"""PubMed / NCBI E-utilities API client."""
import logging
import os
import re
from typing import Any, Dict, List, Optional

from .core import API_RATE_LIMITS, APIResponse, BaseAPIClient

logger = logging.getLogger(__name__)

_ORCID_STRIP = re.compile(r"https?://orcid\.org/")


class PubMedClient(BaseAPIClient):
    """NCBI E-utilities client for PubMed literature search."""

    def __init__(self, api_key: Optional[str] = None, email: Optional[str] = None):
        super().__init__(
            api_name="pubmed",
            base_url="https://eutils.ncbi.nlm.nih.gov/entrez/eutils",
            rate_limit_config=API_RATE_LIMITS["pubmed"],
        )
        self.api_key = api_key
        self.email = email

    def _default_headers(self) -> Dict[str, str]:
        headers = super()._default_headers()
        if self.email:
            headers["User-Agent"] = f"PrionLab-tools/1.0 (mailto:{self.email})"
        return headers

    def _common_params(self) -> Dict[str, str]:
        params: Dict[str, str] = {
            "db": "pubmed",
            "retmode": "json",
            "tool": "PrionLab-tools",
        }
        if self.api_key:
            params["api_key"] = self.api_key
        if self.email:
            params["email"] = self.email
        return params

    # ── Public API ────────────────────────────────────────────────────────────

    async def search_literature(
        self,
        query: str,
        max_results: int = 100,
        year_from: Optional[int] = None,
        year_to: Optional[int] = None,
        journal: Optional[str] = None,
        author: Optional[str] = None,
        sort: str = "relevance",
    ) -> APIResponse:
        """Search PubMed and return article details."""
        terms: List[str] = [query] if query else []

        if year_from and year_to:
            terms.append(f'("{year_from}"[Date - Publication] : "{year_to}"[Date - Publication])')
        elif year_from:
            terms.append(f'"{year_from}"[Date - Publication] : "3000"[Date - Publication]')
        elif year_to:
            terms.append(f'"1800"[Date - Publication] : "{year_to}"[Date - Publication]')

        if journal:
            terms.append(f'"{journal}"[Journal]')
        if author:
            terms.append(f'"{author}"[Author]')

        full_query = " AND ".join(terms) if terms else query

        # Step 1: esearch → PMIDs
        search_params = self._common_params()
        search_params.update({
            "term": full_query,
            "retmax": str(min(max_results, 10000)),
            "sort": sort,
        })
        search_resp = await self._make_request("GET", "esearch.fcgi", params=search_params)
        if not search_resp.success:
            return search_resp

        pmids: List[str] = []
        if search_resp.data and "esearchresult" in search_resp.data:
            pmids = search_resp.data["esearchresult"].get("idlist", [])
        total_count = int(
            (search_resp.data or {}).get("esearchresult", {}).get("count", 0)
        )

        if not pmids:
            return APIResponse(
                success=True,
                data={"articles": [], "total_count": 0, "query": full_query},
                source=self.api_name,
            )

        # Step 2: efetch → article details
        details_resp = await self.get_articles_by_pmids(pmids)
        if details_resp.success:
            details_resp.data["total_count"] = total_count
            details_resp.data["query"] = full_query
            details_resp.data["pmids_retrieved"] = len(pmids)
        return details_resp

    async def get_articles_by_pmids(self, pmids: List[str]) -> APIResponse:
        """Fetch article details for a list of PMIDs."""
        if not pmids:
            return APIResponse(success=True, data={"articles": []}, source=self.api_name)

        fetch_params = self._common_params()
        fetch_params.update({
            "id": ",".join(str(p) for p in pmids[:200]),
            "rettype": "abstract",
        })

        response = await self._make_request("GET", "efetch.fcgi", params=fetch_params)
        if response.success and response.data:
            articles = self._parse_articles(response.data)
            response.data = {"articles": articles}
        return response

    async def get_by_doi(self, doi: str) -> APIResponse:
        """Search PubMed for a specific DOI."""
        return await self.search_literature(f"{doi}[DOI]", max_results=5)

    # ── Parsing ───────────────────────────────────────────────────────────────

    def _parse_articles(self, data: Any) -> List[Dict]:
        """Parse PubMed efetch response into structured article dicts.

        PubMed's JSON efetch is not well-documented; we navigate the tree
        defensively and fall back gracefully on missing keys.
        """
        articles: List[Dict] = []
        try:
            article_set = data.get("PubmedArticleSet") or []
            if not isinstance(article_set, list):
                article_set = [article_set]

            for entry in article_set:
                try:
                    medline = (entry.get("MedlineCitation") or {})
                    article = (medline.get("Article") or {})
                    parsed = self._parse_single_article(medline, article)
                    articles.append(parsed)
                except Exception as exc:
                    logger.debug("PubMedClient: skip article: %s", exc)
        except Exception as exc:
            logger.error("PubMedClient: parse articles: %s", exc)
        return articles

    @staticmethod
    def _parse_single_article(medline: Dict, article: Dict) -> Dict:
        # PMID
        pmid_node = medline.get("PMID") or {}
        pmid = pmid_node.get("#text", pmid_node) if isinstance(pmid_node, dict) else str(pmid_node)

        # Title
        title_node = article.get("ArticleTitle") or {}
        title = title_node.get("#text", title_node) if isinstance(title_node, dict) else str(title_node)

        # Journal
        journal_info = (article.get("Journal") or {})
        journal_title_node = journal_info.get("Title") or ""
        journal_title = (
            journal_title_node.get("#text", journal_title_node)
            if isinstance(journal_title_node, dict)
            else str(journal_title_node)
        )

        # Publication year
        pub_date = (journal_info.get("JournalIssue") or {}).get("PubDate") or {}
        year = pub_date.get("Year", "")

        # Abstract
        abstract_text_node = (article.get("Abstract") or {}).get("AbstractText") or ""
        abstract = (
            abstract_text_node.get("#text", abstract_text_node)
            if isinstance(abstract_text_node, dict)
            else str(abstract_text_node)
        )

        # Authors
        author_list = (article.get("AuthorList") or {}).get("Author") or []
        if not isinstance(author_list, list):
            author_list = [author_list]
        authors: List[Dict] = []
        for a in author_list:
            if not isinstance(a, dict):
                continue
            last = a.get("LastName", "")
            fore = a.get("ForeName", "")
            authors.append({
                "family_name": last,
                "given_name": fore,
                "full_name": f"{fore} {last}".strip(),
            })

        # DOI from ELocationID
        doi = ""
        eloc = article.get("ELocationID") or []
        if not isinstance(eloc, list):
            eloc = [eloc]
        for loc in eloc:
            if isinstance(loc, dict) and (loc.get("@attributes") or {}).get("EIdType") == "doi":
                doi = loc.get("#text", "")
                break

        return {
            "pmid": str(pmid),
            "title": str(title),
            "authors": authors,
            "journal": str(journal_title),
            "year": str(year),
            "abstract": str(abstract),
            "doi": doi,
        }


# Module-level singleton
_pubmed_client: Optional[PubMedClient] = None


def get_pubmed_client() -> PubMedClient:
    global _pubmed_client
    if _pubmed_client is None:
        _pubmed_client = PubMedClient(
            api_key=os.getenv("PUBMED_API_KEY"),
            email=os.getenv("PUBMED_EMAIL"),
        )
    return _pubmed_client
