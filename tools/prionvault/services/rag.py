"""RAG pipeline: retrieval-augmented question answering on the library.

Workflow:
  1. Run the vector retriever against the user's question.
  2. Build a numbered context block with the top chunks.
  3. Ask the selected provider (Claude / GPT / Gemini) to answer using
     ONLY that context, citing the source number for every claim and
     reporting a confidence level.
  4. Return: synthesized markdown answer + list of cited papers (with
     metadata + the actual extracts) + token/cost usage.

The system prompt is deliberately strict about hallucination: if the
context doesn't support an answer, the model has to say so explicitly.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from typing import List, Optional

from ..embeddings.retriever import (
    search,
    RetrievedArticle,
    RetrievedChunk,
    RetrievalResult,
)
from ..embeddings.embedder import NotConfigured as VoyageNotConfigured
from .ai_summary import PROVIDERS, DEFAULT_PROVIDER, NotConfigured

logger = logging.getLogger(__name__)


MAX_OUTPUT_TOKENS = 1200
DEFAULT_CHAT_PROVIDER = DEFAULT_PROVIDER


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
    # True when the article has a Dropbox PDF the UI can link directly
    # to via /prionvault/api/articles/<id>/pdf-view.
    has_pdf:      bool = False


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
    # Pagination support for the "ver más" UI affordance:
    #   top_k_used        — limit honoured for this call
    #   total_candidates  — distinct articles the retriever found in
    #                       its candidate pool. If > top_k_used the
    #                       UI offers a prompt to fetch more.
    #   has_more          — total_candidates > len(citations).
    top_k_used:      int = 0
    total_candidates: int = 0
    has_more:        bool = False
    # Each entry is (term, expansions) — what the biomedical query
    # expander broadened your query into. Empty when nothing matched.
    expansion_matches: list = field(default_factory=list)
    # Provider fallback chain: the provider that ACTUALLY answered may
    # not be the one the operator picked. When the first choice fails
    # with a recoverable cause (safety refusal, rate-limit, empty
    # response), we retry against the next fallback in line and record
    # what happened, so the UI can render an amber banner like
    # "Pediste Claude pero rechazó por filtro de seguridad. Te respondí
    #  con Gemini en su lugar."
    requested_provider: str = ""
    actual_provider:    str = ""
    fallback_attempts:  list = field(default_factory=list)
    #   list[ {provider, kind, reason} ]
    # kind ∈ {refusal, rate_limit, max_tokens, empty, not_configured,
    #         other}.


# Backwards-compat alias — the route used to import this name.
# Now ProviderNotConfigured / NotConfigured (from ai_summary) covers
# the "no API key for this provider" case uniformly.
AnthropicNotConfigured = NotConfigured


def _fetch_summaries(article_ids: list[str]) -> dict[str, str]:
    """Return {article_id: summary_ai} for the given ids, skipping
    articles without a summary. One round-trip, no re-indexing needed."""
    if not article_ids:
        return {}
    try:
        from ..ingestion.queue import _get_engine
        from sqlalchemy import text as _sql
        eng = _get_engine()
        with eng.connect() as conn:
            rows = conn.execute(_sql(
                "SELECT id::text, summary_ai FROM articles "
                "WHERE id = ANY(CAST(:ids AS uuid[])) "
                "  AND summary_ai IS NOT NULL AND summary_ai <> ''"
            ), {"ids": article_ids}).all()
        return {r[0]: r[1] for r in rows}
    except Exception as exc:
        logger.warning("rag: could not fetch summaries: %s", exc)
        return {}


def _build_context(chunks: List[RetrievedChunk],
                   articles: List[RetrievedArticle]
                   ) -> tuple[str, List[RagCitation]]:
    by_id = {a.id: a for a in articles}
    article_ids = list(by_id.keys())
    summaries = _fetch_summaries(article_ids)

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
            has_pdf=bool(getattr(meta, "has_pdf", False)),
        )
        citations.append(cite)
        header_bits = []
        if meta.authors: header_bits.append(meta.authors[:120])
        if meta.year:    header_bits.append(str(meta.year))
        if meta.journal: header_bits.append(meta.journal[:80])
        if meta.doi:     header_bits.append(f"DOI:{meta.doi}")
        header = " · ".join(header_bits)
        block = (
            f"[{i}] {meta.title}\n"
            f"    {header}\n"
            f"    Extracto: {c.chunk_text}"
        )
        summary = summaries.get(meta.id)
        if summary:
            # Cap at 800 chars so a very long summary doesn't dominate
            # the context at the expense of other chunks.
            block += f"\n    Resumen IA: {summary[:800]}"
        parts.append(block)
    return "\n\n".join(parts), citations


def _parse_confidence(text: str) -> Optional[str]:
    """Pull the confidence label out of the model's answer. The prompt
    asks for "Nivel de confianza: alto|medio|bajo", but real models
    drift to "Confianza: medio", "Confidence: medium", etc. — the
    regex is lenient enough to catch all of these and normalises
    English → Spanish so the rest of the pipeline only sees one set.
    """
    import re
    m = re.search(
        r"(?:nivel\s+de\s+)?(?:confianza|confidence)[:\s]+(alto|medio|bajo|high|medium|low)",
        text or "", flags=re.IGNORECASE,
    )
    if not m:
        return None
    v = m.group(1).lower()
    mapping = {"high": "alto", "medium": "medio", "low": "bajo"}
    return mapping.get(v, v)


def _parse_cited_numbers(text: str) -> List[int]:
    import re
    return sorted({int(m) for m in re.findall(r"\[(\d{1,3})\]", text)})


# ── Fallback chain: when the user-chosen provider can't deliver, try ───
# the next one in the row. Chosen so the alternate always belongs to
# a DIFFERENT vendor — that way a vendor-wide outage / safety filter
# / rate-limit doesn't double-fail. Two fallback steps max.
_FALLBACK_CHAIN: dict[str, list[str]] = {
    "anthropic": ["gemini",    "openai"],
    "openai":    ["gemini",    "anthropic"],
    "gemini":    ["anthropic", "openai"],
}

# Failure kinds that trigger a fallback. "other" does NOT — it usually
# means a code bug we want to surface as a 502, not silently retry.
_FALLBACK_KINDS = frozenset({
    "refusal", "rate_limit", "max_tokens", "empty", "not_configured",
})


def _classify_failure(exc: Exception) -> tuple[str, str]:
    """Bucket a chat-call failure into a (kind, human-readable reason)
    tuple. Wraps NotConfigured + every RuntimeError we know how to
    raise from _chat() plus generic SDK error shapes. The reason is
    what the UI banner shows the operator — keep it short and Spanish.
    """
    if isinstance(exc, NotConfigured):
        return ("not_configured",
                "API key del proveedor no configurada")
    msg = str(exc).lower()
    if "refusal" in msg or "declined" in msg or "block_reason=safety" in msg:
        return ("refusal",
                "Filtro de seguridad del proveedor rechazó la consulta")
    if ("429" in msg or "rate limit" in msg or "rate_limit" in msg
            or "quota" in msg or "tpm" in msg
            or "tokens per min" in msg or "resource_exhausted" in msg):
        return ("rate_limit",
                "Rate limit del proveedor alcanzado")
    if ("max_tokens" in msg or "max_output_tokens" in msg
            or "max tokens" in msg):
        return ("max_tokens",
                "El proveedor agotó su presupuesto de tokens sin terminar")
    if "empty response" in msg or "empty answer" in msg:
        return ("empty",
                "El proveedor devolvió una respuesta vacía sin razón clara")
    return ("other", str(exc)[:200])


def _estimate_cost(provider: str, tokens_in: Optional[int],
                   tokens_out: Optional[int]) -> Optional[float]:
    p = PROVIDERS.get(provider)
    if not p or tokens_in is None or tokens_out is None:
        return None
    return round(
        (tokens_in * p["price_in"] + tokens_out * p["price_out"]) / 1_000_000,
        5,
    )


def _chat(*, provider: str, system: str, user: str) -> tuple[str, Optional[int], Optional[int], str]:
    """Dispatch to the selected provider. Returns (answer_text,
    tokens_in, tokens_out, model). Raises NotConfigured if the key is
    missing, or RuntimeError on empty responses, so the caller can
    bubble that up as a 503 or 502."""
    if provider not in PROVIDERS:
        raise ValueError(f"unknown provider {provider!r}")
    api_key = os.getenv(PROVIDERS[provider]["env"], "").strip()
    if not api_key:
        raise NotConfigured(f"{PROVIDERS[provider]['env']} is not set")
    model = PROVIDERS[provider]["model"]

    if provider == "anthropic":
        import anthropic
        client = anthropic.Anthropic(api_key=api_key, timeout=60.0)
        # Output budget: 4096 instead of the shared MAX_OUTPUT_TOKENS
        # (1 200). 1 200 is enough for the 3-8 sentence target, but
        # when the model decides the question warrants a longer
        # answer and runs out of room mid-sentence the SDK returns
        # an empty text block + stop_reason="max_tokens". Quadrupling
        # the cap costs nothing per call (Claude bills only emitted
        # tokens) and eliminates that failure mode for free.
        anthropic_max_out = max(MAX_OUTPUT_TOKENS * 4, 4096)
        msg = client.messages.create(
            model=model, max_tokens=anthropic_max_out,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        text = "".join(b.text for b in msg.content
                       if getattr(b, "type", None) == "text").strip()

        # When the answer is still empty, surface the actual cause
        # instead of a generic "empty response" — same diagnostic
        # treatment as the Gemini branch below.
        # Claude's stop_reason values: end_turn, max_tokens,
        # stop_sequence, tool_use, pause_turn, refusal.
        if not text:
            stop_reason = getattr(msg, "stop_reason", None)
            content_types = sorted({
                getattr(b, "type", "unknown") for b in (msg.content or [])
            })
            bits = []
            if stop_reason:
                bits.append(f"stop_reason={stop_reason}")
            if content_types and content_types != ["text"]:
                bits.append(f"content_types={','.join(content_types)}")
            if stop_reason == "max_tokens":
                bits.append(
                    "the model ran out of output budget before "
                    "writing visible text — retry the same query")
            elif stop_reason == "refusal":
                bits.append(
                    "Claude declined to answer this question — "
                    "try rephrasing or switch provider")
            if bits:
                raise RuntimeError(
                    "Claude Sonnet 4.6 returned an empty response ("
                    + "; ".join(bits) + ")"
                )

        usage = getattr(msg, "usage", None)
        return (text,
                getattr(usage, "input_tokens",  None) if usage else None,
                getattr(usage, "output_tokens", None) if usage else None,
                model)

    if provider == "openai":
        from openai import OpenAI
        client = OpenAI(api_key=api_key, timeout=60.0)
        comp = client.chat.completions.create(
            model=model, max_tokens=MAX_OUTPUT_TOKENS,
            messages=[
                {"role": "system", "content": system},
                {"role": "user",   "content": user},
            ],
        )
        choice = comp.choices[0] if comp.choices else None
        text = ((choice.message.content if choice and choice.message else "")
                or "").strip()
        usage = getattr(comp, "usage", None)
        return (text,
                getattr(usage, "prompt_tokens",     None) if usage else None,
                getattr(usage, "completion_tokens", None) if usage else None,
                model)

    # gemini — needs special handling for "thinking" budget on 2.5 Pro
    from google import genai
    from google.genai import types
    client = genai.Client(api_key=api_key)

    # Gemini 2.5 Pro reasons internally before producing visible text,
    # and those reasoning tokens count against max_output_tokens. With
    # the shared 1 200-token cap the model would spend its whole budget
    # thinking and finish with an empty `text`, surfacing as
    # "Gemini 2.5 Pro returned an empty response". Triple the cap for
    # Gemini specifically (Claude / OpenAI keep the original 1 200,
    # which is plenty for the 3-8 sentence answer we ask for).
    gemini_max_out = max(MAX_OUTPUT_TOKENS * 8, 8192)
    cfg_kwargs = {
        "system_instruction":   system,
        "max_output_tokens":    gemini_max_out,
        "temperature":          0.3,
    }
    # If the SDK exposes ThinkingConfig (google-genai ≥ 1.0), cap the
    # thinking budget explicitly so the model always has room left for
    # the user-facing answer. Older SDKs ignore the field — wrap the
    # whole thing in a try so a missing class doesn't break the call.
    try:
        cfg_kwargs["thinking_config"] = types.ThinkingConfig(
            thinking_budget=2048,
            include_thoughts=False,
        )
    except (AttributeError, TypeError):
        pass

    resp = client.models.generate_content(
        model=model, contents=user,
        config=types.GenerateContentConfig(**cfg_kwargs),
    )
    text = (getattr(resp, "text", "") or "").strip()

    # When the answer is still empty, surface the actual cause instead
    # of a generic "empty response". Gemini exposes a finish_reason on
    # each candidate (MAX_TOKENS, SAFETY, RECITATION, OTHER) and a
    # block_reason on the prompt_feedback when the input itself was
    # rejected. Operators can act on these messages directly.
    if not text:
        cands = getattr(resp, "candidates", None) or []
        cand_reason = (str(cands[0].finish_reason)
                       if cands and getattr(cands[0], "finish_reason", None)
                       else None)
        pf = getattr(resp, "prompt_feedback", None)
        block_reason = (str(getattr(pf, "block_reason", "") or "")
                        if pf else "")
        reason_bits = []
        if cand_reason:  reason_bits.append(f"finish_reason={cand_reason}")
        if block_reason: reason_bits.append(f"block_reason={block_reason}")
        if reason_bits:
            raise RuntimeError(
                f"Gemini 2.5 Pro returned an empty response ("
                + ", ".join(reason_bits) + ")"
            )
        # No diagnostic info available — fall through to the generic
        # error so the caller still gets a useful 502.

    usage = getattr(resp, "usage_metadata", None)
    return (text,
            getattr(usage, "prompt_token_count",     None) if usage else None,
            getattr(usage, "candidates_token_count", None) if usage else None,
            model)


def ask(query: str, *, top_k: int = 20,
        provider: str = DEFAULT_CHAT_PROVIDER) -> RagResult:
    """End-to-end RAG: retrieve, prompt the selected provider, parse,
    return. Bubbles NotConfigured / VoyageNotConfigured so the caller
    can map them to 503; other exceptions become 502."""
    start = time.monotonic()
    if provider not in PROVIDERS:
        raise ValueError(f"unknown provider {provider!r}")

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
            top_k_used=top_k,
            total_candidates=0,
            has_more=False,
            expansion_matches=list(retrieval.expansion_matches or []),
            requested_provider=provider,
            actual_provider=provider,
            fallback_attempts=[],
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
    # Defensive context-window guard. Modern frontier models (Claude
    # Sonnet 4.6, GPT-4.1, Gemini 2.5 Pro) all have ≥ 200 k token
    # windows so this almost never triggers — but if a future call
    # routes to a smaller model (Haiku, GPT-mini) the prompt would
    # silently get truncated mid-citation and the grounding breaks.
    # ~4 chars per token in scientific English → 150 k chars ≈ 38 k
    # tokens of context, well within every supported model's input
    # limit.
    _CTX_CHAR_CAP = 150_000
    if len(context_text) > _CTX_CHAR_CAP:
        keep = []
        running = 0
        # Walk the numbered chunks from the start (highest-ranked
        # appears first) and stop once we'd overflow.
        for block in context_text.split("\n\n"):
            if running + len(block) + 2 > _CTX_CHAR_CAP:
                break
            keep.append(block)
            running += len(block) + 2
        logger.warning("rag: context truncated from %d to %d chars "
                       "(%d / %d chunks kept)",
                       len(context_text), running, len(keep),
                       context_text.count("\n\n") + 1)
        context_text = "\n\n".join(keep)

    user_prompt = (
        f"Pregunta del usuario:\n{query}\n\n"
        f"Fragmentos de la biblioteca:\n{context_text}\n\n"
        f"Recuerda: responde usando ÚNICAMENTE los fragmentos anteriores, "
        f"cita con [N] cada afirmación, y termina con la línea "
        f"'Nivel de confianza: alto|medio|bajo'."
    )

    # Provider fallback chain: try the requested provider first; if it
    # fails with a recoverable cause, fall through to the next vendor.
    # The chain is short (2 steps) and the alternate always belongs to
    # a different vendor so a single vendor's outage / safety policy /
    # rate-limit can't double-fail.
    fallback_attempts: list[dict] = []
    chain = [provider] + _FALLBACK_CHAIN.get(provider, [])
    answer = ""
    tokens_in = tokens_out = None
    model_used = PROVIDERS[provider]["model"]
    actual_provider = provider
    last_exc: Optional[Exception] = None

    for attempt_provider in chain:
        try:
            answer, tokens_in, tokens_out, model_used = _chat(
                provider=attempt_provider,
                system=_SYSTEM_PROMPT,
                user=user_prompt,
            )
            if not answer:
                raise RuntimeError(
                    f"{PROVIDERS[attempt_provider]['label']} returned an "
                    f"empty response")
            actual_provider = attempt_provider
            break    # got a usable answer
        except Exception as exc:
            kind, reason = _classify_failure(exc)
            fallback_attempts.append({
                "provider": attempt_provider,
                "kind":     kind,
                "reason":   reason,
            })
            last_exc = exc
            if kind not in _FALLBACK_KINDS:
                # Don't retry an unexpected error class — could be a
                # code bug the operator needs to see.
                raise
            # Try the next provider in line. If we exhaust the chain
            # the outer raise below carries the last failure up.
            logger.info(
                "rag fallback: %s failed (%s — %s); trying next",
                attempt_provider, kind, reason)
            continue
    else:
        # Chain exhausted with no successful answer — bubble the last
        # failure so the route returns its 502 with the original error
        # text. The UI then shows the full attempt list.
        if last_exc is not None:
            raise last_exc

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
        cost_usd=_estimate_cost(actual_provider, tokens_in, tokens_out),
        elapsed_ms=int((time.monotonic() - start) * 1000),
        retrieval_ms=retrieval_ms,
        no_results=False,
        top_k_used=top_k,
        total_candidates=retrieval.total_candidate_articles,
        has_more=(retrieval.total_candidate_articles > len(citations)),
        expansion_matches=list(retrieval.expansion_matches or []),
        requested_provider=provider,
        actual_provider=actual_provider,
        fallback_attempts=fallback_attempts,
        rerank_used=bool(retrieval.rerank and retrieval.rerank.used),
        rerank_candidates=retrieval.rerank.candidates if retrieval.rerank else 0,
        rerank_cost_usd=retrieval.rerank.cost_usd if retrieval.rerank else None,
        hybrid_used=bool(retrieval.hybrid and retrieval.hybrid.used),
        hybrid_vector_hits=retrieval.hybrid.vector_hits if retrieval.hybrid else 0,
        hybrid_bm25_hits=retrieval.hybrid.bm25_hits if retrieval.hybrid else 0,
        hybrid_fused=retrieval.hybrid.fused if retrieval.hybrid else 0,
    )
