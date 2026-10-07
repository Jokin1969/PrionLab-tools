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
_CONTEXT_TAIL_CHARS = 600       # how much of a claim's tail drives retrieval + explanation

# Tolerant on purpose: any case ("Ref"/"REF"/"ref"), optional trailing
# "." or plural "s" ("Ref", "Ref.", "Refs", "Refs."), with or without
# surrounding ( ) or [ ], and matched as a whole word so it never fires
# inside "reference"/"refer". Does NOT require brackets at all — a bare
# "Ref." in running text is a valid marker too.
_REF_MARKER_RE = re.compile(r"[\(\[]?\s*\bref\.?s?\b\s*[\)\]]?", re.IGNORECASE)

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
#
# Earlier version asked the model to quote the exact words to anchor on,
# then located that quote in the text with a plain substring search. That
# broke constantly on real scientific text: the model rarely reproduces
# special characters (α, β, en-dashes, curly quotes…) with perfect
# byte-for-byte fidelity even when told not to change a comma, so the
# substring search silently failed for EVERY point and the whole
# analysis came back empty. Numbering sentences ourselves and asking the
# model to pick sentence NUMBERS sidesteps verbatim matching entirely —
# the model only ever has to echo back small integers.

_SENTENCE_BOUNDARY_RE = re.compile(r"[.!?]\s+(?=[A-ZÁÉÍÓÚÑ0-9])")

# Common scientific-writing abbreviations that end in "." but do NOT end
# a sentence — "et al." and "Fig. 3" are the two that show up in nearly
# every biomedical paragraph. Checked case-insensitively against the
# word immediately before the period.
_ABBREVIATIONS = {
    "al", "fig", "figs", "eq", "eqs", "no", "nos", "vs", "cf", "ca",
    "approx", "sp", "spp", "var", "ref", "refs", "dr", "prof", "mr",
    "mrs", "ms", "st",
}
_WORD_BEFORE_DOT_RE = re.compile(r"(\w+)\.$")


def _split_sentences(text: str) -> list[tuple[int, int]]:
    """Return [(start, end), ...] character spans for each sentence,
    covering the whole text (no gaps dropped — a trailing span with no
    terminal punctuation is still included).

    Skips splitting right after a known abbreviation ("et al.", "Fig.",
    "e.g.", …) so "... described in Fig. 3 shows ..." doesn't get cut
    into a dangling "... described in Fig." sentence — common enough in
    scientific text that leaving it unhandled would degrade "auto" mode
    on exactly the kind of writing this feature targets."""
    spans = []
    cursor = 0
    for m in _SENTENCE_BOUNDARY_RE.finditer(text):
        split_pos = m.start() + 1  # just after the punctuation mark
        if text[m.start()] == '.':
            word = _WORD_BEFORE_DOT_RE.search(text[:split_pos])
            if word and word.group(1).lower() in _ABBREVIATIONS:
                continue
        if text[cursor:split_pos].strip():
            spans.append((cursor, split_pos))
        cursor = m.end()
    if text[cursor:].strip():
        spans.append((cursor, len(text)))
    return spans


_PLACEMENT_SYSTEM = """Eres un asistente experto en escritura científica biomédica \
(investigación de priones y enfermedades priónicas). Te doy un texto dividido en \
frases NUMERADAS (una por línea, "N: texto"). Tu única tarea es decidir qué \
números de frase contienen una afirmación concreta (dato, resultado, hallazgo \
específico) que necesitaría una cita bibliográfica que la respalde — no frases \
genéricas de transición, introducción del tema o conectores.

Identifica como máximo 15 frases, las más importantes. Si ninguna frase necesita \
cita, devuelve una lista vacía.

Responde SOLO con JSON estricto, sin explicación ni markdown:
{"sentence_numbers": [3, 7, 12]}"""


def _detect_points_ai(text: str, provider: Optional[str]) -> tuple[list[dict], dict]:
    from .llm_pool import call_llm_json_with_fallback

    diag: dict = {"sentence_count": 0, "provider_used": None, "attempts": [],
                  "raw_numbers": [], "chosen_count": 0, "out_of_range": []}

    spans = _split_sentences(text)
    diag["sentence_count"] = len(spans)
    if not spans:
        diag["reason"] = "no_sentences"
        return [], diag
    numbered = "\n".join(f"{i + 1}: {text[s:e].strip()}" for i, (s, e) in enumerate(spans))

    try:
        parsed, info = call_llm_json_with_fallback(
            providers=_provider_chain(provider),
            system=_PLACEMENT_SYSTEM, user=numbered, max_tokens=800,
        )
    except RuntimeError as exc:
        diag["reason"] = "llm_call_failed"
        diag["error"] = str(exc)
        raise RefSuggestError(
            f"No se pudo analizar el texto con ningún proveedor de IA "
            f"(Claude → GPT → Gemini probados en orden). Detalle: {exc}")  from exc

    diag["provider_used"] = info.get("provider")
    diag["attempts"] = info.get("attempts") or []

    raw_numbers = parsed.get("sentence_numbers") or []
    diag["raw_numbers"] = raw_numbers
    chosen = sorted({
        int(n) for n in raw_numbers
        if isinstance(n, (int, float)) and 1 <= int(n) <= len(spans)
    })
    diag["chosen_count"] = len(chosen)
    diag["out_of_range"] = [n for n in raw_numbers
                            if not (isinstance(n, (int, float)) and 1 <= int(n) <= len(spans))]
    if not chosen:
        diag["reason"] = "model_found_nothing" if not raw_numbers else "all_out_of_range"

    points = []
    cursor = 0
    n = 0
    for sentence_no in chosen:
        _, end = spans[sentence_no - 1]
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

    # Use only the TAIL of the claim as the search query — the text
    # right before the marker is what the citation is actually
    # attached to. Without this, a marker placed after several
    # paragraphs (nothing since the previous marker/start) would embed
    # the whole blob, diluting the query with earlier, less relevant
    # sentences instead of focusing on what's actually being cited.
    query = claim[-_CONTEXT_TAIL_CHARS:]
    result = _retrieve(query, top_k=_CANDIDATE_POOL, per_article_cap=1,
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
            "claim": p["claim"][-_CONTEXT_TAIL_CHARS:],  # same tail used for retrieval
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
            n_words = len(text.split())
            n_markers_loose = len(re.findall(r"\bref\b", text, re.IGNORECASE))
            detail = (
                f'No he encontrado ninguna marca de referencia en el texto '
                f'({n_words} palabras analizadas). Reconozco "Ref", "ref", "REF", '
                f'con o sin punto final, con o sin "s" de plural, y con o sin '
                f'paréntesis/corchetes — por ejemplo: (Ref.), Ref, [Refs], REF.'
            )
            if n_markers_loose:
                detail += (
                    f' He encontrado la palabra "ref" {n_markers_loose} '
                    f'{"vez" if n_markers_loose == 1 else "veces"} en el texto, pero '
                    f'pegada a otras palabras sin espacio o símbolo que la delimite '
                    f'como marca — revisa que quede como palabra suelta.'
                )
            else:
                detail += ' No he encontrado la palabra "ref" en ninguna forma dentro del texto.'
            detail += ' Si prefieres no añadir marcas a mano, usa el modo automático.'
            raise RefSuggestError(detail)
    else:
        points, placement_info = _detect_points_ai(text, provider)
        if not points:
            n_sent = placement_info.get("sentence_count", 0) if placement_info else 0
            reason = placement_info.get("reason") if placement_info else None
            if reason == "no_sentences":
                detail = ("No he podido dividir el texto en frases — compruebe que "
                          "tiene puntuación (puntos, signos de interrogación/exclamación).")
            elif reason == "model_found_nothing":
                prov = placement_info.get("provider_used") or "el proveedor de IA"
                detail = (
                    f'He dividido el texto en {n_sent} frase{"s" if n_sent != 1 else ""} y '
                    f'se las he pasado a {prov}, pero ha decidido que ninguna contiene una '
                    f'afirmación concreta (dato, resultado, hallazgo) que necesite respaldo '
                    f'bibliográfico — por ejemplo, un texto puramente introductorio o de '
                    f'transición, sin datos concretos, da este resultado. Si crees que sí '
                    f'debería haber encontrado algo, prueba con otro proveedor (Claude/GPT/'
                    f'Gemini) o usa el modo manual con marcas "(Ref.)".'
                )
            elif reason == "all_out_of_range":
                detail = (
                    f'La IA devolvió números de frase fuera de rango sobre un total de '
                    f'{n_sent} frases detectadas ({placement_info.get("out_of_range")}) — '
                    f'probablemente una respuesta mal formada. Vuelve a intentarlo o prueba '
                    f'con otro proveedor.'
                )
            else:
                detail = (f'He dividido el texto en {n_sent} frases pero no he podido '
                          f'identificar ningún punto que necesite cita.')
            raise RefSuggestError(detail)

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
        diagnostic = None
        if not suggestions:
            if not p["candidates"]:
                diagnostic = (
                    "La búsqueda semántica sobre la biblioteca de PrionVault no ha "
                    "encontrado NINGÚN artículo relacionado con esta frase — ni por "
                    "similitud de significado ni por coincidencia de términos. Puede "
                    "que PrionVault no tenga ningún artículo sobre este tema concreto, "
                    "o que la frase sea demasiado genérica para encontrar algo específico."
                )
            else:
                considered = ", ".join(f'"{c["title"][:70]}"' for c in p["candidates"][:5])
                diagnostic = (
                    f"La búsqueda encontró {len(p['candidates'])} artículo"
                    f"{'s' if len(p['candidates']) != 1 else ''} semánticamente cercano"
                    f"{'s' if len(p['candidates']) != 1 else ''} ({considered}), pero la IA "
                    f"consideró que ninguno respalda genuinamente esta afirmación concreta "
                    f"— no fuerza citas que no encajen de verdad."
                )
        out_points.append({
            "n": p["n"],
            "claim": p["claim"],
            "replace_start": p["replace_start"],
            "replace_end": p["replace_end"],
            "suggestions": suggestions[:_SHOWN_BY_DEFAULT],
            "more_suggestions": suggestions[_SHOWN_BY_DEFAULT:],
            "total_candidate_articles": p["total_candidate_articles"],
            "diagnostic": diagnostic,
        })

    return {
        "mode": mode,
        "text": text,
        "points": out_points,
        "truncated": truncated,
        "placement_info": placement_info,
        "explain_info": explain_info,
    }
