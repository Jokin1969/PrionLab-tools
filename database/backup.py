"""
Backup manager for PostgreSQL database.

Creates compressed dumps via pg_dump when available, falls back to
a per-table CSV export. Supports optional S3 upload when configured.
"""
import csv
import gzip
import io
import logging
import os
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Optional

import config

logger = logging.getLogger(__name__)

BACKUP_DIR = Path(config.DATA_DIR) / "backups"


class BackupManager:

    def __init__(self):
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    # ── Public API ────────────────────────────────────────────────────────────

    def create_backup(self) -> dict:
        """Create a compressed backup.  Returns status dict."""
        from database.config import db
        if not db.is_configured():
            return {"success": False, "error": "Database not configured"}
        ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        if shutil.which("pg_dump"):
            result = self._pg_dump_backup(db.database_url, ts)
        else:
            result = self._csv_export_backup(db, ts)
        if result.get("success"):
            # Optional S3 upload
            if self._s3_configured():
                try:
                    self._upload_to_s3(result["path"])
                except Exception as e:
                    logger.warning("S3 upload failed (backup still saved locally): %s", e)
            self.cleanup_old_backups()
        return result

    def list_backups(self) -> list[dict]:
        """Return info for all local backups, newest first."""
        backups = []
        for f in sorted(BACKUP_DIR.iterdir(), reverse=True):
            if f.suffix in (".gz", ".zip"):
                stat = f.stat()
                backups.append({
                    "filename": f.name,
                    "path": str(f),
                    "size_mb": round(stat.st_size / (1024 * 1024), 2),
                    "created_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                    "type": "pg_dump" if f.name.startswith("pgdump_") else "csv_export",
                })
        return backups

    def cleanup_old_backups(self, keep: int = 10) -> int:
        """Delete oldest backups beyond `keep` count.  Returns number deleted."""
        files = sorted(
            (f for f in BACKUP_DIR.iterdir() if f.suffix in (".gz", ".zip")),
            key=lambda f: f.stat().st_mtime,
            reverse=True,
        )
        deleted = 0
        for old in files[keep:]:
            try:
                old.unlink()
                deleted += 1
                logger.info("Deleted old backup: %s", old.name)
            except Exception as e:
                logger.warning("Could not delete backup %s: %s", old.name, e)
        return deleted

    def restore_from_backup(self, backup_path: str) -> dict:
        """Restore from a pg_dump .gz backup.  Use with extreme caution."""
        from database.config import db
        if not db.is_configured():
            return {"success": False, "error": "Database not configured"}
        path = Path(backup_path)
        if not path.exists():
            return {"success": False, "error": f"Backup file not found: {backup_path}"}
        if not path.name.startswith("pgdump_"):
            return {"success": False, "error": "Only pg_dump backups can be restored here"}
        if not shutil.which("psql"):
            return {"success": False, "error": "psql not found in PATH"}
        try:
            with gzip.open(path, "rb") as gz:
                sql = gz.read()
            proc = subprocess.run(
                ["psql", db.database_url],
                input=sql, capture_output=True, timeout=300,
            )
            if proc.returncode != 0:
                return {"success": False, "error": proc.stderr.decode()[:500]}
            logger.info("Database restored from %s", path.name)
            return {"success": True, "backup": path.name}
        except Exception as e:
            logger.error("Restore failed: %s", e)
            return {"success": False, "error": str(e)}

    # ── Private helpers ───────────────────────────────────────────────────────

    def _pg_dump_backup(self, url: str, ts: str) -> dict:
        out_path = BACKUP_DIR / f"pgdump_{ts}.sql.gz"
        try:
            proc = subprocess.run(
                ["pg_dump", "--no-password", "--clean", "--if-exists", url],
                capture_output=True, timeout=300,
            )
            if proc.returncode != 0:
                return {"success": False, "error": proc.stderr.decode()[:500]}
            with gzip.open(out_path, "wb") as gz:
                gz.write(proc.stdout)
            size_mb = round(out_path.stat().st_size / (1024 * 1024), 2)
            logger.info("pg_dump backup created: %s (%.1f MB)", out_path.name, size_mb)
            return {"success": True, "path": str(out_path),
                    "filename": out_path.name, "size_mb": size_mb, "type": "pg_dump"}
        except subprocess.TimeoutExpired:
            return {"success": False, "error": "pg_dump timed out after 300s"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def _csv_export_backup(self, db, ts: str) -> dict:
        """Export each table to CSV inside a .gz archive."""
        out_path = BACKUP_DIR / f"csv_export_{ts}.gz"
        try:
            import database.models as _m
            from sqlalchemy import inspect
            inspector = inspect(db.engine)
            buf = io.BytesIO()
            with gzip.GzipFile(fileobj=buf, mode="wb") as gz:
                for table_name in inspector.get_table_names():
                    csv_buf = io.StringIO()
                    writer = csv.writer(csv_buf)
                    with db.engine.connect() as conn:
                        from sqlalchemy import text as _text
                        result = conn.execute(_text(f"SELECT * FROM {table_name}"))
                        writer.writerow(result.keys())
                        for row in result:
                            writer.writerow(list(row))
                    content = f"-- TABLE: {table_name}\n{csv_buf.getvalue()}\n\n"
                    gz.write(content.encode("utf-8"))
            with open(out_path, "wb") as f:
                f.write(buf.getvalue())
            size_mb = round(out_path.stat().st_size / (1024 * 1024), 2)
            logger.info("CSV export backup: %s (%.1f MB)", out_path.name, size_mb)
            return {"success": True, "path": str(out_path),
                    "filename": out_path.name, "size_mb": size_mb, "type": "csv_export"}
        except Exception as e:
            logger.error("CSV export backup failed: %s", e)
            return {"success": False, "error": str(e)}

    @staticmethod
    def _s3_configured() -> bool:
        return bool(os.getenv("AWS_S3_BUCKET") and os.getenv("AWS_ACCESS_KEY_ID"))

    @staticmethod
    def _upload_to_s3(local_path: str) -> None:
        try:
            import boto3  # optional dependency
        except ImportError:
            logger.warning("boto3 not installed — S3 upload skipped")
            return
        bucket = os.getenv("AWS_S3_BUCKET")
        prefix = os.getenv("AWS_S3_PREFIX", "prionlab-backups/")
        key = prefix + Path(local_path).name
        s3 = boto3.client("s3")
        s3.upload_file(local_path, bucket, key)
        logger.info("Backup uploaded to s3://%s/%s", bucket, key)
