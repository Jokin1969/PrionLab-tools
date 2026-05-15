import logging
from datetime import date, datetime

import bcrypt
from flask import (Blueprint, flash, make_response, redirect,
                   render_template, request, session, url_for)
from flask_babel import gettext as _

from config import ADMIN_PASSWORD, CONTACT_EMAIL
from core.decorators import login_required

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


def _lookup_db_user_id(username: str) -> str | None:
    """Return the UUID of the `users` row whose username matches.

    Three layered behaviours:
      1. Row exists in DB → return its id.
      2. Row missing but the user is in the CSV (the legacy user
         store) → insert a minimal row into `users` and return its id.
         This unblocks every tool that keys off users.id (PrionVault,
         PrionPacks, ratings, favourites, …) without forcing the user
         to re-register.
      3. Otherwise → None.

    Result is a str (not a UUID) so it serialises into the Flask
    session cookie without extra plumbing.
    """
    if not username:
        return None
    try:
        from database.config import db
        from sqlalchemy import text as _text
        if not db.is_configured():
            return None
        with db.engine.connect() as conn:
            row = conn.execute(
                _text("SELECT id FROM users WHERE lower(username) = lower(:u) LIMIT 1"),
                {"u": username},
            ).first()
            if row and row[0]:
                return str(row[0])
    except Exception as exc:
        logger.warning("auth: could not resolve user_id for %s: %s",
                       username, exc)
        return None

    # ── Auto-provision from the CSV ─────────────────────────────────
    try:
        from core.users import load_users
        csv_row = next(
            (u for u in load_users()
             if u.get("username", "").lower() == username.lower()),
            None,
        )
        if not csv_row:
            return None

        full_name = (csv_row.get("full_name") or username).strip()
        parts     = full_name.split(None, 1)
        first     = parts[0] if parts else username
        last      = parts[1] if len(parts) > 1 else ""
        email     = (csv_row.get("email") or
                     f"{username.lower()}@local.invalid").strip()
        role      = (csv_row.get("role") or "reader").strip()
        language  = (csv_row.get("language") or "es").strip()
        pw_hash   = (csv_row.get("password_hash")
                     or "!auto-provisioned!").strip()

        import uuid as _uuid
        from database.config import db
        from sqlalchemy import text as _text
        new_id = str(_uuid.uuid4())
        with db.engine.begin() as conn:
            conn.execute(_text(
                """INSERT INTO users
                   (id, username, email, password_hash,
                    first_name, last_name, role, language,
                    is_active, email_verified, created_at, updated_at)
                   VALUES (:id, :u, :e, :p, :fn, :ln, :r, :lng,
                           TRUE, FALSE, NOW(), NOW())
                   ON CONFLICT (username) DO NOTHING"""
            ), {"id": new_id, "u": username, "e": email, "p": pw_hash,
                "fn": first, "ln": last, "r": role, "lng": language})
            # Re-read to cope with the ON CONFLICT path (another
            # request might have inserted the same username in
            # parallel and our INSERT became a no-op).
            row = conn.execute(_text(
                "SELECT id FROM users WHERE lower(username) = lower(:u) LIMIT 1"
            ), {"u": username}).first()
            if row and row[0]:
                logger.info("auth: auto-provisioned DB user for %s "
                            "(id=%s)", username, row[0])
                return str(row[0])
    except Exception as exc:
        logger.warning("auth: auto-provision failed for %s: %s",
                       username, exc)
    return None


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
            # Resolve the DB-side UUID so tools that key off users.id
            # (PrionVault, PrionPacks, …) can authenticate the viewer.
            uid = _lookup_db_user_id(session["username"])
            if uid:
                session["user_id"] = uid
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


@auth_bp.route("/register", methods=["GET", "POST"])
def register():
    if session.get("logged_in"):
        return redirect(url_for("home"))
    error = None
    if request.method == "POST":
        from core.users import create_user, email_exists, user_exists
        username = request.form.get("username", "").strip().lower()
        password = request.form.get("password", "")
        full_name = request.form.get("full_name", "").strip()
        email = request.form.get("email", "").strip()
        affiliation = request.form.get("affiliation", "").strip()
        position = request.form.get("position", "").strip()
        research_areas = request.form.get("research_areas", "").strip()
        orcid = request.form.get("orcid", "").strip()
        bio = request.form.get("bio", "").strip()
        if not username or not password or not full_name:
            error = _("Username, full name and password are required.")
        elif len(username) < 3:
            error = _("Username must be at least 3 characters.")
        elif len(password) < 6:
            error = _("Password must be at least 6 characters.")
        elif user_exists(username):
            error = _("Username already taken.")
        elif email and email_exists(email):
            error = _("Email already registered.")
        else:
            create_user({
                "username": username,
                "password_hash": hash_password(password),
                "full_name": full_name,
                "email": email,
                "role": "reader",
                "language": "es",
                "active": "true",
                "created_at": date.today().isoformat(),
                "last_login": "",
                "affiliation": affiliation,
                "position": position,
                "research_areas": research_areas,
                "orcid": orcid,
                "bio": bio,
                "lab_id": "",
            }, sync=False)
            flash(_("Account created. You can now log in."), "success")
            return redirect(url_for("auth.login"))
    return render_template("auth/register.html", error=error)


@auth_bp.route("/profile", methods=["GET", "POST"])
@login_required
def profile():
    from core.users import get_user, update_user
    username = session.get("username", "")
    user = get_user(username) or {}
    error = None
    if request.method == "POST":
        updates = {
            "full_name": request.form.get("full_name", "").strip(),
            "email": request.form.get("email", "").strip(),
            "affiliation": request.form.get("affiliation", "").strip(),
            "position": request.form.get("position", "").strip(),
            "research_areas": request.form.get("research_areas", "").strip(),
            "orcid": request.form.get("orcid", "").strip(),
            "bio": request.form.get("bio", "").strip(),
        }
        new_password = request.form.get("new_password", "")
        if new_password:
            if len(new_password) < 6:
                error = _("New password must be at least 6 characters.")
            else:
                current_pwd = request.form.get("current_password", "")
                if not verify_password(current_pwd, user.get("password_hash", "")):
                    error = _("Current password is incorrect.")
                else:
                    updates["password_hash"] = hash_password(new_password)
        if not error:
            update_user(username, updates, sync=False)
            session["full_name"] = updates["full_name"]
            flash(_("Profile updated successfully."), "success")
            return redirect(url_for("auth.profile"))
    return render_template("auth/profile.html", user=user, error=error)
