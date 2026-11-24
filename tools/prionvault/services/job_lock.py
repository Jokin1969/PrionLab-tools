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


_STOP_DDL = ("CREATE TABLE IF NOT EXISTS pv_batch_stop ("
             "name TEXT PRIMARY KEY, requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW())")


def running_elsewhere(name: str) -> bool:
    """True when some process holds this batch's advisory lock (i.e. the
    batch runs in the other gunicorn worker)."""
    k = _key(name)
    try:
        from ..ingestion.queue import _get_engine
        with _get_engine().connect() as conn:
            return bool(conn.execute(_t(
                "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted "
                "AND classid = :c AND objid = :o AND objsubid = 1"),
                {"c": k >> 32, "o": k & 0xFFFFFFFF}).first())
    except Exception:
        return False


_PROGRESS_DDL = ("CREATE TABLE IF NOT EXISTS pv_batch_progress ("
                 "name TEXT PRIMARY KEY, info TEXT NOT NULL DEFAULT '{}', "
                 "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())")


def save_progress(name: str, info: dict) -> None:
    """Publish the running job's progress so the OTHER gunicorn worker —
    which answers half of the status polls — can show the real phase
    instead of a bare "running in another process"."""
    import json
    try:
        from ..ingestion.queue import _get_engine
        with _get_engine().begin() as conn:
            conn.execute(_t(_PROGRESS_DDL))
            conn.execute(_t(
                "INSERT INTO pv_batch_progress (name, info, updated_at) VALUES (:n, :i, NOW()) "
                "ON CONFLICT (name) DO UPDATE SET info = :i, updated_at = NOW()"),
                {"n": name, "i": json.dumps(info, ensure_ascii=False, default=str)})
    except Exception as exc:
        logger.debug("job_lock %s: could not save progress (%s)", name, exc)


def load_progress(name: str) -> dict:
    import json
    try:
        from ..ingestion.queue import _get_engine
        with _get_engine().connect() as conn:
            row = conn.execute(_t(
                "SELECT info FROM pv_batch_progress WHERE name = :n "
                "AND updated_at > NOW() - INTERVAL '2 hours'"), {"n": name}).first()
        return json.loads(row[0]) if row else {}
    except Exception:
        return {}


def request_stop(name: str) -> None:
    """Record a stop request in the DB, so the worker that actually runs
    the batch sees it even when the click landed on the other worker."""
    try:
        from ..ingestion.queue import _get_engine
        with _get_engine().begin() as conn:
            conn.execute(_t(_STOP_DDL))
            conn.execute(_t(
                "INSERT INTO pv_batch_stop (name, requested_at) VALUES (:n, NOW()) "
                "ON CONFLICT (name) DO UPDATE SET requested_at = NOW()"), {"n": name})
    except Exception as exc:
        logger.warning("job_lock %s: could not record stop request (%s)", name, exc)


def _watch_stop(name: str, state: dict, lock, started, done) -> None:
    from ..ingestion.queue import _get_engine
    while not done.wait(3):
        try:
            with _get_engine().connect() as conn:
                conn.execute(_t(_STOP_DDL))
                conn.commit()
                hit = conn.execute(_t(
                    "SELECT 1 FROM pv_batch_stop WHERE name = :n AND requested_at >= :s"),
                    {"n": name, "s": started}).first()
            if hit:
                with lock:
                    state["stop_requested"] = True
                return
        except Exception:
            pass


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
        import threading
        from datetime import timezone
        done = threading.Event()
        threading.Thread(target=_watch_stop,
                         args=(name, state, lock, datetime.now(timezone.utc), done),
                         name=f"{name}-stop-watch", daemon=True).start()
        try:
            return target(*args, **kwargs)
        finally:
            done.set()
            if conn is not None:
                try:
                    conn.execute(_t("SELECT pg_advisory_unlock(:k)"), {"k": _key(name)})
                    conn.commit()
                finally:
                    conn.close()
    return run
