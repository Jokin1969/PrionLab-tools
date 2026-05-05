"""Resolve a paper's bibliographic metadata from a DOI / title.

Pipeline:
  1. If we have a DOI, query CrossRef (api.crossref.org/works/<doi>).
     Free, no auth needed, very fast.
  2. If CrossRef misses or has no DOI, query PubMed E-utilities by DOI
     or title. Also free.
  3. Last resort: try a CrossRef title-search and pick the best match.

All three calls are wrapped with short timeouts and fail soft — the
worker handles the absence of metadata as a separate state.
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from typing import Optional, List
from urllib.parse import quote

import requests

logger = logging.getLogger(__name__)

# Polite identification — CrossRef rate-limits anonymous traffic less
# aggressively when the User-Agent identifies the project + a contact.
_USER_AGENT = (
    "PrionVault/1.0 (https://prionlab-tools.up.railway.app; "
    "mailto:hesti@cicbiogune.es) python-requests"
)

_CROSSREF_WORKS = "https://api.crossref.org/works/"
_CROSSREF_QUERY = "https://api.crossref.org/works"
_PUBMED_ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
_PUBMED_ESUMMARY = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"

_TIMEOUT = 8.0  # seconds — CrossRef occasionally takes 5-6 s
_HDRS = {"User-Agent": _USER_AGENT, "Accept": "application/json"}


@dataclass
class Metadata:
    doi:       Optional[str] = None
    pubmed_id: Optional[str] = None
    title:     Optional[str] = None
    authors:   Optional[str] = None  # "Smith J; Doe A" — comma/semicolon list
    journal:   Optional[str] = None
    year:      Optional[int] = None
    volume:    Optional[str] = None
    issue:     Optional[str] = None
    pages:     Optional[str] = None
    abstract:  Optional[str] = None
    source:    Optional[str] = None  # "crossref" | "pubmed" | "title_search"
    raw:       dict = field(default_factory=dict)


# ── CrossRef ────────────────────────────────────────────────────────────────
def _format_authors(items: list) -> Optional[str]:
    parts = []
    for a in items or []:
        family = (a.get("family") or "").strip()
        given  = (a.get("given") or "").strip()
        if not family and not given:
            continue
        if given:
            initials = ".".join(p[0] for p in given.split() if p) + "."
            parts.append(f"{family} {initials}")
        else:
            parts.append(family)
    return "; ".join(parts) or None


def _crossref_year(msg: dict) -> Optional[int]:
    for k in ("published-print", "published-online", "issued", "created"):
        block = msg.get(k) or {}
        parts = block.get("date-parts") or []
        if parts and parts[0]:
            try:
                return int(parts[0][0])
            except (ValueError, TypeError):
                continue
    return None


def _crossref_clean_abstract(html: Optional[str]) -> Optional[str]:
    if not html:
        return None
    # CrossRef wraps abstracts in <jats:p>...</jats:p>. Strip.
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


def crossref_by_doi(doi: str) -> Optional[Metadata]:
    if not doi:
        return None
    try:
        r = requests.get(_CROSSREF_WORKS + quote(doi, safe=""),
                         headers=_HDRS, timeout=_TIMEOUT)
        if r.status_code == 404:
            return None
        r.raise_for_status()
    except Exception as exc:
        logger.debug("CrossRef lookup failed for %s: %s", doi, exc)
        return None

    data = r.json().get("message") or {}
    title_list = data.get("title") or []
    title = title_list[0].strip() if title_list else None
    journal_list = data.get("container-title") or []
    journal = journal_list[0] if journal_list else None

    return Metadata(
        doi=(data.get("DOI") or doi).lower(),
        title=title,
        authors=_format_authors(data.get("author") or []),
        journal=journal,
        year=_crossref_year(data),
        volume=data.get("volume"),
        issue=data.get("issue"),
        pages=data.get("page"),
        abstract=_crossref_clean_abstract(data.get("abstract")),
        source="crossref",
        raw=data,
    )


def crossref_by_title(title_hint: str, year_hint: Optional[int] = None,
                      max_results: int = 3) -> Optional[Metadata]:
    """Fallback: search CrossRef by query title and pick the best match."""
    if not title_hint or len(title_hint) < 12:
        return None
    params = {
        "query.title": title_hint[:200],
        "rows": max_results,
        "select": "DOI,title,author,container-title,issued,published-print,abstract,volume,issue,page",
    }
    if year_hint:
        params["filter"] = f"from-pub-date:{year_hint},until-pub-date:{year_hint}"

    try:
        r = requests.get(_CROSSREF_QUERY, params=params,
                         headers=_HDRS, timeout=_TIMEOUT)
        r.raise_for_status()
    except Exception as exc:
        logger.debug("CrossRef title search failed: %s", exc)
        return None

    items = (r.json().get("message") or {}).get("items") or []
    if not items:
        return None
    # CrossRef returns by relevance; trust the first match as long as the
    # title overlaps with our hint at >= 70% of words.
    best = items[0]
    best_title_list = best.get("title") or []
    best_title = (best_title_list[0] if best_title_list else "").lower()
    hint_words = set(re.findall(r"\w+", title_hint.lower()))
    best_words = set(re.findall(r"\w+", best_title))
    if hint_words and best_words:
        overlap = len(hint_words & best_words) / max(1, len(hint_words))
        if overlap < 0.5:
            return None  # too dissimilar, don't risk a wrong match
    journal_list = best.get("container-title") or []
    return Metadata(
        doi=(best.get("DOI") or "").lower() or None,
        title=best_title_list[0] if best_title_list else None,
        authors=_format_authors(best.get("author") or []),
        journal=journal_list[0] if journal_list else None,
        year=_crossref_year(best),
        volume=best.get("volume"),
        issue=best.get("issue"),
        pages=best.get("page"),
        abstract=_crossref_clean_abstract(best.get("abstract")),
        source="title_search",
        raw=best,
    )


# ── PubMed E-utilities ──────────────────────────────────────────────────────
def pubmed_by_doi(doi: str) -> Optional[Metadata]:
    if not doi:
        return None
    try:
        r = requests.get(_PUBMED_ESEARCH, params={
            "db": "pubmed",
            "term": f"{doi}[doi]",
            "retmode": "json",
        }, headers=_HDRS, timeout=_TIMEOUT)
        r.raise_for_status()
    except Exception as exc:
        logger.debug("PubMed esearch failed: %s", exc)
        return None

    ids = ((r.json().get("esearchresult") or {}).get("idlist")) or []
    if not ids:
        return None
    pmid = ids[0]

    try:
        r = requests.get(_PUBMED_ESUMMARY, params={
            "db": "pubmed",
            "id": pmid,
            "retmode": "json",
        }, headers=_HDRS, timeout=_TIMEOUT)
        r.raise_for_status()
    except Exception as exc:
        logger.debug("PubMed esummary failed: %s", exc)
        return None

    summary = (r.json().get("result") or {}).get(pmid) or {}
    if not summary:
        return None

    authors = "; ".join((a.get("name") or "").strip()
                        for a in (summary.get("authors") or [])
                        if a.get("name")) or None
    year = None
    pubdate = summary.get("pubdate") or ""
    m = re.match(r"(\d{4})", pubdate)
    if m:
        year = int(m.group(1))

    return Metadata(
        doi=doi,
        pubmed_id=pmid,
        title=(summary.get("title") or "").strip() or None,
        authors=authors,
        journal=summary.get("fulljournalname") or summary.get("source"),
        year=year,
        volume=summary.get("volume"),
        issue=summary.get("issue"),
        pages=summary.get("pages"),
        source="pubmed",
        raw=summary,
    )


# ── Public entrypoint ───────────────────────────────────────────────────────
def resolve_metadata(*, doi: Optional[str] = None,
                     title_hint: Optional[str] = None) -> Optional[Metadata]:
    """Try the resolver chain. Returns None only if EVERY step fails."""
    if doi:
        meta = crossref_by_doi(doi)
        if meta and meta.title:
            return meta
        # PubMed fallback (sometimes has data when CrossRef doesn't).
        meta = pubmed_by_doi(doi)
        if meta and meta.title:
            return meta
    if title_hint:
        meta = crossref_by_title(title_hint)
        if meta and meta.title:
            return meta
    return None
