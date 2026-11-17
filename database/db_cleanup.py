"""One-off database housekeeping, run in the background.

`drop_duplicate_unique_constraints` — PrionRead's ORM used to re-add every
`unique` constraint each time it started (users.email, articles.doi,
articles.pubmed_id → `…_key1`, `…_key2`, … thousands of identical indexes,
all of which had to be updated on every write). The cause is fixed in
prionread/backend; this removes the copies, keeping one constraint per
column set.

`compact_articles` — VACUUM FULL of `articles`, to give back the dead space
left by re-indexing. Explicit admin action only: it locks the table while it
runs.
"""
from __future__ import annotations

import logging
import re
import threading
import time
from collections import defaultdict

from sqlalchemy import text

logger = logging.getLogger(__name__)

_NUMBERED = re.compile(r"_key\d+$")


def duplicate_unique_constraints(conn) -> list[tuple[str, str]]:
    """[(table, constraint)] that duplicate another unique constraint on the
    same columns of the same table. One per column set is always kept."""
    rows = conn.execute(text("""
        SELECT c.conrelid::regclass::text AS tbl, c.conname, c.conkey::text AS cols
          FROM pg_constraint c
          JOIN pg_namespace n ON n.oid = c.connamespace
         WHERE c.contype = 'u' AND n.nspname = 'public'""")).all()
    groups: dict = defaultdict(list)
    for tbl, name, cols in rows:
        groups[(tbl, cols)].append(name)
    out = []
    for (tbl, _cols), names in groups.items():
        if len(names) < 2:
            continue
        # keep the original (un-numbered) one when there is one
        keep = sorted(names, key=lambda n: (bool(_NUMBERED.search(n)), len(n), n))[0]
        out += [(tbl, n) for n in names if n != keep and _NUMBERED.search(n)]
    return out


def drop_duplicate_unique_constraints(engine, batch: int = 20) -> int:
    dropped = 0
    failed: set = set()
    while True:
        with engine.connect() as conn:
            todo = [d for d in duplicate_unique_constraints(conn) if d not in failed][:batch]
        if not todo:
            break
        # Small transactions: each DROP takes a lock on the table.
        try:
            with engine.begin() as conn:
                conn.execute(text("SET LOCAL lock_timeout = '5s'"))
                for tbl, name in todo:
                    conn.execute(text(f'ALTER TABLE {tbl} DROP CONSTRAINT IF EXISTS "{name}"'))
            dropped += len(todo)
        except Exception as exc:
            logger.warning("db_cleanup: batch failed (%s) — retrying one by one",
                           str(exc).splitlines()[0][:160])
            for tbl, name in todo:
                try:
                    with engine.begin() as conn:
                        conn.execute(text("SET LOCAL lock_timeout = '5s'"))
                        conn.execute(text(f'ALTER TABLE {tbl} DROP CONSTRAINT IF EXISTS "{name}"'))
                    dropped += 1
                except Exception:
                    failed.add((tbl, name))
        time.sleep(0.2)
    if dropped or failed:
        logger.info("db_cleanup: dropped %d duplicate unique constraints (%d could not be dropped)",
                    dropped, len(failed))
    return dropped


def start_cleanup(delay_s: float = 120.0) -> None:
    """Background thread, one gunicorn worker at a time."""
    def run():
        time.sleep(delay_s)
        try:
            from database.config import db
            from database.singleton import run_once
            if db.is_configured():
                run_once("db_cleanup_dup_unique", drop_duplicate_unique_constraints, db.engine)
        except Exception as exc:
            logger.warning("db_cleanup failed: %s", exc)
    threading.Thread(target=run, name="db-cleanup", daemon=True).start()


# ── Compaction (explicit admin action) ───────────────────────────────────────

_compact = {"running": False, "started_at": None, "finished_at": None,
            "before_mb": None, "after_mb": None, "error": None}
_compact_lock = threading.Lock()


def compact_status() -> dict:
    return dict(_compact)


def compact_articles(engine) -> bool:
    """Start VACUUM FULL on `articles` in a thread. False if already running."""
    with _compact_lock:
        if _compact["running"]:
            return False
        _compact.update(running=True, started_at=time.time(), finished_at=None,
                        before_mb=None, after_mb=None, error=None)

    def size(conn):
        return round((conn.execute(text(
            "SELECT pg_total_relation_size('articles')")).scalar() or 0) / 1048576, 1)

    def run():
        try:
            with engine.connect() as conn:
                _compact["before_mb"] = size(conn)
            raw = engine.raw_connection()
            try:
                raw.driver_connection.autocommit = True      # VACUUM cannot run in a transaction
                with raw.cursor() as cur:
                    cur.execute("VACUUM (FULL, ANALYZE) articles")
            finally:
                try:
                    raw.driver_connection.autocommit = False
                except Exception:
                    pass
                raw.close()
            with engine.connect() as conn:
                _compact["after_mb"] = size(conn)
            logger.info("db_cleanup: articles compacted %s → %s MB",
                        _compact["before_mb"], _compact["after_mb"])
        except Exception as exc:
            _compact["error"] = str(exc).splitlines()[0][:300]
            logger.error("db_cleanup: compaction failed: %s", exc)
        finally:
            _compact.update(running=False, finished_at=time.time())

    threading.Thread(target=run, name="db-compact-articles", daemon=True).start()
    return True
