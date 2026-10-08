"""PDF ↔ metadata consistency verifier.

Goal: catch articles where the DB title/authors/year don't match what
the PDF actually is — a real risk when papers were imported by hand
and the wrong file got attached. A wrong PDF poisons the AI summary
downstream, so we'd rather flag it loudly than trust it.

Two-stage scoring per article (only those with extracted_text):

  1. **Heuristic (free)** — token-overlap on title (60 pts) +
     first-author surname presence (25 pts) + year presence (15 pts).
     Final score 0-100.
        >= 80           → 'ok'
        40-79           → 'suspect' → escalate to LLM
        < 40            → 'mismatch'

  2. **LLM (gpt-4o-mini by default)** for the suspect bucket. Sends
     ~3 kB of the PDF's first page plus the DB metadata and asks for
     a JSON verdict {verdict: match|mismatch|uncertain, reason}.
        match           → final 'ok'
        mismatch        → final 'mismatch'
        uncertain       → stays 'suspect' (operator decides by hand)

Single-runner pattern (mirror of batch_searchable_pdf): one background
thread, stop flag honoured between articles, status polled by the
modal. Status / score / detail are persisted, so reopening the modal
shows the same verdicts and never re-runs verified rows unless the
operator pulses "Reverificar" on a selection.
"""
from __future__ import annotations

import logging
import re
import threading
import time
from collections import deque
from datetime import datetime
from typing import Optional

from sqlalchemy import text as sql_text

from ..ingestion.queue import _get_engine
from .llm_pool import call_llm_json_with_fallback, NotConfigured

logger = logging.getLogger(__name__)


# How much of the PDF's extracted_text the heuristic + LLM see. The
# title / authors / year all sit on the first page so this is plenty
# without wasting LLM tokens.
_PDF_HEAD_CHARS = 3_000

# Inter-paper sleep. Heuristic is essentially instant; the LLM call
# is the slow part, and even there the OpenAI client is async-ish, so
# a small pause keeps the worker interruptible by the Stop flag.
_BETWEEN_PAPERS_SLEEP_S = 0.1

_EVENT_LOG_MAX = 500


# ── State ────────────────────────────────────────────────────────────────────

_state = {
    "running":         False,
    "started_at":      None,
    "finished_at":     None,
    "stop_requested":  False,
    "eligible_total":  0,
    "processed":       0,
    "ok":              0,
    "suspect":         0,
    "mismatch":        0,
    "no_pdf_text":     0,
    "errors":          0,
    "current":         None,    # {id, title}
    "last_error":      None,
    "llm_calls":       0,
    "events":          deque(maxlen=_EVENT_LOG_MAX),
}
_lock   = threading.Lock()
_thread: Optional[threading.Thread] = None


def _log_event(article_id, title: str, status: str, score: int,
               detail: Optional[str] = None) -> None:
    entry = {
        "at":         datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "article_id": str(article_id) if article_id else None,
        "title":      (title or "")[:160],
        "status":     status,
        "score":      score,
        "detail":     (detail[:240] if isinstance(detail, str) else None),
    }
    with _lock:
        _state["events"].append(entry)


def get_status() -> dict:
    with _lock:
        snap = {k: v for k, v in _state.items() if k != "events"}
        snap["events"] = list(reversed(_state["events"]))
    snap["totals"] = _totals()
    return snap


def _totals() -> dict:
    """Snapshot of the verification status across the whole catalogue.
    Cheap (single grouped query)."""
    try:
        eng = _get_engine()
        with eng.connect() as conn:
            row = conn.execute(sql_text("""
                SELECT
                    COUNT(*) FILTER (WHERE dropbox_path IS NOT NULL
                                       AND extracted_text IS NOT NULL) AS eligible,
                    COUNT(*) FILTER (WHERE pdf_metadata_match_status IS NULL
                                       AND dropbox_path IS NOT NULL
                                       AND extracted_text IS NOT NULL) AS pending,
                    COUNT(*) FILTER (WHERE pdf_metadata_match_status IN ('ok','manual_ok')) AS ok,
                    COUNT(*) FILTER (WHERE pdf_metadata_match_status = 'suspect') AS suspect,
                    COUNT(*) FILTER (WHERE pdf_metadata_match_status = 'mismatch') AS mismatch,
                    COUNT(*) FILTER (WHERE pdf_metadata_match_status = 'no_pdf_text') AS no_pdf_text
                  FROM articles
            """)).first()
        return {
            "eligible":    int(row[0] or 0),
            "pending":     int(row[1] or 0),
            "ok":          int(row[2] or 0),
            "suspect":     int(row[3] or 0),
            "mismatch":    int(row[4] or 0),
            "no_pdf_text": int(row[5] or 0),
        }
    except Exception as exc:
        logger.warning("pdf_metadata_verifier: totals failed (%s)", exc)
        return {"eligible": 0, "pending": 0, "ok": 0, "suspect": 0,
                "mismatch": 0, "no_pdf_text": 0, "error": str(exc)[:240]}


def clear_events() -> None:
    with _lock:
        _state["events"].clear()
        _state["last_error"] = None


# ── Heuristic scoring ────────────────────────────────────────────────────────

_STOPWORDS = frozenset({
    "the", "and", "for", "with", "from", "into", "this", "that", "have",
    "been", "are", "was", "were", "their", "its", "our", "your", "but",
    "not", "via", "study", "studies", "review", "case", "report",
})


def _normalize(s: str) -> str:
    if not s:
        return ""
    s = s.lower()
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _title_overlap(title_norm: str, pdf_head_norm: str) -> float:
    """Fraction of distinct title tokens (≥4 chars, not stopword) that
    appear in the PDF head text. 0-1."""
    title_tokens = {
        t for t in title_norm.split()
        if len(t) >= 4 and t not in _STOPWORDS
    }
    if not title_tokens:
        return 0.0
    pdf_tokens = set(pdf_head_norm.split())
    return len(title_tokens & pdf_tokens) / len(title_tokens)


def _first_author_surname(authors: str) -> Optional[str]:
    """Best-effort: grab the first author's surname from the authors
    field. Handles "Castilla J; Soto C" and "Castilla, J; Soto, C"."""
    if not authors:
        return None
    first = authors.split(";")[0].strip()
    if not first:
        return None
    # Comma-separated → surname comes first.
    if "," in first:
        candidate = first.split(",")[0].strip()
    else:
        # "Castilla J" → "Castilla"; "J Castilla" → "Castilla"
        parts = first.split()
        if len(parts) == 1:
            candidate = parts[0]
        else:
            # If the first token is one char or initials, take the last
            # token; otherwise take the first token.
            if len(parts[0]) <= 2 or "." in parts[0]:
                candidate = parts[-1]
            else:
                candidate = parts[0]
    candidate = _normalize(candidate)
    return candidate if candidate and len(candidate) >= 3 else None


def heuristic_score(article: dict) -> tuple[int, str]:
    """Returns (score 0-100, detail string).

    Title overlap → 0-60 (linear on the token-overlap fraction).
    First-author surname present → 0 or 25.
    Year present → 0 or 15.
    """
    pdf_text = (article.get("extracted_text") or "")[:_PDF_HEAD_CHARS]
    pdf_head_norm = _normalize(pdf_text)
    if not pdf_head_norm:
        return 0, "no_pdf_text"

    title_norm = _normalize(article.get("title") or "")
    if not title_norm:
        return 0, "no_db_title"

    title_frac = _title_overlap(title_norm, pdf_head_norm)
    title_score = round(60 * title_frac)

    surname = _first_author_surname(article.get("authors") or "")
    author_score = 25 if surname and surname in pdf_head_norm else 0

    year = article.get("year")
    year_score = 15 if year and str(year) in pdf_head_norm else 0

    total = title_score + author_score + year_score
    detail = (
        f"title={title_score} ({title_frac:.0%}) "
        f"author={author_score}{'' if surname else ' (no_surname)'} "
        f"year={year_score}{'' if year else ' (no_year)'}"
    )
    return total, detail


# ── LLM verification ─────────────────────────────────────────────────────────

_VERIFY_SYSTEM = (
    "Eres un verificador estricto que decide si una primera página de PDF "
    "corresponde a los metadatos que tenemos en la base de datos. "
    "Te paso los metadatos (título, autores, año, revista) y los primeros "
    "~3 kB de texto extraído del PDF. Decide si encajan.\n\n"
    "Reglas:\n"
    " - 'match' SOLO si el título del PDF coincide claramente con el de la "
    "base. Pequeñas diferencias de puntuación o acentos se aceptan; "
    "diferencias de palabras clave NO.\n"
    " - 'mismatch' si el PDF es claramente otro artículo distinto.\n"
    " - 'uncertain' si el PDF es ilegible (mucho ruido OCR), o si no hay "
    "evidencia suficiente para decidir.\n\n"
    "Responde JSON estricto:\n"
    "{\"verdict\":\"match|mismatch|uncertain\",\"reason\":\"breve explicación en español\"}"
)


def _llm_verify(article: dict, provider: str
                ) -> tuple[str, str, Optional[dict]]:
    """Returns (verdict, reason, info). verdict is 'match' | 'mismatch'
    | 'uncertain'. info carries the provider chain that delivered."""
    pdf_head = (article.get("extracted_text") or "")[:_PDF_HEAD_CHARS]
    user = (
        "## Metadatos de la base de datos\n"
        f"Título: {article.get('title') or '(vacío)'}\n"
        f"Autores: {article.get('authors') or '(vacíos)'}\n"
        f"Año: {article.get('year') or '?'}\n"
        f"Revista: {article.get('journal') or '?'}\n"
        f"DOI: {article.get('doi') or '?'}\n"
        f"PMID: {article.get('pubmed_id') or '?'}\n\n"
        "## Primera página del PDF (texto extraído)\n"
        f"{pdf_head}\n"
    )
    try:
        parsed, info = call_llm_json_with_fallback(
            providers=[provider, "openai", "anthropic", "gemini"],
            system=_VERIFY_SYSTEM, user=user, max_tokens=400,
        )
    except (RuntimeError, NotConfigured) as exc:
        return "uncertain", f"LLM no disponible: {exc}"[:240], None
    verdict = (parsed.get("verdict") or "").strip().lower()
    reason  = (parsed.get("reason")  or "").strip()
    if verdict not in {"match", "mismatch", "uncertain"}:
        verdict = "uncertain"
    return verdict, reason, info


# ── Per-article verifier (single paper) ──────────────────────────────────────

def _verify_one(article: dict, *, llm_provider: Optional[str]) -> dict:
    """Returns {status, score, detail}. Caller is responsible for
    UPDATEing the row."""
    score, detail = heuristic_score(article)
    if detail == "no_pdf_text":
        return {"status": "no_pdf_text", "score": 0, "detail": "PDF sin texto extraído"}
    if detail == "no_db_title":
        return {"status": "suspect", "score": 0,
                "detail": "Sin título en la base — no se puede comparar"}

    # Decisive ends of the spectrum: skip the LLM entirely.
    if score >= 80:
        return {"status": "ok", "score": score, "detail": "heur " + detail}
    if score < 40:
        return {"status": "mismatch", "score": score, "detail": "heur " + detail}

    # Borderline → ask the LLM.
    if not llm_provider:
        # Without an LLM key configured, keep the heuristic verdict.
        return {"status": "suspect", "score": score, "detail": "heur " + detail}

    with _lock:
        _state["llm_calls"] += 1
    verdict, reason, _info = _llm_verify(article, llm_provider)
    final_status = {
        "match":     "ok",
        "mismatch":  "mismatch",
        "uncertain": "suspect",
    }.get(verdict, "suspect")
    return {
        "status": final_status,
        "score":  score,
        "detail": f"heur {detail} | LLM {verdict}: {reason}"[:600],
    }


# ── Batch orchestration ──────────────────────────────────────────────────────

def start_batch(*, llm_provider: Optional[str] = "openai",
                limit: Optional[int] = None,
                recheck: bool = False) -> Optional[dict]:
    """Spawn the worker. `llm_provider` is the preferred provider for
    the LLM follow-up (cheapest: openai gpt-4o-mini). `recheck=True`
    walks every article (including already-verified ones) so the
    operator can re-run the whole batch after tweaking weights."""
    global _thread
    with _lock:
        if _state["running"]:
            return None
        _state.update({
            "running":         True,
            "started_at":      datetime.utcnow().isoformat(),
            "finished_at":     None,
            "stop_requested":  False,
            "eligible_total":  0,
            "processed":       0,
            "ok":              0,
            "suspect":         0,
            "mismatch":        0,
            "no_pdf_text":     0,
            "errors":          0,
            "current":         None,
            "last_error":      None,
            "llm_calls":       0,
        })
    _thread = threading.Thread(
        target=_run_loop,
        kwargs={"llm_provider": llm_provider, "limit": limit,
                "recheck": recheck},
        name="prionvault-verify-metadata",
        daemon=True,
    )
    _thread.start()
    return get_status()


def stop_batch() -> dict:
    with _lock:
        if _state["running"]:
            _state["stop_requested"] = True
    return get_status()


def _run_loop(*, llm_provider: Optional[str], limit: Optional[int],
              recheck: bool) -> None:
    eng = _get_engine()
    where_pending = (
        "dropbox_path IS NOT NULL AND extracted_text IS NOT NULL"
        if recheck
        else "pdf_metadata_match_status IS NULL"
             " AND dropbox_path IS NOT NULL"
             " AND extracted_text IS NOT NULL"
    )

    try:
        with eng.connect() as conn:
            row = conn.execute(sql_text(
                f"SELECT COUNT(*) FROM articles WHERE {where_pending}"
            )).first()
            n = int(row[0] or 0)
            if limit is not None:
                n = min(n, limit)
            with _lock:
                _state["eligible_total"] = n
    except Exception as exc:
        logger.exception("pdf_metadata_verifier: count failed")
        with _lock:
            _state["running"]     = False
            _state["finished_at"] = datetime.utcnow().isoformat()
            _state["last_error"]  = f"count: {exc}"
        return

    seen_ids: set = set()
    while True:
        with _lock:
            if _state["stop_requested"]:
                break
            if limit is not None and _state["processed"] >= limit:
                break
        # Pick the next article. Order by created_at DESC so newest
        # papers (more likely to be operator-imported) get checked
        # first.
        try:
            with eng.connect() as conn:
                params: dict = {}
                seen_clause = ""
                if seen_ids:
                    params["seen"] = list(seen_ids)
                    seen_clause = " AND id::text <> ALL(:seen)"
                row = conn.execute(sql_text(
                    f"""SELECT id, title, authors, year, journal, doi,
                               pubmed_id, extracted_text
                          FROM articles
                         WHERE {where_pending}
                               {seen_clause}
                         ORDER BY created_at DESC NULLS LAST
                         LIMIT 1"""
                ), params).mappings().first()
        except Exception as exc:
            logger.exception("pdf_metadata_verifier: probe failed")
            with _lock:
                _state["last_error"] = f"probe: {exc}"
                _state["errors"] += 1
            time.sleep(2.0)
            continue

        if not row:
            break

        article = dict(row)
        aid     = str(article["id"])
        title   = article.get("title") or "(sin título)"
        seen_ids.add(aid)

        with _lock:
            _state["current"] = {"id": aid, "title": title[:160]}

        try:
            verdict = _verify_one(article, llm_provider=llm_provider)
        except Exception as exc:
            logger.exception("pdf_metadata_verifier: verify_one crashed for %s", aid)
            with _lock:
                _state["errors"] += 1
                _state["last_error"] = f"{title[:80]} — {str(exc)[:160]}"
            time.sleep(_BETWEEN_PAPERS_SLEEP_S)
            continue

        try:
            with eng.begin() as conn:
                conn.execute(sql_text("""
                    UPDATE articles
                       SET pdf_metadata_match_status     = :st,
                           pdf_metadata_match_score      = :sc,
                           pdf_metadata_match_checked_at = NOW(),
                           pdf_metadata_match_detail     = :dt
                     WHERE id = :aid
                """), {
                    "aid": aid,
                    "st":  verdict["status"],
                    "sc":  verdict["score"],
                    "dt":  verdict["detail"],
                })
        except Exception as exc:
            logger.exception("pdf_metadata_verifier: persist failed for %s", aid)
            with _lock:
                _state["errors"] += 1
                _state["last_error"] = f"{title[:80]} — persist: {str(exc)[:160]}"
            time.sleep(_BETWEEN_PAPERS_SLEEP_S)
            continue

        with _lock:
            _state["processed"] += 1
            bucket = verdict["status"]
            if bucket in ("ok",):
                _state["ok"] += 1
            elif bucket == "suspect":
                _state["suspect"] += 1
            elif bucket == "mismatch":
                _state["mismatch"] += 1
            elif bucket == "no_pdf_text":
                _state["no_pdf_text"] += 1
        _log_event(aid, title, verdict["status"], verdict["score"],
                   verdict["detail"])
        time.sleep(_BETWEEN_PAPERS_SLEEP_S)

    with _lock:
        _state["running"]     = False
        _state["finished_at"] = datetime.utcnow().isoformat()
        _state["current"]     = None


# ── Listing for the modal ────────────────────────────────────────────────────

def list_verified(*, status: str = "suspect",
                  page: int = 1, size: int = 50) -> dict:
    """Paginated listing for the modal. status: 'ok' | 'suspect' |
    'mismatch' | 'manual_ok' | 'no_pdf_text'."""
    page = max(1, int(page or 1))
    size = max(1, min(200, int(size or 50)))
    eng = _get_engine()
    with eng.connect() as conn:
        total = conn.execute(sql_text("""
            SELECT COUNT(*) FROM articles
             WHERE pdf_metadata_match_status = :s
        """), {"s": status}).scalar() or 0
        rows = conn.execute(sql_text("""
            SELECT id::text AS id, title, authors, year, journal, doi,
                   pubmed_id, pdf_metadata_match_score AS score,
                   pdf_metadata_match_detail AS detail,
                   pdf_metadata_match_checked_at AS checked_at,
                   SUBSTRING(extracted_text FROM 1 FOR 400) AS pdf_head
              FROM articles
             WHERE pdf_metadata_match_status = :s
             ORDER BY pdf_metadata_match_score ASC NULLS LAST,
                      pdf_metadata_match_checked_at DESC NULLS LAST
             LIMIT :lim OFFSET :off
        """), {"s": status, "lim": size,
               "off": (page - 1) * size}).mappings().all()
    items = []
    for r in rows:
        d = dict(r)
        ca = d.get("checked_at")
        d["checked_at"] = ca.isoformat() if hasattr(ca, "isoformat") else ca
        items.append(d)
    return {"total": int(total), "page": page, "size": size,
            "status": status, "items": items}


def list_ids_by_status(*, status: str) -> list[str]:
    """Return all article IDs with the given verification status (for main-list transfer)."""
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text("""
            SELECT id::text FROM articles
             WHERE pdf_metadata_match_status = :s
             ORDER BY pdf_metadata_match_score ASC NULLS LAST
        """), {"s": status}).fetchall()
    return [r[0] for r in rows]


def mark_status(ids: list[str], status: str) -> int:
    """Bulk update status. Use 'manual_ok' to greenlight false-flags."""
    if not ids or status not in {"manual_ok", "ok", "suspect",
                                  "mismatch", "no_pdf_text"}:
        return 0
    eng = _get_engine()
    with eng.begin() as conn:
        r = conn.execute(sql_text("""
            UPDATE articles
               SET pdf_metadata_match_status     = :st,
                   pdf_metadata_match_checked_at = NOW()
             WHERE id::text = ANY(:ids)
        """), {"st": status, "ids": ids})
    return r.rowcount or 0


def recheck_ids(ids: list[str]) -> int:
    """Drop the verdict on a selection so the next batch re-evaluates."""
    if not ids:
        return 0
    eng = _get_engine()
    with eng.begin() as conn:
        r = conn.execute(sql_text("""
            UPDATE articles
               SET pdf_metadata_match_status     = NULL,
                   pdf_metadata_match_score      = NULL,
                   pdf_metadata_match_checked_at = NULL,
                   pdf_metadata_match_detail     = NULL
             WHERE id::text = ANY(:ids)
        """), {"ids": ids})
    return r.rowcount or 0
