"""Generate a .bib file from a list of PrionVault references.

Built for exporting into the FECYT CVN Editor's "Importar publicaciones"
wizard, which accepts BibTeX as one of its source formats (CVN's own
XML schema is not publicly documented, so BibTeX is the practical
interoperable target — see the "Exportar referencias" help entry).

Only @article entries are produced — PrionVault's library is journal
articles. Field mapping straight from articles + source_metadata, no
network lookups (unlike the Gobierno Vasco .docx export, which hits
SCImago for quality indicators — out of scope here).
"""
from __future__ import annotations

import re
import unicodedata

from .refs_exporter import _split_authors, _govasco_vol_pages

_BIBTEX_SPECIAL = str.maketrans({
    '{': r'\{', '}': r'\}', '&': r'\&', '%': r'\%',
    '$': r'\$', '#': r'\#', '_': r'\_',
})


def _escape(value: str) -> str:
    return (value or '').translate(_BIBTEX_SPECIAL)


def _cite_key_stub(authors: str, year) -> str:
    """First author's surname (last whitespace-separated token, since
    names are stored as free text) + year, ASCII-folded and stripped of
    anything not alphanumeric — e.g. "Castilla2024"."""
    first_author = _split_authors(authors)[0] if authors else ''
    surname = first_author.split()[-1] if first_author.split() else 'ref'
    surname = unicodedata.normalize('NFD', surname).encode('ascii', 'ignore').decode('ascii')
    surname = re.sub(r'[^A-Za-z0-9]', '', surname) or 'ref'
    return f"{surname}{year or ''}"


def _bibtex_authors(authors: str) -> str:
    """"First Last; First Last" -> "First Last and First Last".

    Names are stored as free text with no reliable First/Last split
    (accents, compound surnames, "de la"-style particles), so authors
    are passed through as-is rather than guessing a "Last, First"
    rewrite that could easily get it wrong.
    """
    return ' and '.join(_split_authors(authors))


def generate_bibtex(articles: list[dict]) -> str:
    """Return the full .bib file content for a list of article dicts.

    Each dict is expected to carry: title, authors, year, journal, doi,
    pubmed_id, source_metadata (for volume/issue/pages/issn).
    """
    used_keys: dict[str, int] = {}
    entries: list[str] = []

    for article in articles:
        sm = article.get('source_metadata') or {}
        volume, first_page, last_page = _govasco_vol_pages(sm)
        issue = str(sm.get('issue') or sm.get('number') or '').strip()
        issn = str(sm.get('issn') or '').strip()
        pages = f"{first_page}--{last_page}" if first_page and last_page else (first_page or last_page)

        stub = _cite_key_stub(article.get('authors', ''), article.get('year'))
        n = used_keys.get(stub, 0)
        used_keys[stub] = n + 1
        key = stub if n == 0 else f"{stub}{chr(ord('a') + n - 1)}"

        fields: list[tuple[str, str]] = []
        if article.get('authors'):
            fields.append(('author', _bibtex_authors(article['authors'])))
        if article.get('title'):
            # Double-braced so BibTeX/CVN importers preserve capitalization
            # (acronyms, species names) instead of lowercasing the title.
            fields.append(('title', '{' + _escape(article['title']) + '}'))
        if article.get('journal'):
            fields.append(('journal', _escape(article['journal'])))
        if article.get('year'):
            fields.append(('year', str(article['year'])))
        if volume:
            fields.append(('volume', _escape(volume)))
        if issue:
            fields.append(('number', _escape(issue)))
        if pages:
            fields.append(('pages', _escape(pages)))
        if article.get('doi'):
            fields.append(('doi', _escape(article['doi'])))
        if issn:
            fields.append(('issn', _escape(issn)))
        if article.get('pubmed_id'):
            fields.append(('pmid', _escape(str(article['pubmed_id']))))

        body = ',\n'.join(f'  {name} = {{{value}}}' for name, value in fields)
        entries.append(f'@article{{{key},\n{body}\n}}')

    return '\n\n'.join(entries) + ('\n' if entries else '')
