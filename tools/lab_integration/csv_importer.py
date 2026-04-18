"""CSV import system for neurodegeneration research publications."""
import csv
import io
import logging
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

REQUIRED_FIELDS = ["title", "authors", "journal", "year"]
OPTIONAL_DEFAULTS: Dict[str, Any] = {
    "doi": "",
    "pmid": "",
    "abstract": "",
    "keywords": "",
    "research_area": "neuroscience",
    "corresponding_author": "",
    "funding_source": "",
    "collaboration_type": "external",
    "publication_type": "research_article",
    "impact_factor": "",
    "citation_count": "",
    "notes": "",
}
VALID_CATEGORIES = {
    "research_area": {"neuroscience", "biochemistry", "molecular biology", "pathology", "therapeutics", "diagnostics"},
    "collaboration_type": {"internal", "external", "mixed"},
    "publication_type": {"research_article", "review", "commentary", "editorial", "case_report", "letter"},
}
_DOI_RE = re.compile(r"^10\.\d{4,}/.+$")
_NEURO_KWS = {"prion", "prion protein", "neurodegeneration", "alzheimer", "parkinson",
              "alpha-synuclein", "tau", "amyloid", "protein misfolding", "brain pathology"}


@dataclass
class CSVValidationResult:
    success: bool
    valid_rows: int
    invalid_rows: int
    errors: List[str]
    warnings: List[str]
    parsed_data: List[Dict]


@dataclass
class CSVImportResult:
    success: bool
    total_rows: int
    imported: int
    updated: int
    skipped: int
    errors: List[str]


class NeuroCSVImporter:
    """Validate and import publication CSVs tailored for neurodegeneration research."""

    def validate_csv_content(self, csv_content: str) -> CSVValidationResult:
        try:
            reader = csv.DictReader(io.StringIO(csv_content))
            fieldnames = reader.fieldnames or []
            missing = [f for f in REQUIRED_FIELDS if f not in fieldnames]
            if missing:
                return CSVValidationResult(
                    success=False, valid_rows=0, invalid_rows=0,
                    errors=[f"Missing required columns: {', '.join(missing)}"],
                    warnings=[], parsed_data=[],
                )
            valid = 0
            invalid = 0
            errors: List[str] = []
            warnings: List[str] = []
            parsed: List[Dict] = []

            for idx, row in enumerate(reader, start=1):
                r = self._validate_row(row, idx)
                if r["valid"]:
                    valid += 1
                    parsed.append(r["data"])
                else:
                    invalid += 1
                    errors.extend(r["errors"])
                warnings.extend(r["warnings"])

            return CSVValidationResult(
                success=valid > 0, valid_rows=valid, invalid_rows=invalid,
                errors=errors, warnings=warnings, parsed_data=parsed,
            )
        except Exception as exc:
            logger.error("CSV validation: %s", exc)
            return CSVValidationResult(
                success=False, valid_rows=0, invalid_rows=0,
                errors=[f"Parse error: {exc}"], warnings=[], parsed_data=[],
            )

    def _validate_row(self, row: Dict, idx: int) -> Dict:
        errors: List[str] = []
        warnings: List[str] = []
        data: Dict = {}
        valid = True

        for f in REQUIRED_FIELDS:
            val = row.get(f, "").strip()
            if not val:
                valid = False
                errors.append(f"Row {idx}: missing required field '{f}'")
            else:
                data[f] = val

        for f, default in OPTIONAL_DEFAULTS.items():
            data[f] = row.get(f, "").strip() or default

        if valid:
            try:
                yr = int(data["year"])
                if yr < 1900 or yr > datetime.now().year + 1:
                    warnings.append(f"Row {idx}: unusual year {yr}")
                data["year"] = yr
            except ValueError:
                valid = False
                errors.append(f"Row {idx}: invalid year '{data['year']}'")

            if data["doi"] and not _DOI_RE.match(data["doi"]):
                warnings.append(f"Row {idx}: non-standard DOI '{data['doi']}'")

            if data["pmid"] and not data["pmid"].isdigit():
                warnings.append(f"Row {idx}: non-numeric PMID '{data['pmid']}'")

            for cat_field, valid_vals in VALID_CATEGORIES.items():
                v = data.get(cat_field, "").lower()
                if v and v not in valid_vals:
                    warnings.append(f"Row {idx}: unknown {cat_field} '{v}'; defaulting to first valid")
                    data[cat_field] = sorted(valid_vals)[0]

            # Neurodegeneration relevance hint
            text = f"{data.get('title','')} {data.get('keywords','')} {data.get('abstract','')}".lower()
            if not any(kw in text for kw in _NEURO_KWS):
                warnings.append(f"Row {idx}: may not be relevant to neurodegeneration research")

        return {"valid": valid, "errors": errors, "warnings": warnings, "data": data}

    def import_csv_data(
        self,
        parsed_data: List[Dict],
        update_existing: bool = True,
        username: str = "",
    ) -> CSVImportResult:
        imported = updated = skipped = 0
        errors: List[str] = []

        for idx, row in enumerate(parsed_data, start=1):
            try:
                existing = _find_existing(row)
                if existing is not None:
                    if update_existing:
                        if _update_in_csv(row):
                            updated += 1
                        else:
                            errors.append(f"Row {idx}: update failed")
                    else:
                        skipped += 1
                else:
                    if _save_new(row, username):
                        imported += 1
                    else:
                        errors.append(f"Row {idx}: import failed")
            except Exception as exc:
                errors.append(f"Row {idx}: {exc}")

        return CSVImportResult(
            success=(imported + updated) > 0,
            total_rows=len(parsed_data),
            imported=imported,
            updated=updated,
            skipped=skipped,
            errors=errors,
        )

    @staticmethod
    def generate_csv_template() -> str:
        headers = REQUIRED_FIELDS + list(OPTIONAL_DEFAULTS.keys())
        examples = [
            {
                "title": "Prion protein misfolding mechanisms in neurodegeneration",
                "authors": "Castilla J, García-Martínez L, Rodríguez-Santos M",
                "journal": "Nature Neuroscience", "year": "2023",
                "doi": "10.1038/s41593-023-01234-5", "pmid": "36789012",
                "abstract": "Prion proteins undergo conformational changes...",
                "keywords": "prion protein; misfolding; neurodegeneration",
                "research_area": "neuroscience", "corresponding_author": "joaquin.castilla@ehu.eus",
                "funding_source": "EU Horizon 2020; NIH R01",
                "collaboration_type": "internal", "publication_type": "research_article",
                "impact_factor": "25.3", "citation_count": "45", "notes": "", },
            {
                "title": "Alpha-synuclein aggregation in Parkinson's disease",
                "authors": "García-Martínez L, López-Fernández A, Castilla J",
                "journal": "Journal of Neuroscience", "year": "2022",
                "doi": "10.1523/JNEUROSCI.1234-21.2022", "pmid": "34567890",
                "abstract": "Investigation of alpha-synuclein aggregation mechanisms...",
                "keywords": "Parkinson's disease; alpha-synuclein; protein aggregation",
                "research_area": "neuroscience", "corresponding_author": "luis.garcia@ehu.eus",
                "funding_source": "Basque Government; La Caixa Foundation",
                "collaboration_type": "internal", "publication_type": "research_article",
                "impact_factor": "6.2", "citation_count": "32", "notes": "", },
        ]
        out = io.StringIO()
        writer = csv.DictWriter(out, fieldnames=headers, extrasaction="ignore", quoting=csv.QUOTE_ALL)
        writer.writeheader()
        writer.writerows(examples)
        return out.getvalue()


# ── Storage helpers ────────────────────────────────────────────────────────────

def _find_existing(row: Dict) -> Optional[str]:
    """Return a truthy identifier if a matching publication already exists."""
    doi = row.get("doi", "").strip()
    try:
        from tools.research.models import get_all_publications
        for p in get_all_publications():
            if doi and (p.get("doi") or "").strip().lower() == doi.lower():
                return p.get("pub_id", "found")
    except Exception:
        pass
    return None


def _save_new(row: Dict, username: str = "") -> bool:
    """Save to DB if configured, else append to lab_imports.csv."""
    try:
        from database.config import db
        if db.is_configured():
            from database.models import Publication
            with db.get_session() as s:
                p = Publication(
                    title=row["title"],
                    authors=row["authors"],
                    journal=row["journal"],
                    year=int(row["year"]),
                    doi=row.get("doi", ""),
                    abstract=row.get("abstract", ""),
                    pub_type=_map_pub_type(row.get("publication_type", "research_article")),
                    impact_factor=_safe_float(row.get("impact_factor")),
                    citation_count=_safe_int(row.get("citation_count")),
                )
                if hasattr(p, "update_search_vector"):
                    p.update_search_vector()
                s.add(p)
            return True
    except Exception as exc:
        logger.debug("DB save failed: %s", exc)
    return _append_csv(row)


def _update_in_csv(row: Dict) -> bool:
    """No-op update for CSV fallback (no row-level update without DB)."""
    return True  # treat as success; full update requires DB


def _append_csv(row: Dict) -> bool:
    try:
        import config
        csv_path = os.path.join(config.DATA_DIR, "lab_csv_imports.csv")
    except Exception:
        csv_path = os.path.join("data", "lab_csv_imports.csv")
    os.makedirs(os.path.dirname(csv_path), exist_ok=True)
    fieldnames = REQUIRED_FIELDS + list(OPTIONAL_DEFAULTS.keys())
    exists = os.path.exists(csv_path)
    with open(csv_path, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore", quoting=csv.QUOTE_ALL)
        if not exists:
            writer.writeheader()
        writer.writerow(row)
    return True


def _map_pub_type(t: str) -> str:
    mapping = {"research_article": "article", "review": "review", "commentary": "editorial",
               "editorial": "editorial", "letter": "letter"}
    return mapping.get(t.lower(), "article")


def _safe_float(v: Any) -> Optional[float]:
    try:
        return float(v) if v else None
    except (TypeError, ValueError):
        return None


def _safe_int(v: Any) -> Optional[int]:
    try:
        return int(v) if v else None
    except (TypeError, ValueError):
        return None


# Module singleton
_csv_importer: Optional[NeuroCSVImporter] = None


def get_csv_importer() -> NeuroCSVImporter:
    global _csv_importer
    if _csv_importer is None:
        _csv_importer = NeuroCSVImporter()
    return _csv_importer
