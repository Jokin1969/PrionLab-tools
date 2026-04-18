import logging
import os
import re
from datetime import datetime

from flask import jsonify, render_template, request, send_file, session

from core.decorators import login_required
from tools.export import export_bp
from tools.export.models import (
    check_reader_rate_limit,
    cleanup_expired_exports,
    create_download_record,
    export_to_latex,
    export_to_plain_text,
    export_to_word,
    get_export_record,
    get_export_template,
    get_export_templates,
    increment_download_count,
    get_user_export_history,
)

logger = logging.getLogger(__name__)


@export_bp.route("/composer")
@login_required
def composer():
    templates = get_export_templates()
    return render_template("export/composer.html", export_templates=templates)


@export_bp.route("/downloads")
@login_required
def downloads():
    user_id = session.get("username", "")
    exports = get_user_export_history(user_id)
    return render_template("export/download.html", exports=exports)


@export_bp.route("/section/<section_type>", methods=["POST"])
@login_required
def export_section(section_type):
    user_id = session.get("username", "")
    role = session.get("role", "reader")

    if role == "reader" and not check_reader_rate_limit(user_id):
        return jsonify({"error": "Daily export limit reached (5 per day for readers)."}), 429

    text = request.form.get("text", "").strip()
    format_type = request.form.get("format", "docx")
    template_id = request.form.get("template_id", "exp_001")

    if not text:
        return jsonify({"error": "No content to export."}), 400

    safe_key = re.sub(r"[^\w]", "_", section_type)[:40]
    sections_data = {
        "title": "Manuscript Draft",
        safe_key: text,
    }

    try:
        if format_type == "latex":
            filepath = export_to_latex(sections_data, "exp_002")
            ext = "tex"
        elif format_type == "txt":
            filepath = export_to_plain_text(sections_data)
            ext = "txt"
        else:
            filepath = export_to_word(sections_data, template_id)
            ext = "docx"

        filename = f"{safe_key}.{ext}"
        info = create_download_record(filepath, filename, user_id, template_id, [safe_key])
        return jsonify(info)
    except Exception as e:
        logger.error("Export section failed: %s", e)
        return jsonify({"error": "Export failed. Please try again."}), 500


@export_bp.route("/manuscript", methods=["POST"])
@login_required
def export_manuscript():
    user_id = session.get("username", "")
    role = session.get("role", "reader")

    if role == "reader" and not check_reader_rate_limit(user_id):
        return jsonify({"error": "Daily export limit reached (5 per day for readers)."}), 429

    data = request.get_json(force=True) or {}
    sections_text = data.get("sections_text", {})
    template_id = data.get("template_id", "exp_001")
    title = (data.get("title") or "Manuscript Draft").strip()
    sections_order = data.get("sections_order") or list(sections_text.keys())

    if not sections_text:
        return jsonify({"error": "No sections selected."}), 400

    sections_data = {"title": title}
    for key in sections_order:
        if key in sections_text and sections_text[key]:
            sections_data[key] = sections_text[key]

    if len(sections_data) <= 1:
        return jsonify({"error": "No generated content found for the selected sections."}), 400

    try:
        tmpl = get_export_template(template_id)
        fmt = tmpl["format"] if tmpl else "docx"
        safe_title = re.sub(r"[^\w\s-]", "", title).strip().replace(" ", "_")[:40] or "manuscript"

        if fmt == "latex":
            filepath = export_to_latex(sections_data, template_id)
            filename = f"{safe_title}.tex"
        else:
            filepath = export_to_word(sections_data, template_id)
            filename = f"{safe_title}.docx"

        sections = [k for k in sections_order if k in sections_text and sections_text[k]]
        info = create_download_record(filepath, filename, user_id, template_id, sections)
        return jsonify(info)
    except Exception as e:
        logger.error("Manuscript export failed: %s", e)
        return jsonify({"error": "Export failed. Please try again."}), 500


@export_bp.route("/download/<export_id>")
@login_required
def download_file(export_id):
    record = get_export_record(export_id)
    if not record:
        return "Download not found.", 404

    try:
        expires = datetime.strptime(record["expires_at"], "%Y-%m-%d %H:%M:%S")
        if datetime.utcnow() > expires:
            return "Download link has expired.", 410
    except Exception:
        return "Download not found.", 404

    filepath = record.get("filepath", "")
    if not os.path.exists(filepath):
        return "File is no longer available.", 404

    increment_download_count(export_id)
    return send_file(filepath, as_attachment=True, download_name=record["filename"])


@export_bp.route("/cleanup", methods=["POST"])
@login_required
def cleanup():
    removed = cleanup_expired_exports()
    return jsonify({"removed": removed, "message": f"Removed {removed} expired export(s)."})
