"""AI summary generation for PrionVault articles.

Supports three providers, each via its own SDK:
  - "anthropic"  → Claude Sonnet 4.6     (ANTHROPIC_API_KEY)
  - "openai"     → GPT-4.1               (OPENAI_API_KEY)
  - "gemini"     → Gemini 2.5 Pro        (GEMINI_API_KEY)

The prompt is provider-agnostic and produces the structured Spanish
summary that lives in `articles.summary_ai` (the Postgres trigger on
that column reindexes the full-text search vector automatically).

Each provider returns a `SummaryResult` with the same shape so the
batch worker and the per-article endpoint don't have to special-case
anything.

Pricing (USD per 1M tokens) is bundled here for cost tracking. Update
the table if the providers change list prices.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


# ── Provider catalogue ───────────────────────────────────────────────────────
PROVIDERS = {
    "anthropic": {
        "label":    "Claude Sonnet 4.6",
        "model":    "claude-sonnet-4-6",
        "env":      "ANTHROPIC_API_KEY",
        "price_in":  3.0,
        "price_out": 15.0,
    },
    "openai": {
        "label":    "GPT-4.1",
        "model":    "gpt-4.1",
        "env":      "OPENAI_API_KEY",
        "price_in":  2.5,
        "price_out": 10.0,
    },
    "gemini": {
        "label":    "Gemini 2.5 Pro",
        "model":    "gemini-2.5-pro",
        "env":      "GEMINI_API_KEY",
        "price_in":  1.25,
        "price_out": 10.0,
    },
}
DEFAULT_PROVIDER = "anthropic"
MAX_OUTPUT_TOKENS = 2400
EXTRACTED_TEXT_CHAR_LIMIT = 50_000

# Retry an empty / transient-error response this many times before
# giving up on a paper. Backoff is exponential (2 s, 4 s, 8 s)
# so a transient provider-side 503 / capacity event has ~14 s to
# clear before we bubble the failure up to the caller. That keeps
# sync per-article calls responsive while still covering most
# real-world rate-limit / overload blips.
_MAX_ATTEMPTS = 4
_BASE_BACKOFF_S = 2.0


_SYSTEM_PROMPT = """Eres un asistente científico especializado en biología \
de priones, neurodegeneración y neurociencia traslacional. Generas \
resúmenes estructurados de artículos científicos para investigadores \
y estudiantes de doctorado.

Reglas obligatorias:
- Responde SIEMPRE en español de España.
- Conserva en su forma original toda la terminología técnica y siglas: \
PrP, PrPSc, PrPC, PrPres, CJD (o ECJ), sCJD, vCJD, fCJD, iCJD, GSS, FFI, \
RT-QuIC, PMCA, RML, ME7, octarrepetido, OPRI, OPRD, gen PRNP, codón 129, \
codón 178, codón 200, M/V, V/V, M/M, α-Syn, SNCA, ATV, SNpc, AAV, \
prionoide. No traduzcas siglas, nombres de genes, nombres de modelos \
animales ni nombres de técnicas.
- Sé específico con cifras, p-valores, mutaciones, regiones cerebrales, \
anticuerpos, líneas celulares, modelos transgénicos, dosis y \
edades / tiempos de supervivencia.
- No inventes datos que no estén en el material proporcionado. Si una \
sección no se puede inferir, indícalo brevemente en lugar de rellenarla \
con generalidades.
- Tono de manuscrito científico. No uses viñetas dentro del resumen \
narrativo; sí puedes usarlas en Métodos / Resultados si los datos son \
muchos y enumerables."""


def _build_user_prompt(*, title, authors, year, journal, abstract,
                       doi, pubmed_id, extracted_text) -> str:
    """Build a provider-agnostic user prompt.

    Layout:
      - A header block with metadata so the resulting summary can be
        copy-pasted standalone (the user often takes it into PrionPacks
        / external docs where the reference info needs to travel with
        the text).
      - The article material (abstract + extracted text, truncated).
      - Output instructions: header echoed in the response, then a
        five-section structured summary in Markdown.
    """
    def _or_unknown(v, fallback):
        s = (v or "").strip() if isinstance(v, str) else (str(v) if v else "")
        return s if s else fallback

    title_s   = _or_unknown(title,    "(sin título)")
    authors_s = _or_unknown(authors,  "El texto proporcionado no indica los autores.")
    year_s    = _or_unknown(year,     "El texto proporcionado no indica el año.")
    journal_s = _or_unknown(journal,  "El texto proporcionado no indica la revista.")
    doi_s     = _or_unknown(doi,      "El texto proporcionado no incluye el DOI del artículo.")
    pmid_s    = (str(pubmed_id).strip() if pubmed_id else "")

    abstract_block = (
        f"\n\nAbstract original:\n{abstract.strip()}"
        if abstract and abstract.strip()
        else "\n\n(Abstract no disponible)"
    )

    if extracted_text and extracted_text.strip():
        truncated = extracted_text.strip()
        was_truncated = False
        if len(truncated) > EXTRACTED_TEXT_CHAR_LIMIT:
            truncated = truncated[:EXTRACTED_TEXT_CHAR_LIMIT]
            was_truncated = True
        text_block = (
            f"\n\nTexto extraído del PDF"
            f"{' (truncado a 50 k caracteres)' if was_truncated else ''}:\n{truncated}"
        )
    else:
        text_block = ("\n\n(Texto completo del PDF no disponible — "
                      "basarse en abstract + metadatos)")

    pmid_line = f"\nPMID: {pmid_s}" if pmid_s else ""

    return f"""Genera un resumen completo del siguiente artículo científico \
en español. La salida debe empezar SIEMPRE con esta cabecera bibliográfica \
exactamente en este formato y orden, sin viñetas y sin comillas, \
y a continuación un resumen estructurado en cinco secciones con \
encabezados Markdown (## ).

Cabecera obligatoria:

Título: {title_s}
Autores: {authors_s}
Revista: {journal_s}
Año: {year_s}
DOI: {doi_s}{pmid_line}

A continuación de la cabecera, deja una línea en blanco y produce el \
resumen estructurado con estas cinco secciones, en este orden, cada una \
encabezada con `## `:

## Objetivos
Qué pregunta, hipótesis o problema aborda el estudio. Incluye el contexto \
inmediato y los antecedentes relevantes que cite el propio artículo.

## Métodos
Modelos experimentales, técnicas y enfoques principales. Cita reactivos, \
líneas celulares, cohortes humanas, anticuerpos, modelos animales \
(incluyendo cepas y genotipo), dosis y tiempos.

## Resultados
Hallazgos cuantitativos y cualitativos más importantes, en orden de \
relevancia. Sé específico con cifras, porcentajes, p-valores, \
nombres de mutaciones, regiones cerebrales, días postinoculación, etc.

## Discusión
Interpretación de los autores. Comparación con la literatura previa \
citada. Limitaciones reconocidas explícitamente.

## Conclusiones e implicaciones
Mensaje principal y su relevancia para el campo de los priones / \
neurodegeneración. Implicaciones diagnósticas, terapéuticas o \
mecanísticas concretas.

Datos del artículo:
Título: {title_s}
Autores: {authors_s}
Revista: {journal_s}
Año: {year_s}
DOI: {doi_s}{pmid_line}{abstract_block}{text_block}
"""


@dataclass
class SummaryResult:
    text:           str
    model:          str
    provider:       str
    input_chars:    int
    used_full_text: bool
    elapsed_ms:     int
    tokens_in:      Optional[int] = None
    tokens_out:     Optional[int] = None
    cost_usd:       Optional[float] = None


class NotConfigured(RuntimeError):
    """Raised when the API key for the selected provider is missing."""


def _estimate_cost(provider: str, tokens_in: Optional[int],
                   tokens_out: Optional[int]) -> Optional[float]:
    p = PROVIDERS.get(provider)
    if not p or tokens_in is None or tokens_out is None:
        return None
    return round(
        (tokens_in * p["price_in"] + tokens_out * p["price_out"]) / 1_000_000,
        5,
    )


# ── Provider dispatch ────────────────────────────────────────────────────────

def generate_summary(*, title, authors=None, year=None, journal=None,
                     abstract=None, doi=None, pubmed_id=None,
                     extracted_text=None,
                     provider: str = DEFAULT_PROVIDER) -> SummaryResult:
    """Generate a summary using the requested provider. Retries up to
    _MAX_ATTEMPTS times on empty / transient errors before giving up."""
    if provider not in PROVIDERS:
        raise ValueError(f"unknown provider: {provider!r}. "
                         f"Valid: {sorted(PROVIDERS)}")

    api_key = os.getenv(PROVIDERS[provider]["env"], "").strip()
    if not api_key:
        raise NotConfigured(
            f"{PROVIDERS[provider]['env']} is not set "
            f"(needed for provider={provider})"
        )

    user_prompt = _build_user_prompt(
        title=title, authors=authors, year=year, journal=journal,
        abstract=abstract, doi=doi, pubmed_id=pubmed_id,
        extracted_text=extracted_text,
    )

    last_error: Optional[Exception] = None
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            if provider == "anthropic":
                return _call_anthropic(api_key, user_prompt, extracted_text)
            if provider == "openai":
                return _call_openai(api_key, user_prompt, extracted_text)
            if provider == "gemini":
                return _call_gemini(api_key, user_prompt, extracted_text)
        except RuntimeError as exc:
            # Empty / parse-failure responses are retriable.
            last_error = exc
            logger.warning("ai_summary[%s] attempt %d: %s",
                           provider, attempt, exc)
        except Exception as exc:
            # Network / SDK / rate-limit errors are also retriable.
            last_error = exc
            logger.warning("ai_summary[%s] attempt %d transient error: %s",
                           provider, attempt, exc)
        if attempt < _MAX_ATTEMPTS:
            time.sleep(_BASE_BACKOFF_S ** attempt)

    raise RuntimeError(
        f"{provider} failed after {_MAX_ATTEMPTS} attempts: {last_error}"
    )


# ── Anthropic ───────────────────────────────────────────────────────────────

def _call_anthropic(api_key: str, user_prompt: str,
                    extracted_text) -> SummaryResult:
    import anthropic
    client = anthropic.Anthropic(api_key=api_key)
    model = PROVIDERS["anthropic"]["model"]

    start = time.monotonic()
    message = client.messages.create(
        model=model,
        max_tokens=MAX_OUTPUT_TOKENS,
        system=_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_prompt}],
    )
    elapsed_ms = int((time.monotonic() - start) * 1000)

    text = "".join(
        block.text for block in message.content
        if getattr(block, "type", None) == "text"
    ).strip()
    if not text:
        raise RuntimeError("Claude returned an empty response")

    usage = getattr(message, "usage", None)
    tokens_in  = getattr(usage, "input_tokens",  None) if usage else None
    tokens_out = getattr(usage, "output_tokens", None) if usage else None

    return SummaryResult(
        text=text, model=model, provider="anthropic",
        input_chars=len(user_prompt),
        used_full_text=bool(extracted_text and extracted_text.strip()),
        elapsed_ms=elapsed_ms,
        tokens_in=tokens_in, tokens_out=tokens_out,
        cost_usd=_estimate_cost("anthropic", tokens_in, tokens_out),
    )


# ── OpenAI ──────────────────────────────────────────────────────────────────

def _call_openai(api_key: str, user_prompt: str,
                 extracted_text) -> SummaryResult:
    from openai import OpenAI
    client = OpenAI(api_key=api_key)
    model = PROVIDERS["openai"]["model"]

    start = time.monotonic()
    completion = client.chat.completions.create(
        model=model,
        max_tokens=MAX_OUTPUT_TOKENS,
        messages=[
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user",   "content": user_prompt},
        ],
    )
    elapsed_ms = int((time.monotonic() - start) * 1000)

    choice = completion.choices[0] if completion.choices else None
    text = (choice.message.content if choice and choice.message else "") or ""
    text = text.strip()
    if not text:
        raise RuntimeError("OpenAI returned an empty response")

    usage = getattr(completion, "usage", None)
    tokens_in  = getattr(usage, "prompt_tokens",     None) if usage else None
    tokens_out = getattr(usage, "completion_tokens", None) if usage else None

    return SummaryResult(
        text=text, model=model, provider="openai",
        input_chars=len(user_prompt),
        used_full_text=bool(extracted_text and extracted_text.strip()),
        elapsed_ms=elapsed_ms,
        tokens_in=tokens_in, tokens_out=tokens_out,
        cost_usd=_estimate_cost("openai", tokens_in, tokens_out),
    )


# ── Gemini ──────────────────────────────────────────────────────────────────

def _call_gemini(api_key: str, user_prompt: str,
                 extracted_text) -> SummaryResult:
    # Use the newer google-genai SDK; the old google-generativeai is
    # deprecated. Both APIs differ; we standardise on the new one.
    from google import genai
    from google.genai import types
    client = genai.Client(api_key=api_key)
    model = PROVIDERS["gemini"]["model"]

    start = time.monotonic()
    resp = client.models.generate_content(
        model=model,
        contents=user_prompt,
        config=types.GenerateContentConfig(
            system_instruction=_SYSTEM_PROMPT,
            max_output_tokens=MAX_OUTPUT_TOKENS,
            temperature=0.4,
        ),
    )
    elapsed_ms = int((time.monotonic() - start) * 1000)

    text = (getattr(resp, "text", "") or "").strip()
    if not text:
        raise RuntimeError("Gemini returned an empty response")

    usage = getattr(resp, "usage_metadata", None)
    tokens_in  = getattr(usage, "prompt_token_count",    None) if usage else None
    tokens_out = getattr(usage, "candidates_token_count", None) if usage else None

    return SummaryResult(
        text=text, model=model, provider="gemini",
        input_chars=len(user_prompt),
        used_full_text=bool(extracted_text and extracted_text.strip()),
        elapsed_ms=elapsed_ms,
        tokens_in=tokens_in, tokens_out=tokens_out,
        cost_usd=_estimate_cost("gemini", tokens_in, tokens_out),
    )


# ── Status helpers (used by the start endpoint to gate the modal) ──────────

def provider_status() -> dict:
    """Return availability info for each provider. Used by the modal
    to disable options whose API key is missing."""
    out = {}
    for key, p in PROVIDERS.items():
        out[key] = {
            "label":      p["label"],
            "model":      p["model"],
            "configured": bool(os.getenv(p["env"], "").strip()),
            "env":        p["env"],
            "price_in":   p["price_in"],
            "price_out":  p["price_out"],
        }
    return out
