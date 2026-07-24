"""Per-article AI chat: ask questions about a single paper.

Unlike `rag.py` (which answers over the whole library with strict
citation grounding), this module builds a focused context around ONE
article — its metadata, AI summary, indexed full text, and the prior
turns of the current conversation — and asks the selected provider to
answer as a research assistant.

Provider fallback: the user picks a primary provider (Claude by
default). If it fails for a recoverable reason (rate-limit, safety
refusal, empty response, missing key), we fall through to the next
provider in the canonical order Claude → GPT → Gemini, skipping the
one that already failed. The answer records which provider actually
served it so the UI can flag the switch.

Conversations are persisted in `prionvault_article_chat` /
`prionvault_article_chat_message` and never auto-expire — they are a
research asset the lab may mine later.
"""
from __future__ import annotations

import logging
import time
from typing import Optional

from sqlalchemy import text as _sql

from .ai_summary import PROVIDERS, DEFAULT_PROVIDER
# Reuse the battle-tested provider dispatch + failure classification
# from the RAG pipeline instead of re-implementing per-provider quirks.
from .rag import _chat, _classify_failure, _FALLBACK_KINDS, _estimate_cost

logger = logging.getLogger(__name__)

# How much of the article's indexed text to feed the model. ~4 chars per
# token → 80k chars ≈ 20k tokens, comfortably within every supported
# model's window while leaving room for summary + history + answer.
_ARTICLE_TEXT_CHAR_CAP = 80_000
# Cap the conversation history we replay so a very long thread doesn't
# crowd out the article text. Keep the most recent turns.
_HISTORY_CHAR_CAP = 12_000

_MAX_QUESTION_LEN = 4_000


_SYSTEM_PROMPT = """Eres un asistente de investigación científica \
especializado en biomedicina, priones y neurodegeneración. El usuario \
te hace preguntas sobre UN artículo científico concreto, cuyo contexto \
(metadatos, resumen y texto indexado) se te proporciona a continuación.

Reglas:
- Responde apoyándote en el contenido del artículo proporcionado. Si la \
respuesta no está en el material disponible, dilo con claridad en lugar \
de inventarla, y si procede aporta contexto general marcándolo como \
conocimiento externo al artículo.
- Sé preciso con la terminología científica y con las cifras: no \
inventes valores, nombres ni conclusiones que no aparezcan.
- Ten en cuenta las preguntas y respuestas previas de la conversación \
para dar continuidad.
- Responde en español (salvo que el usuario escriba en otro idioma), en \
tono claro y directo, con la extensión que la pregunta requiera."""


# Fallback order requested by the operator: Claude → GPT → Gemini. The
# chain always starts with the chosen provider, then appends the rest
# in that canonical order (skipping the chosen one).
_CANONICAL_ORDER = ["anthropic", "openai", "gemini"]


def _fallback_chain(primary: str) -> list[str]:
    primary = (primary or DEFAULT_PROVIDER).strip().lower()
    if primary not in PROVIDERS:
        primary = DEFAULT_PROVIDER
    return [primary] + [p for p in _CANONICAL_ORDER if p != primary]


# ── Context assembly ──────────────────────────────────────────────────────────

def _get_engine():
    from ..ingestion.queue import _get_engine as _e
    return _e()


def _fetch_article(article_id: str) -> Optional[dict]:
    eng = _get_engine()
    with eng.connect() as conn:
        row = conn.execute(_sql("""
            SELECT id::text AS id, title, authors, year, journal, doi,
                   pubmed_id, abstract, summary_ai
              FROM articles
             WHERE id = CAST(:aid AS uuid)
        """), {"aid": article_id}).mappings().first()
    return dict(row) if row else None


def _fetch_article_text(article_id: str) -> str:
    """Concatenate the article's indexed chunks (the same text used for
    vector search) up to the char cap, in reading order."""
    eng = _get_engine()
    try:
        with eng.connect() as conn:
            rows = conn.execute(_sql("""
                SELECT chunk_text
                  FROM article_chunk
                 WHERE article_id = CAST(:aid AS uuid)
                   AND source_field = 'extracted_text'
                 ORDER BY chunk_index
            """), {"aid": article_id}).all()
    except Exception as exc:
        logger.warning("article_chat: chunk fetch failed for %s: %s", article_id, exc)
        return ""
    parts: list[str] = []
    running = 0
    for (txt,) in rows:
        if not txt:
            continue
        if running + len(txt) > _ARTICLE_TEXT_CHAR_CAP:
            parts.append(txt[: max(0, _ARTICLE_TEXT_CHAR_CAP - running)])
            break
        parts.append(txt)
        running += len(txt)
    return "\n".join(parts).strip()


def _build_user_prompt(article: dict, article_text: str,
                       history: list[dict], question: str) -> str:
    meta_bits = []
    if article.get("authors"): meta_bits.append(f"Autores: {article['authors']}")
    line2 = []
    if article.get("year"):    line2.append(str(article["year"]))
    if article.get("journal"): line2.append(str(article["journal"]))
    if article.get("doi"):     line2.append(f"DOI: {article['doi']}")
    if article.get("pubmed_id"): line2.append(f"PMID: {article['pubmed_id']}")
    if line2:
        meta_bits.append(" · ".join(line2))

    sections = [
        "=== ARTÍCULO ===",
        f"Título: {article.get('title') or '(sin título)'}",
    ]
    sections.extend(meta_bits)
    if article.get("abstract"):
        sections.append(f"\nAbstract:\n{article['abstract']}")
    if article.get("summary_ai"):
        sections.append(f"\n=== RESUMEN IA ===\n{article['summary_ai']}")
    if article_text:
        sections.append(f"\n=== TEXTO DEL ARTÍCULO (extractos indexados) ===\n{article_text}")
    else:
        sections.append(
            "\n(No hay texto completo indexado para este artículo; "
            "responde a partir del título, el abstract y el resumen si existen.)"
        )

    if history:
        # Trim from the oldest end to respect the char budget.
        hist_lines: list[str] = []
        running = 0
        for m in reversed(history):
            role = "Usuario" if m["role"] == "user" else "Asistente"
            line = f"{role}: {m['content']}"
            if running + len(line) > _HISTORY_CHAR_CAP:
                break
            hist_lines.append(line)
            running += len(line)
        hist_lines.reverse()
        if hist_lines:
            sections.append("\n=== CONVERSACIÓN PREVIA ===\n" + "\n\n".join(hist_lines))

    sections.append(f"\n=== PREGUNTA ACTUAL ===\n{question}")
    return "\n".join(sections)


# ── CRUD ──────────────────────────────────────────────────────────────────────

def list_chats(article_id: str, user_id: str) -> list[dict]:
    """Return the user's conversation threads for this article, newest
    first, each with a message count and preview."""
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(_sql("""
            SELECT c.id::text                       AS id,
                   c.requested_provider             AS requested_provider,
                   c.title                          AS title,
                   c.created_at                     AS created_at,
                   c.updated_at                     AS updated_at,
                   COUNT(m.id)                      AS message_count
              FROM prionvault_article_chat c
              LEFT JOIN prionvault_article_chat_message m ON m.chat_id = c.id
             WHERE c.article_id = CAST(:aid AS uuid)
               AND c.user_id    = CAST(:uid AS uuid)
             GROUP BY c.id
             ORDER BY c.updated_at DESC
        """), {"aid": article_id, "uid": user_id}).mappings().all()
    return [_chat_row_to_dict(r) for r in rows]


def _chat_row_to_dict(r) -> dict:
    d = dict(r)
    for k in ("created_at", "updated_at"):
        if d.get(k) is not None:
            d[k] = d[k].isoformat()
    d["provider_label"] = PROVIDERS.get(
        d.get("requested_provider"), {}).get("label", d.get("requested_provider"))
    return d


def get_chat(chat_id: str, user_id: str) -> Optional[dict]:
    """Return a conversation (metadata + ordered messages) if it belongs
    to the user, else None."""
    eng = _get_engine()
    with eng.connect() as conn:
        head = conn.execute(_sql("""
            SELECT id::text AS id, article_id::text AS article_id,
                   requested_provider, title, created_at, updated_at
              FROM prionvault_article_chat
             WHERE id = CAST(:cid AS uuid)
               AND user_id = CAST(:uid AS uuid)
        """), {"cid": chat_id, "uid": user_id}).mappings().first()
        if not head:
            return None
        msgs = conn.execute(_sql("""
            SELECT role, content, provider, model, tokens_in, tokens_out,
                   cost_usd, fallback, created_at
              FROM prionvault_article_chat_message
             WHERE chat_id = CAST(:cid AS uuid)
             ORDER BY created_at, id
        """), {"cid": chat_id}).mappings().all()

    out = _chat_row_to_dict(head)
    out["messages"] = []
    for m in msgs:
        md = dict(m)
        if md.get("created_at") is not None:
            md["created_at"] = md["created_at"].isoformat()
        if md.get("cost_usd") is not None:
            md["cost_usd"] = float(md["cost_usd"])
        if md.get("provider"):
            md["provider_label"] = PROVIDERS.get(
                md["provider"], {}).get("label", md["provider"])
        out["messages"].append(md)
    return out


def create_chat(article_id: str, user_id: str, provider: str) -> str:
    provider = (provider or DEFAULT_PROVIDER).strip().lower()
    if provider not in PROVIDERS:
        provider = DEFAULT_PROVIDER
    eng = _get_engine()
    with eng.begin() as conn:
        cid = conn.execute(_sql("""
            INSERT INTO prionvault_article_chat (article_id, user_id, requested_provider)
            VALUES (CAST(:aid AS uuid), CAST(:uid AS uuid), :prov)
            RETURNING id::text
        """), {"aid": article_id, "uid": user_id, "prov": provider}).scalar()
    return cid


def delete_chat(chat_id: str, user_id: str) -> bool:
    eng = _get_engine()
    with eng.begin() as conn:
        res = conn.execute(_sql("""
            DELETE FROM prionvault_article_chat
             WHERE id = CAST(:cid AS uuid)
               AND user_id = CAST(:uid AS uuid)
        """), {"cid": chat_id, "uid": user_id})
    return (res.rowcount or 0) > 0


# ── Ask ───────────────────────────────────────────────────────────────────────

class ChatError(RuntimeError):
    """Raised when every provider in the fallback chain failed. Carries
    the per-provider attempt list for the UI."""
    def __init__(self, message: str, attempts: list[dict]):
        super().__init__(message)
        self.attempts = attempts


def ask(chat_id: str, user_id: str, question: str,
        provider: Optional[str] = None) -> dict:
    """Append the question to the thread, build the article-scoped
    context, call the provider (with Claude→GPT→Gemini fallback), store
    the answer, and return a dict describing what happened.

    Raises:
      LookupError  — chat not found / not owned by user
      ValueError   — empty question
      ChatError    — all providers failed (carries .attempts)
    """
    question = (question or "").strip()
    if not question:
        raise ValueError("La pregunta no puede estar vacía.")
    question = question[:_MAX_QUESTION_LEN]

    eng = _get_engine()
    with eng.connect() as conn:
        head = conn.execute(_sql("""
            SELECT article_id::text AS article_id, requested_provider
              FROM prionvault_article_chat
             WHERE id = CAST(:cid AS uuid) AND user_id = CAST(:uid AS uuid)
        """), {"cid": chat_id, "uid": user_id}).mappings().first()
    if not head:
        raise LookupError("chat_not_found")

    article_id = head["article_id"]
    primary = (provider or head["requested_provider"] or DEFAULT_PROVIDER).strip().lower()
    if primary not in PROVIDERS:
        primary = DEFAULT_PROVIDER

    article = _fetch_article(article_id)
    if not article:
        raise LookupError("article_not_found")

    # Load prior turns for continuity (before inserting the new question).
    existing = get_chat(chat_id, user_id)
    history = existing["messages"] if existing else []

    article_text = _fetch_article_text(article_id)
    user_prompt = _build_user_prompt(article, article_text, history, question)

    # Append the admin-maintained translation glossary so the chat obeys
    # the same fixed translations as the summaries. Never let a glossary
    # failure break the answer.
    system_prompt = _SYSTEM_PROMPT
    try:
        from .glossary import glossary_prompt_block
        system_prompt = _SYSTEM_PROMPT + glossary_prompt_block()
    except Exception:
        pass

    # Run the fallback chain.
    chain = _fallback_chain(primary)
    attempts: list[dict] = []
    answer = ""
    actual_provider = primary
    model_used = PROVIDERS[primary]["model"]
    tokens_in = tokens_out = None
    last_exc: Optional[Exception] = None
    start = time.monotonic()

    for attempt_provider in chain:
        try:
            answer, tokens_in, tokens_out, model_used = _chat(
                provider=attempt_provider,
                system=system_prompt,
                user=user_prompt,
            )
            if not answer:
                raise RuntimeError(
                    f"{PROVIDERS[attempt_provider]['label']} returned an empty response")
            actual_provider = attempt_provider
            break
        except Exception as exc:
            kind, reason = _classify_failure(exc)
            attempts.append({"provider": attempt_provider, "kind": kind, "reason": reason})
            last_exc = exc
            logger.info("article_chat fallback: %s failed (%s — %s)",
                        attempt_provider, kind, reason)
            if kind not in _FALLBACK_KINDS:
                # Unexpected error class — don't silently retry.
                raise ChatError(str(exc), attempts) from exc
            continue
    else:
        raise ChatError(
            str(last_exc) if last_exc else "all providers failed", attempts)

    elapsed_ms = int((time.monotonic() - start) * 1000)
    cost = _estimate_cost(actual_provider, tokens_in, tokens_out)

    # `attempts` currently holds only FAILED providers. The one that
    # succeeded is `actual_provider`; keep the failed list as fallback
    # metadata (empty when the primary answered first try).
    fallback_meta = [a for a in attempts if a["provider"] != actual_provider]

    # Persist both messages + bump the thread. Derive a title from the
    # first question if the thread has none yet.
    import json as _json
    with eng.begin() as conn:
        conn.execute(_sql("""
            INSERT INTO prionvault_article_chat_message (chat_id, role, content)
            VALUES (CAST(:cid AS uuid), 'user', :content)
        """), {"cid": chat_id, "content": question})
        conn.execute(_sql("""
            INSERT INTO prionvault_article_chat_message
                (chat_id, role, content, provider, model,
                 tokens_in, tokens_out, cost_usd, fallback)
            VALUES (CAST(:cid AS uuid), 'assistant', :content, :prov, :model,
                    :tin, :tout, :cost, CAST(:fb AS jsonb))
        """), {
            "cid": chat_id, "content": answer, "prov": actual_provider,
            "model": model_used, "tin": tokens_in, "tout": tokens_out,
            "cost": cost,
            "fb": _json.dumps(fallback_meta) if fallback_meta else None,
        })
        conn.execute(_sql("""
            UPDATE prionvault_article_chat
               SET updated_at = NOW(),
                   title = COALESCE(title, :title)
             WHERE id = CAST(:cid AS uuid)
        """), {"cid": chat_id, "title": question[:120]})

    return {
        "answer":             answer,
        "requested_provider": primary,
        "actual_provider":    actual_provider,
        "provider_label":     PROVIDERS.get(actual_provider, {}).get("label", actual_provider),
        "model":              model_used,
        "fallback":           fallback_meta,
        "switched":           actual_provider != primary,
        "tokens_in":          tokens_in,
        "tokens_out":         tokens_out,
        "cost_usd":           cost,
        "elapsed_ms":         elapsed_ms,
    }
