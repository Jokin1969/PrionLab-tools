"""Per-user sticky notes on an article.

Up to 5 notes per (article, user). The colour is not chosen by the
user: each note gets the lowest free `color_index` (0-4), mapped in the
frontend to amarilla / azul / verde / morada / naranja. Deleting a note
frees its slot so a new note can reuse that colour.
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import text as _sql
from sqlalchemy.exc import IntegrityError

logger = logging.getLogger(__name__)

MAX_NOTES = 5


def _get_engine():
    from ..ingestion.queue import _get_engine as _e
    return _e()


def _note_to_dict(r) -> dict:
    d = dict(r)
    d["id"] = str(d["id"])
    for k in ("created_at", "updated_at"):
        if d.get(k) is not None:
            d[k] = d[k].isoformat()
    return d


def list_notes(article_id: str, user_id: str) -> list[dict]:
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(_sql("""
            SELECT id, color_index, body, created_at, updated_at
              FROM prionvault_article_note
             WHERE article_id = CAST(:aid AS uuid)
               AND user_id    = CAST(:uid AS uuid)
             ORDER BY color_index
        """), {"aid": article_id, "uid": user_id}).mappings().all()
    return [_note_to_dict(r) for r in rows]


class NoteLimitReached(RuntimeError):
    """Raised when the (article, user) already has MAX_NOTES notes."""


def _lowest_free_index(conn, article_id: str, user_id: str) -> Optional[int]:
    used = {r[0] for r in conn.execute(_sql("""
        SELECT color_index FROM prionvault_article_note
         WHERE article_id = CAST(:aid AS uuid) AND user_id = CAST(:uid AS uuid)
    """), {"aid": article_id, "uid": user_id}).all()}
    for i in range(MAX_NOTES):
        if i not in used:
            return i
    return None


def create_note(article_id: str, user_id: str, body: str = "") -> dict:
    """Create a note in the lowest free colour slot. Raises
    NoteLimitReached when all 5 slots are taken."""
    body = body or ""
    eng = _get_engine()
    # Retry once on the (tiny) race where two inserts pick the same slot;
    # the UNIQUE constraint is the backstop.
    for _attempt in range(2):
        with eng.begin() as conn:
            idx = _lowest_free_index(conn, article_id, user_id)
            if idx is None:
                raise NoteLimitReached(f"máximo {MAX_NOTES} notas por artículo")
            try:
                row = conn.execute(_sql("""
                    INSERT INTO prionvault_article_note
                        (article_id, user_id, color_index, body)
                    VALUES (CAST(:aid AS uuid), CAST(:uid AS uuid), :ci, :body)
                    RETURNING id, color_index, body, created_at, updated_at
                """), {"aid": article_id, "uid": user_id, "ci": idx,
                       "body": body}).mappings().first()
                return _note_to_dict(row)
            except IntegrityError:
                continue  # slot taken by a concurrent insert — recompute
    raise NoteLimitReached(f"máximo {MAX_NOTES} notas por artículo")


def update_note(note_id: str, user_id: str, body: str) -> Optional[dict]:
    """Update a note's body if it belongs to the user. Returns the
    updated note or None if not found / not owned."""
    eng = _get_engine()
    with eng.begin() as conn:
        row = conn.execute(_sql("""
            UPDATE prionvault_article_note
               SET body = :body, updated_at = NOW()
             WHERE id = CAST(:nid AS uuid)
               AND user_id = CAST(:uid AS uuid)
            RETURNING id, color_index, body, created_at, updated_at
        """), {"nid": note_id, "uid": user_id, "body": body or ""}).mappings().first()
    return _note_to_dict(row) if row else None


def delete_note(note_id: str, user_id: str) -> bool:
    eng = _get_engine()
    with eng.begin() as conn:
        res = conn.execute(_sql("""
            DELETE FROM prionvault_article_note
             WHERE id = CAST(:nid AS uuid) AND user_id = CAST(:uid AS uuid)
        """), {"nid": note_id, "uid": user_id})
    return (res.rowcount or 0) > 0


def note_stubs_for_articles(article_ids: list[str], user_id: str) -> dict:
    """Return {article_id: [{id, color_index}, ...]} for the viewer, used
    by the listing to render the coloured note icons without one request
    per row. Ordered by color_index."""
    if not article_ids or not user_id:
        return {}
    eng = _get_engine()
    out: dict = {}
    try:
        with eng.connect() as conn:
            rows = conn.execute(_sql("""
                SELECT article_id::text AS aid, id::text AS id, color_index
                  FROM prionvault_article_note
                 WHERE user_id = CAST(:uid AS uuid)
                   AND article_id = ANY(CAST(:ids AS uuid[]))
                 ORDER BY color_index
            """), {"uid": user_id, "ids": article_ids}).mappings().all()
        for r in rows:
            out.setdefault(r["aid"], []).append(
                {"id": r["id"], "color_index": r["color_index"]})
    except Exception as exc:
        logger.warning("article_notes: stub batch failed: %s", exc)
    return out
