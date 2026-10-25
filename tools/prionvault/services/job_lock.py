"""Cross-worker guard for the admin batch jobs.

Each gunicorn worker keeps its own in-memory batch state, so a second
"start" hitting the other worker used to launch a duplicate run over the
same articles (double LLM/Voyage cost). `guarded()` wraps a batch thread
target with a Postgres session advisory lock held for the whole run: if
another process already holds it, the run is cancelled immediately and
the state says so.
"""
import hashlib
import logging
from datetime import datetime

from sqlalchemy import text as _t

logger = logging.getLogger(__name__)


def _key(name: str) -> int:
    return int.from_bytes(hashlib.sha1(f"pv-batch:{name}".encode()).digest()[:7], "big")


def guarded(name: str, target, state: dict, lock):
    def run(*args, **kwargs):
        conn = None
        try:
            from ..ingestion.queue import _get_engine
            conn = _get_engine().connect()
            got = conn.execute(_t("SELECT pg_try_advisory_lock(:k)"), {"k": _key(name)}).scalar()
            conn.commit()
        except Exception as exc:  # DB hiccup: don't block the run on the guard itself
            logger.warning("job_lock %s: could not take lock (%s) — running unguarded", name, exc)
            got = True
        if not got:
            logger.info("job_lock %s: already running in another worker — skipped", name)
            with lock:
                state["running"] = False
                state["finished_at"] = datetime.utcnow().isoformat()
                state["last_error"] = "Ya hay un lote igual en marcha en otro proceso del servidor."
            if conn is not None:
                conn.close()
            return
        try:
            return target(*args, **kwargs)
        finally:
            if conn is not None:
                try:
                    conn.execute(_t("SELECT pg_advisory_unlock(:k)"), {"k": _key(name)})
                    conn.commit()
                finally:
                    conn.close()
    return run
