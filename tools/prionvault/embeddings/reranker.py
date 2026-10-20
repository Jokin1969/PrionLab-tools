"""Voyage rerank-2 wrapper.

Reranking is the second stage of a quality retrieval pipeline: after
pgvector returns a large pool of candidate chunks ranked by embedding
similarity, a cross-encoder scoring model re-orders them based on the
actual semantic match between the query and each candidate, in
context. Typical accuracy uplift: 10–30%.

Voyage's rerank-2 model is used here because we already authenticate
with VOYAGE_API_KEY for embeddings. Pricing (as of late 2025) is roughly
$0.05 / 1M tokens, which is cheap enough that the rerank cost per query
is dominated by Claude, not by Voyage.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import List, Optional

logger = logging.getLogger(__name__)

MODEL = "rerank-2"
# Voyage's free tier handles up to 1000 documents/request; even our most
# aggressive over-fetch (100 candidates) is well under that.
MAX_DOCUMENTS_PER_CALL = 1000

# Pricing for cost tracking (USD per 1M tokens).
_PRICE_PER_M_TOKENS = 0.05


@dataclass
class RerankScore:
    index:           int    # position in the original input list
    relevance_score: float  # higher = more relevant; rerank-2 returns 0..1-ish


@dataclass
class RerankResult:
    scores:     List[RerankScore]
    tokens:     int
    model:      str
    elapsed_ms: int
    cost_usd:   Optional[float]


class NotConfigured(RuntimeError):
    """Raised when VOYAGE_API_KEY is not set."""


def rerank(query: str, documents: List[str], *,
           top_k: Optional[int] = None) -> RerankResult:
    """Re-rank a candidate set of documents against `query`.

    Returns the scores in INPUT order — the caller is responsible for
    applying them. (Voyage by default returns them sorted by score, but
    keeping the original indices avoids any ambiguity.)
    """
    if not query or not documents:
        return RerankResult(scores=[], tokens=0, model=MODEL,
                            elapsed_ms=0, cost_usd=0.0)
    if len(documents) > MAX_DOCUMENTS_PER_CALL:
        # Reranking a huge pool gives diminishing returns; cap defensively.
        documents = documents[:MAX_DOCUMENTS_PER_CALL]

    api_key = os.getenv("VOYAGE_API_KEY", "").strip()
    if not api_key:
        raise NotConfigured("VOYAGE_API_KEY is not set")
    import voyageai
    client = voyageai.Client(api_key=api_key)

    start = time.monotonic()
    attempt = 0
    while True:
        try:
            kwargs = {"model": MODEL, "truncation": True}
            if top_k is not None:
                kwargs["top_k"] = max(1, int(top_k))
            response = client.rerank(query, documents, **kwargs)
            break
        except Exception as exc:
            attempt += 1
            if attempt >= 3:
                raise
            backoff = 1.5 ** attempt
            logger.warning("Voyage rerank retry %d after %s — sleeping %.1fs",
                           attempt, exc, backoff)
            time.sleep(backoff)
    elapsed_ms = int((time.monotonic() - start) * 1000)

    raw_results = getattr(response, "results", []) or []
    scores: List[RerankScore] = [
        RerankScore(
            index=int(r.index),
            relevance_score=float(r.relevance_score),
        )
        for r in raw_results
    ]
    tokens = int(getattr(response, "total_tokens", 0) or 0)
    cost = round(tokens * _PRICE_PER_M_TOKENS / 1_000_000, 6) if tokens else 0.0
    return RerankResult(
        scores=scores, tokens=tokens, model=MODEL,
        elapsed_ms=elapsed_ms, cost_usd=cost,
    )
