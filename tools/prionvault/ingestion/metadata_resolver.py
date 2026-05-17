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
_PUBMED_ESEARCH  = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
_PUBMED_ESUMMARY = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"
_PUBMED_EFETCH   = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"

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

    def __post_init__(self):
        # Centralised cleanup: every Metadata object — no matter which
        # resolver built it — goes through the same tidy pass, so
        # callers don't have to remember to call clean_metadata_text.
        from ..services.text_cleanup import clean_metadata_text
        for fld in ("title", "authors", "journal", "abstract"):
            v = getattr(self, fld, None)
            if v:
                setattr(self, fld, clean_metadata_text(v))


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
        # Raw — Metadata.__post_init__ runs clean_metadata_text, which
        # decodes entities and turns <jats:sup>X</jats:sup> into Unicode
        # superscripts. Doing it here too would strip the tags before
        # the Unicode pass ever sees them.
        abstract=data.get("abstract"),
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
        abstract=best.get("abstract"),  # cleaned via __post_init__
        source="title_search",
        raw=best,
    )


# ── PubMed E-utilities ──────────────────────────────────────────────────────
def pubmed_efetch_abstract(pmid: str) -> Optional[str]:
    """Pull just the abstract text for a PMID via efetch.

    esummary (used by the two pubmed_by_* helpers below for cheap
    metadata) DOES NOT include the abstract — that lives only in the
    XML returned by efetch with rettype=abstract. Handles both:

      <Abstract>
        <AbstractText>plain single paragraph</AbstractText>
      </Abstract>

    and the structured form many journals (PLoS, BMC, …) use:

      <Abstract>
        <AbstractText Label="BACKGROUND">…</AbstractText>
        <AbstractText Label="METHODS">…</AbstractText>
        <AbstractText Label="RESULTS">…</AbstractText>
        <AbstractText Label="CONCLUSION">…</AbstractText>
      </Abstract>

    Structured sections are joined back together with their labels so
    the result reads naturally.
    """
    if not pmid:
        return None
    try:
        r = requests.get(_PUBMED_EFETCH, params={
            "db":      "pubmed",
            "id":      pmid,
            "rettype": "abstract",
            "retmode": "xml",
        }, headers={"User-Agent": _USER_AGENT, "Accept": "application/xml"},
           timeout=_TIMEOUT)
        r.raise_for_status()
    except Exception as exc:
        logger.debug("PubMed efetch abstract for %s failed: %s", pmid, exc)
        return None

    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(r.content)
    except ET.ParseError as exc:
        logger.debug("PubMed efetch returned invalid XML for %s: %s", pmid, exc)
        return None

    parts = []
    for at in root.iter("AbstractText"):
        # itertext() concatenates text across nested inline tags
        # (<i>, <sup>, …) which the JATS-ish abstract often uses.
        text = "".join(at.itertext()).strip()
        if not text:
            continue
        label = (at.get("Label") or "").strip()
        parts.append(f"{label}: {text}" if label else text)
    if not parts:
        return None
    return "\n\n".join(parts)



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
        abstract=pubmed_efetch_abstract(pmid),
        source="pubmed",
        raw=summary,
    )


def pubmed_by_pmid(pmid: str) -> Optional[Metadata]:
    """Fetch metadata from PubMed using a PMID directly (no esearch needed).

    Also tries to extract the DOI from the ArticleIdList so CrossRef can
    later fill gaps (abstract, etc.).
    """
    if not pmid:
        return None
    try:
        r = requests.get(_PUBMED_ESUMMARY, params={
            "db": "pubmed",
            "id": pmid,
            "retmode": "json",
        }, headers=_HDRS, timeout=_TIMEOUT)
        r.raise_for_status()
    except Exception as exc:
        logger.debug("PubMed esummary by PMID %s failed: %s", pmid, exc)
        return None

    summary = (r.json().get("result") or {}).get(pmid) or {}
    if not summary or summary.get("uid") != pmid:
        return None

    # PubMed ArticleIdList often contains the DOI.
    doi = None
    for aid in summary.get("articleids") or []:
        if (aid.get("idtype") or "").lower() == "doi":
            raw = (aid.get("value") or "").strip().lower()
            if raw:
                doi = raw
                break

    authors = "; ".join(
        (a.get("name") or "").strip()
        for a in (summary.get("authors") or [])
        if a.get("name")
    ) or None

    year = None
    m = re.match(r"(\d{4})", summary.get("pubdate") or "")
    if m:
        year = int(m.group(1))

    return Metadata(
        doi=doi,
        pubmed_id=pmid,
        title=(summary.get("title") or "").rstrip(".").strip() or None,
        authors=authors,
        journal=summary.get("fulljournalname") or summary.get("source"),
        year=year,
        volume=summary.get("volume"),
        issue=summary.get("issue"),
        pages=summary.get("pages"),
        abstract=pubmed_efetch_abstract(pmid),
        source="pubmed_pmid",
        raw=summary,
    )


def pubmed_search_pmid_by_title(title: str,
                                author: Optional[str] = None,
                                year: Optional[int] = None) -> Optional[str]:
    """Find a PMID from a title fragment (+ optional author surname / year).

    Used by the AI-assisted PMID lookup: the model returns a title from
    PDF text, and we resolve it through PubMed esearch. We trim to the
    first ~10 words because long titles with punctuation routinely
    break PubMed's parser, and the first 10 are essentially unique.
    Tries the narrowest query first and progressively relaxes.
    """
    if not title:
        return None

    words = re.sub(r"[^\w\s-]+", " ", title, flags=re.UNICODE).split()
    if not words:
        return None
    title_part = " ".join(words[:10])

    author_part = None
    if author:
        a = re.sub(r"[^\w\s-]+", "", author, flags=re.UNICODE).strip()
        if a:
            author_part = a

    tiers = []
    base = f'"{title_part}"[Title]'
    if author_part and year:
        tiers.append(f'{base} AND {author_part}[Author] AND {year}[PDAT]')
    if author_part:
        tiers.append(f'{base} AND {author_part}[Author]')
    if year:
        tiers.append(f'{base} AND {year}[PDAT]')
    tiers.append(base)
    # Looser fallbacks. The [Title] phrase operator is strict about
    # token order and punctuation — papers with colons / parentheses
    # in their titles routinely fail the strict tiers but resolve
    # cleanly when we drop the field qualifier and let PubMed's
    # default index (Title + Abstract + MeSH) handle the search.
    if author_part:
        tiers.append(f'{title_part} AND {author_part}[Author]')
    tiers.append(title_part)

    for term in tiers:
        try:
            r = requests.get(_PUBMED_ESEARCH, params={
                "db":      "pubmed",
                "term":    term,
                "retmax":  "1",
                "retmode": "json",
                # Best-match ranking is what PubMed's web search box
                # uses; without it esearch returns most-recent first,
                # which can bury the actual paper.
                "sort":    "relevance",
            }, headers=_HDRS, timeout=_TIMEOUT)
            r.raise_for_status()
        except Exception as exc:
            logger.debug("PubMed esearch by title tier failed (%s): %s", term, exc)
            continue
        ids = ((r.json().get("esearchresult") or {}).get("idlist")) or []
        if ids:
            return ids[0]
    return None


# ── Public entrypoint ───────────────────────────────────────────────────────
def resolve_metadata(*, doi: Optional[str] = None,
                     pmid_hint: Optional[str] = None,
                     title_hint: Optional[str] = None) -> Optional[Metadata]:
    """Try the resolver chain. Returns None only if EVERY step fails.

    Priority order:
      1. DOI  → CrossRef (best metadata) → PubMed-by-DOI
      2. PMID → PubMed-by-PMID; then CrossRef-by-title to recover the DOI
      3. Title hint → CrossRef title search
    """
    if doi:
        meta = crossref_by_doi(doi)
        if meta and meta.title:
            return meta
        # PubMed fallback (sometimes has data when CrossRef doesn't).
        meta = pubmed_by_doi(doi)
        if meta and meta.title:
            return meta

    if pmid_hint and not doi:
        meta = pubmed_by_pmid(pmid_hint)
        if meta and meta.title:
            # If PubMed didn't return a DOI, try CrossRef by title to get one.
            if not meta.doi and meta.title:
                cr = crossref_by_title(meta.title, year_hint=meta.year)
                if cr and cr.doi:
                    meta.doi = cr.doi
                    # Also enrich with CrossRef abstract if PubMed had none.
                    if not meta.abstract and cr.abstract:
                        meta.abstract = cr.abstract
            return meta

    if title_hint:
        meta = crossref_by_title(title_hint)
        if meta and meta.title:
            return meta
    return None
