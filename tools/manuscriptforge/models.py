import csv
import logging
import os
from datetime import datetime

import pandas as pd

from config import CSV_DIR

logger = logging.getLogger(__name__)

# ── Column schemas ────────────────────────────────────────────────────────────

MEMBERS_COLS = [
    "member_id", "first_name", "last_name", "display_name", "email", "orcid", "dni",
    "is_corresponding_default", "status", "current_position", "joined_date", "left_date",
    "short_bio", "long_bio", "expertise_areas", "has_competing_interests",
    "competing_interests_text", "linked_username", "notes", "created_at", "updated_at",
]
AFFILIATIONS_COLS = [
    "affiliation_id", "short_name", "full_name", "department", "address_line",
    "postal_code", "city", "region", "country", "country_code", "notes",
    "created_at", "updated_at",
]
MEMBER_AFF_COLS = ["member_id", "affiliation_id", "priority"]

MEMBERS_FILE     = os.path.join(CSV_DIR, "members.csv")
AFFILIATIONS_FILE = os.path.join(CSV_DIR, "affiliations.csv")
MEMBER_AFF_FILE  = os.path.join(CSV_DIR, "member_affiliations.csv")


# ── Internal helpers ──────────────────────────────────────────────────────────

def _read(filepath: str, columns: list[str]) -> pd.DataFrame:
    if not os.path.exists(filepath):
        return pd.DataFrame(columns=columns)
    try:
        df = pd.read_csv(filepath, dtype=str, keep_default_na=False, na_values=[])
        for col in columns:
            if col not in df.columns:
                df[col] = ""
        return df[columns]
    except Exception as e:
        logger.error("Failed to read %s: %s", filepath, e)
        return pd.DataFrame(columns=columns)


def _write(df: pd.DataFrame, filepath: str, sync_name: str | None = None) -> None:
    os.makedirs(CSV_DIR, exist_ok=True)
    df.to_csv(filepath, index=False, quoting=csv.QUOTE_ALL)
    if sync_name:
        try:
            from core.sync import push_to_dropbox
            push_to_dropbox(sync_name)
        except Exception as e:
            logger.error("Dropbox push for %s failed: %s", sync_name, e)


def _now() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")


# ── Schema bootstrap ──────────────────────────────────────────────────────────

def bootstrap_schema() -> None:
    """Create empty CSVs with correct headers if they don't exist."""
    for filepath, cols in [
        (MEMBERS_FILE, MEMBERS_COLS),
        (AFFILIATIONS_FILE, AFFILIATIONS_COLS),
        (MEMBER_AFF_FILE, MEMBER_AFF_COLS),
    ]:
        if not os.path.exists(filepath):
            os.makedirs(CSV_DIR, exist_ok=True)
            pd.DataFrame(columns=cols).to_csv(filepath, index=False)
            logger.info("Created empty %s", os.path.basename(filepath))


# ── Members ───────────────────────────────────────────────────────────────────

def load_members() -> pd.DataFrame:
    return _read(MEMBERS_FILE, MEMBERS_COLS)


def save_members(df: pd.DataFrame, sync: bool = True) -> None:
    _write(df, MEMBERS_FILE, "members.csv" if sync else None)


def get_member(member_id: str) -> dict | None:
    df = load_members()
    rows = df[df["member_id"] == member_id]
    return rows.iloc[0].to_dict() if not rows.empty else None


def _next_member_id(df: pd.DataFrame) -> str:
    nums = df["member_id"].str.extract(r"^m(\d+)$")[0].dropna().astype(int)
    return f"m{nums.max() + 1:03d}" if not nums.empty else "m001"


def create_member(data: dict) -> dict:
    df = load_members()
    data["member_id"] = _next_member_id(df)
    data["created_at"] = data["updated_at"] = _now()
    row = {col: data.get(col, "") for col in MEMBERS_COLS}
    save_members(pd.concat([df, pd.DataFrame([row])], ignore_index=True))
    return data


def update_member(member_id: str, updates: dict) -> bool:
    df = load_members()
    mask = df["member_id"] == member_id
    if not mask.any():
        return False
    for k, v in updates.items():
        if k in MEMBERS_COLS:
            df.loc[mask, k] = v
    df.loc[mask, "updated_at"] = _now()
    save_members(df)
    return True


def delete_member(member_id: str) -> bool:
    df = load_members()
    if not (df["member_id"] == member_id).any():
        return False
    save_members(df[df["member_id"] != member_id])
    # Cascade: remove member's affiliations
    ma = load_member_affiliations()
    save_member_affiliations(ma[ma["member_id"] != member_id])
    return True


# ── Affiliations ──────────────────────────────────────────────────────────────

def load_affiliations() -> pd.DataFrame:
    return _read(AFFILIATIONS_FILE, AFFILIATIONS_COLS)


def save_affiliations(df: pd.DataFrame, sync: bool = True) -> None:
    _write(df, AFFILIATIONS_FILE, "affiliations.csv" if sync else None)


def get_affiliation(affiliation_id: str) -> dict | None:
    df = load_affiliations()
    rows = df[df["affiliation_id"] == affiliation_id]
    return rows.iloc[0].to_dict() if not rows.empty else None


def _next_affiliation_id(df: pd.DataFrame) -> str:
    nums = df["affiliation_id"].str.extract(r"^aff_(\d+)$")[0].dropna().astype(int)
    return f"aff_{nums.max() + 1:03d}" if not nums.empty else "aff_001"


def create_affiliation(data: dict) -> dict:
    df = load_affiliations()
    data["affiliation_id"] = _next_affiliation_id(df)
    data["created_at"] = data["updated_at"] = _now()
    row = {col: data.get(col, "") for col in AFFILIATIONS_COLS}
    save_affiliations(pd.concat([df, pd.DataFrame([row])], ignore_index=True))
    return data


def update_affiliation(affiliation_id: str, updates: dict) -> bool:
    df = load_affiliations()
    mask = df["affiliation_id"] == affiliation_id
    if not mask.any():
        return False
    for k, v in updates.items():
        if k in AFFILIATIONS_COLS:
            df.loc[mask, k] = v
    df.loc[mask, "updated_at"] = _now()
    save_affiliations(df)
    return True


def delete_affiliation(affiliation_id: str) -> tuple[bool, str]:
    ma = load_member_affiliations()
    n_linked = int((ma["affiliation_id"] == affiliation_id).sum())
    if n_linked:
        return False, f"Cannot delete: {n_linked} member(s) linked. Remove them first."
    df = load_affiliations()
    if not (df["affiliation_id"] == affiliation_id).any():
        return False, "Affiliation not found."
    save_affiliations(df[df["affiliation_id"] != affiliation_id])
    return True, ""


# ── Member ↔ Affiliation bridge ───────────────────────────────────────────────

def load_member_affiliations() -> pd.DataFrame:
    return _read(MEMBER_AFF_FILE, MEMBER_AFF_COLS)


def save_member_affiliations(df: pd.DataFrame, sync: bool = True) -> None:
    _write(df, MEMBER_AFF_FILE, "member_affiliations.csv" if sync else None)


def get_member_affiliations(member_id: str) -> list[dict]:
    """Returns affiliation records for a member, enriched with affiliation details."""
    ma = load_member_affiliations()
    rows = ma[ma["member_id"] == member_id].copy()
    if rows.empty:
        return []
    rows["priority"] = pd.to_numeric(rows["priority"], errors="coerce").fillna(0).astype(int)
    rows = rows.sort_values("priority")

    affs = load_affiliations()
    result = []
    for _, r in rows.iterrows():
        aff_rows = affs[affs["affiliation_id"] == r["affiliation_id"]]
        if not aff_rows.empty:
            item = aff_rows.iloc[0].to_dict()
            item["priority"] = int(r["priority"])
            result.append(item)
    return result


def get_affiliation_members(affiliation_id: str) -> list[dict]:
    """Returns member records linked to an affiliation."""
    ma = load_member_affiliations()
    rows = ma[ma["affiliation_id"] == affiliation_id]
    if rows.empty:
        return []
    members = load_members()
    result = []
    for _, r in rows.iterrows():
        m_rows = members[members["member_id"] == r["member_id"]]
        if not m_rows.empty:
            item = m_rows.iloc[0].to_dict()
            item["priority"] = r["priority"]
            result.append(item)
    return result


def count_affiliation_members(affiliation_id: str) -> int:
    ma = load_member_affiliations()
    return int((ma["affiliation_id"] == affiliation_id).sum())


def add_member_affiliation(member_id: str, affiliation_id: str) -> tuple[bool, str]:
    ma = load_member_affiliations()
    if not ma[(ma["member_id"] == member_id) & (ma["affiliation_id"] == affiliation_id)].empty:
        return False, "Affiliation already assigned to this member."
    existing = ma[ma["member_id"] == member_id]
    priorities = pd.to_numeric(existing["priority"], errors="coerce").dropna().astype(int)
    priority = int(priorities.max()) + 1 if not priorities.empty else 1
    new_row = pd.DataFrame([{"member_id": member_id, "affiliation_id": affiliation_id, "priority": str(priority)}])
    save_member_affiliations(pd.concat([ma, new_row], ignore_index=True))
    return True, ""


def remove_member_affiliation(member_id: str, affiliation_id: str) -> bool:
    ma = load_member_affiliations()
    mask = (ma["member_id"] == member_id) & (ma["affiliation_id"] == affiliation_id)
    if not mask.any():
        return False
    ma = ma[~mask]
    ma = _renumber_priorities(ma, member_id)
    save_member_affiliations(ma)
    return True


def move_member_affiliation(member_id: str, affiliation_id: str, direction: str) -> bool:
    ma = load_member_affiliations()
    rows = ma[ma["member_id"] == member_id].copy()
    rows["priority"] = pd.to_numeric(rows["priority"], errors="coerce").astype(int)
    rows = rows.sort_values("priority")

    target = rows[rows["affiliation_id"] == affiliation_id]
    if target.empty:
        return False
    target_idx = target.index[0]
    sorted_idxs = rows.index.tolist()
    pos = sorted_idxs.index(target_idx)

    if direction == "up" and pos > 0:
        swap_idx = sorted_idxs[pos - 1]
    elif direction == "down" and pos < len(sorted_idxs) - 1:
        swap_idx = sorted_idxs[pos + 1]
    else:
        return False

    p1, p2 = ma.loc[target_idx, "priority"], ma.loc[swap_idx, "priority"]
    ma.loc[target_idx, "priority"] = p2
    ma.loc[swap_idx, "priority"] = p1
    save_member_affiliations(ma)
    return True


def _renumber_priorities(df: pd.DataFrame, member_id: str) -> pd.DataFrame:
    rows = df[df["member_id"] == member_id].copy()
    rows["priority"] = pd.to_numeric(rows["priority"], errors="coerce").astype(int)
    rows = rows.sort_values("priority")
    for i, idx in enumerate(rows.index, start=1):
        df.loc[idx, "priority"] = str(i)
    return df
