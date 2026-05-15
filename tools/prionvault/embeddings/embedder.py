"""Voyage AI embeddings client wrapper.

Uses voyage-3-large (1024 dimensions) so the vectors match the
`article_chunk.embedding` column declared in migration 001
(`vector(1024)`). Wraps the SDK with batching + retry logic, returns
both the embeddings and the token count Voyage charges us for so the
caller can record cost.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import List, Optional

logger = logging.getLogger(__name__)

MODEL = "voyage-3-large"
EMBEDDING_DIM = 1024

# Voyage's API allows up to 1000 texts per batch but the wisest per-call
# limit is the token budget (120k tokens / batch for voyage-3-large).
# Keeping batches at 64 texts × ~800 tokens ≈ 50k tokens is comfortably
# under the limit and keeps individual requests fast.
MAX_BATCH_SIZE = 64

# Voyage pricing (USD per 1M tokens) — voyage-3-large at the time of
# writing. Adjust if Voyage changes pricing.
_PRICE_PER_M_TOKENS = 0.12


@dataclass
class EmbedResult:
    embeddings:  List[List[float]]
    tokens:      int
    model:       str
    elapsed_ms:  int
    cost_usd:    Optional[float]


class NotConfigured(RuntimeError):
    """Raised when VOYAGE_API_KEY is not set."""


def _get_client():
    api_key = os.getenv("VOYAGE_API_KEY", "").strip()
    if not api_key:
        raise NotConfigured("VOYAGE_API_KEY is not set")
    import voyageai
    return voyageai.Client(api_key=api_key)


def embed_texts(texts: List[str], *,
                input_type: str = "document") -> EmbedResult:
    """Embed a list of texts. `input_type` is "document" for indexing or
    "query" for search queries — Voyage uses different prompts internally
    and the docs strongly suggest passing the correct one.
    """
    if not texts:
        return EmbedResult(embeddings=[], tokens=0, model=MODEL,
                           elapsed_ms=0, cost_usd=0.0)
    if input_type not in ("document", "query"):
        raise ValueError(f"input_type must be 'document' or 'query', got {input_type!r}")

    client = _get_client()
    all_vecs: List[List[float]] = []
    total_tokens = 0
    start = time.monotonic()

    for batch_start in range(0, len(texts), MAX_BATCH_SIZE):
        batch = texts[batch_start:batch_start + MAX_BATCH_SIZE]
        attempt = 0
        while True:
            try:
                resp = client.embed(
                    batch,
                    model=MODEL,
                    input_type=input_type,
                    truncation=True,
                )
                break
            except Exception as exc:
                attempt += 1
                if attempt >= 3:
                    raise
                # Most retriable errors are transient (rate limits, brief
                # network blips). Exponential backoff.
                backoff = 1.5 ** attempt
                logger.warning("Voyage embed retry %d after %s — sleeping %.1fs",
                               attempt, exc, backoff)
                time.sleep(backoff)

        all_vecs.extend(resp.embeddings)
        total_tokens += getattr(resp, "total_tokens", 0) or 0

    elapsed_ms = int((time.monotonic() - start) * 1000)
    cost = round(total_tokens * _PRICE_PER_M_TOKENS / 1_000_000, 6) \
        if total_tokens else 0.0
    return EmbedResult(
        embeddings=all_vecs,
        tokens=total_tokens,
        model=MODEL,
        elapsed_ms=elapsed_ms,
        cost_usd=cost,
    )


def embed_query(query: str) -> List[float]:
    """Embed a single query string. Convenience wrapper around embed_texts."""
    result = embed_texts([query], input_type="query")
    return result.embeddings[0] if result.embeddings else []
