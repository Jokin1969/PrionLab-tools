import csv
import logging
import os
import re
import uuid
from datetime import datetime, timedelta

import pandas as pd
from docx import Document

import config

logger = logging.getLogger(__name__)

TEMPLATES_CSV = os.path.join(config.CSV_DIR, "export_templates.csv")
HISTORY_CSV = os.path.join(config.CSV_DIR, "export_history.csv")

TEMPLATES_COLS = ["template_id", "name", "format", "description", "sections_order", "is_active"]
HISTORY_COLS = [
    "export_id", "user_id", "template_id", "sections_exported",
    "filename", "filepath", "created_at", "download_count", "expires_at",
]

_SEED_TEMPLATES = [
    {
        "template_id": "exp_001", "name": "Basic Word", "format": "docx",
        "description": "Standard Word document format",
        "sections_order": "author_order,methods,funding,acknowledgments,credit,competing_interests",
        "is_active": "true",
    },
    {
        "template_id": "exp_002", "name": "Basic LaTeX", "format": "latex",
        "description": "Standard LaTeX academic format",
        "sections_order": "author_order,methods,funding,acknowledgments,credit,competing_interests",
        "is_active": "true",
    },
    {
        "template_id": "exp_003", "name": "Nature Word", "format": "docx",
        "description": "Nature journal Word format with specific styling",
        "sections_order": "author_order,methods,acknowledgments,funding,credit,competing_interests",
        "is_active": "true",
    },
    {
        "template_id": "exp_004", "name": "Nature LaTeX", "format": "latex",
        "description": "Nature journal LaTeX format",
        "sections_order": "author_order,methods,acknowledgments,funding,credit,competing_interests",
        "is_active": "true",
    },
    {
        "template_id": "exp_005", "name": "Methods Only", "format": "docx",
        "description": "Export only Methods section for supplementary",
        "sections_order": "methods",
        "is_active": "true",
    },
]

_SECTION_TITLES = {
    "author_order": "Author Order & Affiliations",
    "methods": "Materials and Methods",
    "funding": "Funding",
    "acknowledgments": "Acknowledgments",
    "credit": "Author Contributions",
    "competing_interests": "Competing Interests",
}


def _read_templates() -> pd.DataFrame:
    if not os.path.exists(TEMPLATES_CSV):
        return pd.DataFrame(columns=TEMPLATES_COLS)
    return pd.read_csv(TEMPLATES_CSV, dtype=str).fillna("")


def _read_history() -> pd.DataFrame:
    if not os.path.exists(HISTORY_CSV):
        return pd.DataFrame(columns=HISTORY_COLS)
    return pd.read_csv(HISTORY_CSV, dtype=str).fillna("")


def _write_history(df: pd.DataFrame) -> None:
    df.to_csv(HISTORY_CSV, index=False, quoting=csv.QUOTE_ALL)


def _seed_export_templates_if_empty() -> None:
    if os.path.exists(TEMPLATES_CSV):
        try:
            if not pd.read_csv(TEMPLATES_CSV, dtype=str).empty:
                return
        except Exception:
            pass
    pd.DataFrame(_SEED_TEMPLATES).to_csv(TEMPLATES_CSV, index=False, quoting=csv.QUOTE_ALL)
    logger.info("Export templates seeded.")


def bootstrap_export_schema() -> None:
    _seed_export_templates_if_empty()
    if not os.path.exists(HISTORY_CSV):
        pd.DataFrame(columns=HISTORY_COLS).to_csv(HISTORY_CSV, index=False, quoting=csv.QUOTE_ALL)


def get_export_templates() -> list:
    df = _read_templates()
    return df[df["is_active"] == "true"].to_dict(orient="records")


def get_export_template(template_id: str) -> dict | None:
    df = _read_templates()
    row = df[df["template_id"] == template_id]
    return row.iloc[0].to_dict() if not row.empty else None


def get_template_sections_order(template_id: str) -> list:
    tmpl = get_export_template(template_id)
    if not tmpl:
        return []
    return [s.strip() for s in tmpl.get("sections_order", "").split(",") if s.strip()]


def format_section_title(key: str) -> str:
    return _SECTION_TITLES.get(key, key.replace("_", " ").title())


def _escape_latex(text: str) -> str:
    special = {
        "\\": r"\textbackslash{}",
        "&": r"\&",
        "%": r"\%",
        "$": r"\$",
        "#": r"\#",
        "_": r"\_",
        "{": r"\{",
        "}": r"\}",
        "~": r"\textasciitilde{}",
        "^": r"\textasciicircum{}",
    }
    pattern = re.compile("|".join(re.escape(k) for k in special))
    return pattern.sub(lambda m: special[m.group()], text)


def export_to_word(sections_data: dict, template_id: str = "exp_001") -> str:
    doc = Document()
    title = sections_data.get("title", "Manuscript Draft")
    doc.add_heading(title, 0)

    order = get_template_sections_order(template_id)
    if not order:
        order = [k for k in sections_data if k != "title"]

    for key in order:
        if key not in sections_data:
            continue
        text = sections_data[key]
        if isinstance(text, dict):
            text = text.get("text", "")
        if not text:
            continue
        doc.add_heading(format_section_title(key), level=1)
        doc.add_paragraph(text)

    filename = f"manuscript_{uuid.uuid4().hex[:8]}.docx"
    filepath = os.path.join("/tmp", filename)
    doc.save(filepath)
    return filepath


def export_to_latex(sections_data: dict, template_id: str = "exp_002") -> str:
    title = _escape_latex(sections_data.get("title", "Manuscript Draft"))
    lines = [
        r"\documentclass[11pt,a4paper]{article}",
        r"\usepackage[utf8]{inputenc}",
        r"\usepackage{authblk}",
        "",
        f"\\title{{{title}}}",
        "",
        r"\begin{document}",
        r"\maketitle",
        "",
    ]

    order = get_template_sections_order(template_id)
    if not order:
        order = [k for k in sections_data if k != "title"]

    for key in order:
        if key not in sections_data:
            continue
        text = sections_data[key]
        if isinstance(text, dict):
            text = text.get("text", "")
        if not text:
            continue
        sec_title = format_section_title(key)
        lines.append(f"\\section{{{sec_title}}}")
        lines.append(_escape_latex(text))
        lines.append("")

    lines.append(r"\end{document}")

    filename = f"manuscript_{uuid.uuid4().hex[:8]}.tex"
    filepath = os.path.join("/tmp", filename)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return filepath


def export_to_plain_text(sections_data: dict) -> str:
    title = sections_data.get("title", "Manuscript Draft")
    lines = [title.upper(), "=" * len(title), ""]

    for key, content in sections_data.items():
        if key == "title":
            continue
        text = content
        if isinstance(text, dict):
            text = text.get("text", "")
        if not text:
            continue
        heading = format_section_title(key).upper()
        lines += [heading, "-" * len(heading), text, ""]

    filename = f"manuscript_{uuid.uuid4().hex[:8]}.txt"
    filepath = os.path.join("/tmp", filename)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return filepath


def create_download_record(
    filepath: str, filename: str, user_id: str, template_id: str, sections: list
) -> dict:
    export_id = "exp_h" + uuid.uuid4().hex[:8]
    now = datetime.utcnow()
    expires_at = now + timedelta(days=7)

    record = {
        "export_id": export_id,
        "user_id": user_id,
        "template_id": template_id,
        "sections_exported": ",".join(sections),
        "filename": filename,
        "filepath": filepath,
        "created_at": now.strftime("%Y-%m-%d %H:%M:%S"),
        "download_count": "0",
        "expires_at": expires_at.strftime("%Y-%m-%d %H:%M:%S"),
    }

    df = _read_history()
    df = pd.concat([df, pd.DataFrame([record])], ignore_index=True)
    _write_history(df)

    return {
        "download_id": export_id,
        "expires_at": expires_at.strftime("%Y-%m-%d %H:%M"),
        "filename": filename,
        "download_url": f"/export/download/{export_id}",
    }


def get_user_export_history(user_id: str) -> list:
    df = _read_history()
    rows = df[df["user_id"] == user_id].to_dict(orient="records")
    now = datetime.utcnow()
    for r in rows:
        try:
            exp = datetime.strptime(r["expires_at"], "%Y-%m-%d %H:%M:%S")
            r["is_expired"] = exp < now
            r["expires_in_days"] = max(0, (exp - now).days)
        except Exception:
            r["is_expired"] = True
            r["expires_in_days"] = 0
    rows.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return rows


def get_export_record(export_id: str) -> dict | None:
    df = _read_history()
    row = df[df["export_id"] == export_id]
    return row.iloc[0].to_dict() if not row.empty else None


def increment_download_count(export_id: str) -> None:
    df = _read_history()
    mask = df["export_id"] == export_id
    if mask.any():
        current = int(df.loc[mask, "download_count"].iloc[0] or 0)
        df.loc[mask, "download_count"] = str(current + 1)
        _write_history(df)


def check_reader_rate_limit(user_id: str) -> bool:
    df = _read_history()
    today = datetime.utcnow().strftime("%Y-%m-%d")
    count = len(df[(df["user_id"] == user_id) & (df["created_at"].str.startswith(today))])
    return count < 5


def cleanup_expired_exports() -> int:
    df = _read_history()
    if df.empty:
        return 0
    now = datetime.utcnow()

    def _is_expired(val: str) -> bool:
        try:
            return datetime.strptime(val, "%Y-%m-%d %H:%M:%S") < now
        except Exception:
            return True

    expired_mask = df["expires_at"].apply(_is_expired)
    for _, row in df[expired_mask].iterrows():
        try:
            if os.path.exists(row["filepath"]):
                os.remove(row["filepath"])
        except Exception as e:
            logger.warning("Could not remove %s: %s", row.get("filepath"), e)

    removed = int(expired_mask.sum())
    _write_history(df[~expired_mask].reset_index(drop=True))
    return removed
