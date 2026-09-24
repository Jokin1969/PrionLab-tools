"""Glossary management routes for PrionVault.

Core term CRUD/import/export/version + the read-only "public" API meant
for other tools (ManuscriptForge, PrionPacks, etc.) to consume later.

Everything about retroactively reconciling/"improving" already-generated
summaries against the glossary (batch improve, unreviewed/outdated
tracking, improvement log, cost estimates, debug/test pages) was removed:
all AI summaries have since been regenerated from scratch using the
current glossary, and every new/regenerated summary already records which
glossary version produced it via articles.ai_summary_glossary_version —
so that reconciliation machinery no longer has a use case.

Routes registered as side-effect import at bottom of routes.py.
"""
import logging

from flask import jsonify, request

from core.decorators import admin_required, login_required
from . import prionvault_bp

logger = logging.getLogger(__name__)


# ── Glossary term operations ───────────────────────────────────────────────
@prionvault_bp.route("/api/glossary/terms", methods=["GET"])
@login_required
def api_glossary_terms():
    """Get all glossary terms, optionally filtered by category."""
    from .services import glossary_manager

    category = request.args.get("category", "")

    try:
        terms = glossary_manager.get_all_terms(category=category if category else None)
        return jsonify({
            "terms": terms,
            "count": len(terms),
        })
    except Exception as e:
        logger.exception("Failed to fetch glossary terms")
        return jsonify({"error": str(e)[:300]}), 500


@prionvault_bp.route("/api/glossary/term", methods=["PUT"])
@admin_required
def api_glossary_update_term():
    """Update a glossary term in-place."""
    from .services import glossary_manager

    data = request.get_json(force=True, silent=True) or {}
    term_en = (data.get("term_en") or "").strip().lower()
    term_es = (data.get("term_es_recommended") or "").strip()
    avoid = (data.get("term_es_avoid") or "").strip() or None
    notes = (data.get("notes") or "").strip() or None
    category = (data.get("category") or "").strip() or None
    # Terms live under a specific version row (see glossary_manager's
    # append-only, full-snapshot-per-version model) — default to the
    # CURRENT version, not a hardcoded 1, or this silently no-ops once
    # the glossary has been edited/imported past version 1.
    version = data.get("version") or glossary_manager.get_current_glossary_version()

    if not term_en or not term_es:
        return jsonify({"error": "term_en and term_es_recommended are required"}), 400

    try:
        result = glossary_manager.update_term(
            term_en=term_en,
            term_es_recommended=term_es,
            term_es_avoid=avoid,
            notes=notes,
            category=category,
            version=version
        )
        if not result:
            return jsonify({"error": "Term not found in current glossary version"}), 404
        return jsonify({"ok": True, "updated": result})
    except Exception as e:
        logger.exception("Failed to update glossary term")
        return jsonify({"error": str(e)[:300]}), 500


@prionvault_bp.route("/api/glossary/term", methods=["DELETE"])
@admin_required
def api_glossary_delete_term():
    """Delete a glossary term."""
    from .services import glossary_manager

    term_en = (request.args.get("term_en") or "").strip().lower()
    if not term_en:
        return jsonify({"error": "term_en is required"}), 400

    try:
        deleted = glossary_manager.delete_term(term_en)
        if not deleted:
            return jsonify({"error": "Term not found"}), 404
        return jsonify({"ok": True})
    except Exception as e:
        logger.exception("Failed to delete glossary term")
        return jsonify({"error": str(e)[:300]}), 500


@prionvault_bp.route("/api/glossary/categories", methods=["GET"])
@login_required
def api_glossary_categories():
    """Get all glossary categories."""
    from .services import glossary_manager

    try:
        categories = glossary_manager.get_categories()
        return jsonify({
            "categories": categories,
            "count": len(categories),
        })
    except Exception as e:
        logger.exception("Failed to fetch categories")
        return jsonify({"error": str(e)[:300]}), 500


@prionvault_bp.route("/api/glossary/version", methods=["GET"])
@login_required
def api_glossary_version():
    """Get current glossary version."""
    from .services import glossary_manager

    try:
        version = glossary_manager.get_current_glossary_version()
        return jsonify({"version": version})
    except Exception as e:
        logger.exception("Failed to fetch glossary version")
        return jsonify({"error": str(e)[:300]}), 500


@prionvault_bp.route("/api/glossary/import", methods=["POST"])
@admin_required
def api_glossary_import():
    """Import glossary terms from JSON or TSV.

    Accepts either:
    - JSON: {"terms": [{...}, ...]}
    - TSV: {"tsv_content": "English\\tCastellano...\\n..."}
    """
    from .services import glossary_manager

    data = request.get_json(force=True, silent=True) or {}

    # Try JSON format first
    terms = data.get("terms", [])
    if terms and isinstance(terms, list):
        try:
            result = glossary_manager.import_glossary(terms)
            return jsonify(result.__dict__ if hasattr(result, '__dict__') else result)
        except Exception as e:
            logger.exception("Glossary import failed")
            return jsonify({"error": str(e)[:300]}), 500

    # Try TSV format
    tsv_content = data.get("tsv_content", "")
    if tsv_content:
        try:
            # Validate first
            is_valid, errors, preview_rows = glossary_manager.validate_tsv_format(tsv_content)
            if not is_valid:
                return jsonify({"error": "TSV validation failed", "details": errors}), 400

            # Parse and import
            terms = glossary_manager.parse_tsv_to_terms(tsv_content)
            result = glossary_manager.import_glossary(terms)
            return jsonify(result.__dict__ if hasattr(result, '__dict__') else result)
        except Exception as e:
            logger.exception("TSV import failed")
            return jsonify({"error": str(e)[:300]}), 500

    return jsonify({"error": "Either 'terms' (JSON) or 'tsv_content' (TSV) is required"}), 400


# ── Public glossary API (for other modules: PrionRead, PrionPacks, etc.) ─────
@prionvault_bp.route("/api/glossary/public/version", methods=["GET"])
@login_required
def api_glossary_public_version():
    """Get current glossary version (public API for other modules)."""
    from .services import glossary_manager
    try:
        version = glossary_manager.get_current_glossary_version()
        return jsonify({"version": version})
    except Exception as e:
        logger.exception("Failed to fetch glossary version")
        return jsonify({"error": str(e)[:300]}), 500


@prionvault_bp.route("/api/glossary/public/terms", methods=["GET"])
@login_required
def api_glossary_public_terms():
    """Get all glossary terms (public API for other modules).

    Optional query params:
    - category: Filter by category
    - limit: Max results (default 1000)
    - offset: Pagination offset (default 0)
    """
    from .services import glossary_manager

    try:
        category = request.args.get("category", "").strip() or None
        limit = min(int(request.args.get("limit", 1000)), 5000)
        offset = int(request.args.get("offset", 0))

        terms = glossary_manager.get_all_terms(category=category)
        total = len(terms)
        paginated = terms[offset:offset + limit]

        return jsonify({
            "version": glossary_manager.get_current_glossary_version(),
            "total": total,
            "returned": len(paginated),
            "offset": offset,
            "limit": limit,
            "terms": [
                {
                    "term_en": t.get("term_en", "").lower(),
                    "term_es_recommended": t.get("term_es_recommended", ""),
                    "term_es_avoid": t.get("term_es_avoid"),
                    "category": t.get("category"),
                    "notes": t.get("notes"),
                }
                for t in paginated
            ]
        })
    except Exception as e:
        logger.exception("Failed to fetch glossary terms")
        return jsonify({"error": str(e)[:300]}), 500


@prionvault_bp.route("/api/glossary/public/search", methods=["GET"])
@login_required
def api_glossary_public_search():
    """Search glossary terms by English or Spanish (public API).

    Query params:
    - q: Search query (required)
    - limit: Max results (default 50)
    """
    from .services import glossary_manager

    try:
        query = request.args.get("q", "").strip().lower()
        if not query:
            return jsonify({"error": "Missing 'q' parameter"}), 400

        limit = min(int(request.args.get("limit", 50)), 500)

        all_terms = glossary_manager.get_all_terms()
        matches = []

        for term in all_terms:
            term_en = (term.get("term_en") or "").lower()
            term_es = (term.get("term_es_recommended") or "").lower()
            avoid = (term.get("term_es_avoid") or "").lower()

            # Simple substring match (can be improved with fuzzy matching)
            if query in term_en or query in term_es or (avoid and query in avoid):
                matches.append({
                    "term_en": term.get("term_en", ""),
                    "term_es_recommended": term.get("term_es_recommended", ""),
                    "term_es_avoid": term.get("term_es_avoid"),
                    "category": term.get("category"),
                    "notes": term.get("notes"),
                })

            if len(matches) >= limit:
                break

        return jsonify({
            "query": query,
            "found": len(matches),
            "limited_to": limit if len(matches) >= limit else None,
            "results": matches[:limit]
        })
    except Exception as e:
        logger.exception("Failed to search glossary")
        return jsonify({"error": str(e)[:300]}), 500
