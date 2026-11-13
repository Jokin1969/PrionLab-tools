"""Run a scheduled job in ONE gunicorn worker at a time.

Every worker starts its own APScheduler, so each periodic job fires once
per worker. `run_once(name, fn)` takes a Postgres advisory lock for the
duration of the job and simply skips when another worker already holds
it (or, without a database, just runs the job).
"""
import hashlib
import logging

logger = logging.getLogger(__name__)


def _key(name: str) -> int:
    return int.from_bytes(hashlib.sha1(f"job:{name}".encode()).digest()[:7], "big")


def run_once(name: str, fn, *args, **kwargs):
    try:
        from sqlalchemy import text
        from database.config import db
        if not db.is_configured():
            return fn(*args, **kwargs)
        conn = db.engine.connect()
    except Exception:
        return fn(*args, **kwargs)
    try:
        try:
            got = conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": _key(name)}).scalar()
            conn.commit()
        except Exception as exc:
            # Database restarting / connection dropped: skip this run, the
            # scheduler fires again shortly. Not an application error.
            logger.warning("job %s skipped: could not take its lock (%s)",
                           name, str(exc).splitlines()[0][:160])
            return None
        if not got:
            logger.debug("job %s already running in another worker — skipped", name)
            return None
        try:
            return fn(*args, **kwargs)
        finally:
            try:
                conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _key(name)})
                conn.commit()
            except Exception as exc:
                # The connection died while the job ran (database restart).
                # Postgres releases a session's advisory locks when the
                # session ends, so there is nothing left to unlock.
                logger.warning("job %s: lock connection lost (%s) — the lock is released "
                               "by the server", name, str(exc).splitlines()[0][:160])
    finally:
        try:
            conn.close()
        except Exception:
            pass
