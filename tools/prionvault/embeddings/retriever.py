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
    distance:     float          # smaller = closer
    similarity:   float          # 1 - distance, 0..1


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
class RetrievalResult:
    query:      str
    articles:   List[RetrievedArticle]   # de-duplicated, ranked by best chunk
    raw_chunks: List[RetrievedChunk]     # full top-K, useful for the RAG prompt
    fetched_at_distance: float            # worst (largest) distance returned


def search(query: str, *, top_k: int = 20,
           per_article_cap: int = 3) -> RetrievalResult:
    """Run a semantic search. Returns chunks + grouped articles.

    `per_article_cap` limits how many chunks of the same article appear in
    raw_chunks, so the RAG prompt isn't dominated by a single paper.
    """
    query = (query or "").strip()
    if not query:
        return RetrievalResult(query="", articles=[], raw_chunks=[],
                               fetched_at_distance=0.0)

    qvec = embed_query(query)
    if not qvec:
        raise RuntimeError("query embedding returned empty vector")
    vec_literal = "[" + ",".join(f"{x:.7f}" for x in qvec) + "]"

    fetch_k = max(top_k * 3, 30)  # over-fetch so the per-article cap doesn't starve us

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
        ), {"qvec": vec_literal, "k": fetch_k}).all()

    seen_per_article: dict = {}
    chunks: List[RetrievedChunk] = []
    for r in rows:
        aid = str(r.article_id)
        n = seen_per_article.get(aid, 0)
        if n >= per_article_cap:
            continue
        seen_per_article[aid] = n + 1

        dist = float(r.distance) if r.distance is not None else 1.0
        chunks.append(RetrievedChunk(
            article_id=aid,
            chunk_index=int(r.chunk_index),
            source_field=r.source_field,
            chunk_text=r.chunk_text,
            tokens=int(r.tokens) if r.tokens is not None else None,
            distance=dist,
            similarity=max(0.0, 1.0 - dist),
        ))
        if len(chunks) >= top_k:
            break

    # Group by article, keep best chunk first
    grouped: dict = {}
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
    for c in chunks:
        grouped.setdefault(c.article_id, []).append(c)

    articles: List[RetrievedArticle] = []
    for aid, cs in grouped.items():
        cs.sort(key=lambda x: x.distance)
        meta = article_meta.get(aid, {})
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
    articles.sort(key=lambda a: a.best_distance)

    return RetrievalResult(
        query=query,
        articles=articles,
        raw_chunks=chunks,
        fetched_at_distance=chunks[-1].distance if chunks else 0.0,
    )
