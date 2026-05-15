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


def _choose_source(extracted_text, summary_ai, abstract) -> tuple[str, str]:
    """Pick the richest text available for this article."""
    if extracted_text and extracted_text.strip() and len(extracted_text.strip()) > 200:
        return ("extracted_text", extracted_text)
    if summary_ai and summary_ai.strip() and len(summary_ai.strip()) > 100:
        return ("summary_ai", summary_ai)
    if abstract and abstract.strip():
        return ("abstract", abstract)
    return ("", "")


def _embedding_to_pgvector_literal(vec: List[float]) -> str:
    """pgvector accepts strings like '[0.1,0.2,...]'. We pass it as a
    parameter and let the driver cast it via the column type.
    """
    return "[" + ",".join(f"{x:.7f}" for x in vec) + "]"


def index_article(*, article_id, title, extracted_text=None,
                  summary_ai=None, abstract=None) -> IndexResult:
    """Chunk + embed + persist for a single article.

    Replaces any previous chunks for the same article+source_field.
    Returns an IndexResult with cost/tokens info for the caller to record.
    """
    start = time.monotonic()
    source_field, source_text = _choose_source(extracted_text, summary_ai, abstract)
    if not source_field:
        return IndexResult(
            article_id=str(article_id), chunks_total=0, chunks_written=0,
            tokens=0, cost_usd=0.0,
            elapsed_ms=int((time.monotonic() - start) * 1000),
            used_source="", error="no_text_available",
        )

    chunks: List[Chunk] = chunk_text(source_text)
    if not chunks:
        return IndexResult(
            article_id=str(article_id), chunks_total=0, chunks_written=0,
            tokens=0, cost_usd=0.0,
            elapsed_ms=int((time.monotonic() - start) * 1000),
            used_source=source_field, error="empty_after_chunking",
        )

    texts = [c.text for c in chunks]
    try:
        embed_result = embed_texts(texts, input_type="document")
    except NotConfigured:
        return IndexResult(
            article_id=str(article_id), chunks_total=len(chunks),
            chunks_written=0, tokens=0, cost_usd=0.0,
            elapsed_ms=int((time.monotonic() - start) * 1000),
            used_source=source_field, error="VOYAGE_API_KEY not set",
        )

    if len(embed_result.embeddings) != len(chunks):
        return IndexResult(
            article_id=str(article_id), chunks_total=len(chunks),
            chunks_written=0, tokens=embed_result.tokens,
            cost_usd=embed_result.cost_usd or 0.0,
            elapsed_ms=int((time.monotonic() - start) * 1000),
            used_source=source_field,
            error=f"embedding count mismatch: got {len(embed_result.embeddings)} for {len(chunks)} chunks",
        )

    # Dimension guard: the article_chunk.embedding column is declared as
    # vector(EMBEDDING_DIM). If MODEL is ever swapped for one with a
    # different dimensionality the INSERT below would fail late with a
    # cryptic Postgres error. Fail loud at this layer instead.
    if embed_result.embeddings and len(embed_result.embeddings[0]) != EMBEDDING_DIM:
        return IndexResult(
            article_id=str(article_id), chunks_total=len(chunks),
            chunks_written=0, tokens=embed_result.tokens,
            cost_usd=embed_result.cost_usd or 0.0,
            elapsed_ms=int((time.monotonic() - start) * 1000),
            used_source=source_field,
            error=(f"embedding dim mismatch: model returned "
                   f"{len(embed_result.embeddings[0])}-d vectors, "
                   f"DB column is vector({EMBEDDING_DIM}). "
                   f"Reset MODEL or migrate the column."),
        )

    eng = _get_engine()
    with eng.begin() as conn:
        # Replace existing chunks for this article+source_field.
        conn.execute(sql_text(
            """DELETE FROM article_chunk
               WHERE article_id = :aid AND source_field = :src"""
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
               VALUES (:aid, :idx, :src, :text, :tok, (:vec)::vector, NOW())"""
        ), rows)

        conn.execute(sql_text(
            """UPDATE articles
               SET indexed_at    = NOW(),
                   index_version = :model,
                   updated_at    = NOW()
               WHERE id = :aid"""
        ), {"aid": str(article_id), "model": MODEL})

    return IndexResult(
        article_id=str(article_id),
        chunks_total=len(chunks),
        chunks_written=len(chunks),
        tokens=embed_result.tokens,
        cost_usd=embed_result.cost_usd or 0.0,
        elapsed_ms=int((time.monotonic() - start) * 1000),
        used_source=source_field,
    )
