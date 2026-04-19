"""Reference API routes."""
import logging
from dataclasses import asdict

from flask import jsonify, request, session

from core.decorators import login_required
from . import references_bp
from .service import (
    delete_reference, generate_bibliography,
    get_citation_styles, get_references, import_bibtex, search_references,
)
from .smart_recommendations import get_smart_recommendation_engine
from .citation_network import get_citation_network_service
from .ai_core import get_core_ai_recommendation_engine
from .advanced_gaps import get_advanced_gap_detection_service
from .analytics_integration import get_analytics_integration_service

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


# ── Intelligence endpoints ────────────────────────────────────────────────────

@references_bp.route("/manuscript/<manuscript_id>/recommendations")
@login_required
def recommendations(manuscript_id):
    username = session.get("username", "")
    engine = get_smart_recommendation_engine()
    recs = engine.generate_recommendations(manuscript_id, username, limit=10)
    return jsonify({
        "success": True,
        "recommendations": [
            {
                "reference_id": r.reference_id,
                "title": r.title,
                "authors": r.authors,
                "journal": r.journal,
                "year": r.year,
                "doi": r.doi,
                "relevance_score": round(r.relevance_score, 4),
                "recommendation_type": r.recommendation_type,
                "explanation": r.explanation,
                "confidence": round(r.confidence, 3),
                "source_references": r.source_references,
            }
            for r in recs
        ],
        "count": len(recs),
    })


@references_bp.route("/manuscript/<manuscript_id>/gaps")
@login_required
def research_gaps(manuscript_id):
    username = session.get("username", "")
    engine = get_smart_recommendation_engine()
    gaps = engine.detect_research_gaps(manuscript_id, username)
    return jsonify({"success": True, "gaps": [asdict(g) for g in gaps], "count": len(gaps)})


@references_bp.route("/manuscript/<manuscript_id>/network")
@login_required
def citation_network(manuscript_id):
    return jsonify(get_citation_network_service().build_citation_network(manuscript_id))


@references_bp.route("/manuscript/<manuscript_id>/author-network")
@login_required
def author_network(manuscript_id):
    return jsonify(get_citation_network_service().get_author_influence_network(manuscript_id))


@references_bp.route("/manuscript/<manuscript_id>/landscape")
@login_required
def research_landscape(manuscript_id):
    return jsonify(get_citation_network_service().analyze_research_landscape(manuscript_id))


@references_bp.route("/manuscript/<manuscript_id>/ai-recommendations")
@login_required
def ai_recommendations(manuscript_id):
    username = session.get("username", "")
    limit = request.args.get("limit", 10, type=int)
    engine = get_core_ai_recommendation_engine()
    result = engine.generate_core_recommendations(manuscript_id, username, limit)
    # Apply analytics enhancement
    if result.get("recommendations"):
        svc = get_analytics_integration_service()
        result["recommendations"] = svc.enhance_recommendations(
            result["recommendations"], username
        )
    return jsonify(result)


@references_bp.route("/manuscript/<manuscript_id>/advanced-gaps")
@login_required
def advanced_gaps(manuscript_id):
    username = session.get("username", "")
    svc = get_advanced_gap_detection_service()
    result = svc.analyze_research_gaps(manuscript_id, username)
    return jsonify({
        "success": True,
        "gaps": [asdict(g) for g in result.gaps],
        "summary": result.summary,
        "recommendations": result.recommendations,
        "priority_actions": result.priority_actions,
        "count": len(result.gaps),
    })


@references_bp.route("/manuscript/<manuscript_id>/trends")
@login_required
def reference_trends(manuscript_id):
    username = session.get("username", "")
    svc = get_analytics_integration_service()
    return jsonify(svc.get_temporal_trends(manuscript_id))
