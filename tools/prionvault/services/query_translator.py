"""Query translation for multilingual search.

Detects if a query is in Spanish and automatically translates it to English
before semantic search. This allows Spanish-speaking users to query in their
native language while the vector search operates on English terms.

Design:
  - Use Claude API to detect query language and translate if needed
  - Single API call for both detection and translation
  - Caches language detection per session (optional)
  - Preserves original query for potential result re-translation
"""
from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)


def get_claude_client():
    """Import Claude client on demand to avoid initialization side-effects."""
    from anthropic import Anthropic
    return Anthropic()


def detect_and_translate(query: str) -> tuple[str, str]:
    """Detect query language and translate Spanish queries to English.

    Args:
        query: The user's search query

    Returns:
        (processed_query, source_language) where:
        - processed_query: English query (translated if Spanish, otherwise original)
        - source_language: 'es' for Spanish, 'en' for English, 'other' for others
    """
    if not query or not query.strip():
        return query, "en"

    query = query.strip()

    try:
        client = get_claude_client()

        # Single call: detect language and translate if Spanish
        response = client.messages.create(
            model="claude-opus-4-8",
            max_tokens=500,
            messages=[
                {
                    "role": "user",
                    "content": f"""Analyze this biomedical query:

<query>{query}</query>

Do EXACTLY this:
1. Detect if the query is in Spanish (es), English (en), or other language
2. If Spanish: translate to English
3. Output format:
   LANGUAGE: [es|en|other]
   [if Spanish only]:
   TRANSLATION: <English translation>

Be concise. For biomedical terms, preserve the meaning precisely."""
                }
            ]
        )

        result = response.content[0].text.strip()

        # Parse response
        language = "en"
        translation = None

        for line in result.split("\n"):
            line = line.strip()
            if line.startswith("LANGUAGE:"):
                language = line.replace("LANGUAGE:", "").strip()
                language = language.lower()
                if language not in ("es", "en", "other"):
                    language = "en"
            elif line.startswith("TRANSLATION:"):
                translation = line.replace("TRANSLATION:", "").strip()

        # Return translated query if Spanish, otherwise original
        if language == "es" and translation:
            logger.debug(f"Translated Spanish query: {query[:50]}... → {translation[:50]}...")
            return translation, "es"
        else:
            return query, language

    except Exception as exc:
        logger.warning(f"Query translation failed: {exc}, using original query")
        return query, "en"


def should_translate_query(query: str) -> bool:
    """Quick heuristic check if query might be in Spanish (without API call).

    Used for pre-filtering before more expensive operations. Returns True
    if query contains Spanish biomedical terms or common Spanish words.
    """
    spanish_indicators = {
        # Common Spanish biomedical terms
        "proteína", "enfermedad", "toro", "hámster", "comparación",
        "diferencia", "nivel", "ganado", "vaca", "bovino", "sirio",
        "hamster", "hamsters",
        # Common Spanish words
        "el", "la", "los", "las", "de", "del", "que", "es", "en",
        "para", "por", "como", "con", "una", "un", "o", "y",
        "mediante", "mediante", "dentro", "fuera", "durante",
    }

    words = query.lower().split()
    spanish_word_count = sum(1 for w in words if any(
        ind in w for ind in spanish_indicators
    ))

    # Heuristic: if >30% of words match Spanish patterns, likely Spanish
    return spanish_word_count > max(2, len(words) * 0.2)
