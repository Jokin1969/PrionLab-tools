"""Backup supervision: run log, single-runner guard, catch-up and alerts.

Why this exists (problems found in production):
  - gunicorn runs 2 workers and EACH starts its own maintenance scheduler,
    so every scheduled backup ran twice at the same moment — two full
    exports and two Dropbox uploads of the same database competing for
    memory and disk.
  - The schedule lives only in memory: if the app was restarting at the
    scheduled time, that backup was silently skipped, with no retry.
  - Failures (e.g. Dropbox out of space) were only written to the server
    log, so nobody found out.

What this module adds:
  - run_backup(trigger): every attempt is recorded in `backup_run`
    (migration 097), and a Postgres advisory lock guarantees only ONE
    backup runs at a time across all workers — the other worker skips.
  - watchdog(): hourly check. If the last successful backup is older
    than the configured frequency (plus a grace period), it runs a
    catch-up backup straight away; it also closes runs left "running"
    by a process that died mid-backup.
  - Admin email alert whenever a backup fails, can't reach Dropbox, is
    suspiciously smaller than the previous one, or had to be caught up.
  - health(): the status shown in the Backups panel.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

logger = logging.getLogger(__name__)

_LOCK_KEY = 0x707276626B7570          # "prvbkup" — one backup at a time, cluster-wide
_GRACE = timedelta(hours=6)            # tolerance beyond the configured interval
_STALE_RUNNING = timedelta(hours=3)    # a "running" row older than this is dead
_SHRINK_WARN = 0.7                     # warn if a backup is <70% the size of the previous one


def _sql(q):
    from sqlalchemy import text
    return text(q)


def _engine():
    from database.config import db
    return db.engine


def _interval(settings: dict) -> timedelta:
    freq = (settings or {}).get("frequency", "weekly")
    return {"daily": timedelta(days=1), "monthly": timedelta(days=31)}.get(freq, timedelta(days=7))


def _settings() -> dict:
    from database.backup import get_backup_settings
    return get_backup_settings()


# ── Run log ──────────────────────────────────────────────────────────────────

def _start_row(conn, trigger: str) -> Optional[int]:
    return conn.execute(_sql(
        "INSERT INTO backup_run (trigger, worker_pid) VALUES (:t, :pid) RETURNING id"
    ), {"t": trigger, "pid": os.getpid()}).scalar()


def _finish_row(run_id: int, **fields) -> None:
    sets = ", ".join(f"{k} = :{k}" for k in fields)
    with _engine().begin() as conn:
        conn.execute(_sql(f"UPDATE backup_run SET finished_at = NOW(), {sets} WHERE id = :id"),
                     {"id": run_id, **fields})


def _last_success_size(exclude_id: int) -> Optional[float]:
    with _engine().connect() as conn:
        v = conn.execute(_sql("""
            SELECT size_mb FROM backup_run
             WHERE status IN ('success', 'partial') AND id <> :id AND size_mb IS NOT NULL
             ORDER BY started_at DESC LIMIT 1
        """), {"id": exclude_id}).scalar()
    return float(v) if v is not None else None


def run_backup(trigger: str = "scheduled") -> dict:
    """Create a backup under the cluster-wide lock and record the attempt.
    Returns BackupManager.create_backup()'s result, plus run_id/status, or
    {"success": False, "skipped": True} if another backup is already running."""
    from database.backup import BackupManager

    lock_conn = _engine().connect()
    try:
        got = lock_conn.execute(_sql("SELECT pg_try_advisory_lock(:k)"), {"k": _LOCK_KEY}).scalar()
        lock_conn.commit()
        if not got:
            logger.info("backup (%s) skipped: another backup is already running", trigger)
            return {"success": False, "skipped": True,
                    "error": "Ya hay otra copia de seguridad en curso."}

        with _engine().begin() as conn:
            run_id = _start_row(conn, trigger)

        try:
            result = BackupManager().create_backup()
        except Exception as exc:
            logger.exception("backup (%s) crashed", trigger)
            result = {"success": False, "error": str(exc)}

        if not result.get("success"):
            _finish_row(run_id, status="failed", error=(result.get("error") or "error desconocido")[:1000])
            result.update(run_id=run_id, status="failed")
            _alert(trigger, "failed", result)
            return result

        warning = None
        prev = _last_success_size(run_id)
        size = result.get("size_mb")
        if prev and size is not None and size < prev * _SHRINK_WARN:
            warning = (f"La copia ocupa {size} MB, bastante menos que la anterior ({prev} MB): "
                       f"comprueba que no falten datos.")
        status = "partial" if result.get("dropbox_error") else "success"
        _finish_row(run_id, status=status, filename=result.get("filename"),
                    size_mb=size, dropbox_path=result.get("dropbox_path"),
                    dropbox_error=(result.get("dropbox_error") or None), warning=warning)
        result.update(run_id=run_id, status=status, warning=warning)
        if status != "success" or warning or trigger == "catchup":
            _alert(trigger, status, result)
        return result
    finally:
        try:
            lock_conn.execute(_sql("SELECT pg_advisory_unlock(:k)"), {"k": _LOCK_KEY})
            lock_conn.commit()
        except Exception:
            pass
        lock_conn.close()


# ── Watchdog ─────────────────────────────────────────────────────────────────

def _lock_free() -> bool:
    """True if no backup currently holds the lock (checks without keeping it)."""
    with _engine().connect() as conn:
        got = conn.execute(_sql("SELECT pg_try_advisory_lock(:k)"), {"k": _LOCK_KEY}).scalar()
        if got:
            conn.execute(_sql("SELECT pg_advisory_unlock(:k)"), {"k": _LOCK_KEY})
        conn.commit()
        return bool(got)


def _last_success_at() -> Optional[datetime]:
    with _engine().connect() as conn:
        v = conn.execute(_sql(
            "SELECT MAX(started_at) FROM backup_run WHERE status IN ('success', 'partial')"
        )).scalar()
    if v:
        return v
    # No run recorded yet (history from before the run log): fall back to
    # the newest backup present in Dropbox.
    try:
        from database.backup import BackupManager
        items = BackupManager.list_dropbox_backups()
        if items and items[0].get("created_at"):
            dt = datetime.fromisoformat(items[0]["created_at"])
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception as exc:
        logger.info("backup watchdog: Dropbox listing unavailable: %s", exc)
    return None


def watchdog() -> dict:
    """Hourly: close dead runs, and catch up a missed backup."""
    out = {"closed_stale": 0, "caught_up": False}
    if not _lock_free():
        return out   # a backup is running right now — nothing to judge yet

    with _engine().begin() as conn:
        out["closed_stale"] = conn.execute(_sql("""
            UPDATE backup_run SET status = 'failed', finished_at = NOW(),
                   error = 'Interrumpida: el proceso se detuvo durante la copia (reinicio o falta de memoria).'
             WHERE status = 'running' AND started_at < NOW() - make_interval(secs => :s)
        """), {"s": _STALE_RUNNING.total_seconds()}).rowcount or 0

    last = _last_success_at()
    due = _interval(_settings()) + _GRACE
    now = datetime.now(timezone.utc)
    if last is None or now - last > due:
        logger.warning("backup watchdog: last successful backup %s is overdue — catching up", last)
        run_backup("catchup")
        out["caught_up"] = True
    return out


# ── Health (Backups panel) ───────────────────────────────────────────────────

def _next_scheduled(settings: dict) -> Optional[str]:
    try:
        from apscheduler.triggers.cron import CronTrigger
        from database.maintenance import _backup_cron_kwargs
        trig = CronTrigger(timezone="UTC", **_backup_cron_kwargs(settings))
        nxt = trig.get_next_fire_time(None, datetime.now(timezone.utc))
        return nxt.isoformat() if nxt else None
    except Exception:
        return None


def health() -> dict:
    settings = _settings()
    interval = _interval(settings)
    with _engine().connect() as conn:
        rows = conn.execute(_sql("""
            SELECT id, trigger, started_at, finished_at, status, filename, size_mb,
                   dropbox_path, dropbox_error, error, warning
              FROM backup_run ORDER BY started_at DESC LIMIT 20
        """)).mappings().all()
    runs = [{
        **{k: r[k] for k in ("id", "trigger", "status", "filename", "dropbox_path",
                             "dropbox_error", "error", "warning")},
        "size_mb": float(r["size_mb"]) if r["size_mb"] is not None else None,
        "started_at": r["started_at"].isoformat() if r["started_at"] else None,
        "finished_at": r["finished_at"].isoformat() if r["finished_at"] else None,
    } for r in rows]

    last = _last_success_at()
    now = datetime.now(timezone.utc)
    age_h = round((now - last).total_seconds() / 3600, 1) if last else None
    overdue = last is None or (now - last) > interval + _GRACE
    last_run = runs[0] if runs else None

    problems = []
    if overdue:
        problems.append("No hay ninguna copia correcta reciente." if last is None else
                        f"La última copia correcta es de hace {age_h} h, más de lo que marca la frecuencia configurada.")
    if last_run and last_run["status"] == "failed":
        problems.append(f"La última copia falló: {last_run['error'] or 'error desconocido'}")
    if last_run and last_run["status"] == "partial":
        problems.append(f"La última copia no se subió a Dropbox: {last_run['dropbox_error']}")
    if last_run and last_run.get("warning"):
        problems.append(last_run["warning"])

    level = "error" if (overdue or (last_run and last_run["status"] == "failed")) else (
        "warning" if problems else "ok")
    return {
        "level": level,
        "problems": problems,
        "last_success_at": last.isoformat() if last else None,
        "age_hours": age_h,
        "interval_hours": round(interval.total_seconds() / 3600),
        "next_scheduled": _next_scheduled(settings),
        "settings": settings,
        "running": not _lock_free(),
        "runs": runs,
    }


# ── Alerts ───────────────────────────────────────────────────────────────────

def _alert(trigger: str, status: str, result: dict) -> None:
    try:
        from config import smtp_configured
        from core.users import list_admin_emails
        from core.smtp_client import send_email
        admins = list_admin_emails()
        if not admins or not smtp_configured():
            return
        kind = {"scheduled": "programada", "manual": "manual", "catchup": "de recuperación"}.get(trigger, trigger)
        if status == "failed":
            subject = "⚠ PrionLab — La copia de seguridad ha FALLADO"
            lines = [f"La copia de seguridad {kind} no se pudo hacer.",
                     f"Error: {result.get('error') or 'desconocido'}"]
        elif status == "partial":
            subject = "⚠ PrionLab — Copia de seguridad hecha pero NO subida a Dropbox"
            lines = [f"La copia {kind} se creó en el servidor ({result.get('filename')}, "
                     f"{result.get('size_mb')} MB) pero no se pudo subir a Dropbox.",
                     f"Motivo: {result.get('dropbox_error')}",
                     "Mientras no se resuelva, esa copia no es duradera (se pierde si el servidor se reinicia)."]
        else:
            subject = "PrionLab — Aviso sobre la copia de seguridad"
            lines = [f"Copia {kind} correcta: {result.get('filename')} ({result.get('size_mb')} MB)."]
        if trigger == "catchup":
            lines.append("Se ha lanzado automáticamente porque la última copia correcta era demasiado antigua "
                         "(probablemente la copia programada no llegó a ejecutarse).")
        if result.get("warning"):
            lines.append(result["warning"])
        lines.append("\nPuedes ver el estado completo en PrionVault → Backups.")
        send_email(admins[0], subject, "\n".join(lines), bcc=admins[1:] or None)
    except Exception:
        logger.exception("backup alert email failed")
