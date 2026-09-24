"""Voyage AI embeddings client wrapper.

Uses voyage-4-large (1024 dimensions) so the vectors match the
`article_chunk.embedding` column declared in migration 001
(`vector(1024)`). voyage-4-large is the Voyage 4 family flagship
(MoE architecture, January 2026 release): replaces voyage-3-large
as the top model on the RTEB leaderboard, with serving cost
materially below the previous generation.

We keep EMBEDDING_DIM at 1024 (out of 256/512/1024/2048 supported)
so the existing pgvector column doesn't need a schema migration —
the trade-off vs. 2048 is a small recall hit on hard queries; the
+1024 dims would double our chunk-table size without measurable
gain at our corpus size (~4 k → 20 k articles).

Wraps the SDK with batching + retry logic, returns both the
embeddings and the token count Voyage charges us for so the caller
can record cost.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import List, Optional

logger = logging.getLogger(__name__)

MODEL = "voyage-4-large"
EMBEDDING_DIM = 1024

# Voyage's API allows up to 1000 texts per batch but the wisest per-call
# limit is the token budget (120k tokens / batch for voyage-4-large).
# Keeping batches at 64 texts × ~800 tokens ≈ 50k tokens is comfortably
# under the limit and keeps individual requests fast.
MAX_BATCH_SIZE = 64
# Hard cap per-document so a freak 30k-token review can't silently
# get truncated by Voyage at the 32k single-document limit. The
# embed_texts loop logs a warning and trims to this many chars so
# the call still goes through with a stable embedding.
_MAX_CHARS_PER_TEXT = 30_000

# Voyage pricing (USD per 1M tokens). voyage-4-large list price at
# launch was reported below the voyage-3-large rate thanks to the
# MoE architecture; this constant is only used for the in-app cost
# display (not for billing), so a small drift here is harmless.
# Bump this when Voyage publishes their next price card.
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
        try:
            from ..services import provider_status
            provider_status.record_error(
                "voyage", "VOYAGE_API_KEY env var is not set",
                action="resolve_key",
            )
        except Exception:
            pass
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

    # Guard against any single text overshooting Voyage's per-document
    # token cap. We trim by char count (cheap, conservative — ~3 chars
    # per token in scientific English) and log so the caller knows the
    # chunker should be tightened upstream.
    trimmed = []
    for t in texts:
        if t and len(t) > _MAX_CHARS_PER_TEXT:
            logger.warning("embedder: trimming oversized text from %d to %d chars "
                           "(input_type=%s)", len(t), _MAX_CHARS_PER_TEXT, input_type)
            trimmed.append(t[:_MAX_CHARS_PER_TEXT])
        else:
            trimmed.append(t or "")
    texts = trimmed

    client = _get_client()
    all_vecs: List[List[float]] = []
    total_tokens = 0
    start = time.monotonic()

    for batch_start in range(0, len(texts), MAX_BATCH_SIZE):
        batch = texts[batch_start:batch_start + MAX_BATCH_SIZE]
        attempt = 0
        while True:
            try:
                # voyage-4-large supports 256/512/1024/2048 — we pass
                # 1024 explicitly so a future SDK default change
                # cannot silently start returning a different size
                # than the pgvector column can store.
                resp = client.embed(
                    batch,
                    model=MODEL,
                    input_type=input_type,
                    output_dimension=EMBEDDING_DIM,
                    truncation=True,
                )
                break
            except Exception as exc:
                attempt += 1
                if attempt >= 3:
                    # Final failure on this batch — record it so the
                    # "Estado IA" panel flags Voyage as down before
                    # bubbling up.
                    try:
                        from ..services import provider_status
                        provider_status.record_error(
                            "voyage", str(exc), action="embed",
                        )
                    except Exception:
                        pass
                    raise
                # Most retriable errors are transient (rate limits, brief
                # network blips). Exponential backoff.
                backoff = 1.5 ** attempt
                logger.warning("Voyage embed retry %d after %s — sleeping %.1fs",
                               attempt, exc, backoff)
                time.sleep(backoff)

        all_vecs.extend(resp.embeddings)
        total_tokens += getattr(resp, "total_tokens", 0) or 0

    # Whole-call success.
    try:
        from ..services import provider_status
        provider_status.record_success("voyage", action="embed")
    except Exception:
        pass

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
