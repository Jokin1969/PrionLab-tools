"""Glossary management for biomedical terminology normalization.

Handles:
  - Import of English → Spanish term mappings
  - Versioning: tracks new and changed terms
  - Diff detection: identifies what changed since last import
  - Glossary injection into AI prompts for consistent terminology
"""
from __future__ import annotations

import logging
from typing import Optional
from dataclasses import dataclass

from sqlalchemy import text as sql_text

logger = logging.getLogger(__name__)

# Expected TSV column headers
EXPECTED_COLUMNS = ["English", "Castellano recomendado", "Evitar", "Comentario", "Categoría"]
EXPECTED_COLUMNS_LOWER = [c.lower() for c in EXPECTED_COLUMNS]


def _get_engine():
    """Get database engine."""
    from ..ingestion.queue import _get_engine as _e
    return _e()


@dataclass
class GlossaryTerm:
    """Single glossary entry."""
    term_en: str
    term_es_recommended: str
    term_es_avoid: Optional[str] = None
    notes: Optional[str] = None
    category: Optional[str] = None
    version: int = 1


@dataclass
class ImportResult:
    """Result of glossary import."""
    imported: int
    updated: int
    skipped: int
    errors: list[str]
    new_version: int


@dataclass
class GlossaryDiff:
    """Changes since last import."""
    new_terms: list[GlossaryTerm]
    updated_terms: list[tuple[GlossaryTerm, GlossaryTerm]]  # (old, new)
    total_terms: int
    version_before: int
    version_after: int


def import_glossary(terms: list[dict]) -> ImportResult:
    """Import complete glossary version (replaces previous version).

    Each dict should have: term_en, term_es_recommended, term_es_avoid (optional),
    notes (optional), category (optional).

    Deletes all old terms and inserts new ones under incremented version number.
    Returns ImportResult with counts and any errors.
    """
    if not terms:
        return ImportResult(imported=0, updated=0, skipped=0, errors=[], new_version=1)

    eng = _get_engine()
    imported = 0
    skipped = 0
    errors: list[str] = []
    new_version = 1

    try:
        with eng.begin() as conn:
            # Get current version and increment
            meta = conn.execute(sql_text(
                "SELECT current_version FROM prionvault_glossary_metadata "
                "ORDER BY id DESC LIMIT 1"
            )).first()
            old_version = meta[0] if meta else 0
            new_version = old_version + 1

            # Delete all old terms (replace, don't update)
            if old_version > 0:
                conn.execute(sql_text(
                    "DELETE FROM prionvault_glossary_terms WHERE version = :old_v"
                ), {"old_v": old_version})

            # Insert all new terms
            for term_dict in terms:
                try:
                    term_en = (term_dict.get("term_en") or "").strip().lower()
                    term_es = (term_dict.get("term_es_recommended") or "").strip()
                    avoid = (term_dict.get("term_es_avoid") or "").strip() or None
                    notes = (term_dict.get("notes") or "").strip() or None
                    category = (term_dict.get("categoria") or
                               term_dict.get("category") or "").strip() or None

                    if not term_en or not term_es:
                        errors.append(f"Missing EN or ES: {term_dict}")
                        skipped += 1
                        continue

                    conn.execute(sql_text(
                        """INSERT INTO prionvault_glossary_terms
                           (term_en, term_es_recommended, term_es_avoid, notes, category, version)
                           VALUES (:en, :es, :avoid, :notes, :cat, :v)"""
                    ), {
                        "en": term_en,
                        "es": term_es,
                        "avoid": avoid,
                        "notes": notes,
                        "cat": category,
                        "v": new_version,
                    })
                    imported += 1
                except Exception as e:
                    errors.append(f"Error processing {term_dict}: {str(e)[:200]}")
                    skipped += 1

            # Update metadata
            conn.execute(sql_text(
                """INSERT INTO prionvault_glossary_metadata (current_version, total_terms, notes)
                   VALUES (:v, :count, :notes)
                   ON CONFLICT (id) DO NOTHING"""
            ), {
                "v": new_version,
                "count": imported,
                "notes": f"Version {new_version}: {imported} terms, {skipped} skipped",
            })

    except Exception as e:
        logger.exception("glossary import failed")
        errors.append(f"Database error: {str(e)[:300]}")

    return ImportResult(
        imported=imported,
        updated=0,  # No longer tracking updates, full replacement
        skipped=skipped,
        errors=errors,
        new_version=new_version,
    )


def get_diff(since_version: Optional[int] = None) -> GlossaryDiff:
    """Get changes since a previous version.

    If since_version is None, returns changes since second-to-last version.
    Useful for seeing what changed on re-import.
    """
    eng = _get_engine()
    with eng.connect() as conn:
        # Get current and previous versions
        meta = conn.execute(sql_text(
            "SELECT current_version FROM prionvault_glossary_metadata "
            "ORDER BY id DESC LIMIT 2"
        )).all()

        if not meta:
            return GlossaryDiff(
                new_terms=[],
                updated_terms=[],
                total_terms=0,
                version_before=0,
                version_after=1,
            )

        current_version = meta[0][0] if meta else 1
        prev_version = meta[1][0] if len(meta) > 1 else 0
        compare_version = since_version or prev_version

        # Terms only in current version (new)
        new = conn.execute(sql_text(
            "SELECT term_en, term_es_recommended, term_es_avoid, notes, category, version "
            "FROM prionvault_glossary_terms "
            "WHERE version = :cur AND term_en NOT IN ("
            "  SELECT term_en FROM prionvault_glossary_terms WHERE version < :cur"
            ")"
        ), {"cur": current_version}).all()

        new_terms = [
            GlossaryTerm(
                term_en=r[0],
                term_es_recommended=r[1],
                term_es_avoid=r[2],
                notes=r[3],
                category=r[4],
                version=r[5],
            )
            for r in new
        ]

        # Terms in both versions but different
        updated_pairs = []
        all_terms = conn.execute(sql_text(
            "SELECT DISTINCT term_en FROM prionvault_glossary_terms "
            "WHERE version IN (:prev, :cur)"
        ), {"prev": compare_version, "cur": current_version}).all()

        for (term_en,) in all_terms:
            old = conn.execute(sql_text(
                "SELECT term_es_recommended, term_es_avoid, notes FROM prionvault_glossary_terms "
                "WHERE term_en = :en AND version <= :v ORDER BY version DESC LIMIT 1"
            ), {"en": term_en, "v": compare_version}).first()

            new = conn.execute(sql_text(
                "SELECT term_es_recommended, term_es_avoid, notes FROM prionvault_glossary_terms "
                "WHERE term_en = :en AND version = :v"
            ), {"en": term_en, "v": current_version}).first()

            if old and new and old[0] != new[0]:  # ES translation changed
                updated_pairs.append((
                    GlossaryTerm(
                        term_en=term_en,
                        term_es_recommended=old[0],
                        term_es_avoid=old[1],
                        notes=old[2],
                    ),
                    GlossaryTerm(
                        term_en=term_en,
                        term_es_recommended=new[0],
                        term_es_avoid=new[1],
                        notes=new[2],
                    ),
                ))

        # Total count
        total = conn.execute(sql_text(
            "SELECT COUNT(*) FROM prionvault_glossary_terms "
            "WHERE version = :v"
        ), {"v": current_version}).scalar() or 0

    return GlossaryDiff(
        new_terms=new_terms,
        updated_terms=updated_pairs,
        total_terms=total,
        version_before=compare_version,
        version_after=current_version,
    )


def get_glossary_context() -> str:
    """Return glossary as formatted context for AI prompts.

    Format: English term | Spanish recommendation | Category | Notes
    Useful for injecting into system prompt for summary generation.
    """
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text(
            """SELECT term_en, term_es_recommended, category, notes
               FROM prionvault_glossary_terms
               WHERE version = (SELECT MAX(version) FROM prionvault_glossary_metadata)
               ORDER BY category, term_en"""
        )).all()

    if not rows:
        return ""

    lines = []
    current_cat = None
    for term_en, term_es, cat, notes in rows:
        if cat != current_cat:
            lines.append(f"\n[{cat or 'General'}]")
            current_cat = cat
        note_str = f" — {notes}" if notes else ""
        lines.append(f"  {term_en} → {term_es}{note_str}")

    return "\n".join(lines)


def get_all_terms(category: Optional[str] = None) -> list[dict]:
    """List all current glossary terms, optionally filtered by category."""
    eng = _get_engine()
    with eng.connect() as conn:
        where = ""
        params = {}
        if category:
            where = " AND category = :cat"
            params["cat"] = category

        rows = conn.execute(sql_text(
            f"""SELECT term_en, term_es_recommended, term_es_avoid, notes, category, version
               FROM prionvault_glossary_terms
               WHERE version = (SELECT MAX(version) FROM prionvault_glossary_metadata){where}
               ORDER BY category, term_en"""
        ), params).mappings().all()

    return [dict(r) for r in rows]


def get_categories() -> list[str]:
    """List all categories in current glossary."""
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text(
            """SELECT DISTINCT category FROM prionvault_glossary_terms
               WHERE version = (SELECT MAX(version) FROM prionvault_glossary_metadata)
               AND category IS NOT NULL
               ORDER BY category"""
        )).all()
    return [r[0] for r in rows]


def get_current_glossary_version() -> int:
    """Get the current glossary version number."""
    eng = _get_engine()
    with eng.connect() as conn:
        result = conn.execute(sql_text(
            "SELECT current_version FROM prionvault_glossary_metadata "
            "ORDER BY id DESC LIMIT 1"
        )).scalar()
    return result or 1


def validate_tsv_format(tsv_content: str) -> tuple[bool, list[str], list[dict]]:
    """Validate TSV format and return (is_valid, errors, preview_rows).

    Checks:
    - Correct number of columns
    - Column headers match expected
    - At least one data row
    - Required fields (EN, ES) not empty

    Returns:
      (is_valid, error_messages, preview_data)
      preview_data contains up to 5 rows for user confirmation
    """
    lines = tsv_content.strip().split('\n')
    if not lines:
        return False, ["File is empty"], []

    errors = []

    # Parse header
    header_cells = lines[0].split('\t')
    if len(header_cells) != 5:
        errors.append(f"Expected 5 columns, found {len(header_cells)}")
        return False, errors, []

    # Check column names (case-insensitive)
    header_lower = [h.strip().lower() for h in header_cells]
    if header_lower != EXPECTED_COLUMNS_LOWER:
        errors.append(f"Column mismatch. Expected: {', '.join(EXPECTED_COLUMNS)}")
        errors.append(f"Got: {', '.join([h.strip() for h in header_cells])}")
        return False, errors, []

    # Parse data rows
    if len(lines) < 2:
        errors.append("No data rows (only header)")
        return False, errors, []

    preview_rows = []
    for i, line in enumerate(lines[1:], start=2):
        cells = line.split('\t')
        if len(cells) != 5:
            errors.append(f"Row {i}: Expected 5 columns, found {len(cells)}")
            continue

        term_en = cells[0].strip()
        term_es = cells[1].strip()

        if not term_en:
            errors.append(f"Row {i}: English term is empty")
            continue
        if not term_es:
            errors.append(f"Row {i}: Spanish term is empty")
            continue

        row_dict = {
            "term_en": term_en,
            "term_es_recommended": term_es,
            "term_es_avoid": cells[2].strip() if cells[2].strip() != "-" else None,
            "notes": cells[3].strip() if cells[3].strip() else None,
            "category": cells[4].strip() if cells[4].strip() else None,
        }
        preview_rows.append(row_dict)

    if not preview_rows:
        errors.append("No valid data rows found")
        return False, errors, []

    # Return validation success with preview (limit to 5 rows)
    is_valid = len(errors) == 0
    return is_valid, errors, preview_rows[:5]


def parse_tsv_to_terms(tsv_content: str) -> list[dict]:
    """Parse TSV content to term dicts (assumes already validated)."""
    lines = tsv_content.strip().split('\n')
    terms = []

    for line in lines[1:]:  # Skip header
        if not line.strip():
            continue

        cells = line.split('\t')
        if len(cells) < 5:
            continue

        term_dict = {
            "term_en": cells[0].strip(),
            "term_es_recommended": cells[1].strip(),
            "term_es_avoid": cells[2].strip() if cells[2].strip() != "-" else None,
            "notes": cells[3].strip() if cells[3].strip() else None,
            "category": cells[4].strip() if cells[4].strip() else None,
        }
        terms.append(term_dict)

    return terms
