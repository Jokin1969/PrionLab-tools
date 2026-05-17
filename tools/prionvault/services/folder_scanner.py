"""Single-source implementation of the Dropbox-folder scan.

Both the HTTP endpoint (/api/ingest/scan-folder) and the background
auto-scan daemon call into here. Keeps the dedupe-by-source-path,
chunking and error shape consistent.
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import text as sql_text

from ..ingestion import queue as ingest_queue
from ..ingestion.queue import _get_engine

logger = logging.getLogger(__name__)


DEFAULT_WATCH_FOLDER = "/PrionLab tools/PDFs"


def scan_folder_into_queue(*, folder: str = DEFAULT_WATCH_FOLDER,
                           per_call_limit: int = 50,
                           user_id=None) -> dict:
    """List PDFs in `folder` and enqueue up to `per_call_limit` of them.

    Skips files that already have an in-flight ingest job (so calling
    this in a loop without waiting for the worker doesn't double-enqueue).

    Returns a dict with keys: ok, error?, detail?, folder, scanned,
    pdfs_found, already_queued, queued, skipped, skipped_detail,
    job_ids, remaining.
    """
    folder = (folder or DEFAULT_WATCH_FOLDER).strip()
    if not folder.startswith("/"):
        folder = "/" + folder
    folder = folder.rstrip("/") or "/"
    per_call_limit = max(1, min(100, per_call_limit))

    try:
        from core.dropbox_client import get_client
        import dropbox
    except Exception as exc:
        return {"ok": False, "error": "dropbox_unavailable",
                "detail": str(exc)[:200]}

    client = get_client()
    if client is None:
        return {"ok": False, "error": "dropbox_not_configured"}

    try:
        result  = client.files_list_folder(folder)
        entries = list(result.entries)
        while result.has_more:
            result = client.files_list_folder_continue(result.cursor)
            entries.extend(result.entries)
    except dropbox.exceptions.ApiError as exc:
        return {"ok": False, "error": "folder_not_accessible",
                "folder": folder, "detail": str(exc)[:200]}
    except Exception as exc:
        logger.exception("scan-folder: list failed for %s", folder)
        return {"ok": False, "error": "list_failed",
                "detail": str(exc)[:200]}

    pdf_entries = [e for e in entries
                   if isinstance(e, dropbox.files.FileMetadata)
                   and e.name.lower().endswith(".pdf")]

    # Skip PDFs that already have an in-flight ingest job (queued /
    # uploading / extracting / resolving / indexing). Without this the
    # worker deletes the file only AFTER it finishes — so back-to-back
    # scans (or a chunked client loop) would re-download and re-enqueue
    # the same files until the worker caught up.
    in_flight_paths: set = set()
    if pdf_entries:
        candidate_paths = [e.path_display for e in pdf_entries]
        eng = _get_engine()
        with eng.connect() as conn:
            rows = conn.execute(sql_text("""
                SELECT source_dropbox_path
                  FROM prionvault_ingest_job
                 WHERE source_dropbox_path = ANY(:paths)
                   AND status IN
                       ('queued', 'uploading', 'extracting',
                        'resolving', 'indexing')
            """), {"paths": candidate_paths}).all()
            in_flight_paths = {r[0] for r in rows if r[0]}

    fresh_entries = [e for e in pdf_entries
                     if e.path_display not in in_flight_paths]
    total_pdfs     = len(pdf_entries)
    already_queued = len(in_flight_paths)
    fresh_total    = len(fresh_entries)
    to_process     = fresh_entries[:per_call_limit]
    remaining      = fresh_total - len(to_process)

    queued_ids: list[int] = []
    skipped:    list[dict] = []
    for entry in to_process:
        try:
            _meta, response = client.files_download(entry.path_lower)
            content = response.content
        except Exception as exc:
            skipped.append({"path": entry.path_display,
                            "error": f"download failed: {str(exc)[:160]}"})
            continue
        try:
            jid = ingest_queue.enqueue_pdf(
                content=content,
                filename=entry.name,
                user_id=user_id,
                source_dropbox_path=entry.path_display,
            )
            queued_ids.append(jid)
        except Exception as exc:
            skipped.append({"path": entry.path_display,
                            "error": f"enqueue failed: {str(exc)[:160]}"})

    return {
        "ok":             True,
        "folder":         folder,
        "scanned":        len(entries),
        "pdfs_found":     total_pdfs,
        "already_queued": already_queued,
        "queued":         len(queued_ids),
        "skipped":        len(skipped),
        "skipped_detail": skipped[:20],
        "job_ids":        queued_ids,
        "remaining":      remaining,
    }
