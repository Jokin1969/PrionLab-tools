"""One-shot backfill: copy the global article marks
(is_flagged / is_milestone / color_label / priority) to the first
admin's prionvault_user_state row, so the migration to per-user
marks doesn't lose any prior work.

Why the FIRST admin (not "everyone"): the marks were almost
certainly placed by the original operator. Attributing them to that
account preserves their visible state for whoever has been managing
the catalogue. Other users start with a clean per-user slate and
add their own marks from there.

Idempotent: a control row in `prionvault_scheduled_runs` records
when the backfill ran. Re-running this is a no-op.

Safe by construction: we only WRITE to prionvault_user_state, never
to articles. The global columns on `articles` remain intact during
this transition phase so a rollback only needs to revert the code
changes.
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import text as sql_text

logger = logging.getLogger(__name__)

_RUN_NAME = "prionvault_marks_backfill_v1"


def _get_engine():
    from ..ingestion.queue import _get_engine as _e
    return _e()


def _pick_target_admin(conn) -> Optional[str]:
    """Pick the FIRST admin (oldest created_at). Falls back to
    'whoever exists' if no admin role is set."""
    row = conn.execute(sql_text(
        "SELECT id::text FROM users "
        " WHERE role = 'admin' "
        " ORDER BY created_at ASC LIMIT 1"
    )).first()
    if row:
        return row[0]
    row = conn.execute(sql_text(
        "SELECT id::text FROM users ORDER BY created_at ASC LIMIT 1"
    )).first()
    return row[0] if row else None


def _already_ran(conn) -> bool:
    """Check the scheduled_runs control table for an OK pass."""
    try:
        row = conn.execute(sql_text(
            "SELECT last_status FROM prionvault_scheduled_runs "
            " WHERE name = :n"
        ), {"n": _RUN_NAME}).first()
        return bool(row and row[0] == "ok")
    except Exception:
        # Table may not exist yet on a fresh DB; treat as not-run.
        return False


def _record_run(conn, payload: dict) -> None:
    """Stamp the control table so subsequent boots short-circuit.
    Best-effort: if the schedule table isn't there, we log and
    move on; the backfill is still safe to re-run because of the
    ON CONFLICT clause below."""
    try:
        conn.execute(sql_text(
            """
            INSERT INTO prionvault_scheduled_runs
              (name, last_run_at, last_status, payload)
            VALUES (:n, NOW(), 'ok', CAST(:p AS jsonb))
            ON CONFLICT (name) DO UPDATE
              SET last_run_at = EXCLUDED.last_run_at,
                  last_status = EXCLUDED.last_status,
                  payload     = EXCLUDED.payload
            """
        ), {"n": _RUN_NAME, "p": _json_dumps(payload)})
    except Exception as exc:
        logger.warning("marks_backfill: control-row write failed: %s", exc)


def _json_dumps(d: dict) -> str:
    import json
    return json.dumps(d, default=str)


def backfill_once() -> dict:
    """Run the backfill if it hasn't run yet. Returns a summary dict
    suitable for app.logger. Never raises — backfill failures must
    not crash app boot, so the worst case is "we'll try again next
    boot"."""
    eng = _get_engine()
    try:
        with eng.connect() as conn:
            if _already_ran(conn):
                return {"skipped": True, "reason": "already_ran"}
            target_uid = _pick_target_admin(conn)
            if not target_uid:
                return {"skipped": True, "reason": "no_users_yet"}

            # Pull every article that currently carries a non-default
            # mark. We exclude the all-default rows so the backfill
            # doesn't create empty per-user rows for the entire
            # catalogue (4 000 articles → 4 000 inert prionvault_user_state
            # rows is wasted space). The COALESCE guards against
            # nullable columns.
            rows = conn.execute(sql_text(
                """
                SELECT id::text         AS aid,
                       is_flagged,
                       is_milestone,
                       color_label,
                       priority
                  FROM articles
                 WHERE COALESCE(is_flagged,   FALSE) = TRUE
                    OR COALESCE(is_milestone, FALSE) = TRUE
                    OR color_label IS NOT NULL
                    OR (priority IS NOT NULL AND priority <> 3)
                """
            )).mappings().all()

        if not rows:
            with eng.begin() as conn:
                _record_run(conn, {"copied": 0, "user_id": target_uid})
            return {"copied": 0, "user_id": target_uid}

        # One transaction for the whole backfill: either we land the
        # entire dataset or none of it.
        with eng.begin() as conn:
            for r in rows:
                conn.execute(sql_text(
                    """
                    INSERT INTO prionvault_user_state
                      (user_id, article_id, is_flagged, is_milestone,
                       color_label, priority)
                    VALUES (:u, :a::uuid, :f, :m, :c, :p)
                    ON CONFLICT (user_id, article_id) DO UPDATE
                       SET is_flagged   = EXCLUDED.is_flagged
                            OR prionvault_user_state.is_flagged,
                           is_milestone = EXCLUDED.is_milestone
                            OR prionvault_user_state.is_milestone,
                           color_label  = COALESCE(
                             prionvault_user_state.color_label,
                             EXCLUDED.color_label
                           ),
                           priority     = COALESCE(
                             prionvault_user_state.priority,
                             EXCLUDED.priority
                           )
                    """
                ), {
                    "u": target_uid,
                    "a": r["aid"],
                    "f": bool(r["is_flagged"]),
                    "m": bool(r["is_milestone"]),
                    "c": r["color_label"],
                    "p": r["priority"],
                })
            _record_run(conn, {"copied": len(rows), "user_id": target_uid})

        return {"copied": len(rows), "user_id": target_uid}
    except Exception as exc:
        logger.warning("marks_backfill failed (will retry next boot): %s", exc)
        return {"error": str(exc)[:240]}
