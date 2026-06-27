"""Shared request-scoped helpers for PrionVault route modules.

Imported by routes.py and every routes_*.py sub-module.  No blueprint
or route registration here — just pure utility functions that depend on
the Flask request context (session) and the SQLAlchemy session factory.
"""
import logging
import time as _time
from typing import Optional, Set, Tuple

from flask import Response, jsonify, session
from sqlalchemy import text as sql_text
from sqlalchemy.orm import Session as SASession

from database.config import db

logger = logging.getLogger(__name__)

# ── articles column introspection (shared, TTL-cached) ──────────────────────
_pv_columns_cache: Optional[Set[str]] = None
_pv_columns_cache_time: float = 0.0
_PV_COLUMNS_TTL_S = 120.0


def _get_pv_columns(s: SASession) -> Set[str]:
    """Return the set of column names that currently exist in `articles`.

    TTL-cached so newly added columns (from migrations applied after process
    start) are picked up within _PV_COLUMNS_TTL_S seconds without a restart.
    """
    global _pv_columns_cache, _pv_columns_cache_time
    if (_pv_columns_cache is not None
            and (_time.monotonic() - _pv_columns_cache_time) < _PV_COLUMNS_TTL_S):
        return _pv_columns_cache
    try:
        rows = s.execute(sql_text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'articles'"
        )).all()
        _pv_columns_cache = {r[0] for r in rows}
        _pv_columns_cache_time = _time.monotonic()
    except Exception as exc:
        logger.warning("Could not introspect articles columns: %s", exc)
        _pv_columns_cache = set()
        _pv_columns_cache_time = _time.monotonic()
    return _pv_columns_cache

# Type alias for the (response, status_code) guard return type.
_GuardResult = Optional[Tuple[Response, int]]


def _viewer_role() -> Optional[str]:
    return session.get("role")


def _viewer_id() -> Optional[str]:
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
