"""Translation glossary shared by AI summaries and article chat.

An admin pins the correct Spanish rendering for terms the models
mistranslate (the canonical case: "bank vole" → "topillo rojo", not
"musaraña de banco"). `glossary_prompt_block()` renders the active
rules into a mandatory instruction block that gets injected into every
summary / chat system prompt.

The prompt block is cached in-process with a short TTL so a summary
batch of hundreds of papers doesn't hit the DB once per paper; edits
made through the admin modal show up within `_CACHE_TTL_S` seconds.
"""
from __future__ import annotations

import logging
import time as _time
from typing import Optional

from sqlalchemy import text as _sql

logger = logging.getLogger(__name__)


def _get_engine():
    from ..ingestion.queue import _get_engine as _e
    return _e()


# ── CRUD ──────────────────────────────────────────────────────────────────────

def list_entries() -> list[dict]:
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(_sql("""
            SELECT id::text AS id, source_term, target_term, note,
                   created_at, updated_at
              FROM prionvault_translation_glossary
             ORDER BY LOWER(source_term)
        """)).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        for k in ("created_at", "updated_at"):
            if d.get(k) is not None:
                d[k] = d[k].isoformat()
        out.append(d)
    return out


def add_entry(source_term: str, target_term: str,
              note: Optional[str] = None,
              created_by: Optional[str] = None) -> dict:
    """Insert a rule. Raises ValueError on empty fields or a duplicate
    source term."""
    source_term = (source_term or "").strip()
    target_term = (target_term or "").strip()
    note = (note or "").strip() or None
    if not source_term or not target_term:
        raise ValueError("El término de origen y el de destino son obligatorios.")

    eng = _get_engine()
    try:
        with eng.begin() as conn:
            row = conn.execute(_sql("""
                INSERT INTO prionvault_translation_glossary
                    (source_term, target_term, note, created_by)
                VALUES (:s, :t, :n, CAST(:u AS uuid))
                RETURNING id::text
            """), {"s": source_term, "t": target_term, "n": note,
                   "u": created_by}).scalar()
    except Exception as exc:
        if "pv_glossary_source_lower_idx" in str(exc) or "duplicate" in str(exc).lower():
            raise ValueError(f"Ya existe una regla para «{source_term}».") from exc
        raise
    _invalidate_cache()
    return {"id": row, "source_term": source_term,
            "target_term": target_term, "note": note}


def update_entry(entry_id: str, source_term: str, target_term: str,
                 note: Optional[str] = None) -> bool:
    source_term = (source_term or "").strip()
    target_term = (target_term or "").strip()
    note = (note or "").strip() or None
    if not source_term or not target_term:
        raise ValueError("El término de origen y el de destino son obligatorios.")
    eng = _get_engine()
    try:
        with eng.begin() as conn:
            res = conn.execute(_sql("""
                UPDATE prionvault_translation_glossary
                   SET source_term = :s, target_term = :t, note = :n,
                       updated_at = NOW()
                 WHERE id = CAST(:id AS uuid)
            """), {"s": source_term, "t": target_term, "n": note, "id": entry_id})
    except Exception as exc:
        if "pv_glossary_source_lower_idx" in str(exc) or "duplicate" in str(exc).lower():
            raise ValueError(f"Ya existe otra regla para «{source_term}».") from exc
        raise
    _invalidate_cache()
    return (res.rowcount or 0) > 0


def delete_entry(entry_id: str) -> bool:
    eng = _get_engine()
    with eng.begin() as conn:
        res = conn.execute(_sql("""
            DELETE FROM prionvault_translation_glossary
             WHERE id = CAST(:id AS uuid)
        """), {"id": entry_id})
    _invalidate_cache()
    return (res.rowcount or 0) > 0


# ── Prompt block (cached) ─────────────────────────────────────────────────────

_CACHE_TTL_S = 60.0
_cache_block: Optional[str] = None
_cache_time: float = 0.0


def _invalidate_cache() -> None:
    global _cache_block, _cache_time
    _cache_block = None
    _cache_time = 0.0


def glossary_prompt_block() -> str:
    """Return a system-prompt fragment enforcing the glossary, or "" when
    there are no rules. Cached for _CACHE_TTL_S seconds."""
    global _cache_block, _cache_time
    now = _time.monotonic()
    if _cache_block is not None and (now - _cache_time) < _CACHE_TTL_S:
        return _cache_block

    block = ""
    try:
        eng = _get_engine()
        with eng.connect() as conn:
            rows = conn.execute(_sql("""
                SELECT source_term, target_term, note
                  FROM prionvault_translation_glossary
                 ORDER BY LOWER(source_term)
            """)).all()
        if rows:
            lines = []
            for source, target, note in rows:
                line = f'- «{source}» → «{target}»'
                if note:
                    line += f' ({note})'
                lines.append(line)
            block = (
                "\n\nGLOSARIO DE TRADUCCIÓN OBLIGATORIO:\n"
                "Cuando traduzcas el material al español, usa SIEMPRE estas "
                "traducciones exactas. Tienen prioridad absoluta sobre "
                "cualquier otra opción, aunque te parezca más natural otra:\n"
                + "\n".join(lines)
            )
    except Exception as exc:
        # Never let a glossary problem break summary/chat generation.
        logger.warning("glossary: could not build prompt block: %s", exc)
        block = ""

    _cache_block = block
    _cache_time = now
    return block
