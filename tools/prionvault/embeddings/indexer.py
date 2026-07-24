"""Per-article indexing pipeline: text → chunks → vectors → DB rows.

The pipeline is idempotent: running it again on the same article replaces
the previous chunks for that source_field cleanly, so the embedding model
can be swapped or the chunking strategy tweaked without leaving stale rows.

Writes:
  - article_chunk rows (one per chunk) with embedding and source_field
  - articles.indexed_at = NOW()
  - articles.index_version = MODEL (e.g. "voyage-3-large")
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import List, Optional

from sqlalchemy import text as sql_text

from ..ingestion.queue import _get_engine
from .chunker import chunk_text, Chunk
from .embedder import embed_texts, MODEL, EMBEDDING_DIM, NotConfigured

logger = logging.getLogger(__name__)


@dataclass
class IndexResult:
    article_id:    str
    chunks_total:  int
    chunks_written:int
    tokens:        int
    cost_usd:      float
    elapsed_ms:    int
    used_source:   str   # "extracted_text" | "abstract" | "summary_ai"
    error:         Optional[str] = None


def _choose_sources(extracted_text, summary_ai, abstract) -> list[tuple[str, str]]:
    """Return every source we want to index for this article, in
    order of priority.

    Difference vs the previous single-source picker: when both the
    full PDF text AND an AI summary exist, we index BOTH as separate
    chunk sets (kept apart by `source_field`). The PDF chunks carry
    the author's exact vocabulary; the summary chunks carry a cleaner,
    higher-level rephrasing — together they raise recall for queries
    written in either style.

    When only one richer source is available, we keep the old
    "best-available" behaviour.
    """
    has_extracted = bool(extracted_text and extracted_text.strip()
                         and len(extracted_text.strip()) > 200)
    has_summary   = bool(summary_ai and summary_ai.strip()
                         and len(summary_ai.strip()) > 100)
    has_abstract  = bool(abstract and abstract.strip())

    sources: list[tuple[str, str]] = []
    if has_extracted:
        sources.append(("extracted_text", extracted_text))
        if has_summary:
            sources.append(("summary_ai", summary_ai))
    elif has_summary:
        sources.append(("summary_ai", summary_ai))

    # Always index the abstract as a complementary source when available.
    # The abstract is the author's authoritative short text in the original
    # language. PDF extraction can garble or miss it, and AI summaries
    # paraphrase/translate it — so exact author phrases like "procrustean
    # bed" may only survive in the abstract field. Skip only when the
    # abstract is already the sole source (to avoid double-indexing).
    if has_abstract and (has_extracted or has_summary):
        sources.append(("abstract", abstract))
    elif has_abstract:
        sources.append(("abstract", abstract))
    return sources


def _choose_source(extracted_text, summary_ai, abstract) -> tuple[str, str]:
    """Backward-compatible wrapper around _choose_sources for callers
    that still expect a single (source_field, text) tuple."""
    s = _choose_sources(extracted_text, summary_ai, abstract)
    return s[0] if s else ("", "")


def _embedding_to_pgvector_literal(vec: List[float]) -> str:
    """pgvector accepts strings like '[0.1,0.2,...]'. We pass it as a
    parameter and let the driver cast it via the column type.
    """
    return "[" + ",".join(f"{x:.7f}" for x in vec) + "]"


def _persist_one_source(article_id, source_field: str,
                        source_text: str) -> tuple[int, int, int, float, Optional[str]]:
    """Chunk → embed → DELETE+INSERT for a single (article, source).
    Returns (chunks_total, chunks_written, tokens, cost_usd, error)
    so the multi-source caller can aggregate stats. Errors are
    strings, not exceptions, so a half-failed multi-source run can
    still persist what worked."""
    chunks: List[Chunk] = chunk_text(source_text)
    if not chunks:
        return (0, 0, 0, 0.0, f"empty_after_chunking ({source_field})")

    texts = [c.text for c in chunks]
    try:
        embed_result = embed_texts(texts, input_type="document")
    except NotConfigured:
        return (len(chunks), 0, 0, 0.0, "VOYAGE_API_KEY not set")
    if len(embed_result.embeddings) != len(chunks):
        return (len(chunks), 0, embed_result.tokens,
                embed_result.cost_usd or 0.0,
                f"embedding count mismatch ({source_field}): got "
                f"{len(embed_result.embeddings)} for {len(chunks)} chunks")
    if embed_result.embeddings and len(embed_result.embeddings[0]) != EMBEDDING_DIM:
        return (len(chunks), 0, embed_result.tokens,
                embed_result.cost_usd or 0.0,
                f"embedding dim mismatch ({source_field}): model "
                f"returned {len(embed_result.embeddings[0])}-d, "
                f"DB column is vector({EMBEDDING_DIM})")

    eng = _get_engine()
    with eng.begin() as conn:
        conn.execute(sql_text(
            "DELETE FROM article_chunk "
            " WHERE article_id = :aid AND source_field = :src"
        ), {"aid": str(article_id), "src": source_field})

        rows = []
        for c, vec in zip(chunks, embed_result.embeddings):
            rows.append({
                "aid":   str(article_id),
                "idx":   c.index,
                "src":   source_field,
                "text":  c.text,
                "tok":   c.tokens,
                "vec":   _embedding_to_pgvector_literal(vec),
            })
        conn.execute(sql_text(
            """INSERT INTO article_chunk
                 (article_id, chunk_index, source_field, chunk_text, tokens,
                  embedding, created_at)
               VALUES (:aid, :idx, :src, :text, :tok, (:vec)::vector, NOW())
               ON CONFLICT (article_id, chunk_index, source_field)
               DO UPDATE SET
                   chunk_text = EXCLUDED.chunk_text,
                   tokens     = EXCLUDED.tokens,
                   embedding  = EXCLUDED.embedding,
                   created_at = NOW()"""
        ), rows)
    return (len(chunks), len(chunks), embed_result.tokens,
            embed_result.cost_usd or 0.0, None)


def index_article(*, article_id, title, extracted_text=None,
                  summary_ai=None, abstract=None) -> IndexResult:
    """Chunk + embed + persist for a single article.

    When the article has both an extracted PDF text AND an AI
    summary, BOTH are indexed (kept apart by source_field). The PDF
    chunks carry the author's vocabulary; the summary chunks carry a
    cleaner rephrasing. Querying ranks against the union of the two,
    raising recall for terminology-mismatched queries.

    Per-source chunks are replaced (DELETE + INSERT under the same
    article_id + source_field). Returns one IndexResult with
    aggregated stats. `used_source` is a comma-joined string when
    more than one source was processed.
    """
    start = time.monotonic()
    sources = _choose_sources(extracted_text, summary_ai, abstract)
    if not sources:
        return IndexResult(
            article_id=str(article_id), chunks_total=0, chunks_written=0,
            tokens=0, cost_usd=0.0,
            elapsed_ms=int((time.monotonic() - start) * 1000),
            used_source="", error="no_text_available",
        )

    total_chunks = total_written = 0
    total_tokens = 0
    total_cost   = 0.0
    sources_used: list[str] = []
    last_error: Optional[str] = None

    for source_field, source_text in sources:
        ct, cw, tk, cu, err = _persist_one_source(
            article_id, source_field, source_text)
        if err and cw == 0 and not sources_used:
            # First source failed outright and nothing was written —
            # bubble up the error so the worker can mark the job.
            return IndexResult(
                article_id=str(article_id), chunks_total=ct,
                chunks_written=0, tokens=tk, cost_usd=cu,
                elapsed_ms=int((time.monotonic() - start) * 1000),
                used_source=source_field, error=err,
            )
        total_chunks  += ct
        total_written += cw
        total_tokens  += tk
        total_cost    += cu
        if cw > 0:
            sources_used.append(source_field)
        if err:
            last_error = err   # remembered but not fatal

    if not sources_used:
        # All sources failed (e.g. embedder down).
        return IndexResult(
            article_id=str(article_id), chunks_total=total_chunks,
            chunks_written=0, tokens=total_tokens, cost_usd=total_cost,
            elapsed_ms=int((time.monotonic() - start) * 1000),
            used_source=",".join(s[0] for s in sources),
            error=last_error or "all_sources_failed",
        )

    # Stamp the article row exactly once, after every successful
    # source has been persisted.
    eng = _get_engine()
    with eng.begin() as conn:
        conn.execute(sql_text(
            """UPDATE articles
               SET indexed_at    = NOW(),
                   index_version = :model,
                   updated_at    = NOW()
               WHERE id = :aid"""
        ), {"aid": str(article_id), "model": MODEL})

    return IndexResult(
        article_id=str(article_id),
        chunks_total=total_chunks,
        chunks_written=total_written,
        tokens=total_tokens,
        cost_usd=total_cost,
        elapsed_ms=int((time.monotonic() - start) * 1000),
        used_source=",".join(sources_used),
        error=last_error,   # non-fatal partial-failure note, if any
    )


def index_article_source(*, article_id, source_field: str,
                         source_text: str, title: str = "") -> IndexResult:
    """Chunk + embed + persist a single source for an article without
    touching any other source_field chunks. Used by the 'add abstracts'
    batch to backfill abstract chunks alongside existing PDF chunks."""
    start = time.monotonic()
    if not source_text or not source_text.strip():
        return IndexResult(
            article_id=str(article_id), chunks_total=0, chunks_written=0,
            tokens=0, cost_usd=0.0,
            elapsed_ms=0, used_source=source_field, error="no_text_available",
        )
    ct, cw, tk, cu, err = _persist_one_source(article_id, source_field, source_text)
    return IndexResult(
        article_id=str(article_id),
        chunks_total=ct, chunks_written=cw,
        tokens=tk, cost_usd=cu,
        elapsed_ms=int((time.monotonic() - start) * 1000),
        used_source=source_field, error=err,
    )
