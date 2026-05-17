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
import uuid as _uuid_mod
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
    doi  = extraction.doi
    pmid = extraction.pmid

    # ── 2. Dedup BEFORE we hit Dropbox or CrossRef ─────────────────────
    dup_id, reason = find_duplicate(doi=doi, pdf_md5=md5)
    if dup_id is not None:
        logger.info("Job %d duplicate of article %s (%s) — enriching missing PDF metadata",
                    job.id, dup_id, reason)
        enriched = _enrich_duplicate(
            article_id=dup_id, content=content, md5=md5,
            extraction=extraction, doi=doi,
        )
        # Stash the rejected PDF aside. For watch-folder uploads the
        # source already sits on Dropbox and cleanup_source_pdf moves
        # it server-side. For hand-uploaded jobs (Import PDFs modal)
        # there's no Dropbox source, so we explicitly upload the
        # content into the matched paper's _duplicates folder.
        moved_path = None
        if not job.source_dropbox_path:
            moved_path = _stash_duplicate_pdf(content, staged.name, dup_id)

        doi_info  = f" doi={doi}" if doi else ""
        enr_info  = f" | enriched: {','.join(enriched)}" if enriched else ""
        move_info = f" | moved={moved_path}" if moved_path else ""
        ingest_queue.mark_step(job.id, status="duplicate",
                               step=f"duplicate | by {reason}{doi_info}{enr_info}{move_info}",
                               article_id=dup_id,
                               error=f"Already in library (matched by {reason}).")
        ingest_queue.cleanup_source_pdf(job.id, status="duplicate")
        _cleanup_staged(staged)
        return

    # ── 3. Resolve metadata (CrossRef -> PubMed -> title search) ───────
    ingest_queue.mark_step(job.id, status="resolving", step="crossref")
    meta = resolve_metadata(doi=doi, pmid_hint=pmid,
                            title_hint=extraction.title_hint)
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
    # NOTE: volume/issue/pages are NOT in the `articles` table (they exist
    # in the metadata resolver but were never added to the DB schema).
    article_id = _upsert_article(
        doi=final_doi, pubmed_id=pubmed_id, title=title, authors=authors,
        journal=journal, year=year, abstract=abstract,
        pdf_md5=md5, pdf_size_bytes=upload.size_bytes,
        pdf_pages=extraction.pages, extracted_text=extraction.text,
        dropbox_path=upload.dropbox_path, dropbox_link=upload.dropbox_link,
        source=meta_source, added_by=job.created_by,
    )

    id_type  = "doi" if final_doi else ("pmid" if pubmed_id else "md5")
    summary  = f"done | {id_type}={final_doi or pubmed_id or md5[:8]} | {target_path}"
    ingest_queue.mark_step(job.id, status="done", step=summary,
                           article_id=article_id)
    ingest_queue.cleanup_source_pdf(job.id, status="done")
    _cleanup_staged(staged)


def _enrich_duplicate(*, article_id, content: bytes, md5: str,
                       extraction, doi: Optional[str]) -> list[str]:
    """Fill missing PDF metadata on an existing duplicate article row.

    Useful when PrionRead created the article first (metadata only, no PDF)
    and the same paper is later ingested via PrionVault. The row gets
    pdf_pages, pdf_md5, pdf_size_bytes, extracted_text and Dropbox path
    populated for fields that are still NULL — never overwrites curated data.

    Returns the list of fields that were actually updated.
    """
    eng = _get_engine()
    updated: list[str] = []
    try:
        with eng.begin() as conn:
            db_cols = _get_articles_columns(conn)
            cols_to_read = [c for c in
                ("pdf_pages", "pdf_md5", "pdf_size_bytes",
                 "extracted_text", "extraction_status",
                 "dropbox_path", "dropbox_link", "doi")
                if c in db_cols]
            if not cols_to_read:
                return updated

            select_sql = "SELECT " + ", ".join(cols_to_read) + \
                         " FROM articles WHERE id = :aid"
            row = conn.execute(text(select_sql), {"aid": str(article_id)}).first()
            if row is None:
                return updated
            existing = dict(zip(cols_to_read, row))

            # Compute what we can fill in. Only update where existing is NULL/empty.
            candidate: dict = {}
            if "pdf_pages" in db_cols and not existing.get("pdf_pages") and extraction.pages:
                candidate["pdf_pages"] = extraction.pages
            if "pdf_md5" in db_cols and not existing.get("pdf_md5"):
                candidate["pdf_md5"] = md5
            if "pdf_size_bytes" in db_cols and not existing.get("pdf_size_bytes"):
                candidate["pdf_size_bytes"] = len(content)
            if "extracted_text" in db_cols and not existing.get("extracted_text") and extraction.text:
                candidate["extracted_text"] = extraction.text
            if "extraction_status" in db_cols and existing.get("extraction_status") in (None, "pending"):
                candidate["extraction_status"] = "extracted" if extraction.text else "failed"

            # Upload PDF to Dropbox only if the existing row has no path yet.
            if "dropbox_path" in db_cols and not existing.get("dropbox_path"):
                year_for_path = None
                try:
                    year_row = conn.execute(text(
                        "SELECT year FROM articles WHERE id = :aid"
                    ), {"aid": str(article_id)}).first()
                    year_for_path = year_row[0] if year_row else None
                except Exception:
                    pass
                target_path = build_path(doi=existing.get("doi") or doi,
                                         year=year_for_path,
                                         md5=md5, filename_hint=f"{md5}.pdf")
                upload = upload_pdf(content, target_path, overwrite=False)
                if not upload.error or "conflict" in (upload.error or "").lower():
                    candidate["dropbox_path"] = upload.dropbox_path
                    if upload.dropbox_link and "dropbox_link" in db_cols \
                            and not existing.get("dropbox_link"):
                        candidate["dropbox_link"] = upload.dropbox_link
                    if "pdf_size_bytes" in db_cols and not candidate.get("pdf_size_bytes"):
                        candidate["pdf_size_bytes"] = upload.size_bytes

            if candidate:
                set_sql = ", ".join(f"{k} = :{k}" for k in candidate)
                conn.execute(text(
                    f"UPDATE articles SET {set_sql}, updated_at = NOW() WHERE id = :aid"
                ), {**candidate, "aid": str(article_id)})
                updated = sorted(candidate.keys())
    except Exception as exc:
        logger.warning("Duplicate enrichment failed for %s: %s", article_id, exc)
    return updated


def _stash_duplicate_pdf(content: bytes, base_filename: str,
                         dup_article_id) -> Optional[str]:
    """Upload a rejected duplicate PDF into the original's _duplicates folder.

    Target path:
      <year-folder of the matched article>/_duplicates/<safe-filename>

    Falls back to a top-level `_duplicates` folder if the matched
    article has no dropbox_path yet. Returns the resulting Dropbox
    path or None on failure (best-effort — never raises).
    """
    import re as _re
    parent = "/PrionLab tools/PrionVault"
    try:
        eng = _get_engine()
        with eng.connect() as conn:
            row = conn.execute(text(
                "SELECT dropbox_path FROM articles WHERE id = :aid"
            ), {"aid": str(dup_article_id)}).first()
            if row and row[0]:
                parent = row[0].rsplit("/", 1)[0]
    except Exception as exc:
        logger.debug("_stash_duplicate_pdf: parent lookup failed: %s", exc)

    safe_name = _re.sub(r"[^A-Za-z0-9._-]+", "_", base_filename).strip("._-") or "duplicate.pdf"
    target = f"{parent}/_duplicates/{safe_name}"

    try:
        from core.dropbox_client import get_client
        import dropbox
    except Exception as exc:
        logger.warning("_stash_duplicate_pdf: dropbox import failed: %s", exc)
        return None

    client = get_client()
    if client is None:
        logger.warning("_stash_duplicate_pdf: no Dropbox client")
        return None

    try:
        try:
            client.files_create_folder_v2(f"{parent}/_duplicates")
        except dropbox.exceptions.ApiError as exc:
            if "conflict" not in str(exc).lower():
                raise
        result = client.files_upload(
            content, target,
            mode=dropbox.files.WriteMode.add,
            autorename=True,  # append " (1)" etc. on collision
            mute=True,
        )
        return getattr(result, "path_display", None) or target
    except Exception as exc:
        logger.warning("_stash_duplicate_pdf: upload failed for %s: %s", target, exc)
        return None


_articles_col_cache: set | None = None
_articles_col_lock = threading.Lock()


def _get_articles_columns(conn) -> set:
    """Return the set of column names that exist in `articles`. Cached."""
    global _articles_col_cache
    if _articles_col_cache is not None:
        return _articles_col_cache
    with _articles_col_lock:
        if _articles_col_cache is not None:
            return _articles_col_cache
        try:
            rows = conn.execute(text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'articles'"
            )).all()
            _articles_col_cache = {r[0] for r in rows}
        except Exception as exc:
            logger.warning("Could not introspect articles columns: %s", exc)
            _articles_col_cache = set()
        return _articles_col_cache


def _upsert_article(**kw) -> str:
    """Create or update the `articles` row, keyed by DOI when available.

    Returns the article id (UUID as str). Filters `kw` against the actual
    columns in `articles` so unknown fields never cause SQL errors.
    """
    # Drop the worker's `added_by` parameter (it maps to the
    # `added_by_id` SQL column, see below) before composing the SET / VALUES
    # clause so we never accidentally interpolate "added_by" into the SQL.
    added_by_id = kw.pop("added_by", None)
    fields = {k: v for k, v in kw.items() if v is not None}
    doi = fields.get("doi")

    eng = _get_engine()
    with eng.begin() as conn:
        # Introspect once which columns actually exist, then filter fields.
        db_cols = _get_articles_columns(conn)
        fields = {k: v for k, v in fields.items() if k in db_cols}

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
                          if k in _UPDATABLE_FIELDS and k in db_cols}
            if assignable:
                set_sql = ", ".join(f"{k} = :{k}" for k in assignable)
                extra = ""
                if "extraction_status" in db_cols:
                    extra = ", extraction_status = 'extracted', extraction_error = NULL"
                conn.execute(text(
                    f"UPDATE articles SET {set_sql}{extra}, updated_at = NOW() WHERE id = :id"
                ), {**assignable, "id": existing_id})
            return str(existing_id)
        else:
            # INSERT new row. The Sequelize-created `articles` table has no
            # DB-level DEFAULT on `id`, so we must supply a UUID explicitly.
            new_id = str(_uuid_mod.uuid4())
            fixed_cols = ["id", "added_by_id", "created_at", "updated_at"]
            fixed_vals = ":_new_id, :added_by_id, NOW(), NOW()"
            if "extraction_status" in db_cols:
                fixed_cols = ["id", "extraction_status", "added_by_id", "created_at", "updated_at"]
                fixed_vals = ":_new_id, 'extracted', :added_by_id, NOW(), NOW()"
            cols = list(fields.keys()) + fixed_cols
            placeholders = ", ".join(f":{c}" for c in fields.keys()) + f", {fixed_vals}"
            sql = (f"INSERT INTO articles ({', '.join(cols)}) "
                   f"VALUES ({placeholders}) RETURNING id")
            params = dict(fields)
            params["added_by_id"] = (str(added_by_id) if added_by_id else None)
            params["_new_id"] = new_id
            row = conn.execute(text(sql), params).first()
            return str(row[0])


# Columns the ingest worker is allowed to fill on UPDATE. Must match
# columns that actually exist in the `articles` table. Never overwrite
# manually-entered fields; the worker only enriches what is missing.
# Note: volume/issue/pages are NOT in the table — do not add them here.
_UPDATABLE_FIELDS = {
    "pubmed_id", "title", "authors", "journal", "year",
    "abstract",
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
