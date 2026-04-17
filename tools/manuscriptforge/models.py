import csv
import logging
import os
from datetime import datetime

import pandas as pd

from config import CSV_DIR

logger = logging.getLogger(__name__)

# ── Column schemas ────────────────────────────────────────────────────────────

MEMBERS_COLS = [
    "member_id", "first_name", "last_name", "display_name", "initials", "email", "orcid", "dni",
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

MEMBERS_FILE      = os.path.join(CSV_DIR, "members.csv")
AFFILIATIONS_FILE = os.path.join(CSV_DIR, "affiliations.csv")
MEMBER_AFF_FILE   = os.path.join(CSV_DIR, "member_affiliations.csv")

GRANTS_COLS = [
    "grant_id", "code", "title", "funding_agency", "funding_program",
    "principal_investigator", "start_date", "end_date", "amount_eur",
    "status", "acknowledgment_text", "notes", "created_at", "updated_at",
]
GRANT_MEMBERS_COLS = ["grant_id", "member_id", "role"]
GRANTS_FILE       = os.path.join(CSV_DIR, "grants.csv")
GRANT_MEMBERS_FILE = os.path.join(CSV_DIR, "grant_members.csv")

PUBLICATIONS_COLS = [
    "pub_id", "doi", "title", "authors_raw", "journal", "year",
    "volume", "issue", "pages", "pmid", "pdf_path", "pub_type",
    "is_group_pub", "notes", "created_at", "updated_at",
]
PUBLICATIONS_FILE = os.path.join(CSV_DIR, "publications.csv")

ACK_BLOCKS_COLS = [
    "block_id", "category", "short_label", "text", "is_active",
    "notes", "created_at", "updated_at",
]
ACK_VALID_CATEGORIES = {
    "technical_staff", "core_facility", "external_collaborator",
    "sample_donor", "infrastructure", "other",
}
ACK_BLOCKS_FILE = os.path.join(CSV_DIR, "acknowledgment_blocks.csv")


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
        (GRANTS_FILE, GRANTS_COLS),
        (GRANT_MEMBERS_FILE, GRANT_MEMBERS_COLS),
        (PUBLICATIONS_FILE, PUBLICATIONS_COLS),
        (ACK_BLOCKS_FILE, ACK_BLOCKS_COLS),
    ]:
        if not os.path.exists(filepath):
            os.makedirs(CSV_DIR, exist_ok=True)
            pd.DataFrame(columns=cols).to_csv(filepath, index=False)
            logger.info("Created empty %s", os.path.basename(filepath))
    _seed_ack_blocks_if_empty()
    _seed_grants_if_empty()
    _seed_affiliations_if_empty()
    _seed_members_if_empty()
    _seed_extra_affiliations()
    _seed_extra_member_affiliations()
    _seed_extra_ack_blocks()
    _patch_members_initials()
    _bootstrap_papers_dir()


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
    # Cascade: remove member's grants
    gm = load_grant_members()
    save_grant_members(gm[gm["member_id"] != member_id])
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


# ── Grants ────────────────────────────────────────────────────────────────────

def load_grants() -> pd.DataFrame:
    return _read(GRANTS_FILE, GRANTS_COLS)


def save_grants(df: pd.DataFrame, sync: bool = True) -> None:
    _write(df, GRANTS_FILE, "grants.csv" if sync else None)


def get_grant(grant_id: str) -> dict | None:
    df = load_grants()
    rows = df[df["grant_id"] == grant_id]
    return rows.iloc[0].to_dict() if not rows.empty else None


def _next_grant_id(df: pd.DataFrame) -> str:
    nums = df["grant_id"].str.extract(r"^g(\d+)$")[0].dropna().astype(int)
    return f"g{nums.max() + 1:03d}" if not nums.empty else "g001"


def create_grant(data: dict) -> dict:
    df = load_grants()
    data["grant_id"] = _next_grant_id(df)
    data["created_at"] = data["updated_at"] = _now()
    row = {col: data.get(col, "") for col in GRANTS_COLS}
    save_grants(pd.concat([df, pd.DataFrame([row])], ignore_index=True))
    return data


def update_grant(grant_id: str, updates: dict) -> bool:
    df = load_grants()
    mask = df["grant_id"] == grant_id
    if not mask.any():
        return False
    for k, v in updates.items():
        if k in GRANTS_COLS:
            df.loc[mask, k] = v
    df.loc[mask, "updated_at"] = _now()
    save_grants(df)
    return True


def delete_grant(grant_id: str) -> bool:
    df = load_grants()
    if not (df["grant_id"] == grant_id).any():
        return False
    save_grants(df[df["grant_id"] != grant_id])
    gm = load_grant_members()
    save_grant_members(gm[gm["grant_id"] != grant_id])
    return True


# ── Grant ↔ Member bridge ─────────────────────────────────────────────────────

def load_grant_members() -> pd.DataFrame:
    return _read(GRANT_MEMBERS_FILE, GRANT_MEMBERS_COLS)


def save_grant_members(df: pd.DataFrame, sync: bool = True) -> None:
    _write(df, GRANT_MEMBERS_FILE, "grant_members.csv" if sync else None)


def get_grant_members(grant_id: str) -> list[dict]:
    gm = load_grant_members()
    rows = gm[gm["grant_id"] == grant_id]
    if rows.empty:
        return []
    members = load_members()
    result = []
    for _, r in rows.iterrows():
        m_rows = members[members["member_id"] == r["member_id"]]
        if not m_rows.empty:
            item = m_rows.iloc[0].to_dict()
            item["grant_role"] = r["role"]
            result.append(item)
    return result


def get_member_grants(member_id: str) -> list[dict]:
    gm = load_grant_members()
    rows = gm[gm["member_id"] == member_id]
    if rows.empty:
        return []
    grants = load_grants()
    result = []
    for _, r in rows.iterrows():
        g_rows = grants[grants["grant_id"] == r["grant_id"]]
        if not g_rows.empty:
            item = g_rows.iloc[0].to_dict()
            item["grant_role"] = r["role"]
            result.append(item)
    return result


def add_grant_member(grant_id: str, member_id: str, role: str = "") -> tuple[bool, str]:
    gm = load_grant_members()
    if not gm[(gm["grant_id"] == grant_id) & (gm["member_id"] == member_id)].empty:
        return False, "Member already linked to this grant."
    new_row = pd.DataFrame([{"grant_id": grant_id, "member_id": member_id, "role": role}])
    save_grant_members(pd.concat([gm, new_row], ignore_index=True))
    return True, ""


def remove_grant_member(grant_id: str, member_id: str) -> bool:
    gm = load_grant_members()
    mask = (gm["grant_id"] == grant_id) & (gm["member_id"] == member_id)
    if not mask.any():
        return False
    save_grant_members(gm[~mask])
    return True


# ── Publications ──────────────────────────────────────────────────────────────

def load_publications() -> pd.DataFrame:
    return _read(PUBLICATIONS_FILE, PUBLICATIONS_COLS)


def save_publications(df: pd.DataFrame, sync: bool = True) -> None:
    _write(df, PUBLICATIONS_FILE, "publications.csv" if sync else None)


def get_publication(pub_id: str) -> dict | None:
    df = load_publications()
    rows = df[df["pub_id"] == pub_id]
    return rows.iloc[0].to_dict() if not rows.empty else None


def _next_pub_id(df: pd.DataFrame) -> str:
    nums = df["pub_id"].str.extract(r"^pub_(\d+)$")[0].dropna().astype(int)
    return f"pub_{nums.max() + 1:03d}" if not nums.empty else "pub_001"


def create_publication(data: dict) -> dict:
    df = load_publications()
    data["pub_id"] = _next_pub_id(df)
    data["created_at"] = data["updated_at"] = _now()
    row = {col: data.get(col, "") for col in PUBLICATIONS_COLS}
    save_publications(pd.concat([df, pd.DataFrame([row])], ignore_index=True))
    return data


def update_publication(pub_id: str, updates: dict) -> bool:
    df = load_publications()
    mask = df["pub_id"] == pub_id
    if not mask.any():
        return False
    for k, v in updates.items():
        if k in PUBLICATIONS_COLS:
            df.loc[mask, k] = v
    df.loc[mask, "updated_at"] = _now()
    save_publications(df)
    return True


def delete_publication(pub_id: str) -> tuple[bool, str]:
    df = load_publications()
    rows = df[df["pub_id"] == pub_id]
    if rows.empty:
        return False, ""
    pdf_path = rows.iloc[0].get("pdf_path", "")
    save_publications(df[df["pub_id"] != pub_id])
    return True, pdf_path


# ── Acknowledgment Blocks ─────────────────────────────────────────────────────

def load_ack_blocks() -> pd.DataFrame:
    return _read(ACK_BLOCKS_FILE, ACK_BLOCKS_COLS)


def save_ack_blocks(df: pd.DataFrame, sync: bool = True) -> None:
    _write(df, ACK_BLOCKS_FILE, "acknowledgment_blocks.csv" if sync else None)


def get_ack_block(block_id: str) -> dict | None:
    df = load_ack_blocks()
    rows = df[df["block_id"] == block_id]
    return rows.iloc[0].to_dict() if not rows.empty else None


def _next_ack_id(df: pd.DataFrame) -> str:
    nums = df["block_id"].str.extract(r"^ack_(\d+)$")[0].dropna().astype(int)
    return f"ack_{nums.max() + 1:03d}" if not nums.empty else "ack_001"


def create_ack_block(data: dict) -> dict:
    df = load_ack_blocks()
    data["block_id"] = _next_ack_id(df)
    data["created_at"] = data["updated_at"] = _now()
    row = {col: data.get(col, "") for col in ACK_BLOCKS_COLS}
    save_ack_blocks(pd.concat([df, pd.DataFrame([row])], ignore_index=True))
    return data


def update_ack_block(block_id: str, updates: dict) -> bool:
    df = load_ack_blocks()
    mask = df["block_id"] == block_id
    if not mask.any():
        return False
    for k, v in updates.items():
        if k in ACK_BLOCKS_COLS:
            df.loc[mask, k] = v
    df.loc[mask, "updated_at"] = _now()
    save_ack_blocks(df)
    return True


def delete_ack_block(block_id: str) -> bool:
    df = load_ack_blocks()
    if not (df["block_id"] == block_id).any():
        return False
    save_ack_blocks(df[df["block_id"] != block_id])
    return True


def toggle_ack_block(block_id: str) -> bool:
    df = load_ack_blocks()
    mask = df["block_id"] == block_id
    if not mask.any():
        return False
    current = str(df.loc[mask, "is_active"].iloc[0]).lower()
    df.loc[mask, "is_active"] = "false" if current == "true" else "true"
    df.loc[mask, "updated_at"] = _now()
    save_ack_blocks(df)
    return True


# ── Section generation ────────────────────────────────────────────────────────

def _transform_for_additional(text: str) -> str:
    """Rewrite a grant acknowledgment text for use after the first grant."""
    t = text.lower()
    if t.startswith("this work was partially funded by grant"):
        return "Additional funding was provided by grant" + text[len("this work was partially funded by grant"):]
    if t.startswith("this work was funded by grant"):
        return "Additional funding was provided by grant" + text[len("this work was funded by grant"):]
    if t.startswith("additional"):
        return text
    return "Additionally, " + text


def generate_funding(grant_ids: list[str]) -> dict:
    """Build the Funding section text for a manuscript.

    Grants are sorted by funding_agency then code so same-agency grants are
    grouped together. The first grant's text is used verbatim; subsequent
    grants receive an "Additional funding..." or "Additionally, " prefix.

    Returns a dict with keys: funding_text, grants_info, warnings.
    Raises ValueError if the input is invalid.
    """
    if not grant_ids:
        raise ValueError("At least one grant must be selected.")

    all_grants = load_grants()
    known_ids = set(all_grants["grant_id"].tolist())
    missing = [gid for gid in grant_ids if gid not in known_ids]
    if missing:
        raise ValueError(f"Unknown grant(s): {', '.join(missing)}")

    warnings: list[str] = []
    selected: list[dict] = []

    for gid in grant_ids:
        row = all_grants[all_grants["grant_id"] == gid].iloc[0].to_dict()
        if row.get("status", "") not in ("active", "pending"):
            warnings.append(f"Grant {row['code']} is closed but included in the generation.")
        ack = row.get("acknowledgment_text", "").strip()
        if not ack:
            warnings.append(f"Grant {row['code']} has no acknowledgment text — skipped.")
            continue
        selected.append(row)

    if not selected:
        raise ValueError("None of the selected grants have acknowledgment text.")

    # Sort to group same-agency grants together, then by code within each agency
    selected.sort(key=lambda g: (g.get("funding_agency", ""), g.get("code", "")))

    texts: list[str] = []
    for i, grant in enumerate(selected):
        text = grant["acknowledgment_text"].strip()
        if i > 0:
            text = _transform_for_additional(text)
        texts.append(text)

    funding_text = " ".join(texts)

    grants_info = [
        {
            "code":   g.get("code", ""),
            "title":  g.get("title", ""),
            "agency": g.get("funding_agency", ""),
            "status": g.get("status", ""),
        }
        for g in selected
    ]

    return {
        "funding_text": funding_text,
        "grants_info":  grants_info,
        "warnings":     warnings,
    }


_SUPERSCRIPT_DIGITS = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
    "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
}


def _to_superscript(n: int) -> str:
    return "".join(_SUPERSCRIPT_DIGITS[d] for d in str(n))


def _format_affiliation(aff: dict) -> str:
    """Format an affiliation as 'short_name, city, country' (skip empty parts)."""
    parts = [aff.get("short_name", "").strip(),
             aff.get("city", "").strip(),
             aff.get("country", "").strip()]
    return ", ".join(p for p in parts if p)


def generate_author_order(member_ids: list[str]) -> dict:
    """Build the Author Order & Affiliations section for a manuscript.

    Affiliations are numbered by first appearance, walking authors in the
    given order and each author's affiliations by their individual priority.
    Shared affiliations keep the same number across authors.

    Returns a dict with keys: authors_line, affiliations_list,
    affiliations_text, full_text, unaffiliated (list of display names).
    Raises ValueError if the input is invalid.
    """
    if not member_ids:
        raise ValueError("At least one author must be selected.")

    members_df = load_members()
    known_ids = set(members_df["member_id"].tolist())
    missing = [mid for mid in member_ids if mid not in known_ids]
    if missing:
        raise ValueError(f"Unknown member(s): {', '.join(missing)}")

    affiliation_number: dict[str, int] = {}
    affiliation_data: dict[str, dict] = {}
    next_number = 1

    author_entries: list[tuple[str, list[int]]] = []
    unaffiliated: list[str] = []

    for mid in member_ids:
        member = get_member(mid)
        display = (member.get("display_name") or "").strip() or \
                  f"{member.get('first_name', '').strip()} {member.get('last_name', '').strip()}".strip()

        affs = get_member_affiliations(mid)
        if not affs:
            author_entries.append((display, []))
            unaffiliated.append(display)
            logger.warning("Author %s (%s) has no affiliations", mid, display)
            continue

        nums: list[int] = []
        for aff in affs:
            aff_id = aff["affiliation_id"]
            if aff_id not in affiliation_number:
                affiliation_number[aff_id] = next_number
                affiliation_data[aff_id] = aff
                next_number += 1
            nums.append(affiliation_number[aff_id])
        author_entries.append((display, nums))

    if not affiliation_number:
        raise ValueError("None of the selected authors have affiliations.")

    # Build author line: "Name¹'²'³"
    author_tokens = []
    for display, nums in author_entries:
        if nums:
            sups = "'".join(_to_superscript(n) for n in nums)
            author_tokens.append(f"{display}{sups}")
        else:
            author_tokens.append(display)
    authors_line = ", ".join(author_tokens)

    # Build affiliations list in numbering order
    by_number = sorted(affiliation_number.items(), key=lambda kv: kv[1])
    affiliations_list = []
    for aff_id, number in by_number:
        line = f"{_to_superscript(number)}{_format_affiliation(affiliation_data[aff_id])}"
        affiliations_list.append(line)

    affiliations_text = "\n".join(affiliations_list)
    full_text = f"{authors_line}\n\n{affiliations_text}"

    return {
        "authors_line":       authors_line,
        "affiliations_list":  affiliations_list,
        "affiliations_text":  affiliations_text,
        "full_text":          full_text,
        "unaffiliated":       unaffiliated,
    }


# ── Seed & bootstrap helpers ──────────────────────────────────────────────────

_ACK_SEED = [
    ("core_facility",          "Core support CIC bioGUNE + IKERBasque",
     "The authors would like to thank the following for their support: IKERBasque foundation, "
     "vivarium, maintenance and IT services from CIC bioGUNE for outstanding assistance."),
    ("core_facility",          "Electron Microscopy Platform CIC bioGUNE",
     "The Electron Microscopy Platform from CIC bioGUNE for excellent service and assistance."),
    ("technical_staff",        "IRTA-CReSA BSL3 facility",
     "María de la Sierra Espinar and the rest of the IRTA-CReSA BSL3 facility personnel "
     "for their excellent technical support."),
    ("technical_staff",        "Neiker biocontainment unit",
     "The staff of the biocontainment units at Neiker for their excellent care and maintenance "
     "of the animals."),
    ("technical_staff",        "CEBEGA biocontainment unit",
     "The staff of the biocontainment units at CEBEGA for their excellent care and maintenance "
     "of the animals."),
    ("other",                  "Past lab members (coletilla)",
     "The authors would also like to acknowledge the work from past laboratory members of the "
     "Prion Research Lab from CIC bioGUNE, that despite not being directly involved in the "
     "manuscript have contributed along the years to the development of all the methods and "
     "techniques currently used in the laboratory."),
    ("sample_donor",           "Spanish Foundation of Prion Diseases",
     "The families of the Spanish Foundation of prion diseases (www.fundacionprionicas.org), "
     "for their participation in this project and for their collaboration in describing their "
     "genealogies."),
    ("sample_donor",           "CJD Foundation (USA + Spain) + families",
     "The Creutzfeldt-Jakob Disease Foundation (USA and Spain) and the families affected by "
     "prion diseases, whose generosity and support have made it possible to obtain and study "
     "human GSS samples."),
    ("sample_donor",           "Biobanks (generic)",
     "The biobanks that provided access to key biological samples essential for this work."),
    ("external_collaborator",  "Jesús R. Requena (scientific discussion)",
     "Jesús R. Requena for always-useful scientific discussions and advice."),
]


def _seed_ack_blocks_if_empty() -> None:
    if not os.path.exists(ACK_BLOCKS_FILE):
        return
    try:
        existing = pd.read_csv(ACK_BLOCKS_FILE, dtype=str, keep_default_na=False)
        if not existing.empty:
            return
    except Exception:
        return

    now = _now()
    rows = []
    for i, (category, short_label, text) in enumerate(_ACK_SEED, start=1):
        rows.append({
            "block_id":    f"ack_{i:03d}",
            "category":    category,
            "short_label": short_label,
            "text":        text,
            "is_active":   "true",
            "notes":       "",
            "created_at":  now,
            "updated_at":  now,
        })
    df = pd.DataFrame(rows, columns=ACK_BLOCKS_COLS)
    _write(df, ACK_BLOCKS_FILE, "acknowledgment_blocks.csv")
    logger.info("Seeded %d acknowledgment blocks", len(rows))


def _bootstrap_papers_dir() -> None:
    from config import PAPERS_DIR
    os.makedirs(PAPERS_DIR, exist_ok=True)
    try:
        from core.dropbox_client import get_client
        from config import DROPBOX_PAPERS_FOLDER
        client = get_client()
        if client is None:
            return
        try:
            client.files_get_metadata(DROPBOX_PAPERS_FOLDER)
        except Exception:
            client.files_create_folder_v2(DROPBOX_PAPERS_FOLDER)
            logger.info("Created Dropbox papers folder: %s", DROPBOX_PAPERS_FOLDER)
    except Exception as e:
        logger.debug("Could not bootstrap Dropbox papers folder: %s", e)


_GRANTS_SEED = [
    ("g001", "PID2021-122201OB-C21",
     "Understanding the key features of spontaneous prion formation",
     "Ministerio de Ciencia e Innovación", "Plan Estatal", "Joaquín Castilla",
     "2022-01-01", "2025-12-31", "active",
     "This work was partially funded by grant PID2021-122201OB-C21, funded by "
     "MCIN/AEI/10.13039/501100011033 and co-financed by the European Regional "
     "Development Fund (ERDF)."),
    ("g002", "PID2021-1222010B-C22",
     "Prion misfolding mechanisms",
     "Ministerio de Ciencia e Innovación", "Plan Estatal", "Enric Vidal",
     "2022-01-01", "2025-12-31", "active",
     "This work was partially funded by grant PID2021-1222010B-C22, funded by "
     "MCIN/AEI/10.13039/501100011033 and co-financed by the European Regional "
     "Development Fund (ERDF)."),
    ("g003", "PID2020-117465GB-I00",
     "Prion protein structural studies",
     "Ministerio de Ciencia e Innovación", "Plan Estatal", "Jesús R. Requena",
     "2021-01-01", "2024-12-31", "active",
     "This work was partially funded by grant PID2020-117465GB-I00, funded by "
     "MCIN/AEI/10.13039/501100011033 and co-financed by the European Regional "
     "Development Fund (ERDF)."),
    ("g004", "CEX2021-001136-S",
     "Severo Ochoa Excellence accreditation",
     "Ministerio de Ciencia e Innovación", "Severo Ochoa", "Joaquín Castilla",
     "2022-01-01", "2026-12-31", "active",
     "CIC bioGUNE currently holds a Severo Ochoa Excellence accreditation, "
     "CEX2021-001136-S, also funded by Ministerio de Ciencia e Innovación/"
     "AEI/10.13039/501100011033."),
    ("g005", "AC21_2/00024",
     "Neurodegenerative diseases research",
     "Instituto de Salud Carlos III", "JPND", "Joaquín Castilla",
     "2021-01-01", "2024-12-31", "active",
     "Additional funding was provided by the Instituto de Salud Carlos III "
     "(ISCIII), grant number AC21_2/00024, as part of a JPND grant "
     "(JPND-2021-650-130)."),
    ("g006", "EFA031/01",
     "NEURO-COOP cross-border research",
     "European Union", "Interreg VI-A España-Francia-Andorra",
     "Joaquín Castilla / Hasier Eraña",
     "2022-01-01", "2027-12-31", "active",
     "EFA031/01 NEURO-COOP, which is co-funded at 65% by the European Union "
     "through Programa Interreg VI-A España-Francia-Andorra (POCTEFA 2021-2027)."),
    ("g007", "PID2024-160022OB-I00",
     "Next-generation prion research",
     "Ministerio de Ciencia e Innovación", "Plan Estatal", "Joaquín Castilla",
     "2025-01-01", "2028-12-31", "active",
     "This work was partially funded by grant PID2024-160022OB-I00, funded by "
     "MCIN/AEI/10.13039/501100011033 and co-financed by the European Regional "
     "Development Fund (ERDF)."),
    ("g008", "PID2021-125946OB-I00",
     "Advanced protein studies",
     "Ministerio de Ciencia e Innovación", "Plan Estatal", "Gonzalo José Otaegui",
     "2022-01-01", "2025-12-31", "active",
     "This work was funded by grant PID2021-125946OB-I00, funded by "
     "MCIN/AEI/10.13039/501100011033 and co-financed by the European Regional "
     "Development Fund (ERDF)."),
    ("g009", "IJC2020-045506-I",
     "Young researcher grant",
     "Ministerio de Ciencia e Innovación", "Juan de la Cierva", "",
     "2021-01-01", "2023-12-31", "closed",
     "This work was funded by grant IJC2020-045506-I, funded by "
     "MCIN/AEI/10.13039/501100011033 and co-financed by the European Regional "
     "Development Fund (ERDF)."),
    ("g010", "RYC2022-036457-I",
     "Ramón y Cajal fellowship",
     "Ministerio de Ciencia e Innovación", "Ramón y Cajal", "F.P.",
     "2023-01-01", "2028-12-31", "active",
     "This work was funded by grant RYC2022-036457-I, funded by "
     "MCIN/AEI/10.13039/501100011033."),
    ("g011", "PT23/00123",
     "Transgenic facility support",
     "Instituto de Salud Carlos III", "ISCIII", "",
     "2023-01-01", "2026-12-31", "active",
     "Transgenic Facility is supported by Instituto de Salud Carlos III (ISCIII), "
     "co-funded by the European Union grant PT23/00123."),
]


def _seed_grants_if_empty() -> None:
    if not os.path.exists(GRANTS_FILE):
        logger.info("Grants CSV missing, skipping seed (will be created by bootstrap_schema)")
        return
    try:
        existing = pd.read_csv(GRANTS_FILE, dtype=str, keep_default_na=False)
        if not existing.empty:
            logger.info("Grants CSV not empty, skipping seed")
            return
    except Exception:
        return

    now = _now()
    rows = []
    for (gid, code, title, agency, program, pi,
         start, end, status, ack_text) in _GRANTS_SEED:
        rows.append({
            "grant_id":               gid,
            "code":                   code,
            "title":                  title,
            "funding_agency":         agency,
            "funding_program":        program,
            "principal_investigator": pi,
            "start_date":             start,
            "end_date":               end,
            "amount_eur":             "",
            "status":                 status,
            "acknowledgment_text":    ack_text,
            "notes":                  "",
            "created_at":             now,
            "updated_at":             now,
        })
    df = pd.DataFrame(rows, columns=GRANTS_COLS)
    _write(df, GRANTS_FILE, "grants.csv")
    assert len(pd.read_csv(GRANTS_FILE, dtype=str, keep_default_na=False)) == len(rows)
    logger.info("Seed complete: added %d grants to grants.csv", len(rows))


_AFFILIATIONS_SEED = [
    ("aff_001", "CIC BioGUNE",
     "Basque Research and Technology Alliance (BRTA) - CIC BioGUNE",
     "", "Derio", "Bizkaia", "Spain", "ES"),
    ("aff_002", "CIBERINFEC",
     "Centro de Investigación Biomédica en Red de Enfermedades infecciosas",
     "Instituto de Salud Carlos III", "Madrid", "Madrid", "Spain", "ES"),
    ("aff_003", "CISA-INIA-CSIC",
     "Centro de Investigación en Sanidad Animal",
     "", "Valdeolmos", "Madrid", "Spain", "ES"),
    ("aff_004", "Istituto Superiore di Sanità",
     "Istituto Superiore di Sanità",
     "Department of Food Safety, Nutrition and Veterinary Public Health",
     "Rome", "Lazio", "Italy", "IT"),
    ("aff_005", "UKE Hamburg",
     "University Medical Center Hamburg-Eppendorf",
     "Institute of Neuropathology", "Hamburg", "Hamburg", "Germany", "DE"),
    ("aff_006", "Mario Negri IRCCS",
     "Istituto di Ricerche Farmacologiche Mario Negri IRCCS",
     "", "Milan", "Lombardy", "Italy", "IT"),
    ("aff_007", "University of Insubria",
     "University of Insubria",
     "Department of Biotechnology and Life Sciences",
     "Varese", "Lombardy", "Italy", "IT"),
    ("aff_008", "IKERBasque",
     "Basque Foundation for Science",
     "", "Bilbao", "Bizkaia", "Spain", "ES"),
    ("aff_009", "IRTA-CReSA",
     "IRTA, Programa de Sanitat Animal",
     "Centre de Recerca en Sanitat Animal (CReSA), Campus UAB",
     "Bellaterra", "Barcelona", "Spain", "ES"),
    ("aff_010", "IRTA-UAB",
     "Unitat mixta d'Investigación IRTA-UAB en Sanitat Animal",
     "", "Bellaterra", "Barcelona", "Spain", "ES"),
    ("aff_011", "ATLAS Molecular Pharma",
     "ATLAS Molecular Pharma S. L.",
     "", "Derio", "Bizkaia", "Spain", "ES"),
    ("aff_012", "CIMUS-USC",
     "CIMUS Biomedical Research Institute",
     "University of Santiago de Compostela-IDIS",
     "Santiago de Compostela", "Galicia", "Spain", "ES"),
    ("aff_013", "Colorado State University",
     "Colorado State University",
     "Prion Research Center (PRC), Department of Biomedical Sciences",
     "Fort Collins", "Colorado", "USA", "US"),
    ("aff_014", "Universidad de Salamanca",
     "Universidad de Salamanca",
     "Departamento de Medicina", "Salamanca", "Castilla y León", "Spain", "ES"),
    ("aff_015", "INRAE Toulouse",
     "INRAE, ENVT",
     "UMR 1225, Interactions Hôtes Agents Pathogènes",
     "Toulouse", "Occitanie", "France", "FR"),
    ("aff_016", "Norwegian Veterinary Institute",
     "Norwegian Veterinary Institute (NVI)",
     "", "Oslo", "Oslo", "Norway", "NO"),
    ("aff_017", "APHA UK",
     "Animal and Plant Health Agency (APHA)",
     "", "Addlestone, Weybridge", "Surrey", "United Kingdom", "GB"),
    ("aff_018", "Nottingham Trent University",
     "Nottingham Trent University",
     "School of Science and Technology",
     "Nottingham", "England", "United Kingdom", "GB"),
    ("aff_019", "Slovak Medical University",
     "Slovak Medical University",
     "", "Bratislava", "Bratislava", "Slovakia", "SK"),
    ("aff_020", "CNRS Toulouse",
     "Université de Toulouse, CNRS",
     "Centre de Recherche Cerveau et Cognition",
     "Toulouse", "Occitanie", "France", "FR"),
]


def _seed_affiliations_if_empty() -> None:
    if not os.path.exists(AFFILIATIONS_FILE):
        logger.info("Affiliations CSV missing, skipping seed (will be created by bootstrap_schema)")
        return
    try:
        existing = pd.read_csv(AFFILIATIONS_FILE, dtype=str, keep_default_na=False)
        if not existing.empty:
            logger.info("Affiliations CSV not empty, skipping seed")
            return
    except Exception:
        return

    now = _now()
    rows = []
    for (aff_id, short_name, full_name, department,
         city, region, country, country_code) in _AFFILIATIONS_SEED:
        rows.append({
            "affiliation_id": aff_id,
            "short_name":     short_name,
            "full_name":      full_name,
            "department":     department,
            "address_line":   "",
            "postal_code":    "",
            "city":           city,
            "region":         region,
            "country":        country,
            "country_code":   country_code,
            "notes":          "",
            "created_at":     now,
            "updated_at":     now,
        })
    df = pd.DataFrame(rows, columns=AFFILIATIONS_COLS)
    _write(df, AFFILIATIONS_FILE, "affiliations.csv")
    assert len(pd.read_csv(AFFILIATIONS_FILE, dtype=str, keep_default_na=False)) == len(rows)
    logger.info("Seed complete: added %d affiliations to affiliations.csv", len(rows))


_MEMBERS_SEED = [
    # (member_id, first_name, last_name, display_name, initials, email, current_position,
    #  status, is_corresponding_default, has_competing_interests, notes)
    ("m001", "Joaquín",   "Castilla",                    "J. Castilla",      "J.C.",
     "jcastilla@cicbiogune.es",      "PI",                       "active",
     "true",  "false", "Lab PI, corresponding author by default"),
    ("m002", "Hasier",    "Eraña",                       "H. Eraña",         "H.E.",
     "herana.atlas@cicbiogune.es",   "Senior Researcher",        "active",
     "false", "false", "Senior researcher, multiple affiliations"),
    ("m003", "Enric",     "Vidal",                       "E. Vidal",         "E.V.",
     "enric.vidal@irta.cat",         "External Collaborator",    "collaborator_external",
     "false", "false", "IRTA-CReSA collaborator"),
    ("m004", "Natalia",   "Fernández-Borges",             "N. Fernández-Borges", "N.F.B.",
     "natalia.fernandez@inia.csic.es","External Collaborator",   "collaborator_external",
     "false", "false", "CISA-INIA-CSIC collaborator"),
    ("m005", "Jorge M.",  "Charco",                      "J.M. Charco",      "J.M.C.",
     "jmoreno@cicbiogune.es",        "Postdoc",                  "active",
     "false", "false", "Core group member"),
    ("m006", "Carlos M.", "Díaz-Domínguez",              "C.M. Díaz-Domínguez", "C.M.D.D.",
     "cdiaz@cicbiogune.es",          "Postdoc",                  "active",
     "false", "false", "Core group member"),
    ("m007", "Cristina",  "Sampedro-Torres-Quevedo",     "C. Sampedro-Torres-Quevedo", "C.S.T.Q.",
     "csampedro@cicbiogune.es",      "PhD student",              "active",
     "false", "false", "PhD student"),
    ("m008", "Josu",      "Galarza-Ahumada",             "J. Galarza-Ahumada", "J.G.A.",
     "jgalarza@cicbiogune.es",       "PhD student",              "active",
     "false", "false", "PhD student"),
    ("m009", "Eva",       "Fernández-Muñoz",             "E. Fernández-Muñoz", "E.F.M.",
     "efernandez@cicbiogune.es",     "PhD student",              "active",
     "false", "false", "PhD student"),
    ("m010", "Maitena",   "San-Juan-Ansoleaga",          "M. San-Juan-Ansoleaga", "M.S.J.A.",
     "msanjuan@cicbiogune.es",       "Lab Technician",           "active",
     "false", "false", "Technical staff"),
    ("m011", "Miguel Ángel", "Pérez-Castro",             "M.Á. Pérez-Castro", "M.A.P.C.",
     "mperez@lunenfeld.ca",          "External Collaborator",    "collaborator_external",
     "false", "false", "Currently at Lunenfeld"),
    ("m012", "Nuno",      "Gonçalves-Anjo",              "N. Gonçalves-Anjo", "N.G.A.",
     "nanjo@cicbiogune.es",          "Postdoc",                  "active",
     "false", "false", "Postdoc"),
    ("m013", "Patricia",  "Piñeiro",                     "P. Piñeiro",       "P.P.",
     "ppineiro@cicbiogune.es",       "Lab Technician",           "active",
     "false", "false", "Technical staff"),
    ("m014", "Samanta",   "Giler",                       "S. Giler",         "S.G.",
     "samanta.giler@irta.cat",       "External Collaborator",    "collaborator_external",
     "false", "false", "IRTA collaboration"),
    ("m015", "Nora",      "González-Martín",             "N. González-Martín", "N.G.M.",
     "noragonz@usal.es",             "External Collaborator",    "collaborator_external",
     "false", "false", "Universidad de Salamanca"),
    ("m016", "Nuria L.",  "Lorenzo",                     "N.L. Lorenzo",     "N.L.L.",
     "nuria_2l_92@hotmail.com",      "PhD student",              "active",
     "false", "false", "PhD student"),
    ("m017", "Africa",    "Manero-Azua",                 "A. Manero-Azua",   "A.M.A.",
     "africa.maneroruizdeazua@bio-araba.eus", "External Collaborator", "collaborator_external",
     "false", "false", "Bioaraba collaboration"),
    ("m018", "Guiomar",   "Perez de Nanclares",          "G. Perez de Nanclares", "G.P.N.",
     "guiomar.perezdenanclaresleal@osakidetza.eus", "External Collaborator", "collaborator_external",
     "false", "false", "Bioaraba/Biobizkaia collaboration"),
    ("m019", "Mariví",    "Geijo",                       "M. Geijo",         "M.G.",
     "mgeijo@neiker.eus",            "External Collaborator",    "collaborator_external",
     "false", "false", "Neiker collaboration"),
    ("m020", "Manuel A.", "Sánchez-Martín",              "M.A. Sánchez-Martín", "M.A.S.M.",
     "adolsan@usal.es",              "External Collaborator",    "collaborator_external",
     "false", "false", "Universidad de Salamanca, transgenic facility"),
    ("m021", "Jesús R.",  "Requena",                     "J.R. Requena",     "J.R.R.",
     "jesus.requena@usc.es",         "External Collaborator",    "collaborator_external",
     "false", "false", "CIMUS-USC collaboration"),
]

_MEMBER_AFF_SEED = [
    # (member_id, affiliation_id, priority)
    ("m001", "aff_001", "1"),
    ("m001", "aff_008", "2"),
    ("m001", "aff_002", "3"),
    ("m002", "aff_001", "1"),
    ("m002", "aff_002", "2"),
    ("m002", "aff_011", "3"),
    ("m003", "aff_009", "1"),
    ("m003", "aff_010", "2"),
    ("m004", "aff_003", "1"),
    ("m005", "aff_001", "1"),
    ("m005", "aff_002", "2"),
    ("m005", "aff_011", "3"),
    ("m006", "aff_001", "1"),
    ("m006", "aff_002", "2"),
    ("m007", "aff_001", "1"),
    ("m007", "aff_002", "2"),
    ("m008", "aff_001", "1"),
    ("m009", "aff_001", "1"),
    ("m010", "aff_001", "1"),
    ("m011", "aff_001", "1"),
    ("m011", "aff_002", "2"),
    ("m012", "aff_001", "1"),
    ("m013", "aff_001", "1"),
    ("m014", "aff_001", "1"),
    ("m014", "aff_009", "2"),
    ("m015", "aff_014", "1"),
    ("m016", "aff_001", "1"),
    ("m016", "aff_002", "2"),
    ("m020", "aff_014", "1"),
    ("m021", "aff_012", "1"),
]


def _seed_members_if_empty() -> None:
    if not os.path.exists(MEMBERS_FILE):
        logger.info("Members CSV missing, skipping seed (will be created by bootstrap_schema)")
        return
    try:
        existing = pd.read_csv(MEMBERS_FILE, dtype=str, keep_default_na=False)
        if not existing.empty:
            logger.info("Members CSV not empty, skipping seed")
            return
    except Exception:
        return

    now = _now()
    rows = []
    for (mid, first, last, display, initials, email, position,
         status, is_corr, has_ci, notes) in _MEMBERS_SEED:
        rows.append({
            "member_id":                mid,
            "first_name":               first,
            "last_name":                last,
            "display_name":             display,
            "initials":                 initials,
            "email":                    email,
            "orcid":                    "",
            "dni":                      "",
            "is_corresponding_default": is_corr,
            "status":                   status,
            "current_position":         position,
            "joined_date":              "",
            "left_date":                "",
            "short_bio":                "",
            "long_bio":                 "",
            "expertise_areas":          "",
            "has_competing_interests":  has_ci,
            "competing_interests_text": "",
            "linked_username":          "",
            "notes":                    notes,
            "created_at":               now,
            "updated_at":               now,
        })
    df = pd.DataFrame(rows, columns=MEMBERS_COLS)
    _write(df, MEMBERS_FILE, "members.csv")
    assert len(pd.read_csv(MEMBERS_FILE, dtype=str, keep_default_na=False)) == len(rows)
    logger.info("Seed complete: added %d members to members.csv", len(rows))

    _seed_member_affiliations_if_empty()


def _seed_member_affiliations_if_empty() -> None:
    if not os.path.exists(MEMBER_AFF_FILE):
        logger.info("Member affiliations CSV missing, skipping seed")
        return
    try:
        existing = pd.read_csv(MEMBER_AFF_FILE, dtype=str, keep_default_na=False)
        if not existing.empty:
            logger.info("Member affiliations CSV not empty, skipping seed")
            return
    except Exception:
        return

    rows = [{"member_id": m, "affiliation_id": a, "priority": p}
            for m, a, p in _MEMBER_AFF_SEED]
    df = pd.DataFrame(rows, columns=MEMBER_AFF_COLS)
    _write(df, MEMBER_AFF_FILE, "member_affiliations.csv")
    assert len(pd.read_csv(MEMBER_AFF_FILE, dtype=str, keep_default_na=False)) == len(rows)
    logger.info("Seed complete: added %d member-affiliation links to member_affiliations.csv", len(rows))


# ── Extra seed data (added in prompt-05-5) ───────────────────────────────────

_EXTRA_AFFILIATIONS_SEED = [
    ("aff_021", "Bioaraba Neurology",
     "Department of Neurology, Bioaraba Health Research Institute",
     "Araba University Hospital - Txagorritxu",
     "Vitoria-Gasteiz", "Araba", "Spain", "ES"),
    ("aff_022", "Bioaraba Molecular Genetics",
     "Molecular (Epi) Genetics Laboratory, Bioaraba Health Research Institute",
     "Araba University Hospital",
     "Vitoria-Gasteiz", "Araba", "Spain", "ES"),
    ("aff_023", "Biobizkaia Genetics",
     "(Epi)genetics of Rare Disorders, Biobizkaia Health Research Institute",
     "Cruces University Hospital",
     "Barakaldo", "Bizkaia", "Spain", "ES"),
    ("aff_024", "Osakidetza Research Unit",
     "Research Unit, Osakidetza Basque Health Service",
     "Barrualde-Galdakao Integrated Health Organisation",
     "Galdakao", "Bizkaia", "Spain", "ES"),
    ("aff_025", "Kronikgune Institute",
     "Kronikgune Institute for Health Services Research",
     "",
     "Barakaldo", "Bizkaia", "Spain", "ES"),
    ("aff_026", "RICAPPS Network",
     "Network for Research on Chronicity, Primary Care, and Health Promotion (RICAPPS)",
     "",
     "Galdakao", "Bizkaia", "Spain", "ES"),
]


def _seed_extra_affiliations() -> None:
    """Add Basque health ecosystem affiliations (aff_021–aff_026) if not present."""
    if not os.path.exists(AFFILIATIONS_FILE):
        return
    try:
        df = pd.read_csv(AFFILIATIONS_FILE, dtype=str, keep_default_na=False)
    except Exception:
        return

    existing_ids = set(df["affiliation_id"].tolist())
    now = _now()
    new_rows = []
    for (aff_id, short_name, full_name, department,
         city, region, country, country_code) in _EXTRA_AFFILIATIONS_SEED:
        if aff_id in existing_ids:
            continue
        new_rows.append({
            "affiliation_id": aff_id,
            "short_name":     short_name,
            "full_name":      full_name,
            "department":     department,
            "address_line":   "",
            "postal_code":    "",
            "city":           city,
            "region":         region,
            "country":        country,
            "country_code":   country_code,
            "notes":          "",
            "created_at":     now,
            "updated_at":     now,
        })
    if not new_rows:
        logger.info("Extra affiliations already present, skipping")
        return
    for col in AFFILIATIONS_COLS:
        if col not in df.columns:
            df[col] = ""
    df = df[AFFILIATIONS_COLS]
    df_new = pd.DataFrame(new_rows, columns=AFFILIATIONS_COLS)
    df = pd.concat([df, df_new], ignore_index=True)
    _write(df, AFFILIATIONS_FILE, "affiliations.csv")
    logger.info("Seeded %d extra affiliations (aff_021–aff_026)", len(new_rows))


_EXTRA_MEMBER_AFF_SEED = [
    ("m017", "aff_021", "1"),
    ("m017", "aff_022", "2"),
    ("m018", "aff_022", "1"),
    ("m018", "aff_023", "2"),
]


def _seed_extra_member_affiliations() -> None:
    """Add missing member-affiliation links for m017 and m018."""
    if not os.path.exists(MEMBER_AFF_FILE):
        return
    try:
        df = pd.read_csv(MEMBER_AFF_FILE, dtype=str, keep_default_na=False)
    except Exception:
        return

    new_rows = []
    for (mid, aff_id, priority) in _EXTRA_MEMBER_AFF_SEED:
        mask = (df["member_id"] == mid) & (df["affiliation_id"] == aff_id)
        if mask.any():
            continue
        new_rows.append({"member_id": mid, "affiliation_id": aff_id, "priority": priority})
    if not new_rows:
        logger.info("Extra member-affiliation links already present, skipping")
        return
    df_new = pd.DataFrame(new_rows, columns=MEMBER_AFF_COLS)
    df = pd.concat([df, df_new], ignore_index=True)
    _write(df, MEMBER_AFF_FILE, "member_affiliations.csv")
    logger.info("Seeded %d extra member-affiliation links", len(new_rows))


_EXTRA_ACK_SEED = [
    ("ack_011", "core_facility", "SGIker UPV/EHU Electron Microscopy",
     "Technical and human support provided by SGIker (UPV/EHU/ERDF, EU), specifically "
     "the Scanning Electron Microscopy service."),
    ("ack_012", "technical_staff", "Sara Gómez Ramos IT support",
     "Sara Gómez Ramos for her assistance with the PrPdex webpage."),
    ("ack_013", "other", "Past members Tomás Barrio and Leire Hervá",
     "Tomás Barrio and Leire Hervá for their efforts at the initial and end stages of "
     "the work, respectively."),
    ("ack_014", "external_collaborator", "Dr. José Castresana Pyrenean desman",
     "Dr. José Castresana for providing the Pyrenean desman (Galemys pyrenaicus) sample."),
    ("ack_015", "external_collaborator", "Dr. Wilfred Goldmann carnivore samples",
     "Dr. Wilfred Goldmann for providing samples from several carnivores."),
    ("ack_016", "external_collaborator", "Manuel de la Riva Eva Martínez Zoo samples",
     "Manuel de la Riva and Eva Martínez for the samples obtained from Faunia and the "
     "Zoo from Madrid."),
    ("ack_017", "technical_staff", "César P. Díaz-Domínguez cervid images",
     "César P. Díaz-Domínguez for his invaluable contribution through the generation of "
     "cervid images for the manuscript."),
    ("ack_018", "sample_donor", "Dr. Isidre Ferrer GSS isolate",
     "Dr. Isidre Ferrer for the GSS-P102L-129V isolate."),
    ("ack_019", "sample_donor", "Dr. Susana Teijeira IISGS GSS sample",
     "Dr. Susana Teijeira from the Grupo de Enfermedades Raras y Medicina Pediátrica, "
     "Instituto de Investigación Sanitaria Galicia Sur (IISGS), for providing the "
     "GSS-A117V sample from a Spanish patient."),
    ("ack_020", "other", "AI-generated clipart disclosure",
     "Use of a generative AI tool to generate the clipart: A drawing used in figures was "
     "generated using the Copilot Designer generative AI tool (Microsoft365). The prompt "
     "introduced was: \"I need a realistic cartoon of a mouse in black and white or "
     "greyscale to illustrate a figure in a scientific paper.\""),
]


def _seed_extra_ack_blocks() -> None:
    """Add ack_011–ack_020 blocks if they are not already present."""
    if not os.path.exists(ACK_BLOCKS_FILE):
        return
    try:
        df = pd.read_csv(ACK_BLOCKS_FILE, dtype=str, keep_default_na=False)
    except Exception:
        return

    existing_ids = set(df["block_id"].tolist())
    now = _now()
    new_rows = []
    for (bid, category, short_label, text) in _EXTRA_ACK_SEED:
        if bid in existing_ids:
            continue
        new_rows.append({
            "block_id":    bid,
            "category":    category,
            "short_label": short_label,
            "text":        text,
            "is_active":   "true",
            "notes":       "",
            "created_at":  now,
            "updated_at":  now,
        })
    if not new_rows:
        logger.info("Extra ack blocks already present, skipping")
        return
    df_new = pd.DataFrame(new_rows, columns=ACK_BLOCKS_COLS)
    df = pd.concat([df, df_new], ignore_index=True)
    _write(df, ACK_BLOCKS_FILE, "acknowledgment_blocks.csv")
    logger.info("Seeded %d extra acknowledgment blocks (ack_011–ack_020)", len(new_rows))


_MEMBER_INITIALS_MAP = {
    "m001": "J.C.",    "m002": "H.E.",    "m003": "E.V.",
    "m004": "N.F.B.",  "m005": "J.M.C.",  "m006": "C.M.D.D.",
    "m007": "C.S.T.Q.","m008": "J.G.A.",  "m009": "E.F.M.",
    "m010": "M.S.J.A.","m011": "M.A.P.C.","m012": "N.G.A.",
    "m013": "P.P.",    "m014": "S.G.",    "m015": "N.G.M.",
    "m016": "N.L.L.",  "m017": "A.M.A.",  "m018": "G.P.N.",
    "m019": "M.G.",    "m020": "M.A.S.M.","m021": "J.R.R.",
}


def _patch_members_initials() -> None:
    """Backfill initials column for existing member records that lack it."""
    if not os.path.exists(MEMBERS_FILE):
        return
    try:
        df = pd.read_csv(MEMBERS_FILE, dtype=str, keep_default_na=False)
    except Exception:
        return
    if df.empty:
        return

    if "initials" not in df.columns:
        df["initials"] = ""

    patched = 0
    for mid, initials in _MEMBER_INITIALS_MAP.items():
        mask = (df["member_id"] == mid) & (df["initials"].str.strip() == "")
        if mask.any():
            df.loc[mask, "initials"] = initials
            patched += 1

    if not patched:
        logger.info("Members initials already populated, skipping patch")
        return

    for col in MEMBERS_COLS:
        if col not in df.columns:
            df[col] = ""
    df = df[MEMBERS_COLS]
    _write(df, MEMBERS_FILE, "members.csv")
    logger.info("Patched initials for %d members", patched)
