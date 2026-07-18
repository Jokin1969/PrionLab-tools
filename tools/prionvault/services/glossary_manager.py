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
    """Import/update glossary terms from a list of dicts.

    Each dict should have: term_en, term_es_recommended, term_es_avoid (optional),
    notes (optional), category (optional).

    Returns ImportResult with counts and any errors. Automatically increments
    version on changes.
    """
    if not terms:
        return ImportResult(imported=0, updated=0, skipped=0, errors=[], new_version=1)

    eng = _get_engine()
    imported = 0
    updated = 0
    skipped = 0
    errors: list[str] = []
    new_version = 1

    try:
        with eng.begin() as conn:
            # Get current version
            meta = conn.execute(sql_text(
                "SELECT current_version FROM prionvault_glossary_metadata "
                "ORDER BY id DESC LIMIT 1"
            )).first()
            new_version = (meta[0] if meta else 0) + 1

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

                    # Check if exists
                    existing = conn.execute(sql_text(
                        "SELECT id, term_es_recommended, version FROM prionvault_glossary_terms "
                        "WHERE term_en = :en"
                    ), {"en": term_en}).first()

                    if existing:
                        existing_id, existing_es, existing_version = existing
                        # Update if changed
                        if existing_es != term_es or existing.get(2) < new_version:
                            conn.execute(sql_text(
                                """UPDATE prionvault_glossary_terms
                                   SET term_es_recommended = :es,
                                       term_es_avoid = :avoid,
                                       notes = :notes,
                                       category = :cat,
                                       version = :v,
                                       updated_at = NOW()
                                   WHERE id = :id"""
                            ), {
                                "es": term_es,
                                "avoid": avoid,
                                "notes": notes,
                                "cat": category,
                                "v": new_version,
                                "id": existing_id,
                            })
                            updated += 1
                        else:
                            skipped += 1
                    else:
                        # Insert new
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
                "count": imported + updated + skipped,
                "notes": f"Imported {imported}, updated {updated}, skipped {skipped}",
            })

    except Exception as e:
        logger.exception("glossary import failed")
        errors.append(f"Database error: {str(e)[:300]}")

    return ImportResult(
        imported=imported,
        updated=updated,
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
