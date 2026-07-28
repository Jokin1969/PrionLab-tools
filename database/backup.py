"""
Backup manager for PostgreSQL database.

Creates compressed dumps via pg_dump when available, falls back to
a per-table CSV export. Supports optional S3 upload when configured.

Also mirrors each successful backup to Dropbox under
``$PRIONLAB_BACKUP_DIR`` (default ``/PrionLab tools/Backups``) and
applies a count+monthly retention policy on that folder. Schedule and
retention are configurable at runtime via the `backup_settings` table
(see migrations/070_backup_settings.sql) rather than env vars, editable
from the admin "Backups" panel.
"""
import ast
import csv
import gzip
import io
import json
import logging
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

import config

logger = logging.getLogger(__name__)

# The csv module's default per-field size cap (128 KiB) is too small for
# long article fields (e.g. extraction_text, summary_ai) — raise it so
# CSV export/restore doesn't choke on a single oversized cell. sys.maxsize
# can overflow the platform C long on some systems; fall back if so.
try:
    csv.field_size_limit(sys.maxsize)
except OverflowError:
    csv.field_size_limit(2**31 - 1)

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
                    settings = get_backup_settings()
                    pruned = self._apply_dropbox_retention(
                        retain_count=settings["retain_count"],
                        monthly=settings["retain_monthly"],
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

    def restore_from_csv_export(self, backup_path: str, only_tables: Optional[set] = None,
                                 acknowledge_data_loss: Optional[set] = None) -> dict:
        """Restore from a CSV export .gz backup.

        CSV exports are structured as:
          -- TABLE: table_name
          col1,col2,col3
          val1,val2,val3
          ...

          -- TABLE: another_table
          ...

        Uses PostgreSQL COPY for robust, fast bulk restoration.

        `only_tables`, if given, restricts the restore to that subset of
        table names — every other table in the backup is ignored
        entirely (not truncated, not touched). Use this for a surgical
        recovery of specific tables rather than rolling the whole
        database back to the backup's point in time, which would also
        overwrite any table's *current* data with no relation to the
        problem being fixed (e.g. user sessions/preferences, labs,
        publications) with day(s)-old data, silently destroying
        everything users did since the backup was taken.

        `acknowledge_data_loss`, if given, is a set of table names the
        caller explicitly accepts losing via TRUNCATE CASCADE even
        though they have no data queued to reload afterward (e.g.
        regenerable embeddings tables deliberately excluded from the
        export). Without this, any such table blocks the whole restore.
        """
        from database.config import db
        if not db.is_configured():
            return {"success": False, "error": "Database not configured"}
        path = Path(backup_path)
        if not path.exists():
            return {"success": False, "error": f"Backup file not found: {backup_path}"}
        if not path.name.startswith("csv_export_"):
            return {"success": False, "error": "Only csv_export backups can be restored here"}

        try:
            logger.warning("Starting CSV restore from %s", path.name)
            tables_restored = 0
            rows_restored = 0

            with gzip.open(path, "rb") as gz:
                content = gz.read().decode("utf-8")

            # Connect directly with psycopg2 (not through SQLAlchemy)
            try:
                import psycopg2
            except ImportError:
                return {"success": False, "error": "psycopg2 not available"}

            psycopg2_conn = psycopg2.connect(db.database_url)
            cell_warnings = []
            try:
                with psycopg2_conn.cursor() as cursor:
                    real_tables = _get_real_tables(cursor)
                if not real_tables:
                    return {"success": False, "error": "Could not introspect current schema tables"}

                parsed = _parse_csv_backup(content, real_tables)

                if only_tables is not None:
                    requested_missing = sorted(set(only_tables) - set(parsed.keys()))
                    if requested_missing:
                        logger.warning(
                            "Requested tables not found (or empty) in backup: %s",
                            requested_missing,
                        )
                    parsed = {t: v for t, v in parsed.items() if t in only_tables}

                if not parsed:
                    return {"success": False, "error": "No non-empty tables found in backup"}

                with psycopg2_conn.cursor() as cursor:
                    all_edges = _get_all_fk_edges(cursor)

                plan = _compute_restore_plan(parsed, all_edges, acknowledge_data_loss)
                order = plan["order"]
                blocking = plan["blocking"]
                acknowledged = plan["acknowledged"]
                if acknowledged:
                    logger.warning(
                        "Restore will empty %s via CASCADE with no data to "
                        "reload — explicitly acknowledged, proceeding",
                        sorted(acknowledged),
                    )
                if blocking:
                    return {
                        "success": False,
                        "error": (
                            "Refusing to restore: TRUNCATE CASCADE would also "
                            f"empty {blocking}, which have no data in this "
                            "backup to reload afterward."
                        ),
                    }

                with psycopg2_conn.cursor() as cursor:
                    # Truncate every table in ONE statement so a later
                    # table's CASCADE can't wipe out rows already loaded
                    # into an earlier table — all truncation happens
                    # before any insertion starts.
                    quoted = ", ".join(f'"{t}"' for t in order)
                    cursor.execute(f"TRUNCATE TABLE {quoted} CASCADE")
                psycopg2_conn.commit()

                for table_name in order:
                    header, data_rows = parsed[table_name]
                    logger.info("Restoring table %s (%d rows)", table_name, len(data_rows))

                    # Restore this table using COPY
                    try:
                        with psycopg2_conn.cursor() as cursor:
                            # Some older CSV exports serialized json/jsonb
                            # and array column values with Python's str()/
                            # repr() (single-quoted dict/list syntax) instead
                            # of valid JSON / Postgres array literals. Detect
                            # those columns and repair affected cells before
                            # COPY, so one bad cell doesn't abort the whole
                            # table.
                            cursor.execute(
                                "SELECT column_name, data_type FROM information_schema.columns "
                                "WHERE table_name = %s", (table_name,)
                            )
                            col_types = dict(cursor.fetchall())
                            json_cols = {c for c in header if col_types.get(c) in ("json", "jsonb")}
                            array_cols = {c for c in header if col_types.get(c) == "ARRAY"}

                            if json_cols or array_cols:
                                data_rows, nulled = _repair_json_and_array_cells(
                                    header, data_rows, json_cols, array_cols
                                )
                                if nulled:
                                    msg = f"{table_name}: nulled {nulled} malformed json/array cell(s)"
                                    logger.warning(msg)
                                    cell_warnings.append(msg)

                            # Use COPY with escape format to properly handle NULLs
                            # In escape format: \N represents NULL, \\ represents backslash
                            cols = ",".join(header)
                            copy_sql = f'COPY "{table_name}" ({cols}) FROM STDIN WITH (FORMAT text, NULL \'\\N\')'

                            # Convert CSV rows to escape format with \N for empty strings (NULLs)
                            copy_data = io.StringIO()
                            for row in data_rows:
                                escaped_row = []
                                for val in row:
                                    if val == '':
                                        escaped_row.append('\\N')
                                    else:
                                        # Escape backslashes, tabs and embedded
                                        # newlines/carriage returns — text
                                        # format COPY uses newlines as row
                                        # terminators, so real newlines in a
                                        # field (e.g. multi-line summaries)
                                        # must be escaped or they'd split
                                        # the row prematurely.
                                        escaped_val = (
                                            val.replace('\\', '\\\\')
                                               .replace('\t', '\\t')
                                               .replace('\n', '\\n')
                                               .replace('\r', '\\r')
                                        )
                                        escaped_row.append(escaped_val)
                                copy_data.write('\t'.join(escaped_row) + '\n')
                            copy_data.seek(0)

                            # Execute COPY FROM STDIN using raw psycopg2
                            cursor.copy_expert(copy_sql, copy_data)

                            # COPY inserts explicit primary key values from
                            # the backup as-is. For an integer PK backed by
                            # a sequence (SERIAL/IDENTITY — e.g. an
                            # auto-increment "id"), Postgres does NOT
                            # advance that sequence to match, since COPY
                            # never calls nextval(). The next ordinary
                            # INSERT (no explicit id) then collides with an
                            # id the restore just (re)introduced. Bring the
                            # sequence forward to MAX(id)+1 right after
                            # loading — a no-op for UUID/text primary keys,
                            # since pg_get_serial_sequence returns NULL for
                            # those.
                            if 'id' in header:
                                cursor.execute(
                                    "SELECT pg_get_serial_sequence(%s, 'id')",
                                    (table_name,)
                                )
                                seq = cursor.fetchone()[0]
                                if seq:
                                    cursor.execute(
                                        f'SELECT setval(%s, '
                                        f'COALESCE((SELECT MAX(id) FROM "{table_name}"), 0) + 1, '
                                        f'false)',
                                        (seq,)
                                    )

                        psycopg2_conn.commit()
                        rows_restored += len(data_rows)
                        tables_restored += 1
                    except Exception as e:
                        psycopg2_conn.rollback()
                        logger.error("Failed to restore table %s: %s", table_name, e)
                        raise
            finally:
                psycopg2_conn.close()

            logger.info(
                "CSV restore completed: %d tables, %d rows",
                tables_restored, rows_restored
            )
            result = {
                "success": True,
                "backup": path.name,
                "tables_restored": tables_restored,
                "rows_restored": rows_restored,
            }
            if cell_warnings:
                result["warnings"] = cell_warnings
            return result
        except Exception as e:
            logger.error("CSV restore failed: %s", e)
            return {"success": False, "error": str(e)[:500]}

    def verify_csv_export(self, backup_path: str, only_tables: Optional[set] = None) -> dict:
        """Read-only dry run of a csv_export restore: parses the backup
        and computes exactly what restore_from_csv_export would do,
        WITHOUT touching the database (no TRUNCATE, no COPY, no writes
        of any kind — every query is a SELECT).

        Returns a report: per-table row counts found in the backup,
        tables in the backup no longer present in the current schema,
        the computed restore order, any table that TRUNCATE CASCADE
        would empty with no data to reload (the same check
        restore_from_csv_export enforces), and a best-effort count of
        json/array cells that look like they'd need repair. Use this to
        confirm a backup is restorable *before* an emergency, not
        during one.
        """
        from database.config import db
        if not db.is_configured():
            return {"success": False, "error": "Database not configured"}
        path = Path(backup_path)
        if not path.exists():
            return {"success": False, "error": f"Backup file not found: {backup_path}"}
        if not path.name.startswith("csv_export_"):
            return {"success": False, "error": "Only csv_export backups can be verified here"}

        try:
            with gzip.open(path, "rb") as gz:
                content = gz.read().decode("utf-8")
        except Exception as e:
            return {"success": False, "error": f"Could not read/decompress backup: {e}"}

        try:
            import psycopg2
        except ImportError:
            return {"success": False, "error": "psycopg2 not available"}

        try:
            conn = psycopg2.connect(db.database_url)
        except Exception as e:
            return {"success": False, "error": f"Could not connect to database: {e}"}
        try:
            with conn.cursor() as cursor:
                real_tables = _get_real_tables(cursor)
            if not real_tables:
                return {"success": False, "error": "Could not introspect current schema tables"}

            parsed = _parse_csv_backup(content, real_tables)
            backup_table_names = set(parsed.keys())

            considered = parsed
            if only_tables is not None:
                considered = {t: v for t, v in parsed.items() if t in only_tables}

            with conn.cursor() as cursor:
                all_edges = _get_all_fk_edges(cursor)
            plan = _compute_restore_plan(considered, all_edges, acknowledge_data_loss=None)

            # Best-effort scan for json/array cells that would need
            # repair (Python-repr artifacts from an older, buggy
            # export) — read-only, no mutation.
            repair_estimate = {}
            with conn.cursor() as cursor:
                for table_name, (header, data_rows) in considered.items():
                    cursor.execute(
                        "SELECT column_name, data_type FROM information_schema.columns "
                        "WHERE table_name = %s", (table_name,)
                    )
                    col_types = dict(cursor.fetchall())
                    json_cols = {c for c in header if col_types.get(c) in ("json", "jsonb")}
                    array_cols = {c for c in header if col_types.get(c) == "ARRAY"}
                    if not json_cols and not array_cols:
                        continue
                    _, nulled = _repair_json_and_array_cells(
                        header, data_rows, json_cols, array_cols
                    )
                    if nulled:
                        repair_estimate[table_name] = nulled

            tables_report = [
                {"table": t, "rows": len(rows), "columns": len(header)}
                for t, (header, rows) in sorted(parsed.items())
            ]
            size_mb = round(path.stat().st_size / (1024 * 1024), 2)

            return {
                "success": True,
                "backup": path.name,
                "size_mb": size_mb,
                "tables_found": len(backup_table_names),
                "total_rows": sum(len(rows) for _, rows in parsed.values()),
                "tables": tables_report,
                "restore_order": plan["order"],
                "would_block": plan["blocking"],
                "unrepairable_json_array_cells": repair_estimate,
            }
        except Exception as e:
            logger.error("Backup verification failed: %s", e)
            return {"success": False, "error": str(e)[:500]}
        finally:
            conn.close()

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
        """Export each table to CSV inside a .gz archive.

        Every column is selected with an explicit ``::text`` cast so
        PostgreSQL's own type output functions render json/jsonb, arrays,
        timestamps, etc. into the exact textual form its input functions
        expect back on restore. Without this, the raw Python driver values
        for json/array columns (dicts/lists) get passed through csv.writer's
        str()/repr(), producing single-quoted Python literal syntax that is
        NOT valid JSON or a valid Postgres array literal.
        """
        out_path = BACKUP_DIR / f"csv_export_{ts}.gz"
        try:
            import database.models as _m
            from sqlalchemy import inspect
            from sqlalchemy import text as _text
            inspector = inspect(db.engine)
            buf = io.BytesIO()
            with gzip.GzipFile(fileobj=buf, mode="wb") as gz:
                for table_name in inspector.get_table_names():
                    columns = [c["name"] for c in inspector.get_columns(table_name)]
                    if not columns:
                        continue
                    select_cols = ", ".join(f'"{c}"::text AS "{c}"' for c in columns)
                    csv_buf = io.StringIO()
                    writer = csv.writer(csv_buf)
                    with db.engine.connect() as conn:
                        result = conn.execute(_text(f'SELECT {select_cols} FROM "{table_name}"'))
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
    def _apply_dropbox_retention(cls, *, retain_count: int, monthly: int) -> int:
        """Prune old backups in the Dropbox folder. Returns count
        deleted. The newest `retain_count` backups are always kept,
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
            retain_count=retain_count, monthly=monthly,
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

def _get_real_tables(cursor) -> set:
    """Return the set of base table names in the current public schema."""
    cursor.execute(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
    )
    return {r[0] for r in cursor.fetchall()}


def _get_all_fk_edges(cursor) -> list:
    """Return every (child_table, parent_table) FK relationship in the
    current schema, self-references excluded."""
    cursor.execute(
        "SELECT tc.table_name AS child, ccu.table_name AS parent "
        "FROM information_schema.table_constraints tc "
        "JOIN information_schema.constraint_column_usage ccu "
        "  ON tc.constraint_name = ccu.constraint_name "
        " AND tc.table_schema = ccu.table_schema "
        "WHERE tc.constraint_type = 'FOREIGN KEY'"
    )
    return [(c, p) for c, p in cursor.fetchall() if c != p]


def _parse_csv_backup(content: str, real_tables: set) -> dict:
    """Parse a csv_export backup's decompressed text into
    {table_name: (header, data_rows)}, skipping empty tables.

    Parses the ENTIRE backup with a single csv.reader pass instead of
    regex-splitting the raw text on "-- TABLE:" marker lines. This
    matters because tables with large free-text columns (e.g.
    AI-generated article summaries) can contain a line that looks
    exactly like a marker — a plain text/regex split would cut that
    table's data in half and misattribute the rest, silently discarding
    real rows (this is what emptied the `articles` table in a previous
    run). Feeding the whole file through csv.reader instead means quote
    state is tracked character-by-character across the entire stream: a
    marker-like line that occurs *inside* an open quoted field is
    correctly treated as part of that field's text, never as a
    standalone row, so it can never be mistaken for a real boundary.

    Any marker-shaped row ends the previous table's block, whether or
    not its name is a table we currently recognize — an unrecognized
    name (e.g. one renamed/dropped by a later migration) must NOT fall
    through and have its rows misattributed as extra data for whatever
    table came before it.
    """
    marker_re = re.compile(r"^-- TABLE: (.+)$")
    parsed = {}
    current_table = None
    current_header = None
    current_rows = []

    def _flush_current():
        if current_table and current_header and current_rows:
            parsed[current_table] = (current_header, list(current_rows))

    for row in csv.reader(io.StringIO(content)):
        if len(row) == 1:
            m = marker_re.match(row[0])
            if m:
                _flush_current()
                name = m.group(1)
                if name in real_tables:
                    current_table = name
                else:
                    logger.info(
                        "Table %s from backup no longer exists "
                        "in current schema, skipping", name
                    )
                    current_table = None
                current_header = None
                current_rows = []
                continue
        if current_table is None:
            continue
        if not row or (len(row) == 1 and row[0] == ''):
            continue  # blank separator line between table blocks
        if current_header is None:
            current_header = row
        else:
            current_rows.append(row)
    _flush_current()

    for table_name in real_tables:
        if table_name not in parsed:
            logger.info("Table %s is empty or absent, skipping", table_name)
    return parsed


def _compute_restore_plan(parsed: dict, all_edges: list,
                          acknowledge_data_loss: Optional[set] = None) -> dict:
    """Given the parsed backup tables and the current schema's FK edges,
    compute a safe restore order and detect any CASCADE-closure risk.

    Returns {"order": [...], "blocking": [...], "acknowledged": {...}}.
    `blocking` is non-empty when TRUNCATE ... CASCADE would empty a
    table outside `parsed` with no data queued to reload it (unless the
    caller pre-acknowledged that specific table via
    `acknowledge_data_loss`) — restoring must not proceed in that case.
    """
    backup_edges = [(c, p) for c, p in all_edges if c in parsed and p in parsed]
    order = _topological_table_order(list(parsed.keys()), backup_edges)

    # TRUNCATE ... CASCADE also empties any table that (transitively)
    # references one of the tables about to be truncated — even tables
    # that aren't part of this backup. This is exactly the mechanism
    # that emptied the `articles` table in a previous incident.
    children_of = {}
    for child, parent in all_edges:
        children_of.setdefault(parent, set()).add(child)
    closure = set(order)
    frontier = list(order)
    while frontier:
        t = frontier.pop()
        for c in children_of.get(t, ()):
            if c not in closure:
                closure.add(c)
                frontier.append(c)
    unreloadable = closure - set(parsed.keys())
    acknowledged = unreloadable & (acknowledge_data_loss or set())
    blocking = sorted(unreloadable - acknowledged)
    return {"order": order, "blocking": blocking, "acknowledged": acknowledged}


def _topological_table_order(tables, edges):
    """Order `tables` so a parent (FK target) always precedes any child
    that references it. `edges` is a list of (child, parent) pairs.

    Needed because restoring tables independently in file order can try
    to insert a child row (e.g. article_tag_link) before its parent
    table (article_tag) has been reloaded, violating the FK constraint.

    Falls back to appending any tables stuck in an unresolved dependency
    (e.g. a genuine cycle) in their original order, rather than looping
    forever — a handful of FK errors on a real cycle is preferable to
    hanging the restore.
    """
    depends_on = {t: set() for t in tables}
    for child, parent in edges:
        depends_on.setdefault(child, set()).add(parent)

    remaining = list(tables)
    placed = []
    placed_set = set()
    while remaining:
        progressed = False
        for t in list(remaining):
            if depends_on.get(t, set()) <= placed_set:
                placed.append(t)
                placed_set.add(t)
                remaining.remove(t)
                progressed = True
        if not progressed:
            placed.extend(remaining)
            break
    return placed


def _repair_json_and_array_cells(header, data_rows, json_cols, array_cols):
    """Repair json/jsonb and array cells serialized with Python's str()/
    repr() (single-quoted dict/list syntax, e.g. "[{'a': 1}]") instead of
    valid JSON or Postgres array literals — an artifact of an older,
    buggy CSV export that ran `csv.writer` over raw driver values without
    explicit serialization.

    Returns (fixed_rows, nulled_count). A cell that cannot be repaired is
    set to NULL (empty string) and counted, rather than aborting the
    restore of the entire table over a handful of rows.
    """
    idx_json = [header.index(c) for c in json_cols]
    idx_array = [header.index(c) for c in array_cols]
    nulled = 0
    fixed_rows = []
    for row in data_rows:
        row = list(row)
        for idx in idx_json:
            val = row[idx]
            if not val:
                continue
            try:
                json.loads(val)
                continue  # already valid JSON — leave untouched
            except (ValueError, TypeError):
                pass
            try:
                parsed = ast.literal_eval(val)
                row[idx] = json.dumps(parsed, ensure_ascii=False)
            except (ValueError, SyntaxError):
                row[idx] = ''
                nulled += 1
        for idx in idx_array:
            val = row[idx]
            if not val:
                continue
            if val.startswith('{') and val.endswith('}'):
                continue  # already a Postgres array literal
            try:
                parsed = ast.literal_eval(val)
                row[idx] = _pg_array_literal(parsed)
            except (ValueError, SyntaxError):
                row[idx] = ''
                nulled += 1
        fixed_rows.append(row)
    return fixed_rows, nulled


def _pg_array_literal(items) -> str:
    """Render a Python list as a Postgres array literal, e.g.
    ['a', 'b,c'] -> '{a,"b,c"}'."""
    def fmt(v):
        if v is None:
            return 'NULL'
        s = str(v)
        if s == '' or re.search(r'[{}",\\\s]', s):
            s = s.replace('\\', '\\\\').replace('"', '\\"')
            return f'"{s}"'
        return s
    return '{' + ','.join(fmt(v) for v in items) + '}'


def _parse_backup_ts(name: str) -> Optional[datetime]:
    m = _BACKUP_TS_RE.match(name)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(2) + m.group(3), "%Y%m%d%H%M%S")
    except ValueError:
        return None


def _select_keep(entries: list[tuple[str, datetime]],
                 *, retain_count: int, monthly: int) -> set[str]:
    """Decide which backups to keep.

    Keep:
      • the `retain_count` most recent entries, AND
      • the chronologically-earliest entry of each calendar month
        for the most recent `monthly` distinct months.

    Count-based (rather than day-based) so retention makes sense
    regardless of how often backups actually run (weekly by default,
    but configurable) — "keep the last N backups" means the same thing
    whether that's N days or N weeks of history.

    Returns the set of filenames to keep.
    """
    keep: set[str] = set()

    # 1) `retain_count` most recent entries
    if retain_count > 0:
        for name, _ts in sorted(entries, key=lambda e: e[1], reverse=True)[:retain_count]:
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


# ── Configurable schedule + retention (backup_settings table) ───────────────

_DEFAULT_BACKUP_SETTINGS = {
    "frequency":      "weekly",
    "day_of_week":    "sun",
    "day_of_month":   1,
    "hour_utc":       3,
    "retain_count":   12,
    "retain_monthly": 24,
}


def get_backup_settings() -> dict:
    """Return the current backup schedule/retention settings, creating
    the default row if the database has none yet. Falls back to
    in-memory defaults (never raises) if the DB isn't reachable, so
    scheduling code always has something usable."""
    try:
        from database.config import db
        from sqlalchemy import text as sql_text
        if not db.is_configured():
            return dict(_DEFAULT_BACKUP_SETTINGS)
        s = db.Session()
        try:
            row = s.execute(sql_text(
                "SELECT frequency, day_of_week, day_of_month, hour_utc, "
                "       retain_count, retain_monthly "
                "FROM backup_settings WHERE id = TRUE"
            )).mappings().first()
            if row is None:
                return dict(_DEFAULT_BACKUP_SETTINGS)
            return dict(row)
        finally:
            s.close()
    except Exception as exc:
        logger.warning("get_backup_settings: falling back to defaults: %s", exc)
        return dict(_DEFAULT_BACKUP_SETTINGS)


def set_backup_settings(**fields) -> dict:
    """Update backup schedule/retention settings. Only known columns in
    `fields` are applied; returns the settings row after the update."""
    from database.config import db
    from sqlalchemy import text as sql_text
    allowed = set(_DEFAULT_BACKUP_SETTINGS.keys())
    updates = {k: v for k, v in fields.items() if k in allowed and v is not None}
    if not updates:
        return get_backup_settings()
    cols = ", ".join(f"{k} = :{k}" for k in updates)
    s = db.Session()
    try:
        s.execute(sql_text(
            f"UPDATE backup_settings SET {cols}, updated_at = NOW() WHERE id = TRUE"
        ), updates)
        s.commit()
    finally:
        s.close()
    return get_backup_settings()
