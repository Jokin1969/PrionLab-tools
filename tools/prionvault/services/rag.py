"""RAG pipeline: retrieval-augmented question answering on the library.

Workflow:
  1. Run the vector retriever against the user's question.
  2. Build a numbered context block with the top chunks.
  3. Ask Claude to answer using ONLY that context, citing the source
     number for every claim and reporting a confidence level.
  4. Return: synthesized markdown answer + list of cited papers (with
     metadata + the actual extracts) + token/cost usage.

The system prompt is deliberately strict about hallucination: if the
context doesn't support an answer, Claude has to say so explicitly.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import List, Optional

from ..embeddings.retriever import (
    search,
    RetrievedArticle,
    RetrievedChunk,
    RetrievalResult,
)
from ..embeddings.embedder import NotConfigured as VoyageNotConfigured

logger = logging.getLogger(__name__)


CHAT_MODEL = "claude-sonnet-4-6"
MAX_OUTPUT_TOKENS = 1200

# Approximate USD pricing per 1M tokens for the chat model.
_CHAT_PRICE = {"in": 3.0, "out": 15.0}


_SYSTEM_PROMPT = """Eres un asistente de investigación especializado en literatura \
científica biomédica, con experiencia en priones y neurodegeneración. Tu papel \
es contestar preguntas usando ÚNICAMENTE los fragmentos numerados que el \
usuario te proporciona como contexto.

Reglas estrictas:
- Si los fragmentos no contienen información suficiente, responde literalmente \
  "No encuentro evidencia suficiente en la biblioteca para responder esta \
  pregunta." y, si quieres, sugiere por qué.
- No inventes nombres, fechas, valores numéricos ni conclusiones que no \
  aparezcan en los fragmentos.
- Cita cada afirmación usando la notación [N] (donde N es el número del \
  fragmento). Una misma frase puede llevar varias citas: [1][3].
- Al final, en una línea separada, escribe exactamente:
      Nivel de confianza: alto|medio|bajo
  según cuánto te apoyas en evidencia clara y consistente.
- Responde en español, con terminología científica precisa, en tono conciso \
  (3-8 frases salvo que la pregunta exija más detalle)."""


@dataclass
class RagCitation:
    n:            int        # 1-based index in the context block
    article_id:   str
    title:        str
    authors:      Optional[str]
    year:         Optional[int]
    journal:      Optional[str]
    doi:          Optional[str]
    pubmed_id:    Optional[str]
    similarity:   float
    rerank_score: Optional[float]
    extract:      str        # the actual chunk text shown to the model


@dataclass
class RagResult:
    query:           str
    answer:          str
    confidence:      Optional[str]   # "alto" | "medio" | "bajo" | None
    citations:       List[RagCitation]   # papers that ended up in the prompt
    cited_numbers:   List[int]       # numbers actually referenced in answer
    tokens_in:       Optional[int]
    tokens_out:      Optional[int]
    cost_usd:        Optional[float]   # Claude cost only (rerank tracked separately)
    elapsed_ms:      int
    retrieval_ms:    int
    no_results:      bool            # True if retrieval found nothing
    rerank_used:     bool = False
    rerank_candidates: int = 0
    rerank_cost_usd: Optional[float] = None
    hybrid_used:     bool = False
    hybrid_vector_hits: int = 0
    hybrid_bm25_hits:   int = 0
    hybrid_fused:       int = 0


class AnthropicNotConfigured(RuntimeError):
    """Raised when ANTHROPIC_API_KEY is missing."""


def _build_context(chunks: List[RetrievedChunk],
                   articles: List[RetrievedArticle]
                   ) -> tuple[str, List[RagCitation]]:
    by_id = {a.id: a for a in articles}
    citations: List[RagCitation] = []
    parts: List[str] = []
    for i, c in enumerate(chunks, start=1):
        meta = by_id.get(c.article_id)
        if meta is None:
            continue
        cite = RagCitation(
            n=i,
            article_id=meta.id,
            title=meta.title,
            authors=meta.authors,
            year=meta.year,
            journal=meta.journal,
            doi=meta.doi,
            pubmed_id=meta.pubmed_id,
            similarity=c.similarity,
            rerank_score=c.rerank_score,
            extract=c.chunk_text,
        )
        citations.append(cite)
        header_bits = []
        if meta.authors: header_bits.append(meta.authors[:120])
        if meta.year:    header_bits.append(str(meta.year))
        if meta.journal: header_bits.append(meta.journal[:80])
        if meta.doi:     header_bits.append(f"DOI:{meta.doi}")
        header = " · ".join(header_bits)
        parts.append(
            f"[{i}] {meta.title}\n"
            f"    {header}\n"
            f"    Extracto: {c.chunk_text}"
        )
    return "\n\n".join(parts), citations


def _parse_confidence(text: str) -> Optional[str]:
    import re
    m = re.search(r"nivel\s+de\s+confianza[:\s]+(alto|medio|bajo)",
                  text, flags=re.IGNORECASE)
    return m.group(1).lower() if m else None


def _parse_cited_numbers(text: str) -> List[int]:
    import re
    return sorted({int(m) for m in re.findall(r"\[(\d{1,3})\]", text)})


def _estimate_cost(tokens_in: Optional[int],
                   tokens_out: Optional[int]) -> Optional[float]:
    if tokens_in is None or tokens_out is None:
        return None
    return round(
        (tokens_in * _CHAT_PRICE["in"] + tokens_out * _CHAT_PRICE["out"]) / 1_000_000,
        5,
    )


def ask(query: str, *, top_k: int = 20) -> RagResult:
    """End-to-end RAG: retrieve, prompt Claude, parse, return."""
    start = time.monotonic()
    api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        raise AnthropicNotConfigured("ANTHROPIC_API_KEY is not set")

    retrieval_start = time.monotonic()
    try:
        retrieval: RetrievalResult = search(query, top_k=top_k)
    except VoyageNotConfigured:
        raise   # bubble up; caller maps to 503
    retrieval_ms = int((time.monotonic() - retrieval_start) * 1000)

    if not retrieval.raw_chunks:
        return RagResult(
            query=query,
            answer=("No encuentro evidencia en la biblioteca para esta pregunta. "
                    "Es posible que aún no haya artículos relevantes indexados, "
                    "o que la pregunta esté fuera del alcance de la colección."),
            confidence="bajo",
            citations=[],
            cited_numbers=[],
            tokens_in=None,
            tokens_out=None,
            cost_usd=None,
            elapsed_ms=int((time.monotonic() - start) * 1000),
            retrieval_ms=retrieval_ms,
            no_results=True,
            rerank_used=bool(retrieval.rerank and retrieval.rerank.used),
            rerank_candidates=retrieval.rerank.candidates if retrieval.rerank else 0,
            rerank_cost_usd=retrieval.rerank.cost_usd if retrieval.rerank else None,
            hybrid_used=bool(retrieval.hybrid and retrieval.hybrid.used),
            hybrid_vector_hits=retrieval.hybrid.vector_hits if retrieval.hybrid else 0,
            hybrid_bm25_hits=retrieval.hybrid.bm25_hits if retrieval.hybrid else 0,
            hybrid_fused=retrieval.hybrid.fused if retrieval.hybrid else 0,
        )

    context_text, citations = _build_context(retrieval.raw_chunks,
                                             retrieval.articles)
    user_prompt = (
        f"Pregunta del usuario:\n{query}\n\n"
        f"Fragmentos de la biblioteca:\n{context_text}\n\n"
        f"Recuerda: responde usando ÚNICAMENTE los fragmentos anteriores, "
        f"cita con [N] cada afirmación, y termina con la línea "
        f"'Nivel de confianza: alto|medio|bajo'."
    )

    import anthropic
    client = anthropic.Anthropic(api_key=api_key)
    message = client.messages.create(
        model=CHAT_MODEL,
        max_tokens=MAX_OUTPUT_TOKENS,
        system=_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_prompt}],
    )
    answer = "".join(
        b.text for b in message.content if getattr(b, "type", None) == "text"
    ).strip()
    if not answer:
        raise RuntimeError("Claude returned an empty response")

    usage = getattr(message, "usage", None)
    tokens_in  = getattr(usage, "input_tokens",  None) if usage else None
    tokens_out = getattr(usage, "output_tokens", None) if usage else None

    cited_nums = _parse_cited_numbers(answer)
    confidence = _parse_confidence(answer)

    return RagResult(
        query=query,
        answer=answer,
        confidence=confidence,
        citations=citations,
        cited_numbers=cited_nums,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cost_usd=_estimate_cost(tokens_in, tokens_out),
        elapsed_ms=int((time.monotonic() - start) * 1000),
        retrieval_ms=retrieval_ms,
        no_results=False,
        rerank_used=bool(retrieval.rerank and retrieval.rerank.used),
        rerank_candidates=retrieval.rerank.candidates if retrieval.rerank else 0,
        rerank_cost_usd=retrieval.rerank.cost_usd if retrieval.rerank else None,
        hybrid_used=bool(retrieval.hybrid and retrieval.hybrid.used),
        hybrid_vector_hits=retrieval.hybrid.vector_hits if retrieval.hybrid else 0,
        hybrid_bm25_hits=retrieval.hybrid.bm25_hits if retrieval.hybrid else 0,
        hybrid_fused=retrieval.hybrid.fused if retrieval.hybrid else 0,
    )
