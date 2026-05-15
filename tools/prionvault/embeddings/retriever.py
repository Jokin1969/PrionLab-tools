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
class HybridInfo:
    used:        bool
    vector_hits: int = 0   # chunks returned by pgvector
    bm25_hits:   int = 0   # chunks returned by BM25 (chunk-level tsvector)
    fused:       int = 0   # unique chunks in the fused pool


@dataclass
class RetrievalResult:
    query:      str
    articles:   List[RetrievedArticle]   # de-duplicated, ranked by best chunk
    raw_chunks: List[RetrievedChunk]     # full top-K, useful for the RAG prompt
    fetched_at_distance: float            # worst (largest) distance returned
    rerank:     Optional[RerankInfo] = None
    hybrid:     Optional[HybridInfo] = None


def find_similar_articles(article_id, *, limit: int = 10) -> List[dict]:
    """Return up to `limit` articles whose chunks are closest to a
    representative chunk of `article_id`.

    Uses the article's first extracted_text chunk (richest source) as the
    query vector and runs a normal pgvector ORDER BY so the HNSW index
    does the heavy lifting. Excludes the source article and groups
    candidate chunks by article, keeping the min distance per paper.
    """
    eng = _get_engine()
    with eng.connect() as conn:
        row = conn.execute(sql_text(
            """SELECT embedding::text FROM article_chunk
               WHERE article_id = :aid
               ORDER BY (source_field = 'extracted_text') DESC,
                        chunk_index ASC
               LIMIT 1"""
        ), {"aid": str(article_id)}).first()
        if not row or not row[0]:
            return []
        vec_literal = row[0]

        # Over-fetch chunks so the per-article dedup leaves us with
        # enough distinct papers to return `limit` rows.
        candidate_k = max(limit * 8, 60)
        rows = conn.execute(sql_text(
            """SELECT c.article_id,
                      c.embedding <=> (:vec)::vector AS distance,
                      a.title, a.authors, a.year, a.journal, a.doi, a.pubmed_id,
                      (a.summary_ai IS NOT NULL) AS has_summary_ai,
                      (a.dropbox_path IS NOT NULL) AS has_pdf
               FROM article_chunk c
               JOIN articles a ON a.id = c.article_id
               WHERE c.article_id != :aid
               ORDER BY c.embedding <=> (:vec)::vector ASC
               LIMIT :k"""
        ), {"vec": vec_literal, "aid": str(article_id),
            "k": candidate_k}).all()

    best: dict = {}
    for r in rows:
        aid = str(r.article_id)
        d = float(r.distance) if r.distance is not None else 1.0
        if aid in best and best[aid]["distance"] <= d:
            continue
        best[aid] = {
            "id":             aid,
            "title":          r.title or "",
            "authors":        r.authors,
            "year":           r.year,
            "journal":        r.journal,
            "doi":            r.doi,
            "pubmed_id":      r.pubmed_id,
            "has_summary_ai": bool(r.has_summary_ai),
            "has_pdf":        bool(r.has_pdf),
            "distance":       d,
            "similarity":     max(0.0, 1.0 - d),
        }
    return sorted(best.values(), key=lambda x: x["distance"])[:limit]


# Reciprocal Rank Fusion constant. 60 is the canonical default from the
# Cormack et al. paper; behaviour is robust to small perturbations.
_RRF_K = 60


def search(query: str, *, top_k: int = 20,
           per_article_cap: int = 3,
           rerank: bool = True,
           hybrid: bool = True,
           candidate_k: Optional[int] = None) -> RetrievalResult:
    """Run a semantic search. Returns chunks + grouped articles.

    `per_article_cap` limits how many chunks of the same article appear in
    raw_chunks, so the RAG prompt isn't dominated by a single paper.

    When `hybrid` is True (default), the retriever runs both a pgvector
    cosine search and a chunk-level BM25 full-text search, then fuses
    the two rankings with Reciprocal Rank Fusion before the rerank step.
    This is the recommended setting because it preserves recall on exact
    technical tokens (PrPSc, GFAP, 14-3-3, …) that the dense embedder
    sometimes blurs together with semantically adjacent concepts.

    When `rerank` is True (default), Voyage rerank-2 re-scores the fused
    candidate pool against the query and the final top_k is taken from
    the re-ranked order. If VOYAGE_API_KEY is not set the rerank step is
    skipped gracefully and the function falls back to the fused order.
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
        vec_rows = conn.execute(sql_text(
            """SELECT
                   c.id AS chunk_pk,
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

        # ── Lexical (BM25-style) leg of the hybrid retrieval ────────────
        bm25_rows = []
        hybrid_active = False
        if hybrid:
            try:
                bm25_rows = conn.execute(sql_text(
                    """SELECT
                           c.id AS chunk_pk,
                           c.article_id,
                           c.chunk_index,
                           c.source_field,
                           c.chunk_text,
                           c.tokens,
                           ts_rank_cd(c.chunk_search_vector,
                                      plainto_tsquery('simple', :q)) AS rank,
                           a.title, a.authors, a.year, a.journal, a.doi, a.pubmed_id
                       FROM article_chunk c
                       JOIN articles a ON a.id = c.article_id
                       WHERE c.chunk_search_vector @@ plainto_tsquery('simple', :q)
                       ORDER BY rank DESC
                       LIMIT :k"""
                ), {"q": query, "k": candidate_k}).all()
                hybrid_active = True
            except Exception as exc:
                # Column or index missing (migration 006 not applied yet?).
                # Fall back to pure vector quietly.
                logger.warning("BM25 leg failed, hybrid disabled: %s", exc)
                bm25_rows = []
                hybrid_active = False

    # ── Build a chunk pool indexed by chunk_pk, collecting both legs ────
    chunk_by_pk: dict = {}
    article_meta: dict = {}

    def _ingest_row(r, is_vec: bool):
        pk = int(r.chunk_pk)
        aid = str(r.article_id)
        if aid not in article_meta:
            article_meta[aid] = {
                "title":     r.title or "",
                "authors":   r.authors,
                "year":      r.year,
                "journal":   r.journal,
                "doi":       r.doi,
                "pubmed_id": r.pubmed_id,
            }
        if pk in chunk_by_pk:
            return chunk_by_pk[pk]
        if is_vec:
            dist = float(r.distance) if r.distance is not None else 1.0
            similarity = max(0.0, 1.0 - dist)
        else:
            # No vector distance yet for this chunk — leave a conservative
            # default; reranking will rescue or demote it.
            dist = 1.0
            similarity = 0.0
        c = RetrievedChunk(
            article_id=aid,
            chunk_index=int(r.chunk_index),
            source_field=r.source_field,
            chunk_text=r.chunk_text,
            tokens=int(r.tokens) if r.tokens is not None else None,
            distance=dist,
            similarity=similarity,
        )
        chunk_by_pk[pk] = c
        return c

    # ── Reciprocal Rank Fusion ─────────────────────────────────────────
    rrf_scores: dict = {}
    for rank, r in enumerate(vec_rows):
        _ingest_row(r, is_vec=True)
        pk = int(r.chunk_pk)
        rrf_scores[pk] = rrf_scores.get(pk, 0.0) + 1.0 / (_RRF_K + rank + 1)
    for rank, r in enumerate(bm25_rows):
        _ingest_row(r, is_vec=False)
        pk = int(r.chunk_pk)
        rrf_scores[pk] = rrf_scores.get(pk, 0.0) + 1.0 / (_RRF_K + rank + 1)

    # When BM25 finds a chunk that wasn't in the vector top-K, we don't
    # know its true vector similarity. Backfill the distance for those
    # chunks with a single quick lookup so the per-article cap and the
    # final ordering have something useful to fall back on.
    pks_needing_dist = [
        pk for pk, c in chunk_by_pk.items() if c.similarity == 0.0
    ]
    if pks_needing_dist:
        try:
            with eng.connect() as conn:
                d_rows = conn.execute(sql_text(
                    """SELECT id, embedding <=> (:qvec)::vector AS distance
                       FROM article_chunk
                       WHERE id = ANY(:pks)"""
                ), {"qvec": vec_literal, "pks": pks_needing_dist}).all()
                for dr in d_rows:
                    c = chunk_by_pk.get(int(dr.id))
                    if c is None:
                        continue
                    dist = float(dr.distance) if dr.distance is not None else 1.0
                    c.distance = dist
                    c.similarity = max(0.0, 1.0 - dist)
        except Exception as exc:
            logger.warning("backfill distances failed: %s", exc)

    # Order candidates by fused RRF score when hybrid is active, otherwise
    # by pure vector order (preserves earlier behaviour).
    if hybrid_active:
        candidate_chunks: List[RetrievedChunk] = [
            chunk_by_pk[pk] for pk, _ in
            sorted(rrf_scores.items(), key=lambda kv: -kv[1])
        ]
    else:
        candidate_chunks = [
            chunk_by_pk[int(r.chunk_pk)] for r in vec_rows
        ]

    hybrid_info = HybridInfo(
        used=hybrid_active,
        vector_hits=len(vec_rows),
        bm25_hits=len(bm25_rows),
        fused=len(candidate_chunks),
    )
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
        hybrid=hybrid_info,
    )
