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
    """Return the UUID of the row in `users` that matches `username`.

    Works against two distinct historical schemas of the same table:
      a) The Python ORM in database/models.py — columns username,
         password_hash, first_name, last_name, …
      b) The PrionRead / Sequelize legacy schema actually in
         production on this deployment — columns name, password,
         email, role (enum), …

    We introspect information_schema.columns once, then:
      1. Search by every identifier-style column that exists
         (`username`, `name`, `email`) — case-insensitive — and return
         the first hit.
      2. If still nothing, auto-provision a row using only the columns
         the live table actually has, mapping the CSV's full_name to
         `name`, password_hash to `password`, etc.
    """
    if not username:
        return None
    try:
        from database.config import db
        from sqlalchemy import text as _text
        if not db.is_configured():
            return None
        with db.engine.connect() as conn:
            cols = _users_columns(conn)
            for cand in ("username", "name", "email"):
                if cand not in cols:
                    continue
                try:
                    row = conn.execute(_text(
                        f"SELECT id FROM users "
                        f"WHERE lower({cand}) = lower(:u) LIMIT 1"
                    ), {"u": username}).first()
                except Exception as exc:
                    logger.debug("auth: probe by %s failed: %s", cand, exc)
                    continue
                if row and row[0]:
                    return str(row[0])
    except Exception as exc:
        logger.warning("auth: could not resolve user_id for %s: %s",
                       username, exc)
        return None

    # ── Not found → auto-provision against the live schema ─────────
    return _auto_provision_user(username)


def _users_columns(conn) -> set[str]:
    """Return the set of column names actually present in public.users
    on this deployment. Cached per-connection."""
    from sqlalchemy import text as _text
    rows = conn.execute(_text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = 'users'"
    )).all()
    return {r[0] for r in rows}


def _auto_provision_user(username: str) -> str | None:
    """Create a `users` row for `username` using whatever columns the
    live table actually has. Best-effort: returns the new id on
    success, None if the INSERT failed for any reason. The CSV is the
    source of truth for full name, email, role and password hash —
    we just translate it into the live column names."""
    try:
        from core.users import load_users
        csv_row = next(
            (u for u in load_users()
             if u.get("username", "").lower() == username.lower()),
            None,
        )

        full_name = ((csv_row.get("full_name") if csv_row else None)
                     or username).strip() or username
        email     = ((csv_row.get("email") if csv_row else None)
                     or f"{username.lower()}@local.invalid").strip()
        role      = ((csv_row.get("role") if csv_row else None)
                     or "reader").strip().lower()
        # Some PrionRead deploys use an ENUM with capitalised values.
        # We accept either; the INSERT below tries lower-case first
        # and falls back to capitalised on CheckConstraint errors.
        pw_hash   = ((csv_row.get("password_hash") if csv_row else None)
                     or "!auto-provisioned!").strip()

        import uuid as _uuid
        from database.config import db
        from sqlalchemy import text as _text
        new_id = str(_uuid.uuid4())
        with db.engine.begin() as conn:
            cols = _users_columns(conn)
            row = _try_insert_user(conn, cols, new_id,
                                   username=username,
                                   full_name=full_name,
                                   email=email,
                                   role=role,
                                   pw_hash=pw_hash)
            if row:
                logger.info("auth: auto-provisioned DB user for %s "
                            "(id=%s)", username, row)
                return row
    except Exception as exc:
        logger.warning("auth: auto-provision failed for %s: %s",
                       username, exc)
    return None


def _try_insert_user(conn, cols: set[str], new_id: str, *,
                     username: str, full_name: str, email: str,
                     role: str, pw_hash: str) -> str | None:
    """Build an INSERT keyed only off columns that actually exist on
    public.users. Tries again with capitalised role if the role enum
    rejects lower-case. Returns the resulting id (existing or new)."""
    from sqlalchemy import text as _text
    # column → value, but only include keys whose column exists.
    candidate = {
        "id":            new_id,
        "username":      username,        # ORM schema
        "name":          full_name,       # PrionRead schema
        "first_name":    full_name.split(None, 1)[0] if full_name else username,
        "last_name":     (full_name.split(None, 1)[1]
                          if full_name and " " in full_name else ""),
        "email":         email,
        "password":      pw_hash,         # PrionRead schema
        "password_hash": pw_hash,         # ORM schema
        "role":          role,
        "language":      "es",
        "is_active":     True,
        "email_verified": False,
    }
    data_cols = [c for c in candidate if c in cols]
    if "id" not in data_cols or "email" not in data_cols:
        logger.warning("auth: users table is missing id or email — cannot provision")
        return None

    # The Sequelize-managed users table on this deployment has
    # created_at / updated_at as NOT NULL with no DB-level default
    # (Sequelize adds the value at the ORM layer). We can't bind a
    # SQL function via parameters, so when those columns exist we
    # inline NOW() in the VALUES clause for them.
    ts_cols = [c for c in ("created_at", "updated_at") if c in cols]

    all_cols   = data_cols + ts_cols
    placeholders = ", ".join([f":{c}" for c in data_cols] +
                             ["NOW()"] * len(ts_cols))
    cols_sql   = ", ".join(all_cols)
    params     = {c: candidate[c] for c in data_cols}

    def _do_insert():
        return conn.execute(_text(
            f"INSERT INTO users ({cols_sql}) VALUES ({placeholders}) "
            f"ON CONFLICT (email) DO NOTHING"
        ), params)

    try:
        _do_insert()
    except Exception as exc:
        msg = str(exc).lower()
        # If role is an ENUM and we sent the wrong case, retry with
        # alternative capitalisations, and finally without role at
        # all (the column allows NULL on this deployment).
        if "role" in msg and ("invalid input value for enum" in msg
                              or "invalid input syntax" in msg):
            inserted = False
            for variant in (role.capitalize(), role.upper()):
                params["role"] = variant
                try:
                    _do_insert()
                    inserted = True
                    break
                except Exception as exc2:
                    logger.debug("auth: role retry %s: %s", variant, exc2)
            if not inserted:
                # Last resort: drop the role column from the INSERT
                # (keeps the NOW() timestamp inlining).
                drop_data = [c for c in data_cols if c != "role"]
                drop_all  = drop_data + ts_cols
                drop_ph   = ", ".join([f":{c}" for c in drop_data] +
                                      ["NOW()"] * len(ts_cols))
                drop_sql  = ", ".join(drop_all)
                drop_params = {c: candidate[c] for c in drop_data}
                try:
                    conn.execute(_text(
                        f"INSERT INTO users ({drop_sql}) VALUES ({drop_ph}) "
                        f"ON CONFLICT (email) DO NOTHING"
                    ), drop_params)
                except Exception as exc3:
                    logger.warning("auth: INSERT-without-role failed: %s", exc3)
                    return None
        else:
            logger.warning("auth: INSERT failed: %s", exc)
            return None

    # Re-read by email (the unique key) to handle ON CONFLICT and to
    # catch the case where another request inserted the same row in
    # parallel.
    row = conn.execute(_text(
        "SELECT id FROM users WHERE lower(email) = lower(:e) LIMIT 1"
    ), {"e": email}).first()
    return str(row[0]) if row and row[0] else None


def _authenticate(username: str, password: str) -> dict | None:
    from core.users import get_user_by_username_or_email

    # Lookup by username OR email — operators trained on email addresses
    # don't expect to also memorise a username, and conversely the
    # admin's "admin" alias keeps working unchanged.
    matched = get_user_by_username_or_email(username)

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
            # Force password change on first login: when the seeded
            # account still has the starter password, every page
            # should redirect to /change-password until they pick a
            # new one. The session flag lets the before_request
            # middleware enforce this even on background API calls.
            if (user.get("must_change_pw") or "").lower() == "true":
                session["must_change_pw"] = True
                resp = make_response(redirect(url_for("auth.change_password")))
            else:
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


# ── Force-change-password (first login) ──────────────────────────────────────

# Minimum length for any operator-chosen password. We refuse the
# starter "12345678" specifically so a user who hits this screen
# can't just re-confirm the seeded credential.
_MIN_PW_LEN     = 8
_FORBIDDEN_PWS  = {"12345678", "00000000", "password", "qwertyui"}


def _password_quality_error(new_password: str) -> str | None:
    if len(new_password) < _MIN_PW_LEN:
        return _("Password must be at least %(n)d characters.",
                 n=_MIN_PW_LEN)
    if new_password in _FORBIDDEN_PWS:
        return _("This password is too common. Pick something else.")
    return None


@auth_bp.route("/change-password", methods=["GET", "POST"])
@login_required
def change_password():
    """Page the user lands on after first login (must_change_pw=true).
    Also reachable voluntarily from the navbar."""
    from core.users import get_user, update_user
    username = session.get("username", "")
    user = get_user(username) or {}
    error = None
    if request.method == "POST":
        current = request.form.get("current_password", "")
        new_pw  = request.form.get("new_password", "")
        confirm = request.form.get("confirm_password", "")
        # When forced (first login) the user does NOT need to type the
        # starter password again — the session flag means we already
        # know it's the starter. Voluntary changes (navbar entry) DO
        # require it as a defence against session hijack.
        forced = bool(session.get("must_change_pw"))
        if not forced:
            if not verify_password(current, user.get("password_hash", "")):
                error = _("Current password is incorrect.")
        if not error:
            if new_pw != confirm:
                error = _("The new password and its confirmation don't match.")
            else:
                error = _password_quality_error(new_pw)
        if not error:
            update_user(username, {
                "password_hash":  hash_password(new_pw),
                "must_change_pw": "false",
            }, sync=False)
            session.pop("must_change_pw", None)
            flash(_("Password updated. Welcome aboard."), "success")
            return redirect(url_for("home"))
    return render_template("auth/change_password.html",
                           forced=bool(session.get("must_change_pw")),
                           error=error)


# ── Password recovery via email link ─────────────────────────────────────────

# Reset tokens are short-lived and single-use. 1 h is the standard
# trade-off between "user has time to act on the email" and "stolen
# token doesn't grant indefinite access".
_RESET_TOKEN_TTL_HOURS = 1


@auth_bp.route("/forgot-password", methods=["GET", "POST"])
def forgot_password():
    """Email the operator a reset link. To avoid leaking which emails
    are registered, we ALWAYS return a generic "If that address
    exists, we've sent a link" success message — even when the
    address isn't on file or SMTP fails."""
    from datetime import timedelta
    import secrets
    from core.users import get_user_by_email, update_user

    if request.method == "POST":
        email = (request.form.get("email") or "").strip().lower()
        if email:
            user = get_user_by_email(email)
            if user and user.get("active", "true").lower() == "true":
                token = secrets.token_urlsafe(32)
                expires = (datetime.utcnow()
                           + timedelta(hours=_RESET_TOKEN_TTL_HOURS))
                try:
                    update_user(user["username"], {
                        "reset_token":         token,
                        "reset_token_expires": expires.isoformat(),
                    }, sync=False)
                    _send_reset_email(user, token)
                except Exception as exc:
                    logger.warning("forgot_password write/send failed for "
                                   "%s: %s", email, exc)
        # Always show the same flash so an attacker can't enumerate
        # registered emails by watching the response.
        flash(_("If that address is registered, a reset link is on "
                "its way. Check your inbox in a couple of minutes."),
              "info")
        return redirect(url_for("auth.login"))
    return render_template("auth/forgot_password.html")


def _send_reset_email(user: dict, token: str) -> None:
    """Best-effort: log+swallow on failure. Caller already wraps in
    try/except for the user-facing flow."""
    from core.smtp_client import send_email
    name = user.get("full_name") or user.get("username")
    reset_url = url_for("auth.reset_password", token=token, _external=True)
    body = (
        f"Hola {name},\n\n"
        f"Has solicitado restablecer tu contraseña en PrionLab Tools.\n"
        f"Sigue este enlace dentro de la próxima hora para elegir una nueva:\n\n"
        f"    {reset_url}\n\n"
        f"Si no has pedido este restablecimiento, ignora este correo "
        f"y tu contraseña actual seguirá funcionando.\n\n"
        f"— PrionLab Tools"
    )
    html = (
        f"<p>Hola <strong>{name}</strong>,</p>"
        f"<p>Has solicitado restablecer tu contraseña en PrionLab Tools.</p>"
        f"<p>Pulsa el enlace dentro de la próxima hora para elegir una nueva:</p>"
        f"<p><a href=\"{reset_url}\">{reset_url}</a></p>"
        f"<p style=\"color:#666;font-size:13px;\">Si no has pedido "
        f"este restablecimiento, ignora este correo y tu contraseña "
        f"actual seguirá funcionando.</p>"
        f"<p>— PrionLab Tools</p>"
    )
    send_email(user.get("email"),
               "Restablecer contraseña — PrionLab Tools",
               body, html=html)


@auth_bp.route("/reset-password/<token>", methods=["GET", "POST"])
def reset_password(token):
    """Validate the token + expiration, accept a new password.
    Token is single-use: cleared atomically with the password set."""
    from core.users import load_users, update_user

    # Walk the user list looking for a row that carries this token.
    # Linear scan over a small CSV is fine; the lookup happens once
    # per password reset attempt.
    matched = None
    for u in load_users():
        if u.get("reset_token") == token:
            matched = u
            break
    error = None
    expired = False
    if not matched:
        error = _("This reset link is invalid or has already been used.")
    else:
        try:
            exp = datetime.fromisoformat(matched.get("reset_token_expires") or "")
            if exp < datetime.utcnow():
                expired = True
                error = _("This reset link has expired. Request a new one.")
        except ValueError:
            error = _("This reset link is invalid or has already been used.")

    if request.method == "POST" and matched and not expired and not error:
        new_pw  = request.form.get("new_password", "")
        confirm = request.form.get("confirm_password", "")
        if new_pw != confirm:
            error = _("The new password and its confirmation don't match.")
        else:
            error = _password_quality_error(new_pw)
        if not error:
            update_user(matched["username"], {
                "password_hash":       hash_password(new_pw),
                "must_change_pw":      "false",
                "reset_token":         "",
                "reset_token_expires": "",
            }, sync=False)
            flash(_("Password updated. You can log in now."), "success")
            return redirect(url_for("auth.login"))
    return render_template("auth/reset_password.html",
                           token=token, error=error,
                           expired=expired,
                           valid=bool(matched and not expired and not error))
