"""Extract text + page count + DOI candidate from a PDF file.

Uses pdfplumber under the hood. Returns a structured result so the
worker can decide how to handle each step independently — extraction
failures don't crash the whole ingest.
"""
from __future__ import annotations

import io
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Union

logger = logging.getLogger(__name__)

# DOI regex shared with the rest of PrionVault. Matches the form
# "10.<registrant>/<suffix>" anywhere in the text. Stops at whitespace,
# common closing punctuation and the closing parenthesis.
_DOI_RE = re.compile(r"\b10\.\d{4,}/[^\s\"'<>,;\]\)]+", re.IGNORECASE)

# Heuristic to grab a DOI even when the PDF says "DOI: 10.xxxx/yyyy".
_DOI_LABEL_RE = re.compile(
    r"(?:doi(?:\.org)?[:/]\s*|https?://(?:dx\.)?doi\.org/)?"
    r"(10\.\d{4,}/[^\s\"'<>,;\]\)]+)",
    re.IGNORECASE,
)

# PMID patterns: "PMID: 12345678", "PubMed ID: 12345678", "PMID12345678",
# "PubMed PMID: 12345678", "Medline PMID: 12345678".
# PMIDs are 1-8 digits; we require at least 5 to avoid false positives.
_PMID_RE = re.compile(
    r"(?:PubMed(?:\s+PMID)?|PMID|Medline\s+PMID|PubMed\s+ID)\s*:?\s*(\d{5,8})\b",
    re.IGNORECASE,
)


@dataclass
class ExtractionResult:
    text:       str           # the full extracted text (may be empty)
    pages:      int           # number of pages
    doi:        Optional[str] # best DOI candidate found, normalised lowercase
    pmid:       Optional[str] # PubMed ID found in the text, if any
    title_hint: Optional[str] # first non-empty line of the first page,
                              # useful as a fallback for CrossRef title lookup
    error:      Optional[str] # short error string if extraction failed


def normalise_doi(doi: str) -> str:
    """Strip URL prefix, trailing punctuation, and lowercase."""
    s = doi.strip().rstrip(".,;:)")
    s = re.sub(r"^(?:https?://)?(?:dx\.)?doi\.org/", "", s, flags=re.IGNORECASE)
    return s.lower()


def find_doi_in_text(text: str) -> Optional[str]:
    """Return the best DOI candidate from `text`, normalised, or None.

    Strategy (mirrors PrionRead's approach):
      1. Collect all labelled DOIs (DOI: 10.xxx/yyy) from the first page only.
         These are authoritative; pick the shortest (the paper's own DOI is
         typically shorter than reference DOIs).
      2. If none found on page 1, try the full text labelled matches.
      3. Last resort: bare DOI pattern anywhere, again shortest wins.
    A paper's own DOI is nearly always shorter than reference DOIs.
    """
    if not text:
        return None

    # Limit to first 3 000 chars (≈ first page) for the high-confidence pass.
    head = text[:3000]
    candidates: list[str] = []

    for m in _DOI_LABEL_RE.finditer(head):
        cand = normalise_doi(m.group(1))
        if cand and len(cand) >= 7:
            candidates.append(cand)

    if not candidates:
        # Try full text with labelled form.
        for m in _DOI_LABEL_RE.finditer(text):
            cand = normalise_doi(m.group(1))
            if cand and len(cand) >= 7:
                candidates.append(cand)

    if candidates:
        return min(candidates, key=len)

    # Last resort: bare DOI pattern, collect all, pick shortest.
    all_bare = [normalise_doi(m.group(0)) for m in _DOI_RE.finditer(text)]
    all_bare = [c for c in all_bare if len(c) >= 7]
    return min(all_bare, key=len) if all_bare else None


def find_pmid_in_text(text: str) -> Optional[str]:
    """Return the first plausible PubMed ID found in `text`, or None."""
    if not text:
        return None
    m = _PMID_RE.search(text)
    return m.group(1) if m else None


def _extract_first_meaningful_line(text: str) -> Optional[str]:
    """Heuristic for `title_hint`: first non-trivial line of the first page."""
    if not text:
        return None
    for raw in text.split("\n")[:30]:
        line = raw.strip()
        # Skip page numbers, journal headers, very short lines, all-caps
        # noise common in headers.
        if len(line) < 12:
            continue
        if line.isdigit():
            continue
        if re.match(r"^[\d\s\.]+$", line):
            continue
        return line[:300]
    return None


def extract_pdf(source: Union[str, Path, bytes, io.IOBase]) -> ExtractionResult:
    """Extract text + page count + DOI candidate.

    `source` may be a file path, a bytes object (the raw PDF) or any
    file-like object. We never raise — failures are reported in the
    `.error` field.
    """
    try:
        import pdfplumber
    except ImportError as exc:
        return ExtractionResult(text="", pages=0, doi=None, title_hint=None,
                                error=f"pdfplumber not installed: {exc}")

    try:
        # pdfplumber accepts paths, file-like objects, or BytesIO directly.
        if isinstance(source, (bytes, bytearray)):
            opener = pdfplumber.open(io.BytesIO(source))
        else:
            opener = pdfplumber.open(source)

        with opener as pdf:
            pages = len(pdf.pages)
            chunks = []
            for page in pdf.pages:
                try:
                    txt = page.extract_text(x_tolerance=2, y_tolerance=2)
                except Exception as exc:
                    logger.debug("pdfplumber page extract failed: %s", exc)
                    txt = None
                if txt:
                    chunks.append(txt)
            full = "\n".join(chunks).strip()

        return ExtractionResult(
            text=full,
            pages=pages,
            doi=find_doi_in_text(full),
            pmid=find_pmid_in_text(full),
            title_hint=_extract_first_meaningful_line(full),
            error=None if (full or pages == 0) else "no_text_extracted",
        )
    except Exception as exc:
        logger.warning("PDF extraction failed: %s", exc, exc_info=False)
        return ExtractionResult(text="", pages=0, doi=None, pmid=None,
                                title_hint=None, error=str(exc)[:300])
