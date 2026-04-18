"""Reference service — DB-first with JSON fallback."""
import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from .bibtex_parser import ParsedReference, get_bibtex_parser

logger = logging.getLogger(__name__)

CITATION_STYLES = {
    "nature": "Nature",
    "science": "Science",
    "cell": "Cell",
    "pnas": "PNAS",
    "apa": "APA",
    "vancouver": "Vancouver",
    "mla": "MLA",
}


def _db():
    try:
        from database.config import db
        return db if db.is_configured() else None
    except Exception:
        return None


def _refs_path() -> str:
    try:
        import config
        base = config.DATA_DIR
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "..", "..", "data")
    return os.path.join(base, "references.json")


def _load_store() -> List[Dict]:
    path = _refs_path()
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _save_store(data: List[Dict]) -> None:
    path = _refs_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ── Import ─────────────────────────────────────────────────────────────────────

def import_bibtex(content: str, manuscript_id: str, username: str = "") -> Dict:
    """Parse BibTeX content and store references."""
    parser = get_bibtex_parser()
    refs, parse_errors = parser.parse_file(content)
    if not refs:
        return {"success": False, "error": "No valid references found",
                "parse_errors": parse_errors, "references_imported": 0}
    refs, warnings = parser.validate(refs)

    imported = 0
    dupes = 0
    errors: List[str] = []

    db = _db()
    if db:
        try:
            import uuid as _uuid
            from database.models import ReferenceEntry
            existing = _get_refs_db(manuscript_id, db)
            existing_dois = {r.get("doi", "") for r in existing if r.get("doi")}
            existing_keys = {(r.get("title", "").lower()[:40], r.get("year")) for r in existing}
            with db.get_session() as s:
                for ref in refs:
                    if ref.doi and ref.doi in existing_dois:
                        dupes += 1
                        continue
                    title_key = (ref.title.lower()[:40], ref.year if ref.year else None)
                    if title_key in existing_keys:
                        dupes += 1
                        continue
                    try:
                        mid = _uuid.UUID(manuscript_id) if manuscript_id else None
                    except Exception:
                        mid = None
                    entry = ReferenceEntry(
                        title=ref.title,
                        authors=json.dumps(ref.authors),
                        journal=ref.journal,
                        year=ref.year or None,
                        volume=ref.volume,
                        issue=ref.issue,
                        pages=ref.pages,
                        doi=ref.doi or None,
                        pmid=ref.pmid or None,
                        isbn=ref.isbn or None,
                        url=ref.url or None,
                        abstract=ref.abstract,
                        keywords=json.dumps(ref.keywords),
                        research_area=ref.research_area,
                        entry_type=ref.entry_type,
                        bibtex_key=ref.bibtex_key,
                        raw_bibtex=ref.raw_bibtex,
                        manuscript_id=mid,
                        created_by=username,
                    )
                    s.add(entry)
                    imported += 1
                    if ref.doi:
                        existing_dois.add(ref.doi)
                    existing_keys.add(title_key)
            return _import_result(imported, dupes, refs, parse_errors, warnings, errors)
        except Exception as exc:
            logger.warning("DB import_bibtex: %s", exc)

    # JSON fallback
    store = _load_store()
    ex_dois = {r.get("doi", "") for r in store if r.get("doi") and r.get("manuscript_id") == manuscript_id}
    ex_keys = {(r.get("title", "").lower()[:40], r.get("year")) for r in store if r.get("manuscript_id") == manuscript_id}
    now = datetime.now(timezone.utc).isoformat()
    for ref in refs:
        if ref.doi and ref.doi in ex_dois:
            dupes += 1
            continue
        tk = (ref.title.lower()[:40], ref.year if ref.year else None)
        if tk in ex_keys:
            dupes += 1
            continue
        store.append({
            "id": ref.ref_uuid, "manuscript_id": manuscript_id,
            "title": ref.title, "authors": ref.authors,
            "journal": ref.journal, "year": ref.year,
            "volume": ref.volume, "issue": ref.issue, "pages": ref.pages,
            "doi": ref.doi, "pmid": ref.pmid, "isbn": ref.isbn,
            "url": ref.url, "abstract": ref.abstract,
            "keywords": ref.keywords, "research_area": ref.research_area,
            "entry_type": ref.entry_type, "bibtex_key": ref.bibtex_key,
            "created_by": username, "created_at": now,
        })
        imported += 1
        if ref.doi:
            ex_dois.add(ref.doi)
        ex_keys.add(tk)
    _save_store(store)
    return _import_result(imported, dupes, refs, parse_errors, warnings, errors)


def _import_result(imported, dupes, refs, parse_errors, warnings, errors) -> Dict:
    return {
        "success": imported > 0 or dupes > 0,
        "references_imported": imported,
        "duplicates_skipped": dupes,
        "total_parsed": len(refs),
        "parse_errors": parse_errors[:10],
        "warnings": warnings[:10],
        "storage_errors": errors[:5],
    }

# ── Query / Delete ─────────────────────────────────────────────────────────────

def _get_refs_db(manuscript_id: str, db) -> List[Dict]:
    try:
        import uuid as _uuid
        from database.models import ReferenceEntry
        with db.get_session() as s:
            try:
                mid = _uuid.UUID(manuscript_id)
            except Exception:
                return []
            rows = s.query(ReferenceEntry).filter(ReferenceEntry.manuscript_id == mid).all()
            return [r.to_dict() for r in rows]
    except Exception as exc:
        logger.warning("DB _get_refs_db: %s", exc)
        return []


def get_references(manuscript_id: str, research_area: str = "",
                   year_from: int = 0, year_to: int = 0,
                   entry_type: str = "") -> List[Dict]:
    db = _db()
    if db:
        refs = _get_refs_db(manuscript_id, db)
    else:
        store = _load_store()
        refs = [r for r in store if r.get("manuscript_id") == manuscript_id]
    # Filters
    if research_area:
        refs = [r for r in refs if r.get("research_area") == research_area]
    if year_from:
        refs = [r for r in refs if (r.get("year") or 0) >= year_from]
    if year_to:
        refs = [r for r in refs if (r.get("year") or 0) <= year_to]
    if entry_type:
        refs = [r for r in refs if r.get("entry_type") == entry_type]
    return refs


def search_references(manuscript_id: str, query: str) -> List[Dict]:
    refs = get_references(manuscript_id)
    if not query:
        return refs
    q = query.lower()
    results = []
    for r in refs:
        text = " ".join([
            r.get("title", ""),
            " ".join(r.get("authors", [])),
            r.get("journal", ""),
            " ".join(r.get("keywords", [])),
        ]).lower()
        if q in text:
            results.append(r)
    return results


def delete_reference(reference_id: str, username: str = "") -> Dict:
    db = _db()
    if db:
        try:
            import uuid as _uuid
            from database.models import ReferenceEntry
            with db.get_session() as s:
                entry = s.query(ReferenceEntry).filter(
                    ReferenceEntry.id == _uuid.UUID(reference_id)
                ).first()
                if not entry:
                    return {"success": False, "error": "Not found"}
                s.delete(entry)
            return {"success": True}
        except Exception as exc:
            logger.warning("DB delete_reference: %s", exc)

    store = _load_store()
    new_store = [r for r in store if r.get("id") != reference_id]
    if len(new_store) == len(store):
        return {"success": False, "error": "Not found"}
    _save_store(new_store)
    return {"success": True}

# ── Citation formatting ────────────────────────────────────────────────────────

def _fmt_author_nature(author: str) -> str:
    parts = author.split()
    if len(parts) >= 2:
        return f"{parts[-1]}, {''.join(p[0] + '.' for p in parts[:-1])}"
    return author


def _fmt_author_apa(author: str) -> str:
    parts = author.split()
    if len(parts) >= 2:
        initials = " ".join(p[0] + "." for p in parts[:-1])
        return f"{parts[-1]}, {initials}"
    return author


def _fmt_author_vancouver(author: str) -> str:
    parts = author.split()
    if len(parts) >= 2:
        return f"{parts[-1]} {''.join(p[0] for p in parts[:-1])}"
    return author


def _fmt_author_mla(author: str) -> str:
    parts = author.split()
    if len(parts) >= 2:
        return f"{parts[-1]}, {' '.join(parts[:-1])}"
    return author


def _authors_str(authors: List, style: str, threshold: int = 3) -> str:
    if not authors:
        return "Unknown"
    if style in ("nature", "cell", "pnas"):
        fmted = [_fmt_author_nature(a) for a in authors]
    elif style == "apa":
        fmted = [_fmt_author_apa(a) for a in authors]
    elif style == "vancouver":
        fmted = [_fmt_author_vancouver(a) for a in authors]
    elif style == "mla":
        fmted = [_fmt_author_mla(a) for a in authors]
    else:  # science
        fmted = authors  # keep as-is for Science
    if len(fmted) <= threshold:
        if len(fmted) == 1:
            return fmted[0]
        return ", ".join(fmted[:-1]) + " & " + fmted[-1]
    return fmted[0] + " et al."


def _format_one(ref: Dict, number: int, style: str) -> str:
    authors = ref.get("authors") or []
    if isinstance(authors, str):
        try:
            authors = json.loads(authors)
        except Exception:
            authors = [authors]
    title = ref.get("title", "Untitled")
    journal = ref.get("journal", "")
    year = ref.get("year") or ""
    volume = ref.get("volume", "")
    issue = ref.get("issue", "")
    pages = ref.get("pages", "")
    doi = ref.get("doi", "")

    if style in ("nature", "pnas"):
        a = _authors_str(authors, "nature", 3)
        c = f"{number}. {a} {title}. {journal}"
        if volume:
            c += f" {volume}"
        if pages:
            c += f", {pages}"
        if year:
            c += f" ({year})"
        c += "."
        return c

    if style == "science":
        a = _authors_str(authors, "science", 5)
        c = f"{number}. {a}"
        if journal and volume:
            c += f", {journal} {volume}"
            if pages:
                c += f", {pages}"
            if year:
                c += f" ({year})"
        c += "."
        return c

    if style == "cell":
        a = _authors_str(authors, "cell", 10)
        c = f"{a} ({year or 'n.d.'}). {title}. {journal}"
        if volume:
            c += f" {volume}"
            if pages:
                c += f", {pages}"
        c += "."
        return c

    if style == "apa":
        a = _authors_str(authors, "apa", 20)
        c = f"{a} ({year or 'n.d.'}). {title}. {journal}"
        if volume:
            c += f", {volume}"
            if issue:
                c += f"({issue})"
            if pages:
                c += f", {pages}"
        if doi:
            c += f". https://doi.org/{doi}"
        return c

    if style == "vancouver":
        a = _authors_str(authors, "vancouver", 6)
        c = f"{number}. {a}. {title}. {journal}."
        if year:
            c += f" {year}"
        if volume:
            c += f";{volume}"
            if issue:
                c += f"({issue})"
            if pages:
                c += f":{pages}"
        c += "."
        return c

    if style == "mla":
        a = _authors_str(authors, "mla", 1)
        c = f'{a}. "{title}." {journal}'
        if volume:
            c += f", vol. {volume}"
            if issue:
                c += f", no. {issue}"
        if year:
            c += f", {year}"
        if pages:
            c += f", pp. {pages}"
        c += "."
        return c

    return f"{number}. {title}"


# ── Bibliography generation ────────────────────────────────────────────────────

def generate_bibliography(manuscript_id: str, citation_style: str = "nature",
                           selected_ids: Optional[List[str]] = None) -> Dict:
    if citation_style not in CITATION_STYLES:
        return {"success": False, "error": f"Unknown style: {citation_style}"}

    if selected_ids:
        all_refs = get_references(manuscript_id)
        refs = [r for r in all_refs if r.get("id") in set(selected_ids)]
    else:
        refs = get_references(manuscript_id)

    if not refs:
        return {"success": False, "error": "No references found"}

    # Sort by first author last name, then year
    def sort_key(r):
        authors = r.get("authors") or []
        if isinstance(authors, str):
            try:
                authors = json.loads(authors)
            except Exception:
                authors = []
        first = authors[0] if authors else ""
        last_name = first.split()[-1].lower() if first.split() else ""
        return (last_name, r.get("year") or 0)

    refs_sorted = sorted(refs, key=sort_key)
    formatted = []
    for i, ref in enumerate(refs_sorted, 1):
        formatted.append({
            "number": i,
            "reference_id": ref.get("id"),
            "citation": _format_one(ref, i, citation_style),
            "title": ref.get("title", ""),
        })

    bib_text = (
        f"References ({CITATION_STYLES[citation_style]} style)\n\n"
        + "\n\n".join(c["citation"] for c in formatted)
    )
    return {
        "success": True,
        "citation_style": citation_style,
        "reference_count": len(formatted),
        "formatted_citations": formatted,
        "bibliography_text": bib_text,
    }


def get_citation_styles() -> List[Dict]:
    return [
        {"id": k, "name": v, "description": _STYLE_DESC[k]}
        for k, v in CITATION_STYLES.items()
    ]


_STYLE_DESC = {
    "nature": "Nature journal style",
    "science": "Science journal style",
    "cell": "Cell journal style",
    "pnas": "Proceedings of the National Academy of Sciences",
    "apa": "American Psychological Association",
    "vancouver": "Vancouver style (medical journals)",
    "mla": "Modern Language Association",
}
