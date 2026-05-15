"""AI summary generation for PrionVault articles.

Calls Claude (Sonnet 4.6) with the article metadata and — when available —
the full extracted text of the PDF, and returns a structured Spanish summary
suitable for storing in `articles.summary_ai`. The Postgres trigger on the
`articles` table picks the new value up automatically and reindexes the
full-text search vector, so the summary becomes searchable the moment it is
saved.

Cost rough budget (Sonnet 4.6 pricing as of late 2025):
  - Input  $3 / 1M tokens
  - Output $15 / 1M tokens
  - With extracted_text truncated to ~50 k chars (~12 k tokens) the worst
    case is ~$0.05–0.10 per article. With abstract only, ~$0.005.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


MODEL = "claude-sonnet-4-6"
MAX_OUTPUT_TOKENS = 1500
# Hard ceiling on the extracted-text payload so a single 200-page review
# article doesn't quietly blow the budget. ~50 k chars ≈ 12 k tokens.
EXTRACTED_TEXT_CHAR_LIMIT = 50_000

_SYSTEM_PROMPT = """Eres un asistente especializado en literatura científica biomédica, \
con experiencia en priones y neurodegeneración. Tu tarea es generar resúmenes \
estructurados de artículos científicos para investigadores y estudiantes de doctorado.

Responde SIEMPRE en español, con terminología científica precisa. Sé conciso y \
factual; no inventes datos que no estén en el material proporcionado. Si una \
sección no se puede inferir del material, indícalo brevemente en lugar de \
rellenarla con generalidades."""


def _build_user_prompt(*, title, authors, year, journal, abstract,
                       doi, pubmed_id, extracted_text) -> str:
    meta_parts = [f"Título: {title or '—'}"]
    if authors:   meta_parts.append(f"Autores: {authors}")
    if year:      meta_parts.append(f"Año: {year}")
    if journal:   meta_parts.append(f"Revista: {journal}")
    if doi:       meta_parts.append(f"DOI: {doi}")
    if pubmed_id: meta_parts.append(f"PMID: {pubmed_id}")
    meta_block = "\n".join(meta_parts)

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
            f"{' (truncado)' if was_truncated else ''}:\n{truncated}"
        )
    else:
        text_block = "\n\n(Texto completo del PDF no disponible — basarse en abstract + metadatos)"

    return f"""Resume el siguiente artículo científico en aproximadamente 400-500 palabras, \
estructurado en cinco secciones claramente diferenciadas usando encabezados Markdown:

## Objetivos
¿Qué pregunta, hipótesis o problema aborda el estudio? Contexto inmediato.

## Métodos
Modelos experimentales, técnicas y enfoques principales. Cita reactivos, líneas \
celulares, animales o cohortes humanas relevantes.

## Resultados
Hallazgos cuantitativos y cualitativos más importantes, en orden de relevancia.

## Discusión
Interpretación de los autores, limitaciones reconocidas y comparación con la \
literatura previa cuando aparezca en el texto.

## Conclusiones e implicaciones
Mensaje principal y su relevancia para el campo de los priones / neurodegeneración \
si aplica.

Datos del artículo:
{meta_block}{abstract_block}{text_block}
"""


@dataclass
class SummaryResult:
    text:        str
    model:       str
    input_chars: int       # chars sent to the model (after truncation)
    used_full_text: bool   # True if extracted_text was used, False if only abstract
    elapsed_ms:  int
    tokens_in:   Optional[int] = None
    tokens_out:  Optional[int] = None
    cost_usd:    Optional[float] = None


# Approximate USD/1M token prices — kept here so we don't depend on an env-var
# to compute cost tracking. Adjust if Anthropic changes pricing.
_PRICE_PER_M_TOKENS = {
    "claude-sonnet-4-6": {"in": 3.0, "out": 15.0},
    "claude-opus-4-7":   {"in": 15.0, "out": 75.0},
}


def _estimate_cost(model: str, tokens_in: Optional[int],
                   tokens_out: Optional[int]) -> Optional[float]:
    price = _PRICE_PER_M_TOKENS.get(model)
    if not price or tokens_in is None or tokens_out is None:
        return None
    return round((tokens_in * price["in"] + tokens_out * price["out"]) / 1_000_000, 5)


class NotConfigured(RuntimeError):
    """Raised when ANTHROPIC_API_KEY is not set."""


def generate_summary(*, title, authors=None, year=None, journal=None,
                     abstract=None, doi=None, pubmed_id=None,
                     extracted_text=None) -> SummaryResult:
    """Call Claude and return the structured summary text + usage info.

    Raises NotConfigured if ANTHROPIC_API_KEY is missing; re-raises any
    network / API error from the SDK so the caller can decide what to do.
    """
    api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        raise NotConfigured("ANTHROPIC_API_KEY is not set")

    import anthropic
    client = anthropic.Anthropic(api_key=api_key)

    user_prompt = _build_user_prompt(
        title=title, authors=authors, year=year, journal=journal,
        abstract=abstract, doi=doi, pubmed_id=pubmed_id,
        extracted_text=extracted_text,
    )

    start = time.monotonic()
    message = client.messages.create(
        model=MODEL,
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
        text=text,
        model=MODEL,
        input_chars=len(user_prompt),
        used_full_text=bool(extracted_text and extracted_text.strip()),
        elapsed_ms=elapsed_ms,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cost_usd=_estimate_cost(MODEL, tokens_in, tokens_out),
    )
