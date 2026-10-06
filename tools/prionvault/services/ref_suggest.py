"""Reference-suggestion engine — "Sugerir referencias" in PrionVault.

Takes a block of text (an abstract, a Discussion section draft, anything
the user is writing) and suggests, for one or more points in that text,
which PrionVault articles would make good citations there — with an
elaborated, grounded explanation of why each one fits.

Two modes:
  "marked" — the text already carries "(Ref.)" markers after the
             sentences/clauses that need a citation. Each marker becomes
             one numbered point; the claim text is everything since the
             previous marker (or the start of the text).
  "auto"   — no markers. A lightweight first LLM call reads the whole
             text and proposes WHERE a citation belongs (quoting the
             exact phrase to anchor on), then the rest of the pipeline
             is identical to "marked".

Pipeline, either mode:
  1. Split the text into numbered points, each with a claim string and
     the exact (start, end) character span in the ORIGINAL text where a
     citation marker should be inserted/replace a "(Ref.)".
  2. Per point, run the existing hybrid (vector + BM25, reranked)
     retriever over the PrionVault corpus using the claim as the query
     — the same engine the library chat and AI search use.
  3. ONE combined LLM call (not one per point — keeps latency and cost
     bounded for a text with many points) asks the model to judge,
     per point, which of the retrieved candidates genuinely support
     that specific claim, in what order, and WHY — quoting both the
     claim and what the article contributes. Provider fallback
     Claude → GPT → Gemini, reusing llm_pool's existing chain.
  4. Results are capped at a handful of points and candidates per
     point to keep the prompt (and the UI) manageable; `total_found`
     on each point tells the UI whether a "ver más" affordance makes
     sense beyond what's shown by default.

No database persistence — this is a stateless, synchronous request/
response feature; nothing about a suggestion run is saved.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)

_MAX_TEXT_CHARS   = 20_000     # ~3-4k words — generous for an abstract/section
_MAX_POINTS       = 15         # cap LLM prompt size for texts with many markers
_CANDIDATE_POOL   = 8          # retrieved + sent to the LLM per point
_SHOWN_BY_DEFAULT = 5           # of which this many are shown without "ver más"
_SNIPPET_CHARS    = 420         # per-candidate context chunk sent to the LLM

_REF_MARKER_RE = re.compile(r"\(\s*[Rr]ef\.?\s*\)")

_DEFAULT_PROVIDERS = ("anthropic", "openai", "gemini")


class RefSuggestError(RuntimeError):
    """User-facing error (bad input, no providers configured, etc.)."""


def _provider_chain(provider: Optional[str]) -> list[str]:
    p = (provider or "").strip().lower()
    chain = [p] if p in _DEFAULT_PROVIDERS else []
    for q in _DEFAULT_PROVIDERS:
        if q not in chain:
            chain.append(q)
    return chain


# ── Step 1a: "marked" mode — split on literal (Ref.) markers ────────────────

def _split_marked(text: str) -> list[dict]:
    points = []
    cursor = 0
    n = 0
    for m in _REF_MARKER_RE.finditer(text):
        claim = text[cursor:m.start()].strip()
        if claim:
            n += 1
            points.append({
                "n": n,
                "claim": claim,
                "replace_start": m.start(),
                "replace_end": m.end(),
            })
        cursor = m.end()
    return points


# ── Step 1b: "auto" mode — ask the LLM where citations belong ───────────────

_PLACEMENT_SYSTEM = """Eres un asistente experto en escritura científica biomédica \
(investigación de priones y enfermedades priónicas). Te doy un texto. Tu única \
tarea es identificar qué frases o afirmaciones concretas necesitarían una cita \
bibliográfica que las respalde (datos, resultados, afirmaciones específicas — no \
frases genéricas de transición).

Para cada una, devuelve una cita TEXTUAL EXACTA (copia-pega, sin modificar ni una \
coma) de las últimas 4 a 12 palabras de la frase o cláusula justo donde debería ir \
la marca de cita (normalmente el final de la frase, antes del punto). Debe \
aparecer EXACTAMENTE así en el texto original — es como vamos a localizarla.

Identifica como máximo 15 puntos, los más importantes. Si el texto no tiene \
ninguna afirmación que requiera cita, devuelve una lista vacía.

Responde SOLO con JSON estricto, sin explicación ni markdown:
{"points": [{"quote": "..."}]}"""


def _detect_points_ai(text: str, provider: Optional[str]) -> tuple[list[dict], dict]:
    from .llm_pool import call_llm_json_with_fallback

    try:
        parsed, info = call_llm_json_with_fallback(
            providers=_provider_chain(provider),
            system=_PLACEMENT_SYSTEM, user=text, max_tokens=1800,
        )
    except RuntimeError as exc:
        raise RefSuggestError(f"No se pudo analizar el texto: {exc}") from exc

    quotes = [q.get("quote", "").strip() for q in (parsed.get("points") or [])
              if isinstance(q, dict) and q.get("quote", "").strip()]

    # Locate each quote in the ORIGINAL text, in the order it appears —
    # not the order the model returned them, in case it didn't preserve
    # document order. Any quote the model paraphrased instead of copying
    # verbatim silently fails to match and is skipped (logged for
    # diagnosis) rather than guessed at.
    located = []
    for q in quotes:
        idx = text.find(q)
        if idx < 0:
            logger.info("ref_suggest: placement quote not found verbatim: %r", q[:80])
            continue
        located.append((idx, idx + len(q)))
    located.sort(key=lambda t: t[0])

    points = []
    cursor = 0
    n = 0
    for start, end in located:
        claim = text[cursor:end].strip()
        if claim:
            n += 1
            points.append({
                "n": n,
                "claim": claim,
                "replace_start": end,   # zero-width insertion — nothing removed
                "replace_end": end,
            })
        cursor = end
    return points, info


# ── Step 2: retrieval per point ──────────────────────────────────────────────

def _build_candidates(claim: str, viewer_id: Optional[str]) -> tuple[list[dict], int]:
    from ..embeddings.retriever import search as _retrieve

    result = _retrieve(claim, top_k=_CANDIDATE_POOL, per_article_cap=1,
                       rerank=True, hybrid=True, viewer_id=viewer_id)

    # Best snippet per article from the raw (unreranked-order-agnostic)
    # chunk list — first chunk matching that article_id is good enough
    # context for the explain prompt.
    snippet_by_article: dict[str, str] = {}
    for ch in result.raw_chunks:
        if ch.article_id not in snippet_by_article:
            snippet_by_article[ch.article_id] = (ch.chunk_text or "")[:_SNIPPET_CHARS]

    candidates = []
    for a in result.articles:
        candidates.append({
            "article_id": a.id,
            "title":      a.title or "(sin título)",
            "authors":    a.authors or "",
            "year":       a.year,
            "journal":    a.journal or "",
            "doi":        a.doi or "",
            "pubmed_id":  a.pubmed_id or "",
            "has_pdf":    bool(a.has_pdf),
            "snippet":    snippet_by_article.get(a.id, ""),
            "similarity": round(a.best_similarity, 4),
        })
    return candidates, result.total_candidate_articles


# ── Step 3: one combined explain call for every point ────────────────────────

_EXPLAIN_SYSTEM = """Eres un asistente experto en investigación biomédica de \
priones que ayuda a un investigador a encontrar las referencias bibliográficas \
más adecuadas para afirmaciones concretas de un texto que está escribiendo.

Te doy una lista de PUNTOS. Cada punto tiene una afirmación/frase ("claim") y una \
lista de artículos CANDIDATOS (ya recuperados por búsqueda semántica sobre la \
biblioteca de PrionVault), cada uno con un fragmento de su texto ("snippet").

Para cada punto, decide qué candidatos encajan GENUINAMENTE como cita de esa \
afirmación concreta — puede que ninguno, puede que varios. Para cada uno que \
elijas, escribe una explicación breve pero sustanciosa (2-4 frases) que:
  1. Cite qué dice exactamente la afirmación del texto.
  2. Explique qué aporta ESE artículo en relación a eso (su hallazgo, método o \
dato concreto — usa el snippet, no generalidades).
  3. Diga por qué encajan juntos.
Ordena los candidatos elegidos de más a menos relevante para esa afirmación \
concreta. Si un candidato no encaja de verdad, simplemente no lo incluyas — no \
fuerces citas.

Responde SOLO con JSON estricto, sin markdown:
{"points": [{"n": 1, "suggestions": [{"article_id": "...", "explanation": "..."}]}]}"""


def _explain_points(points: list[dict], provider: Optional[str]) -> dict:
    from .llm_pool import call_llm_json_with_fallback

    payload = []
    for p in points:
        payload.append({
            "n": p["n"],
            "claim": p["claim"][-600:],  # the clause right before the marker matters most
            "candidates": [
                {"article_id": c["article_id"], "title": c["title"],
                 "authors": (c["authors"] or "").split(";")[0].strip(),
                 "year": c["year"], "journal": c["journal"], "snippet": c["snippet"]}
                for c in p["candidates"]
            ],
        })
    user = json.dumps({"points": payload}, ensure_ascii=False)

    try:
        parsed, info = call_llm_json_with_fallback(
            providers=_provider_chain(provider),
            system=_EXPLAIN_SYSTEM, user=user, max_tokens=4000,
        )
    except RuntimeError as exc:
        raise RefSuggestError(f"No se pudieron generar las explicaciones: {exc}") from exc
    return parsed, info


# ── Entry point ───────────────────────────────────────────────────────────────

def suggest_references(text: str, mode: str, provider: Optional[str] = None,
                       viewer_id: Optional[str] = None) -> dict:
    text = (text or "").strip()
    if not text:
        raise RefSuggestError("El texto está vacío.")
    if len(text) > _MAX_TEXT_CHARS:
        raise RefSuggestError(
            f"El texto es demasiado largo ({len(text)} caracteres, máximo {_MAX_TEXT_CHARS}).")
    if mode not in ("marked", "auto"):
        raise RefSuggestError(f"Modo desconocido: {mode!r}")

    placement_info = None
    if mode == "marked":
        points = _split_marked(text)
        if not points:
            raise RefSuggestError(
                'No he encontrado ninguna marca "(Ref.)" en el texto. '
                'Añádelas al final de las frases que quieras referenciar, '
                'o usa el modo automático.')
    else:
        points, placement_info = _detect_points_ai(text, provider)
        if not points:
            raise RefSuggestError(
                "No he identificado ninguna afirmación que parezca necesitar "
                "una cita en este texto.")

    truncated = len(points) > _MAX_POINTS
    points = points[:_MAX_POINTS]

    for p in points:
        candidates, total = _build_candidates(p["claim"], viewer_id)
        p["candidates"] = candidates
        p["total_candidate_articles"] = total

    points_with_candidates = [p for p in points if p["candidates"]]
    explain_info = None
    explanations_by_point: dict[int, list[dict]] = {}
    if points_with_candidates:
        parsed, explain_info = _explain_points(points_with_candidates, provider)
        for item in (parsed.get("points") or []):
            if not isinstance(item, dict):
                continue
            n = item.get("n")
            sugg = item.get("suggestions") or []
            if isinstance(n, int) and isinstance(sugg, list):
                explanations_by_point[n] = sugg

    out_points = []
    for p in points:
        by_article = {c["article_id"]: c for c in p["candidates"]}
        ordered_explanations = explanations_by_point.get(p["n"], [])
        suggestions = []
        for item in ordered_explanations:
            if not isinstance(item, dict):
                continue
            aid = item.get("article_id")
            cand = by_article.get(aid)
            if not cand:
                continue  # guard against a hallucinated / mistyped article_id
            suggestions.append({
                **cand,
                "explanation": (item.get("explanation") or "").strip(),
            })
        out_points.append({
            "n": p["n"],
            "claim": p["claim"],
            "replace_start": p["replace_start"],
            "replace_end": p["replace_end"],
            "suggestions": suggestions[:_SHOWN_BY_DEFAULT],
            "more_suggestions": suggestions[_SHOWN_BY_DEFAULT:],
            "total_candidate_articles": p["total_candidate_articles"],
        })

    return {
        "mode": mode,
        "text": text,
        "points": out_points,
        "truncated": truncated,
        "placement_info": placement_info,
        "explain_info": explain_info,
    }
