"""BibTeX parser for ReadCube Papers exports."""
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

_NEURO_KEYWORDS = {
    "prion", "prion protein", "prp", "prion disease",
    "neurodegeneration", "neurodegenerative", "alzheimer", "parkinson",
    "huntington", "alpha-synuclein", "tau", "amyloid",
    "protein misfolding", "protein aggregation", "neuropathology",
    "cerebrospinal fluid", "csf", "neuroinflammation", "microglia",
    "autophagy", "neuroprotection", "biomarkers", "brain pathology",
}
_NEURO_JOURNALS = {
    "nature neuroscience", "neuron", "brain", "acta neuropathologica",
    "journal of neuroscience", "molecular neurodegeneration",
    "neurobiology of disease", "neurobiology of aging",
    "alzheimer's & dementia", "parkinsonism & related disorders",
    "movement disorders", "journal of alzheimer's disease", "prion",
}
_DOI_RE = re.compile(r"^10\.\d{4,}/\S+$")


@dataclass
class ParsedReference:
    """BibTeX reference data structure."""
    ref_uuid: str
    title: str
    authors: List[str] = field(default_factory=list)
    journal: str = ""
    year: int = 0
    volume: str = ""
    issue: str = ""
    pages: str = ""
    doi: str = ""
    pmid: str = ""
    isbn: str = ""
    url: str = ""
    abstract: str = ""
    keywords: List[str] = field(default_factory=list)
    research_area: str = "general"
    entry_type: str = "article"
    bibtex_key: str = ""
    raw_bibtex: str = ""


class BibTeXParser:
    """Parse BibTeX files exported from ReadCube Papers."""

    def parse_file(self, content: str) -> Tuple[List[ParsedReference], List[str]]:
        """Parse BibTeX content, return (references, errors)."""
        try:
            content = self._clean(content)
            entries = self._split(content)
            refs: List[ParsedReference] = []
            errors: List[str] = []
            for entry in entries:
                try:
                    ref = self._parse_entry(entry)
                    if ref:
                        ref.research_area = self._classify(ref)
                        refs.append(ref)
                except Exception as exc:
                    errors.append(f"Parse error: {str(exc)[:120]}")
            logger.info("BibTeX: parsed %d refs, %d errors", len(refs), len(errors))
            return refs, errors
        except Exception as exc:
            logger.error("BibTeX critical error: %s", exc)
            return [], [f"Critical error: {exc}"]

    def validate(self, refs: List[ParsedReference]) -> Tuple[List[ParsedReference], List[str]]:
        warnings: List[str] = []
        for r in refs:
            w: List[str] = []
            if not r.title:
                w.append("missing title")
            if not r.authors:
                w.append("missing authors")
            if not r.year:
                w.append("missing year")
            if r.doi and not _DOI_RE.match(r.doi):
                w.append("invalid DOI format")
            if w:
                warnings.append(f"'{r.title[:50]}': {', '.join(w)}")
        return refs, warnings

    # ── Private helpers ────────────────────────────────────────────────────────

    @staticmethod
    def _clean(content: str) -> str:
        content = content.lstrip("\ufeff")
        content = content.replace("\r\n", "\n").replace("\r", "\n")
        return re.sub(r"\n\s*\n", "\n\n", content).strip()

    @staticmethod
    def _split(content: str) -> List[str]:
        entries: List[str] = []
        current = ""
        depth = 0
        in_entry = False
        for line in content.split("\n"):
            stripped = line.strip()
            if not stripped:
                continue
            if re.match(r"^@\w+\s*\{", stripped):
                if current and in_entry:
                    entries.append(current.strip())
                current = stripped + "\n"
                depth = stripped.count("{") - stripped.count("}")
                in_entry = True
            elif in_entry:
                current += stripped + "\n"
                depth += stripped.count("{") - stripped.count("}")
                if depth <= 0:
                    entries.append(current.strip())
                    current = ""
                    in_entry = False
        if current.strip():
            entries.append(current.strip())
        return entries

    def _parse_entry(self, text: str) -> Optional[ParsedReference]:
        m = re.match(r"^@(\w+)\s*\{\s*([^,\s]+)", text, re.IGNORECASE)
        if not m:
            return None
        entry_type = m.group(1).lower()
        bibtex_key = m.group(2).strip()
        fields = self._extract_fields(text)
        return ParsedReference(
            ref_uuid=str(uuid.uuid4()),
            title=self._clean_val(fields.get("title", "")),
            authors=self._parse_authors(fields.get("author", "")),
            journal=self._clean_val(fields.get("journal", fields.get("booktitle", ""))),
            year=self._extract_year(fields.get("year", ""), fields.get("date", "")),
            volume=self._clean_val(fields.get("volume", "")),
            issue=self._clean_val(fields.get("number", fields.get("issue", ""))),
            pages=self._norm_pages(fields.get("pages", "")),
            doi=self._extract_doi(fields.get("doi", "")),
            pmid=self._clean_val(fields.get("pmid", "")),
            isbn=self._clean_val(fields.get("isbn", "")),
            url=self._clean_val(fields.get("url", "")),
            abstract=self._clean_val(fields.get("abstract", "")),
            keywords=self._parse_keywords(fields.get("keywords", "")),
            entry_type=entry_type,
            bibtex_key=bibtex_key,
            raw_bibtex=text,
        )

    @staticmethod
    def _extract_fields(text: str) -> Dict[str, str]:
        # Strip entry header
        body = re.sub(r"^@\w+\s*\{[^,]+,", "", text, flags=re.IGNORECASE)
        body = body.rstrip("}").strip()
        fields: Dict[str, str] = {}
        # Match field = {value} or field = "value"
        for m in re.finditer(
            r'(\w+)\s*=\s*(?:\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}|"([^"]*)")',
            body, re.DOTALL,
        ):
            name = m.group(1).lower()
            val = m.group(2) if m.group(2) is not None else m.group(3)
            if val is not None:
                fields[name] = val.strip()
        return fields

    @staticmethod
    def _parse_authors(raw: str) -> List[str]:
        if not raw:
            return []
        parts = re.split(r"\s+and\s+", raw, flags=re.IGNORECASE)
        result = []
        for p in parts:
            p = p.strip()
            if not p:
                continue
            if "," in p:
                last, first = p.split(",", 1)
                result.append(f"{first.strip()} {last.strip()}")
            else:
                result.append(p)
        return result

    @staticmethod
    def _extract_year(year_field: str, date_field: str) -> int:
        for src in (year_field, date_field):
            m = re.search(r"(\d{4})", src)
            if m:
                return int(m.group(1))
        return 0

    @staticmethod
    def _clean_val(val: str) -> str:
        if not val:
            return ""
        val = re.sub(r"^\{+|^\"+|\"+$|\}+$", "", val)
        return re.sub(r"\s+", " ", val).strip()

    @staticmethod
    def _norm_pages(pages: str) -> str:
        if not pages:
            return ""
        p = re.sub(r"^\{+|^\"+|\"+$|\}+$", "", pages)
        return p.replace("--", "-").strip()

    @staticmethod
    def _extract_doi(raw: str) -> str:
        if not raw:
            return ""
        doi = re.sub(r"^\{+|^\"+|\"+$|\}+$", "", raw).strip()
        doi = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", doi)
        return doi

    @staticmethod
    def _parse_keywords(raw: str) -> List[str]:
        if not raw:
            return []
        cleaned = re.sub(r"^\{+|^\"+|\"+$|\}+$", "", raw).strip()
        return [k.strip() for k in re.split(r"[,;]", cleaned) if k.strip()]

    @staticmethod
    def _classify(ref: ParsedReference) -> str:
        text = " ".join([
            ref.title.lower(), ref.journal.lower(),
            ref.abstract.lower(), " ".join(ref.keywords).lower(),
        ])
        if any(kw in text for kw in _NEURO_KEYWORDS) or any(j in ref.journal.lower() for j in _NEURO_JOURNALS):
            return "neuroscience"
        if any(t in text for t in ("biochemistry", "molecular", "protein structure")):
            return "biochemistry"
        if any(t in text for t in ("pathology", "disease", "clinical trial")):
            return "pathology"
        if any(t in text for t in ("therapeutic", "drug", "treatment", "therapy")):
            return "therapeutics"
        return "general"


_parser: Optional[BibTeXParser] = None


def get_bibtex_parser() -> BibTeXParser:
    global _parser
    if _parser is None:
        _parser = BibTeXParser()
    return _parser
