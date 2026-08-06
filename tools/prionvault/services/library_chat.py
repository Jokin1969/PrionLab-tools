"""Library chat — persistent, memory-capable chat over the whole library.

The old "AI search" (rag.py) answered strictly from retrieved PrionVault
fragments and refused to say anything else. This is the same retrieval
pipeline (hybrid vector + BM25, optional rerank — see
embeddings/retriever.search) feeding a DIFFERENT kind of answer: the
model is explicitly allowed to add its own general knowledge, as long
as it clearly labels, claim by claim, whether something comes from
PrionVault or from what it already knows — neither source is favoured,
PrionVault material is just more convenient when it's there.

Conversations persist forever (prionvault_library_chat /
_message, never expired — same posture as prionvault_article_chat) and
are themselves searchable: every message gets embedded the same way an
article chunk does, so "what did we discuss about X in March" works via
the same hybrid retrieval idea, just pointed at messages instead of
chunks.
"""
from __future__ import annotations

import logging
import time
from typing import Optional

from sqlalchemy import text as _sql

from .ai_summary import PROVIDERS, DEFAULT_PROVIDER
from .rag import _chat, _classify_failure, _FALLBACK_KINDS, _estimate_cost, _parse_cited_numbers
from ..embeddings.retriever import search as _retrieve, _bm25_or_query

logger = logging.getLogger(__name__)

_HISTORY_CHAR_CAP = 16_000
_MAX_QUESTION_LEN = 4_000
_CANONICAL_ORDER = ["anthropic", "openai", "gemini"]


_SYSTEM_PROMPT = """Eres el asistente de investigación de PrionLab, especializado \
en priones, neurodegeneración y biomedicina en general. Conversas de forma \
continuada con un investigador que puede preguntarte cualquier cosa: sobre la \
literatura que tiene en su biblioteca PrionVault, sobre ciencia en general, o \
ambas cosas mezcladas.

Se te proporciona, cuando existe, un bloque de FRAGMENTOS recuperados de \
PrionVault (artículos, resúmenes generados por IA, notas del investigador) \
relevantes para la pregunta actual.

Reglas de atribución — MUY IMPORTANTES:
- Tienes total libertad para responder combinando lo que encuentres en los \
fragmentos de PrionVault con tu propio conocimiento general. Ninguna de las \
dos fuentes tiene prioridad sobre la otra: usa la que mejor responda a la \
pregunta. Que la información esté en PrionVault es solo una comodidad (ya \
está verificada, indexada y citable), no un motivo para preferirla.
- Deja SIEMPRE claro, para cada afirmación relevante, de dónde viene: usa la \
notación [N] (fragmento N de PrionVault) para lo que se apoye en el material \
proporcionado, y la etiqueta (conocimiento general) para lo que aportes por tu \
cuenta. Una misma frase puede combinar ambas si corresponde.
- No inventes datos, cifras ni citas de PrionVault que no estén en los \
fragmentos — lo que no venga de allí, sácalo de tu conocimiento general y \
etiquétalo como tal en vez de fingir que es de la biblioteca.
- Ten en cuenta la conversación previa para dar continuidad.
- Responde en español (salvo que te escriban en otro idioma), en tono claro \
y directo, con la extensión que la pregunta requiera.

NOTAS DEL INVESTIGADOR Y CHATS PREVIOS EN LOS FRAGMENTOS — LÉELOS SIEMPRE:
Algunos fragmentos van etiquetados como "NOTA DEL INVESTIGADOR" o "Conversación \
previa del chat de este artículo" en vez de "Extracto del PDF" / "Abstract" / \
"Resumen IA". Son anotaciones que el propio investigador escribió a mano sobre \
ese artículo — a menudo contienen justo lo que un extracto de PDF no dice: \
sinónimos, nomenclaturas alternativas (p. ej. el nombre interno de una línea de \
ratón transgénico frente a su notación genética formal), o una referencia \
cruzada a otro artículo relacionado. Trátalas como una pista directa, no como \
texto secundario:
- Antes de concluir que algo "no está en PrionVault" o "no consta", repasa el \
texto COMPLETO de cada fragmento recuperado, notas incluidas — no te quedes solo \
con el "Extracto"/"Resumen IA" si también hay una nota o conversación adjunta.
- Si una nota menciona otro artículo, autor o DOI relacionado con la pregunta, \
dilo explícitamente en tu respuesta aunque ese artículo en concreto no haya \
salido como fragmento independiente — es la pista que el investigador dejó para \
sí mismo, precisamente para este tipo de búsqueda.
- Si sigues sin encontrar algo tras revisar notas y conversaciones incluidas, \
pide un DOI/autor/año aproximado en vez de darlo por inexistente sin más.
- Una nota es una PISTA fiable, no una fuente que sustituya la verificación: si \
hace una afirmación factual concreta (p. ej. "este es el primer artículo que \
menciona X") y el artículo que cita también aparece entre los fragmentos — como \
Extracto del PDF, Abstract o Resumen IA, no solo como nota — contrasta la \
afirmación contra ese texto antes de darla por buena, y dilo: "confirmado en el \
extracto del PDF [N]" o, si el artículo referenciado NO viene con su propio \
texto en los fragmentos, dilo también ("la nota lo indica, pero no tengo el \
texto del artículo citado entre los fragmentos para contrastarlo directamente"). \
No presentes una afirmación de una nota como un hecho verificado si no la has \
podido cruzar con el contenido real del artículo."""


def _get_engine():
    from ..ingestion.queue import _get_engine as _e
    return _e()


def _fallback_chain(primary: str) -> list[str]:
    primary = (primary or DEFAULT_PROVIDER).strip().lower()
    if primary not in PROVIDERS:
        primary = DEFAULT_PROVIDER
    return [primary] + [p for p in _CANONICAL_ORDER if p != primary]


# ── Context assembly ─────────────────────────────────────────────────────────

def _build_pv_context(question: str, viewer_id: Optional[str]):
    """Hybrid-retrieve PrionVault fragments for this question. Returns
    (context_block: str, citations: list[dict]) — empty when retrieval
    finds nothing or embeddings aren't configured."""
    try:
        # A little extra headroom (was top_k=12/cap=2) so a curated note/
        # chat fragment (see retriever._is_curated) has room to survive
        # alongside the topically-relevant PDF chunks, not compete for
        # one of only two slots on its article.
        result = _retrieve(question, top_k=16, per_article_cap=3,
                           rerank=True, hybrid=True, viewer_id=viewer_id)
    except Exception as exc:
        logger.warning("library_chat: retrieval failed: %s", exc)
        return "", []

    from .rag import _build_context
    if not result.raw_chunks:
        return "", []
    context_block, citations = _build_context(result.raw_chunks, result.articles)
    cite_dicts = [{
        "n": c.n, "article_id": c.article_id, "title": c.title,
        "authors": c.authors, "year": c.year, "journal": c.journal,
        "doi": c.doi, "pubmed_id": c.pubmed_id, "has_pdf": c.has_pdf,
    } for c in citations]
    return context_block, cite_dicts


_CITED_CONTEXT_CHAR_CAP = 8_000
_MAX_CITED_PAIRS = 15


def _build_cited_context_block(cited_context: Optional[list[dict]]) -> str:
    """Render user-picked Q&A pairs brought in from OTHER conversations
    (the "Usar aquí" feature). Kept in its own clearly-labeled section,
    separate from the current thread's own history, so the model (and
    the transcript) never confuses "what we already discussed here"
    with "what the user is importing from elsewhere"."""
    if not cited_context:
        return ""
    pairs = cited_context[:_MAX_CITED_PAIRS]
    lines: list[str] = []
    running = 0
    for p in pairs:
        q = (p.get("question") or "").strip()
        a = (p.get("answer") or "").strip()
        src = (p.get("source_title") or "").strip()
        if not q and not a:
            continue
        block = (f"[De «{src or 'otra conversación'}»]\n"
                 f"Usuario: {q}\nAsistente: {a}")
        if running + len(block) > _CITED_CONTEXT_CHAR_CAP:
            break
        lines.append(block)
        running += len(block)
    if not lines:
        return ""
    return "\n=== CONTEXTO CITADO DE OTRAS CONVERSACIONES (el usuario lo trajo aquí a propósito) ===\n" + \
        "\n\n".join(lines)


def _build_user_prompt(context_block: str, history: list[dict], question: str,
                       cited_context: Optional[list[dict]] = None) -> str:
    sections = []
    if context_block:
        sections.append("=== FRAGMENTOS DE PRIONVAULT (usa [N] para citarlos) ===\n" + context_block)
    else:
        sections.append(
            "(No se ha encontrado material relevante en PrionVault para esta "
            "pregunta — responde con tu conocimiento general, etiquetándolo "
            "como tal.)"
        )

    cited_block = _build_cited_context_block(cited_context)
    if cited_block:
        sections.append(cited_block)

    if history:
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


def _embed_message_async(message_id: int, content: str) -> None:
    """Best-effort: embed a stored message so it's findable later via
    search_chats(). Never lets an embedding failure affect the chat
    response — this always runs AFTER the message is already saved."""
    try:
        from ..embeddings.embedder import embed_texts
        result = embed_texts([content[:8000]], input_type="document")
        if not result.embeddings:
            return
        vec = result.embeddings[0]
        vec_literal = "[" + ",".join(f"{x:.7f}" for x in vec) + "]"
        eng = _get_engine()
        with eng.begin() as conn:
            conn.execute(_sql("""
                UPDATE prionvault_library_chat_message
                   SET embedding = (:emb)::vector
                 WHERE id = :id
            """), {"emb": vec_literal, "id": message_id})
    except Exception as exc:
        logger.warning("library_chat: embed message %s failed: %s", message_id, exc)


# ── CRUD ─────────────────────────────────────────────────────────────────────

def _chat_row_to_dict(r) -> dict:
    d = dict(r)
    for k in ("created_at", "updated_at"):
        if d.get(k) is not None:
            d[k] = d[k].isoformat()
    d["provider_label"] = PROVIDERS.get(
        d.get("requested_provider"), {}).get("label", d.get("requested_provider"))
    return d


def _list_chats_conn(conn, user_id: str) -> list[dict]:
    rows = conn.execute(_sql("""
        SELECT c.id::text AS id, c.requested_provider, c.title,
               c.created_at, c.updated_at, COUNT(m.id) AS message_count
          FROM prionvault_library_chat c
          LEFT JOIN prionvault_library_chat_message m ON m.chat_id = c.id
         WHERE c.user_id = CAST(:uid AS uuid)
         GROUP BY c.id
         ORDER BY c.updated_at DESC
    """), {"uid": user_id}).mappings().all()
    return [_chat_row_to_dict(r) for r in rows]


def list_chats(user_id: str) -> list[dict]:
    eng = _get_engine()
    with eng.connect() as conn:
        return _list_chats_conn(conn, user_id)


def create_chat(user_id: str, provider: str) -> str:
    provider = (provider or DEFAULT_PROVIDER).strip().lower()
    if provider not in PROVIDERS:
        provider = DEFAULT_PROVIDER
    eng = _get_engine()
    with eng.begin() as conn:
        cid = conn.execute(_sql("""
            INSERT INTO prionvault_library_chat (user_id, requested_provider)
            VALUES (CAST(:uid AS uuid), :prov)
            RETURNING id::text
        """), {"uid": user_id, "prov": provider}).scalar()
    return cid


_DEFAULT_MESSAGE_PAIRS = 25  # 50 messages — recent context is what actually matters
                             # for continuity; older turns are one click away (full=True).


def get_chat(chat_id: str, user_id: str, limit_pairs: Optional[int] = _DEFAULT_MESSAGE_PAIRS) -> Optional[dict]:
    """Conversations never expire (see module docstring), so a chat used
    heavily over months can accumulate hundreds of messages — each with
    its own citations JSON (a dozen full article metadata dicts).
    Re-fetching and re-rendering ALL of that every time the modal opens
    was the actual cause of multi-second opens: a big payload over the
    wire plus a big DOM build, not a slow query. limit_pairs=None (or
    the /report route's full=1) still fetches everything when it's
    actually needed."""
    eng = _get_engine()
    with eng.connect() as conn:
        return _get_chat_conn(conn, chat_id, user_id, limit_pairs)


def _get_chat_conn(conn, chat_id: str, user_id: str,
                   limit_pairs: Optional[int] = _DEFAULT_MESSAGE_PAIRS) -> Optional[dict]:
    head = conn.execute(_sql("""
        SELECT id::text AS id, requested_provider, title, created_at, updated_at
          FROM prionvault_library_chat
         WHERE id = CAST(:cid AS uuid) AND user_id = CAST(:uid AS uuid)
    """), {"cid": chat_id, "uid": user_id}).mappings().first()
    if not head:
        return None
    total = conn.execute(_sql("""
        SELECT COUNT(*) FROM prionvault_library_chat_message
         WHERE chat_id = CAST(:cid AS uuid)
    """), {"cid": chat_id}).scalar() or 0

    if limit_pairs is not None:
        msgs = conn.execute(_sql("""
            SELECT * FROM (
                SELECT id, role, content, provider, model, tokens_in, tokens_out,
                       cost_usd, fallback, cited_article_ids, citations, created_at
                  FROM prionvault_library_chat_message
                 WHERE chat_id = CAST(:cid AS uuid)
                 ORDER BY created_at DESC, id DESC
                 LIMIT :lim
            ) recent ORDER BY created_at, id
        """), {"cid": chat_id, "lim": limit_pairs * 2}).mappings().all()
    else:
        msgs = conn.execute(_sql("""
            SELECT id, role, content, provider, model, tokens_in, tokens_out,
                   cost_usd, fallback, cited_article_ids, citations, created_at
              FROM prionvault_library_chat_message
             WHERE chat_id = CAST(:cid AS uuid)
             ORDER BY created_at, id
        """), {"cid": chat_id}).mappings().all()

    out = _chat_row_to_dict(head)
    out["total_messages"] = total
    out["truncated"] = total > len(msgs)
    out["messages"] = []
    for m in msgs:
        md = dict(m)
        if md.get("created_at") is not None:
            md["created_at"] = md["created_at"].isoformat()
        if md.get("cost_usd") is not None:
            md["cost_usd"] = float(md["cost_usd"])
        if md.get("cited_article_ids"):
            md["cited_article_ids"] = [str(x) for x in md["cited_article_ids"]]
        if md.get("provider"):
            md["provider_label"] = PROVIDERS.get(md["provider"], {}).get("label", md["provider"])
        out["messages"].append(md)
    return out


def open_view(user_id: str, chat_id: Optional[str] = None) -> dict:
    """Everything the "open the chat modal" flow needs, in ONE database
    connection / ONE HTTP round trip instead of two sequential ones
    (list, then fetch-the-chat) — that second network round trip (auth,
    routing, connection acquisition) was adding real wall-clock time on
    top of the query cost itself, on every single open. Mirrors exactly
    what the frontend used to do with loadChats() + openChat()."""
    eng = _get_engine()
    with eng.connect() as conn:
        chats = _list_chats_conn(conn, user_id)
        target_id = chat_id or (chats[0]["id"] if chats else None)
        current = _get_chat_conn(conn, target_id, user_id) if target_id else None
    return {"chats": chats, "current": current}


def delete_message_pair(chat_id: str, user_id: str, user_message_id: int) -> bool:
    """Delete one question + its answer from a conversation — the
    trash icon on each user bubble. `user_message_id` must be a 'user'
    role message; the very next message in the thread is deleted
    alongside it if (and only if) it's the assistant's reply, so a
    trailing unanswered question doesn't take out an unrelated turn."""
    eng = _get_engine()
    with eng.connect() as conn:
        owned = conn.execute(_sql("""
            SELECT 1 FROM prionvault_library_chat
             WHERE id = CAST(:cid AS uuid) AND user_id = CAST(:uid AS uuid)
        """), {"cid": chat_id, "uid": user_id}).first()
        if not owned:
            return False
        rows = conn.execute(_sql("""
            SELECT id, role FROM prionvault_library_chat_message
             WHERE chat_id = CAST(:cid AS uuid)
             ORDER BY created_at, id
        """), {"cid": chat_id}).all()

    ids = [r[0] for r in rows]
    try:
        idx = ids.index(int(user_message_id))
    except (ValueError, TypeError):
        return False
    if rows[idx][1] != "user":
        return False
    to_delete = [ids[idx]]
    if idx + 1 < len(rows) and rows[idx + 1][1] == "assistant":
        to_delete.append(ids[idx + 1])

    eng = _get_engine()
    with eng.begin() as conn:
        conn.execute(_sql("""
            DELETE FROM prionvault_library_chat_message WHERE id = ANY(:ids)
        """), {"ids": to_delete})
    return True


def delete_chat(chat_id: str, user_id: str) -> bool:
    eng = _get_engine()
    with eng.begin() as conn:
        res = conn.execute(_sql("""
            DELETE FROM prionvault_library_chat
             WHERE id = CAST(:cid AS uuid) AND user_id = CAST(:uid AS uuid)
        """), {"cid": chat_id, "uid": user_id})
    return (res.rowcount or 0) > 0


class ChatError(RuntimeError):
    def __init__(self, message: str, attempts: list[dict]):
        super().__init__(message)
        self.attempts = attempts


def ask(chat_id: str, user_id: str, question: str, provider: Optional[str] = None,
       cited_context: Optional[list[dict]] = None) -> dict:
    question = (question or "").strip()
    if not question:
        raise ValueError("La pregunta no puede estar vacía.")
    question = question[:_MAX_QUESTION_LEN]

    eng = _get_engine()
    with eng.connect() as conn:
        head = conn.execute(_sql("""
            SELECT requested_provider FROM prionvault_library_chat
             WHERE id = CAST(:cid AS uuid) AND user_id = CAST(:uid AS uuid)
        """), {"cid": chat_id, "uid": user_id}).mappings().first()
    if not head:
        raise LookupError("chat_not_found")

    primary = (provider or head["requested_provider"] or DEFAULT_PROVIDER).strip().lower()
    if primary not in PROVIDERS:
        primary = DEFAULT_PROVIDER

    existing = get_chat(chat_id, user_id)
    history = existing["messages"] if existing else []

    retrieval_start = time.monotonic()
    context_block, citations = _build_pv_context(question, user_id)
    retrieval_ms = int((time.monotonic() - retrieval_start) * 1000)

    user_prompt = _build_user_prompt(context_block, history, question, cited_context)

    system_prompt = _SYSTEM_PROMPT
    try:
        from . import glossary_manager
        system_prompt = _SYSTEM_PROMPT + glossary_manager.prompt_block()
    except Exception:
        pass

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
                provider=attempt_provider, system=system_prompt, user=user_prompt)
            if not answer:
                raise RuntimeError(f"{PROVIDERS[attempt_provider]['label']} returned an empty response")
            actual_provider = attempt_provider
            break
        except Exception as exc:
            kind, reason = _classify_failure(exc)
            attempts.append({"provider": attempt_provider, "kind": kind, "reason": reason})
            last_exc = exc
            logger.info("library_chat fallback: %s failed (%s — %s)", attempt_provider, kind, reason)
            if kind not in _FALLBACK_KINDS:
                raise ChatError(str(exc), attempts) from exc
            continue
    else:
        raise ChatError(str(last_exc) if last_exc else "all providers failed", attempts)

    elapsed_ms = int((time.monotonic() - start) * 1000)
    cost = _estimate_cost(actual_provider, tokens_in, tokens_out)
    fallback_meta = [a for a in attempts if a["provider"] != actual_provider]

    cited_numbers = _parse_cited_numbers(answer)
    cite_by_n = {c["n"]: c["article_id"] for c in citations}
    cited_article_ids = [cite_by_n[n] for n in cited_numbers if n in cite_by_n]

    import json as _json
    with eng.begin() as conn:
        conn.execute(_sql("""
            INSERT INTO prionvault_library_chat_message (chat_id, role, content)
            VALUES (CAST(:cid AS uuid), 'user', :content)
        """), {"cid": chat_id, "content": question})
        assistant_id = conn.execute(_sql("""
            INSERT INTO prionvault_library_chat_message
                (chat_id, role, content, provider, model, tokens_in, tokens_out,
                 cost_usd, fallback, cited_article_ids, citations)
            VALUES (CAST(:cid AS uuid), 'assistant', :content, :prov, :model,
                    :tin, :tout, :cost, CAST(:fb AS jsonb), CAST(:cites AS uuid[]), CAST(:citjson AS jsonb))
            RETURNING id
        """), {
            "cid": chat_id, "content": answer, "prov": actual_provider,
            "model": model_used, "tin": tokens_in, "tout": tokens_out, "cost": cost,
            "fb": _json.dumps(fallback_meta) if fallback_meta else None,
            "cites": cited_article_ids or None,
            # Store every retrieved citation (not just the ones the model
            # actually cited) so a hover card can resolve ANY [N] token
            # that shows up in the answer text, on reload as well.
            "citjson": _json.dumps(citations) if citations else None,
        }).scalar()
        conn.execute(_sql("""
            UPDATE prionvault_library_chat
               SET updated_at = NOW(), title = COALESCE(title, :title)
             WHERE id = CAST(:cid AS uuid)
        """), {"cid": chat_id, "title": question[:120]})

    # Best-effort, synchronous but non-blocking-on-failure: embed the new
    # assistant turn so it's findable via search_chats(). Skipped for the
    # user turn to keep this fast — the assistant answer's embedding is
    # enough to recall the exchange (it restates the question in context).
    try:
        _embed_message_async(assistant_id, f"{question}\n\n{answer}")
    except Exception:
        pass

    return {
        "answer": answer,
        "requested_provider": primary,
        "actual_provider": actual_provider,
        "provider_label": PROVIDERS.get(actual_provider, {}).get("label", actual_provider),
        "model": model_used,
        "fallback": fallback_meta,
        "switched": actual_provider != primary,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "cost_usd": cost,
        "elapsed_ms": elapsed_ms,
        "retrieval_ms": retrieval_ms,
        "citations": citations,
        "cited_article_ids": cited_article_ids,
    }


# ── Search past conversations ────────────────────────────────────────────────

def search_chats(user_id: str, query: str, limit: int = 15) -> list[dict]:
    """Hybrid search (vector + BM25) over this user's past messages —
    same idea as the article retriever, pointed at conversations instead
    of chunks. Falls back to BM25-only if embeddings aren't configured."""
    query = (query or "").strip()
    if not query:
        return []

    eng = _get_engine()
    qvec = None
    try:
        from ..embeddings.embedder import embed_query
        raw_qvec = embed_query(query)
        if raw_qvec:
            qvec = "[" + ",".join(f"{x:.7f}" for x in raw_qvec) + "]"
    except Exception as exc:
        logger.info("library_chat search: embeddings unavailable, BM25-only: %s", exc)

    # Same fix as embeddings/retriever.py's hybrid search: plainto_tsquery
    # ANDs every word, and 'simple' has no stopword list, so a natural-
    # language search phrase ANDs together filler words too — an OR of
    # significant words lets a real keyword match through.
    bm25_q = _bm25_or_query(query)

    with eng.connect() as conn:
        if qvec:
            rows = conn.execute(_sql("""
                WITH vec AS (
                    SELECT m.id, m.chat_id, m.content, m.created_at,
                           1 - (m.embedding <=> (:qvec)::vector) AS score
                      FROM prionvault_library_chat_message m
                      JOIN prionvault_library_chat c ON c.id = m.chat_id
                     WHERE c.user_id = CAST(:uid AS uuid)
                       AND m.embedding IS NOT NULL
                       AND m.role = 'assistant'
                     ORDER BY m.embedding <=> (:qvec)::vector
                     LIMIT 30
                ),
                bm25 AS (
                    SELECT m.id, m.chat_id, m.content, m.created_at,
                           ts_rank(m.search_vector, websearch_to_tsquery('simple', :q)) AS score
                      FROM prionvault_library_chat_message m
                      JOIN prionvault_library_chat c ON c.id = m.chat_id
                     WHERE c.user_id = CAST(:uid AS uuid)
                       AND m.search_vector @@ websearch_to_tsquery('simple', :q)
                     ORDER BY score DESC
                     LIMIT 30
                ),
                fused AS (
                    SELECT id, chat_id, content, created_at, score FROM vec
                    UNION ALL
                    SELECT id, chat_id, content, created_at, score FROM bm25
                )
                SELECT DISTINCT ON (id) id, chat_id, content, created_at
                  FROM fused
                 ORDER BY id, score DESC
                 LIMIT :lim
            """), {"qvec": qvec, "uid": user_id, "q": bm25_q, "lim": limit}).mappings().all()
        else:
            rows = conn.execute(_sql("""
                SELECT m.id, m.chat_id, m.content, m.created_at
                  FROM prionvault_library_chat_message m
                  JOIN prionvault_library_chat c ON c.id = m.chat_id
                 WHERE c.user_id = CAST(:uid AS uuid)
                   AND m.search_vector @@ websearch_to_tsquery('simple', :q)
                 ORDER BY ts_rank(m.search_vector, websearch_to_tsquery('simple', :q)) DESC
                 LIMIT :lim
            """), {"uid": user_id, "q": bm25_q, "lim": limit}).mappings().all()

        if not rows:
            return []
        chat_ids = list({str(r["chat_id"]) for r in rows})
        titles = conn.execute(_sql("""
            SELECT id::text, title FROM prionvault_library_chat
             WHERE id = ANY(CAST(:ids AS uuid[]))
        """), {"ids": chat_ids}).all()
        title_by_id = {t[0]: t[1] for t in titles}

    out = []
    for r in rows:
        out.append({
            "message_id": r["id"],
            "chat_id": str(r["chat_id"]),
            "chat_title": title_by_id.get(str(r["chat_id"])) or "(sin título)",
            "excerpt": (r["content"] or "")[:280],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        })
    return out
