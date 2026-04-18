import csv
import io
import json
import logging
import os
import re
import uuid
from datetime import date, datetime, timedelta
from typing import Optional

import requests

import config

logger = logging.getLogger(__name__)

# ── CSV paths ─────────────────────────────────────────────────────────────────

PUBLICATIONS_CSV     = os.path.join(config.CSV_DIR, "publications.csv")
CITATIONS_CSV        = os.path.join(config.CSV_DIR, "citations.csv")
PUB_AUTHORS_CSV      = os.path.join(config.CSV_DIR, "publication_authors.csv")
CITATION_STYLES_CSV  = os.path.join(config.CSV_DIR, "citation_styles.csv")
RESEARCH_METRICS_CSV = os.path.join(config.CSV_DIR, "research_metrics.csv")
PUB_TAGS_CSV         = os.path.join(config.CSV_DIR, "publication_tags.csv")

# ── Column definitions ────────────────────────────────────────────────────────

_PUB_COLS = [
    "pub_id", "title", "abstract", "journal", "year", "volume", "issue",
    "pages", "doi", "pmid", "url", "keywords", "pub_type", "status",
    "added_by", "added_at", "updated_at", "times_cited", "notes",
]
_CITE_COLS = [
    "cite_id", "pub_id", "manuscript_id", "style", "formatted_citation",
    "created_by", "created_at",
]
_AUTH_COLS = [
    "author_id", "pub_id", "last_name", "first_name", "initials",
    "affiliation", "author_order", "is_corresponding",
]
_STYLE_COLS = ["style_id", "style_name", "description", "example_format"]
_METRICS_COLS = [
    "metric_id", "pub_id", "citation_count", "altmetric_score",
    "download_count", "recorded_at",
]
_TAG_COLS = ["tag_id", "pub_id", "tag", "added_by", "added_at"]

# ── Seed data ─────────────────────────────────────────────────────────────────

_SEED_PUBLICATIONS = [
    {
        "pub_id": "pub_001",
        "title": "Molecular dissection of prion strain diversity and phenotypic heterogeneity",
        "abstract": "Prion diseases are caused by misfolded PrP conformers that propagate through templating. We investigated strain-specific conformational features using PMCA and structural analyses.",
        "journal": "Acta Neuropathol Commun",
        "year": "2023",
        "volume": "11",
        "issue": "1",
        "pages": "45",
        "doi": "10.1186/s40478-023-01545-4",
        "pmid": "36934309",
        "url": "",
        "keywords": "prion strains; PrP conformation; PMCA; neurodegeneration",
        "pub_type": "research_article",
        "status": "published",
        "added_by": "admin",
        "added_at": "2024-01-01T00:00:00",
        "updated_at": "2024-01-01T00:00:00",
        "times_cited": "12",
        "notes": "Lab publication - strain diversity study",
    },
    {
        "pub_id": "pub_002",
        "title": "Cross-species transmission barriers in prion diseases: structural and evolutionary insights",
        "abstract": "Species barriers in prion diseases are determined by PrP primary sequence and conformational compatibility. We analyzed transmission barriers across multiple species using in vitro and in vivo models.",
        "journal": "Nat Commun",
        "year": "2024",
        "volume": "15",
        "issue": "3",
        "pages": "1823",
        "doi": "10.1038/s41467-024-45123-7",
        "pmid": "38402234",
        "url": "",
        "keywords": "prion transmission; species barrier; PrP structure; evolution",
        "pub_type": "research_article",
        "status": "published",
        "added_by": "admin",
        "added_at": "2024-01-01T00:00:00",
        "updated_at": "2024-01-01T00:00:00",
        "times_cited": "8",
        "notes": "Lab publication - cross-species transmission",
    },
    {
        "pub_id": "pub_003",
        "title": "Novel PMCA-based diagnostic approach for early detection of prion infection in biological samples",
        "abstract": "We developed an enhanced PMCA protocol with improved sensitivity for detecting sub-clinical prion infection in blood and urine samples from scrapie-infected sheep.",
        "journal": "PLoS Pathog",
        "year": "2025",
        "volume": "21",
        "issue": "2",
        "pages": "e1012345",
        "doi": "10.1371/journal.ppat.1012345",
        "pmid": "39988871",
        "url": "",
        "keywords": "PMCA; prion diagnostics; scrapie; biomarkers; blood-based testing",
        "pub_type": "research_article",
        "status": "published",
        "added_by": "admin",
        "added_at": "2025-01-01T00:00:00",
        "updated_at": "2025-01-01T00:00:00",
        "times_cited": "3",
        "notes": "Lab publication - diagnostic methods",
    },
]

_SEED_AUTHORS = [
    {"author_id": "auth_001", "pub_id": "pub_001", "last_name": "Garcia", "first_name": "Juan", "initials": "J", "affiliation": "PrionLab, CReSA", "author_order": "1", "is_corresponding": "false"},
    {"author_id": "auth_002", "pub_id": "pub_001", "last_name": "Martinez", "first_name": "Maria", "initials": "M", "affiliation": "PrionLab, CReSA", "author_order": "2", "is_corresponding": "true"},
    {"author_id": "auth_003", "pub_id": "pub_002", "last_name": "Lopez", "first_name": "Carlos", "initials": "C", "affiliation": "PrionLab, CReSA", "author_order": "1", "is_corresponding": "true"},
    {"author_id": "auth_004", "pub_id": "pub_003", "last_name": "Rodriguez", "first_name": "Ana", "initials": "A", "affiliation": "PrionLab, CReSA", "author_order": "1", "is_corresponding": "true"},
]

_SEED_STYLES = [
    {"style_id": "sty_001", "style_name": "Vancouver", "description": "Numbered references, widely used in biomedical journals", "example_format": "Author AB, Author CD. Title. Journal. Year;Vol(Issue):Pages."},
    {"style_id": "sty_002", "style_name": "Nature", "description": "Superscript numbers, used in Nature family journals", "example_format": "Author, A. B. et al. Title. Journal Vol, Pages (Year)."},
    {"style_id": "sty_003", "style_name": "PLoS", "description": "Numbered references, used in PLoS journals", "example_format": "Author AB, Author CD (Year) Title. Journal Vol(Issue): Pages."},
    {"style_id": "sty_004", "style_name": "APA", "description": "Author-date format, used in psychology and social sciences", "example_format": "Author, A. B., & Author, C. D. (Year). Title. Journal, Vol(Issue), Pages."},
    {"style_id": "sty_005", "style_name": "Acta_Neuropathol", "description": "Used in Acta Neuropathologica and related journals", "example_format": "Author AB, Author CD (Year) Title. Acta Neuropathol Vol:Pages. https://doi.org/DOI"},
]

# ── CSV helpers ───────────────────────────────────────────────────────────────

def _read(path: str, cols: list) -> list[dict]:
    if not os.path.exists(path):
        return []
    try:
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
        for col in cols:
            for r in rows:
                r.setdefault(col, "")
        return rows
    except Exception as e:
        logger.error("CSV read error %s: %s", path, e)
        return []


def _write(path: str, cols: list, rows: list[dict]):
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=cols, quoting=csv.QUOTE_ALL,
                                extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def _seed_if_empty(path: str, cols: list, seed_rows: list[dict]):
    rows = _read(path, cols)
    if not rows:
        _write(path, cols, seed_rows)


def bootstrap_research_schema():
    _seed_if_empty(PUBLICATIONS_CSV, _PUB_COLS, _SEED_PUBLICATIONS)
    _seed_if_empty(PUB_AUTHORS_CSV, _AUTH_COLS, _SEED_AUTHORS)
    _seed_if_empty(CITATION_STYLES_CSV, _STYLE_COLS, _SEED_STYLES)
    _seed_if_empty(CITATIONS_CSV, _CITE_COLS, [])
    _seed_if_empty(RESEARCH_METRICS_CSV, _METRICS_COLS, [])
    _seed_if_empty(PUB_TAGS_CSV, _TAG_COLS, [])


# ── Data access helpers ────────────────────────────────────────────────────────

def _get_pub_authors(pub_id: str) -> list[dict]:
    authors = _read(PUB_AUTHORS_CSV, _AUTH_COLS)
    return sorted(
        [a for a in authors if a["pub_id"] == pub_id],
        key=lambda a: int(a.get("author_order", 99) or 99)
    )


def _format_author_list_short(authors: list[dict]) -> str:
    parts = []
    for a in authors:
        ln = a.get("last_name", "")
        ini = a.get("initials", a.get("first_name", "")[:1] if a.get("first_name") else "")
        if ln:
            parts.append(f"{ln} {ini}" if ini else ln)
    if len(parts) > 6:
        return ", ".join(parts[:6]) + ", et al."
    return ", ".join(parts)


def get_all_publications(filters: dict = None) -> list[dict]:
    pubs = _read(PUBLICATIONS_CSV, _PUB_COLS)
    if filters:
        q = (filters.get("query") or "").lower()
        journal = (filters.get("journal") or "").lower()
        year = (filters.get("year") or "").strip()
        pub_type = (filters.get("pub_type") or "").strip()
        if q:
            pubs = [p for p in pubs if q in p.get("title", "").lower()
                    or q in p.get("abstract", "").lower()
                    or q in p.get("keywords", "").lower()]
        if journal:
            pubs = [p for p in pubs if journal in p.get("journal", "").lower()]
        if year:
            pubs = [p for p in pubs if p.get("year", "") == year]
        if pub_type:
            pubs = [p for p in pubs if p.get("pub_type", "") == pub_type]
    for p in pubs:
        p["authors"] = _get_pub_authors(p["pub_id"])
        p["author_string"] = _format_author_list_short(p["authors"])
    return sorted(pubs, key=lambda p: p.get("year", "0"), reverse=True)


def get_publication(pub_id: str) -> Optional[dict]:
    pubs = _read(PUBLICATIONS_CSV, _PUB_COLS)
    for p in pubs:
        if p["pub_id"] == pub_id:
            p["authors"] = _get_pub_authors(pub_id)
            p["author_string"] = _format_author_list_short(p["authors"])
            return p
    return None


def get_publication_statistics() -> dict:
    pubs = _read(PUBLICATIONS_CSV, _PUB_COLS)
    total = len(pubs)
    by_year = {}
    by_journal = {}
    by_type = {}
    total_citations = 0
    for p in pubs:
        yr = p.get("year", "Unknown")
        by_year[yr] = by_year.get(yr, 0) + 1
        jn = p.get("journal", "Unknown")
        by_journal[jn] = by_journal.get(jn, 0) + 1
        pt = p.get("pub_type", "other")
        by_type[pt] = by_type.get(pt, 0) + 1
        try:
            total_citations += int(p.get("times_cited", 0) or 0)
        except (ValueError, TypeError):
            pass
    return {
        "total_publications": total,
        "total_citations": total_citations,
        "by_year": dict(sorted(by_year.items(), reverse=True)),
        "by_journal": by_journal,
        "by_type": by_type,
    }

# ── Rate limiting ─────────────────────────────────────────────────────────────

def check_publication_rate_limit(user_id: str) -> bool:
    pubs = _read(PUBLICATIONS_CSV, _PUB_COLS)
    today = date.today().isoformat()
    count = sum(1 for p in pubs
                if p.get("added_by") == user_id
                and p.get("added_at", "").startswith(today))
    return count < 10


def check_citation_rate_limit(user_id: str) -> bool:
    cites = _read(CITATIONS_CSV, _CITE_COLS)
    today = date.today().isoformat()
    count = sum(1 for c in cites
                if c.get("created_by") == user_id
                and c.get("created_at", "").startswith(today))
    return count < 20


# ── PublicationManager ─────────────────────────────────────────────────────────

class PublicationManager:

    @staticmethod
    def add_publication_manual(data: dict, user_id: str) -> dict:
        pubs = _read(PUBLICATIONS_CSV, _PUB_COLS)
        pub_id = "pub_" + uuid.uuid4().hex[:8]
        now = datetime.utcnow().isoformat()
        record = {
            "pub_id": pub_id,
            "title": data.get("title", "").strip(),
            "abstract": data.get("abstract", "").strip(),
            "journal": data.get("journal", "").strip(),
            "year": str(data.get("year", "")).strip(),
            "volume": data.get("volume", "").strip(),
            "issue": data.get("issue", "").strip(),
            "pages": data.get("pages", "").strip(),
            "doi": data.get("doi", "").strip(),
            "pmid": data.get("pmid", "").strip(),
            "url": data.get("url", "").strip(),
            "keywords": data.get("keywords", "").strip(),
            "pub_type": data.get("pub_type", "research_article").strip(),
            "status": data.get("status", "published").strip(),
            "added_by": user_id,
            "added_at": now,
            "updated_at": now,
            "times_cited": "0",
            "notes": data.get("notes", "").strip(),
        }
        if not record["title"]:
            return {"success": False, "error": "Title is required."}
        pubs.append(record)
        _write(PUBLICATIONS_CSV, _PUB_COLS, pubs)
        authors = data.get("authors", [])
        if authors:
            PublicationManager._save_authors(pub_id, authors)
        return {"success": True, "pub_id": pub_id}

    @staticmethod
    def _save_authors(pub_id: str, authors: list):
        all_authors = _read(PUB_AUTHORS_CSV, _AUTH_COLS)
        for i, a in enumerate(authors, start=1):
            all_authors.append({
                "author_id": "auth_" + uuid.uuid4().hex[:8],
                "pub_id": pub_id,
                "last_name": a.get("last_name", "").strip(),
                "first_name": a.get("first_name", "").strip(),
                "initials": a.get("initials", "").strip(),
                "affiliation": a.get("affiliation", "").strip(),
                "author_order": str(i),
                "is_corresponding": "true" if a.get("is_corresponding") else "false",
            })
        _write(PUB_AUTHORS_CSV, _AUTH_COLS, all_authors)

    @staticmethod
    def add_publication_by_doi(doi: str, user_id: str) -> dict:
        doi = doi.strip().lstrip("https://doi.org/").lstrip("doi:")
        url = f"https://api.crossref.org/works/{doi}"
        try:
            resp = requests.get(url, timeout=10,
                                headers={"User-Agent": "PrionLab-Tools/1.0 mailto:admin@prionlab.org"})
            if resp.status_code != 200:
                return {"success": False, "error": f"DOI not found (HTTP {resp.status_code})."}
            item = resp.json().get("message", {})
        except requests.RequestException as e:
            return {"success": False, "error": f"Network error: {e}"}

        title_list = item.get("title", [""])
        title = title_list[0] if title_list else ""
        abstract_raw = item.get("abstract", "")
        abstract = re.sub(r"<[^>]+>", "", abstract_raw).strip()
        journal_list = item.get("container-title", [""])
        journal = journal_list[0] if journal_list else ""
        year_parts = item.get("published-print", item.get("published-online", {})).get("date-parts", [[""]])
        year = str(year_parts[0][0]) if year_parts and year_parts[0] else ""
        volume = item.get("volume", "")
        issue = item.get("issue", "")
        pages = item.get("page", "")
        raw_authors = item.get("author", [])
        authors = []
        for a in raw_authors:
            fn = a.get("given", "")
            ln = a.get("family", "")
            initials = "".join(w[0] for w in fn.split() if w) if fn else ""
            authors.append({"last_name": ln, "first_name": fn, "initials": initials,
                            "affiliation": "", "is_corresponding": False})
        subject = item.get("subject", [])
        keywords = "; ".join(subject[:5]) if subject else ""
        data = {
            "title": title, "abstract": abstract, "journal": journal,
            "year": year, "volume": volume, "issue": issue, "pages": pages,
            "doi": doi, "pmid": "", "keywords": keywords,
            "pub_type": "research_article", "status": "published",
            "notes": f"Imported via CrossRef DOI: {doi}",
            "authors": authors,
        }
        return PublicationManager.add_publication_manual(data, user_id)

    @staticmethod
    def add_publication_by_pmid(pmid: str, user_id: str) -> dict:
        pmid = pmid.strip()
        base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
        try:
            fetch_url = f"{base}/efetch.fcgi?db=pubmed&id={pmid}&retmode=json&rettype=abstract"
            summary_url = f"{base}/esummary.fcgi?db=pubmed&id={pmid}&retmode=json"
            resp = requests.get(summary_url, timeout=10)
            if resp.status_code != 200:
                return {"success": False, "error": f"PMID not found (HTTP {resp.status_code})."}
            result = resp.json().get("result", {})
            item = result.get(pmid, {})
            if not item:
                return {"success": False, "error": "PMID not found in PubMed."}
        except requests.RequestException as e:
            return {"success": False, "error": f"Network error: {e}"}

        title = item.get("title", "")
        journal = item.get("source", "")
        year = item.get("pubdate", "")[:4]
        volume = item.get("volume", "")
        issue = item.get("issue", "")
        pages = item.get("pages", "")
        doi = ""
        for art_id in item.get("articleids", []):
            if art_id.get("idtype") == "doi":
                doi = art_id.get("value", "")
        raw_authors = item.get("authors", [])
        authors = []
        for a in raw_authors:
            name = a.get("name", "")
            parts = name.split(" ", 1)
            ln = parts[0] if parts else name
            initials = parts[1] if len(parts) > 1 else ""
            authors.append({"last_name": ln, "first_name": "", "initials": initials,
                            "affiliation": "", "is_corresponding": False})
        data = {
            "title": title, "abstract": "", "journal": journal,
            "year": year, "volume": volume, "issue": issue, "pages": pages,
            "doi": doi, "pmid": pmid, "keywords": "",
            "pub_type": "research_article", "status": "published",
            "notes": f"Imported via PubMed PMID: {pmid}",
            "authors": authors,
        }
        return PublicationManager.add_publication_manual(data, user_id)

    @staticmethod
    def delete_publication(pub_id: str, user_id: str, role: str) -> bool:
        pubs = _read(PUBLICATIONS_CSV, _PUB_COLS)
        orig_len = len(pubs)
        pubs = [p for p in pubs if not (p["pub_id"] == pub_id
                and (p.get("added_by") == user_id or role == "admin"))]
        if len(pubs) == orig_len:
            return False
        _write(PUBLICATIONS_CSV, _PUB_COLS, pubs)
        authors = _read(PUB_AUTHORS_CSV, _AUTH_COLS)
        _write(PUB_AUTHORS_CSV, _AUTH_COLS,
               [a for a in authors if a["pub_id"] != pub_id])
        return True

# ── CitationManager ───────────────────────────────────────────────────────────

class CitationManager:

    @staticmethod
    def _get_author_string(pub: dict, style: str) -> str:
        authors = pub.get("authors") or _get_pub_authors(pub["pub_id"])
        if not authors:
            return "Anonymous"
        formatted = []
        for a in authors:
            ln = a.get("last_name", "")
            fn = a.get("first_name", "")
            ini = a.get("initials", fn[:1] if fn else "")
            if style in ("Vancouver", "PLoS", "Acta_Neuropathol"):
                formatted.append(f"{ln} {ini}" if ini else ln)
            elif style == "Nature":
                formatted.append(f"{ln}, {fn[:1]}." if fn else ln)
            elif style == "APA":
                formatted.append(f"{ln}, {fn[:1]}." if fn else ln)
        n = len(formatted)
        if style in ("Vancouver", "PLoS", "Acta_Neuropathol"):
            if n > 6:
                return ", ".join(formatted[:6]) + ", et al."
            return ", ".join(formatted)
        elif style == "Nature":
            if n > 5:
                return ", ".join(formatted[:5]) + " et al."
            return ", ".join(formatted)
        elif style == "APA":
            if n > 7:
                return ", ".join(formatted[:6]) + ", ... " + formatted[-1]
            if n > 1:
                return ", ".join(formatted[:-1]) + " & " + formatted[-1]
            return formatted[0]
        return ", ".join(formatted)

    @staticmethod
    def format_citation(pub: dict, style: str, ref_number: int = 1) -> str:
        title = pub.get("title", "")
        journal = pub.get("journal", "")
        year = pub.get("year", "")
        volume = pub.get("volume", "")
        issue = pub.get("issue", "")
        pages = pub.get("pages", "")
        doi = pub.get("doi", "")
        pmid = pub.get("pmid", "")
        authors = CitationManager._get_author_string(pub, style)

        vol_issue = f"{volume}({issue})" if issue else volume
        doi_str = f"https://doi.org/{doi}" if doi else ""

        if style == "Vancouver":
            citation = f"{authors}. {title}. {journal}. {year};{vol_issue}:{pages}."
            if doi:
                citation += f" doi:{doi}"
            return citation.strip()

        elif style == "Nature":
            citation = f"{authors}. {title}. {journal} {volume}, {pages} ({year})."
            if doi:
                citation += f" https://doi.org/{doi}"
            return citation.strip()

        elif style == "PLoS":
            citation = f"{authors} ({year}) {title}. {journal} {vol_issue}: {pages}."
            if doi:
                citation += f" https://doi.org/{doi}"
            return citation.strip()

        elif style == "APA":
            citation = f"{authors} ({year}). {title}. {journal}"
            if volume:
                citation += f", {volume}"
                if issue:
                    citation += f"({issue})"
            if pages:
                citation += f", {pages}"
            citation += "."
            if doi:
                citation += f" https://doi.org/{doi}"
            return citation.strip()

        elif style == "Acta_Neuropathol":
            citation = f"{authors} ({year}) {title}. {journal} {volume}:{pages}."
            if doi_str:
                citation += f" {doi_str}"
            return citation.strip()

        return f"{authors}. {title}. {journal}. {year}."

    @staticmethod
    def generate_bibliography(pub_ids: list, style: str) -> str:
        lines = []
        for i, pub_id in enumerate(pub_ids, start=1):
            pub = get_publication(pub_id)
            if pub:
                citation = CitationManager.format_citation(pub, style, i)
                if style in ("Vancouver", "PLoS"):
                    lines.append(f"{i}. {citation}")
                else:
                    lines.append(citation)
        return "\n".join(lines)

    @staticmethod
    def save_citation(pub_id: str, manuscript_id: str, style: str,
                      user_id: str) -> dict:
        pub = get_publication(pub_id)
        if not pub:
            return {"success": False, "error": "Publication not found."}
        formatted = CitationManager.format_citation(pub, style)
        cites = _read(CITATIONS_CSV, _CITE_COLS)
        cite_id = "cit_" + uuid.uuid4().hex[:8]
        now = datetime.utcnow().isoformat()
        cites.append({
            "cite_id": cite_id,
            "pub_id": pub_id,
            "manuscript_id": manuscript_id or "",
            "style": style,
            "formatted_citation": formatted,
            "created_by": user_id,
            "created_at": now,
        })
        _write(CITATIONS_CSV, _CITE_COLS, cites)
        return {"success": True, "cite_id": cite_id, "formatted_citation": formatted}

    @staticmethod
    def get_citation_styles() -> list[dict]:
        return _read(CITATION_STYLES_CSV, _STYLE_COLS)

# ── Introduction / ManuscriptForge integration ────────────────────────────────

def get_relevant_lab_publications(approach_id: str = "", keywords: str = "") -> list[dict]:
    pubs = get_all_publications()
    if not pubs:
        return []
    scored = []
    kw_list = [k.strip().lower() for k in keywords.split(";") if k.strip()] if keywords else []
    approach_kw = {
        "approach_001": ["strain", "conformation", "diversity", "phenotype"],
        "approach_002": ["mechanism", "disease", "pathway", "neurodegeneration"],
        "approach_003": ["phylogenetic", "evolution", "species", "barrier"],
        "approach_004": ["diagnostic", "detection", "clinical", "biomarker"],
        "approach_005": ["spontaneous", "formation", "de novo", "aggregation"],
    }
    relevant_kw = approach_kw.get(approach_id, []) + kw_list
    for p in pubs:
        score = 0
        text = (p.get("title", "") + " " + p.get("abstract", "") + " " + p.get("keywords", "")).lower()
        for kw in relevant_kw:
            if kw in text:
                score += 1
        if score > 0:
            scored.append((score, p))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [p for _, p in scored[:5]]


def enhance_literature_with_lab_publications(sections: dict, approach_id: str, keywords: str) -> dict:
    relevant = get_relevant_lab_publications(approach_id, keywords)
    if not relevant:
        return sections
    citations = []
    for i, pub in enumerate(relevant[:3], start=1):
        authors = pub.get("author_string", "Unknown et al.")
        year = pub.get("year", "")
        title = pub.get("title", "")
        citations.append(f"{authors} ({year}) reported {title[:60]}{'...' if len(title) > 60 else ''}.")
    lit_note = sections.get("literature_note", "")
    if lit_note and citations:
        lit_note += " " + " ".join(citations[:2])
        sections["literature_note"] = lit_note
    return sections


def get_available_references(manuscript_id: str = "") -> list[dict]:
    pubs = get_all_publications()
    result = []
    for p in pubs:
        result.append({
            "pub_id": p["pub_id"],
            "title": p.get("title", ""),
            "author_string": p.get("author_string", ""),
            "journal": p.get("journal", ""),
            "year": p.get("year", ""),
            "doi": p.get("doi", ""),
        })
    return result


def import_references_section(pub_ids: list, style: str = "Vancouver") -> dict:
    if not pub_ids:
        return {"success": False, "error": "No publications selected."}
    bibliography = CitationManager.generate_bibliography(pub_ids, style)
    return {
        "success": True,
        "bibliography": bibliography,
        "count": len(pub_ids),
        "style": style,
        "message": f"{len(pub_ids)} reference(s) formatted in {style} style.",
    }

