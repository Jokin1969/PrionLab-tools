"""Background batch indexer for vector embeddings.

Mirrors the design of `batch_summary`: a single guarded background
thread walks every article that has indexable text (extracted_text >
200 chars, or summary_ai > 100 chars, or abstract as a last resort)
and either no chunks yet or chunks from a previous index_version, and
runs the per-article indexing pipeline.

The source of truth for "needs indexing" is the `articles.indexed_at`
column combined with the current embedder MODEL stored in
`articles.index_version`, so the run is naturally resumable across
restarts.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime
from typing import Optional

from sqlalchemy import text as sql_text

from ..ingestion.queue import _get_engine
from ..embeddings.embedder import MODEL as EMBED_MODEL, NotConfigured
from ..embeddings.indexer import index_article

logger = logging.getLogger(__name__)

# Voyage handles batches of 64 happily; we still pause briefly between
# articles to keep the API quiet and the loop interruptible.
_BETWEEN_ARTICLES_SLEEP_S = 0.4

_state = {
    "running":           False,
    "started_at":        None,
    "finished_at":       None,
    "stop_requested":    False,
    "eligible_total":    0,
    "processed":         0,
    "failed":            0,
    "skipped":           0,
    "current_article":   None,
    "last_error":        None,
    "total_cost_usd":    0.0,
    "total_tokens":      0,
    "total_chunks":      0,
}
_lock = threading.Lock()
_thread: Optional[threading.Thread] = None


def get_status() -> dict:
    with _lock:
        snap = dict(_state)
    snap["library_stats"] = _library_stats()
    snap["embed_model"] = EMBED_MODEL
    return snap


def _library_stats() -> dict:
    try:
        eng = _get_engine()
        with eng.connect() as conn:
            row = conn.execute(sql_text(
                """SELECT
                       COUNT(*) AS total,
                       COUNT(*) FILTER (
                         WHERE (extracted_text IS NOT NULL
                                AND length(extracted_text) > 200)
                            OR (summary_ai IS NOT NULL
                                AND length(summary_ai) > 100)
                            OR (abstract IS NOT NULL
                                AND length(abstract) > 100)
                       ) AS indexable,
                       COUNT(*) FILTER (
                         WHERE indexed_at IS NOT NULL
                           AND index_version = :model
                       ) AS indexed,
                       COUNT(*) FILTER (
                         WHERE ((extracted_text IS NOT NULL
                                 AND length(extracted_text) > 200)
                             OR (summary_ai IS NOT NULL
                                 AND length(summary_ai) > 100)
                             OR (abstract IS NOT NULL
                                 AND length(abstract) > 100))
                           AND (indexed_at IS NULL
                                OR index_version IS DISTINCT FROM :model)
                       ) AS eligible
                   FROM articles"""
            ), {"model": EMBED_MODEL}).first()
            chunk_count = conn.execute(sql_text(
                "SELECT COUNT(*) FROM article_chunk"
            )).scalar() or 0
            return {
                "total":      int(row[0] or 0),
                "indexable":  int(row[1] or 0),
                "indexed":    int(row[2] or 0),
                "eligible":   int(row[3] or 0),
                "chunks_in_index": int(chunk_count),
            }
    except Exception as exc:
        logger.warning("batch_index: library_stats failed: %s", exc)
        return {"total": 0, "indexable": 0, "indexed": 0, "eligible": 0,
                "chunks_in_index": 0}


def start_batch(*, viewer_user_id=None,
                limit: Optional[int] = None) -> Optional[dict]:
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
            "failed":          0,
            "skipped":         0,
            "current_article": None,
            "last_error":      None,
            "total_cost_usd":  0.0,
            "total_tokens":    0,
            "total_chunks":    0,
        })

    _thread = threading.Thread(
        target=_run_batch,
        kwargs={"viewer_user_id": viewer_user_id, "limit": limit},
        name="prionvault-batch-index",
        daemon=True,
    )
    _thread.start()
    return get_status()


def stop_batch() -> dict:
    with _lock:
        if _state["running"]:
            _state["stop_requested"] = True
    return get_status()


def _run_batch(*, viewer_user_id=None, limit: Optional[int] = None) -> None:
    eng = _get_engine()
    try:
        with eng.connect() as conn:
            row = conn.execute(sql_text(
                """SELECT COUNT(*) FROM articles
                   WHERE ((extracted_text IS NOT NULL
                           AND length(extracted_text) > 200)
                       OR (summary_ai IS NOT NULL
                           AND length(summary_ai) > 100)
                       OR (abstract IS NOT NULL
                           AND length(abstract) > 100))
                     AND (indexed_at IS NULL
                          OR index_version IS DISTINCT FROM :model)"""
            ), {"model": EMBED_MODEL}).first()
            with _lock:
                _state["eligible_total"] = int(row[0] or 0)
                if limit is not None:
                    _state["eligible_total"] = min(_state["eligible_total"], limit)
    except Exception as exc:
        logger.exception("batch_index: count failed")
        with _lock:
            _state["running"] = False
            _state["finished_at"] = datetime.utcnow().isoformat()
            _state["last_error"] = f"count failed: {exc}"
        return

    seen_ids: set = set()
    aborted = False
    while not aborted:
        with _lock:
            if _state["stop_requested"]:
                break
            if limit is not None and _state["processed"] + _state["failed"] >= limit:
                break

        try:
            with eng.connect() as conn:
                params = {"model": EMBED_MODEL}
                seen_clause = ""
                if seen_ids:
                    params["seen"] = list(seen_ids)
                    seen_clause = " AND id <> ALL(:seen)"
                row = conn.execute(sql_text(
                    f"""SELECT id, title, extracted_text, summary_ai, abstract
                        FROM articles
                        WHERE ((extracted_text IS NOT NULL
                                AND length(extracted_text) > 200)
                            OR (summary_ai IS NOT NULL
                                AND length(summary_ai) > 100)
                            OR (abstract IS NOT NULL
                                AND length(abstract) > 100))
                          AND (indexed_at IS NULL
                               OR index_version IS DISTINCT FROM :model)
                          {seen_clause}
                        ORDER BY year DESC NULLS LAST, created_at DESC NULLS LAST
                        LIMIT 1"""
                ), params).first()
        except Exception as exc:
            logger.exception("batch_index: query failed")
            with _lock:
                _state["last_error"] = f"query failed: {exc}"
            time.sleep(5.0)
            continue

        if row is None:
            break

        article_id    = row[0]
        title         = row[1] or "(sin título)"
        extracted     = row[2]
        summary_ai    = row[3]
        abstract      = row[4]
        seen_ids.add(article_id)

        with _lock:
            _state["current_article"] = {
                "id": str(article_id), "title": title[:160],
            }

        try:
            result = index_article(
                article_id=article_id,
                title=title,
                extracted_text=extracted,
                summary_ai=summary_ai,
                abstract=abstract,
            )
        except NotConfigured:
            logger.error("batch_index: VOYAGE_API_KEY missing — aborting batch")
            with _lock:
                _state["last_error"] = "VOYAGE_API_KEY not set"
                _state["stop_requested"] = True
            aborted = True
            break
        except Exception as exc:
            logger.warning("batch_index: article %s failed: %s", article_id, exc)
            with _lock:
                _state["failed"] += 1
                _state["last_error"] = f"{title[:80]} — {str(exc)[:160]}"
            time.sleep(_BETWEEN_ARTICLES_SLEEP_S)
            continue

        if result.error:
            with _lock:
                if result.error in ("no_text_available", "empty_after_chunking"):
                    _state["skipped"] += 1
                else:
                    _state["failed"] += 1
                    _state["last_error"] = f"{title[:80]} — {result.error}"
            time.sleep(_BETWEEN_ARTICLES_SLEEP_S)
            continue

        # Best-effort usage tracking.
        try:
            with eng.begin() as conn:
                conn.execute(sql_text(
                    """INSERT INTO prionvault_usage
                       (user_id, action, cost_usd, tokens_in, tokens_out,
                        metadata, created_at)
                       VALUES (:uid, 'embedding_index', :cost, :tok, 0,
                               :meta::jsonb, NOW())"""
                ), {
                    "uid":  str(viewer_user_id) if viewer_user_id else None,
                    "cost": result.cost_usd,
                    "tok":  result.tokens,
                    "meta": _json_dumps({
                        "article_id":  str(article_id),
                        "model":       EMBED_MODEL,
                        "source":      result.used_source,
                        "chunks":      result.chunks_written,
                        "elapsed_ms":  result.elapsed_ms,
                        "via":         "batch",
                    }),
                })
        except Exception as exc:
            logger.warning("batch_index: usage insert failed: %s", exc)

        with _lock:
            _state["processed"]       += 1
            _state["total_cost_usd"]  += float(result.cost_usd or 0)
            _state["total_tokens"]    += int(result.tokens or 0)
            _state["total_chunks"]    += int(result.chunks_written or 0)

        time.sleep(_BETWEEN_ARTICLES_SLEEP_S)

    with _lock:
        _state["running"]         = False
        _state["stop_requested"]  = False
        _state["current_article"] = None
        _state["finished_at"]     = datetime.utcnow().isoformat()


def _json_dumps(obj) -> str:
    import json
    return json.dumps(obj, default=str)
