"""Reference API routes."""
import logging

from flask import jsonify, request, session

from core.decorators import login_required
from . import references_bp
from .service import (
    delete_reference, generate_bibliography,
    get_citation_styles, get_references, import_bibtex, search_references,
)

logger = logging.getLogger(__name__)


@references_bp.route("/import/bibtex", methods=["POST"])
@login_required
def import_bibtex_route():
    username = session.get("username", "")
    manuscript_id = request.form.get("manuscript_id", "")
    if not manuscript_id:
        return jsonify({"success": False, "error": "manuscript_id required"}), 400
    if "file" not in request.files:
        return jsonify({"success": False, "error": "No file uploaded"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"success": False, "error": "No file selected"}), 400
    try:
        content = f.read().decode("utf-8")
    except UnicodeDecodeError:
        try:
            f.seek(0)
            content = f.read().decode("latin-1")
        except Exception:
            return jsonify({"success": False, "error": "Unable to decode file; use UTF-8"}), 400
    result = import_bibtex(content, manuscript_id, username)
    return jsonify(result), 200 if result.get("success") else 400


@references_bp.route("/manuscript/<manuscript_id>")
@login_required
def get_refs(manuscript_id):
    area = request.args.get("research_area", "")
    entry_type = request.args.get("entry_type", "")
    try:
        year_from = int(request.args.get("year_from", 0))
        year_to = int(request.args.get("year_to", 0))
    except (ValueError, TypeError):
        year_from = year_to = 0
    refs = get_references(manuscript_id, area, year_from, year_to, entry_type)
    return jsonify({"success": True, "references": refs, "count": len(refs)})


@references_bp.route("/manuscript/<manuscript_id>/search")
@login_required
def search_refs(manuscript_id):
    query = request.args.get("q", "")
    results = search_references(manuscript_id, query)
    return jsonify({"success": True, "results": results, "count": len(results), "query": query})


@references_bp.route("/manuscript/<manuscript_id>/bibliography", methods=["POST"])
@login_required
def bibliography(manuscript_id):
    data = request.get_json(silent=True) or {}
    style = data.get("citation_style", "nature")
    selected = data.get("selected_references") or None
    result = generate_bibliography(manuscript_id, style, selected)
    return jsonify(result), 200 if result.get("success") else 400


@references_bp.route("/<reference_id>", methods=["DELETE"])
@login_required
def delete_ref(reference_id):
    username = session.get("username", "")
    result = delete_reference(reference_id, username)
    return jsonify(result), 200 if result.get("success") else 400


@references_bp.route("/styles")
@login_required
def styles():
    return jsonify({"success": True, "citation_styles": get_citation_styles()})
