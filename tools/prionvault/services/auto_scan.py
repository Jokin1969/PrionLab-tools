"""Background daemon that periodically scans the Dropbox watch folder.

Default cadence: every 6 hours (configurable via env). On each tick:
  1. Sleep for AUTO_SCAN_POLL_SECONDS (default 900 = 15 min) so the
     check is cheap and the daemon is responsive to admin force-runs.
  2. Try to claim the "auto-scan-folder" lease via an UPSERT that only
     succeeds if last_run_at < NOW() - <interval>. This makes the
     daemon multi-worker safe: two gunicorn workers can't both run
     the scan because only one wins the UPSERT race.
  3. Loop scan_folder_into_queue() in chunks of 50 until either
     `remaining` reaches 0 or AUTO_SCAN_BATCH_LIMIT is hit.
  4. Record the result (queued / skipped / runtime / error) in the
     same row so the admin status endpoint can display it.

Env vars (all optional):
  PRIONVAULT_AUTO_SCAN_DISABLED   "1" turns the daemon off entirely.
  PRIONVAULT_AUTO_SCAN_INTERVAL_HOURS   default 6
  PRIONVAULT_AUTO_SCAN_FOLDER     default "/PrionLab tools/PDFs"
  PRIONVAULT_AUTO_SCAN_BATCH_LIMIT  default 500 — hard cap per run
                                    so one tick never burns through
                                    the entire folder + the Dropbox
                                    rate quota.
  PRIONVAULT_AUTO_SCAN_POLL_SECONDS default 900 — how often the
                                    daemon checks the lease.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Optional

from sqlalchemy import text as sql_text

from ..ingestion.queue import _get_engine
from .folder_scanner import scan_folder_into_queue, DEFAULT_WATCH_FOLDER

logger = logging.getLogger(__name__)

LEASE_NAME = "auto-scan-folder"

_thread: Optional[threading.Thread] = None
_stop = threading.Event()
# Lets the admin force a run without waiting for the next poll tick.
_force = threading.Event()


def _env_int(name: str, default: int) -> int:
    try:
        v = int(os.environ.get(name, "").strip() or default)
        return max(1, v)
    except (TypeError, ValueError):
        return default


def _config() -> dict:
    return {
        "disabled":          os.environ.get("PRIONVAULT_AUTO_SCAN_DISABLED",
                                            "").strip() in ("1", "true", "True"),
        "interval_hours":    _env_int("PRIONVAULT_AUTO_SCAN_INTERVAL_HOURS", 6),
        "folder":            (os.environ.get("PRIONVAULT_AUTO_SCAN_FOLDER", "").strip()
                              or DEFAULT_WATCH_FOLDER),
        "batch_limit":       _env_int("PRIONVAULT_AUTO_SCAN_BATCH_LIMIT", 500),
        "poll_seconds":      _env_int("PRIONVAULT_AUTO_SCAN_POLL_SECONDS", 900),
    }


def _claim_lease(interval_hours: int) -> bool:
    """Atomic claim. Returns True if THIS worker should run now.

    The ON CONFLICT path only fires UPDATE when enough time has passed
    since the last run. If two workers race, only one's UPDATE matches
    the WHERE clause; the other gets a no-op and sees no RETURNING row.
    """
    try:
        eng = _get_engine()
    except Exception:
        return False
    try:
        with eng.begin() as conn:
            row = conn.execute(sql_text("""
                INSERT INTO prionvault_scheduled_runs
                  (name, last_run_at, last_status, updated_at)
                VALUES (:n, NOW(), 'running', NOW())
                ON CONFLICT (name) DO UPDATE
                  SET last_run_at = NOW(),
                      last_status = 'running',
                      updated_at  = NOW()
                  WHERE prionvault_scheduled_runs.last_run_at IS NULL
                     OR prionvault_scheduled_runs.last_run_at
                          < NOW() - make_interval(hours => :h)
                RETURNING name
            """), {"n": LEASE_NAME, "h": interval_hours}).first()
            return row is not None
    except Exception as exc:
        logger.warning("auto-scan: lease claim failed (%s)", exc)
        return False


def _record_result(*, status: str, runtime_ms: int,
                   error: Optional[str] = None,
                   payload: Optional[dict] = None) -> None:
    """Save the outcome of a run on the same lease row."""
    import json
    try:
        eng = _get_engine()
        with eng.begin() as conn:
            conn.execute(sql_text("""
                INSERT INTO prionvault_scheduled_runs
                  (name, last_run_at, last_status, last_error, last_runtime_ms,
                   payload, updated_at)
                VALUES (:n, NOW(), :s, :e, :ms, CAST(:p AS JSONB), NOW())
                ON CONFLICT (name) DO UPDATE
                  SET last_status     = EXCLUDED.last_status,
                      last_error      = EXCLUDED.last_error,
                      last_runtime_ms = EXCLUDED.last_runtime_ms,
                      payload         = EXCLUDED.payload,
                      updated_at      = NOW()
            """), {
                "n":  LEASE_NAME,
                "s":  status,
                "e":  (error[:600] if error else None),
                "ms": int(runtime_ms),
                "p":  json.dumps(payload or {}),
            })
    except Exception as exc:
        logger.warning("auto-scan: could not record result (%s)", exc)


def _do_one_scan(folder: str, batch_limit: int) -> dict:
    """Drain the folder in 50-PDF chunks up to `batch_limit`.

    Returns an aggregate summary mirroring scan_folder_into_queue's
    shape but summed across chunks.
    """
    CHUNK = 50
    total_queued    = 0
    total_skipped   = 0
    total_pdfs      = 0
    already_queued  = 0
    skipped_detail  = []
    last_error: Optional[str] = None

    while total_queued + total_skipped < batch_limit:
        result = scan_folder_into_queue(
            folder=folder, per_call_limit=CHUNK, user_id=None,
        )
        if not result.get("ok"):
            last_error = f"{result.get('error')}: {result.get('detail') or ''}"
            break
        total_pdfs      = result["pdfs_found"]      # last seen, not summed
        already_queued  = result["already_queued"]
        total_queued   += result["queued"]
        total_skipped  += result["skipped"]
        skipped_detail.extend(result.get("skipped_detail") or [])
        # Stop early when the chunk came back empty: either the folder
        # is drained or every fresh PDF is already in-flight.
        if result["queued"] == 0:
            break

    return {
        "folder":         folder,
        "pdfs_found":     total_pdfs,
        "already_queued": already_queued,
        "queued":         total_queued,
        "skipped":        total_skipped,
        "skipped_detail": skipped_detail[:20],
        "error":          last_error,
    }


def _run_loop() -> None:
    """Daemon loop. Wakes on the poll interval OR on a forced run."""
    while not _stop.is_set():
        cfg = _config()
        if cfg["disabled"]:
            _stop.wait(timeout=cfg["poll_seconds"])
            continue

        # Either the admin pushed the button (which sets _force) or the
        # poll interval elapsed. Both paths go through the lease claim
        # so we never race two workers.
        was_forced = _force.is_set()
        _force.clear()

        # If forced, bypass the interval-gated claim by stealing the
        # lease unconditionally; otherwise use the interval check.
        if was_forced:
            claimed = _claim_lease(interval_hours=0)
        else:
            claimed = _claim_lease(interval_hours=cfg["interval_hours"])

        if claimed:
            logger.info("auto-scan: claimed lease, scanning %s (forced=%s, batch_limit=%d)",
                        cfg["folder"], was_forced, cfg["batch_limit"])
            t0 = time.monotonic()
            try:
                summary = _do_one_scan(cfg["folder"], cfg["batch_limit"])
                runtime_ms = int((time.monotonic() - t0) * 1000)
                _record_result(
                    status="error" if summary.get("error") else "ok",
                    runtime_ms=runtime_ms,
                    error=summary.get("error"),
                    payload={
                        "folder":         summary["folder"],
                        "pdfs_found":     summary["pdfs_found"],
                        "already_queued": summary["already_queued"],
                        "queued":         summary["queued"],
                        "skipped":        summary["skipped"],
                        "forced":         was_forced,
                        "interval_hours": cfg["interval_hours"],
                    },
                )
                logger.info("auto-scan: done — folder=%s queued=%d skipped=%d (%d ms)",
                            summary["folder"], summary["queued"],
                            summary["skipped"], runtime_ms)
                # After every auto-scan run, also do a full PrionPack
                # ↔ PrionVault sync. Cheap (single SELECT per branch)
                # and catches edge cases where a new article landed
                # but the per-DOI hook in the worker didn't fire (DB
                # restart mid-job, etc.). Best-effort.
                try:
                    from .prionpack_sync import sync_all
                    sync_all()
                except Exception as exc:
                    logger.warning("auto-scan: prionpack sync_all failed: %s", exc)
            except Exception as exc:
                runtime_ms = int((time.monotonic() - t0) * 1000)
                logger.exception("auto-scan: unhandled error")
                _record_result(status="error", runtime_ms=runtime_ms,
                               error=str(exc)[:600])

        # Sleep until the next poll OR until _force is set.
        _force.wait(timeout=cfg["poll_seconds"])


def force_run_now() -> None:
    """Tell the daemon to wake up and run on the next loop iteration.

    Used by the admin "Forzar ahora" button. If the daemon is mid-scan
    the force will be picked up on the NEXT iteration.
    """
    _force.set()


def start_auto_scan() -> Optional[threading.Thread]:
    """Spawn the background daemon. Idempotent.

    Set PRIONVAULT_AUTO_SCAN_DISABLED=1 to opt out (e.g. on staging or
    on a worker-only deployment where you don't want this firing).
    """
    global _thread
    if os.environ.get("PRIONVAULT_AUTO_SCAN_DISABLED", "").strip() in ("1", "true", "True"):
        logger.info("PrionVault auto-scan disabled via env var.")
        return None
    if _thread and _thread.is_alive():
        return _thread
    _stop.clear()
    _thread = threading.Thread(target=_run_loop, name="prionvault-auto-scan",
                               daemon=True)
    _thread.start()
    logger.info("PrionVault auto-scan daemon started.")
    return _thread


def stop_auto_scan() -> None:
    _stop.set()
    _force.set()  # break the wait


def get_status() -> dict:
    """Snapshot the lease row + the current effective config for the
    admin status panel."""
    cfg = _config()
    row = None
    try:
        eng = _get_engine()
        with eng.connect() as conn:
            row = conn.execute(sql_text("""
                SELECT name, last_run_at, last_status, last_error,
                       last_runtime_ms, payload, updated_at
                  FROM prionvault_scheduled_runs
                 WHERE name = :n
            """), {"n": LEASE_NAME}).mappings().first()
    except Exception as exc:
        logger.warning("auto-scan: status read failed: %s", exc)

    last = dict(row) if row else None
    if last:
        if last.get("last_run_at"):
            last["last_run_at"] = last["last_run_at"].isoformat()
        if last.get("updated_at"):
            last["updated_at"] = last["updated_at"].isoformat()
    return {
        "config":      cfg,
        "running":     bool(_thread and _thread.is_alive()),
        "last":        last,
    }
