"""PrionVault ingest worker - consumes jobs from `prionvault_ingest_job`.

Runs as a daemon thread inside the Flask process. One worker pulls one
job at a time and processes the full pipeline:

    queued -> uploading -> extracting -> resolving -> done
                                      -> duplicate
                                      -> failed (after 3 attempts)
"""
from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

from sqlalchemy import text

from .deduplicator import find_duplicate, md5_of
from .dropbox_uploader import build_path, upload_pdf
from .metadata_resolver import resolve_metadata
from .pdf_extractor import extract_pdf
from . import queue as ingest_queue
from .queue import _get_engine

logger = logging.getLogger(__name__)

# Polling interval when the queue is empty.
_IDLE_SLEEP = 4.0
# Short pause between jobs to be polite with CrossRef / PubMed.
_BETWEEN_JOBS_SLEEP = 0.4


def _process_job(job: ingest_queue.Job) -> None:
    """Drive a single job through the pipeline."""
    if not job.staged_path or not Path(job.staged_path).exists():
        ingest_queue.mark_step(job.id, status="failed", step="staged_missing",
                               error="Staged PDF file is missing on disk.")
        return

    staged = Path(job.staged_path)
    try:
        content = staged.read_bytes()
    except Exception as exc:
        ingest_queue.mark_step(job.id, status="failed", step="read_staged",
                               error=f"Cannot read staged PDF: {exc}")
        return
    md5 = md5_of(content)

    # ── 1. Extract text + DOI candidate ────────────────────────────────
    ingest_queue.mark_step(job.id, status="extracting", step="pdfplumber")
    extraction = extract_pdf(content)
    if extraction.error and not extraction.text:
        ingest_queue.bump_attempt_or_fail(job.id,
            f"PDF extraction failed: {extraction.error}")
        return
    doi = extraction.doi

    # ── 2. Dedup BEFORE we hit Dropbox or CrossRef ─────────────────────
    dup_id, reason = find_duplicate(doi=doi, pdf_md5=md5)
    if dup_id is not None:
        logger.info("Job %d duplicate of article %s (%s) — skipping ingest",
                    job.id, dup_id, reason)
        doi_info = f" doi={doi}" if doi else ""
        ingest_queue.mark_step(job.id, status="duplicate",
                               step=f"duplicate | by {reason}{doi_info}",
                               article_id=dup_id,
                               error=f"Already in library (matched by {reason}).")
        _cleanup_staged(staged)
        return

    # ── 3. Resolve metadata (CrossRef -> PubMed -> title search) ───────
    ingest_queue.mark_step(job.id, status="resolving", step="crossref")
    meta = resolve_metadata(doi=doi, title_hint=extraction.title_hint)
    final_doi  = (meta.doi if meta and meta.doi else doi)
    title      = (meta.title if meta else None) or (extraction.title_hint or staged.stem)
    year       = (meta.year if meta else None)
    authors    = (meta.authors if meta else None)
    journal    = (meta.journal if meta else None)
    abstract   = (meta.abstract if meta else None)
    pubmed_id  = (meta.pubmed_id if meta else None)
    volume     = (meta.volume if meta else None)
    issue      = (meta.issue if meta else None)
    pages      = (meta.pages if meta else None)
    meta_source = (meta.source if meta else "no_metadata")

    # ── 4. Upload to Dropbox ───────────────────────────────────────────
    ingest_queue.mark_step(job.id, status="uploading", step="dropbox_upload")
    target_path = build_path(doi=final_doi, year=year, md5=md5,
                             filename_hint=staged.name)
    upload = upload_pdf(content, target_path, overwrite=False)
    if upload.error and "conflict" not in upload.error.lower():
        # Hard error — couldn't upload at all. Retry.
        ingest_queue.bump_attempt_or_fail(job.id,
            f"Dropbox upload failed: {upload.error}")
        return
    # If a "conflict" came back it means the path already exists. That
    # can happen when an earlier job uploaded the same DOI. Treat as OK
    # but log; the dedup check above should catch it normally.

    # ── 5. Insert / update the article row ─────────────────────────────
    article_id = _upsert_article(
        doi=final_doi, pubmed_id=pubmed_id, title=title, authors=authors,
        journal=journal, year=year, volume=volume, issue=issue, pages=pages,
        abstract=abstract,
        pdf_md5=md5, pdf_size_bytes=upload.size_bytes,
        pdf_pages=extraction.pages, extracted_text=extraction.text,
        dropbox_path=upload.dropbox_path, dropbox_link=upload.dropbox_link,
        source=meta_source, added_by=job.created_by,
    )

    year_str = str(year) if year else "unknown"
    id_type  = "doi" if final_doi else ("pmid" if pubmed_id else "md5")
    summary  = f"done | {id_type}={final_doi or pubmed_id or md5[:8]} | {target_path}"
    ingest_queue.mark_step(job.id, status="done", step=summary,
                           article_id=article_id)
    _cleanup_staged(staged)


def _upsert_article(**kw) -> str:
    """Create or update the `articles` row, keyed by DOI when available.

    Returns the article id (UUID as str).
    """
    # Drop the worker's `added_by` parameter (it maps to the
    # `added_by_id` SQL column, see below) before composing the SET / VALUES
    # clause so we never accidentally interpolate "added_by" into the SQL.
    added_by_id = kw.pop("added_by", None)
    fields = {k: v for k, v in kw.items() if v is not None}
    doi = fields.get("doi")

    eng = _get_engine()
    with eng.begin() as conn:
        # If we have a DOI, see if a row already exists.
        existing_id = None
        if doi:
            row = conn.execute(text(
                "SELECT id FROM articles WHERE lower(doi) = :d LIMIT 1"
            ), {"d": doi.lower()}).first()
            if row:
                existing_id = row[0]

        if existing_id:
            # UPDATE only the columns that came back populated; never blank
            # out fields the user / PrionRead may have curated.
            assignable = {k: v for k, v in fields.items()
                          if k in _UPDATABLE_FIELDS}
            if assignable:
                set_sql = ", ".join(f"{k} = :{k}" for k in assignable)
                conn.execute(text(
                    f"UPDATE articles SET {set_sql}, "
                    f"  extraction_status = 'extracted', "
                    f"  extraction_error  = NULL, "
                    f"  updated_at        = NOW() "
                    f" WHERE id = :id"
                ), {**assignable, "id": existing_id})
            return str(existing_id)
        else:
            # INSERT new row. UUID is auto-generated by the table default.
            cols = list(fields.keys()) + ["extraction_status", "added_by_id",
                                          "created_at", "updated_at"]
            placeholders = ", ".join(f":{c}" for c in fields.keys()) + \
                           ", 'extracted', :added_by_id, NOW(), NOW()"
            sql = (f"INSERT INTO articles ({', '.join(cols)}) "
                   f"VALUES ({placeholders}) RETURNING id")
            params = dict(fields)
            params["added_by_id"] = (str(added_by_id) if added_by_id else None)
            row = conn.execute(text(sql), params).first()
            return str(row[0])


# Columns the ingest worker is allowed to fill on UPDATE. We never
# overwrite manually-entered fields; the worker only enriches what is
# missing on subsequent re-ingests.
_UPDATABLE_FIELDS = {
    "pubmed_id", "title", "authors", "journal", "year",
    "volume", "issue", "pages", "abstract",
    "pdf_md5", "pdf_size_bytes", "pdf_pages", "extracted_text",
    "dropbox_path", "dropbox_link", "source",
}


def _cleanup_staged(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except Exception:
        pass


# ── Public entrypoint: start a daemon worker thread ────────────────────
_worker_thread: Optional[threading.Thread] = None
_worker_stop = threading.Event()


def start_worker() -> Optional[threading.Thread]:
    """Spawn the background worker if not already running.

    Idempotent. Returns the thread handle (or None if disabled).
    """
    global _worker_thread
    if os.environ.get("PRIONVAULT_WORKER_DISABLED", "").strip() in ("1", "true", "True"):
        logger.info("PrionVault worker disabled via env var.")
        return None
    if _worker_thread and _worker_thread.is_alive():
        return _worker_thread

    _worker_stop.clear()
    _worker_thread = threading.Thread(target=_run_loop,
                                      name="prionvault-ingest-worker",
                                      daemon=True)
    _worker_thread.start()
    logger.info("PrionVault ingest worker started.")
    return _worker_thread


def stop_worker(timeout: float = 5.0) -> None:
    _worker_stop.set()
    if _worker_thread:
        _worker_thread.join(timeout=timeout)


def _run_loop() -> None:
    # Small initial delay so app boot finishes before we start hammering DB.
    time.sleep(3.0)
    while not _worker_stop.is_set():
        try:
            job = ingest_queue.claim_next()
        except Exception as exc:
            logger.warning("PrionVault worker — claim_next failed: %s", exc)
            time.sleep(_IDLE_SLEEP)
            continue

        if job is None:
            time.sleep(_IDLE_SLEEP)
            continue

        try:
            _process_job(job)
        except Exception as exc:
            logger.exception("PrionVault worker — unexpected error on job %d", job.id)
            try:
                ingest_queue.bump_attempt_or_fail(job.id, str(exc))
            except Exception:
                pass

        time.sleep(_BETWEEN_JOBS_SLEEP)
