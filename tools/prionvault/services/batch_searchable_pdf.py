"""Background batch service: embed an OCR text layer into scanned PDFs.

Takes every article whose PDF has no text layer yet
(`pdf_searchable = FALSE` and `dropbox_path` set), downloads the file,
runs `ocrmypdf` to produce a visually-identical PDF with an invisible
text layer aligned to the scanned images, and uploads the new file
back to Dropbox (overwrite — Dropbox keeps its own version history,
so the original is recoverable from the web UI for 30+ days).

`ocrmypdf` is idempotent: if a PDF already contains real text it
returns `ExitCode.already_done_ocr` and we just mark `pdf_searchable`
TRUE without uploading anything.

Same single-runner pattern as batch_ocr / batch_extract: one
background thread, stop flag honoured between articles, status polled
every couple of seconds.

Eligibility filter:
    dropbox_path     IS NOT NULL
    AND pdf_searchable = FALSE
    AND extracted_text IS NOT NULL     -- has been through extract/ocr
"""
from __future__ import annotations

import io
import logging
import os
import tempfile
import threading
import time
from datetime import datetime
from typing import Optional

from sqlalchemy import text as sql_text

from ..ingestion.queue import _get_engine

logger = logging.getLogger(__name__)

# Inter-paper sleep — ocrmypdf is CPU-bound, but a tiny pause keeps
# the worker interruptible by the Stop flag without hurting throughput.
_BETWEEN_PAPERS_SLEEP_S = 0.4

_state = {
    "running":           False,
    "started_at":        None,
    "finished_at":       None,
    "stop_requested":    False,
    "eligible_total":    0,
    "processed":         0,    # successfully embedded + uploaded
    "failed":            0,
    "skipped":           0,    # already-searchable detected by ocrmypdf
    "current_article":   None,
    "last_error":        None,
    "bytes_uploaded":    0,
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
                       COUNT(*) FILTER (WHERE pdf_searchable = TRUE)    AS searchable,
                       COUNT(*) FILTER (
                         WHERE dropbox_path IS NOT NULL
                           AND pdf_searchable = FALSE
                           AND extracted_text IS NOT NULL
                       ) AS eligible
                   FROM articles"""
            )).first()
            return {
                "total":      int(row[0] or 0),
                "with_pdf":   int(row[1] or 0),
                "searchable": int(row[2] or 0),
                "eligible":   int(row[3] or 0),
            }
    except Exception as exc:
        logger.warning("batch_searchable: library_stats failed: %s", exc)
        return {"total": 0, "with_pdf": 0, "searchable": 0,
                "eligible": 0, "error": str(exc)[:300]}


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
            "bytes_uploaded":  0,
        })

    _thread = threading.Thread(
        target=_run_batch,
        kwargs={"viewer_user_id": viewer_user_id, "limit": limit},
        name="prionvault-batch-searchable",
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
    from core.dropbox_client import get_client
    client = get_client()
    if client is None:
        raise RuntimeError("Dropbox client unavailable")
    _meta, response = client.files_download(dropbox_path)
    return response.content


def _upload_pdf(dropbox_path: str, content: bytes) -> None:
    """Overwrite the file at `dropbox_path` with `content`. Dropbox keeps
    the previous version in its history so a manual revert is always
    possible from the web UI."""
    from core.dropbox_client import get_client
    import dropbox
    client = get_client()
    if client is None:
        raise RuntimeError("Dropbox client unavailable")
    client.files_upload(
        content, dropbox_path,
        mode=dropbox.files.WriteMode.overwrite,
        autorename=False, mute=True,
    )


def _make_searchable(input_bytes: bytes) -> tuple[Optional[bytes], str]:
    """Run ocrmypdf on `input_bytes`. Returns (new_pdf_bytes, status).
    status is one of:
        "embedded"          — text layer added, file changed
        "already_searchable" — PDF already had text, no upload needed
        "error: <detail>"   — failure (file left untouched in Dropbox)
    """
    try:
        import ocrmypdf
        from ocrmypdf.exceptions import (
            PriorOcrFoundError, EncryptedPdfError,
            InputFileError, MissingDependencyError,
            DigitalSignatureError,
        )
    except Exception as exc:
        return None, f"error: ocrmypdf unavailable: {exc}"

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tin:
        tin.write(input_bytes)
        in_path = tin.name
    out_path = in_path + ".ocr.pdf"

    try:
        try:
            ocrmypdf.ocr(
                input_file=in_path,
                output_file=out_path,
                # Skip pages that already contain text — what we want
                # by default, but the filter at the SQL level should
                # already exclude searchable files. Belt and braces.
                skip_text=True,
                # Preserve the original images / page layout. PDF/A
                # rewrite tends to recompress images; we want the file
                # to come out essentially identical visually.
                output_type="pdf",
                optimize=0,
                # Keep the original orientation: deskew / rotate can
                # subtly move text relative to the image and cause
                # misaligned highlights when searching.
                deskew=False,
                rotate_pages=False,
                clean=False,
                progress_bar=False,
                quiet=True,
                use_threads=True,
                # Use English by default; Tesseract supports adding more
                # via OCRMYPDF_LANG env var (e.g. "eng+spa") if needed.
                language=os.getenv("OCRMYPDF_LANG", "eng"),
            )
        except PriorOcrFoundError:
            return None, "already_searchable"
        except EncryptedPdfError:
            return None, "error: PDF is encrypted (password protected)"
        except DigitalSignatureError:
            return None, "error: PDF is digitally signed (would invalidate signature)"
        except InputFileError as exc:
            return None, f"error: invalid PDF: {str(exc)[:160]}"
        except MissingDependencyError as exc:
            return None, f"error: missing system dependency: {str(exc)[:160]}"
        except Exception as exc:
            return None, f"error: ocrmypdf failed: {str(exc)[:200]}"

        try:
            with open(out_path, "rb") as fh:
                new_bytes = fh.read()
            return new_bytes, "embedded"
        except Exception as exc:
            return None, f"error: could not read output: {exc}"
    finally:
        for p in (in_path, out_path):
            try:
                os.unlink(p)
            except OSError:
                pass


def _run_batch(*, viewer_user_id=None, limit: Optional[int] = None) -> None:
    eng = _get_engine()
    try:
        with eng.connect() as conn:
            row = conn.execute(sql_text(
                """SELECT COUNT(*) FROM articles
                   WHERE dropbox_path IS NOT NULL
                     AND pdf_searchable = FALSE
                     AND extracted_text IS NOT NULL"""
            )).first()
            with _lock:
                _state["eligible_total"] = int(row[0] or 0)
                if limit is not None:
                    _state["eligible_total"] = min(
                        _state["eligible_total"], limit)
    except Exception as exc:
        logger.exception("batch_searchable: count failed")
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
                    f"""SELECT id, title, dropbox_path
                        FROM articles
                        WHERE dropbox_path IS NOT NULL
                          AND pdf_searchable = FALSE
                          AND extracted_text IS NOT NULL
                          {seen_clause}
                        ORDER BY created_at DESC NULLS LAST
                        LIMIT 1"""
                ), params).first()
        except Exception as exc:
            logger.exception("batch_searchable: query failed")
            with _lock:
                _state["last_error"] = f"query failed: {exc}"
            time.sleep(5.0)
            continue

        if row is None:
            break

        article_id, title, dropbox_path = row[0], row[1] or "(sin título)", row[2]
        seen_ids.add(article_id)

        with _lock:
            _state["current_article"] = {
                "id":    str(article_id),
                "title": title[:160],
            }

        try:
            original = _download_pdf(dropbox_path)
        except Exception as exc:
            logger.warning("batch_searchable: download failed for %s: %s",
                           article_id, exc)
            with _lock:
                _state["failed"] += 1
                _state["last_error"] = (
                    f"{title[:80]} — download: {str(exc)[:160]}")
            time.sleep(_BETWEEN_PAPERS_SLEEP_S)
            continue

        new_bytes, status = _make_searchable(original)

        if status == "already_searchable":
            # PDF already had text; mark the column so we don't ask
            # again, but skip the upload entirely.
            try:
                with eng.begin() as conn:
                    conn.execute(sql_text(
                        "UPDATE articles SET pdf_searchable = TRUE WHERE id = :aid"
                    ), {"aid": str(article_id)})
            except Exception as exc:
                logger.warning("batch_searchable: mark-only update failed: %s", exc)
            with _lock:
                _state["skipped"] += 1
            time.sleep(_BETWEEN_PAPERS_SLEEP_S)
            continue

        if status != "embedded" or not new_bytes:
            with _lock:
                _state["failed"] += 1
                _state["last_error"] = f"{title[:80]} — {status}"
            time.sleep(_BETWEEN_PAPERS_SLEEP_S)
            continue

        try:
            _upload_pdf(dropbox_path, new_bytes)
        except Exception as exc:
            logger.warning("batch_searchable: upload failed for %s: %s",
                           article_id, exc)
            with _lock:
                _state["failed"] += 1
                _state["last_error"] = (
                    f"{title[:80]} — upload: {str(exc)[:160]}")
            time.sleep(_BETWEEN_PAPERS_SLEEP_S)
            continue

        try:
            with eng.begin() as conn:
                conn.execute(sql_text(
                    """UPDATE articles
                       SET pdf_searchable = TRUE,
                           pdf_size_bytes = :sz,
                           updated_at     = NOW()
                       WHERE id = :aid"""
                ), {"aid": str(article_id), "sz": len(new_bytes)})
        except Exception as exc:
            logger.exception("batch_searchable: persist failed for %s",
                             article_id)
            with _lock:
                _state["failed"] += 1
                _state["last_error"] = f"persist: {str(exc)[:160]}"
            time.sleep(_BETWEEN_PAPERS_SLEEP_S)
            continue

        # Usage tracking in its own transaction so a failure here can't
        # silently roll back the UPDATE above.
        try:
            with eng.begin() as conn:
                conn.execute(sql_text(
                    """INSERT INTO prionvault_usage
                       (user_id, action, cost_usd, tokens_in, tokens_out,
                        metadata, created_at)
                       VALUES (:uid, 'pdf_make_searchable', 0, 0, 0,
                               :meta::jsonb, NOW())"""
                ), {
                    "uid":  str(viewer_user_id) if viewer_user_id else None,
                    "meta": _json_dumps({
                        "article_id": str(article_id),
                        "size_in":    len(original),
                        "size_out":   len(new_bytes),
                        "via":        "batch",
                    }),
                })
        except Exception as exc:
            logger.warning("batch_searchable: usage insert failed: %s", exc)

        with _lock:
            _state["processed"]      += 1
            _state["bytes_uploaded"] += len(new_bytes)

        time.sleep(_BETWEEN_PAPERS_SLEEP_S)

    with _lock:
        _state["running"]         = False
        _state["stop_requested"]  = False
        _state["current_article"] = None
        _state["finished_at"]     = datetime.utcnow().isoformat()


def _json_dumps(obj) -> str:
    import json
    return json.dumps(obj, default=str)
