"""Parse a .bib file into plain article dicts for the BibTeX import wizard.

Generic BibTeX parser — handles files produced by PrionVault's own
exporter (bibtex_exporter.py) as well as common sources like Zotero,
EndNote or Google Scholar. Field values may be wrapped in balanced
braces ({...}, with nesting) or double quotes ("...").
"""
from __future__ import annotations

import re

_ENTRY_START = re.compile(r'@(\w+)\s*\{\s*([^,\s]*)\s*,', re.IGNORECASE)


def _split_entries(text: str) -> list[tuple[str, str, str]]:
    """Return [(entry_type, cite_key, body), ...] — body is everything
    between the entry's opening brace (after the key) and its matching
    closing brace, found via depth counting since fields can themselves
    contain braces."""
    entries = []
    for m in _ENTRY_START.finditer(text):
        entry_type = m.group(1).lower()
        if entry_type in ('string', 'comment', 'preamble'):
            continue
        cite_key = m.group(2).strip()
        start = m.end()
        depth = 1
        i = start
        while i < len(text) and depth > 0:
            if text[i] == '{':
                depth += 1
            elif text[i] == '}':
                depth -= 1
            i += 1
        if depth != 0:
            continue
        entries.append((entry_type, cite_key, text[start:i - 1]))
    return entries


def _split_fields(body: str) -> dict[str, str]:
    """Split a `field = {value}, field = "value", ...` body into a dict,
    keyed by lower-cased field name."""
    fields: dict[str, str] = {}
    i = 0
    n = len(body)
    while i < n:
        m = re.match(r'\s*,?\s*([A-Za-z][\w-]*)\s*=\s*', body[i:])
        if not m:
            break
        name = m.group(1).lower()
        i += m.end()
        if i >= n:
            break
        if body[i] == '{':
            depth = 1
            j = i + 1
            while j < n and depth > 0:
                if body[j] == '{':
                    depth += 1
                elif body[j] == '}':
                    depth -= 1
                j += 1
            fields[name] = body[i + 1:j - 1].strip()
            i = j
        elif body[i] == '"':
            j = i + 1
            while j < n and body[j] != '"':
                j += 1
            fields[name] = body[i + 1:j].strip()
            i = j + 1
        else:
            j = body.find(',', i)
            if j == -1:
                j = n
            fields[name] = body[i:j].strip()
            i = j
    return fields


def _clean_ws(value: str) -> str:
    return re.sub(r'\s+', ' ', value or '').strip()


def _strip_braces(value: str) -> str:
    """Drop literal { } used in BibTeX to protect capitalisation, e.g.
    "{PrP}Sc" -> "PrPSc"."""
    return value.replace('{', '').replace('}', '')


def _bibtex_authors_to_pv(raw: str) -> str:
    """"First Last and First Last" -> "First Last; First Last"
    (PrionVault's free-text author separator)."""
    raw = _clean_ws(_strip_braces(raw))
    if not raw:
        return ''
    parts = re.split(r'\s+\band\b\s+', raw, flags=re.IGNORECASE)
    out = []
    for p in parts:
        p = p.strip().strip(',')
        if not p:
            continue
        if ',' in p:
            # "Last, First" -> "First Last"
            last, _, first = p.partition(',')
            p = f"{first.strip()} {last.strip()}".strip()
        out.append(p)
    return '; '.join(out)


def _extract_year(fields: dict[str, str]) -> int | None:
    raw = fields.get('year') or ''
    m = re.search(r'\d{4}', raw)
    return int(m.group(0)) if m else None


def _extract_doi(fields: dict[str, str]) -> str | None:
    doi = fields.get('doi', '').strip()
    if doi:
        doi = re.sub(r'^https?://(dx\.)?doi\.org/', '', doi, flags=re.IGNORECASE)
        return doi or None
    # Some exports (Google Scholar, EndNote) stash the DOI in the URL/note field.
    for key in ('url', 'note'):
        m = re.search(r'10\.\d{4,9}/\S+', fields.get(key, ''))
        if m:
            return m.group(0).rstrip('.,;)')
    return None


def _extract_pmid(fields: dict[str, str]) -> str | None:
    for key in ('pmid', 'eprint', 'note', 'annote'):
        raw = fields.get(key, '')
        m = re.search(r'\b(\d{6,9})\b', raw)
        if m and (key == 'pmid' or 'pmid' in raw.lower()):
            return m.group(1)
    return None


def parse_bibtex(text: str) -> list[dict]:
    """Parse raw .bib text into a list of dicts with PrionVault-shaped
    keys: cite_key, entry_type, title, authors, year, journal, doi,
    pubmed_id, raw (original entry text, for diagnostics)."""
    out = []
    for entry_type, cite_key, body in _split_entries(text):
        fields = _split_fields(body)
        title = _clean_ws(_strip_braces(fields.get('title', '')))
        if not title and not fields.get('doi') and not fields.get('pmid'):
            continue
        out.append({
            'cite_key':  cite_key,
            'entry_type': entry_type,
            'title':     title,
            'authors':   _bibtex_authors_to_pv(fields.get('author', '')),
            'year':      _extract_year(fields),
            'journal':   _clean_ws(_strip_braces(fields.get('journal') or fields.get('journaltitle', ''))),
            'doi':       _extract_doi(fields),
            'pubmed_id': _extract_pmid(fields),
        })
    return out
