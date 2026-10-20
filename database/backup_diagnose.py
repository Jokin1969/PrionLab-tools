"""Step-by-step diagnosis of the backup pipeline ("🩺 Diagnosticar" in the
PrionVault Backups panel). Each check returns
    {"name", "status": ok|warn|fail|info, "detail", "hint"}
and never raises, so one broken step doesn't hide the others.
"""
from __future__ import annotations

import logging
import os
import shutil
import time
from pathlib import Path

logger = logging.getLogger(__name__)


def _mb(n) -> str:
    if n is None:
        return "?"
    n = float(n)
    return f"{n / (1024 ** 3):.2f} GB" if n >= 1024 ** 3 else f"{n / (1024 ** 2):.0f} MB"


def _check(name, fn):
    t0 = time.monotonic()
    try:
        status, detail, hint = fn()
    except Exception as exc:
        logger.exception("backup diagnose step %r crashed", name)
        status, detail, hint = "fail", f"Error al comprobarlo: {exc}", None
    return {"name": name, "status": status, "detail": detail, "hint": hint,
            "ms": int((time.monotonic() - t0) * 1000)}


def _read_int(path):
    try:
        v = Path(path).read_text().strip()
        return None if v in ("max", "") else int(v)
    except Exception:
        return None


def diagnose() -> list[dict]:
    from sqlalchemy import text
    from database.config import db
    from database.backup import BACKUP_DIR, BackupManager

    checks = []
    ctx = {}

    def database():
        with db.engine.connect() as conn:
            conn.execute(text("SELECT 1"))
            size = conn.execute(text("SELECT pg_database_size(current_database())")).scalar()
            top = conn.execute(text("""
                SELECT relname, pg_total_relation_size(c.oid) AS bytes
                  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relkind = 'r' AND n.nspname = 'public'
                 ORDER BY bytes DESC LIMIT 5""")).all()
        ctx["db_bytes"] = size
        tops = ", ".join(f"{r[0]} {_mb(r[1])}" for r in top)
        return "ok", f"Conectada. Tamaño total {_mb(size)}. Tablas más grandes: {tops}.", None
    checks.append(_check("Base de datos", database))

    def mode():
        pg = shutil.which("pg_dump")
        if pg:
            return "ok", f"Copia con pg_dump ({pg}).", None
        return "info", ("No hay pg_dump en el servidor: la copia se hace exportando cada tabla a CSV "
                        "(más lenta y que necesita más memoria que pg_dump)."), \
            "Si las copias siguen fallando por memoria o tiempo, instalar pg_dump en el servidor las haría más fiables."
    checks.append(_check("Método de copia", mode))

    def memory():
        limit = _read_int("/sys/fs/cgroup/memory.max") or _read_int("/sys/fs/cgroup/memory/memory.limit_in_bytes")
        used = _read_int("/sys/fs/cgroup/memory.current") or _read_int("/sys/fs/cgroup/memory/memory.usage_in_bytes")
        rss = None
        try:
            for line in Path("/proc/self/status").read_text().splitlines():
                if line.startswith("VmRSS:"):
                    rss = int(line.split()[1]) * 1024
        except Exception:
            pass
        if limit and limit > 1 << 50:
            limit = None   # "unlimited" sentinel
        detail = (f"Límite del contenedor: {_mb(limit) if limit else 'sin límite visible'}. "
                  f"En uso ahora: {_mb(used)}. Este proceso: {_mb(rss)}.")
        if limit and used and used > limit * 0.85:
            return "warn", detail, "El servidor está cerca de su límite de memoria: una copia grande puede hacer que se reinicie."
        return "ok", detail, None
    checks.append(_check("Memoria del servidor", memory))

    def disk():
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        test = BACKUP_DIR / ".write_test"
        test.write_text("ok")
        test.unlink()
        free = shutil.disk_usage(BACKUP_DIR).free
        partial = list(BACKUP_DIR.glob("*.partial"))
        local = [f for f in BACKUP_DIR.iterdir() if f.suffix in (".gz", ".zip")]
        need = None
        try:
            from database.backup_monitor import _engine, _sql
            with _engine().connect() as conn:
                need = conn.execute(_sql(
                    "SELECT MAX(size_mb) FROM backup_run WHERE size_mb IS NOT NULL")).scalar()
            need = float(need) * 1024 * 1024 * 1.3 if need else None
        except Exception:
            pass
        if need is None:
            need = 1300 * 1024 * 1024   # last known copies were ~1.2 GB
        detail = (f"Carpeta {BACKUP_DIR} con permiso de escritura. Libre: {_mb(free)} "
                  f"(una copia necesita ~{_mb(need)}). Copias locales: {len(local)} "
                  f"({_mb(sum(f.stat().st_size for f in local))}).")
        if partial:
            detail += f" Restos de copias a medias: {len(partial)}."
        if free < need:
            return "fail", detail, "No hay espacio en disco suficiente para una copia completa."
        return "ok", detail, None
    checks.append(_check("Disco del servidor", disk))

    def dropbox_auth():
        from core.dropbox_client import get_client
        client = get_client()
        if client is None:
            return "fail", "Dropbox no está configurado (faltan las credenciales).", \
                "Revisa DROPBOX_REFRESH_TOKEN / DROPBOX_APP_KEY / DROPBOX_APP_SECRET."
        acc = client.users_get_current_account()
        ctx["dbx"] = client
        return "ok", f"Conectado a la cuenta {acc.name.display_name} ({acc.email}).", None
    checks.append(_check("Dropbox: conexión", dropbox_auth))

    def dropbox_space():
        client = ctx.get("dbx")
        if not client:
            return "info", "Se omite: no hay conexión con Dropbox.", None
        u = client.users_get_space_usage()
        alloc = u.allocation
        total = None
        if alloc.is_individual():
            total = alloc.get_individual().allocated
        elif alloc.is_team():
            total = alloc.get_team().allocated
        free = (total - u.used) if total else None
        detail = f"Usado {_mb(u.used)} de {_mb(total)} — libre {_mb(free)}."
        need = 1300 * 1024 * 1024
        if free is not None and free < need:
            return "fail", detail, ("Dropbox no tiene espacio para otra copia (~1,3 GB). Libera espacio o "
                                    "reduce cuántas copias se guardan (pestaña Frecuencia y retención).")
        return "ok", detail, None
    checks.append(_check("Dropbox: espacio libre", dropbox_space))

    def dropbox_folder():
        client = ctx.get("dbx")
        if not client:
            return "info", "Se omite: no hay conexión con Dropbox.", None
        base = BackupManager._dropbox_base_dir()
        entries = BackupManager._list_dropbox_entries()
        size = sum(e["size"] for e in entries)
        newest = max((e["ts"] or e["server_modified"] for e in entries), default=None)
        return "ok", (f"Carpeta {base}: {len(entries)} copias ({_mb(size)}). "
                      f"La más reciente: {newest:%d/%m/%Y %H:%M}." if newest else
                      f"Carpeta {base}: sin copias todavía."), None
    checks.append(_check("Dropbox: carpeta de copias", dropbox_folder))

    def dropbox_write():
        client = ctx.get("dbx")
        if not client:
            return "info", "Se omite: no hay conexión con Dropbox.", None
        import dropbox
        path = BackupManager._dropbox_base_dir() + "/.prionlab_write_test.txt"
        client.files_upload(b"prionlab backup write test", path,
                            mode=dropbox.files.WriteMode.overwrite)
        client.files_delete_v2(path)
        return "ok", "Se ha podido escribir y borrar un archivo de prueba en la carpeta de copias.", None
    checks.append(_check("Dropbox: permiso de escritura", dropbox_write))

    def running_now():
        from database.backup_monitor import _engine, _lock_free, _sql, close_dead_runs
        closed = close_dead_runs()
        free = _lock_free()
        with _engine().connect() as conn:
            row = conn.execute(_sql("""
                SELECT started_at, trigger, worker_pid FROM backup_run
                 WHERE status = 'running' ORDER BY started_at DESC LIMIT 1""")).first()
        msg = ""
        if closed:
            msg = f"Se han cerrado {closed} copias que habían quedado colgadas (su proceso murió). "
        if free:
            return "ok", msg + "No hay ninguna copia en curso.", None
        if row:
            mins = int((time.time() - row[0].timestamp()) / 60)
            return "info", msg + f"Hay una copia en curso desde hace {mins} min ({row[1]}, proceso {row[2]}).", \
                ("Si lleva horas, probablemente se ha quedado bloqueada." if mins > 120 else None)
        return "info", msg + "Hay una copia en curso.", None
    checks.append(_check("Copia en curso", running_now))

    def history():
        from database.backup_monitor import _engine, _sql
        with _engine().connect() as conn:
            rows = conn.execute(_sql("""
                SELECT status, COUNT(*) FROM backup_run
                 WHERE started_at > NOW() - interval '14 days' GROUP BY status""")).all()
            errs = conn.execute(_sql("""
                SELECT COALESCE(error, dropbox_error), COUNT(*) FROM backup_run
                 WHERE started_at > NOW() - interval '14 days'
                   AND status IN ('failed', 'partial')
                 GROUP BY 1 ORDER BY 2 DESC LIMIT 3""")).all()
        counts = {r[0]: r[1] for r in rows}
        names = {"success": "correctas", "partial": "sin subir a Dropbox", "failed": "fallidas",
                 "running": "en curso", "skipped": "omitidas"}
        summary = ", ".join(f"{v} {names.get(k, k)}" for k, v in counts.items()) or "ningún intento"
        detail = f"Últimos 14 días: {summary}."
        if errs:
            detail += " Errores más frecuentes: " + "; ".join(f"«{(e[0] or '')[:160]}» ×{e[1]}" for e in errs)
        status = "fail" if counts.get("failed") and not counts.get("success") else (
            "warn" if counts.get("failed") or counts.get("partial") else "ok")
        return status, detail, None
    checks.append(_check("Historial reciente", history))

    def scheduler():
        from flask import current_app
        sched = getattr(current_app, "_maintenance_scheduler", None)
        inner = getattr(sched, "_scheduler", None)
        if not inner or not inner.running:
            return "fail", "El programador de tareas no está en marcha en este proceso del servidor.", \
                "Sin programador no hay copias automáticas: revisa el arranque de la aplicación."
        jobs = {j.id: j for j in inner.get_jobs()}
        parts = []
        for jid, label in (("weekly_backup", "copia programada"), ("backup_watchdog", "vigilante")):
            j = jobs.get(jid)
            parts.append(f"{label}: {j.next_run_time:%d/%m/%Y %H:%M} UTC" if j and j.next_run_time
                         else f"{label}: NO programado")
        ok = all(jid in jobs for jid in ("weekly_backup", "backup_watchdog"))
        return ("ok" if ok else "fail"), "En marcha. Próximas ejecuciones — " + "; ".join(parts) + ".", None
    checks.append(_check("Programador de tareas", scheduler))

    return checks
