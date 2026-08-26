"""Shared request-scoped helpers for PrionVault route modules.

Imported by routes.py and every routes_*.py sub-module.  No blueprint
or route registration here — just pure utility functions that depend on
the Flask request context (session) and the SQLAlchemy session factory.
"""
import logging
import time as _time
from typing import Optional, Set, Tuple

from flask import Response, g, jsonify, session
from sqlalchemy import text as sql_text
from sqlalchemy.orm import Session as SASession

from database.config import db

logger = logging.getLogger(__name__)

# ── articles column introspection (shared, TTL-cached) ──────────────────────
_pv_columns_cache: Optional[Set[str]] = None
_pv_columns_cache_time: float = 0.0
_PV_COLUMNS_TTL_S = 120.0

# Fallback set of columns we know exist, used if introspection fails.
# Updated whenever migrations add new columns; prevents dashboard breakage
# if the information_schema query temporarily fails.
_PV_COLUMNS_FALLBACK = {
    "id", "title", "authors", "year", "journal", "doi", "pubmed_id",
    "abstract", "abstract_unavailable",
    "dropbox_path", "pdf_is_scan", "pdf_searchable", "pdf_ocr_unavailable",
    "pdf_pages", "pdf_metadata_match_status", "pdf_metadata_match_score",
    "pdf_metadata_match_checked_at", "pdf_metadata_match_detail",
    "extraction_status", "extraction_text", "extraction_error",
    "index_vector", "index_version", "index_checked_at",
    "summary_ai", "summary_ai_provider", "summary_tokens_in", "summary_tokens_out",
    "summary_human", "summary_ai_notes",
    "source", "created_at", "updated_at", "is_jc",
}


def _get_pv_columns(s: SASession) -> Set[str]:
    """Return the set of column names that currently exist in `articles`.

    TTL-cached so newly added columns (from migrations applied after process
    start) are picked up within _PV_COLUMNS_TTL_S seconds without a restart.

    Design:
    - On success: cache the result and use it.
    - On failure (network issue, BD down, etc): use fallback set but DON'T
      cache it, so the next request tries the query again. This prevents
      cache corruption from temporary DB outages.
    """
    global _pv_columns_cache, _pv_columns_cache_time
    now = _time.monotonic()
    if (_pv_columns_cache is not None
            and (now - _pv_columns_cache_time) < _PV_COLUMNS_TTL_S):
        return _pv_columns_cache
    try:
        rows = s.execute(sql_text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'articles' LIMIT 1000"
        ), execution_options={"timeout": 5}).all()
        if rows:
            _pv_columns_cache = {r[0] for r in rows}
            _pv_columns_cache_time = now
            logger.debug("Introspected %d columns from articles table", len(_pv_columns_cache))
            return _pv_columns_cache
        else:
            logger.error("information_schema returned empty for articles table")
            return _PV_COLUMNS_FALLBACK
    except Exception as exc:
        logger.warning(
            "Could not introspect articles columns (will retry next request): %s", exc
        )
        return _PV_COLUMNS_FALLBACK

def _current_embed_model(pv_cols: Set[str]) -> Optional[str]:
    """Return the active embedding model name, or None if unavailable.

    Shared by the Library Health stats endpoint and the article-listing
    filter builder so "Indexados" / "Necesitan indexación" always mean
    the same thing in both places — they used to drift (health counted
    only the current model's index_version, the listing filter counted
    any indexed_at IS NOT NULL) which made the health card's number
    disagree with what clicking through to it actually showed.
    """
    if "index_version" not in pv_cols:
        return None
    try:
        from .embeddings.embedder import MODEL as _EMBED_MODEL
        return _EMBED_MODEL
    except Exception:
        return None


# Type alias for the (response, status_code) guard return type.
_GuardResult = Optional[Tuple[Response, int]]


def _viewer_role() -> Optional[str]:
    if getattr(g, "_ext_authed", False):
        return getattr(g, "_ext_authed_role", "admin")
    return session.get("role")


def _viewer_id() -> Optional[str]:
    if getattr(g, "_ext_authed", False):
        return None  # extension requests are not tied to a user
    uid = session.get("user_id")
    if uid:
        return uid
    # Backwards-compat: sessions opened before user_id was added at
    # login still have a valid username. Resolve it lazily once and
    # cache in the session so we don't re-query on every request.
    uname = session.get("username")
    if not uname:
        return None
    try:
        from core.auth import _lookup_db_user_id
        uid = _lookup_db_user_id(uname)
    except Exception:
        logger.debug("_viewer_id: failed to resolve user_id for %s", uname, exc_info=True)
        return None
    if uid:
        session["user_id"] = uid
    return uid


def _viewer_is_jc_responsible() -> bool:
    """True if the logged-in user is flagged is_jc_responsible in
    users.csv (core/users.py) — independent of admin/reader role.
    Extension requests and unauthenticated callers are never
    responsible. Gates who may send the JC convocation broadcast."""
    if getattr(g, "_ext_authed", False):
        return False
    uname = session.get("username")
    if not uname:
        return False
    try:
        from core.users import get_user
        u = get_user(uname)
        return bool(u and (u.get("is_jc_responsible") or "").lower() == "true")
    except Exception:
        logger.debug("_viewer_is_jc_responsible: lookup failed for %s", uname, exc_info=True)
        return False


def _session() -> SASession:
    return db.Session()


def _ensure_can_modify(table_name: str, owner_col: str, row_id) -> _GuardResult:
    """Return a Flask (response, status_code) tuple — or None to proceed.

    Admins always pass. Any other authenticated user only passes when the
    row's owner_col matches their user id. Anonymous → 401, missing → 404,
    forbidden → 403. DB errors surface as 500 (fail-closed).
    """
    if _viewer_role() == "admin":
        return None
    vid = _viewer_id()
    if not vid:
        return jsonify({"error": "not_authenticated"}), 401
    try:
        s = _session()
        try:
            row = s.execute(sql_text(
                f"SELECT {owner_col} FROM {table_name} WHERE id = :id"
            ), {"id": str(row_id)}).first()
        finally:
            s.close()
    except Exception as exc:
        logger.exception("ownership lookup failed on %s.%s", table_name, owner_col)
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500
    if row is None:
        return jsonify({"error": "not_found"}), 404
    owner = row[0]
    if owner is None or str(owner) != str(vid):
        return jsonify({
            "error":  "forbidden",
            "detail": "Solo el creador o un admin puede modificar este recurso.",
        }), 403
    return None
