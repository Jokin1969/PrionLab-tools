"""
Journal metrics aggregator — combines Scopus (SJR, CiteScore),
CrossRef (publication counts) and Scholar (h5-index) into a single
response. Works gracefully when only some APIs are configured.
"""
import asyncio
import logging
import time
from typing import Dict, List, Optional

from .core import APIResponse
from .crossref_client import get_crossref_client
from .scopus_client import get_scopus_client
from .scholar_client import get_scholar_client

logger = logging.getLogger(__name__)


async def get_journal_metrics(issn: str, journal_name: str = "") -> Dict:
    """
    Aggregate journal metrics from all available sources.
    Returns a merged dict with keys from each source.
    Gracefully handles missing API keys.
    """
    result: Dict = {
        "issn": issn,
        "journal_name": journal_name,
        "sources_queried": [],
        "sources_succeeded": [],
        "sjr_score": None,
        "cite_score": None,
        "h5_index": None,
        "h5_median": None,
        "impact_factor": None,
        "quartile": None,
        "category": None,
        "open_access": None,
        "publisher": None,
        "crossref_works_count": None,
    }

    tasks = {}

    # Scopus — SJR and CiteScore
    scopus = get_scopus_client()
    if scopus.configured:
        tasks["scopus"] = _run_async(scopus.get_journal_metrics(issn))
        result["sources_queried"].append("scopus")

    # CrossRef — publisher info and works count
    crossref = get_crossref_client()
    tasks["crossref_journal"] = _run_async(_crossref_journal_info(crossref, issn))
    result["sources_queried"].append("crossref")

    # Scholar — h5-index (needs journal name)
    scholar = get_scholar_client()
    if scholar.configured and journal_name:
        tasks["scholar"] = _run_async(scholar.get_journal_h5_metrics(journal_name))
        result["sources_queried"].append("scholar")

    # Run all in parallel
    keys = list(tasks.keys())
    responses = await asyncio.gather(*tasks.values(), return_exceptions=True)

    for key, resp in zip(keys, responses):
        if isinstance(resp, Exception):
            logger.debug("Journal metrics source %s error: %s", key, resp)
            continue

        if isinstance(resp, APIResponse) and resp.success and resp.data:
            result["sources_succeeded"].append(key.split("_")[0])
            data = resp.data

            if key == "scopus":
                result["sjr_score"] = data.get("sjr_score")
                result["cite_score"] = data.get("cite_score")
                result["quartile"] = data.get("quartile")
                result["category"] = data.get("category")
                result["open_access"] = data.get("open_access")
                result["publisher"] = result["publisher"] or data.get("publisher")
                if data.get("title") and not result["journal_name"]:
                    result["journal_name"] = data["title"]

            elif key == "crossref_journal" and data:
                result["publisher"] = result["publisher"] or data.get("publisher")
                result["crossref_works_count"] = data.get("works_count")
                if data.get("title") and not result["journal_name"]:
                    result["journal_name"] = data["title"]

            elif key == "scholar" and data:
                result["h5_index"] = data.get("h5_index")
                result["h5_median"] = data.get("h5_median")
                if data.get("journal_name") and not result["journal_name"]:
                    result["journal_name"] = data["journal_name"]

    return result


async def _crossref_journal_info(crossref, issn: str) -> APIResponse:
    """Fetch journal info from CrossRef using the journals endpoint."""
    resp = await crossref._make_request(
        "GET",
        f"/journals/{issn}",
        params={},
        cache_ttl_hours=168,
    )
    if not resp.success or not resp.data:
        return resp
    try:
        msg = resp.data.get("message", {})
        data = {
            "title": msg.get("title", ""),
            "publisher": msg.get("publisher", ""),
            "works_count": msg.get("works-count"),
            "issn": issn,
        }
        return APIResponse(success=True, data=data, source="crossref")
    except Exception as exc:
        return APIResponse(success=False, data=None, error=str(exc), source="crossref")


def _run_async(coro):
    """Wrap a coroutine so asyncio.gather can await it."""
    return coro


async def bulk_get_journal_metrics(journals: List[Dict]) -> List[Dict]:
    """
    Get metrics for multiple journals.
    Each item: {'issn': '...', 'name': '...'}
    Rate-limited to 1 request/second to respect API quotas.
    """
    results = []
    for j in journals:
        issn = j.get("issn", "")
        name = j.get("name", "")
        if not issn:
            continue
        try:
            metrics = await get_journal_metrics(issn, name)
            results.append(metrics)
        except Exception as exc:
            results.append({"issn": issn, "journal_name": name, "error": str(exc)})
        await asyncio.sleep(0.5)
    return results


def run_journal_metrics_sync(issn: str, journal_name: str = "") -> Dict:
    """Synchronous wrapper for Flask route handlers."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(get_journal_metrics(issn, journal_name))
    finally:
        loop.close()


def run_bulk_journal_metrics_sync(journals: List[Dict]) -> List[Dict]:
    """Synchronous wrapper for bulk journal metrics."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(bulk_get_journal_metrics(journals))
    finally:
        loop.close()
