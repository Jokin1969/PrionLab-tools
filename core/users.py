import csv
import logging
import os
from config import CSV_DIR

logger = logging.getLogger(__name__)

USERS_FILE = os.path.join(CSV_DIR, "users.csv")
COLUMNS = [
    "username", "password_hash", "full_name", "email",
    "role", "language", "active", "created_at", "last_login",
]


def load_users() -> list[dict]:
    if not os.path.exists(USERS_FILE):
        return []
    try:
        with open(USERS_FILE, "r", newline="", encoding="utf-8") as f:
            return list(csv.DictReader(f))
    except Exception as e:
        logger.error("Failed to load users.csv: %s", e)
        return []


def save_users(users: list[dict], sync: bool = True) -> None:
    os.makedirs(CSV_DIR, exist_ok=True)
    with open(USERS_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction="ignore")
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
