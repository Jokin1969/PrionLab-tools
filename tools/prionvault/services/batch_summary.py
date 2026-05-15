"""Background batch generator for AI summaries.

Walks the `articles` table looking for rows that have `extracted_text`
but no `summary_ai`, and runs the Claude pipeline against each one. The
state of the run is held in a module-level dict + a lock; the UI polls
`GET /api/admin/batch-summary/status` to render progress live.

There is no separate queue table: the source of truth is the
`summary_ai IS NULL` predicate on the `articles` table itself, so the
batch is naturally resumable after a Railway restart — pressing Start
again simply picks up the remaining work.

Only one batch can be running at a time. A stop flag is honoured between
articles so the operator can interrupt cleanly without losing the
already-generated summaries.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime
from typing import Optional

from sqlalchemy import text as sql_text

from ..ingestion.queue import _get_engine
from .ai_summary import generate_summary, NotConfigured

logger = logging.getLogger(__name__)

# Polite delay between Claude calls — keeps us well under any per-minute
# rate limit and lets the operator hit Stop without queueing a thousand
# requests on the API side. Adjust if needed.
_BETWEEN_CALLS_SLEEP_S = 1.2

_state = {
    "running":           False,
    "started_at":        None,
    "finished_at":       None,
    "stop_requested":    False,
    "eligible_total":    0,    # eligible at start of this run
    "processed":         0,    # successful summaries this run
    "failed":            0,    # errors this run
    "current_article":   None, # {"id", "title"} of the one being processed
    "last_error":        None,
    "total_cost_usd":    0.0,
    "total_tokens_in":   0,
    "total_tokens_out":  0,
}
_lock = threading.Lock()
_thread: Optional[threading.Thread] = None


def get_status() -> dict:
    with _lock:
        snap = dict(_state)
    snap["library_stats"] = _library_stats()
    return snap


def _library_stats() -> dict:
    """Total articles, eligible (have extracted_text but no summary_ai),
    and how many already have a summary. Computed live so the UI always
    shows the truth even outside of a running batch.
    """
    try:
        eng = _get_engine()
        with eng.connect() as conn:
            row = conn.execute(sql_text(
                """SELECT
                       COUNT(*) AS total,
                       COUNT(*) FILTER (
                         WHERE extracted_text IS NOT NULL
                           AND length(extracted_text) > 100
                       ) AS with_text,
                       COUNT(*) FILTER (WHERE summary_ai IS NOT NULL) AS with_summary,
                       COUNT(*) FILTER (
                         WHERE extracted_text IS NOT NULL
                           AND length(extracted_text) > 100
                           AND summary_ai IS NULL
                       ) AS eligible
                   FROM articles"""
            )).first()
            return {
                "total":         int(row[0] or 0),
                "with_text":     int(row[1] or 0),
                "with_summary":  int(row[2] or 0),
                "eligible":      int(row[3] or 0),
            }
    except Exception as exc:
        logger.warning("batch_summary: library_stats failed: %s", exc)
        return {"total": 0, "with_text": 0, "with_summary": 0,
                "eligible": 0, "error": str(exc)[:300]}


def start_batch(*, viewer_user_id=None,
                limit: Optional[int] = None,
                provider: str = "anthropic",
                ids: Optional[list] = None) -> Optional[dict]:
    """Start a batch run. Returns None if one is already running.

    `provider` is one of the keys of ai_summary.PROVIDERS.
    `ids` (optional): if given, ONLY these article ids are processed
    (regenerating whatever summary they already had). When omitted,
    the default eligibility filter applies (articles with extracted
    text and no summary yet)."""
    from .ai_summary import PROVIDERS
    if provider not in PROVIDERS:
        raise ValueError(f"unknown provider: {provider!r}")

    ids_clean = [str(x) for x in ids] if ids else None

    global _thread
    with _lock:
        if _state["running"]:
            return None
        _state.update({
            "running":           True,
            "started_at":        datetime.utcnow().isoformat(),
            "finished_at":       None,
            "stop_requested":    False,
            "eligible_total":    0,
            "processed":         0,
            "failed":            0,
            "current_article":   None,
            "last_error":        None,
            "total_cost_usd":    0.0,
            "total_tokens_in":   0,
            "total_tokens_out":  0,
            "provider":          provider,
            "model":             PROVIDERS[provider]["model"],
            "selected_count":    len(ids_clean) if ids_clean else 0,
        })

    _thread = threading.Thread(
        target=_run_batch,
        kwargs={"viewer_user_id": viewer_user_id,
                "limit": limit, "provider": provider,
                "ids": ids_clean},
        name="prionvault-batch-summary",
        daemon=True,
    )
    _thread.start()
    return get_status()


def stop_batch() -> dict:
    with _lock:
        if _state["running"]:
            _state["stop_requested"] = True
    return get_status()


def _run_batch(*, viewer_user_id=None,
               limit: Optional[int] = None,
               provider: str = "anthropic",
               ids: Optional[list] = None) -> None:
    eng = _get_engine()

    # The eligibility filter depends on whether the caller pinned a
    # specific selection or wants the default "missing-summary" set.
    if ids:
        base_where = ("WHERE extracted_text IS NOT NULL "
                      "  AND length(extracted_text) > 100 "
                      "  AND id = ANY(CAST(:ids AS uuid[]))")
        base_params: dict = {"ids": ids}
    else:
        base_where = ("WHERE extracted_text IS NOT NULL "
                      "  AND length(extracted_text) > 100 "
                      "  AND summary_ai IS NULL")
        base_params = {}

    try:
        with eng.connect() as conn:
            row = conn.execute(
                sql_text(f"SELECT COUNT(*) FROM articles {base_where}"),
                base_params,
            ).first()
            with _lock:
                _state["eligible_total"] = int(row[0] or 0)
                if limit is not None:
                    _state["eligible_total"] = min(_state["eligible_total"], limit)
    except Exception as exc:
        logger.exception("batch_summary: could not count eligible articles")
        with _lock:
            _state["running"] = False
            _state["finished_at"] = datetime.utcnow().isoformat()
            _state["last_error"] = f"count failed: {exc}"
        return

    seen_ids: set = set()
    while True:
        with _lock:
            if _state["stop_requested"]:
                break
            if limit is not None and _state["processed"] + _state["failed"] >= limit:
                break

        try:
            with eng.connect() as conn:
                params = dict(base_params)
                seen_clause = ""
                if seen_ids:
                    params["seen"] = list(seen_ids)
                    seen_clause = " AND id <> ALL(:seen)"
                row = conn.execute(sql_text(
                    f"""SELECT id, title, authors, year, journal, abstract,
                              doi, pubmed_id, extracted_text
                       FROM articles
                       {base_where}
                       {seen_clause}
                       ORDER BY year DESC NULLS LAST, created_at DESC NULLS LAST
                       LIMIT 1"""
                ), params).first()
        except Exception as exc:
            logger.exception("batch_summary: query for next article failed")
            with _lock:
                _state["last_error"] = f"query failed: {exc}"
            time.sleep(5.0)
            continue

        if row is None:
            break  # nothing left to do

        article_id = row[0]
        title      = row[1] or "(sin título)"
        seen_ids.add(article_id)

        with _lock:
            _state["current_article"] = {
                "id":    str(article_id),
                "title": title[:160],
            }

        try:
            result = generate_summary(
                title=title,
                authors=row[2], year=row[3], journal=row[4],
                abstract=row[5], doi=row[6], pubmed_id=row[7],
                extracted_text=row[8],
                provider=provider,
            )
        except NotConfigured:
            logger.error("batch_summary: API key missing for provider=%s "
                         "— aborting batch", provider)
            with _lock:
                _state["last_error"] = "ANTHROPIC_API_KEY not set"
                _state["stop_requested"] = True
            break
        except Exception as exc:
            logger.warning("batch_summary: article %s failed: %s", article_id, exc)
            with _lock:
                _state["failed"] += 1
                _state["last_error"] = f"{title[:80]} — {str(exc)[:160]}"
            time.sleep(_BETWEEN_CALLS_SLEEP_S)
            continue

        # UPDATE and usage-tracking INSERT in SEPARATE transactions: a
        # failure on the usage INSERT cannot be allowed to poison the
        # main UPDATE (psycopg2: "current transaction aborted, commit
        # converts to rollback" — silently loses the summary).
        try:
            with eng.begin() as conn:
                conn.execute(sql_text(
                    """UPDATE articles
                       SET summary_ai = :summary,
                           updated_at = NOW()
                       WHERE id = :aid"""
                ), {"summary": result.text, "aid": article_id})
        except Exception as exc:
            logger.exception("batch_summary: persisting summary for %s failed", article_id)
            with _lock:
                _state["failed"] += 1
                _state["last_error"] = f"persist failed: {str(exc)[:160]}"
            time.sleep(_BETWEEN_CALLS_SLEEP_S)
            continue

        try:
            with eng.begin() as conn:
                conn.execute(sql_text(
                    """INSERT INTO prionvault_usage
                       (user_id, action, cost_usd, tokens_in, tokens_out,
                        metadata, created_at)
                       VALUES (:uid, 'summary_generate', :cost, :tin, :tout,
                               :meta::jsonb, NOW())"""
                ), {
                    "uid":  str(viewer_user_id) if viewer_user_id else None,
                    "cost": result.cost_usd,
                    "tin":  result.tokens_in,
                    "tout": result.tokens_out,
                    "meta": _json_dumps({
                        "article_id":     str(article_id),
                        "model":          result.model,
                        "used_full_text": result.used_full_text,
                        "input_chars":    result.input_chars,
                        "elapsed_ms":     result.elapsed_ms,
                        "via":            "batch",
                    }),
                })
        except Exception as exc:
            logger.warning("batch_summary: usage insert failed: %s", exc)

        with _lock:
            _state["processed"]        += 1
            _state["total_cost_usd"]   += float(result.cost_usd or 0)
            _state["total_tokens_in"]  += int(result.tokens_in or 0)
            _state["total_tokens_out"] += int(result.tokens_out or 0)

        time.sleep(_BETWEEN_CALLS_SLEEP_S)

    with _lock:
        _state["running"]         = False
        _state["stop_requested"]  = False
        _state["current_article"] = None
        _state["finished_at"]     = datetime.utcnow().isoformat()


def _json_dumps(obj) -> str:
    import json
    return json.dumps(obj, default=str)
