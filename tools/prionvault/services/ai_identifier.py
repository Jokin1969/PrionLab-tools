"""AI-assisted bibliographic identification from PDF text.

Used by the Edit modal's "🤖 Buscar PMID con IA" button. Given the raw
text extracted from the first pages of a PDF, asks gpt-4o-mini to pull
out the article title, first-author surname and publication year. The
caller then hands those to PubMed esearch to recover the PMID.

This is intentionally a separate, narrower service from
`ai_summary.py` — we don't need full-paper context or multi-provider
support here, just a cheap, deterministic JSON extraction.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Optional, TypedDict

logger = logging.getLogger(__name__)


_MODEL = "gpt-4o-mini"
_MAX_INPUT_CHARS = 12_000  # title + authors live on page 1; no need to send more


class IdentifiedArticle(TypedDict):
    title: Optional[str]
    first_author_lastname: Optional[str]
    year: Optional[int]


class AIIdentifierError(RuntimeError):
    """Raised on configuration / upstream failures.

    `.code` mirrors the conventions used elsewhere in PrionVault so the
    route layer can map it onto an HTTP status without re-parsing strings.
    """

    def __init__(self, message: str, code: str = "UPSTREAM_ERROR") -> None:
        super().__init__(message)
        self.code = code


_SYSTEM_PROMPT = (
    "You extract bibliographic metadata from scientific PDFs. "
    "Reply ONLY with valid JSON, no markdown, no prose."
)


def _build_user_prompt(pdf_text: str) -> str:
    return (
        "Below is text extracted from the first pages of a scientific paper.\n"
        "Identify the article and reply with this exact JSON shape:\n\n"
        "{\n"
        '  "title": "the full article title, single line, no trailing period",\n'
        '  "first_author_lastname": "Surname only of the first listed author",\n'
        '  "year": 1234\n'
        "}\n\n"
        "Rules:\n"
        '- "title" must be the article\'s own title, not the journal name or running header.\n'
        '- Strip line breaks and hyphenation from PDF layout (e.g. "glyco-\\nforms" -> "glycoforms").\n'
        '- "first_author_lastname" is just the family name (e.g. "Stack", "García-López"), no initials.\n'
        '- "year" is the integer publication year. Use the article\'s own year, not Received/Accepted dates if both are present.\n'
        "- If a field cannot be determined confidently, set it to null.\n\n"
        f'PDF text:\n"""\n{pdf_text}\n"""'
    )


def identify_article_from_pdf_text(pdf_text: str) -> IdentifiedArticle:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise AIIdentifierError(
            "OpenAI no está configurado en el servidor (falta OPENAI_API_KEY)",
            code="NOT_CONFIGURED",
        )

    excerpt = (pdf_text or "").strip()
    if not excerpt:
        raise AIIdentifierError("El PDF no contiene texto extraíble", code="INVALID_INPUT")
    excerpt = excerpt[:_MAX_INPUT_CHARS]

    try:
        from openai import OpenAI
    except ImportError as exc:
        raise AIIdentifierError(
            f"La librería 'openai' no está instalada: {exc}", code="NOT_CONFIGURED",
        ) from exc

    client = OpenAI(api_key=api_key, timeout=30.0)

    try:
        completion = client.chat.completions.create(
            model=_MODEL,
            max_tokens=300,
            temperature=0,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user",   "content": _build_user_prompt(excerpt)},
            ],
        )
    except Exception as exc:
        status = getattr(exc, "status_code", None) or getattr(exc, "status", None)
        if status == 401:
            raise AIIdentifierError("Clave de OpenAI inválida", code="INVALID_KEY") from exc
        if status == 429:
            raise AIIdentifierError("OpenAI rate limit / cuota excedida", code="RATE_LIMITED") from exc
        raise AIIdentifierError(f"Llamada a OpenAI falló: {exc}", code="UPSTREAM_ERROR") from exc

    choice = completion.choices[0] if completion.choices else None
    raw = ((choice.message.content if choice and choice.message else "") or "").strip()
    if not raw:
        raise AIIdentifierError("OpenAI devolvió una respuesta vacía", code="EMPTY_RESPONSE")

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AIIdentifierError(f"OpenAI devolvió JSON inválido: {exc}", code="UPSTREAM_ERROR") from exc

    title = parsed.get("title")
    if isinstance(title, str):
        title = title.strip() or None
    else:
        title = None

    author = parsed.get("first_author_lastname")
    if isinstance(author, str):
        author = author.strip() or None
    else:
        author = None

    year_raw = parsed.get("year")
    year: Optional[int] = None
    if isinstance(year_raw, int) and 1800 < year_raw < 2100:
        year = year_raw
    elif isinstance(year_raw, str) and year_raw.strip().isdigit():
        y = int(year_raw.strip())
        if 1800 < y < 2100:
            year = y

    return IdentifiedArticle(title=title, first_author_lastname=author, year=year)
