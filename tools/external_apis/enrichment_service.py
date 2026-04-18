"""Publication enrichment service — orchestrates ORCID, CrossRef, PubMed, arXiv."""
import asyncio
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class EnrichmentResult:
    """Result of enriching a single publication."""
    success: bool
    pub_id: str = ""
    doi: str = ""
    enriched_fields: Dict[str, Any] = field(default_factory=dict)
    sources_used: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict:
        return {
            "success": self.success,
            "pub_id": self.pub_id,
            "doi": self.doi,
            "enriched_fields": self.enriched_fields,
            "sources_used": self.sources_used,
            "errors": self.errors,
        }


class EnrichmentService:
    """Orchestrates multiple external APIs to enrich publication records."""

    # ── Public API ────────────────────────────────────────────────────────────

    async def enrich_publication(self, pub: Dict) -> Dict:
        """Enrich a publication dict using all available APIs."""
        result = EnrichmentResult(
            success=False,
            pub_id=str(pub.get("pub_id", "")),
            doi=str(pub.get("doi", "")),
        )
        enriched: Dict[str, Any] = {}

        # CrossRef enrichment via DOI
        doi = result.doi.strip()
        if doi:
            cr_data = await self._crossref_enrich(doi)
            if cr_data:
                enriched.update(cr_data)
                result.sources_used.append("crossref")

        # PubMed enrichment via DOI or title
        pm_data = await self._pubmed_enrich(doi=doi, title=pub.get("title", ""))
        if pm_data:
            # Merge without overwriting CrossRef data
            for k, v in pm_data.items():
                if k not in enriched or not enriched[k]:
                    enriched[k] = v
            result.sources_used.append("pubmed")

        result.enriched_fields = enriched
        result.success = bool(enriched)
        return result.to_dict()

    async def enrich_by_doi(self, doi: str) -> Dict:
        """Enrich using a DOI as the primary key."""
        return await self.enrich_publication({"doi": doi})

    async def verify_author(self, author_name: str, affiliation: str = "") -> Dict:
        """Look up an author on ORCID and return matched profiles."""
        from .orcid_client import get_orcid_client
        client = get_orcid_client()
        try:
            async with client:
                resp = await client.search_person(name=author_name, affiliation=affiliation)
            if resp.success:
                return {
                    "success": True,
                    "author": author_name,
                    "orcid_matches": resp.data or [],
                    "source": "orcid",
                    "cached": resp.cached,
                }
            return {"success": False, "author": author_name, "error": resp.error, "orcid_matches": []}
        except Exception as exc:
            logger.error("verify_author %s: %s", author_name, exc)
            return {"success": False, "author": author_name, "error": str(exc), "orcid_matches": []}

    async def search_arxiv_preprints(
        self,
        query: str,
        categories: Optional[List[str]] = None,
        max_results: int = 20,
    ) -> Dict:
        """Search arXiv for preprints related to a topic."""
        from .arxiv_client import get_arxiv_client
        client = get_arxiv_client()
        try:
            async with client:
                resp = await client.search_preprints(
                    query=query, categories=categories or [], max_results=max_results
                )
            return {
                "success": resp.success,
                "data": resp.data,
                "error": resp.error,
                "cached": resp.cached,
            }
        except Exception as exc:
            logger.error("search_arxiv_preprints: %s", exc)
            return {"success": False, "data": None, "error": str(exc)}

    # ── Private helpers ───────────────────────────────────────────────────────

    async def _crossref_enrich(self, doi: str) -> Optional[Dict]:
        from .crossref_client import get_crossref_client
        client = get_crossref_client()
        try:
            async with client:
                resp = await client.get_work_by_doi(doi)
            if not resp.success or not resp.data:
                return None
            work = resp.data
            result: Dict[str, Any] = {}
            if work.get("title"):
                result["title"] = work["title"]
            if work.get("abstract"):
                result["abstract"] = work["abstract"]
            if work.get("authors"):
                result["authors_detail"] = work["authors"]
                # Flat string for display
                names = [a.get("full_name", "") for a in work["authors"]]
                result["authors_str"] = "; ".join(n for n in names if n)
            if work.get("journal"):
                result["journal"] = work["journal"]
            if work.get("year"):
                result["year"] = work["year"]
            if work.get("volume"):
                result["volume"] = work["volume"]
            if work.get("issue"):
                result["issue"] = work["issue"]
            if work.get("pages"):
                result["pages"] = work["pages"]
            if work.get("citation_count") is not None:
                result["citation_count"] = work["citation_count"]
            if work.get("publisher"):
                result["publisher"] = work["publisher"]
            return result or None
        except Exception as exc:
            logger.warning("CrossRef enrich DOI %s: %s", doi, exc)
            return None

    async def _pubmed_enrich(self, doi: str = "", title: str = "") -> Optional[Dict]:
        from .pubmed_client import get_pubmed_client
        client = get_pubmed_client()
        try:
            async with client:
                if doi:
                    resp = await client.get_by_doi(doi)
                elif title:
                    query = re.sub(r"[^\w\s]", "", title)[:100]
                    resp = await client.search_literature(query, max_results=5)
                else:
                    return None

            if not resp.success or not resp.data:
                return None

            articles = resp.data.get("articles", [])
            if not articles:
                return None

            art = articles[0]
            result: Dict[str, Any] = {}
            if art.get("pmid"):
                result["pmid"] = art["pmid"]
            if art.get("abstract"):
                result["abstract_pubmed"] = art["abstract"]
            if art.get("authors"):
                result["authors_pubmed"] = art["authors"]
            if art.get("journal"):
                result["journal_pubmed"] = art["journal"]
            if art.get("year"):
                result["year_pubmed"] = art["year"]
            return result or None
        except Exception as exc:
            logger.warning("PubMed enrich: %s", exc)
            return None
