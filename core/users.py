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
COLUMNS = _CORE_COLS + _PROFILE_COLS


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
