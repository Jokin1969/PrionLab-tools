"""Google Scholar async client via SerpAPI (no official Scholar API exists)."""
import logging
import os
import time
from typing import Dict, List, Optional

from .core import APIResponse, BaseAPIClient, RateLimitConfig

logger = logging.getLogger(__name__)

_RATE_LIMIT = RateLimitConfig(
    requests_per_second=1,
    requests_per_minute=30,
    requests_per_hour=500,
    burst_limit=5,
)

_BASE_URL = "https://serpapi.com"


class ScholarClient(BaseAPIClient):
    """
    Google Scholar client using SerpAPI.
    Requires SERPAPI_KEY environment variable.
    Falls back to CrossRef/ORCID data when not configured.
    """

    def __init__(self):
        super().__init__("scholar", _BASE_URL, _RATE_LIMIT)
        self._api_key = os.getenv("SERPAPI_KEY", "")

    @property
    def configured(self) -> bool:
        return bool(self._api_key)

    def _default_headers(self) -> Dict:
        return super()._default_headers()

    # ── Author profile ────────────────────────────────────────────────────────

    async def get_author_profile(self, scholar_id: str) -> APIResponse:
        """
        Fetch Google Scholar author profile metrics.
        scholar_id: the 'user' parameter from a Scholar profile URL.
        """
        if not self.configured:
            return APIResponse(
                success=False, data=None,
                error="SERPAPI_KEY not configured", source="scholar",
            )

        resp = await self._make_request(
            "GET",
            "/search",
            params={
                "engine": "google_scholar_author",
                "author_id": scholar_id,
                "api_key": self._api_key,
                "num": 100,
            },
            cache_ttl_hours=6,
        )
        if not resp.success or not resp.data:
            return resp

        try:
            data = resp.data
            author = data.get("author", {})
            cited = author.get("cited_by", {})
            table = cited.get("table", [])

            total_cit = 0
            h_index = 0
            i10_index = 0
            cit_since = {}

            for row in table:
                citations = row.get("citations", {})
                if "all" in citations:
                    total_cit = int(citations["all"])
                h_row = row.get("h_index", {})
                if "all" in h_row:
                    h_index = int(h_row["all"])
                i10_row = row.get("i10_index", {})
                if "all" in i10_row:
                    i10_index = int(i10_row["all"])

            graph = cited.get("graph", [])
            for point in graph:
                yr = point.get("year")
                ct = point.get("citations")
                if yr and ct:
                    cit_since[str(yr)] = int(ct)

            articles = data.get("articles", [])
            recent_pubs = [
                {
                    "title": a.get("title", ""),
                    "authors": a.get("authors", ""),
                    "year": a.get("year"),
                    "cited_by": (a.get("cited_by") or {}).get("value", 0),
                    "link": a.get("link", ""),
                }
                for a in articles[:20]
            ]

            result = {
                "scholar_id": scholar_id,
                "name": author.get("name", ""),
                "affiliation": author.get("affiliations", ""),
                "interests": [i.get("title", "") for i in author.get("interests", [])],
                "total_citations": total_cit,
                "h_index": h_index,
                "i10_index": i10_index,
                "citations_by_year": cit_since,
                "recent_publications": recent_pubs,
            }
            return APIResponse(success=True, data=result, source="scholar", cached=resp.cached)
        except Exception as exc:
            logger.warning("Scholar profile parse error: %s", exc)
            return APIResponse(success=False, data=None, error=str(exc), source="scholar")

    # ── Publication search ────────────────────────────────────────────────────

    async def search_publications(self, query: str, limit: int = 20) -> APIResponse:
        """Search Google Scholar publications."""
        if not self.configured:
            return APIResponse(
                success=False, data=None,
                error="SERPAPI_KEY not configured", source="scholar",
            )

        resp = await self._make_request(
            "GET",
            "/search",
            params={
                "engine": "google_scholar",
                "q": query,
                "api_key": self._api_key,
                "num": min(limit, 20),
            },
            cache_ttl_hours=4,
        )
        if not resp.success or not resp.data:
            return resp

        try:
            results = []
            for item in resp.data.get("organic_results", []):
                resources = item.get("resources", [])
                pdf_link = resources[0].get("link") if resources else None
                cited_info = item.get("inline_links", {}).get("cited_by", {})
                results.append({
                    "title": item.get("title", ""),
                    "snippet": item.get("snippet", ""),
                    "link": item.get("link", ""),
                    "pdf_link": pdf_link,
                    "cited_by": cited_info.get("total", 0),
                    "year": item.get("publication_info", {}).get("summary", ""),
                    "authors": item.get("publication_info", {}).get("authors", []),
                })
            return APIResponse(
                success=True, data={"results": results, "total": len(results)},
                source="scholar", cached=resp.cached,
            )
        except Exception as exc:
            logger.warning("Scholar search parse error: %s", exc)
            return APIResponse(success=False, data=None, error=str(exc), source="scholar")

    # ── Journal h5-index ──────────────────────────────────────────────────────

    async def get_journal_h5_metrics(self, journal_name: str) -> APIResponse:
        """Search for a journal's h5-index in Google Scholar Metrics."""
        if not self.configured:
            return APIResponse(
                success=False, data=None,
                error="SERPAPI_KEY not configured", source="scholar",
            )

        resp = await self._make_request(
            "GET",
            "/search",
            params={
                "engine": "google_scholar_metrics",
                "q": journal_name,
                "api_key": self._api_key,
            },
            cache_ttl_hours=168,
        )
        if not resp.success or not resp.data:
            return resp

        try:
            journals = resp.data.get("results", [])
            if not journals:
                return APIResponse(success=True, data=None, source="scholar")
            top = journals[0]
            result = {
                "journal_name": top.get("name", journal_name),
                "h5_index": top.get("h5_index"),
                "h5_median": top.get("h5_median"),
            }
            return APIResponse(success=True, data=result, source="scholar", cached=resp.cached)
        except Exception as exc:
            logger.warning("Scholar journal h5 parse error: %s", exc)
            return APIResponse(success=False, data=None, error=str(exc), source="scholar")

    # ── Health probe ──────────────────────────────────────────────────────────

    async def health_check(self) -> Dict:
        if not self.configured:
            return {"api": "scholar", "status": "not_configured", "key_present": False}
        t0 = time.time()
        try:
            resp = await self.search_publications("prion disease", limit=1)
            ms = int((time.time() - t0) * 1000)
            return {
                "api": "scholar",
                "status": "healthy" if resp.success else "error",
                "response_ms": ms,
                "key_present": True,
            }
        except Exception as exc:
            ms = int((time.time() - t0) * 1000)
            return {"api": "scholar", "status": "error", "error": str(exc), "response_ms": ms}


# ── Singleton ─────────────────────────────────────────────────────────────────

_client: Optional[ScholarClient] = None


def get_scholar_client() -> ScholarClient:
    global _client
    if _client is None:
        _client = ScholarClient()
    return _client
