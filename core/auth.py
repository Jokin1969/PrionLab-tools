import logging
from datetime import date, datetime

import bcrypt
from flask import (Blueprint, make_response, redirect, render_template,
                   request, session, url_for)
from flask_babel import gettext as _

from config import ADMIN_PASSWORD, CONTACT_EMAIL

logger = logging.getLogger(__name__)
auth_bp = Blueprint("auth", __name__)


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def bootstrap_admin_user() -> None:
    """Creates the initial admin user locally (and pushes to Dropbox) if no users exist."""
    from core.users import load_users, save_users

    if load_users():
        return

    logger.info("Bootstrap: no users found, creating initial admin")
    pwd = ADMIN_PASSWORD if ADMIN_PASSWORD else "changeme"
    admin = {
        "username": "admin",
        "password_hash": hash_password(pwd),
        "full_name": "Administrator",
        "email": CONTACT_EMAIL,
        "role": "admin",
        "language": "es",
        "active": "true",
        "created_at": date.today().isoformat(),
        "last_login": "",
    }
    try:
        save_users([admin], sync=True)
        logger.info("Bootstrap: admin user created")
    except Exception as e:
        logger.error("Bootstrap: failed to save users: %s", e)


def _authenticate(username: str, password: str) -> dict | None:
    from core.users import load_users

    users = load_users()
    matched = next(
        (u for u in users if u.get("username", "").lower() == username.lower()), None
    )

    # Regular CSV auth
    if matched and matched.get("active", "true").lower() == "true":
        if verify_password(password, matched.get("password_hash", "")):
            return matched

    # Emergency fallback: username=admin + raw ADMIN_PASSWORD always works
    if username.lower() == "admin" and ADMIN_PASSWORD and password == ADMIN_PASSWORD:
        base = dict(matched) if matched else {
            "username": "admin",
            "role": "admin",
            "full_name": "Administrator",
            "email": CONTACT_EMAIL,
            "language": "es",
        }
        base["_emergency"] = True
        return base

    return None


@auth_bp.route("/login", methods=["GET", "POST"])
def login():
    if session.get("logged_in"):
        return redirect(url_for("home"))

    error = None
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")

        user = _authenticate(username, password)
        if user:
            session["logged_in"] = True
            session["username"] = user.get("username", username)
            session["role"] = user.get("role", "reader")
            session["full_name"] = user.get("full_name", username)
            session["language"] = user.get("language", "es")
            session.permanent = True

            # Update last_login (skip for emergency login to avoid writing corrupted CSV)
            if not user.get("_emergency"):
                try:
                    from core.users import update_user
                    update_user(
                        user["username"],
                        {"last_login": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")},
                        sync=False,
                    )
                except Exception as e:
                    logger.warning("Failed to update last_login: %s", e)

            lang = user.get("language", "es")
            next_url = request.args.get("next") or url_for("home")
            resp = make_response(redirect(next_url))
            resp.set_cookie("prionlab_lang", lang, max_age=365 * 24 * 3600, samesite="Lax")
            return resp
        else:
            error = _("Incorrect username or password.")

    return render_template("login.html", error=error)


@auth_bp.route("/logout")
def logout():
    session.clear()
    resp = make_response(redirect(url_for("auth.login")))
    resp.delete_cookie("prionlab_lang")
    return resp
