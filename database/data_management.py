"""
Data Management Service — wraps the existing backup, sync and maintenance
infrastructure to expose a unified status and control API.
"""
import csv
import io
import logging
import os
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

import config

logger = logging.getLogger(__name__)

BACKUP_DIR = Path(config.DATA_DIR) / "backups"
CSV_DIR = Path(config.CSV_DIR)


# ── Storage status ────────────────────────────────────────────────────────────

def get_storage_status() -> Dict:
    """Return comprehensive status of all storage systems."""
    data_path = Path(config.DATA_DIR)
    status: Dict = {}

    # Volume usage
    try:
        usage = shutil.disk_usage(data_path)
        status["volume"] = {
            "path": str(data_path),
            "total_gb": round(usage.total / 1024 ** 3, 2),
            "used_gb": round(usage.used / 1024 ** 3, 2),
            "free_gb": round(usage.free / 1024 ** 3, 2),
            "usage_pct": round(usage.used / usage.total * 100, 1),
        }
    except Exception as e:
        status["volume"] = {"error": str(e)}

    # SQLite metadata DB
    db_path = Path(config.DB_PATH)
    status["metadata_db"] = {
        "path": str(db_path),
        "exists": db_path.exists(),
        "size_mb": round(db_path.stat().st_size / 1024 ** 2, 3) if db_path.exists() else 0,
        "last_sync": _get_last_sync_time(),
    }

    # PostgreSQL status
    status["postgresql"] = _get_postgresql_status()

    # CSV files
    csv_files = list(CSV_DIR.glob("*.csv")) if CSV_DIR.exists() else []
    total_csv_size = sum(f.stat().st_size for f in csv_files)
    status["csv_storage"] = {
        "directory": str(CSV_DIR),
        "file_count": len(csv_files),
        "files": [{"name": f.name, "size_kb": round(f.stat().st_size / 1024, 1)} for f in sorted(csv_files)],
        "total_mb": round(total_csv_size / 1024 ** 2, 2),
    }

    # Backups
    status["backups"] = _get_backup_summary()

    # Dropbox
    status["dropbox"] = _get_dropbox_status()

    return status


def _get_last_sync_time() -> Optional[str]:
    db_path = Path(config.DB_PATH)
    if not db_path.exists():
        return None
    try:
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT value FROM app_meta WHERE key='last_dropbox_sync'"
        ).fetchone()
        conn.close()
        return row["value"] if row else None
    except Exception:
        return None


def _get_postgresql_status() -> Dict:
    try:
        from database.config import db
        if not db.is_configured():
            return {"configured": False, "status": "CSV-only mode"}
        if not db.test_connection():
            return {"configured": True, "status": "connection_failed"}
        with db.get_session() as s:
            result = s.execute(
                db._engine.dialect.dbapi.connect  # just probe connection
            ) if False else None  # noqa – just test via is_configured
            pass
        return {"configured": True, "status": "connected", "url_masked": _mask_db_url(db.database_url)}
    except Exception as e:
        return {"configured": True, "status": "error", "detail": str(e)}


def _mask_db_url(url: str) -> str:
    """Mask password in database URL."""
    if url and "@" in url:
        parts = url.split("@")
        credentials = parts[0].split("//")[-1]
        if ":" in credentials:
            user = credentials.split(":")[0]
            return url.replace(credentials, f"{user}:***")
    return url


def _get_backup_summary() -> Dict:
    if not BACKUP_DIR.exists():
        return {"count": 0, "latest": None, "total_mb": 0}
    backups = sorted(
        [f for f in BACKUP_DIR.iterdir() if f.suffix in (".gz", ".zip")],
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    )
    total_size = sum(f.stat().st_size for f in backups)
    return {
        "count": len(backups),
        "latest": {
            "filename": backups[0].name,
            "size_mb": round(backups[0].stat().st_size / 1024 ** 2, 2),
            "created_at": datetime.fromtimestamp(backups[0].stat().st_mtime).isoformat(),
        } if backups else None,
        "total_mb": round(total_size / 1024 ** 2, 2),
    }


def _get_dropbox_status() -> Dict:
    if not config.dropbox_configured():
        return {"configured": False}
    try:
        from core.dropbox_client import get_client
        client = get_client()
        if client is None:
            return {"configured": True, "status": "client_unavailable"}
        account = client.users_get_current_account()
        return {
            "configured": True,
            "status": "connected",
            "account": account.email,
            "remote_folder": config.DROPBOX_REMOTE_FOLDER,
            "last_sync": _get_last_sync_time(),
        }
    except Exception as e:
        return {"configured": True, "status": "error", "detail": str(e)}


# ── Backup operations ─────────────────────────────────────────────────────────

def trigger_backup(backup_type: str = "auto") -> Dict:
    """
    Trigger a database backup.
    backup_type: 'auto' (pg_dump or CSV fallback), 'csv_only'
    """
    from database.backup import BackupManager
    bm = BackupManager()

    if backup_type == "csv_only":
        result = _csv_only_backup()
    else:
        result = bm.create_backup()

    return result


def _csv_only_backup() -> Dict:
    """Export all local CSV files into a timestamped gzip archive."""
    import gzip
    import tarfile

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    archive_path = BACKUP_DIR / f"csv_export_{ts}.tar.gz"

    csv_files = list(CSV_DIR.glob("*.csv")) if CSV_DIR.exists() else []
    if not csv_files:
        return {"success": False, "error": "No CSV files found to backup"}

    try:
        with tarfile.open(archive_path, "w:gz") as tar:
            for f in csv_files:
                tar.add(f, arcname=f.name)
        size_mb = round(archive_path.stat().st_size / 1024 ** 2, 2)
        logger.info("CSV-only backup created: %s (%.2f MB)", archive_path.name, size_mb)
        return {
            "success": True,
            "path": str(archive_path),
            "filename": archive_path.name,
            "type": "csv_only",
            "files_included": len(csv_files),
            "size_mb": size_mb,
        }
    except Exception as e:
        logger.error("CSV-only backup failed: %s", e)
        return {"success": False, "error": str(e)}


def list_backups() -> List[Dict]:
    """List all available local backups."""
    from database.backup import BackupManager
    return BackupManager().list_backups()


# ── Integrity check ───────────────────────────────────────────────────────────

def perform_integrity_check() -> Dict:
    """Check data integrity across all storage systems."""
    results: Dict = {
        "check_id": f"ic_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "checks": {},
        "issues": [],
        "health_score": 1.0,
    }

    checks = results["checks"]
    issues = results["issues"]

    # 1. DATA_DIR exists and is writable
    data_path = Path(config.DATA_DIR)
    checks["data_dir_exists"] = data_path.exists()
    if checks["data_dir_exists"]:
        try:
            probe = data_path / ".write_probe"
            probe.write_text("ok")
            probe.unlink()
            checks["data_dir_writable"] = True
        except Exception:
            checks["data_dir_writable"] = False
            issues.append("DATA_DIR is not writable")
    else:
        checks["data_dir_writable"] = False
        issues.append("DATA_DIR does not exist")

    # 2. Metadata SQLite DB
    db_path = Path(config.DB_PATH)
    checks["metadata_db_exists"] = db_path.exists()
    if db_path.exists():
        try:
            conn = sqlite3.connect(str(db_path))
            conn.execute("PRAGMA integrity_check")
            conn.close()
            checks["metadata_db_integrity"] = True
        except Exception as e:
            checks["metadata_db_integrity"] = False
            issues.append(f"Metadata DB integrity failed: {e}")

    # 3. CSV files readable
    if CSV_DIR.exists():
        bad_csvs = []
        for csv_file in CSV_DIR.glob("*.csv"):
            try:
                with open(csv_file, newline="", encoding="utf-8") as f:
                    reader = csv.reader(f)
                    next(reader, None)
            except Exception:
                bad_csvs.append(csv_file.name)
        checks["csv_files_readable"] = len(bad_csvs) == 0
        if bad_csvs:
            issues.append(f"Unreadable CSV files: {', '.join(bad_csvs)}")
    else:
        checks["csv_dir_exists"] = False
        issues.append("CSV directory does not exist")

    # 4. PostgreSQL (if configured)
    try:
        from database.config import db
        if db.is_configured():
            checks["postgresql_connection"] = db.test_connection()
            if not checks["postgresql_connection"]:
                issues.append("PostgreSQL connection failed")
        else:
            checks["postgresql_configured"] = False
    except Exception as e:
        checks["postgresql_check_error"] = str(e)

    # 5. Dropbox connection (if configured)
    if config.dropbox_configured():
        dropbox_st = _get_dropbox_status()
        checks["dropbox_connected"] = dropbox_st.get("status") == "connected"
        if not checks["dropbox_connected"]:
            issues.append("Dropbox connection unavailable")

    # Health score = fraction of True checks
    bool_checks = {k: v for k, v in checks.items() if isinstance(v, bool)}
    if bool_checks:
        results["health_score"] = round(sum(bool_checks.values()) / len(bool_checks), 2)

    results["passed"] = len(issues) == 0
    return results


# ── Dropbox sync ──────────────────────────────────────────────────────────────

def sync_csv_to_dropbox(filenames: Optional[List[str]] = None) -> Dict:
    """
    Push CSV files to Dropbox.
    If filenames is None, push all CSV files in CSV_DIR.
    """
    from core.sync import push_to_dropbox
    if not config.dropbox_configured():
        return {"success": False, "error": "Dropbox not configured"}

    if filenames is None:
        filenames = [f.name for f in CSV_DIR.glob("*.csv")] if CSV_DIR.exists() else []

    pushed = []
    failed = []
    for fname in filenames:
        ok = push_to_dropbox(fname)
        (pushed if ok else failed).append(fname)

    return {
        "success": len(failed) == 0,
        "pushed": pushed,
        "failed": failed,
        "total": len(filenames),
    }


def pull_csv_from_dropbox() -> Dict:
    """Pull latest CSV files from Dropbox."""
    from core.sync import pull_from_dropbox
    if not config.dropbox_configured():
        return {"success": False, "error": "Dropbox not configured"}
    try:
        updated = pull_from_dropbox()
        return {"success": True, "updated_files": updated, "count": len(updated)}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ── Storage optimization ──────────────────────────────────────────────────────

def optimize_storage() -> Dict:
    """Clean up temp files and optionally vacuum the metadata DB."""
    results = []

    # 1. Clean temp/cache dir
    cache_dir = Path(config.CACHE_DIR)
    removed = 0
    if cache_dir.exists():
        for f in cache_dir.rglob("*"):
            if f.is_file():
                try:
                    f.unlink()
                    removed += 1
                except Exception:
                    pass
        results.append(f"Cache cleaned: {removed} files removed")

    # 2. Vacuum metadata SQLite
    db_path = Path(config.DB_PATH)
    if db_path.exists():
        try:
            conn = sqlite3.connect(str(db_path))
            conn.execute("VACUUM")
            conn.close()
            results.append("Metadata DB vacuumed")
        except Exception as e:
            results.append(f"DB vacuum failed: {e}")

    # 3. Trim old backups (keep 10)
    from database.backup import BackupManager
    deleted = BackupManager().cleanup_old_backups(keep=10)
    results.append(f"Old backups pruned: {deleted} removed")

    return {"success": True, "actions": results}


# ── Export table to CSV ───────────────────────────────────────────────────────

def export_table_to_csv(table_name: str, upload_dropbox: bool = False) -> Dict:
    """Export a PostgreSQL table to a CSV file in CSV_DIR."""
    try:
        from database.config import db
        if not db.is_configured():
            return {"success": False, "error": "Database not configured"}
        import pandas as pd
        with db.get_session() as s:
            df = pd.read_sql_query(f"SELECT * FROM {table_name}", s.bind)  # type: ignore
        CSV_DIR.mkdir(parents=True, exist_ok=True)
        out_path = CSV_DIR / f"{table_name}.csv"
        df.to_csv(out_path, index=False, encoding="utf-8")
        size_kb = round(out_path.stat().st_size / 1024, 1)
        result: Dict = {
            "success": True,
            "table": table_name,
            "rows": len(df),
            "path": str(out_path),
            "size_kb": size_kb,
        }
        if upload_dropbox:
            sync_result = sync_csv_to_dropbox([out_path.name])
            result["dropbox_upload"] = sync_result
        return result
    except Exception as e:
        logger.error("Table export failed for %s: %s", table_name, e)
        return {"success": False, "error": str(e), "table": table_name}
