"""External academic database integrations — CrossRef, PubMed, Web of Science, Scopus.

Uses synchronous requests with rate limiting. WoS and Scopus require API keys via
environment variables; they degrade gracefully when not configured.
"""
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import requests

logger = logging.getLogger(__name__)

_CROSSREF_BASE = "https://api.crossref.org/works"
_PUBMED_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
_WOS_BASE = "https://api.clarivate.com/api/wos"
_SCOPUS_BASE = "https://api.elsevier.com/content"

_DEFAULT_TIMEOUT = 12  # seconds per request
_RATE_DELAY = 0.35     # seconds between requests to same service


@dataclass
class ExternalPublicationData:
    """Normalised publication record returned by any external source."""
    source: str               # "crossref" | "pubmed" | "wos" | "scopus"
    external_id: str          # DOI / PMID / WoS UT / Scopus EID
    title: str = ""
    authors: List[str] = field(default_factory=list)
    journal: str = ""
    year: int = 0
    volume: str = ""
    issue: str = ""
    pages: str = ""
    doi: str = ""
    pmid: str = ""
    abstract: str = ""
    keywords: List[str] = field(default_factory=list)
    citations_count: int = 0
    pub_type: str = "article"
    is_open_access: bool = False
    url: str = ""
    research_areas: List[str] = field(default_factory=list)
    confidence: float = 1.0

    def to_reference_dict(self) -> Dict:
        """Convert to references.json dict format."""
        return {
            "title": self.title,
            "authors": self.authors,
            "journal": self.journal,
            "year": self.year,
            "doi": self.doi,
            "abstract": self.abstract,
            "entry_type": self.pub_type,
            "external_id": self.external_id,
            "source_db": self.source,
            "citations_count": self.citations_count,
        }


@dataclass
class DatabaseSyncResult:
    """Summary of a sync or enrich operation."""
    success: bool
    source: str
    records_found: int = 0
    records_updated: int = 0
    records_new: int = 0
    errors: List[str] = field(default_factory=list)
    duration_ms: int = 0


# ── CrossRef ──────────────────────────────────────────────────────────────────

class CrossRefService:
    """CrossRef REST API — no authentication required."""

    def __init__(self):
        self._last_call = 0.0
        self._mailto = os.environ.get("CROSSREF_MAILTO", "prionlab@example.org")
        self._session = requests.Session()
        self._session.headers.update({
            "User-Agent": f"PrionLab-Tools/1.0 (mailto:{self._mailto})"
        })

    def _throttle(self):
        elapsed = time.time() - self._last_call
        if elapsed < _RATE_DELAY:
            time.sleep(_RATE_DELAY - elapsed)
        self._last_call = time.time()

    def lookup_doi(self, doi: str) -> Optional[ExternalPublicationData]:
        """Fetch full metadata for a single DOI."""
        self._throttle()
        try:
            r = self._session.get(
                f"{_CROSSREF_BASE}/{doi.strip()}",
                timeout=_DEFAULT_TIMEOUT,
            )
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return self._parse_item(r.json().get("message", {}))
        except Exception as exc:
            logger.warning("CrossRef DOI lookup failed for %s: %s", doi, exc)
            return None

    def search(self, query: str, rows: int = 20) -> List[ExternalPublicationData]:
        """Free-text search against CrossRef."""
        self._throttle()
        try:
            r = self._session.get(
                _CROSSREF_BASE,
                params={"query": query, "rows": rows, "select": (
                    "DOI,title,author,container-title,published,volume,"
                    "issue,page,type,abstract,is-referenced-by-count"
                )},
                timeout=_DEFAULT_TIMEOUT,
            )
            r.raise_for_status()
            items = r.json().get("message", {}).get("items", [])
            return [self._parse_item(i) for i in items if i]
        except Exception as exc:
            logger.warning("CrossRef search failed: %s", exc)
            return []

    def _parse_item(self, item: Dict) -> ExternalPublicationData:
        doi = item.get("DOI", "")
        titles = item.get("title", [])
        title = titles[0] if titles else ""
        authors = [
            f"{a.get('family', '')}, {a.get('given', '')[:1]}."
            for a in item.get("author", [])
            if a.get("family")
        ]
        journals = item.get("container-title", [])
        journal = journals[0] if journals else ""
        pub_date = item.get("published", {}).get("date-parts", [[0]])[0]
        year = pub_date[0] if pub_date else 0
        raw_type = item.get("type", "journal-article")
        pub_type = _map_crossref_type(raw_type)
        return ExternalPublicationData(
            source="crossref",
            external_id=doi,
            title=title,
            authors=authors,
            journal=journal,
            year=int(year) if year else 0,
            volume=item.get("volume", ""),
            issue=item.get("issue", ""),
            pages=item.get("page", ""),
            doi=doi,
            abstract=_strip_jats(item.get("abstract", "")),
            citations_count=item.get("is-referenced-by-count", 0),
            pub_type=pub_type,
            url=item.get("URL", ""),
            confidence=0.95,
        )


# ── PubMed ─────────────────────────────────────────────────────────────────────

class PubMedService:
    """NCBI E-utilities — no authentication required for public access."""

    def __init__(self):
        self._last_call = 0.0
        self._session = requests.Session()
        self._api_key = os.environ.get("NCBI_API_KEY", "")  # optional; raises rate limit

    def _throttle(self):
        delay = 0.11 if self._api_key else _RATE_DELAY
        elapsed = time.time() - self._last_call
        if elapsed < delay:
            time.sleep(delay - elapsed)
        self._last_call = time.time()

    def _params(self, extra: Dict) -> Dict:
        p = {"retmode": "json", "db": "pubmed", **extra}
        if self._api_key:
            p["api_key"] = self._api_key
        return p

    def search(self, query: str, max_results: int = 20) -> List[ExternalPublicationData]:
        """Search PubMed and return full records."""
        pmids = self._esearch(query, max_results)
        if not pmids:
            return []
        return self._efetch(pmids)

    def fetch_pmid(self, pmid: str) -> Optional[ExternalPublicationData]:
        """Fetch a single record by PMID."""
        results = self._efetch([pmid])
        return results[0] if results else None

    def _esearch(self, query: str, retmax: int) -> List[str]:
        self._throttle()
        try:
            r = self._session.get(
                f"{_PUBMED_BASE}/esearch.fcgi",
                params=self._params({"term": query, "retmax": retmax}),
                timeout=_DEFAULT_TIMEOUT,
            )
            r.raise_for_status()
            return r.json().get("esearchresult", {}).get("idlist", [])
        except Exception as exc:
            logger.warning("PubMed esearch failed: %s", exc)
            return []

    def _efetch(self, pmids: List[str]) -> List[ExternalPublicationData]:
        self._throttle()
        try:
            r = self._session.get(
                f"{_PUBMED_BASE}/efetch.fcgi",
                params=self._params({"id": ",".join(pmids), "rettype": "abstract"}),
                timeout=_DEFAULT_TIMEOUT,
            )
            r.raise_for_status()
            # PubMed JSON fetch not available for abstract rettype; use summary instead
        except Exception:
            pass

        # Use esummary for structured JSON
        self._throttle()
        try:
            r = self._session.get(
                f"{_PUBMED_BASE}/esummary.fcgi",
                params=self._params({"id": ",".join(pmids)}),
                timeout=_DEFAULT_TIMEOUT,
            )
            r.raise_for_status()
            result = r.json().get("result", {})
            out = []
            for pmid in pmids:
                item = result.get(pmid, {})
                if item:
                    out.append(self._parse_summary(item, pmid))
            return out
        except Exception as exc:
            logger.warning("PubMed efetch failed: %s", exc)
            return []

    def _parse_summary(self, item: Dict, pmid: str) -> ExternalPublicationData:
        authors = [a.get("name", "") for a in item.get("authors", []) if a.get("name")]
        pub_types = item.get("pubtype", [])
        pub_type = _map_pubmed_type(pub_types)
        year_str = item.get("pubdate", "")[:4]
        try:
            year = int(year_str)
        except ValueError:
            year = 0
        doi = ""
        for art_id in item.get("articleids", []):
            if art_id.get("idtype") == "doi":
                doi = art_id.get("value", "")
        return ExternalPublicationData(
            source="pubmed",
            external_id=pmid,
            title=item.get("title", "").rstrip("."),
            authors=authors,
            journal=item.get("source", ""),
            year=year,
            volume=item.get("volume", ""),
            issue=item.get("issue", ""),
            pages=item.get("pages", ""),
            doi=doi,
            pmid=pmid,
            pub_type=pub_type,
            url=f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
            confidence=0.98,
        )


# ── Web of Science ─────────────────────────────────────────────────────────────

class WebOfScienceService:
    """Clarivate Web of Science API — requires WOS_API_KEY env var."""

    def __init__(self):
        self._api_key = os.environ.get("WOS_API_KEY", "")
        self._last_call = 0.0
        self._session = requests.Session()
        if self._api_key:
            self._session.headers.update({"X-ApiKey": self._api_key})

    @property
    def is_configured(self) -> bool:
        return bool(self._api_key)

    def _throttle(self):
        elapsed = time.time() - self._last_call
        if elapsed < _RATE_DELAY:
            time.sleep(_RATE_DELAY - elapsed)
        self._last_call = time.time()

    def search(self, query: str, max_results: int = 20) -> List[ExternalPublicationData]:
        if not self.is_configured:
            return []
        self._throttle()
        try:
            r = self._session.get(
                f"{_WOS_BASE}/query",
                params={"usrQuery": query, "count": max_results, "firstRecord": 1},
                timeout=_DEFAULT_TIMEOUT,
            )
            r.raise_for_status()
            records = r.json().get("Data", {}).get("Records", {}).get("records", {}).get("REC", [])
            if isinstance(records, dict):
                records = [records]
            return [self._parse_record(rec) for rec in records if rec]
        except Exception as exc:
            logger.warning("WoS search failed: %s", exc)
            return []

    def get_citations(self, ut: str) -> int:
        """Return citation count for a WoS UT identifier."""
        if not self.is_configured:
            return 0
        self._throttle()
        try:
            r = self._session.get(
                f"{_WOS_BASE}/{ut}/citations",
                timeout=_DEFAULT_TIMEOUT,
            )
            r.raise_for_status()
            return r.json().get("Data", {}).get("Records", {}).get("QueryResult", {}).get("RecordsFound", 0)
        except Exception:
            return 0

    def _parse_record(self, rec: Dict) -> ExternalPublicationData:
        static = rec.get("static_data", {})
        summary = static.get("summary", {})
        names = summary.get("names", {}).get("name", [])
        if isinstance(names, dict):
            names = [names]
        authors = [
            f"{n.get('last_name', '')}, {(n.get('first_name') or n.get('initials', ''))[:1]}."
            for n in names if n.get("role") == "author" and n.get("last_name")
        ]
        titles = summary.get("titles", {}).get("title", [])
        if isinstance(titles, dict):
            titles = [titles]
        title = next((t.get("content", "") for t in titles if t.get("type") == "item"), "")
        source = next((t.get("content", "") for t in titles if t.get("type") == "source"), "")
        pub_info = summary.get("pub_info", {})
        year = int(pub_info.get("pubyear", 0) or 0)
        ut = rec.get("UID", "")
        doi = ""
        for id_item in static.get("item", {}).get("identifiers", {}).get("identifier", []):
            if isinstance(id_item, dict) and id_item.get("type") == "doi":
                doi = id_item.get("value", "")
        return ExternalPublicationData(
            source="wos",
            external_id=ut,
            title=title,
            authors=authors,
            journal=source,
            year=year,
            volume=pub_info.get("vol", ""),
            issue=pub_info.get("issue", ""),
            pages=summary.get("page", {}).get("content", ""),
            doi=doi,
            pub_type="article",
            confidence=0.97,
        )


# ── Scopus ─────────────────────────────────────────────────────────────────────

class ScopusService:
    """Elsevier Scopus API — requires SCOPUS_API_KEY env var."""

    def __init__(self):
        self._api_key = os.environ.get("SCOPUS_API_KEY", "")
        self._last_call = 0.0
        self._session = requests.Session()
        if self._api_key:
            self._session.headers.update({
                "X-ELS-APIKey": self._api_key,
                "Accept": "application/json",
            })

    @property
    def is_configured(self) -> bool:
        return bool(self._api_key)

    def _throttle(self):
        elapsed = time.time() - self._last_call
        if elapsed < _RATE_DELAY:
            time.sleep(_RATE_DELAY - elapsed)
        self._last_call = time.time()

    def search(self, query: str, max_results: int = 20) -> List[ExternalPublicationData]:
        if not self.is_configured:
            return []
        self._throttle()
        try:
            r = self._session.get(
                f"{_SCOPUS_BASE}/search/scopus",
                params={
                    "query": query, "count": max_results,
                    "field": "dc:title,dc:creator,prism:publicationName,"
                             "prism:coverDate,prism:doi,prism:volume,"
                             "prism:issueIdentifier,prism:pageRange,"
                             "citedby-count,eid,openaccess",
                },
                timeout=_DEFAULT_TIMEOUT,
            )
            r.raise_for_status()
            entries = r.json().get("search-results", {}).get("entry", [])
            return [self._parse_entry(e) for e in entries if e]
        except Exception as exc:
            logger.warning("Scopus search failed: %s", exc)
            return []

    def get_abstract(self, eid: str) -> str:
        """Fetch abstract for a Scopus EID."""
        if not self.is_configured:
            return ""
        self._throttle()
        try:
            r = self._session.get(
                f"{_SCOPUS_BASE}/abstract/scopus_id/{eid.split('-')[-1]}",
                timeout=_DEFAULT_TIMEOUT,
            )
            r.raise_for_status()
            core = r.json().get("abstracts-retrieval-response", {})
            return core.get("coredata", {}).get("dc:description", "")
        except Exception:
            return ""

    def _parse_entry(self, entry: Dict) -> ExternalPublicationData:
        cover_date = entry.get("prism:coverDate", "")[:4]
        try:
            year = int(cover_date)
        except ValueError:
            year = 0
        author_raw = entry.get("dc:creator", "")
        authors = [a.strip() for a in author_raw.split(";") if a.strip()]
        return ExternalPublicationData(
            source="scopus",
            external_id=entry.get("eid", ""),
            title=entry.get("dc:title", ""),
            authors=authors,
            journal=entry.get("prism:publicationName", ""),
            year=year,
            volume=entry.get("prism:volume", ""),
            issue=entry.get("prism:issueIdentifier", ""),
            pages=entry.get("prism:pageRange", ""),
            doi=entry.get("prism:doi", ""),
            citations_count=int(entry.get("citedby-count", 0) or 0),
            is_open_access=bool(entry.get("openaccess")),
            url=entry.get("link", [{}])[0].get("@href", "") if entry.get("link") else "",
            confidence=0.97,
        )


# ── Integration orchestrator ───────────────────────────────────────────────────

class ExternalDatabaseIntegrationService:
    """Orchestrates searches and enrichment across all configured sources."""

    def __init__(self):
        self._crossref = CrossRefService()
        self._pubmed = PubMedService()
        self._wos = WebOfScienceService()
        self._scopus = ScopusService()

    # ── Status ────────────────────────────────────────────────────────────────

    def get_status(self) -> Dict:
        return {
            "crossref": {"configured": True, "available": True, "auth": "none"},
            "pubmed": {"configured": True, "available": True, "auth": "optional"},
            "wos": {"configured": self._wos.is_configured, "available": self._wos.is_configured, "auth": "api_key"},
            "scopus": {"configured": self._scopus.is_configured, "available": self._scopus.is_configured, "auth": "api_key"},
        }

    # ── Search ────────────────────────────────────────────────────────────────

    def search_all(
        self,
        query: str,
        sources: Optional[List[str]] = None,
        max_per_source: int = 15,
    ) -> List[Dict]:
        """Search across selected (or all) sources; merge and deduplicate by DOI."""
        if sources is None:
            sources = ["crossref", "pubmed", "wos", "scopus"]
        all_results: List[ExternalPublicationData] = []

        if "crossref" in sources:
            all_results.extend(self._crossref.search(query, max_per_source))
        if "pubmed" in sources:
            all_results.extend(self._pubmed.search(query, max_per_source))
        if "wos" in sources and self._wos.is_configured:
            all_results.extend(self._wos.search(query, max_per_source))
        if "scopus" in sources and self._scopus.is_configured:
            all_results.extend(self._scopus.search(query, max_per_source))

        return self._deduplicate(all_results)

    # ── Enrich ────────────────────────────────────────────────────────────────

    def enrich_reference(self, ref: Dict) -> Tuple[Dict, DatabaseSyncResult]:
        """Enrich a single reference dict with data from external sources."""
        t0 = time.time()
        result = DatabaseSyncResult(success=False, source="multi")
        enriched = dict(ref)
        updated_fields: List[str] = []

        doi = ref.get("doi", "").strip()
        pmid = ref.get("pmid", "").strip()

        ext: Optional[ExternalPublicationData] = None

        if doi:
            ext = self._crossref.lookup_doi(doi)
        if ext is None and pmid:
            ext = self._pubmed.fetch_pmid(pmid)
        if ext is None and doi:
            # Try PubMed search by DOI
            hits = self._pubmed.search(f'"{doi}"[AID]', 3)
            ext = hits[0] if hits else None

        if ext:
            for src_key, dst_key in [
                ("title", "title"), ("journal", "journal"), ("year", "year"),
                ("volume", "volume"), ("issue", "issue"), ("pages", "pages"),
                ("abstract", "abstract"), ("doi", "doi"),
            ]:
                src_val = getattr(ext, src_key, None)
                if src_val and not enriched.get(dst_key):
                    enriched[dst_key] = src_val
                    updated_fields.append(dst_key)
            if ext.authors and not enriched.get("authors"):
                enriched["authors"] = ext.authors
                updated_fields.append("authors")
            if ext.citations_count and not enriched.get("citations_count"):
                enriched["citations_count"] = ext.citations_count
                updated_fields.append("citations_count")
            result.success = True
            result.records_found = 1
            result.records_updated = 1 if updated_fields else 0
        else:
            result.errors.append(f"No external data found for ref {ref.get('reference_id', '?')}")

        result.duration_ms = int((time.time() - t0) * 1000)
        return enriched, result

    def enrich_manuscript_references(
        self, refs: List[Dict], max_refs: int = 50
    ) -> DatabaseSyncResult:
        """Batch-enrich a manuscript's references. Returns aggregate stats."""
        t0 = time.time()
        aggregate = DatabaseSyncResult(success=True, source="multi")
        for ref in refs[:max_refs]:
            _, r = self.enrich_reference(ref)
            aggregate.records_found += r.records_found
            aggregate.records_updated += r.records_updated
            aggregate.errors.extend(r.errors)
        aggregate.duration_ms = int((time.time() - t0) * 1000)
        return aggregate

    def get_global_citations(self, doi: str = "", pmid: str = "") -> Dict:
        """Aggregate citation counts from all available sources."""
        counts: Dict[str, int] = {}
        if doi:
            ext = self._crossref.lookup_doi(doi)
            if ext:
                counts["crossref"] = ext.citations_count
        if pmid:
            ext_pm = self._pubmed.fetch_pmid(pmid)
            if ext_pm and ext_pm.citations_count:
                counts["pubmed"] = ext_pm.citations_count
        if self._scopus.is_configured and doi:
            results = self._scopus.search(f"DOI({doi})", 1)
            if results:
                counts["scopus"] = results[0].get("citations_count", 0)
        total = max(counts.values()) if counts else 0
        return {"doi": doi, "pmid": pmid, "citations": counts, "total_max": total}

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _deduplicate(self, records: List[ExternalPublicationData]) -> List[Dict]:
        """Merge records with the same DOI; prefer higher-confidence sources."""
        seen_doi: Dict[str, Dict] = {}
        no_doi: List[Dict] = []
        for rec in records:
            d = {
                "source": rec.source,
                "external_id": rec.external_id,
                "title": rec.title,
                "authors": rec.authors,
                "journal": rec.journal,
                "year": rec.year,
                "volume": rec.volume,
                "issue": rec.issue,
                "pages": rec.pages,
                "doi": rec.doi,
                "pmid": rec.pmid,
                "abstract": rec.abstract,
                "keywords": rec.keywords,
                "citations_count": rec.citations_count,
                "pub_type": rec.pub_type,
                "is_open_access": rec.is_open_access,
                "url": rec.url,
                "confidence": rec.confidence,
            }
            key = rec.doi.lower().strip() if rec.doi else ""
            if key:
                if key not in seen_doi:
                    seen_doi[key] = d
                else:
                    existing = seen_doi[key]
                    # Merge: fill empty fields; prefer highest citations_count
                    for k in ("title", "abstract", "volume", "issue", "pages", "journal"):
                        if not existing.get(k) and d.get(k):
                            existing[k] = d[k]
                    if d["citations_count"] > existing.get("citations_count", 0):
                        existing["citations_count"] = d["citations_count"]
                    if not existing.get("pmid") and d.get("pmid"):
                        existing["pmid"] = d["pmid"]
            else:
                no_doi.append(d)
        return list(seen_doi.values()) + no_doi


# ── Module-level singleton ─────────────────────────────────────────────────────

_integration_service: Optional[ExternalDatabaseIntegrationService] = None


def get_external_db_service() -> ExternalDatabaseIntegrationService:
    global _integration_service
    if _integration_service is None:
        _integration_service = ExternalDatabaseIntegrationService()
    return _integration_service


# ── Helpers ───────────────────────────────────────────────────────────────────

def _map_crossref_type(raw: str) -> str:
    mapping = {
        "journal-article": "article",
        "proceedings-article": "conference",
        "book-chapter": "book_chapter",
        "posted-content": "preprint",
        "review-article": "review",
        "book": "book",
    }
    return mapping.get(raw, "article")


def _map_pubmed_type(pub_types: List[str]) -> str:
    lower = [t.lower() for t in pub_types]
    if any("review" in t for t in lower):
        return "review"
    if any("preprint" in t for t in lower):
        return "preprint"
    if any("conference" in t or "proceedings" in t for t in lower):
        return "conference"
    return "article"


def _strip_jats(text: str) -> str:
    """Remove JATS XML tags from CrossRef abstract strings."""
    if not text:
        return ""
    return re.sub(r"<[^>]+>", "", text).strip()
