"""Per-user article selection: the multi-select checkboxes in the
PrionVault listing, persisted so they survive refresh / browser
switch / server deploy.

CRUD is intentionally minimal — the frontend treats it as a
key-value set, so the four operations below are everything it
needs. Bulk add / remove take lists because the UI lets the
operator tick "every visible row" (up to ~1 000) in one click;
issuing 1 000 round-trips for that would be silly.

Anonymous fallback: when the calling endpoint has no viewer_id
(rare — PrionVault sits behind @login_required), the operations
return zero changes instead of raising, so the JS can degrade
gracefully to localStorage in that single edge case.
"""
from __future__ import annotations

import logging
from typing import Iterable, List, Optional
from uuid import UUID

from sqlalchemy import text as sql_text

logger = logging.getLogger(__name__)


def _get_engine():
    from ..ingestion.queue import _get_engine as _e
    return _e()


def _norm_ids(ids: Iterable) -> List[str]:
    """Stringify + dedupe + drop empties. UUID validation is left to
    Postgres' UUID cast at INSERT/DELETE time — a malformed id raises
    cleanly and the caller can surface a 400."""
    seen: set[str] = set()
    out: list[str] = []
    for x in ids or ():
        s = str(x).strip()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


def list_for_user(user_id) -> List[str]:
    """Return every article_id currently ticked by `user_id`, in
    most-recent-first order. Empty list for anonymous callers."""
    if not user_id:
        return []
    eng = _get_engine()
    try:
        with eng.connect() as conn:
            rows = conn.execute(sql_text(
                "SELECT article_id::text FROM prionvault_user_selection "
                " WHERE user_id = :u "
                " ORDER BY created_at DESC"
            ), {"u": str(user_id)}).all()
        return [r[0] for r in rows]
    except Exception as exc:
        logger.warning("user_selection.list_for_user failed: %s", exc)
        return []


def add(user_id, article_ids: Iterable) -> int:
    """Add the given article_ids to the user's selection. Idempotent
    via ON CONFLICT DO NOTHING — re-ticking an already-ticked row is
    a no-op rather than a 4XX. Returns the count of NEW rows
    inserted."""
    if not user_id:
        return 0
    ids = _norm_ids(article_ids)
    if not ids:
        return 0
    eng = _get_engine()
    try:
        with eng.begin() as conn:
            # One INSERT per id is the simplest correct shape. For
            # the common bulk-tick case (up to ~1 000 ids) the cost
            # is dominated by the round-trip, not the per-row work,
            # and Postgres pipelining handles that fine.
            r = conn.execute(sql_text(
                """
                INSERT INTO prionvault_user_selection (user_id, article_id)
                SELECT :u, x::uuid FROM unnest(:ids::text[]) AS x
                ON CONFLICT (user_id, article_id) DO NOTHING
                """
            ), {"u": str(user_id), "ids": ids})
        return r.rowcount or 0
    except Exception as exc:
        logger.warning("user_selection.add failed: %s", exc)
        return 0


def remove(user_id, article_ids: Iterable) -> int:
    """Drop the given article_ids from the user's selection. Returns
    the count of rows actually removed (already-unticked ids
    contribute zero, no error)."""
    if not user_id:
        return 0
    ids = _norm_ids(article_ids)
    if not ids:
        return 0
    eng = _get_engine()
    try:
        with eng.begin() as conn:
            r = conn.execute(sql_text(
                """
                DELETE FROM prionvault_user_selection
                 WHERE user_id = :u
                   AND article_id = ANY(:ids::uuid[])
                """
            ), {"u": str(user_id), "ids": ids})
        return r.rowcount or 0
    except Exception as exc:
        logger.warning("user_selection.remove failed: %s", exc)
        return 0


def clear(user_id) -> int:
    """Wipe the entire selection for `user_id`. Returns the count
    removed. No-op for anonymous callers."""
    if not user_id:
        return 0
    eng = _get_engine()
    try:
        with eng.begin() as conn:
            r = conn.execute(sql_text(
                "DELETE FROM prionvault_user_selection WHERE user_id = :u"
            ), {"u": str(user_id)})
        return r.rowcount or 0
    except Exception as exc:
        logger.warning("user_selection.clear failed: %s", exc)
        return 0


def replace(user_id, article_ids: Iterable) -> dict:
    """Atomically make the user's selection EXACTLY the given list.

    Useful for "I've decided this is my new working set" flows
    (e.g. paste-a-DOI-list → make those the selected ones). Inside
    one transaction so a concurrent reader never observes a
    partially-cleared state.

    Returns {"added": N, "removed": M}.
    """
    if not user_id:
        return {"added": 0, "removed": 0}
    target = set(_norm_ids(article_ids))
    eng = _get_engine()
    try:
        with eng.begin() as conn:
            existing = {r[0] for r in conn.execute(sql_text(
                "SELECT article_id::text FROM prionvault_user_selection "
                " WHERE user_id = :u"
            ), {"u": str(user_id)}).all()}
            to_add    = list(target - existing)
            to_remove = list(existing - target)
            added = removed = 0
            if to_remove:
                r = conn.execute(sql_text(
                    "DELETE FROM prionvault_user_selection "
                    " WHERE user_id = :u "
                    "   AND article_id = ANY(:ids::uuid[])"
                ), {"u": str(user_id), "ids": to_remove})
                removed = r.rowcount or 0
            if to_add:
                r = conn.execute(sql_text(
                    "INSERT INTO prionvault_user_selection (user_id, article_id) "
                    "SELECT :u, x::uuid FROM unnest(:ids::text[]) AS x "
                    "ON CONFLICT DO NOTHING"
                ), {"u": str(user_id), "ids": to_add})
                added = r.rowcount or 0
        return {"added": added, "removed": removed}
    except Exception as exc:
        logger.warning("user_selection.replace failed: %s", exc)
        return {"added": 0, "removed": 0}
