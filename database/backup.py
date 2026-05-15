"""
Backup manager for PostgreSQL database.

Creates compressed dumps via pg_dump when available, falls back to
a per-table CSV export. Supports optional S3 upload when configured.

Also mirrors each successful backup to Dropbox under
``$PRIONLAB_BACKUP_DIR`` (default ``/PrionLab tools/Backups``) and
applies a daily+monthly retention policy on that folder, configurable
via ``PRIONLAB_BACKUP_RETAIN_DAILY`` (default 90) and
``PRIONLAB_BACKUP_RETAIN_MONTHLY`` (default 24).
"""
import csv
import gzip
import io
import logging
import os
import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Optional

import config

logger = logging.getLogger(__name__)

BACKUP_DIR = Path(config.DATA_DIR) / "backups"

DEFAULT_DROPBOX_BACKUP_DIR = "/PrionLab tools/Backups"
_DROPBOX_CHUNK_BYTES   = 8 * 1024 * 1024          # 8 MiB
_DROPBOX_SINGLESHOT_MAX = 150 * 1024 * 1024       # 150 MB API limit

# Filenames produced by `_pg_dump_backup` and `_csv_export_backup`:
#   pgdump_YYYYMMDD_HHMMSS.sql.gz
#   csv_export_YYYYMMDD_HHMMSS.gz
_BACKUP_TS_RE = re.compile(r"^(pgdump|csv_export)_(\d{8})_(\d{6})\.")


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
            # Mirror to Dropbox + apply retention there (independent of S3)
            if self._dropbox_configured():
                try:
                    dbx_path = self._upload_to_dropbox(result["path"])
                    if dbx_path:
                        result["dropbox_path"] = dbx_path
                    pruned = self._apply_dropbox_retention(
                        daily=_env_int("PRIONLAB_BACKUP_RETAIN_DAILY", 90),
                        monthly=_env_int("PRIONLAB_BACKUP_RETAIN_MONTHLY", 24),
                    )
                    if pruned:
                        result["dropbox_pruned"] = pruned
                except Exception as e:
                    logger.warning("Dropbox backup step failed "
                                   "(local copy still saved): %s", e)
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

    # ── Dropbox mirror + retention ────────────────────────────────────────────

    @staticmethod
    def _dropbox_configured() -> bool:
        try:
            from config import dropbox_configured
        except Exception:
            return False
        return bool(dropbox_configured())

    @staticmethod
    def _dropbox_base_dir() -> str:
        return os.getenv("PRIONLAB_BACKUP_DIR",
                         DEFAULT_DROPBOX_BACKUP_DIR).rstrip("/")

    @staticmethod
    def _upload_to_dropbox(local_path: str) -> Optional[str]:
        """Upload `local_path` to Dropbox. Returns the Dropbox path on
        success, or None on failure. Uses upload sessions for files
        larger than 150 MB."""
        try:
            from core.dropbox_client import get_client
            import dropbox
        except Exception as exc:
            logger.warning("Dropbox SDK unavailable: %s", exc)
            return None
        client = get_client()
        if client is None:
            return None

        target = f"{BackupManager._dropbox_base_dir()}/{Path(local_path).name}"
        size = Path(local_path).stat().st_size
        try:
            with open(local_path, "rb") as fh:
                if size <= _DROPBOX_SINGLESHOT_MAX:
                    client.files_upload(
                        fh.read(), target,
                        mode=dropbox.files.WriteMode.overwrite, mute=True)
                else:
                    # Chunked upload session for files > 150 MB.
                    session = client.files_upload_session_start(
                        fh.read(_DROPBOX_CHUNK_BYTES))
                    cursor = dropbox.files.UploadSessionCursor(
                        session_id=session.session_id, offset=fh.tell())
                    commit = dropbox.files.CommitInfo(
                        path=target,
                        mode=dropbox.files.WriteMode.overwrite, mute=True)
                    while True:
                        chunk = fh.read(_DROPBOX_CHUNK_BYTES)
                        if not chunk:
                            client.files_upload_session_finish(
                                b"", cursor, commit)
                            break
                        if (size - fh.tell()) <= 0:
                            client.files_upload_session_finish(
                                chunk, cursor, commit)
                            break
                        client.files_upload_session_append_v2(chunk, cursor)
                        cursor.offset = fh.tell()
            logger.info("Backup uploaded to Dropbox: %s", target)
            return target
        except Exception as exc:
            logger.warning("Dropbox upload failed for %s: %s", target, exc)
            return None

    @classmethod
    def _list_dropbox_entries(cls) -> list[dict]:
        """Return raw Dropbox entries that look like backups, with
        parsed timestamps. Each dict has: name, path_lower,
        path_display, size, ts (datetime or None)."""
        try:
            from core.dropbox_client import get_client
        except Exception:
            return []
        client = get_client()
        if client is None:
            return []
        base = cls._dropbox_base_dir()
        try:
            res = client.files_list_folder(base)
        except Exception as exc:
            logger.warning("Could not list Dropbox folder %s: %s", base, exc)
            return []
        out = []
        while True:
            for entry in res.entries:
                # Skip folders (no 'size' attribute on FolderMetadata).
                if not hasattr(entry, "size"):
                    continue
                ts = _parse_backup_ts(entry.name)
                out.append({
                    "name":         entry.name,
                    "path_lower":   entry.path_lower,
                    "path_display": entry.path_display or entry.name,
                    "size":         entry.size,
                    "ts":           ts,
                    "server_modified": getattr(entry, "server_modified", None),
                })
            if not getattr(res, "has_more", False):
                break
            try:
                res = client.files_list_folder_continue(res.cursor)
            except Exception as exc:
                logger.warning("Dropbox pagination failed: %s", exc)
                break
        return out

    @classmethod
    def list_dropbox_backups(cls) -> list[dict]:
        """Return Dropbox backup entries shaped like `list_backups()`,
        newest first. Empty list if Dropbox is not configured or the
        folder does not exist yet."""
        entries = cls._list_dropbox_entries()
        items = []
        for e in entries:
            created = (e["ts"] or e["server_modified"])
            items.append({
                "filename":   e["name"],
                "path":       e["path_display"],
                "size_mb":    round(e["size"] / (1024 * 1024), 2),
                "created_at": created.isoformat() if created else "",
                "type": ("pg_dump" if e["name"].startswith("pgdump_")
                         else "csv_export"),
            })
        items.sort(key=lambda x: x["created_at"], reverse=True)
        return items

    @classmethod
    def _apply_dropbox_retention(cls, *, daily: int, monthly: int) -> int:
        """Prune old backups in the Dropbox folder. Returns count
        deleted. The newest `daily` daily backups are always kept,
        plus the chronologically-first backup of each of the last
        `monthly` months."""
        try:
            from core.dropbox_client import get_client
        except Exception:
            return 0
        client = get_client()
        if client is None:
            return 0

        entries = [e for e in cls._list_dropbox_entries() if e["ts"]]
        if not entries:
            return 0
        keep = _select_keep(
            [(e["name"], e["ts"]) for e in entries],
            daily=daily, monthly=monthly,
        )
        deleted = 0
        for e in entries:
            if e["name"] in keep:
                continue
            try:
                client.files_delete_v2(e["path_lower"])
                deleted += 1
                logger.info("Pruned Dropbox backup: %s", e["name"])
            except Exception as exc:
                logger.warning("Could not delete Dropbox backup %s: %s",
                               e["path_lower"], exc)
        if deleted:
            logger.info("Dropbox retention pruned %d files", deleted)
        return deleted


# ── Module-level helpers ─────────────────────────────────────────────────────

def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return max(0, int(raw))
    except ValueError:
        logger.warning("Invalid int for %s=%r — using default %d",
                       name, raw, default)
        return default


def _parse_backup_ts(name: str) -> Optional[datetime]:
    m = _BACKUP_TS_RE.match(name)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(2) + m.group(3), "%Y%m%d%H%M%S")
    except ValueError:
        return None


def _select_keep(entries: list[tuple[str, datetime]],
                 *, daily: int, monthly: int) -> set[str]:
    """Decide which backups to keep.

    Keep:
      • every entry within the last `daily` days, AND
      • the chronologically-earliest entry of each calendar month
        for the most recent `monthly` distinct months.

    Returns the set of filenames to keep.
    """
    now = datetime.utcnow()
    keep: set[str] = set()

    # 1) Last `daily` days
    if daily > 0:
        from datetime import timedelta
        cutoff = now - timedelta(days=daily)
        for name, ts in entries:
            if ts >= cutoff:
                keep.add(name)

    # 2) First-of-month for the last `monthly` months
    if monthly > 0:
        earliest: dict[tuple[int, int], tuple[str, datetime]] = {}
        for name, ts in entries:
            key = (ts.year, ts.month)
            if key not in earliest or ts < earliest[key][1]:
                earliest[key] = (name, ts)
        for key in sorted(earliest.keys(), reverse=True)[:monthly]:
            keep.add(earliest[key][0])
    return keep
