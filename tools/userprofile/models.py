import csv
import logging
import os
import secrets
import uuid
from datetime import date, datetime
from typing import Optional

import config

logger = logging.getLogger(__name__)

LABS_CSV = os.path.join(config.CSV_DIR, "labs.csv")
_LAB_COLS = [
    "lab_id", "lab_name", "institution", "department",
    "pi_username", "description", "website", "location",
    "created_at", "is_active", "lab_code", "max_members",
]
_LAB_ACTIVITY_CSV = os.path.join(config.CSV_DIR, "user_activity_log.csv")
_ACTIVITY_COLS = [
    "activity_id", "username", "action_type", "resource_type",
    "resource_id", "details", "timestamp",
]


def _read(path: str, cols: list) -> list[dict]:
    if not os.path.exists(path):
        return []
    try:
        with open(path, newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        for r in rows:
            for c in cols:
                r.setdefault(c, "")
        return rows
    except Exception as e:
        logger.error("CSV read error %s: %s", path, e)
        return []


def _write(path: str, cols: list, rows: list[dict]):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=cols, quoting=csv.QUOTE_ALL,
                                extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def bootstrap_lab_schema():
    if not os.path.exists(LABS_CSV):
        _write(LABS_CSV, _LAB_COLS, [])
    if not os.path.exists(_LAB_ACTIVITY_CSV):
        _write(_LAB_ACTIVITY_CSV, _ACTIVITY_COLS, [])


# ── Lab helpers ────────────────────────────────────────────────────────────────

def _gen_lab_code(lab_name: str) -> str:
    initials = "".join(w[0].upper() for w in lab_name.split() if w)[:4]
    suffix = secrets.randbelow(1000)
    return f"{initials}{suffix:03d}"


def get_all_labs() -> list[dict]:
    return [l for l in _read(LABS_CSV, _LAB_COLS) if l.get("is_active") != "false"]


def get_lab(lab_id: str) -> Optional[dict]:
    for l in _read(LABS_CSV, _LAB_COLS):
        if l["lab_id"] == lab_id:
            return l
    return None


def get_lab_by_code(code: str) -> Optional[dict]:
    for l in _read(LABS_CSV, _LAB_COLS):
        if l.get("lab_code", "").upper() == code.upper():
            return l
    return None


def create_lab(data: dict, pi_username: str) -> dict:
    labs = _read(LABS_CSV, _LAB_COLS)
    lab_id = "lab_" + uuid.uuid4().hex[:8]
    lab_code = _gen_lab_code(data.get("lab_name", "LAB"))
    record = {
        "lab_id": lab_id,
        "lab_name": data.get("lab_name", "").strip(),
        "institution": data.get("institution", "").strip(),
        "department": data.get("department", "").strip(),
        "pi_username": pi_username,
        "description": data.get("description", "").strip(),
        "website": data.get("website", "").strip(),
        "location": data.get("location", "").strip(),
        "created_at": datetime.utcnow().isoformat(),
        "is_active": "true",
        "lab_code": lab_code,
        "max_members": str(data.get("max_members", 20)),
    }
    if not record["lab_name"]:
        return {"success": False, "error": "Lab name is required."}
    labs.append(record)
    _write(LABS_CSV, _LAB_COLS, labs)
    # Assign PI to lab
    try:
        from core.users import update_user
        update_user(pi_username, {"lab_id": lab_id, "role": "admin"}, sync=False)
    except Exception as e:
        logger.warning("Failed to assign PI to lab: %s", e)
    log_activity(pi_username, "create_lab", "lab", lab_id, f"Lab created: {record['lab_name']}")
    return {"success": True, "lab_id": lab_id, "lab_code": lab_code}


def update_lab(lab_id: str, data: dict, username: str) -> dict:
    labs = _read(LABS_CSV, _LAB_COLS)
    for i, l in enumerate(labs):
        if l["lab_id"] == lab_id:
            for field in ("lab_name", "institution", "department",
                          "description", "website", "location"):
                if field in data:
                    labs[i][field] = data[field].strip()
            _write(LABS_CSV, _LAB_COLS, labs)
            return {"success": True}
    return {"success": False, "error": "Lab not found."}


def join_lab(lab_code: str, username: str) -> dict:
    lab = get_lab_by_code(lab_code)
    if not lab:
        return {"success": False, "error": "Invalid lab code."}
    try:
        from core.users import update_user, get_user
        user = get_user(username)
        if user and user.get("lab_id") == lab["lab_id"]:
            return {"success": False, "error": "Already a member of this lab."}
        update_user(username, {"lab_id": lab["lab_id"]}, sync=False)
        log_activity(username, "join_lab", "lab", lab["lab_id"],
                     f"Joined lab: {lab['lab_name']}")
        return {"success": True, "lab_name": lab["lab_name"]}
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_lab_members(lab_id: str) -> list[dict]:
    try:
        from core.users import load_users
        return [
            {k: u.get(k, "") for k in
             ("username", "full_name", "email", "role",
              "position", "research_areas", "orcid", "last_login")}
            for u in load_users()
            if u.get("lab_id") == lab_id and u.get("active", "true") == "true"
        ]
    except Exception:
        return []


def log_activity(username: str, action: str, resource_type: str,
                 resource_id: str, details: str):
    rows = _read(_LAB_ACTIVITY_CSV, _ACTIVITY_COLS)
    rows.append({
        "activity_id": "act_" + uuid.uuid4().hex[:8],
        "username": username,
        "action_type": action,
        "resource_type": resource_type,
        "resource_id": resource_id,
        "details": details,
        "timestamp": datetime.utcnow().isoformat(),
    })
    # Keep last 500 entries
    _write(_LAB_ACTIVITY_CSV, _ACTIVITY_COLS, rows[-500:])


def get_recent_activity(username: str = "", limit: int = 20) -> list[dict]:
    rows = _read(_LAB_ACTIVITY_CSV, _ACTIVITY_COLS)
    if username:
        rows = [r for r in rows if r.get("username") == username]
    return list(reversed(rows[-limit:]))
