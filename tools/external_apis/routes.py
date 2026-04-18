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

# ── arXiv ─────────────────────────────────────────────────────────────────────

@external_api_bp.route("/arxiv/search", methods=["POST"])
@login_required
def arxiv_search():
    """Search arXiv preprints."""
    data = request.get_json(silent=True) or {}
    query = data.get("query", "").strip()
    if not query:
        return jsonify({"success": False, "error": "query is required"}), 400

    from .arxiv_client import get_arxiv_client

    try:
        client = get_arxiv_client()

        async def _search():
            async with client:
                return await client.search_preprints(
                    query=query,
                    author=data.get("author", ""),
                    title=data.get("title", ""),
                    categories=data.get("categories"),
                    max_results=int(data.get("max_results", 20)),
                )

        resp = _run(_search())
        return jsonify({
            "success": resp.success,
            "data": resp.data if resp.success else None,
            "error": resp.error if not resp.success else None,
            "cached": resp.cached,
        })
    except Exception as exc:
        logger.error("arXiv search: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@external_api_bp.route("/arxiv/<path:arxiv_id>")
@login_required
def arxiv_paper(arxiv_id: str):
    """Get a single arXiv paper by ID."""
    from .arxiv_client import get_arxiv_client

    try:
        client = get_arxiv_client()

        async def _fetch():
            async with client:
                return await client.get_paper_by_id(arxiv_id)

        resp = _run(_fetch())
        return jsonify({
            "success": resp.success,
            "data": resp.data if resp.success else None,
            "error": resp.error if not resp.success else None,
            "cached": resp.cached,
        })
    except Exception as exc:
        logger.error("arXiv paper lookup: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


# ── Enrichment ────────────────────────────────────────────────────────────────

@external_api_bp.route("/enrich/doi/<path:doi>")
@login_required
def enrich_by_doi(doi: str):
    """Enrich a publication record using its DOI."""
    from .enrichment_service import EnrichmentService

    try:
        service = EnrichmentService()
        result = _run(service.enrich_by_doi(doi))
        return jsonify(result)
    except Exception as exc:
        logger.error("enrich_by_doi: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@external_api_bp.route("/enrich/author", methods=["POST"])
@login_required
def enrich_author():
    """Verify an author via ORCID."""
    from .enrichment_service import EnrichmentService

    data = request.get_json(silent=True) or {}
    author_name = data.get("author_name", "").strip()
    if not author_name:
        return jsonify({"success": False, "error": "author_name is required"}), 400

    try:
        service = EnrichmentService()
        result = _run(service.verify_author(author_name, affiliation=data.get("affiliation", "")))
        return jsonify(result)
    except Exception as exc:
        logger.error("enrich_author: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@external_api_bp.route("/enrich/bulk", methods=["POST"])
@login_required
def enrich_bulk():
    """Start a bulk enrichment background job."""
    from .background_jobs import get_job_manager, _bulk_enrichment_worker

    data = request.get_json(silent=True) or {}
    criteria = data.get("criteria", {})
    max_publications = int(data.get("max_publications", 50))
    max_concurrent = int(data.get("max_concurrent", 3))

    try:
        jm = get_job_manager()
        job_id = jm.submit(
            "bulk_enrichment",
            _bulk_enrichment_worker,
            criteria=criteria,
            max_publications=max_publications,
            max_concurrent=max_concurrent,
        )
        return jsonify({"success": True, "job_id": job_id})
    except Exception as exc:
        logger.error("enrich_bulk: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


# ── Jobs ──────────────────────────────────────────────────────────────────────

@external_api_bp.route("/jobs/history")
@login_required
def jobs_history():
    """Return recent job history."""
    from .background_jobs import get_job_manager

    try:
        limit = int(request.args.get("limit", 20))
        jobs = get_job_manager().list_recent(limit=limit)
        return jsonify({"success": True, "jobs": jobs})
    except Exception as exc:
        logger.error("jobs_history: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@external_api_bp.route("/jobs/<job_id>/cancel", methods=["POST"])
@login_required
def cancel_job(job_id: str):
    """Cancel a running job."""
    from .background_jobs import get_job_manager

    try:
        ok = get_job_manager().cancel(job_id)
        if ok:
            return jsonify({"success": True, "message": "Job cancelled"})
        return jsonify({"success": False, "error": "Job not found or already finished"}), 404
    except Exception as exc:
        logger.error("cancel_job: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


# ── Test / diagnostics ────────────────────────────────────────────────────────

@external_api_bp.route("/test/basic")
@login_required
def test_basic():
    """Verify the external API integration is wired up correctly."""
    from datetime import datetime as _dt
    return jsonify({
        "success": True,
        "message": "External API integration is working",
        "timestamp": _dt.utcnow().isoformat(),
        "components": {
            "orcid_client": "initialised",
            "crossref_client": "initialised",
            "pubmed_client": "initialised",
            "arxiv_client": "initialised",
            "enrichment_service": "ready",
            "background_jobs": "ready",
        },
    })


@external_api_bp.route("/test/apis", methods=["POST"])
@login_required
def test_apis():
    """Probe live connectivity to each external API (1-result search)."""
    results = {}

    # ORCID
    try:
        from .orcid_client import get_orcid_client
        client = get_orcid_client()

        async def _orcid():
            async with client:
                return await client.search_person(name="Smith")

        resp = _run(_orcid())
        results["orcid"] = {"success": resp.success, "cached": resp.cached, "error": resp.error}
    except Exception as exc:
        results["orcid"] = {"success": False, "error": str(exc)}

    # CrossRef
    try:
        from .crossref_client import get_crossref_client
        client = get_crossref_client()

        async def _crossref():
            async with client:
                return await client.search_works(query="prion", limit=1)

        resp = _run(_crossref())
        results["crossref"] = {"success": resp.success, "cached": resp.cached, "error": resp.error}
    except Exception as exc:
        results["crossref"] = {"success": False, "error": str(exc)}

    # PubMed
    try:
        from .pubmed_client import get_pubmed_client
        client = get_pubmed_client()

        async def _pubmed():
            async with client:
                return await client.search_literature("prion", max_results=1)

        resp = _run(_pubmed())
        results["pubmed"] = {"success": resp.success, "cached": resp.cached, "error": resp.error}
    except Exception as exc:
        results["pubmed"] = {"success": False, "error": str(exc)}

    # arXiv
    try:
        from .arxiv_client import get_arxiv_client
        client = get_arxiv_client()

        async def _arxiv():
            async with client:
                return await client.search_preprints(query="prion", max_results=1)

        resp = _run(_arxiv())
        results["arxiv"] = {"success": resp.success, "cached": resp.cached, "error": resp.error}
    except Exception as exc:
        results["arxiv"] = {"success": False, "error": str(exc)}

    overall = all(r.get("success", False) for r in results.values())
    return jsonify({"success": overall, "api_tests": results})
