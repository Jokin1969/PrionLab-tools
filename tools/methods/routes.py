import logging

from flask import jsonify, render_template, request, session
from flask_babel import gettext as _

from core.decorators import editor_required, login_required
from . import methods_bp
from .models import build_protocols_data, combine_protocols, generate_protocol_text

logger = logging.getLogger(__name__)


@methods_bp.route("/")
@login_required
def index():
    protocols_data = build_protocols_data()
    can_generate = session.get("role") in ("admin", "editor")
    return render_template(
        "methods/index.html",
        protocols_data=protocols_data,
        can_generate=can_generate,
    )


@methods_bp.route("/api/generate-preview", methods=["POST"])
@login_required
def generate_preview():
    data = request.get_json(silent=True) or {}
    protocol_id = data.get("protocol_id", "")
    parameters  = data.get("parameters", {})

    if not protocol_id:
        return jsonify({"error": _("Protocol ID is required.")}), 400

    try:
        result = generate_protocol_text(protocol_id, parameters)
        return jsonify(result)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@methods_bp.route("/api/generate-section", methods=["POST"])
@editor_required
def generate_section():
    data = request.get_json(silent=True) or {}
    protocols_list = data.get("protocols", [])

    if not protocols_list:
        return jsonify({"error": _("Select at least one protocol.")}), 400

    texts: list[str] = []
    all_warnings: list[str] = []

    for item in protocols_list:
        pid    = item.get("protocol_id", "")
        params = item.get("parameters", {})
        if not pid:
            continue
        try:
            result = generate_protocol_text(pid, params)
            texts.append(result["protocol_text"])
            all_warnings.extend(result["warnings"])
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

    return jsonify({
        "methods_text": combine_protocols(texts),
        "warnings":     all_warnings,
    })
