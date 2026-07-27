import logging
import os
import secrets
import string

from flask import Blueprint, flash, redirect, render_template, request, session, url_for
from flask_babel import gettext as _

import config
from core.auth import hash_password, verify_password
from core.decorators import admin_required
from core.users import (create_user, delete_user, get_user, load_users,
                        update_user, user_exists)

logger = logging.getLogger(__name__)
admin_bp = Blueprint("admin", __name__, url_prefix="/admin")


# ── Helpers ─────────────────────────────────────────────────────────────────

def _data_dir_mb() -> float:
    total = 0
    for dirpath, _, filenames in os.walk(config.DATA_DIR):
        for fname in filenames:
            try:
                total += os.path.getsize(os.path.join(dirpath, fname))
            except OSError:
                pass
    return round(total / (1024 * 1024), 2)


def _last_sync() -> str | None:
    try:
        from core.db import get_connection
        with get_connection() as conn:
            row = conn.execute(
                "SELECT value FROM app_meta WHERE key='last_dropbox_sync'"
            ).fetchone()
            return row["value"] if row else None
    except Exception:
        return None


def _recent_logs(n: int = 50) -> str:
    log_file = os.path.join(config.LOGS_DIR, "prionlab.log")
    if not os.path.exists(log_file):
        return "(No logs yet)"
    try:
        with open(log_file, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        return "".join(lines[-n:]) or "(Log is empty)"
    except Exception as e:
        return f"(Error reading logs: {e})"


def _gen_password(length: int = 12) -> str:
    alphabet = string.ascii_letters + string.digits + "!@#$%"
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _can_delete(username: str) -> bool:
    return username.lower() != "admin" and username.lower() != session.get("username", "").lower()


# ── Main panel ───────────────────────────────────────────────────────────────

@admin_bp.route("/")
@admin_required
def index():
    return render_template(
        "admin/index.html",
        users=load_users(),
        dropbox_ok=config.dropbox_configured(),
        smtp_ok=config.smtp_configured(),
        last_sync=_last_sync(),
        disk_mb=_data_dir_mb(),
        log_lines=_recent_logs(),
    )


# ── User management ──────────────────────────────────────────────────────────

@admin_bp.route("/users/add", methods=["GET", "POST"])
@admin_required
def add_user():
    if request.method == "POST":
        username = request.form.get("username", "").strip().lower()
        password = request.form.get("password", "")
        confirm = request.form.get("confirm_password", "")
        full_name = request.form.get("full_name", "").strip()
        email = request.form.get("email", "").strip()
        role = request.form.get("role", "reader")
        language = request.form.get("language", "es")
        active = "true" if request.form.get("active") else "false"

        if not password:
            flash(_("Password is required for new users."), "error")
            return render_template("admin/user_form.html", mode="add", form=request.form)
        if password != confirm:
            flash(_("Passwords do not match."), "error")
            return render_template("admin/user_form.html", mode="add", form=request.form)
        if user_exists(username):
            flash(_("Username already exists."), "error")
            return render_template("admin/user_form.html", mode="add", form=request.form)

        from datetime import date
        create_user({
            "username": username,
            "password_hash": hash_password(password),
            "full_name": full_name,
            "email": email,
            "role": role,
            "language": language,
            "active": active,
            "created_at": date.today().isoformat(),
            "last_login": "",
        })
        flash(_("User created successfully."), "success")
        return redirect(url_for("admin.index"))

    return render_template("admin/user_form.html", mode="add", form={})


@admin_bp.route("/users/<username>/edit", methods=["GET", "POST"])
@admin_required
def edit_user(username):
    user = get_user(username)
    if not user:
        flash(_("User not found."), "error")
        return redirect(url_for("admin.index"))

    if request.method == "POST":
        password = request.form.get("password", "")
        confirm = request.form.get("confirm_password", "")
        full_name = request.form.get("full_name", "").strip()
        email = request.form.get("email", "").strip()
        role = request.form.get("role", user["role"])
        language = request.form.get("language", user["language"])
        active = "true" if request.form.get("active") else "false"

        updates = {
            "full_name": full_name,
            "email": email,
            "role": role,
            "language": language,
            "active": active,
        }

        if password:
            if password != confirm:
                flash(_("Passwords do not match."), "error")
                return render_template("admin/user_form.html", mode="edit", user=user, form=request.form)
            updates["password_hash"] = hash_password(password)

        update_user(username, updates)
        flash(_("User updated successfully."), "success")
        return redirect(url_for("admin.index"))

    return render_template("admin/user_form.html", mode="edit", user=user, form=user)


@admin_bp.route("/users/<username>/delete", methods=["POST"])
@admin_required
def delete_user_route(username):
    if not _can_delete(username):
        flash(_("Cannot delete this user."), "error")
        return redirect(url_for("admin.index"))
    if delete_user(username):
        flash(_("User deleted successfully."), "success")
    else:
        flash(_("User not found."), "error")
    return redirect(url_for("admin.index"))


@admin_bp.route("/users/<username>/toggle", methods=["POST"])
@admin_required
def toggle_user(username):
    user = get_user(username)
    if not user:
        flash(_("User not found."), "error")
        return redirect(url_for("admin.index"))
    new_state = "false" if user.get("active", "true") == "true" else "true"
    update_user(username, {"active": new_state})
    if new_state == "true":
        flash(_("User activated."), "success")
    else:
        flash(_("User deactivated."), "success")
    return redirect(url_for("admin.index"))


@admin_bp.route("/users/<username>/reset-password", methods=["POST"])
@admin_required
def reset_password(username):
    user = get_user(username)
    if not user:
        flash(_("User not found."), "error")
        return redirect(url_for("admin.index"))
    new_pwd = _gen_password()
    update_user(username, {"password_hash": hash_password(new_pwd)})
    # Flash the plaintext password with a special category — shown once, prominently
    flash(new_pwd, "password_reset")
    flash(_("Password reset. Copy the password shown above — it will not be displayed again."), "warning")
    return redirect(url_for("admin.index"))


# ── System actions ───────────────────────────────────────────────────────────

@admin_bp.route("/sync", methods=["POST"])
@admin_required
def force_sync():
    from core.sync import pull_from_dropbox
    try:
        updated = pull_from_dropbox()
        n = len(updated)
        if n:
            flash(_("Sync completed: %(n)d file(s) updated.", n=n), "success")
        else:
            flash(_("Sync completed. All files are up to date."), "success")
    except Exception as e:
        flash(f"Sync error: {e}", "error")
    return redirect(url_for("admin.index"))


@admin_bp.route("/test-email", methods=["POST"])
@admin_required
def test_email():
    from core.smtp_client import send_email
    ok = send_email(
        to=config.CONTACT_EMAIL,
        subject="PrionLab-tools test",
        body="If you receive this, SMTP is working correctly.",
    )
    if ok:
        flash(_("Test email sent successfully."), "success")
    else:
        flash(_("Failed to send test email."), "error")
    return redirect(url_for("admin.index"))


# ── Database admin ───────────────────────────────────────────────────────────

@admin_bp.route("/database")
@admin_required
def database_dashboard():
    from database.services import DatabaseHealthService
    health = DatabaseHealthService.get_metrics()
    table_stats = DatabaseHealthService.get_table_stats() if health.get("connected") else []
    from database.backup import BackupManager
    bm = BackupManager()
    backups = bm.list_backups()
    dropbox_backups = bm.list_dropbox_backups()
    dropbox_base_dir = bm._dropbox_base_dir() if bm._dropbox_configured() else None
    return render_template("admin/database.html",
                           health=health, table_stats=table_stats,
                           backups=backups,
                           dropbox_backups=dropbox_backups,
                           dropbox_base_dir=dropbox_base_dir)


@admin_bp.route("/database/backup", methods=["POST"])
@admin_required
def trigger_backup():
    import threading
    from database.backup import BackupManager

    def _run():
        import logging
        _log = logging.getLogger(__name__)
        try:
            result = BackupManager().create_backup()
            if result.get("success"):
                _log.info("Background backup completed: %s (%.1f MB)",
                          result.get("filename"), result.get("size_mb"))
            else:
                _log.error("Background backup failed: %s", result.get("error"))
        except Exception as exc:
            _log.exception("Background backup crashed: %s", exc)

    t = threading.Thread(target=_run, daemon=True, name="db-backup")
    t.start()
    flash(_("Backup iniciado en segundo plano."), "success")
    return redirect(url_for("admin.database_dashboard"))


@admin_bp.route("/database/vacuum", methods=["POST"])
@admin_required
def trigger_vacuum():
    from database.services import DatabaseHealthService
    ok = DatabaseHealthService.vacuum_analyze()
    if ok:
        flash(_("VACUUM ANALYZE completed."), "success")
    else:
        flash(_("VACUUM ANALYZE failed or DB not configured."), "warning")
    return redirect(url_for("admin.database_dashboard"))


@admin_bp.route("/database/backups/<filename>/delete", methods=["POST"])
@admin_required
def delete_backup(filename):
    import re
    from database.backup import BACKUP_DIR
    if not re.match(r"^[\w\-\.]+$", filename):
        flash(_("Invalid backup filename."), "danger")
        return redirect(url_for("admin.database_dashboard"))
    path = BACKUP_DIR / filename
    if path.exists() and path.parent == BACKUP_DIR:
        path.unlink()
        flash(_("Backup deleted."), "success")
    else:
        flash(_("Backup not found."), "warning")
    return redirect(url_for("admin.database_dashboard"))


@admin_bp.route("/database/backups/restore", methods=["POST"])
@admin_required
def restore_backup_from_dropbox():
    """Restore database from a Dropbox backup (pg_dump or CSV export).

    Requires POST with JSON: {"filename": "pgdump_YYYYMMDD_HHMMSS.sql.gz" or "csv_export_YYYYMMDD_HHMMSS.gz"}
    """
    import re
    import logging
    from pathlib import Path
    from database.backup import BackupManager, BACKUP_DIR

    logger = logging.getLogger(__name__)

    filename = request.get_json(silent=True, force=True).get('filename', '').strip()

    # Validate filename format (pgdump or csv_export)
    is_pgdump = re.match(r"^pgdump_\d{8}_\d{6}\.sql\.gz$", filename)
    is_csv = re.match(r"^csv_export_\d{8}_\d{6}\.gz$", filename)

    if not filename or not (is_pgdump or is_csv):
        flash(_("Invalid backup filename."), "danger")
        return redirect(url_for("admin.database_dashboard"))

    bm = BackupManager()
    try:
        # Get Dropbox backups
        dropbox_backups = bm.list_dropbox_backups()
        backup_in_dropbox = any(b['filename'] == filename for b in dropbox_backups)

        if not backup_in_dropbox:
            flash(_("Backup not found in Dropbox."), "warning")
            return redirect(url_for("admin.database_dashboard"))

        # Download from Dropbox
        from core.dropbox_client import get_client
        client = get_client()
        if not client:
            flash(_("Dropbox not configured."), "danger")
            return redirect(url_for("admin.database_dashboard"))

        backup_path = BACKUP_DIR / filename
        try:
            backup_dropbox = next(
                b for b in dropbox_backups if b['filename'] == filename
            )
            logger.info("Downloading backup from Dropbox: %s", filename)
            metadata, response = client.files_download(backup_dropbox['path'])
            backup_path.write_bytes(response.content)
            logger.info("Downloaded %s (%.1f MB)", filename, backup_path.stat().st_size / (1024*1024))
        except Exception as e:
            logger.error("Failed to download backup from Dropbox: %s", e)
            flash(_("Failed to download backup from Dropbox: %(error)s", error=str(e)[:100]), "danger")
            return redirect(url_for("admin.database_dashboard"))

        # Restore database (choose method based on backup type)
        logger.warning("Restoring database from backup: %s (type: %s)",
                      filename, "pg_dump" if is_pgdump else "CSV export")

        if is_pgdump:
            result = bm.restore_from_backup(str(backup_path))
        else:  # is_csv
            result = bm.restore_from_csv_export(str(backup_path))

        if result.get('success'):
            detail = ""
            if is_csv and result.get('tables_restored'):
                detail = f" ({result['tables_restored']} tables, {result['rows_restored']} rows)"
            logger.info("Database restored successfully from %s", filename)
            flash(_("✅ Database restored from %(backup)s%(detail)s. Data before this backup is lost.",
                    backup=filename, detail=detail), "success")
        else:
            logger.error("Database restore failed: %s", result.get('error'))
            flash(_("Restore failed: %(error)s",
                    error=result.get('error', 'Unknown error')[:200]), "danger")

        return redirect(url_for("admin.database_dashboard"))
    except Exception as exc:
        logger.exception("Restore endpoint error")
        flash(_("Unexpected error: %(error)s", error=str(exc)[:100]), "danger")
        return redirect(url_for("admin.database_dashboard"))


@admin_bp.route("/database/emergency-restore", methods=["POST"])
@admin_required
def emergency_restore():
    """Emergency restore from most recent CSV backup in Dropbox.

    No parameters needed - restores from the latest CSV export automatically.
    Use this when data loss occurs and you need to recover ASAP.
    """
    import logging
    from pathlib import Path
    from database.backup import BackupManager, BACKUP_DIR

    logger = logging.getLogger(__name__)

    try:
        bm = BackupManager()
        dropbox_backups = bm.list_dropbox_backups()

        # Find most recent CSV export
        csv_backups = [b for b in dropbox_backups if b['filename'].startswith('csv_export_')]
        if not csv_backups:
            flash(_("No CSV backups found in Dropbox."), "danger")
            return redirect(url_for("admin.database_dashboard"))

        latest_csv = csv_backups[0]  # Already sorted by date, newest first
        filename = latest_csv['filename']

        logger.warning("Emergency restore triggered: downloading %s", filename)
        flash(_("⏳ Restoring from %(backup)s... This may take a few minutes.",
                backup=filename), "info")

        # Download from Dropbox
        from core.dropbox_client import get_client
        client = get_client()
        if not client:
            flash(_("Dropbox not configured."), "danger")
            return redirect(url_for("admin.database_dashboard"))

        backup_path = BACKUP_DIR / filename
        try:
            logger.info("Downloading from Dropbox: %s", filename)
            metadata, response = client.files_download(latest_csv['path'])
            backup_path.write_bytes(response.content)
            logger.info("Downloaded %s (%.1f MB)", filename, backup_path.stat().st_size / (1024*1024))
        except Exception as e:
            logger.error("Download failed: %s", e)
            flash(_("Failed to download from Dropbox: %(error)s", error=str(e)[:100]), "danger")
            return redirect(url_for("admin.database_dashboard"))

        # Restore CSV
        logger.warning("Starting emergency restore from CSV: %s", filename)
        result = bm.restore_from_csv_export(str(backup_path))

        if result.get('success'):
            logger.info(
                "Emergency restore COMPLETE: %d tables, %d rows from %s",
                result.get('tables_restored'), result.get('rows_restored'), filename
            )
            flash(
                _("✅ <b>RESTORE SUCCESS!</b><br>"
                  "Restored from %(backup)s<br>"
                  "%(tables)d tables, %(rows)d rows<br>"
                  "Refresh the page to see the recovered data.",
                  backup=filename,
                  tables=result.get('tables_restored', '?'),
                  rows=result.get('rows_restored', '?')),
                "success"
            )
        else:
            logger.error("Restore FAILED: %s", result.get('error'))
            flash(
                _("❌ Restore failed: %(error)s",
                  error=result.get('error', 'Unknown error')[:200]),
                "danger"
            )

        return redirect(url_for("admin.database_dashboard"))
    except Exception as exc:
        logger.exception("Emergency restore error")
        flash(_("Unexpected error: %(error)s", error=str(exc)[:100]), "danger")
        return redirect(url_for("admin.database_dashboard"))


@admin_bp.route("/apis")
@admin_required
def api_dashboard():
    """External API Integration dashboard."""
    return render_template("admin/api_dashboard.html")


# ── Database JSON APIs ────────────────────────────────────────────────────────

@admin_bp.route("/api/db/health")
@admin_required
def api_db_health():
    from flask import jsonify
    from database.services import DatabaseHealthService
    try:
        return jsonify({"success": True, "health": DatabaseHealthService.get_metrics()})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@admin_bp.route("/api/db/tables")
@admin_required
def api_db_tables():
    from flask import jsonify
    from database.services import DatabaseHealthService
    from database.config import db
    try:
        tables = DatabaseHealthService.get_table_stats()
        index_stats = []
        if db.is_configured():
            try:
                from sqlalchemy import text
                with db.engine.connect() as conn:
                    rows = conn.execute(text("""
                        SELECT
                            schemaname, tablename, indexname,
                            idx_scan, idx_tup_read, idx_tup_fetch,
                            pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
                        FROM pg_stat_user_indexes
                        ORDER BY idx_scan DESC
                        LIMIT 20
                    """)).fetchall()
                    index_stats = [
                        {
                            "table": r[1], "index": r[2],
                            "scans": r[3], "tuples_read": r[4],
                            "tuples_fetched": r[5], "size": r[6],
                        }
                        for r in rows
                    ]
            except Exception:
                pass
        return jsonify({"success": True, "tables": tables, "indexes": index_stats})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
