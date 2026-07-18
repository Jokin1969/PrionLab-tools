"""Summary improvement using glossary-based terminology normalization.

Improves existing AI summaries by:
  1. Taking summary + glossary
  2. Asking Claude to enhance terminology without changing meaning
  3. Storing improved version (non-destructive; keeps original)
  4. Batch process for bulk improvement
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Optional

from sqlalchemy import text as sql_text

logger = logging.getLogger(__name__)


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


def improve_summary(
    article_id: str,
    original_summary: str,
    glossary_context: str,
) -> ImprovementResult:
    """Improve a single summary using glossary.

    Uses Claude Haiku (3.5) for cost efficiency.
    """
    if not original_summary or not glossary_context:
        return ImprovementResult(
            article_id=article_id,
            success=False,
            original_length=len(original_summary or ""),
            improved_length=0,
            error="Empty summary or glossary",
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
            f"Original summary:\n\n{original_summary}\n\n"
            "Please improve this summary by applying the glossary terminology. "
            "Remember: ONLY terminology improvements, same meaning, same length."
        )

        response = client.messages.create(
            model="claude-3-5-haiku-20241022",
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


def batch_improve_summaries(
    article_ids: list[str],
    glossary_context: str,
    dry_run: bool = False,
) -> dict:
    """Improve multiple summaries in sequence.

    Args:
        article_ids: UUIDs to improve
        glossary_context: Formatted glossary for injection
        dry_run: If True, simulate but don't save

    Returns dict with counts and details.
    """
    eng = _get_engine()
    results = {
        "processed": 0,
        "successful": 0,
        "failed": 0,
        "dry_run": dry_run,
        "errors": [],
        "summary_lengths_before": [],
        "summary_lengths_after": [],
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
                results["successful"] += 1
                results["summary_lengths_after"].append(improvement.improved_length)

                # Save improved version (if not dry_run)
                if not dry_run:
                    with eng.begin() as conn:
                        conn.execute(sql_text(
                            """UPDATE articles
                               SET summary_ai = :improved,
                                   updated_at = NOW()
                               WHERE id = :aid"""
                        ), {"improved": improvement.improved_summary, "aid": aid})

                logger.info(
                    f"Improved {aid}: {improvement.original_length} → "
                    f"{improvement.improved_length} chars "
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
