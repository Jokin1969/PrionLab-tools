"""External API Integration — Flask routes."""
import asyncio
import logging

from flask import jsonify, request, session

from core.decorators import login_required
from . import external_api_bp
from .crossref_client import get_crossref_client
from .orcid_client import get_orcid_client
from .pubmed_client import get_pubmed_client

logger = logging.getLogger(__name__)


def _run(coro):
    """Run an async coroutine in a fresh event loop (sync Flask context)."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ── Health ────────────────────────────────────────────────────────────────────

@external_api_bp.route("/health")
def api_health():
    """Return availability status of configured external APIs."""
    import os
    apis = {
        "crossref": {"status": "available", "base_url": "https://api.crossref.org"},
        "pubmed": {
            "status": "available",
            "base_url": "https://eutils.ncbi.nlm.nih.gov/entrez/eutils",
            "api_key_configured": bool(os.getenv("PUBMED_API_KEY")),
        },
        "orcid": {"status": "available", "base_url": "https://pub.orcid.org/v3.0"},
    }
    return jsonify({"success": True, "apis": apis, "overall_status": "available"})


# ── ORCID ─────────────────────────────────────────────────────────────────────

@external_api_bp.route("/orcid/search", methods=["POST"])
@login_required
def search_orcid():
    """Search ORCID for authors matching name / affiliation / email."""
    data = request.get_json(silent=True) or {}
    name = data.get("name", "")
    affiliation = data.get("affiliation", "")
    email = data.get("email", "")

    if not any([name, affiliation, email]):
        return jsonify({"success": False, "error": "Provide at least one of: name, affiliation, email"}), 400

    try:
        client = get_orcid_client()

        async def _search():
            async with client:
                return await client.search_person(name, affiliation, email)

        resp = _run(_search())
        return jsonify({
            "success": resp.success,
            "data": resp.data if resp.success else None,
            "error": resp.error if not resp.success else None,
            "cached": resp.cached,
        })
    except Exception as exc:
        logger.error("ORCID search: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@external_api_bp.route("/orcid/<path:orcid_id>")
@login_required
def orcid_person(orcid_id: str):
    """Retrieve detailed ORCID profile for the given iD."""
    try:
        client = get_orcid_client()

        async def _fetch():
            async with client:
                return await client.get_person_details(orcid_id)

        resp = _run(_fetch())
        return jsonify({
            "success": resp.success,
            "data": resp.data if resp.success else None,
            "error": resp.error if not resp.success else None,
            "cached": resp.cached,
        })
    except Exception as exc:
        logger.error("ORCID person lookup: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


# ── CrossRef ──────────────────────────────────────────────────────────────────

@external_api_bp.route("/crossref/doi/<path:doi>")
@login_required
def crossref_doi(doi: str):
    """Resolve a DOI via CrossRef."""
    try:
        client = get_crossref_client()

        async def _fetch():
            async with client:
                return await client.get_work_by_doi(doi)

        resp = _run(_fetch())
        return jsonify({
            "success": resp.success,
            "data": resp.data if resp.success else None,
            "error": resp.error if not resp.success else None,
            "cached": resp.cached,
        })
    except Exception as exc:
        logger.error("CrossRef DOI lookup: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@external_api_bp.route("/crossref/search", methods=["POST"])
@login_required
def crossref_search():
    """Search CrossRef works."""
    data = request.get_json(silent=True) or {}
    try:
        client = get_crossref_client()

        async def _search():
            async with client:
                return await client.search_works(
                    query=data.get("query", ""),
                    title=data.get("title", ""),
                    author=data.get("author", ""),
                    year=data.get("year"),
                    journal=data.get("journal", ""),
                    doi=data.get("doi", ""),
                    limit=int(data.get("limit", 20)),
                )

        resp = _run(_search())
        return jsonify({
            "success": resp.success,
            "data": resp.data if resp.success else None,
            "error": resp.error if not resp.success else None,
            "cached": resp.cached,
        })
    except Exception as exc:
        logger.error("CrossRef search: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


# ── PubMed ────────────────────────────────────────────────────────────────────

@external_api_bp.route("/pubmed/search", methods=["POST"])
@login_required
def pubmed_search():
    """Search PubMed literature."""
    data = request.get_json(silent=True) or {}
    query = data.get("query", "").strip()
    if not query:
        return jsonify({"success": False, "error": "query is required"}), 400

    try:
        client = get_pubmed_client()

        async def _search():
            async with client:
                return await client.search_literature(
                    query=query,
                    max_results=int(data.get("max_results", 50)),
                    year_from=data.get("year_from"),
                    year_to=data.get("year_to"),
                    journal=data.get("journal"),
                    author=data.get("author"),
                    sort=data.get("sort", "relevance"),
                )

        resp = _run(_search())
        return jsonify({
            "success": resp.success,
            "data": resp.data if resp.success else None,
            "error": resp.error if not resp.success else None,
            "cached": resp.cached,
        })
    except Exception as exc:
        logger.error("PubMed search: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@external_api_bp.route("/pubmed/doi/<path:doi>")
@login_required
def pubmed_by_doi(doi: str):
    """Look up a PubMed article by DOI."""
    try:
        client = get_pubmed_client()

        async def _fetch():
            async with client:
                return await client.get_by_doi(doi)

        resp = _run(_fetch())
        return jsonify({
            "success": resp.success,
            "data": resp.data if resp.success else None,
            "error": resp.error if not resp.success else None,
            "cached": resp.cached,
        })
    except Exception as exc:
        logger.error("PubMed DOI lookup: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500
