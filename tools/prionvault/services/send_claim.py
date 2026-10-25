"""Atomic claim of due rows for the scheduled senders.

Both gunicorn workers run the every-minute jobs, so a plain SELECT of due
rows made each email go out twice. `claim_due` marks the rows it returns
(attempts+1, last_attempt_at=NOW()) in one statement with SKIP LOCKED, so
a row is handed to exactly one worker. A failed row is retried with
backoff (10 min × attempts) and abandoned after MAX_ATTEMPTS.
"""
import logging

from sqlalchemy import text as _t

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 5
_ensured: set = set()


def _ensure_columns(eng, table: str) -> None:
    # Self-heal in case migration 100 didn't land (see migration 091).
    if table in _ensured:
        return
    with eng.begin() as conn:
        conn.execute(_t(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0"))
        conn.execute(_t(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ"))
    _ensured.add(table)


def claim_due(eng, table: str, columns: str, limit: int = 50) -> list[dict]:
    """`table` and `columns` are code constants, never user input."""
    _ensure_columns(eng, table)
    with eng.begin() as conn:
        rows = conn.execute(_t(f"""
            UPDATE {table} t
               SET attempts = t.attempts + 1, last_attempt_at = NOW()
             WHERE t.id IN (
                   SELECT id FROM {table}
                    WHERE scheduled_at <= NOW() AND sent_at IS NULL
                      AND attempts < :max
                      AND (last_attempt_at IS NULL
                           OR last_attempt_at < NOW() - make_interval(mins => 10 * attempts))
                    ORDER BY scheduled_at ASC
                    LIMIT :lim
                    FOR UPDATE SKIP LOCKED)
            RETURNING t.attempts AS _attempts, {columns}
        """), {"max": MAX_ATTEMPTS, "lim": limit}).mappings().all()
    return [dict(r) for r in rows]
