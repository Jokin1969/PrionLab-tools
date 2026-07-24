import csv
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
]
COLUMNS = _CORE_COLS + _PROFILE_COLS + _LIFECYCLE_COLS


def load_users() -> list[dict]:
    if not os.path.exists(USERS_FILE):
        return []
    try:
        with open(USERS_FILE, "r", newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        for r in rows:
            for col in COLUMNS:
                r.setdefault(col, "")
        return rows
    except Exception as e:
        logger.error("Failed to load users.csv: %s", e)
        return []


def save_users(users: list[dict], sync: bool = True) -> None:
    os.makedirs(CSV_DIR, exist_ok=True)
    with open(USERS_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS,
                                extrasaction="ignore", quoting=csv.QUOTE_ALL)
        writer.writeheader()
        writer.writerows(users)
    if sync:
        from core.sync import push_to_dropbox
        push_to_dropbox("users.csv")


def get_user(username: str) -> dict | None:
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


def user_exists(username: str) -> bool:
    return get_user(username) is not None


def email_exists(email: str) -> bool:
    email_lower = email.lower().strip()
    return any(u.get("email", "").lower() == email_lower for u in load_users())


def create_user(data: dict, sync: bool = True) -> None:
    users = load_users()
    users.append({col: data.get(col, "") for col in COLUMNS})
    save_users(users, sync=sync)


def update_user(username: str, updates: dict, sync: bool = True) -> bool:
    users = load_users()
    for i, u in enumerate(users):
        if u.get("username", "").lower() == username.lower():
            for k, v in updates.items():
                if k in COLUMNS:
                    users[i][k] = v
            save_users(users, sync=sync)
            return True
    return False


def delete_user(username: str, sync: bool = True) -> bool:
    users = load_users()
    filtered = [u for u in users if u.get("username", "").lower() != username.lower()]
    if len(filtered) == len(users):
        return False
    save_users(filtered, sync=sync)
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
    starter_hash = hash_password("12345678")

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


def bootstrap_demo_users() -> None:
    """Ensure demo accounts exist (idempotent — safe to call on every startup)."""
    demo_accounts = [
        {"username": "jcastilla", "full_name": "Javier Castilla", "role": "admin",
         "email": "jcastilla@prionlab.org", "affiliation": "CReSA-IRTA",
         "position": "PI", "research_areas": "prion diseases; neurodegeneration"},
        {"username": "herana", "full_name": "Hasier Erana", "role": "editor",
         "email": "herana@prionlab.org", "affiliation": "CReSA-IRTA",
         "position": "Postdoc", "research_areas": "prion strains; PMCA"},
        {"username": "jcharco", "full_name": "Jorge Charco", "role": "editor",
         "email": "jcharco@prionlab.org", "affiliation": "CReSA-IRTA",
         "position": "PhD student", "research_areas": "prion diagnostics; biomarkers"},
    ]
    for demo in demo_accounts:
        if not user_exists(demo["username"]):
            try:
                create_user({
                    **demo,
                    "password_hash": hash_password("demo123"),
                    "language": "es",
                    "active": "true",
                    "created_at": date.today().isoformat(),
                    "last_login": "",
                    "bio": "",
                    "orcid": "",
                    "lab_id": "",
                }, sync=False)
                logger.info("Demo user created: %s", demo["username"])
            except Exception as e:
                logger.warning("Failed to create demo user %s: %s", demo["username"], e)
