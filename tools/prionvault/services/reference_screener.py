"""Reference-list screener.

Parses a free-text list of references (Vancouver / similar styles) and
returns, per entry:

  - Which identifiers were found (PMID / PMCID / DOI).
  - Whether that paper is already in PrionVault (matched by pubmed_id,
    doi or pmc_id).
  - The best metadata we can pull from CrossRef + PubMed.
  - Whether we expect a freely-downloadable PDF (PMC ID present, or
    Unpaywall reports an OA copy).

Used by the "Cribar lista de referencias" modal so the operator can
paste a paper's bibliography and see in seconds what's missing, what's
already there, and what would import with PDF vs metadata only.
"""
from __future__ import annotations

import logging
import re
from typing import Optional

from sqlalchemy import text as sql_text

from ..ingestion.queue import _get_engine

logger = logging.getLogger(__name__)


# ── Parsing ─────────────────────────────────────────────────────────────────

# Bibliographies usually number their entries. A leading "12. " at the
# start of a line is the most reliable way to split them — fall back
# on blank lines if the text is unstructured.
_ENTRY_PREFIX_RE = re.compile(r"(?m)^\s*\d+\s*[.)]\s+")

# Pasted spreadsheet/table rows ("1\tPrusiner 1998, PNAS\t10.1073/...")
# number their rows too, but with a TAB after the number instead of a
# "." or ")" — needs its own split pattern. Only trusted as the active
# strategy when it matches at least twice (see parse_text), so a
# one-off "3\tfoo" inside an unrelated paragraph doesn't misfire.
_ROW_PREFIX_RE = re.compile(r"(?m)^\s*\d+\s*\t")

# Citation-list exports (e.g. copy-pasted from a chatbot's "Sources"
# list) number entries as one or more bracketed markers at the start of
# a line — "[1] [3] [8] ... " — because several in-text citations can
# point at the same source. The whole run of bracket markers is one
# separator; everything up to the next such run (title line, domain
# label, one or two repeated URLs) belongs to that entry. Only trusted
# when it matches at least twice, same reasoning as the table-row regex.
_BRACKET_PREFIX_RE = re.compile(r"(?m)^\s*(?:\[\d+\]\s*)+")

# A pasted table's header row ("#\tReferencia abreviada\tDOI") isn't a
# reference — drop it instead of showing it as a confusing
# "unparseable" first entry.
_HEADER_ROW_RE = re.compile(r"referencia\s+abreviada", re.IGNORECASE)

# Identifier extractors. Tolerant of extra spacing / punctuation around
# the value, and case-insensitive on the keyword.
_PMID_RE = re.compile(r"\bPMID\s*[:#]?\s*(\d{4,9})\b", re.IGNORECASE)
# Standalone "PMID 12345" without colon (the user's example has both).
_PMID_WORD_RE = re.compile(r"\bPubMed\s+PMID\s*[:#]?\s*(\d{4,9})\b", re.IGNORECASE)
_PMCID_RE = re.compile(r"\b(PMC\d{4,9})\b")
# A bare PubMed link with no "PMID:" label — pubmed.ncbi.nlm.nih.gov/
# <pmid>/, often with a tracking querystring tacked on
# ("?utm_source=chatgpt.com"). Common in citation lists exported from
# chatbots / browser "Sources" panels, which link straight to PubMed
# instead of spelling out "PMID".
_PMID_URL_RE = re.compile(r"pubmed\.ncbi\.nlm\.nih\.gov/(\d{4,9})", re.IGNORECASE)
# DOIs end at whitespace, common punctuation, or sentence-ending dot
# followed by space. ")" is deliberately NOT excluded here — real DOIs
# can contain a balanced parenthetical (e.g. "10.1016/S1474-4422(22)
# 00082-5"); excluding it truncates those mid-identifier. Any actually
# unbalanced trailing ")" (from the DOI sitting inside a sentence's own
# parentheses) gets stripped in _normalise_doi instead, where we can
# check paren balance. "?", "#" and a further "/" are all excluded from
# the suffix — a DOI embedded in a URL path (e.g. a journal landing
# page ".../10.3389/abp.2026.15939/full?utm_source=...") must stop at
# the DOI itself, not swallow the rest of the URL's path/query/fragment;
# a genuine DOI suffix essentially never contains another "/".
_DOI_RE = re.compile(r"\b(10\.\d{4,}/[^\s'\";,>\]?#/]+)", re.IGNORECASE)

_MAX_ENTRIES = 200            # safety cap; the modal isn't a bulk importer
_MAX_TEXT_CHARS = 200_000     # ~50 KB of pasted text covers any sensible list


def _normalise_doi(s: str) -> str:
    s = (s or "").strip().lower().rstrip(".,;:✓✔☑")
    # Strip a trailing markdown / parenthetical artifact like
    # "doi:10.xxxx/yyyy." that the regex doesn't catch by itself.
    if s.startswith("http"):
        s = s.split("doi.org/")[-1]
    # _DOI_RE allows ")" inside the match (real DOIs can contain a
    # balanced parenthetical), which also lets it swallow the closing
    # ")" of an outer sentence like "(see 10.1016/xxx)". Strip a
    # trailing ")" only when it's actually unbalanced.
    while s.endswith(")") and s.count("(") < s.count(")"):
        s = s[:-1]
    return s.rstrip(".,;:")


def parse_text(text: str) -> list[dict]:
    """Split `text` into per-entry blocks, extract identifiers from
    each. Returns a list of {entry_no, raw, pmid, pmcid, doi}. Entries
    without any identifier are kept too (so the operator can see what
    we failed to recognise) with all three IDs set to None."""
    if not text:
        return []
    text = text[:_MAX_TEXT_CHARS]

    # Try numbered-prefix split first ("12. Author..."); then a
    # numbered TABLE row ("12\tAuthor...\t10.xxxx/..." — pasted from a
    # spreadsheet or a Markdown-ish table, tab-separated instead of
    # ". "/") "); then bracketed citation markers ("[1] [3] [8] ...",
    # as exported from a chatbot's "Sources" list); if none matches at
    # least twice, treat each non-blank paragraph as a separate entry.
    if _ENTRY_PREFIX_RE.search(text):
        parts = _ENTRY_PREFIX_RE.split(text)
    elif len(_ROW_PREFIX_RE.findall(text)) >= 2:
        parts = _ROW_PREFIX_RE.split(text)
    elif len(_BRACKET_PREFIX_RE.findall(text)) >= 2:
        parts = _BRACKET_PREFIX_RE.split(text)
    else:
        parts = re.split(r"\n\s*\n", text)
    parts = [p.strip() for p in parts if p and p.strip()]
    # Drop a leading table header row ("#  Referencia abreviada  DOI")
    # picked up as the fragment before the first numbered row/entry.
    if parts and _HEADER_ROW_RE.search(parts[0]):
        parts = parts[1:]

    out: list[dict] = []
    for idx, raw in enumerate(parts[:_MAX_ENTRIES], 1):
        pmid_match  = _PMID_WORD_RE.search(raw) or _PMID_RE.search(raw) or _PMID_URL_RE.search(raw)
        pmcid_match = _PMCID_RE.search(raw)
        doi_match   = _DOI_RE.search(raw)
        pmid  = pmid_match.group(1) if pmid_match else None
        pmcid = pmcid_match.group(1).upper() if pmcid_match else None
        doi   = _normalise_doi(doi_match.group(1)) if doi_match else None
        out.append({
            "entry_no": idx,
            "raw":      raw[:500],
            "pmid":     pmid,
            "pmcid":    pmcid,
            "doi":      doi,
        })
    return out


# ── PrionVault membership ───────────────────────────────────────────────────

def _lookup_in_vault(parsed: list[dict]) -> dict[int, dict]:
    """Returns {entry_no: {article_id, title}} for entries whose
    identifier matches an existing articles row."""
    pmids = [e["pmid"]      for e in parsed if e.get("pmid")]
    dois  = [e["doi"]       for e in parsed if e.get("doi")]
    pmcids = [e["pmcid"]    for e in parsed if e.get("pmcid")]
    if not (pmids or dois or pmcids):
        return {}

    eng = _get_engine()
    matches: dict[int, dict] = {}
    try:
        with eng.connect() as conn:
            # Detect whether pmc_id column exists — older DBs may not
            # have it yet. Mirrors the defensive check pattern used in
            # the rest of routes.py.
            cols = {r[0] for r in conn.execute(sql_text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'articles'"
            )).all()}
            has_pmc = "pmc_id" in cols

            where_parts = []
            params: dict = {}
            if pmids:
                where_parts.append("pubmed_id = ANY(:pmids)")
                params["pmids"] = pmids
            if dois:
                where_parts.append("lower(doi) = ANY(:dois)")
                params["dois"] = dois
            if pmcids and has_pmc:
                where_parts.append("pmc_id = ANY(:pmcids)")
                params["pmcids"] = pmcids
            if not where_parts:
                return {}
            rows = conn.execute(sql_text(
                f"""SELECT id::text, title, pubmed_id, lower(doi) AS doi
                          {", pmc_id" if has_pmc else ""}
                     FROM articles
                    WHERE {' OR '.join(where_parts)}"""
            ), params).mappings().all()
    except Exception as exc:
        logger.warning("screen-refs: vault lookup failed (%s)", exc)
        return {}

    by_pmid  = {r["pubmed_id"]: r for r in rows if r.get("pubmed_id")}
    by_doi   = {r["doi"]:       r for r in rows if r.get("doi")}
    by_pmcid = {r["pmc_id"]:    r for r in rows if "pmc_id" in r and r["pmc_id"]}
    for e in parsed:
        hit = None
        if e.get("pmid")  and e["pmid"]  in by_pmid:  hit = by_pmid[e["pmid"]]
        if not hit and e.get("doi") and e["doi"] in by_doi:    hit = by_doi[e["doi"]]
        if not hit and e.get("pmcid") and e["pmcid"] in by_pmcid: hit = by_pmcid[e["pmcid"]]
        if hit:
            matches[e["entry_no"]] = {
                "id":    hit["id"],
                "title": hit["title"],
            }
    return matches


# ── Metadata enrichment ─────────────────────────────────────────────────────

def _fetch_metadata(entry: dict) -> dict:
    """Best-effort: pull title/authors/year/journal for one entry.
    Tries the cheapest identifier first (PMID via esummary), then DOI
    via CrossRef. Returns a dict possibly with title/authors/year/journal
    set to None when nothing resolved."""
    from ..ingestion.metadata_resolver import (
        pubmed_by_pmid, crossref_by_doi, pubmed_by_doi,
    )
    out: dict = {
        "title":   None,
        "authors": None,
        "year":    None,
        "journal": None,
        "source":  None,    # which API gave us the data
    }
    pmid = entry.get("pmid")
    doi  = entry.get("doi")
    meta = None
    if pmid:
        try:
            meta = pubmed_by_pmid(pmid)
        except Exception:
            meta = None
        if meta:
            out["source"] = "pubmed"
    if not meta and doi:
        try:
            meta = crossref_by_doi(doi)
        except Exception:
            meta = None
        if meta:
            out["source"] = "crossref"
    if not meta and doi:
        try:
            meta = pubmed_by_doi(doi)
        except Exception:
            meta = None
        if meta:
            out["source"] = "pubmed_by_doi"
    if meta:
        out["title"]   = meta.title
        out["authors"] = meta.authors
        out["year"]    = meta.year
        out["journal"] = meta.journal
        # Backfill identifiers the lookup discovered if the parsed
        # entry didn't carry them — useful for the import button.
        if not entry.get("pmid") and getattr(meta, "pubmed_id", None):
            entry["pmid"] = meta.pubmed_id
        if not entry.get("doi") and getattr(meta, "doi", None):
            entry["doi"] = (meta.doi or "").lower() or None
    return out


# ── OA availability ─────────────────────────────────────────────────────────

def _classify_oa(entry: dict, *, check_unpaywall: bool) -> dict:
    """Returns {has_pmc, oa_hint, oa_detail}.

    oa_hint is one of: "pmc" / "unpaywall" / "no" / "unknown".
    Unpaywall is consulted only when explicitly requested (default off,
    because querying it for every entry slows the bulk endpoint).
    """
    pmcid = entry.get("pmcid")
    if pmcid:
        return {"has_pmc": True, "oa_hint": "pmc",
                "oa_detail": f"Fulltext en PMC ({pmcid})"}
    if not check_unpaywall:
        return {"has_pmc": False, "oa_hint": "unknown",
                "oa_detail": "Sin PMC — necesita comprobación Unpaywall"}
    doi = entry.get("doi")
    if not doi:
        return {"has_pmc": False, "oa_hint": "no",
                "oa_detail": "Sin DOI ni PMC — solo metadatos"}
    try:
        from . import unpaywall as _u
        info = _u.find_open_pdf(doi)
    except Exception:
        return {"has_pmc": False, "oa_hint": "unknown",
                "oa_detail": "Unpaywall no respondió"}
    if info.is_oa and info.pdf_url:
        return {"has_pmc": False, "oa_hint": "unpaywall",
                "oa_detail": f"OA según Unpaywall ({info.host_type or 'fuente'})"}
    return {"has_pmc": False, "oa_hint": "no",
            "oa_detail": "Ni PMC ni Unpaywall ofrecen PDF — solo metadatos"}


# ── Public entry point ──────────────────────────────────────────────────────

def screen(text: str, *, check_unpaywall: bool = False) -> dict:
    """Full pass over `text`. Returns {items: [...], stats: {...}}.

    Each item:
      entry_no     1-based index into the input text
      raw          the original entry (truncated)
      pmid / pmcid / doi    parsed identifiers (or None)
      in_vault     {id, title} when the paper is already in articles
      title / authors / year / journal / source   from CrossRef / PubMed
      has_pmc      True when a PMC ID was found
      oa_hint      pmc / unpaywall / no / unknown
      oa_detail    short human-readable hint
    """
    parsed = parse_text(text)
    if not parsed:
        return {"items": [], "stats": {"total": 0, "in_vault": 0, "missing": 0,
                                       "unparseable": 0}}

    in_vault = _lookup_in_vault(parsed)

    items: list[dict] = []
    for e in parsed:
        item = dict(e)
        if e["entry_no"] in in_vault:
            item["in_vault"] = in_vault[e["entry_no"]]
            # Skip metadata fetch when we already have the paper — we
            # know its title from the DB.
            item["title"]   = in_vault[e["entry_no"]]["title"]
            item["authors"] = None
            item["year"]    = None
            item["journal"] = None
            item["source"]  = "prionvault"
            item.update(_classify_oa(e, check_unpaywall=False))
        elif not (e.get("pmid") or e.get("doi") or e.get("pmcid")):
            item["in_vault"] = None
            item["title"]    = None
            item["authors"]  = None
            item["year"]     = None
            item["journal"]  = None
            item["source"]   = None
            item.update({"has_pmc": False, "oa_hint": "unparseable",
                         "oa_detail": "No se reconoció PMID, PMCID ni DOI en esta entrada"})
        else:
            item["in_vault"] = None
            item.update(_fetch_metadata(e))
            # _fetch_metadata may have backfilled e["pmid"]/["doi"]; mirror.
            item["pmid"] = e.get("pmid")
            item["doi"]  = e.get("doi")
            item.update(_classify_oa(e, check_unpaywall=check_unpaywall))
        items.append(item)

    stats = {
        "total":       len(items),
        "in_vault":    sum(1 for it in items if it.get("in_vault")),
        "missing":     sum(1 for it in items if not it.get("in_vault")
                                            and (it.get("pmid") or it.get("doi") or it.get("pmcid"))),
        "unparseable": sum(1 for it in items if it.get("oa_hint") == "unparseable"),
        "with_oa":     sum(1 for it in items if not it.get("in_vault")
                                            and it.get("oa_hint") in ("pmc", "unpaywall")),
    }
    return {"items": items, "stats": stats}
