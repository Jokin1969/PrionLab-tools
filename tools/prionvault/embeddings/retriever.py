"""Top-K retrieval over the vector index.

Embeds the user query with Voyage (`input_type="query"`) and ranks the
`article_chunk` rows by cosine distance using pgvector's `<=>` operator.
Results are grouped by article so the caller can show one card per paper
even if multiple chunks of the same paper matched.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import List, Optional

from sqlalchemy import text as sql_text

from ..ingestion.queue import _get_engine
from .embedder import embed_query, NotConfigured

logger = logging.getLogger(__name__)


@dataclass
class RetrievedChunk:
    article_id:   str
    chunk_index:  int
    source_field: str
    chunk_text:   str
    tokens:       Optional[int]
    distance:     float                 # smaller = closer (pgvector cosine)
    similarity:   float                 # 1 - distance, 0..1
    rerank_score: Optional[float] = None  # filled in when rerank is applied


@dataclass
class RetrievedArticle:
    id:        str
    title:     str
    authors:   Optional[str]
    year:      Optional[int]
    journal:   Optional[str]
    doi:       Optional[str]
    pubmed_id: Optional[str]
    best_distance:   float
    best_similarity: float
    chunks:    List[RetrievedChunk] = field(default_factory=list)


@dataclass
class RerankInfo:
    used:            bool
    model:           Optional[str] = None
    candidates:      int = 0    # how many we considered before rerank
    tokens:          int = 0
    cost_usd:        Optional[float] = None
    elapsed_ms:      int = 0


@dataclass
class RetrievalResult:
    query:      str
    articles:   List[RetrievedArticle]   # de-duplicated, ranked by best chunk
    raw_chunks: List[RetrievedChunk]     # full top-K, useful for the RAG prompt
    fetched_at_distance: float            # worst (largest) distance returned
    rerank:     Optional[RerankInfo] = None


def search(query: str, *, top_k: int = 20,
           per_article_cap: int = 3,
           rerank: bool = True,
           candidate_k: Optional[int] = None) -> RetrievalResult:
    """Run a semantic search. Returns chunks + grouped articles.

    `per_article_cap` limits how many chunks of the same article appear in
    raw_chunks, so the RAG prompt isn't dominated by a single paper.

    When `rerank` is True (default), pgvector over-fetches `candidate_k`
    chunks (default 5×top_k, capped at 100), then Voyage rerank-2
    re-scores them against the query and the final top_k is taken from
    the re-ranked order. If VOYAGE_API_KEY is not set the rerank step is
    skipped gracefully and the function falls back to pure vector
    similarity.
    """
    query = (query or "").strip()
    if not query:
        return RetrievalResult(query="", articles=[], raw_chunks=[],
                               fetched_at_distance=0.0)

    qvec = embed_query(query)
    if not qvec:
        raise RuntimeError("query embedding returned empty vector")
    vec_literal = "[" + ",".join(f"{x:.7f}" for x in qvec) + "]"

    # Over-fetch from pgvector: more candidates → better material for
    # the reranker (or for the per-article cap when rerank is off).
    if candidate_k is None:
        candidate_k = min(100, max(top_k * 5, 40)) if rerank else max(top_k * 3, 30)

    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text(
            """SELECT
                   c.article_id,
                   c.chunk_index,
                   c.source_field,
                   c.chunk_text,
                   c.tokens,
                   c.embedding <=> (:qvec)::vector AS distance,
                   a.title, a.authors, a.year, a.journal, a.doi, a.pubmed_id
               FROM article_chunk c
               JOIN articles a ON a.id = c.article_id
               ORDER BY c.embedding <=> (:qvec)::vector ASC
               LIMIT :k"""
        ), {"qvec": vec_literal, "k": candidate_k}).all()

    # Build the candidate pool first (no per-article cap yet — rerank
    # needs the full set so a strong second chunk of paper A can still
    # surface above a weak first chunk of paper B).
    candidate_chunks: List[RetrievedChunk] = []
    article_meta: dict = {}
    for r in rows:
        aid = str(r.article_id)
        if aid not in article_meta:
            article_meta[aid] = {
                "title": r.title or "",
                "authors": r.authors,
                "year": r.year,
                "journal": r.journal,
                "doi": r.doi,
                "pubmed_id": r.pubmed_id,
            }
        dist = float(r.distance) if r.distance is not None else 1.0
        candidate_chunks.append(RetrievedChunk(
            article_id=aid,
            chunk_index=int(r.chunk_index),
            source_field=r.source_field,
            chunk_text=r.chunk_text,
            tokens=int(r.tokens) if r.tokens is not None else None,
            distance=dist,
            similarity=max(0.0, 1.0 - dist),
        ))

    rerank_info = RerankInfo(used=False, candidates=len(candidate_chunks))

    # ── Optional reranking step ─────────────────────────────────────────
    ordered = candidate_chunks
    if rerank and candidate_chunks:
        try:
            from .reranker import rerank as rerank_docs, NotConfigured as RerankNotConfigured
            try:
                docs = [c.chunk_text for c in candidate_chunks]
                rerank_result = rerank_docs(query, docs)
                # Voyage returns sorted-by-score by default. Map back to chunks.
                if rerank_result.scores:
                    score_by_idx = {s.index: s.relevance_score
                                    for s in rerank_result.scores}
                    for i, c in enumerate(candidate_chunks):
                        c.rerank_score = score_by_idx.get(i)
                    ordered = sorted(
                        candidate_chunks,
                        key=lambda c: (
                            -1 * (c.rerank_score if c.rerank_score is not None else -1),
                            c.distance,
                        ),
                    )
                    rerank_info = RerankInfo(
                        used=True,
                        model=rerank_result.model,
                        candidates=len(candidate_chunks),
                        tokens=rerank_result.tokens,
                        cost_usd=rerank_result.cost_usd,
                        elapsed_ms=rerank_result.elapsed_ms,
                    )
            except RerankNotConfigured:
                logger.info("Skipping rerank — VOYAGE_API_KEY not set")
            except Exception as exc:
                logger.warning("Rerank failed, falling back to vector order: %s", exc)
        except Exception as exc:
            # Rare: import error from reranker module itself.
            logger.warning("Rerank module unavailable: %s", exc)

    # Apply the per-article cap on the (possibly reranked) ordered list.
    seen_per_article: dict = {}
    chunks: List[RetrievedChunk] = []
    for c in ordered:
        n = seen_per_article.get(c.article_id, 0)
        if n >= per_article_cap:
            continue
        seen_per_article[c.article_id] = n + 1
        chunks.append(c)
        if len(chunks) >= top_k:
            break

    # Group by article using the order of `chunks`
    grouped: dict = {}
    for c in chunks:
        grouped.setdefault(c.article_id, []).append(c)

    articles: List[RetrievedArticle] = []
    for aid, cs in grouped.items():
        meta = article_meta.get(aid, {})
        # Sort chunks within the article by best score (rerank if present, else distance)
        cs.sort(key=lambda x: (
            -1 * (x.rerank_score if x.rerank_score is not None else -1),
            x.distance,
        ))
        articles.append(RetrievedArticle(
            id=aid,
            title=meta.get("title") or "",
            authors=meta.get("authors"),
            year=meta.get("year"),
            journal=meta.get("journal"),
            doi=meta.get("doi"),
            pubmed_id=meta.get("pubmed_id"),
            best_distance=cs[0].distance,
            best_similarity=cs[0].similarity,
            chunks=cs,
        ))
    # Sort articles to match the order they appear in `chunks`
    article_order = []
    seen_order: set = set()
    for c in chunks:
        if c.article_id not in seen_order:
            article_order.append(c.article_id)
            seen_order.add(c.article_id)
    articles.sort(key=lambda a: article_order.index(a.id)
                  if a.id in article_order else 9999)

    return RetrievalResult(
        query=query,
        articles=articles,
        raw_chunks=chunks,
        fetched_at_distance=chunks[-1].distance if chunks else 0.0,
        rerank=rerank_info,
    )
