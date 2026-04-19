"""Scopus (Elsevier) API async client — citation metrics and journal data."""
import logging
import os
from typing import Any, Dict, List, Optional

from .core import APIResponse, BaseAPIClient, RateLimitConfig

logger = logging.getLogger(__name__)

_RATE_LIMIT = RateLimitConfig(
    requests_per_second=2,
    requests_per_minute=100,
    requests_per_hour=5000,
    burst_limit=10,
)

_BASE_URL = "https://api.elsevier.com"


class ScopusClient(BaseAPIClient):
    """Async Scopus API client for citation metrics and journal data."""

    def __init__(self):
        super().__init__("scopus", _BASE_URL, _RATE_LIMIT)
        self._api_key = os.getenv("SCOPUS_API_KEY", "")

    def _default_headers(self) -> Dict[str, str]:
        h = super()._default_headers()
        if self._api_key:
            h["X-ELS-APIKey"] = self._api_key
        return h

    @property
    def configured(self) -> bool:
        return bool(self._api_key)

    # ── Author metrics ────────────────────────────────────────────────────────

    async def get_author_metrics(self, author_id: str) -> APIResponse:
        """
        Fetch author metrics (H-index, citation count, document count).
        author_id: Scopus author ID (numeric string).
        """
        if not self.configured:
            return APIResponse(
                success=False,
                data=None,
                error="SCOPUS_API_KEY not configured",
                source="scopus",
            )

        resp = await self._make_request(
            "GET",
            f"/content/author/author_id/{author_id}",
            params={"view": "METRICS"},
            cache_ttl_hours=12,
        )
        if not resp.success or not resp.data:
            return resp

        try:
            entries = resp.data.get("author-retrieval-response", [{}])
            entry = entries[0] if entries else {}
            coredata = entry.get("coredata", {})
            metrics = {
                "author_id": author_id,
                "h_index": int(entry.get("h-index", 0) or 0),
                "citation_count": int(coredata.get("citation-count", 0) or 0),
                "document_count": int(coredata.get("document-count", 0) or 0),
                "orcid": entry.get("orcid"),
                "name": _extract_author_name(entry),
                "affiliation": _extract_affiliation(entry),
                "subject_areas": _extract_subject_areas(entry),
            }
            return APIResponse(success=True, data=metrics, source="scopus", cached=resp.cached)
        except Exception as exc:
            logger.warning("Scopus author metrics parse error: %s", exc)
            return APIResponse(success=False, data=None, error=str(exc), source="scopus")

    # ── Journal metrics ───────────────────────────────────────────────────────

    async def get_journal_metrics(self, issn: str) -> APIResponse:
        """
        Fetch journal metrics (SJR, CiteScore, quartile) by ISSN.
        issn: ISSN with or without hyphen.
        """
        if not self.configured:
            return APIResponse(
                success=False, data=None,
                error="SCOPUS_API_KEY not configured", source="scopus",
            )

        clean_issn = issn.replace("-", "")
        resp = await self._make_request(
            "GET",
            f"/content/serial/title/issn/{clean_issn}",
            params={"view": "STANDARD"},
            cache_ttl_hours=168,  # 1 week — journal data is slow-changing
        )
        if not resp.success or not resp.data:
            return resp

        try:
            entry = (
                resp.data.get("serial-metadata-response", {})
                .get("entry", [{}])[0]
            )
            sjr_list = entry.get("SJRList", {}).get("SJR", [])
            sjr_score = float(sjr_list[0].get("@ratio", 0)) if sjr_list else None

            cs_metric = (
                entry.get("citeScoreYearInfoList", {})
                .get("citeScoreCurrentMetricYear", {})
            )
            cite_score = (
                float(cs_metric.get("citeScore", 0)) if cs_metric else None
            )

            subject_area = (
                entry.get("subject-area", [{}])
            )
            quartile = None
            category = None
            if isinstance(subject_area, list) and subject_area:
                quartile = subject_area[0].get("@abbrev")
                category = subject_area[0].get("$")

            metrics = {
                "issn": issn,
                "title": entry.get("dc:title", ""),
                "publisher": entry.get("dc:publisher", ""),
                "sjr_score": sjr_score,
                "cite_score": cite_score,
                "quartile": quartile,
                "category": category,
                "open_access": entry.get("openaccess") == "1",
            }
            return APIResponse(success=True, data=metrics, source="scopus", cached=resp.cached)
        except Exception as exc:
            logger.warning("Scopus journal metrics parse error: %s", exc)
            return APIResponse(success=False, data=None, error=str(exc), source="scopus")

    # ── Abstract / publication ────────────────────────────────────────────────

    async def get_abstract_by_doi(self, doi: str) -> APIResponse:
        """Fetch abstract and citation count for a DOI from Scopus."""
        if not self.configured:
            return APIResponse(
                success=False, data=None,
                error="SCOPUS_API_KEY not configured", source="scopus",
            )

        resp = await self._make_request(
            "GET",
            f"/content/abstract/doi/{doi}",
            params={"view": "META_ABS"},
            cache_ttl_hours=48,
        )
        if not resp.success or not resp.data:
            return resp

        try:
            container = resp.data.get("abstracts-retrieval-response", {})
            coredata = container.get("coredata", {})
            result = {
                "doi": doi,
                "title": coredata.get("dc:title", ""),
                "abstract": coredata.get("dc:description", ""),
                "citation_count": int(coredata.get("citedby-count", 0) or 0),
                "publication_name": coredata.get("prism:publicationName", ""),
                "cover_date": coredata.get("prism:coverDate", ""),
                "scopus_id": coredata.get("dc:identifier", "").replace("SCOPUS_ID:", ""),
            }
            return APIResponse(success=True, data=result, source="scopus", cached=resp.cached)
        except Exception as exc:
            logger.warning("Scopus abstract parse error: %s", exc)
            return APIResponse(success=False, data=None, error=str(exc), source="scopus")

    # ── Health probe ──────────────────────────────────────────────────────────

    async def health_check(self) -> Dict:
        """Lightweight connectivity test."""
        import time
        if not self.configured:
            return {"api": "scopus", "status": "not_configured", "key_present": False}
        t0 = time.time()
        try:
            resp = await self._make_request(
                "GET", "/content/search/scopus",
                params={"query": "test", "count": 1},
                cache_ttl_hours=0,
            )
            ms = int((time.time() - t0) * 1000)
            return {
                "api": "scopus",
                "status": "healthy" if resp.success else "error",
                "response_ms": ms,
                "key_present": True,
            }
        except Exception as exc:
            ms = int((time.time() - t0) * 1000)
            return {"api": "scopus", "status": "error", "error": str(exc), "response_ms": ms}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _extract_author_name(entry: Dict) -> str:
    pn = entry.get("preferred-name", {})
    given = pn.get("given-name", "")
    surname = pn.get("surname", "")
    return f"{given} {surname}".strip()


def _extract_affiliation(entry: Dict) -> str:
    aff = entry.get("affiliation-current", {})
    if isinstance(aff, dict):
        return aff.get("affiliation-name", "")
    return ""


def _extract_subject_areas(entry: Dict) -> List[str]:
    areas = entry.get("subject-areas", {}).get("subject-area", [])
    if isinstance(areas, list):
        return [a.get("$", "") for a in areas if a.get("$")]
    if isinstance(areas, dict):
        return [areas.get("$", "")]
    return []


# ── Singleton ─────────────────────────────────────────────────────────────────

_client: Optional[ScopusClient] = None


def get_scopus_client() -> ScopusClient:
    global _client
    if _client is None:
        _client = ScopusClient()
    return _client
