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
    try:
        from . import glossary_manager
        terms = glossary_manager.get_all_terms()
        for t in terms:
            es_rec = t.get('term_es_recommended')
            if es_rec and t.get('term_es_avoid'):
                for avoided in t['term_es_avoid'].split('|'):
                    avoided = avoided.strip()
                    if avoided:
                        avoided_to_recommended[avoided] = es_rec
    except Exception as e:
        logger.warning(f"Failed to build avoided terms lookup for fuzzy matching: {e}")

    if not avoided_to_recommended:
        logger.debug(f"No avoided terms found in glossary for fuzzy normalization")
        return text, []

    changes = []
    normalized = text

    # Sort avoided terms by length (longest first) to match multi-word phrases first
    sorted_avoided = sorted(avoided_to_recommended.items(), key=lambda x: len(x[0]), reverse=True)

    # For each avoided term, try to find and replace it in the text
    for avoided_term, recommended_term in sorted_avoided:
        if len(avoided_term) < 3:  # Skip very short terms
            continue

        # Split text into words to find n-grams
        words = normalized.split()
        term_words = avoided_term.split()
        n = len(term_words)

        # Build list of all possible n-grams from text
        found_match = False
        for i in range(len(words) - n + 1):
            ngram = ' '.join(words[i:i+n])

            # Check fuzzy match similarity
            ratio = SequenceMatcher(None, ngram.lower(), avoided_term.lower()).ratio()

            if ratio >= _FUZZY_MATCH_THRESHOLD:
                # Found a match - replace it
                original_ngram = ngram
                words[i:i+n] = recommended_term.split()

                changes.append({
                    'original': original_ngram,
                    'corrected': recommended_term,
                    'avoided_term': avoided_term,
                    'recommended_term': recommended_term,
                    'similarity': ratio,
                })
                normalized = ' '.join(words)
                found_match = True
                break

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
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    model_used: str = "claude-haiku-4-5-20251001"
    changes_detected: int = 0


def improve_summary(
    article_id: str,
    original_summary: str,
    glossary_context: str,
    use_fuzzy_matching: bool = True,
) -> ImprovementResult:
    """Improve a single summary using glossary via direct terminology replacement.

    Applies fuzzy matching to detect and normalize terminology variations WITHOUT
    regenerating the summary. Preserves original structure, length, and meaning.

    Args:
        article_id: Article UUID
        original_summary: Summary text to improve
        glossary_context: Formatted glossary (not used, kept for compatibility)
        use_fuzzy_matching: If True, apply fuzzy matching for terminology replacement

    Returns:
        ImprovementResult with improvement details
    """
    if not original_summary:
        return ImprovementResult(
            article_id=article_id,
            success=False,
            original_length=len(original_summary or ""),
            improved_length=0,
            error="Empty summary",
        )

    try:
        # Apply fuzzy normalization to replace terminology only (no regeneration)
        glossary_lookup = _build_glossary_lookup()
        improved_summary, changes = _apply_fuzzy_normalization(
            original_summary, glossary_lookup
        )

        # If no changes, return original
        if not changes:
            improved_summary = original_summary

        return ImprovementResult(
            article_id=article_id,
            success=True,
            original_length=len(original_summary),
            improved_length=len(improved_summary),
            improved_summary=improved_summary,
            tokens_used=0,
            input_tokens=0,
            output_tokens=0,
            model_used="fuzzy-matching",
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
    input_tokens: int = 0,
    output_tokens: int = 0,
    model_used: str = "claude-haiku-4-5-20251001",
    dry_run: bool = False,
) -> bool:
    """Save improvement to log tables. Returns True if successful."""
    try:
        from . import claude_pricing

        # Calculate cost
        cost_info = claude_pricing.calculate_cost(input_tokens, output_tokens, model_used)
        cost_usd = cost_info["cost_usd"]

        with eng.begin() as conn:
            # Insert into summary_improvement_log
            # Note: input_tokens, output_tokens, total_tokens, model_used, cost_usd use DEFAULT values
            # when migration 067 hasn't been applied yet
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
    progress_callback=None,
) -> dict:
    """Improve multiple summaries in sequence with full tracking.

    Processes articles sequentially, calling Claude for terminology improvement,
    tracking progress via callback, and saving results to database.

    Args:
        article_ids: UUIDs to improve
        glossary_context: Formatted glossary for injection
        glossary_version: Current glossary version (for audit trail)
        dry_run: If True, simulate but don't save
        progress_callback: Optional callback(processed_count) called after each article

    Returns dict with counts, details, and batch tracking.
    """
    logger.info(f"🚀 BATCH IMPROVEMENT STARTED: {len(article_ids)} articles, dry_run={dry_run}")
    logger.info(f"📌 Getting engine...")
    try:
        eng = _get_engine()
        logger.info(f"✅ Engine obtained successfully: {eng}")
    except Exception as eng_err:
        logger.error(f"❌ Failed to get engine: {eng_err}")
        raise

    batch_id = str(uuid.uuid4())
    logger.info(f"📝 Batch ID: {batch_id}")

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

    logger.info(f"📦 Starting main processing loop for {len(article_ids)} articles")
    for idx, aid in enumerate(article_ids):
        try:
            # Fetch article + summary
            logger.info(f"[{idx+1}/{len(article_ids)}] 🔌 Attempting to get DB connection...")
            with eng.connect() as conn:
                logger.info(f"[{idx+1}/{len(article_ids)}] ✅ Connection obtained")
                row = conn.execute(sql_text(
                    "SELECT summary_ai FROM articles WHERE id = :aid"
                ), {"aid": aid}).first()
            logger.info(f"[{idx+1}/{len(article_ids)}] 🔓 Connection closed, row={row is not None}")

            if not row or not row[0]:
                logger.warning(f"[{idx+1}/{len(article_ids)}] No summary found for {aid}")
                results["errors"].append(f"{aid}: No summary found")
                results["failed"] += 1
                results["processed"] += 1
                if progress_callback:
                    progress_callback(results["processed"])
                continue

            original_summary = row[0]
            results["summary_lengths_before"].append(len(original_summary))
            logger.info(f"[{idx+1}/{len(article_ids)}] Summary length: {len(original_summary)} chars")

            # Improve
            logger.info(f"[{idx+1}/{len(article_ids)}] Calling improve_summary()...")
            improvement = improve_summary(aid, original_summary, glossary_context)
            logger.info(f"[{idx+1}/{len(article_ids)}] Result: success={improvement.success}, error={improvement.error}")

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
                        logger.info(f"[{idx+1}/{len(article_ids)}] 💾 Saving improvement for {aid}...")
                        with eng.begin() as conn:
                            conn.execute(sql_text(
                                """UPDATE articles
                                   SET summary_ai = :improved,
                                       ai_summary_glossary_version = :ver,
                                       updated_at = NOW()
                                   WHERE id = :aid"""
                            ), {"improved": improvement.improved_summary, "ver": glossary_version, "aid": aid})

                        # Save to improvement log (without token tracking)
                        _save_improvement_log(
                            eng, aid, glossary_version, original_summary,
                            improved_summary, changes, batch_id,
                            input_tokens=0,
                            output_tokens=0,
                            model_used=improvement.model_used,
                            dry_run=False
                        )
                        logger.info(f"[{idx+1}/{len(article_ids)}] ✅ Successfully saved improvement for {aid}")
                    except Exception as save_err:
                        logger.error(f"[{idx+1}/{len(article_ids)}] ❌ Failed to save improvement for {aid}: {save_err}")
                        raise

                logger.info(
                    f"[{idx+1}/{len(article_ids)}] ✨ Improved {aid}: {improvement.original_length} → "
                    f"{improvement.improved_length} chars, {change_count} changes "
                    f"({improvement.tokens_used} tokens)"
                )
            else:
                results["failed"] += 1
                results["errors"].append(f"{aid}: {improvement.error}")
                logger.warning(f"[{idx+1}/{len(article_ids)}] Failed to improve {aid}: {improvement.error}")

            results["processed"] += 1
            if progress_callback:
                progress_callback(results["processed"])

            # Polite rate limiting
            time.sleep(0.5)

        except Exception as e:
            logger.exception(f"[{idx+1}/{len(article_ids)}] batch_improve_summaries: error for {aid}")
            results["failed"] += 1
            results["errors"].append(f"{aid}: {str(e)[:200]}")
            results["processed"] += 1
            if progress_callback:
                progress_callback(results["processed"])

    # Estimate cost based on successful improvements
    # Average: ~€0.0005 per article (rough estimate)
    estimated_cost_eur = results['successful'] * 0.0005
    estimated_cost_usd = estimated_cost_eur * 1.10

    results["estimated_cost_eur"] = round(estimated_cost_eur, 4)
    results["estimated_cost_usd"] = round(estimated_cost_usd, 4)

    logger.info(
        f"🏁 BATCH COMPLETED: {results['successful']} successful, "
        f"{results['failed']} failed, {results['total_changes']} total changes. "
        f"Estimated cost: ~€{estimated_cost_eur:.4f} / ~${estimated_cost_usd:.4f}. "
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
