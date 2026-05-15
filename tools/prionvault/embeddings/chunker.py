"""Token-aware text splitter with overlap for RAG indexing.

Splits a long text (typically `articles.extracted_text` from a PDF) into
chunks of ~CHUNK_TOKENS tokens with a CHUNK_OVERLAP_TOKENS-token overlap
between consecutive chunks, so context isn't lost at the cut points.

We use tiktoken's cl100k_base encoding as a portable token estimator —
it's not Voyage's exact tokenizer but it's close enough for sizing
purposes and avoids a hard dependency on every provider's SDK during
splitting. The token COUNT we report to the embedder is its own,
authoritative one; this number is only used to decide where to cut.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Iterator, List, Optional

logger = logging.getLogger(__name__)

# ~800 input tokens per chunk fits well within Voyage's 32 k context and
# gives ~16-20 chunks per typical paper. Overlap of 200 keeps continuity
# at the boundaries without inflating the index too much.
CHUNK_TOKENS = 800
CHUNK_OVERLAP_TOKENS = 200

_ENCODING_NAME = "cl100k_base"


@dataclass
class Chunk:
    index:        int   # 0-based position within the article
    text:         str
    tokens:       int   # token count (tiktoken estimate)
    char_start:   int   # offset in the source text
    char_end:     int


def _get_encoding():
    try:
        import tiktoken
        return tiktoken.get_encoding(_ENCODING_NAME)
    except Exception as exc:
        logger.warning("tiktoken unavailable (%s) — falling back to char-based heuristics", exc)
        return None


def _normalise(text: str) -> str:
    """Collapse runs of whitespace and strip control chars that pdfplumber
    sometimes leaves in. Keeps newlines because they often mark section
    boundaries useful for the retriever to display context.
    """
    if not text:
        return ""
    # Strip BOM and other ZW chars
    text = text.replace("﻿", "").replace("​", "")
    # Normalise non-newline whitespace runs
    text = re.sub(r"[ \t\xa0]+", " ", text)
    # Collapse 3+ newlines to 2
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def chunk_text(
    text: str,
    *,
    chunk_tokens: int = CHUNK_TOKENS,
    overlap_tokens: int = CHUNK_OVERLAP_TOKENS,
) -> List[Chunk]:
    """Split `text` into overlapping chunks.

    Returns an empty list for empty or trivially short input.
    """
    cleaned = _normalise(text)
    if not cleaned or len(cleaned) < 200:
        return []

    enc = _get_encoding()
    if enc is None:
        # Char-based fallback: ~4 chars per token is the usual heuristic.
        return _chunk_by_chars(
            cleaned,
            chunk_chars=chunk_tokens * 4,
            overlap_chars=overlap_tokens * 4,
        )

    token_ids = enc.encode(cleaned, disallowed_special=())
    n = len(token_ids)
    if n == 0:
        return []
    if n <= chunk_tokens:
        return [Chunk(
            index=0, text=cleaned, tokens=n,
            char_start=0, char_end=len(cleaned),
        )]

    step = max(1, chunk_tokens - overlap_tokens)
    chunks: List[Chunk] = []
    pos = 0
    idx = 0
    while pos < n:
        end = min(n, pos + chunk_tokens)
        piece_tokens = token_ids[pos:end]
        piece_text = enc.decode(piece_tokens)
        chunks.append(Chunk(
            index=idx,
            text=piece_text.strip(),
            tokens=len(piece_tokens),
            char_start=0,   # offsets are approximate when going through tokens
            char_end=0,
        ))
        idx += 1
        if end >= n:
            break
        pos += step
    return chunks


def _chunk_by_chars(text: str, *, chunk_chars: int,
                    overlap_chars: int) -> List[Chunk]:
    """Fallback splitter when tiktoken is unavailable."""
    chunks: List[Chunk] = []
    n = len(text)
    if n == 0:
        return chunks
    if n <= chunk_chars:
        return [Chunk(
            index=0, text=text, tokens=max(1, n // 4),
            char_start=0, char_end=n,
        )]
    step = max(1, chunk_chars - overlap_chars)
    pos = 0
    idx = 0
    while pos < n:
        end = min(n, pos + chunk_chars)
        piece = text[pos:end]
        chunks.append(Chunk(
            index=idx,
            text=piece.strip(),
            tokens=max(1, len(piece) // 4),
            char_start=pos,
            char_end=end,
        ))
        idx += 1
        if end >= n:
            break
        pos += step
    return chunks


def iter_chunks(text: str) -> Iterator[Chunk]:
    """Generator version for streaming over very large texts."""
    for c in chunk_text(text):
        yield c
