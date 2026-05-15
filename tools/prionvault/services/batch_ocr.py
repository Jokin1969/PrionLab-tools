"""Background batch OCR service.

Walks every article that has a PDF in Dropbox but little or no
`extracted_text` — typically scanned papers where pdfplumber found no
text layer — downloads the PDF, runs Tesseract via the OCR helper, and
writes the recovered text back to `articles.extracted_text` so the rest
of the pipeline (full-text search, AI summary generation, vector
indexing, RAG) can finally see them.

Same single-runner pattern as batch_summary / batch_index: one
background thread guarded by a module-level lock, stop flag honoured
between articles, status polled by the UI every couple of seconds.

Eligibility filter (the source of truth, so re-runs are idempotent):
    dropbox_path IS NOT NULL
    AND (extracted_text IS NULL OR length(extracted_text) < 200)
"""
from __future__ import annotations

import io
import logging
import threading
import time
from datetime import datetime
from typing import Optional

from sqlalchemy import text as sql_text

from ..ingestion.queue import _get_engine
from ..ingestion.ocr import ocr_pdf_bytes

logger = logging.getLogger(__name__)

# Tesseract is CPU-bound and Dropbox download is I/O-bound. A short
# sleep between papers keeps the worker thread interruptible without
# hurting throughput meaningfully.
_BETWEEN_PAPERS_SLEEP_S = 0.6

# Below this character count, the OCR is treated as "didn't really
# work" and the article is marked failed instead of overwriting a
# perfectly-extracted-but-short paper with garbage.
_MIN_USEFUL_CHARS = 200

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
    "total_chars":       0,
    "total_pages":       0,
}
_lock = threading.Lock()
_thread: Optional[threading.Thread] = None


def get_status() -> dict:
    with _lock:
        snap = dict(_state)
    snap["library_stats"] = _library_stats()
    return snap


def _library_stats() -> dict:
    try:
        eng = _get_engine()
        with eng.connect() as conn:
            row = conn.execute(sql_text(
                """SELECT
                       COUNT(*) AS total,
                       COUNT(*) FILTER (WHERE dropbox_path IS NOT NULL) AS with_pdf,
                       COUNT(*) FILTER (
                         WHERE extracted_text IS NOT NULL
                           AND length(extracted_text) >= 200
                       ) AS with_text,
                       COUNT(*) FILTER (
                         WHERE dropbox_path IS NOT NULL
                           AND (extracted_text IS NULL
                                OR length(extracted_text) < 200)
                       ) AS eligible
                   FROM articles"""
            )).first()
            return {
                "total":     int(row[0] or 0),
                "with_pdf":  int(row[1] or 0),
                "with_text": int(row[2] or 0),
                "eligible":  int(row[3] or 0),
            }
    except Exception as exc:
        logger.warning("batch_ocr: library_stats failed: %s", exc)
        return {"total": 0, "with_pdf": 0, "with_text": 0, "eligible": 0}


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
            "total_chars":     0,
            "total_pages":     0,
        })

    _thread = threading.Thread(
        target=_run_batch,
        kwargs={"viewer_user_id": viewer_user_id, "limit": limit},
        name="prionvault-batch-ocr",
        daemon=True,
    )
    _thread.start()
    return get_status()


def stop_batch() -> dict:
    with _lock:
        if _state["running"]:
            _state["stop_requested"] = True
    return get_status()


def _download_pdf(dropbox_path: str) -> bytes:
    """Pull the PDF binary out of Dropbox."""
    from core.dropbox_client import get_client
    client = get_client()
    if client is None:
        raise RuntimeError("Dropbox client unavailable")
    _meta, response = client.files_download(dropbox_path)
    return response.content


def _run_batch(*, viewer_user_id=None, limit: Optional[int] = None) -> None:
    eng = _get_engine()
    try:
        with eng.connect() as conn:
            row = conn.execute(sql_text(
                """SELECT COUNT(*) FROM articles
                   WHERE dropbox_path IS NOT NULL
                     AND (extracted_text IS NULL
                          OR length(extracted_text) < 200)"""
            )).first()
            with _lock:
                _state["eligible_total"] = int(row[0] or 0)
                if limit is not None:
                    _state["eligible_total"] = min(_state["eligible_total"], limit)
    except Exception as exc:
        logger.exception("batch_ocr: count failed")
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
            if limit is not None and \
               _state["processed"] + _state["failed"] + _state["skipped"] >= limit:
                break

        try:
            with eng.connect() as conn:
                params: dict = {}
                seen_clause = ""
                if seen_ids:
                    params["seen"] = list(seen_ids)
                    seen_clause = " AND id <> ALL(:seen)"
                row = conn.execute(sql_text(
                    f"""SELECT id, title, dropbox_path, pdf_pages
                        FROM articles
                        WHERE dropbox_path IS NOT NULL
                          AND (extracted_text IS NULL
                               OR length(extracted_text) < 200)
                          {seen_clause}
                        ORDER BY added_at DESC NULLS LAST
                        LIMIT 1"""
                ), params).first()
        except Exception as exc:
            logger.exception("batch_ocr: query failed")
            with _lock:
                _state["last_error"] = f"query failed: {exc}"
            time.sleep(5.0)
            continue

        if row is None:
            break

        article_id   = row[0]
        title        = row[1] or "(sin título)"
        dropbox_path = row[2]
        old_pages    = row[3]
        seen_ids.add(article_id)

        with _lock:
            _state["current_article"] = {
                "id":    str(article_id),
                "title": title[:160],
            }

        # 1. Download
        try:
            content = _download_pdf(dropbox_path)
        except Exception as exc:
            logger.warning("batch_ocr: download failed for %s: %s", article_id, exc)
            with _lock:
                _state["failed"] += 1
                _state["last_error"] = f"{title[:80]} — download: {str(exc)[:160]}"
            time.sleep(_BETWEEN_PAPERS_SLEEP_S)
            continue

        # 2. OCR
        try:
            result = ocr_pdf_bytes(content)
        except Exception as exc:
            logger.exception("batch_ocr: OCR failed for %s", article_id)
            with _lock:
                _state["failed"] += 1
                _state["last_error"] = f"{title[:80]} — OCR: {str(exc)[:160]}"
            time.sleep(_BETWEEN_PAPERS_SLEEP_S)
            continue

        if not result.text or len(result.text) < _MIN_USEFUL_CHARS:
            with _lock:
                _state["skipped"] += 1
                detail = result.error or "no usable text recovered"
                _state["last_error"] = f"{title[:80]} — {detail[:160]}"
            time.sleep(_BETWEEN_PAPERS_SLEEP_S)
            continue

        # 3. Persist
        try:
            with eng.begin() as conn:
                params = {
                    "aid":   str(article_id),
                    "text":  result.text,
                    "pages": result.pages or old_pages,
                }
                conn.execute(sql_text(
                    """UPDATE articles
                       SET extracted_text    = :text,
                           extraction_status = 'extracted',
                           extraction_error  = NULL,
                           pdf_pages         = COALESCE(:pages, pdf_pages),
                           updated_at        = NOW()
                       WHERE id = :aid"""
                ), params)
                try:
                    conn.execute(sql_text(
                        """INSERT INTO prionvault_usage
                           (user_id, action, cost_usd, tokens_in, tokens_out,
                            metadata, created_at)
                           VALUES (:uid, 'ocr_extract', 0, 0, 0,
                                   :meta::jsonb, NOW())"""
                    ), {
                        "uid":  str(viewer_user_id) if viewer_user_id else None,
                        "meta": _json_dumps({
                            "article_id":  str(article_id),
                            "pages":       result.pages,
                            "pages_ocrd":  result.pages_ocrd,
                            "chars":       len(result.text),
                            "truncated":   result.truncated,
                            "elapsed_ms":  result.elapsed_ms,
                            "via":         "batch",
                        }),
                    })
                except Exception as exc:
                    logger.warning("batch_ocr: usage insert failed: %s", exc)
        except Exception as exc:
            logger.exception("batch_ocr: persist failed for %s", article_id)
            with _lock:
                _state["failed"] += 1
                _state["last_error"] = f"persist: {exc}"
            time.sleep(_BETWEEN_PAPERS_SLEEP_S)
            continue

        with _lock:
            _state["processed"]    += 1
            _state["total_chars"]  += len(result.text)
            _state["total_pages"]  += result.pages_ocrd

        time.sleep(_BETWEEN_PAPERS_SLEEP_S)

    with _lock:
        _state["running"]         = False
        _state["stop_requested"]  = False
        _state["current_article"] = None
        _state["finished_at"]     = datetime.utcnow().isoformat()


def _json_dumps(obj) -> str:
    import json
    return json.dumps(obj, default=str)
