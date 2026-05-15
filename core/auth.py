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
