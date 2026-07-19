"""Summary improvement using glossary-based terminology normalization.

Improves existing AI summaries by:
  1. Normalizing terminology using fuzzy matching
  2. Taking summary + glossary
  3. Asking Claude to enhance terminology without changing meaning
  4. Storing improved version (non-destructive; keeps original)
  5. Tracking all changes with glossary version for audit & re-processing
  6. Batch process for bulk improvement
"""
from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Optional
from datetime import datetime

from sqlalchemy import text as sql_text
from difflib import get_close_matches

logger = logging.getLogger(__name__)

_FUZZY_MATCH_THRESHOLD = 0.80  # 80% similarity required


def _build_glossary_lookup():
    """Build a dict of Spanish recommended → English terms for fuzzy matching.

    Returns: {spanish_recommended: english_term}
    """
    from . import glossary_manager
    try:
        terms = glossary_manager.get_all_terms()
        return {term['term_es_recommended']: term['term_en'] for term in terms}
    except Exception as e:
        logger.warning(f"Failed to build glossary lookup for fuzzy matching: {e}")
        return {}


def _apply_fuzzy_normalization(text: str, glossary: dict) -> tuple[str, list[dict]]:
    """Apply fuzzy matching to detect and normalize terminology variations.

    Finds Spanish terms that closely match "avoid" variants and replaces with
    recommended terminology. Returns: (normalized_text, changes_list)

    Args:
        text: Text to normalize
        glossary: {spanish_recommended: english_term} dict

    Returns:
        (normalized_text, changes) where changes is list of dicts with:
        {original, corrected, similarity}
    """
    if not glossary:
        return text, []

    # Build reverse lookup of avoided terms for fuzzy matching
    avoided_to_recommended = {}
    for es_rec, en_term in glossary.items():
        try:
            # Fetch the full term record to get avoided terms
            from . import glossary_manager
            terms = glossary_manager.get_all_terms()
            for t in terms:
                if t['term_es_recommended'] == es_rec and t.get('term_es_avoid'):
                    for avoided in t['term_es_avoid'].split('|'):
                        avoided = avoided.strip()
                        if avoided:
                            avoided_to_recommended[avoided] = es_rec
        except Exception:
            pass

    if not avoided_to_recommended:
        return text, []

    changes = []
    normalized = text

    # For each word in text, check if it matches any avoided term via fuzzy matching
    words = normalized.split()
    for i, word in enumerate(words):
        # Try fuzzy match against all avoided terms
        for avoided_term, recommended_term in avoided_to_recommended.items():
            if len(avoided_term) < 3:  # Skip very short terms
                continue

            # Use difflib for similarity matching
            ratio = SequenceMatcher(None, word.lower(), avoided_term.lower()).ratio()

            if ratio >= _FUZZY_MATCH_THRESHOLD:
                # Found a match - replace it
                old_word = word
                words[i] = word.replace(avoided_term, recommended_term, 1)
                changes.append({
                    'original': old_word,
                    'corrected': words[i],
                    'avoided_term': avoided_term,
                    'recommended_term': recommended_term,
                    'similarity': ratio,
                })
                break

    if changes:
        normalized = ' '.join(words)

    return normalized, changes


def _get_engine():
    """Get database engine."""
    from ..ingestion.queue import _get_engine as _e
    return _e()


@dataclass
class ImprovementResult:
    """Result of improving a single summary."""
    article_id: str
    success: bool
    original_length: int
    improved_length: int
    improved_summary: Optional[str] = None
    error: Optional[str] = None
    tokens_used: Optional[int] = None
    changes_detected: int = 0


def improve_summary(
    article_id: str,
    original_summary: str,
    glossary_context: str,
    use_fuzzy_matching: bool = True,
) -> ImprovementResult:
    """Improve a single summary using glossary.

    Uses Claude Haiku (3.5) for cost efficiency. Optionally applies fuzzy
    matching to detect and normalize terminology variations before Claude processes.

    Args:
        article_id: Article UUID
        original_summary: Summary text to improve
        glossary_context: Formatted glossary for prompt injection
        use_fuzzy_matching: If True, apply fuzzy matching as preprocessing step

    Returns:
        ImprovementResult with improvement details
    """
    if not original_summary or not glossary_context:
        return ImprovementResult(
            article_id=article_id,
            success=False,
            original_length=len(original_summary or ""),
            improved_length=0,
            error="Empty summary or glossary",
        )

    # Apply fuzzy normalization as preprocessing
    summary_to_improve = original_summary
    if use_fuzzy_matching:
        glossary_lookup = _build_glossary_lookup()
        summary_to_improve, _fuzzy_changes = _apply_fuzzy_normalization(
            original_summary, glossary_lookup
        )

    try:
        from anthropic import Anthropic
        client = Anthropic()

        system_prompt = (
            "You are a scientific terminology expert. Your task is to improve Spanish-language "
            "biomedical summaries by applying standardized terminology from a glossary.\n\n"
            "CRITICAL RULES:\n"
            "1. Keep the exact same meaning and length (±10%)\n"
            "2. Only change terminology to match the glossary when appropriate\n"
            "3. Do NOT add new information or change the structure\n"
            "4. Do NOT translate anything — the summary is already in Spanish\n"
            "5. Return ONLY the improved summary, nothing else\n"
            f"\nGLOSSARY:\n{glossary_context}"
        )

        user_prompt = (
            f"Original summary:\n\n{summary_to_improve}\n\n"
            "Please improve this summary by applying the glossary terminology. "
            "Remember: ONLY terminology improvements, same meaning, same length."
        )

        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=2000,
            system=system_prompt,
            messages=[{"role": "user", "content": user_prompt}],
        )

        improved = response.content[0].text.strip() if response.content else ""
        if not improved:
            return ImprovementResult(
                article_id=article_id,
                success=False,
                original_length=len(original_summary),
                improved_length=0,
                error="Empty response from Claude",
            )

        tokens_used = (response.usage.input_tokens + response.usage.output_tokens
                      if hasattr(response, "usage") else None)

        return ImprovementResult(
            article_id=article_id,
            success=True,
            original_length=len(original_summary),
            improved_length=len(improved),
            improved_summary=improved,
            tokens_used=tokens_used,
        )

    except Exception as e:
        logger.exception(f"Summary improvement failed for {article_id}")
        return ImprovementResult(
            article_id=article_id,
            success=False,
            original_length=len(original_summary),
            improved_length=0,
            error=str(e)[:200],
        )


def _extract_changes(original: str, improved: str, article_id: str) -> tuple[int, list[dict]]:
    """Extract individual changes from original → improved text using diff.

    Returns: (change_count, changes_list)
    """
    changes = []
    change_count = 0

    # Use SequenceMatcher to find changed blocks
    for tag, i1, i2, j1, j2 in SequenceMatcher(None, original, improved).get_opcodes():
        if tag == 'replace':
            original_chunk = original[i1:i2]
            improved_chunk = improved[j1:j2]
            change_count += 1

            # Get context (50 chars before/after)
            context_before = original[max(0, i1-50):i1]
            context_after = improved[j2:min(len(improved), j2+50)]

            changes.append({
                'original_text': original_chunk,
                'corrected_text': improved_chunk,
                'correction_type': 'claude_suggestion',
                'confidence_score': 0.8,
                'context_before': context_before,
                'context_after': context_after,
            })

    return change_count, changes


def _save_improvement_log(
    eng,
    article_id: str,
    glossary_version: int,
    original_summary: str,
    improved_summary: str,
    changes: list[dict],
    batch_id: str,
    dry_run: bool = False,
) -> bool:
    """Save improvement to log tables. Returns True if successful."""
    try:
        with eng.begin() as conn:
            # Insert into summary_improvement_log
            result = conn.execute(sql_text("""
                INSERT INTO summary_improvement_log
                (article_id, glossary_version_used, original_summary, improved_summary,
                 changes_count, batch_id, dry_run)
                VALUES (:aid, :ver, :orig, :improved, :changes, :batch, :dry)
                RETURNING id
            """), {
                "aid": article_id,
                "ver": glossary_version,
                "orig": original_summary,
                "improved": improved_summary,
                "changes": len(changes),
                "batch": batch_id,
                "dry": dry_run,
            })

            log_id = result.scalar()

            # Insert individual changes
            for change in changes:
                conn.execute(sql_text("""
                    INSERT INTO summary_correction_detail
                    (improvement_log_id, original_text, corrected_text,
                     correction_type, confidence_score, context_before, context_after)
                    VALUES (:log_id, :orig, :corr, :type, :conf, :before, :after)
                """), {
                    "log_id": log_id,
                    "orig": change['original_text'],
                    "corr": change['corrected_text'],
                    "type": change['correction_type'],
                    "conf": change['confidence_score'],
                    "before": change['context_before'],
                    "after": change['context_after'],
                })

        return True
    except Exception as e:
        logger.warning(f"Failed to save improvement log for {article_id}: {e}")
        return False


def batch_improve_summaries(
    article_ids: list[str],
    glossary_context: str,
    glossary_version: int,
    dry_run: bool = False,
) -> dict:
    """Improve multiple summaries in sequence with full tracking.

    Args:
        article_ids: UUIDs to improve
        glossary_context: Formatted glossary for injection
        glossary_version: Current glossary version (for audit trail)
        dry_run: If True, simulate but don't save

    Returns dict with counts, details, and batch tracking.
    """
    logger.info(f"🚀 BATCH IMPROVEMENT STARTED: {len(article_ids)} articles, dry_run={dry_run}")

    eng = _get_engine()
    batch_id = str(uuid.uuid4())

    results = {
        "processed": 0,
        "successful": 0,
        "failed": 0,
        "dry_run": dry_run,
        "batch_id": batch_id,
        "glossary_version": glossary_version,
        "errors": [],
        "summary_lengths_before": [],
        "summary_lengths_after": [],
        "total_changes": 0,
    }

    for idx, aid in enumerate(article_ids):
        try:
            # Fetch article + summary
            with eng.connect() as conn:
                row = conn.execute(sql_text(
                    "SELECT summary_ai FROM articles WHERE id = :aid"
                ), {"aid": aid}).first()

            if not row or not row[0]:
                results["errors"].append(f"{aid}: No summary found")
                results["failed"] += 1
                continue

            original_summary = row[0]
            results["summary_lengths_before"].append(len(original_summary))

            # Improve
            improvement = improve_summary(aid, original_summary, glossary_context)

            if improvement.success:
                improved_summary = improvement.improved_summary

                # Extract changes using diff
                change_count, changes = _extract_changes(original_summary, improved_summary, aid)
                improvement.changes_detected = change_count
                results["total_changes"] += change_count

                results["successful"] += 1
                results["summary_lengths_after"].append(improvement.improved_length)

                # Save improved version (if not dry_run)
                if not dry_run:
                    try:
                        logger.info(f"💾 Saving improvement for {aid}...")
                        with eng.begin() as conn:
                            conn.execute(sql_text(
                                """UPDATE articles
                                   SET summary_ai = :improved,
                                       updated_at = NOW()
                                   WHERE id = :aid"""
                            ), {"improved": improvement.improved_summary, "aid": aid})

                        # Save to improvement log
                        _save_improvement_log(
                            eng, aid, glossary_version, original_summary,
                            improved_summary, changes, batch_id, dry_run=False
                        )
                        logger.info(f"✅ Successfully saved improvement for {aid}")
                    except Exception as save_err:
                        logger.error(f"❌ Failed to save improvement for {aid}: {save_err}")
                        raise

                logger.info(
                    f"✨ Improved {aid}: {improvement.original_length} → "
                    f"{improvement.improved_length} chars, {change_count} changes "
                    f"({improvement.tokens_used} tokens)"
                )
            else:
                results["failed"] += 1
                results["errors"].append(f"{aid}: {improvement.error}")
                logger.warning(f"Failed to improve {aid}: {improvement.error}")

            results["processed"] += 1

            # Polite rate limiting
            time.sleep(0.5)

        except Exception as e:
            logger.exception(f"batch_improve_summaries: error for {aid}")
            results["failed"] += 1
            results["errors"].append(f"{aid}: {str(e)[:200]}")

    logger.info(
        f"🏁 BATCH COMPLETED: {results['successful']} successful, "
        f"{results['failed']} failed, {results['total_changes']} total changes. "
        f"Batch ID: {batch_id}"
    )
    return results


def get_articles_needing_improvement(
    limit: int = 50,
    offset: int = 0,
) -> dict:
    """Find articles with summaries that might benefit from glossary improvement.

    Returns list of articles with their summaries and metadata.
    """
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text(
            """SELECT id::text, title, authors, year, summary_ai,
                      char_length(summary_ai) as summary_length
               FROM articles
               WHERE summary_ai IS NOT NULL
                 AND char_length(summary_ai) > 50
               ORDER BY updated_at DESC
               LIMIT :lim OFFSET :off"""
        ), {"lim": limit, "off": offset}).mappings().all()

        total = conn.execute(sql_text(
            "SELECT COUNT(*) FROM articles WHERE summary_ai IS NOT NULL"
        )).scalar() or 0

    return {
        "articles": [dict(r) for r in rows],
        "total": int(total),
        "limit": limit,
        "offset": offset,
        "has_more": (offset + limit) < total,
    }


def get_outdated_articles(
    limit: int = 50,
    offset: int = 0,
) -> dict:
    """Find articles improved with older glossary versions.

    Returns articles that need re-improvement with current glossary version.
    """
    from . import glossary_manager

    eng = _get_engine()
    current_version = glossary_manager.get_current_glossary_version()

    with eng.connect() as conn:
        rows = conn.execute(sql_text("""
            SELECT
              a.id::text,
              a.title,
              a.authors,
              a.year,
              sil.glossary_version_used,
              sil.improved_at,
              sil.changes_count,
              char_length(a.summary_ai) as summary_length
            FROM summary_improvement_log sil
            JOIN articles a ON a.id = sil.article_id
            WHERE sil.glossary_version_used < :current
              AND sil.dry_run = FALSE
            ORDER BY sil.glossary_version_used ASC, sil.improved_at DESC
            LIMIT :lim OFFSET :off
        """), {
            "current": current_version,
            "lim": limit,
            "off": offset,
        }).mappings().all()

        total = conn.execute(sql_text("""
            SELECT COUNT(*) FROM summary_improvement_log
            WHERE glossary_version_used < :current
              AND dry_run = FALSE
        """), {"current": current_version}).scalar() or 0

    return {
        "articles": [dict(r) for r in rows],
        "current_glossary_version": current_version,
        "total_outdated": int(total),
        "limit": limit,
        "offset": offset,
        "has_more": (offset + limit) < total,
    }


def get_improvement_stats() -> dict:
    """Get comprehensive improvement statistics and dashboard metrics."""
    from . import glossary_manager

    eng = _get_engine()
    current_version = glossary_manager.get_current_glossary_version()

    try:
        # Check if table exists using information_schema
        table_exists = False
        try:
            with eng.connect() as check_conn:
                result = check_conn.execute(sql_text("""
                    SELECT EXISTS (
                        SELECT 1 FROM information_schema.tables
                        WHERE table_name = 'summary_improvement_log'
                    )
                """)).scalar()
                table_exists = bool(result)
        except Exception as e:
            logger.warning(f"Failed to check table existence: {e}")
            table_exists = False

        # If table doesn't exist, return empty stats
        if not table_exists:
            logger.warning("summary_improvement_log table not found, returning empty stats")
            return {
                "total_articles_improved": 0,
                "total_changes": 0,
                "avg_changes_per_article": 0.0,
                "last_improvement_at": None,
                "total_batches": 0,
                "current_glossary_version": current_version,
                "by_version": [],
                "most_common_corrections": [],
            }

        with eng.connect() as conn:
            # Total stats
            stats = conn.execute(sql_text("""
                SELECT
                  COUNT(DISTINCT article_id) as total_articles_improved,
                  COALESCE(SUM(changes_count), 0) as total_changes,
                  COALESCE(AVG(changes_count), 0) as avg_changes,
                  MAX(improved_at) as last_improvement_at,
                  COUNT(DISTINCT batch_id) as total_batches
                FROM summary_improvement_log
                WHERE dry_run = FALSE
            """)).first()

            # By version
            by_version = conn.execute(sql_text("""
                SELECT
                  glossary_version_used,
                  COUNT(DISTINCT article_id) as count,
                  COALESCE(SUM(changes_count), 0) as total_changes
                FROM summary_improvement_log
                WHERE dry_run = FALSE
                GROUP BY glossary_version_used
                ORDER BY glossary_version_used DESC
            """)).fetchall()

            # Recent changes
            recent = conn.execute(sql_text("""
                SELECT
                  scd.original_text,
                  scd.corrected_text,
                  COUNT(*) as frequency
                FROM summary_correction_detail scd
                JOIN summary_improvement_log sil ON sil.id = scd.improvement_log_id
                WHERE sil.dry_run = FALSE
                GROUP BY scd.original_text, scd.corrected_text
                ORDER BY frequency DESC
                LIMIT 10
            """)).fetchall()

        return {
            "total_articles_improved": int(stats[0]) if stats else 0,
            "total_changes": int(stats[1]) if stats else 0,
            "avg_changes_per_article": float(stats[2]) if stats else 0.0,
            "last_improvement_at": stats[3].isoformat() if stats and stats[3] else None,
            "total_batches": int(stats[4]) if stats else 0,
            "current_glossary_version": current_version,
            "by_version": [
                {
                    "glossary_version": int(v[0]),
                    "articles_improved": int(v[1]),
                    "total_changes": int(v[2]),
                }
                for v in by_version
            ],
            "most_common_corrections": [
                {
                    "original": r[0],
                    "corrected": r[1],
                    "frequency": int(r[2]),
                }
                for r in recent
            ],
        }
    except Exception as e:
        logger.exception("Failed to get improvement stats")
        return {
            "total_articles_improved": 0,
            "total_changes": 0,
            "avg_changes_per_article": 0.0,
            "last_improvement_at": None,
            "total_batches": 0,
            "current_glossary_version": current_version,
            "by_version": [],
            "most_common_corrections": [],
            "error": str(e)[:200],
        }


def get_improvement_log(
    batch_id: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> dict:
    """Get detailed improvement history, optionally filtered by batch."""
    eng = _get_engine()

    # Check if table exists using information_schema
    table_exists = False
    try:
        with eng.connect() as check_conn:
            result = check_conn.execute(sql_text("""
                SELECT EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_name = 'summary_improvement_log'
                )
            """)).scalar()
            table_exists = bool(result)
    except Exception as e:
        logger.warning(f"Failed to check table existence: {e}")
        table_exists = False

    # If table doesn't exist, return empty log
    if not table_exists:
        return {
            "improvements": [],
            "total": 0,
            "limit": limit,
            "offset": offset,
            "has_more": False,
        }

    with eng.connect() as conn:
        where = ""
        params = {"lim": limit, "off": offset}

        if batch_id:
            where = "WHERE sil.batch_id = :batch"
            params["batch"] = batch_id

        rows = conn.execute(sql_text(f"""
            SELECT
              sil.id,
              sil.article_id::text,
              a.title,
              sil.glossary_version_used,
              sil.improved_at,
              sil.changes_count,
              sil.batch_id::text,
              COUNT(scd.id) as detail_count
            FROM summary_improvement_log sil
            JOIN articles a ON a.id = sil.article_id
            LEFT JOIN summary_correction_detail scd ON scd.improvement_log_id = sil.id
            {where}
            GROUP BY sil.id, sil.article_id, a.title, sil.glossary_version_used,
                     sil.improved_at, sil.changes_count, sil.batch_id
            ORDER BY sil.improved_at DESC
            LIMIT :lim OFFSET :off
        """), params).fetchall()

        total = conn.execute(sql_text(
            f"SELECT COUNT(*) FROM summary_improvement_log {where}"
        ), params).scalar() or 0

    return {
        "improvements": [
            {
                "id": int(r[0]),
                "article_id": r[1],
                "title": r[2],
                "glossary_version": int(r[3]),
                "improved_at": r[4].isoformat() if r[4] else None,
                "changes_count": int(r[5]),
                "batch_id": r[6],
                "detail_count": int(r[7]),
            }
            for r in rows
        ],
        "total": int(total),
        "limit": limit,
        "offset": offset,
        "has_more": (offset + limit) < total,
    }
