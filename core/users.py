import csv
import fcntl
from contextlib import contextmanager
import logging
import os
from datetime import date

from config import CSV_DIR
from core.auth import hash_password

logger = logging.getLogger(__name__)

USERS_FILE = os.path.join(CSV_DIR, "users.csv")

# Core columns always present
_CORE_COLS = [
    "username", "password_hash", "full_name", "email",
    "role", "language", "active", "created_at", "last_login",
]
# Extended profile columns (optional — default to empty string)
_PROFILE_COLS = [
    "affiliation", "position", "research_areas", "orcid", "bio", "lab_id",
]
# Account-lifecycle columns: force-on-first-login, recovery tokens.
# Added in Jun 2026 when the team-level password-reset flow was
# introduced. Stored as strings in the CSV (the rest of users.csv
# follows the same convention), parsed back to bool / datetime at
# use sites.
_LIFECYCLE_COLS = [
    "must_change_pw",        # "true" | "false"
    "reset_token",           # opaque urlsafe token
    "reset_token_expires",   # ISO-8601 datetime, UTC
    "api_token_hash",        # sha256 of the personal extension key (core/api_tokens.py)
]
# Standing responsibilities, independent of admin/reader role — checked
# in the admin user list, not tied to any single feature's own settings
# page. is_jc_responsible: gets emailed when someone asks (via the "JC"
# button on an article not yet marked for Journal Club) to have it
# considered — see tools/prionvault/services/jc.py's request-email flow.
_ROLE_FLAG_COLS = [
    "is_jc_responsible",     # "true" | "false"
    # Grants PrionVault's own, independent user-management mini-panel
    # (Miscelánea → Administración in the PrionVault sidebar) to a
    # non-admin user — lets them manage user accounts WITHOUT the
    # broader PrionLab admin panel (backups, database, other tools).
    # Checked by core.decorators.prionvault_user_admin_required, never
    # by the regular @admin_required used everywhere else.
    "is_prionvault_admin",   # "true" | "false"
]
COLUMNS = _CORE_COLS + _PROFILE_COLS + _LIFECYCLE_COLS + _ROLE_FLAG_COLS


# ── Storage ─────────────────────────────────────────────────────────────────
# Users live in Postgres (`prionlab_users`, migration 102) whenever the DB is
# available; users.csv is kept as a backup snapshot (rewritten after every
# change, pushed to Dropbox when sync=True) and as a READ-ONLY fallback if
# the DB is unreachable. Without a DATABASE_URL (local dev) everything stays
# on users.csv exactly as before. The public functions below are unchanged.

_TABLE = "prionlab_users"
_db_state = {"ready": None}   # None = not checked yet, True/False after


def _engine():
    from database.config import db
    return db.engine if db.is_configured() else None


def _db_ready() -> bool:
    if _db_state["ready"] is None:
        ensure_db_store()
    return bool(_db_state["ready"])


def ensure_db_store() -> bool:
    """Switch to the Postgres store if `prionlab_users` exists; on first
    use (empty table) import users.csv into it. Called at boot right after
    the Dropbox pull; safe to call repeatedly / from both workers."""
    eng = None
    try:
        eng = _engine()
    except Exception:
        eng = None
    if eng is None:
        _db_state["ready"] = False
        return False
    from sqlalchemy import text
    try:
        with eng.begin() as conn:
            exists = conn.execute(text("SELECT to_regclass(:t)"), {"t": _TABLE}).scalar()
            if not exists:
                _db_state["ready"] = False
                return False
            # One importer at a time (transaction-scoped advisory lock).
            conn.execute(text("SELECT pg_advisory_xact_lock(7072657069)"))
            count = conn.execute(text(f"SELECT COUNT(*) FROM {_TABLE}")).scalar()
            if count == 0:
                rows = _csv_read()
                for r in rows:
                    if not (r.get("username") or "").strip():
                        continue
                    conn.execute(_insert_sql(), {c: (r.get(c) or "") for c in COLUMNS})
                if rows:
                    logger.warning("users: imported %d account(s) from users.csv into %s",
                                   len(rows), _TABLE)
        _db_state["ready"] = True
        return True
    except Exception as exc:
        logger.error("users: Postgres store unavailable, using users.csv (%s)", exc)
        _db_state["ready"] = False
        return False


def _insert_sql():
    from sqlalchemy import text
    cols = ", ".join(COLUMNS)
    vals = ", ".join(f":{c}" for c in COLUMNS)
    return text(f"INSERT INTO {_TABLE} ({cols}) VALUES ({vals}) "
                f"ON CONFLICT ((lower(username))) DO NOTHING")


def _db_rows() -> list[dict]:
    from sqlalchemy import text
    with _engine().connect() as conn:
        rows = conn.execute(text(
            f"SELECT {', '.join(COLUMNS)} FROM {_TABLE} ORDER BY seq")).mappings().all()
    return [{c: (r[c] or "") for c in COLUMNS} for r in rows]


def _snapshot_csv(sync: bool) -> None:
    """Rewrite users.csv from the DB (backup + read fallback)."""
    try:
        _csv_write(_db_rows(), sync=sync)
    except Exception as exc:
        logger.warning("users: CSV snapshot failed: %s", exc)


# ── users.csv primitives ─────────────────────────────────────────────────────

def _csv_read() -> list[dict]:
    """Raises on read errors (used by read-modify-write paths, which must
    never rewrite users.csv from an empty list after a failed read)."""
    if not os.path.exists(USERS_FILE):
        return []
    with open(USERS_FILE, "r", newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        for col in COLUMNS:
            r.setdefault(col, "")
    return rows


_read_users = _csv_read   # kept name (tests / older call sites)

_cache: dict = {"key": None, "rows": None}


def _csv_load_cached() -> list[dict]:
    try:
        st = os.stat(USERS_FILE)
        key = (st.st_mtime_ns, st.st_size, USERS_FILE)
    except OSError:
        key = None
    if key is not None and _cache["key"] == key:
        return [dict(r) for r in _cache["rows"]]
    rows = _csv_read()
    if key is not None:
        _cache["key"], _cache["rows"] = key, [dict(r) for r in rows]
    return rows


def _csv_write(users: list[dict], sync: bool) -> None:
    os.makedirs(CSV_DIR, exist_ok=True)
    # Temp file + atomic swap: readers never see a half-written users.csv.
    tmp = f"{USERS_FILE}.tmp.{os.getpid()}"
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS,
                                extrasaction="ignore", quoting=csv.QUOTE_ALL)
        writer.writeheader()
        writer.writerows(users)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, USERS_FILE)
    if sync:
        from core.sync import push_to_dropbox
        push_to_dropbox("users.csv")


@contextmanager
def _users_lock():
    """Cross-process lock (both gunicorn workers) around read-modify-write
    of users.csv, so concurrent edits don't lose each other (CSV mode)."""
    os.makedirs(CSV_DIR, exist_ok=True)
    with open(USERS_FILE + ".lock", "w") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)


# ── Public API ───────────────────────────────────────────────────────────────

def load_users() -> list[dict]:
    """Every account as a list of string dicts (fresh copies)."""
    if _db_ready():
        try:
            return _db_rows()
        except Exception as exc:
            logger.error("users: DB read failed, falling back to users.csv: %s", exc)
    try:
        return _csv_load_cached()
    except Exception as e:
        logger.error("Failed to load users.csv: %s", e)
        return []


def save_users(users: list[dict], sync: bool = True) -> None:
    """Persist the given accounts. DB mode: upsert each (never deletes —
    only bootstrap uses this); CSV mode: rewrite users.csv."""
    if _db_ready():
        from sqlalchemy import text
        sets = ", ".join(f"{c} = EXCLUDED.{c}" for c in COLUMNS if c != "username")
        cols = ", ".join(COLUMNS)
        vals = ", ".join(f":{c}" for c in COLUMNS)
        with _engine().begin() as conn:
            for u in users:
                conn.execute(text(
                    f"INSERT INTO {_TABLE} ({cols}) VALUES ({vals}) "
                    f"ON CONFLICT ((lower(username))) DO UPDATE SET {sets}, updated_at = NOW()"),
                    {c: (u.get(c) or "") for c in COLUMNS})
        _snapshot_csv(sync)
        return
    _csv_write(users, sync=sync)


def _db_one(where: str, value: str) -> dict | None:
    from sqlalchemy import text
    with _engine().connect() as conn:
        r = conn.execute(text(
            f"SELECT {', '.join(COLUMNS)} FROM {_TABLE} WHERE {where} ORDER BY seq LIMIT 1"),
            {"v": value}).mappings().first()
    return {c: (r[c] or "") for c in COLUMNS} if r else None


def get_user(username: str) -> dict | None:
    if not username:
        return None
    if _db_ready():
        try:
            return _db_one("lower(username) = lower(:v)", username)
        except Exception as exc:
            logger.error("users: DB lookup failed, falling back to users.csv: %s", exc)
    for u in load_users():
        if u.get("username", "").lower() == username.lower():
            return u
    return None


def get_user_by_email(email: str) -> dict | None:
    """Lookup by email address, case-insensitive. Returns the first
    match (emails are de-facto unique under the standard create flow).
    Used by /forgot-password and as a fallback for /login when the
    operator types their email instead of their username."""
    if not email:
        return None
    e = email.lower().strip()
    if _db_ready():
        try:
            return _db_one("lower(trim(email)) = :v", e)
        except Exception as exc:
            logger.error("users: DB lookup failed, falling back to users.csv: %s", exc)
    for u in load_users():
        if (u.get("email") or "").lower().strip() == e:
            return u
    return None


def get_user_by_username_or_email(identifier: str) -> dict | None:
    """Convenience for /login: try username first, then email.
    Single source of truth for the "what is this person typing in
    the username field" decision."""
    if not identifier:
        return None
    return get_user(identifier) or get_user_by_email(identifier)


def list_admin_emails() -> list[str]:
    """Every active admin's email — used to BCC the admin on outcomes
    from channels meant for non-admin users (e.g. the reader-facing
    email-ingest mailbox), so they can see who used it and how each
    submission resolved without the sender being aware they're copied."""
    return [
        u["email"].strip()
        for u in load_users()
        if (u.get("role") or "").lower() == "admin"
        and (u.get("active") or "true").lower() == "true"
        and (u.get("email") or "").strip()
    ]


def list_active_users() -> list[dict]:
    """Every active user (any role) with an email — the recipient list
    for lab-wide broadcasts like the Journal Club convocation email."""
    return [
        u for u in load_users()
        if (u.get("active") or "true").lower() == "true"
        and (u.get("email") or "").strip()
    ]


def list_jc_responsible() -> list[dict]:
    """Every active user flagged as a Journal Club responsible (full
    user dict — used when the caller needs the name, not just the
    email, e.g. to address them by name in an email)."""
    return [
        u for u in load_users()
        if (u.get("is_jc_responsible") or "").lower() == "true"
        and (u.get("active") or "true").lower() == "true"
        and (u.get("email") or "").strip()
    ]


def user_exists(username: str) -> bool:
    return get_user(username) is not None


def email_exists(email: str) -> bool:
    email_lower = email.lower().strip()
    return any(u.get("email", "").lower() == email_lower for u in load_users())


def create_user(data: dict, sync: bool = True) -> None:
    if _db_ready():
        from sqlalchemy import text
        cols = ", ".join(COLUMNS)
        vals = ", ".join(f":{c}" for c in COLUMNS)
        with _engine().begin() as conn:
            conn.execute(text(f"INSERT INTO {_TABLE} ({cols}) VALUES ({vals})"),
                         {c: (data.get(c) or "") for c in COLUMNS})
        _snapshot_csv(sync)
        return
    with _users_lock():
        users = _csv_read()
        users.append({col: data.get(col, "") for col in COLUMNS})
        _csv_write(users, sync=sync)


def update_user(username: str, updates: dict, sync: bool = True) -> bool:
    fields = {k: ("" if v is None else v) for k, v in updates.items()
              if k in COLUMNS and k != "username"}
    if _db_ready():
        from sqlalchemy import text
        if not fields:
            return get_user(username) is not None
        sets = ", ".join(f"{k} = :{k}" for k in fields)
        with _engine().begin() as conn:
            n = conn.execute(text(
                f"UPDATE {_TABLE} SET {sets}, updated_at = NOW() "
                f"WHERE lower(username) = lower(:_u)"), {**fields, "_u": username}).rowcount
        if n:
            _snapshot_csv(sync)
        return bool(n)
    with _users_lock():
        users = _csv_read()
        for i, u in enumerate(users):
            if u.get("username", "").lower() == username.lower():
                for k, v in updates.items():
                    if k in COLUMNS:
                        users[i][k] = v
                _csv_write(users, sync=sync)
                return True
    return False


def delete_user(username: str, sync: bool = True) -> bool:
    if _db_ready():
        from sqlalchemy import text
        with _engine().begin() as conn:
            n = conn.execute(text(
                f"DELETE FROM {_TABLE} WHERE lower(username) = lower(:u)"),
                {"u": username}).rowcount
        if n:
            _snapshot_csv(sync)
        return bool(n)
    with _users_lock():
        users = _csv_read()
        filtered = [u for u in users if u.get("username", "").lower() != username.lower()]
        if len(filtered) == len(users):
            return False
        _csv_write(filtered, sync=sync)
    return True


def bootstrap_team_users() -> None:
    """Seed the prion-lab team accounts (Jun 2026) with the canonical
    starter password "12345678" and must_change_pw=true so each user
    is forced to set their own at first login.

    Idempotent: skips entries whose email is ALREADY in users.csv.
    Username derives from the local part of the email so a user can
    log in with either their username or their full email — the
    auth flow accepts both.

    Joaquín Castilla is explicitly excluded: he is the existing
    admin and his account is created by bootstrap_admin_user() with
    its own credentials. Re-seeding him here would either be a
    no-op or wipe his current password — neither is desirable.
    """
    TEAM = [
        # (display name, email)
        ("Carlos Díaz",       "cdiaz@cicbiogune.es"),
        ("Cristina Sampedro", "csampedro@cicbiogune.es"),
        ("Eva Férnandez",     "efernandez@cicbiogune.es"),
        ("Enric Vidal",       "enric.vidal@irta.cat"),
        ("Hasier Eraña",      "herana@cicbiogune.es"),
        ("Inés Xanco",        "ines.xanco@irta.cat"),
        ("Josu Galarza",      "jgalarza@cicbiogune.es"),
        ("Jorge Moreno",      "jmoreno@cicbiogune.es"),
        ("Maitena San Juan",  "msanjuan@cicbiogune.es"),
        ("Nuño Anjo",         "nanjo@cicbiogune.es"),
        ("Nerea Isusi",       "nisusi@cicbiogune.es"),
        ("Patricia Piñeiro",  "ppineiro@cicbiogune.es"),
        ("Samanta Giler",     "samanta.giler@irta.cat"),
        ("Sara Caballero",    "scaballero@cicbiogune.es"),
    ]

    # Pre-hash the shared starter password ONCE, not per-row. bcrypt
    # at rounds=12 is ~250 ms each — 14 of them would add 3-4 s to
    # boot time for no benefit, since they share the same plaintext.
    # No shared/known starter password any more: new seeds get an
    # unusable random one and set theirs via "¿Olvidaste tu contraseña?".
    import secrets as _secrets
    from core.auth import verify_password
    starter_hash = "locked:" + _secrets.token_hex(16)

    # Lock seeded accounts that were never used and still carry the old
    # public starter password (anyone knowing the email could take them).
    for u in load_users():
        h = u.get("password_hash") or ""
        if ((u.get("must_change_pw") or "").lower() == "true" and not u.get("last_login")
                and not h.startswith("locked:") and verify_password("12345678", h)):
            update_user(u["username"], {"password_hash": "locked:" + _secrets.token_hex(16)}, sync=True)
            logger.warning("Team bootstrap: locked unused starter-password account %s", u["username"])

    created = 0
    for full_name, email in TEAM:
        if email_exists(email):
            continue
        username = email.split("@", 1)[0].lower()
        # Edge case: an admin manually created an account with a
        # colliding local-part. Append a digit until we find a slot.
        base = username
        n = 1
        while user_exists(username):
            username = f"{base}{n}"
            n += 1
        try:
            create_user({
                "username":            username,
                "password_hash":       starter_hash,
                "full_name":           full_name,
                "email":               email,
                "role":                "reader",
                "language":            "es",
                "active":              "true",
                "created_at":          date.today().isoformat(),
                "last_login":          "",
                "must_change_pw":      "true",
                "reset_token":         "",
                "reset_token_expires": "",
            }, sync=False)
            created += 1
        except Exception as e:
            logger.warning("Failed to seed team user %s: %s", email, e)
    if created:
        logger.info("Team bootstrap: created %d new user(s)", created)


