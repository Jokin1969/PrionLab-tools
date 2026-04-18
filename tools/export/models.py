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

# ── Journal templates ─────────────────────────────────────────────────────────

JOURNAL_TEMPLATES_CSV = os.path.join(config.CSV_DIR, "journal_templates.csv")
EXPORT_JOBS_CSV = os.path.join(config.CSV_DIR, "export_jobs.csv")

JOURNAL_TEMPLATES_COLS = [
    "template_id", "journal_name", "publisher", "format", "font_family",
    "font_size", "line_spacing", "margin_top", "margin_bottom",
    "margin_left", "margin_right", "reference_style", "author_format",
    "affiliation_format", "abstract_limit", "keywords_required",
    "competing_interests_format", "funding_format",
    "sections_order", "special_requirements",
]
EXPORT_JOBS_COLS = [
    "job_id", "user_id", "export_type", "status", "template_id",
    "created_at", "completed_at", "file_paths", "error_message",
]

_SEED_JOURNAL_TEMPLATES = [
    {
        "template_id": "jnl_001", "journal_name": "Nature", "publisher": "Springer Nature",
        "format": "double_column", "font_family": "Arial", "font_size": "11",
        "line_spacing": "1.5", "margin_top": "25mm", "margin_bottom": "25mm",
        "margin_left": "20mm", "margin_right": "20mm", "reference_style": "Nature",
        "author_format": "Last F.M.", "affiliation_format": "superscript_numbers",
        "abstract_limit": "150", "keywords_required": "true",
        "competing_interests_format": "Required section",
        "funding_format": "Grant funding required",
        "sections_order": "author_order,methods,acknowledgments,funding,credit,competing_interests",
        "special_requirements": "Methods can be supplementary",
    },
    {
        "template_id": "jnl_002", "journal_name": "Cell", "publisher": "Cell Press",
        "format": "single_column", "font_family": "Times New Roman", "font_size": "12",
        "line_spacing": "2.0", "margin_top": "25mm", "margin_bottom": "25mm",
        "margin_left": "25mm", "margin_right": "25mm", "reference_style": "Cell",
        "author_format": "Last F.M.", "affiliation_format": "numbered_footnotes",
        "abstract_limit": "200", "keywords_required": "true",
        "competing_interests_format": "Declaration section",
        "funding_format": "Detailed funding",
        "sections_order": "author_order,methods,acknowledgments,funding,credit,competing_interests",
        "special_requirements": "Significance statement required",
    },
    {
        "template_id": "jnl_003", "journal_name": "PLOS ONE", "publisher": "PLOS",
        "format": "single_column", "font_family": "Arial", "font_size": "11",
        "line_spacing": "1.5", "margin_top": "25mm", "margin_bottom": "25mm",
        "margin_left": "25mm", "margin_right": "25mm", "reference_style": "PLOS",
        "author_format": "Last FM", "affiliation_format": "affiliation_list",
        "abstract_limit": "300", "keywords_required": "false",
        "competing_interests_format": "Competing interests section",
        "funding_format": "Funding information",
        "sections_order": "author_order,methods,acknowledgments,funding,credit,competing_interests",
        "special_requirements": "Open access format",
    },
    {
        "template_id": "jnl_004", "journal_name": "Science", "publisher": "AAAS",
        "format": "double_column", "font_family": "Times New Roman", "font_size": "10",
        "line_spacing": "1.0", "margin_top": "20mm", "margin_bottom": "20mm",
        "margin_left": "15mm", "margin_right": "15mm", "reference_style": "Science",
        "author_format": "F.M. Last", "affiliation_format": "superscript",
        "abstract_limit": "120", "keywords_required": "false",
        "competing_interests_format": "No specific section",
        "funding_format": "Grant acknowledgment",
        "sections_order": "author_order,methods,acknowledgments,funding,credit,competing_interests",
        "special_requirements": "Very concise format",
    },
]


def _read_journal_templates() -> pd.DataFrame:
    if not os.path.exists(JOURNAL_TEMPLATES_CSV):
        return pd.DataFrame(columns=JOURNAL_TEMPLATES_COLS)
    return pd.read_csv(JOURNAL_TEMPLATES_CSV, dtype=str).fillna("")


def _read_export_jobs() -> pd.DataFrame:
    if not os.path.exists(EXPORT_JOBS_CSV):
        return pd.DataFrame(columns=EXPORT_JOBS_COLS)
    return pd.read_csv(EXPORT_JOBS_CSV, dtype=str).fillna("")


def _write_export_jobs(df: pd.DataFrame) -> None:
    df.to_csv(EXPORT_JOBS_CSV, index=False, quoting=csv.QUOTE_ALL)


def _seed_journal_templates_if_empty() -> None:
    if os.path.exists(JOURNAL_TEMPLATES_CSV):
        try:
            if not pd.read_csv(JOURNAL_TEMPLATES_CSV, dtype=str).empty:
                return
        except Exception:
            pass
    pd.DataFrame(_SEED_JOURNAL_TEMPLATES).to_csv(
        JOURNAL_TEMPLATES_CSV, index=False, quoting=csv.QUOTE_ALL
    )
    logger.info("Journal templates seeded.")


def _seed_export_jobs_if_empty() -> None:
    if not os.path.exists(EXPORT_JOBS_CSV):
        pd.DataFrame(columns=EXPORT_JOBS_COLS).to_csv(
            EXPORT_JOBS_CSV, index=False, quoting=csv.QUOTE_ALL
        )


def get_journal_templates() -> list:
    return _read_journal_templates().to_dict(orient="records")


def get_journal_template(template_id: str) -> dict | None:
    df = _read_journal_templates()
    row = df[df["template_id"] == template_id]
    return row.iloc[0].to_dict() if not row.empty else None


# ── Export jobs ───────────────────────────────────────────────────────────────

def create_export_job(job_id: str, user_id: str, export_type: str, template_id: str) -> None:
    record = {
        "job_id": job_id, "user_id": user_id, "export_type": export_type,
        "status": "running", "template_id": template_id,
        "created_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        "completed_at": "", "file_paths": "", "error_message": "",
    }
    df = _read_export_jobs()
    df = pd.concat([df, pd.DataFrame([record])], ignore_index=True)
    _write_export_jobs(df)


def complete_export_job(job_id: str, file_paths: dict) -> None:
    df = _read_export_jobs()
    mask = df["job_id"] == job_id
    if mask.any():
        df.loc[mask, "status"] = "completed"
        df.loc[mask, "completed_at"] = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        df.loc[mask, "file_paths"] = str(file_paths)
        _write_export_jobs(df)


def error_export_job(job_id: str, error_msg: str) -> None:
    df = _read_export_jobs()
    mask = df["job_id"] == job_id
    if mask.any():
        df.loc[mask, "status"] = "error"
        df.loc[mask, "error_message"] = error_msg[:500]
        _write_export_jobs(df)


# ── PDF / HTML generation ─────────────────────────────────────────────────────

import html as _html_lib


def _safe_html(text: str) -> str:
    return _html_lib.escape(str(text or "")).replace("\n", "<br/>")


def get_default_pdf_styles() -> str:
    return """
        @page { size: A4; margin: 25mm; }
        body { font-family: 'Times New Roman', serif; font-size: 12pt;
               line-height: 1.5; color: #000; }
        h1 { font-size: 16pt; font-weight: bold; margin: 20pt 0 10pt; }
        h2 { font-size: 13pt; font-weight: bold; margin: 14pt 0 7pt; }
        p { margin: 8pt 0; text-align: justify; }
        .section-block { margin-bottom: 14pt; }
    """


def get_journal_css(template_id: str) -> str:
    tmpl = get_journal_template(template_id)
    if not tmpl:
        return get_default_pdf_styles()

    font = tmpl.get("font_family", "Times New Roman")
    size = tmpl.get("font_size", "12")
    spacing = tmpl.get("line_spacing", "1.5")
    mt = tmpl.get("margin_top", "25mm")
    mb = tmpl.get("margin_bottom", "25mm")
    ml = tmpl.get("margin_left", "25mm")
    mr = tmpl.get("margin_right", "25mm")

    css = f"""
        @page {{ size: A4; margin: {mt} {mr} {mb} {ml}; }}
        body {{ font-family: '{font}', serif; font-size: {size}pt;
               line-height: {spacing}; color: #000; }}
        h1 {{ font-size: calc({size}pt + 4pt); font-weight: bold;
              margin: 18pt 0 9pt; }}
        h2 {{ font-size: calc({size}pt + 2pt); font-weight: bold;
              margin: 13pt 0 6pt; }}
        p {{ margin: 7pt 0; text-align: justify; }}
        .section-block {{ margin-bottom: 12pt; }}
    """

    jname = tmpl.get("journal_name", "")
    if jname == "Nature":
        css += """
        h1 { text-align: center; }
        .author-block { text-align: center; font-size: 10pt; margin: 6pt 0; }
        .methods-block { font-size: 10pt; }
        """
    elif jname == "Cell":
        css += """
        .competing-block {
            background: #f5f5f5; padding: 8pt; margin: 10pt 0;
            border-left: 3pt solid #0077b6;
        }
        """
    elif jname == "PLOS ONE":
        css += """
        .competing-block { background: #fffacd; padding: 7pt; margin: 9pt 0; }
        .funding-block { background: #f0fff0; padding: 7pt; margin: 9pt 0; }
        """
    elif jname == "Science":
        css += """
        body { font-size: 9pt; }
        h1 { font-size: 12pt; }
        h2 { font-size: 10pt; }
        """

    return css


def export_to_html(sections_data: dict, template_id: str = "jnl_001") -> str:
    tmpl = get_journal_template(template_id)
    jname = tmpl["journal_name"] if tmpl else "Generic"
    order = get_template_sections_order(template_id)
    if not order:
        order = [k for k in sections_data if k != "title"]

    parts = [f'<div class="manuscript"><h1 class="doc-title">{_safe_html(sections_data.get("title", "Manuscript Draft"))}</h1>']

    _section_headings = {
        "author_order": "Authors &amp; Affiliations",
        "methods": "Materials and Methods",
        "funding": "Funding",
        "acknowledgments": "Acknowledgments",
        "credit": "Author Contributions",
        "competing_interests": "Competing Interests",
    }
    _section_classes = {
        "author_order": "author-block",
        "methods": "methods-block",
        "funding": "funding-block",
        "acknowledgments": "ack-block",
        "credit": "credit-block",
        "competing_interests": "competing-block",
    }

    for key in order:
        if key not in sections_data or not sections_data[key]:
            continue
        text = sections_data[key]
        if isinstance(text, dict):
            text = text.get("text", "")
        if not text:
            continue
        heading = _section_headings.get(key, format_section_title(key))
        cls = _section_classes.get(key, "section-block")
        parts.append(f'<h2>{heading}</h2><div class="{cls} section-block"><p>{_safe_html(text)}</p></div>')

    parts.append("</div>")
    return "\n".join(parts)


def generate_pdf_weasyprint(sections_data: dict, template_id: str = "jnl_001") -> str:
    try:
        import weasyprint
    except ImportError:
        raise RuntimeError("WeasyPrint is not installed. Install it with: pip install weasyprint")

    html_body = export_to_html(sections_data, template_id)
    css = get_journal_css(template_id)
    tmpl = get_journal_template(template_id)
    jname = tmpl["journal_name"] if tmpl else "Manuscript"

    full_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>{_safe_html(sections_data.get('title', 'Manuscript'))}</title>
<style>{css}</style>
</head>
<body>
<div class="journal-label" style="font-size:8pt;color:#666;margin-bottom:16pt">
  Formatted for: <strong>{_safe_html(jname)}</strong>
</div>
{html_body}
</body>
</html>"""

    pdf_bytes = weasyprint.HTML(string=full_html).write_pdf()
    filename = f"manuscript_{uuid.uuid4().hex[:8]}.pdf"
    filepath = os.path.join("/tmp", filename)
    with open(filepath, "wb") as f:
        f.write(pdf_bytes)
    return filepath


# ── Journal requirements validation ──────────────────────────────────────────

_JOURNAL_REQUIRED: dict[str, list] = {
    "jnl_001": ["author_order", "methods", "acknowledgments", "competing_interests"],
    "jnl_002": ["author_order", "methods", "acknowledgments", "credit", "competing_interests"],
    "jnl_003": ["author_order", "methods", "competing_interests"],
    "jnl_004": ["author_order", "methods", "acknowledgments"],
}
_JOURNAL_RECOMMENDED: dict[str, list] = {
    "jnl_001": ["funding", "credit"],
    "jnl_002": ["funding"],
    "jnl_003": ["funding", "credit", "acknowledgments"],
    "jnl_004": ["funding", "competing_interests"],
}

_SECTION_NAMES = {
    "author_order": "Author Order & Affiliations",
    "methods": "Materials and Methods",
    "funding": "Funding",
    "acknowledgments": "Acknowledgments",
    "credit": "Author Contributions (CRediT)",
    "competing_interests": "Competing Interests",
}


def validate_journal_requirements(present_sections: list, template_id: str) -> list:
    tmpl = get_journal_template(template_id)
    if not tmpl:
        return [{"status": "fail", "message": f"Unknown template: {template_id}"}]

    results = []
    jname = tmpl.get("journal_name", template_id)
    results.append({
        "status": "info",
        "message": f"Validating for {jname} ({tmpl.get('publisher', '')})",
    })

    required = _JOURNAL_REQUIRED.get(template_id, [])
    recommended = _JOURNAL_RECOMMENDED.get(template_id, [])

    for sec in required:
        name = _SECTION_NAMES.get(sec, sec)
        if sec in present_sections:
            results.append({"status": "pass", "message": f"{name}: present (required)"})
        else:
            results.append({"status": "fail", "message": f"{name}: MISSING (required for {jname})"})

    for sec in recommended:
        name = _SECTION_NAMES.get(sec, sec)
        if sec in present_sections:
            results.append({"status": "pass", "message": f"{name}: present (recommended)"})
        else:
            results.append({"status": "warning", "message": f"{name}: missing (recommended for {jname})"})

    kw_req = tmpl.get("keywords_required", "false").lower() == "true"
    if kw_req:
        results.append({"status": "warning", "message": f"{jname} requires Keywords — add them manually to the final manuscript."})

    abstract_limit = tmpl.get("abstract_limit", "")
    if abstract_limit:
        results.append({"status": "info", "message": f"Abstract word limit: {abstract_limit} words."})

    special = tmpl.get("special_requirements", "").strip()
    if special and special.lower() not in ("", "null"):
        results.append({"status": "info", "message": f"Special: {special}"})

    return results


# ── Updated bootstrap ─────────────────────────────────────────────────────────

def _original_bootstrap():
    pass  # placeholder reference


_orig_bootstrap = bootstrap_export_schema


def bootstrap_export_schema() -> None:
    _orig_bootstrap()
    _seed_journal_templates_if_empty()
    _seed_export_jobs_if_empty()


# ── APScheduler integration ───────────────────────────────────────────────────

_scheduler = None


def init_scheduler(app) -> None:
    global _scheduler
    if _scheduler is not None:
        return

    try:
        from apscheduler.schedulers.background import BackgroundScheduler
        import atexit

        _scheduler = BackgroundScheduler(daemon=True)

        def _cleanup_job():
            with app.app_context():
                try:
                    removed = cleanup_expired_exports()
                    logger.info("Scheduler: cleaned %d expired exports", removed)
                except Exception as e:
                    logger.error("Scheduler cleanup error: %s", e)

        def _cloud_backup_job():
            logger.info("Scheduler: cloud backup job triggered (Google Drive placeholder)")

        _scheduler.add_job(
            func=_cleanup_job,
            trigger="interval",
            hours=6,
            id="cleanup_exports",
            replace_existing=True,
        )
        _scheduler.add_job(
            func=_cloud_backup_job,
            trigger="interval",
            hours=24,
            id="cloud_backup",
            replace_existing=True,
        )
        _scheduler.start()
        atexit.register(lambda: _scheduler.shutdown(wait=False))
        logger.info("Background scheduler started (cleanup every 6h, backup every 24h)")
    except Exception as e:
        logger.warning("Could not start background scheduler: %s", e)
