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
