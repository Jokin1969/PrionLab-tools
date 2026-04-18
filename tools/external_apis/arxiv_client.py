"""arXiv API client — preprint discovery and tracking via Atom feed."""
import asyncio
import logging
import re
import xml.etree.ElementTree as ET
from datetime import datetime
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode

import aiohttp

from .core import API_RATE_LIMITS, APIResponse, BaseAPIClient

logger = logging.getLogger(__name__)

_NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
    "opensearch": "http://a9.com/-/spec/opensearch/1.1/",
}
_ARXIV_BASE = "https://export.arxiv.org/api"


class ArXivClient(BaseAPIClient):
    """arXiv E-print API client (Atom feed, no key required)."""

    def __init__(self):
        super().__init__(
            api_name="arxiv",
            base_url=_ARXIV_BASE,
            rate_limit_config=API_RATE_LIMITS["arxiv"],
        )

    def _default_headers(self) -> Dict[str, str]:
        headers = super()._default_headers()
        headers["Accept"] = "application/atom+xml, text/xml, */*"
        return headers

    # ── Public API ────────────────────────────────────────────────────────────

    async def search_preprints(
        self,
        query: str = "",
        author: str = "",
        title: str = "",
        categories: Optional[List[str]] = None,
        max_results: int = 20,
        start: int = 0,
        sort_by: str = "relevance",
        sort_order: str = "descending",
    ) -> APIResponse:
        """Search arXiv for preprints."""
        search_parts: List[str] = []
        if query:
            search_parts.append(f"all:{query}")
        if author:
            search_parts.append(f"au:{author}")
        if title:
            search_parts.append(f"ti:{title}")
        if categories:
            cat_query = "+OR+".join(f"cat:{c}" for c in categories)
            search_parts.append(f"({cat_query})")

        if not search_parts:
            return APIResponse(
                success=False, data=None,
                error="At least one search criterion required",
                source=self.api_name,
            )

        params = {
            "search_query": "+AND+".join(search_parts),
            "start": start,
            "max_results": min(max_results, 2000),
            "sortBy": sort_by,
            "sortOrder": sort_order,
        }
        return await self._fetch_atom("query", params)

    async def get_paper_by_id(self, arxiv_id: str) -> APIResponse:
        """Retrieve a single arXiv paper by its ID (e.g. '2301.00001' or 'cs.AI/0001001')."""
        clean_id = self._normalise_id(arxiv_id)
        params = {"id_list": clean_id, "max_results": 1}
        resp = await self._fetch_atom("query", params)
        if resp.success and isinstance(resp.data, dict):
            papers = resp.data.get("papers", [])
            resp.data = papers[0] if papers else None
            if resp.data is None:
                resp.success = False
                resp.error = f"No paper found for arXiv ID: {arxiv_id}"
        return resp

    # ── Internals ─────────────────────────────────────────────────────────────

    async def _fetch_atom(self, endpoint: str, params: Dict) -> APIResponse:
        """Make request and parse Atom XML response."""
        # Rate limiting
        wait = await self.rate_limiter.wait_if_needed(self.api_name)
        if wait > 0:
            logger.debug("arXiv: waited %.2fs for rate limiting", wait)

        # Cache lookup
        cached = await self.cache.get(self.api_name, endpoint, params, ttl_hours=6)
        if cached is not None:
            return APIResponse(success=True, data=cached, source=self.api_name, cached=True)

        url = f"{self.base_url}/{endpoint}"
        self.request_count += 1
        max_retries = 3
        for attempt in range(max_retries):
            try:
                async with self.session.get(url, params=params) as resp:
                    if resp.status == 429:
                        await asyncio.sleep(int(resp.headers.get("Retry-After", 30)))
                        continue
                    if resp.status >= 400:
                        self.error_count += 1
                        return APIResponse(
                            success=False, data=None,
                            error=f"HTTP {resp.status}", source=self.api_name,
                        )
                    xml_text = await resp.text()
                    parsed = self._parse_atom(xml_text)
                    await self.cache.set(self.api_name, endpoint, params, parsed, ttl_hours=6)
                    return APIResponse(success=True, data=parsed, source=self.api_name)
            except asyncio.TimeoutError:
                self.error_count += 1
                if attempt == max_retries - 1:
                    return APIResponse(success=False, data=None, error="Timeout", source=self.api_name)
                await asyncio.sleep(2 ** attempt)
            except Exception as exc:
                self.error_count += 1
                logger.error("arXiv fetch error (attempt %d): %s", attempt + 1, exc)
                if attempt == max_retries - 1:
                    return APIResponse(success=False, data=None, error=str(exc), source=self.api_name)
                await asyncio.sleep(2 ** attempt)

        return APIResponse(success=False, data=None, error="Max retries exceeded", source=self.api_name)

    def _parse_atom(self, xml_text: str) -> Dict[str, Any]:
        """Parse arXiv Atom feed into structured paper list."""
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError as exc:
            logger.error("arXiv XML parse error: %s", exc)
            return {"papers": [], "total_results": 0, "parse_error": str(exc)}

        total_el = root.find("opensearch:totalResults", _NS)
        total = int(total_el.text) if total_el is not None and total_el.text else 0

        papers: List[Dict] = []
        for entry in root.findall("atom:entry", _NS):
            paper = self._parse_entry(entry)
            if paper:
                papers.append(paper)

        return {"papers": papers, "total_results": total}

    def _parse_entry(self, entry) -> Optional[Dict]:
        try:
            # arXiv ID
            id_el = entry.find("atom:id", _NS)
            raw_id = id_el.text.strip() if id_el is not None else ""
            arxiv_id = raw_id.split("/abs/")[-1] if "/abs/" in raw_id else raw_id

            # Title (may have embedded whitespace)
            title_el = entry.find("atom:title", _NS)
            title = re.sub(r"\s+", " ", title_el.text.strip()) if title_el is not None else ""

            # Abstract
            summary_el = entry.find("atom:summary", _NS)
            abstract = re.sub(r"\s+", " ", summary_el.text.strip()) if summary_el is not None else ""

            # Authors
            authors = []
            for author_el in entry.findall("atom:author", _NS):
                name_el = author_el.find("atom:name", _NS)
                if name_el is not None:
                    authors.append({"full_name": name_el.text.strip()})

            # Dates
            published_el = entry.find("atom:published", _NS)
            updated_el = entry.find("atom:updated", _NS)
            published = published_el.text[:10] if published_el is not None else ""
            updated = updated_el.text[:10] if updated_el is not None else ""
            year = published[:4] if published else ""

            # Categories
            primary_cat = entry.find("arxiv:primary_category", _NS)
            primary_category = primary_cat.get("term", "") if primary_cat is not None else ""
            categories = [
                lnk.get("term", "")
                for lnk in entry.findall("atom:category", _NS)
            ]

            # DOI (if assigned)
            doi = ""
            doi_el = entry.find("arxiv:doi", _NS)
            if doi_el is not None:
                doi = doi_el.text.strip()
            if not doi:
                for link in entry.findall("atom:link", _NS):
                    if link.get("title") == "doi":
                        doi = link.get("href", "").replace("https://doi.org/", "")

            # Journal ref (if published)
            journal_ref_el = entry.find("arxiv:journal_ref", _NS)
            journal_ref = journal_ref_el.text.strip() if journal_ref_el is not None else ""

            return {
                "arxiv_id": arxiv_id,
                "arxiv_url": f"https://arxiv.org/abs/{arxiv_id}",
                "title": title,
                "abstract": abstract,
                "authors": authors,
                "published": published,
                "updated": updated,
                "year": year,
                "primary_category": primary_category,
                "categories": categories,
                "doi": doi,
                "journal_ref": journal_ref,
            }
        except Exception as exc:
            logger.debug("arXiv entry parse error: %s", exc)
            return None

    @staticmethod
    def _normalise_id(raw: str) -> str:
        """Strip URL prefix and version suffix from arXiv ID."""
        clean = raw.replace("https://arxiv.org/abs/", "").replace("http://arxiv.org/abs/", "")
        # Remove version suffix (e.g. v2)
        return re.sub(r"v\d+$", "", clean.strip())


# Module-level singleton
_arxiv_client: Optional[ArXivClient] = None


def get_arxiv_client() -> ArXivClient:
    global _arxiv_client
    if _arxiv_client is None:
        _arxiv_client = ArXivClient()
    return _arxiv_client
