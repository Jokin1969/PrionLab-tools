import logging

from flask import jsonify, render_template, request, session

from core.decorators import login_required
from tools.research import research_bp
from tools.research.models import (
    CitationManager,
    PublicationManager,
    bootstrap_research_schema,
    check_citation_rate_limit,
    check_publication_rate_limit,
    get_all_publications,
    get_available_references,
    get_publication,
    get_publication_statistics,
    get_relevant_lab_publications,
    import_references_section,
)

logger = logging.getLogger(__name__)


@research_bp.route("/")
@research_bp.route("/library")
@login_required
def library():
    stats = get_publication_statistics()
    return render_template("research/library.html", stats=stats)


# ── Publication endpoints ──────────────────────────────────────────────────────

@research_bp.route("/api/publications")
@login_required
def api_publications():
    filters = {
        "query":    request.args.get("q", ""),
        "journal":  request.args.get("journal", ""),
        "year":     request.args.get("year", ""),
        "pub_type": request.args.get("pub_type", ""),
    }
    pubs = get_all_publications(filters)
    return jsonify(pubs)


@research_bp.route("/api/publications/<pub_id>")
@login_required
def api_publication_detail(pub_id):
    pub = get_publication(pub_id)
    if not pub:
        return jsonify({"error": "Publication not found."}), 404
    return jsonify(pub)


@research_bp.route("/api/publications", methods=["POST"])
@login_required
def api_add_publication():
    user_id = session.get("username", "")
    role = session.get("role", "reader")
    if role == "reader" and not check_publication_rate_limit(user_id):
        return jsonify({"error": "Daily limit reached (10 publications/day for readers)."}), 429
    data = request.get_json(force=True) or {}
    result = PublicationManager.add_publication_manual(data, user_id)
    if not result["success"]:
        return jsonify(result), 400
    return jsonify(result), 201


@research_bp.route("/api/publications/doi", methods=["POST"])
@login_required
def api_add_by_doi():
    user_id = session.get("username", "")
    role = session.get("role", "reader")
    if role == "reader" and not check_publication_rate_limit(user_id):
        return jsonify({"error": "Daily limit reached (10 publications/day for readers)."}), 429
    data = request.get_json(force=True) or {}
    doi = data.get("doi", "").strip()
    if not doi:
        return jsonify({"error": "DOI is required."}), 400
    result = PublicationManager.add_publication_by_doi(doi, user_id)
    if not result["success"]:
        return jsonify(result), 400
    return jsonify(result), 201


@research_bp.route("/api/publications/pmid", methods=["POST"])
@login_required
def api_add_by_pmid():
    user_id = session.get("username", "")
    role = session.get("role", "reader")
    if role == "reader" and not check_publication_rate_limit(user_id):
        return jsonify({"error": "Daily limit reached (10 publications/day for readers)."}), 429
    data = request.get_json(force=True) or {}
    pmid = data.get("pmid", "").strip()
    if not pmid:
        return jsonify({"error": "PMID is required."}), 400
    result = PublicationManager.add_publication_by_pmid(pmid, user_id)
    if not result["success"]:
        return jsonify(result), 400
    return jsonify(result), 201


@research_bp.route("/api/publications/<pub_id>", methods=["DELETE"])
@login_required
def api_delete_publication(pub_id):
    user_id = session.get("username", "")
    role = session.get("role", "reader")
    success = PublicationManager.delete_publication(pub_id, user_id, role)
    if not success:
        return jsonify({"error": "Publication not found or access denied."}), 404
    return jsonify({"success": True, "message": "Publication deleted."})


# ── Statistics ─────────────────────────────────────────────────────────────────

@research_bp.route("/api/stats")
@login_required
def api_stats():
    return jsonify(get_publication_statistics())


# ── Citation endpoints ─────────────────────────────────────────────────────────

@research_bp.route("/api/citation-styles")
@login_required
def api_citation_styles():
    return jsonify(CitationManager.get_citation_styles())


@research_bp.route("/api/citations/format", methods=["POST"])
@login_required
def api_format_citation():
    user_id = session.get("username", "")
    role = session.get("role", "reader")
    if role == "reader" and not check_citation_rate_limit(user_id):
        return jsonify({"error": "Daily limit reached (20 citations/day for readers)."}), 429
    data = request.get_json(force=True) or {}
    pub_id = data.get("pub_id", "")
    style = data.get("style", "Vancouver")
    pub = get_publication(pub_id)
    if not pub:
        return jsonify({"error": "Publication not found."}), 404
    formatted = CitationManager.format_citation(pub, style)
    return jsonify({"formatted_citation": formatted, "style": style})


@research_bp.route("/api/citations/bibliography", methods=["POST"])
@login_required
def api_bibliography():
    user_id = session.get("username", "")
    role = session.get("role", "reader")
    if role == "reader" and not check_citation_rate_limit(user_id):
        return jsonify({"error": "Daily limit reached (20 citations/day for readers)."}), 429
    data = request.get_json(force=True) or {}
    pub_ids = data.get("pub_ids", [])
    style = data.get("style", "Vancouver")
    if not pub_ids:
        return jsonify({"error": "No publications selected."}), 400
    bibliography = CitationManager.generate_bibliography(pub_ids, style)
    return jsonify({"bibliography": bibliography, "count": len(pub_ids), "style": style})


@research_bp.route("/api/citations/save", methods=["POST"])
@login_required
def api_save_citation():
    user_id = session.get("username", "")
    role = session.get("role", "reader")
    if role == "reader" and not check_citation_rate_limit(user_id):
        return jsonify({"error": "Daily limit reached (20 citations/day for readers)."}), 429
    data = request.get_json(force=True) or {}
    result = CitationManager.save_citation(
        pub_id=data.get("pub_id", ""),
        manuscript_id=data.get("manuscript_id", ""),
        style=data.get("style", "Vancouver"),
        user_id=user_id,
    )
    if not result["success"]:
        return jsonify(result), 400
    return jsonify(result)


# ── Integration endpoints ──────────────────────────────────────────────────────

@research_bp.route("/api/relevant-publications")
@login_required
def api_relevant_publications():
    approach_id = request.args.get("approach_id", "")
    keywords = request.args.get("keywords", "")
    pubs = get_relevant_lab_publications(approach_id, keywords)
    return jsonify(pubs)


@research_bp.route("/api/available-references")
@login_required
def api_available_references():
    manuscript_id = request.args.get("manuscript_id", "")
    refs = get_available_references(manuscript_id)
    return jsonify(refs)


@research_bp.route("/api/import-references", methods=["POST"])
@login_required
def api_import_references():
    data = request.get_json(force=True) or {}
    pub_ids = data.get("pub_ids", [])
    style = data.get("style", "Vancouver")
    result = import_references_section(pub_ids, style)
    if not result["success"]:
        return jsonify(result), 400
    return jsonify(result)


# ── Analytics routes ───────────────────────────────────────────────────────────

@research_bp.route("/analytics")
@login_required
def analytics_page():
    return render_template("research/analytics.html")


@research_bp.route("/analytics/overview", methods=["POST"])
@login_required
def analytics_overview():
    from tools.research.analytics import ResearchAnalytics
    data = ResearchAnalytics().generate_overview_dashboard()
    if "error" in data:
        return jsonify({"success": False, "error": data["error"]}), 500
    return jsonify({"success": True, "overview": data})


@research_bp.route("/analytics/impact", methods=["POST"])
@login_required
def analytics_impact():
    from tools.research.analytics import ResearchAnalytics
    data = ResearchAnalytics().generate_impact_analysis()
    if "error" in data:
        return jsonify({"success": False, "error": data["error"]}), 500
    return jsonify({"success": True, "impact": data})


@research_bp.route("/analytics/collaboration", methods=["POST"])
@login_required
def analytics_collaboration():
    from tools.research.analytics import ResearchAnalytics
    data = ResearchAnalytics().generate_collaboration_network()
    if "error" in data:
        return jsonify({"success": False, "error": data["error"]}), 500
    return jsonify({"success": True, "collaboration": data})


@research_bp.route("/analytics/usage", methods=["POST"])
@login_required
def analytics_usage():
    from tools.research.analytics import ExportAnalytics
    days = (request.get_json(force=True) or {}).get("days", 30)
    data = ExportAnalytics().generate_usage_report(int(days))
    if "error" in data:
        return jsonify({"success": False, "error": data["error"]}), 500
    return jsonify({"success": True, "usage": data})


# ── Enhanced citation search / bibliography endpoints ──────────────────────────

@research_bp.route("/search-citations", methods=["POST"])
@login_required
def search_citations():
    data = request.get_json(force=True) or {}
    query = data.get("query", "")
    filters = data.get("filters", {})
    pubs = get_all_publications({"query": query})
    if filters.get("year_from"):
        try:
            yr = int(filters["year_from"])
            pubs = [p for p in pubs if int(p.get("year", 0) or 0) >= yr]
        except (ValueError, TypeError):
            pass
    result = [
        {
            "publication_id": p["pub_id"],
            "title": p.get("title", ""),
            "authors": p.get("author_string", ""),
            "journal": p.get("journal", ""),
            "year": p.get("year", ""),
            "citation_preview": CitationManager.format_citation(p, "Vancouver"),
            "is_lab_publication": True,
        }
        for p in pubs
    ]
    return jsonify({"success": True, "publications": result, "total_count": len(result)})


@research_bp.route("/preview-bibliography", methods=["POST"])
@login_required
def preview_bibliography():
    data = request.get_json(force=True) or {}
    pub_ids = data.get("publication_ids", [])
    style = data.get("style", "Vancouver")
    if not pub_ids:
        return jsonify({"success": False, "error": "No publications selected."}), 400
    bib_text = CitationManager.generate_bibliography(pub_ids, style)
    bib_lines = [{"citation": line.lstrip("0123456789. ")} for line in bib_text.split("\n") if line.strip()]
    return jsonify({"success": True, "bibliography": bib_lines, "style": style,
                    "total_references": len(bib_lines)})


@research_bp.route("/generate-bibliography", methods=["POST"])
@login_required
def generate_bibliography_download():
    user_id = session.get("username", "")
    role = session.get("role", "reader")
    if role == "reader" and not check_citation_rate_limit(user_id):
        return jsonify({"error": "Daily limit reached (20 citations/day for readers)."}), 429
    data = request.get_json(force=True) or {}
    pub_ids = data.get("publication_ids", [])
    style = data.get("style", "Vancouver")
    if not pub_ids:
        return jsonify({"success": False, "error": "No publications selected."}), 400
    bib_text = CitationManager.generate_bibliography(pub_ids, style)
    try:
        from tools.research.analytics import ExportAnalytics, USAGE_CSV, _USAGE_COLS
        ExportAnalytics().track_citation_export(user_id, "bibliography", len(pub_ids), style)
    except Exception:
        pass
    return jsonify({"success": True, "bibliography_text": bib_text,
                    "style": style, "total_references": len(pub_ids)})
