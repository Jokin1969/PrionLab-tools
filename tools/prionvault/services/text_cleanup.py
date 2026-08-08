"""Tidy up bibliographic strings coming from CrossRef / PubMed.

CrossRef ships titles and abstracts as JATS XML fragments, so we
routinely get raw tags like ``<jats:sup>2+</jats:sup>`` or HTML
entities like ``Mu&ntilde;oz`` straight into the DB. PubMed is
cleaner but still occasionally encodes accented characters as
entities.

This module centralises the cleanup logic so it runs at every
ingest path AND can be replayed retroactively over rows that already
exist.

Design notes:
* For super- and subscript tags whose body is purely digits / sign
  characters we transliterate to the Unicode codepoints (²⁺, ₂, …),
  which render fine in any font without any markup on top.
* Tags whose body is more complex (a variable name, a footnote
  marker, etc.) are simply stripped — the readable text survives but
  the typographic hint is lost; that beats showing literal HTML.
* Entities are decoded BEFORE tag handling so numeric / hex
  references inside sup / sub blocks land in the translation table.
"""
import html
import re
from typing import Optional

# Unicode super- and subscript maps. Built from the spans Wikipedia
# documents as having full coverage in modern fonts.
_SUP_MAP = str.maketrans({
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
    "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
    "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
    "n": "ⁿ", "i": "ⁱ",
})
_SUB_MAP = str.maketrans({
    "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
    "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
    "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
})

_SUP_RE = re.compile(
    r"<(?:jats:)?sup\b[^>]*>(.*?)</(?:jats:)?sup>",
    re.IGNORECASE | re.DOTALL,
)
_SUB_RE = re.compile(
    r"<(?:jats:)?sub\b[^>]*>(.*?)</(?:jats:)?sub>",
    re.IGNORECASE | re.DOTALL,
)
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE  = re.compile(r"\s+")


def clean_metadata_text(s: Optional[str]) -> Optional[str]:
    """Decode entities, transliterate sup/sub, strip other tags.

    Idempotent: a previously-cleaned string passes through unchanged
    (no entities, no tags, whitespace already normalised).
    """
    if not s or not isinstance(s, str):
        return s
    # 1. Decode HTML entities (&amp; → &, &aacute; → á, &#225; → á, …).
    s = html.unescape(s)
    # 2. Sup/sub → Unicode where mappable; otherwise the inner text.
    s = _SUP_RE.sub(lambda m: m.group(1).translate(_SUP_MAP), s)
    s = _SUB_RE.sub(lambda m: m.group(1).translate(_SUB_MAP), s)
    # 3. Strip any remaining inline tags but keep their text content.
    s = _TAG_RE.sub("", s)
    # 4. Collapse whitespace and trim.
    s = _WS_RE.sub(" ", s).strip()
    return s or None
