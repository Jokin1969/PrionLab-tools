"""CrossRef API client — DOI resolution and publication metadata."""
import logging
import re
from typing import Dict, List, Optional

from .core import API_RATE_LIMITS, APIResponse, BaseAPIClient

logger = logging.getLogger(__name__)


class CrossRefClient(BaseAPIClient):
    """CrossRef REST API client (polite pool)."""

    MAILTO = "prionlab@example.org"

    def __init__(self):
        super().__init__(
            api_name="crossref",
            base_url="https://api.crossref.org",
            rate_limit_config=API_RATE_LIMITS["crossref"],
        )

    def _default_headers(self) -> Dict[str, str]:
        headers = super()._default_headers()
        # Polite pool: include mailto
        headers["User-Agent"] = f"PrionLab-tools/1.0 (mailto:{self.MAILTO})"
        return headers

    # ── Public API ────────────────────────────────────────────────────────────

    async def get_work_by_doi(self, doi: str) -> APIResponse:
        """Resolve a DOI and return structured work metadata."""
        clean = self._normalise_doi(doi)
        if not clean:
            return APIResponse(
                success=False, data=None,
                error=f"Invalid DOI: {doi}", source=self.api_name,
            )
        response = await self._make_request("GET", f"works/{clean}")
        if response.success and response.data:
            msg = response.data.get("message", {})
            response.data = self._parse_work(msg)
        return response

    async def search_works(
        self,
        query: str = "",
        title: str = "",
        author: str = "",
        year: Optional[int] = None,
        journal: str = "",
        doi: str = "",
        limit: int = 20,
    ) -> APIResponse:
        """Search CrossRef for works matching the given criteria."""
        query_parts: List[str] = []
        if query:
            query_parts.append(query)
        if title:
            query_parts.append(f'title:"{title}"')
        if author:
            query_parts.append(f'author:"{author}"')
        if journal:
            query_parts.append(f'container-title:"{journal}"')
        if year:
            query_parts.append(f"published:{year}")
        if doi:
            clean = self._normalise_doi(doi)
            if clean:
                query_parts.append(f'doi:"{clean}"')

        params: Dict = {"rows": min(limit, 1000)}
        if query_parts:
            params["query"] = " AND ".join(query_parts)

        response = await self._make_request("GET", "works", params=params)
        if response.success and response.data:
            msg = response.data.get("message", {})
            response.data = {
                "works": [self._parse_work(item) for item in msg.get("items", [])],
                "total_results": msg.get("total-results", 0),
                "items_per_page": msg.get("items-per-page", 0),
            }
        return response

    # ── Helpers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _normalise_doi(doi: str) -> Optional[str]:
        if not doi:
            return None
        cleaned = doi
        for prefix in ("https://doi.org/", "http://doi.org/",
                       "https://dx.doi.org/", "http://dx.doi.org/"):
            cleaned = cleaned.replace(prefix, "")
        return cleaned.strip() if re.match(r"^10\.\d+/.+", cleaned.strip()) else None

    @staticmethod
    def _parse_work(work: Dict) -> Dict:
        parsed: Dict = {}
        try:
            parsed["doi"] = work.get("DOI", "")
            titles = work.get("title", [])
            parsed["title"] = titles[0] if titles else ""
            subtitles = work.get("subtitle", [])
            parsed["subtitle"] = subtitles[0] if subtitles else ""

            # Authors
            authors: List[Dict] = []
            for a in work.get("author", []):
                given = a.get("given", "")
                family = a.get("family", "")
                author_info: Dict = {
                    "given_name": given,
                    "family_name": family,
                    "full_name": f"{given} {family}".strip(),
                    "affiliations": [af["name"] for af in a.get("affiliation", []) if "name" in af],
                }
                raw_orcid = a.get("ORCID", "")
                if raw_orcid:
                    author_info["orcid"] = (
                        raw_orcid.replace("https://orcid.org/", "").replace("http://orcid.org/", "")
                    )
                authors.append(author_info)
            parsed["authors"] = authors

            containers = work.get("container-title", [])
            parsed["journal"] = containers[0] if containers else ""

            pub_date = (
                work.get("published-print")
                or work.get("published-online")
                or work.get("created")
            )
            if pub_date and "date-parts" in pub_date:
                dp = pub_date["date-parts"][0]
                parsed["year"] = dp[0] if len(dp) > 0 else None
                parsed["month"] = dp[1] if len(dp) > 1 else None
                parsed["day"] = dp[2] if len(dp) > 2 else None

            parsed["type"] = work.get("type", "")

            raw_abstract = work.get("abstract", "")
            parsed["abstract"] = re.sub(r"<[^>]+>", "", raw_abstract) if raw_abstract else ""

            parsed["volume"] = work.get("volume", "")
            parsed["issue"] = work.get("issue", "")
            parsed["pages"] = work.get("page", "")
            parsed["citation_count"] = work.get("is-referenced-by-count", 0)
            parsed["reference_count"] = work.get("reference-count", 0)
            parsed["url"] = work.get("URL", "")
            parsed["publisher"] = work.get("publisher", "")

        except Exception as exc:
            logger.error("CrossRefClient: parse work: %s", exc)
            parsed["parsing_error"] = str(exc)
        return parsed


# Module-level singleton
_crossref_client: Optional[CrossRefClient] = None


def get_crossref_client() -> CrossRefClient:
    global _crossref_client
    if _crossref_client is None:
        _crossref_client = CrossRefClient()
    return _crossref_client
