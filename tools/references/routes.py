"""Reference API routes."""
import logging
from dataclasses import asdict

import json
from flask import jsonify, make_response, request, session

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


@references_bp.route("/manuscript/<manuscript_id>/collaboration")
@login_required
def collaboration_network(manuscript_id):
    return jsonify(get_citation_network_service().build_collaboration_network(manuscript_id))


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


@references_bp.route("/manuscript/<manuscript_id>/export-network")
@login_required
def export_network(manuscript_id):
    fmt = request.args.get("format", "json")
    data = get_citation_network_service().build_citation_network(manuscript_id)
    if fmt == "csv":
        import io, csv as _csv
        buf = io.StringIO()
        w = _csv.writer(buf)
        w.writerow(["id", "title", "authors", "journal", "year", "doi",
                    "research_area", "degree", "cluster_id"])
        for n in data.get("nodes", []):
            w.writerow([
                n.get("id", ""), n.get("title", ""),
                "; ".join(n.get("authors") or []),
                n.get("journal", ""), n.get("year", ""),
                n.get("doi", ""), n.get("research_area", ""),
                n.get("degree", 0), n.get("cluster_id", ""),
            ])
        resp = make_response(buf.getvalue())
        resp.headers["Content-Type"] = "text/csv"
        resp.headers["Content-Disposition"] = (
            f"attachment; filename=network-{manuscript_id}.csv"
        )
        return resp
    # JSON
    resp = make_response(json.dumps(data, indent=2))
    resp.headers["Content-Type"] = "application/json"
    resp.headers["Content-Disposition"] = (
        f"attachment; filename=network-{manuscript_id}.json"
    )
    return resp


# ── Feedback learning endpoints ───────────────────────────────────────────────

@references_bp.route("/feedback", methods=["POST"])
@login_required
def record_feedback():
    """Record user interaction with a recommendation."""
    from .feedback_learning import get_feedback_learning_service
    username = session.get("username", "")
    data = request.get_json(silent=True) or {}
    svc = get_feedback_learning_service()
    ok = svc.record_feedback(
        username=username,
        rec_type=data.get("rec_type", "content"),
        ref_id=data.get("ref_id", ""),
        ms_id=data.get("ms_id", ""),
        action=data.get("action", "click"),
        journal=data.get("journal", ""),
        year=int(data.get("year") or 0),
    )
    return jsonify({"success": ok})


@references_bp.route("/manuscript/<manuscript_id>/adaptive-weights")
@login_required
def adaptive_weights(manuscript_id):
    """Get personalized algorithm weights for this user."""
    from .feedback_learning import get_feedback_learning_service
    username = session.get("username", "")
    svc = get_feedback_learning_service()
    weights = svc.get_adaptive_weights(username)
    return jsonify({"success": True, "username": username, "weights": weights})


@references_bp.route("/feedback/patterns")
@login_required
def feedback_patterns():
    """Surface feedback patterns for the current user (or global)."""
    from .feedback_learning import get_feedback_learning_service
    username = session.get("username", "")
    scope = request.args.get("scope", "user")
    svc = get_feedback_learning_service()
    patterns = svc.analyze_patterns(username if scope == "user" else None)
    return jsonify({"success": True, "patterns": patterns, "count": len(patterns)})


@references_bp.route("/feedback/stats")
@login_required
def feedback_stats():
    """Overall feedback system statistics (admin-useful)."""
    from .feedback_learning import get_feedback_learning_service
    svc = get_feedback_learning_service()
    return jsonify({"success": True, **svc.get_stats()})
