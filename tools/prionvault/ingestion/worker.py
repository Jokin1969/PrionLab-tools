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
from sqlalchemy.exc import OperationalError, DBAPIError, DisconnectionError

from .deduplicator import find_duplicate, md5_of
from .dropbox_uploader import build_path, upload_pdf
from .metadata_resolver import resolve_metadata
from .pdf_extractor import extract_pdf
from . import queue as ingest_queue
from .queue import _get_engine

logger = logging.getLogger(__name__)


# Public link prefix used in completion emails. Lives here (not in
# email_ingest.py) because the worker is what actually generates the
# notification — by the time we're here we've forgotten which path
# enqueued the job.
_PUBLIC_BASE_URL = os.environ.get(
    "PRIONVAULT_PUBLIC_BASE_URL",
    "https://web-production-5517e.up.railway.app",
)
# Hard cap on the PDF size we attach to the outgoing reply. Most SMTP
# providers reject anything north of 25 MB; we stop short of that on
# purpose. When the PDF is bigger we send the link-only variant.
_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024


# When Postgres goes away (Railway redeploy, upstream outage, etc.)
# every DB call fails. Don't burn through MAX_ATTEMPTS on the active
# job and don't fire a Sentry alert per attempt — wait, then probe
# again. The worker thread stays alive; new jobs pile up on the queue
# until the DB comes back.
_DB_DOWN_BACKOFF_S = 30

# Polling interval when the queue is empty.
_IDLE_SLEEP = 4.0
# Short pause between jobs to be polite with CrossRef / PubMed.
_BETWEEN_JOBS_SLEEP = 0.4


def _process_job(job: ingest_queue.Job) -> None:
    """Drive a single job through the pipeline."""
    if not job.staged_path or not Path(job.staged_path).exists():
        ingest_queue.mark_step(job.id, status="failed", step="staged_missing",
                               error="Staged PDF file is missing on disk.")
        _notify_outcome(job, status="failed", pdf_content=None,
                        error="No encontré el PDF en el servidor (staged_missing). "
                              "Vuelve a enviarlo por email.")
        return

    staged = Path(job.staged_path)
    try:
        content = staged.read_bytes()
    except Exception as exc:
        ingest_queue.mark_step(job.id, status="failed", step="read_staged",
                               error=f"Cannot read staged PDF: {exc}")
        _notify_outcome(job, status="failed", pdf_content=None,
                        error=f"No pude leer el PDF en disco: {exc}")
        return
    md5 = md5_of(content)

    # ── 1. Extract text + DOI candidate ────────────────────────────────
    ingest_queue.mark_step(job.id, status="extracting", step="pdfplumber")
    extraction = extract_pdf(content)
    # Distinguish "no text in the PDF" (scan, very common for pre-2000
    # papers — Neurology, J. Virol., Brain, etc.) from "extractor blew
    # up on a malformed file". A scan is NOT a failure: we still want
    # the PDF in the catalogue with pdf_is_scan=true so batch_ocr can
    # pick it up later and recover the text via Tesseract. A real
    # crash on a corrupt file still goes through the retry/fail path.
    is_scan = (extraction.error == "no_text_extracted" and not extraction.text)
    if extraction.error and not extraction.text and not is_scan:
        _bump_or_fail(job, content,
                      error=f"PDF extraction failed: {extraction.error}",
                      user_msg=f"No se pudo extraer texto del PDF: {extraction.error}")
        return
    doi  = extraction.doi
    pmid = extraction.pmid

    # ── 2. Dedup BEFORE we hit Dropbox or CrossRef ─────────────────────
    # Pass PMID too: a paper imported from the PubMed inventory often
    # arrives with a PMID but no DOI, so a subsequent "Import PDFs"
    # upload must rejoin them by PMID. Without this branch we'd
    # create a duplicate article and leave the inventory row
    # stranded on "⏳ PDF pendiente". See deduplicator.find_duplicate.
    dup_id, reason = find_duplicate(doi=doi, pmid=pmid, pdf_md5=md5)
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
        _notify_outcome(job, status="duplicate", article_id=dup_id,
                        pdf_content=content, duplicate_reason=reason)
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
        _bump_or_fail(job, content,
                      error=f"Dropbox upload failed: {upload.error}",
                      user_msg=f"No pude subir el PDF a Dropbox: {upload.error}")
        return
    # If a "conflict" came back it means the path already exists. That
    # can happen when an earlier job uploaded the same DOI. Treat as OK
    # but log; the dedup check above should catch it normally.

    # ── 5. Insert / update the article row ─────────────────────────────
    # NOTE: volume/issue/pages are NOT in the `articles` table (they exist
    # in the metadata resolver but were never added to the DB schema).
    try:
        article_id = _upsert_article(
            doi=final_doi, pubmed_id=pubmed_id, title=title, authors=authors,
            journal=journal, year=year, abstract=abstract,
            pdf_md5=md5, pdf_size_bytes=upload.size_bytes,
            pdf_pages=extraction.pages, extracted_text=extraction.text,
            dropbox_path=upload.dropbox_path, dropbox_link=upload.dropbox_link,
            source=meta_source, added_by=job.created_by,
            pdf_is_scan=is_scan,
        )
    except Exception as exc:
        # Most common cause in the wild: StringDataRightTruncation on
        # articles.title when migration 022/023 hasn't taken effect on
        # production. Mark the job failed with a clear reason instead
        # of letting the uncaught exception bubble into Sentry on
        # every long-titled paper. The admin can retry the job once
        # the migration applies.
        msg = str(exc)[:300]
        if "StringDataRightTruncation" in type(exc).__name__ \
           or "value too long" in msg.lower():
            reason = ("Esquema desactualizado: alguna columna sigue siendo "
                      "VARCHAR(255). Aplica la migración 023 (force-rerun) "
                      "y reintenta el job. — " + msg)
        else:
            reason = f"Article insert/update failed: {msg}"
        logger.warning("worker: _upsert_article failed for job %d — %s",
                       job.id, msg)
        ingest_queue.mark_step(job.id, status="failed",
                               step="upsert_article", error=reason)
        _notify_outcome(job, status="failed", pdf_content=content,
                        error=reason)
        return

    id_type  = "doi" if final_doi else ("pmid" if pubmed_id else "md5")
    scan_tag = " | scan-pending-ocr" if is_scan else ""
    summary  = f"done | {id_type}={final_doi or pubmed_id or md5[:8]} | {target_path}{scan_tag}"
    ingest_queue.mark_step(job.id, status="done", step=summary,
                           article_id=article_id)
    _notify_outcome(
        job, status="done", article_id=article_id, pdf_content=content,
        is_scan=is_scan,
        article_meta={
            "title":      title,
            "doi":        final_doi,
            "pubmed_id":  pubmed_id,
            "year":       year,
            "authors":    authors,
            "journal":    journal,
        },
    )
    ingest_queue.cleanup_source_pdf(job.id, status="done")
    _cleanup_staged(staged)

    # Auto-link the new article to any PrionPack collection that cites
    # its DOI. Best-effort — a failure here must never poison the job
    # (the ingest is already complete and the row is in the catalog).
    if final_doi:
        try:
            from ..services.prionpack_sync import sync_doi
            sync_doi(final_doi)
        except Exception as exc:
            logger.warning("worker: prionpack sync_doi failed for %s: %s",
                           final_doi, exc)


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
                # Leave at 'pending' when there's no text — the article
                # is still a valid scan, batch_ocr will lift it later.
                if extraction.text:
                    candidate["extraction_status"] = "extracted"

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

    `pdf_is_scan` (bool, optional) flags PDFs without an extractable
    text layer. When True, the row is inserted with
    extraction_status='pending' so batch_ocr later sees it as eligible;
    when False, the status goes straight to 'extracted'.
    """
    # Drop the worker's `added_by` parameter (it maps to the
    # `added_by_id` SQL column, see below) before composing the SET / VALUES
    # clause so we never accidentally interpolate "added_by" into the SQL.
    added_by_id = kw.pop("added_by", None)
    is_scan = bool(kw.pop("pdf_is_scan", False))
    # We pop here so it's not double-applied via `fields`; we put it
    # back into `fields` below as a real column when the schema supports it.
    fields = {k: v for k, v in kw.items() if v is not None}
    if is_scan:
        fields["pdf_is_scan"] = True
    doi = fields.get("doi")
    desired_status = "pending" if is_scan else "extracted"

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
                    # Never downgrade an already-extracted article back
                    # to 'pending' just because this re-ingest happens
                    # to be a scan: a curated text layer on the row
                    # wins. Leave extraction_status untouched in that
                    # case (the COALESCE-ish read in _enrich_duplicate
                    # is what handles that scenario; here we only set
                    # the status when the worker actually has text).
                    if not is_scan:
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
                fixed_vals = (f":_new_id, '{desired_status}', :added_by_id, "
                              "NOW(), NOW()")
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
    "pdf_is_scan",
}


def _cleanup_staged(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except Exception:
        pass


# ── Email notification on terminal job status ──────────────────────────

def _bump_or_fail(job: ingest_queue.Job, content: Optional[bytes],
                  *, error: str, user_msg: str) -> str:
    """Wrap ingest_queue.bump_attempt_or_fail so the email-ingest path
    gets a final notification when retries are exhausted.

    Re-queue paths (status='queued') stay silent — the worker will try
    again and the user only gets contacted on the final outcome.
    """
    new_status = ingest_queue.bump_attempt_or_fail(job.id, error)
    if new_status == "failed":
        _notify_outcome(job, status="failed", pdf_content=content,
                        error=user_msg)
    return new_status


def _notify_outcome(job: ingest_queue.Job, *, status: str,
                    pdf_content: Optional[bytes],
                    article_id: Optional[str] = None,
                    article_meta: Optional[dict] = None,
                    duplicate_reason: Optional[str] = None,
                    is_scan: bool = False,
                    error: Optional[str] = None) -> None:
    """Send the operator who emailed in a final reply with the result.

    No-op when the job didn't carry a notify_email (i.e. it didn't come
    from the email-ingest daemon — DOI-add, Import-PDFs, Dropbox scan
    etc. fall through this silently).

    `status` is the job's terminal status: done / duplicate / failed.
    The body and subject change per status. PDF is attached when we
    still have its bytes in memory and it's under the SMTP size cap.
    """
    to = (job.notify_email or "").strip()
    if not to:
        return

    orig_subject = (job.notify_subject or "").strip() or "(sin asunto)"
    short_subj = orig_subject[:80]

    # Resolve article fields if missing (duplicate path comes here
    # without article_meta, so look up the row).
    meta = dict(article_meta or {})
    if (not meta or not meta.get("title")) and article_id:
        meta = {**_load_article_summary(article_id), **meta}

    if status == "done":
        if is_scan:
            subject = f"[PrionVault] ✓ Ingerido (escaneo, OCR pendiente) — {meta.get('title') or short_subj}"
            body    = _compose_scan_body(meta, article_id, orig_subject)
        else:
            subject = f"[PrionVault] ✓ Ingerido — {meta.get('title') or short_subj}"
            body    = _compose_done_body(meta, article_id, orig_subject)
    elif status == "duplicate":
        subject = f"[PrionVault] Ya estaba en la base — {meta.get('title') or short_subj}"
        body    = _compose_duplicate_body(meta, article_id, orig_subject,
                                          duplicate_reason)
    else:  # failed
        subject = f"[PrionVault] ✗ No se pudo ingerir — {short_subj}"
        body    = _compose_failed_body(orig_subject, error)

    attachments: list[tuple[str, bytes, str]] = []
    if pdf_content and len(pdf_content) <= _MAX_ATTACHMENT_BYTES:
        fname = Path(job.pdf_filename or "article.pdf").name
        # `pdf_filename` is the staging path; strip the timestamp prefix
        # the queue prepended so the attachment looks like the user's
        # original upload.
        if "_" in fname and fname.split("_", 1)[0].isdigit():
            fname = fname.split("_", 1)[1]
        attachments.append((fname or "article.pdf",
                            pdf_content, "application/pdf"))

    try:
        from core.smtp_client import send_email_with_attachments
        send_email_with_attachments(to, subject, body, attachments)
    except Exception as exc:
        logger.warning("worker: notify-email to %s failed (%s)", to, exc)


def _load_article_summary(article_id) -> dict:
    """Pull (title, doi, pubmed_id, year, authors, journal, dropbox_link)
    out of the articles row. Best-effort — returns {} on failure or
    when the row is gone."""
    if not article_id:
        return {}
    eng = _get_engine()
    try:
        with eng.connect() as conn:
            row = conn.execute(text(
                "SELECT title, doi, pubmed_id, year, authors, journal, "
                "       dropbox_link "
                "FROM articles WHERE id = :aid"
            ), {"aid": str(article_id)}).first()
    except Exception as exc:
        logger.debug("_load_article_summary failed for %s: %s",
                     article_id, exc)
        return {}
    if not row:
        return {}
    return {
        "title":        row[0],
        "doi":          row[1],
        "pubmed_id":    row[2],
        "year":         row[3],
        "authors":      row[4],
        "journal":      row[5],
        "dropbox_link": row[6],
    }


def _fmt_authors(authors) -> str:
    """authors is either a JSON list (CrossRef) or a string. Show at
    most the first three, then 'et al'."""
    if not authors:
        return ""
    if isinstance(authors, str):
        return authors
    if isinstance(authors, list):
        names = []
        for a in authors[:3]:
            if isinstance(a, dict):
                given = a.get("given") or a.get("first") or ""
                family = a.get("family") or a.get("last") or ""
                names.append((given + " " + family).strip() or
                             a.get("name") or "")
            else:
                names.append(str(a))
        names = [n for n in names if n]
        if not names:
            return ""
        out = ", ".join(names)
        if len(authors) > 3:
            out += " et al."
        return out
    return str(authors)


def _article_link(article_id) -> str:
    if not article_id:
        return _PUBLIC_BASE_URL + "/prionvault/"
    # The SPA reads ?open=<id> on load and opens the article detail
    # modal automatically. There is no /article/<id> Flask route.
    return f"{_PUBLIC_BASE_URL}/prionvault/?open={article_id}"


def _compose_done_body(meta: dict, article_id, orig_subject: str) -> str:
    lines = [
        "Hola,",
        "",
        f"Tu artículo ya está en PrionVault. Lo encontré, lo subí a Dropbox,",
        "extraje el texto, indexé para búsqueda y lo resumí.",
        "",
        "DATOS DEL ARTÍCULO",
        "──────────────────",
    ]
    if meta.get("title"):
        lines.append(f"  Título    : {meta['title']}")
    authors = _fmt_authors(meta.get("authors"))
    if authors:
        lines.append(f"  Autores   : {authors}")
    if meta.get("journal"):
        lines.append(f"  Revista   : {meta['journal']}")
    if meta.get("year"):
        lines.append(f"  Año       : {meta['year']}")
    if meta.get("doi"):
        lines.append(f"  DOI       : {meta['doi']}")
    if meta.get("pubmed_id"):
        lines.append(f"  PubMed    : {meta['pubmed_id']}")
    lines += [
        "",
        f"Verlo en PrionVault: {_article_link(article_id)}",
        "",
        "(Adjunto va el PDF original que enviaste.)",
        "",
        f"Re: {orig_subject}",
        "",
        "— PrionVault",
    ]
    return "\n".join(lines)


def _compose_duplicate_body(meta: dict, article_id, orig_subject: str,
                            reason: Optional[str]) -> str:
    lines = [
        "Hola,",
        "",
        "Este artículo YA estaba en PrionVault — no lo he añadido por",
        f"duplicado (coincidencia por {reason or 'DOI o md5'}). Aquí",
        "tienes el registro existente:",
        "",
        "ARTÍCULO YA EN LA BASE",
        "──────────────────────",
    ]
    if meta.get("title"):
        lines.append(f"  Título    : {meta['title']}")
    authors = _fmt_authors(meta.get("authors"))
    if authors:
        lines.append(f"  Autores   : {authors}")
    if meta.get("journal"):
        lines.append(f"  Revista   : {meta['journal']}")
    if meta.get("year"):
        lines.append(f"  Año       : {meta['year']}")
    if meta.get("doi"):
        lines.append(f"  DOI       : {meta['doi']}")
    if meta.get("pubmed_id"):
        lines.append(f"  PubMed    : {meta['pubmed_id']}")
    lines += [
        "",
        f"Verlo en PrionVault: {_article_link(article_id)}",
        "",
        f"Re: {orig_subject}",
        "",
        "— PrionVault",
    ]
    return "\n".join(lines)


def _compose_scan_body(meta: dict, article_id, orig_subject: str) -> str:
    lines = [
        "Hola,",
        "",
        "Recibí el PDF y lo añadí al catálogo, pero NO tenía capa de texto",
        "extraíble (es un escaneo — típico en papers anteriores al año 2000).",
        "",
        "El artículo ya está en PrionVault con el PDF subido a Dropbox, pero",
        "se quedará sin texto indexado, sin DOI/PMID resueltos y sin resumen",
        "IA hasta que se procese con OCR.",
        "",
        "Para extraer el texto: PrionVault → OCR → Iniciar batch (procesa",
        "todos los artículos pendientes vía Tesseract).",
        "",
    ]
    if meta.get("title"):
        lines.append(f"  Título provisional: {meta['title']}")
    lines += [
        "",
        f"Verlo en PrionVault: {_article_link(article_id)}",
        "",
        "(Adjunto va el PDF original que enviaste.)",
        "",
        f"Re: {orig_subject}",
        "",
        "— PrionVault",
    ]
    return "\n".join(lines)


def _compose_failed_body(orig_subject: str, error: Optional[str]) -> str:
    return "\n".join([
        "Hola,",
        "",
        "No pude procesar el PDF que enviaste. Detalle del fallo:",
        "",
        f"  {error or 'error desconocido'}",
        "",
        "El PDF original va adjunto por si quieres reintentar manualmente",
        "desde PrionVault → Import PDFs.",
        "",
        f"Re: {orig_subject}",
        "",
        "— PrionVault",
    ])


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
        except (OperationalError, DBAPIError, DisconnectionError) as exc:
            # Postgres unreachable (most likely an upstream restart).
            # Log at warning so Sentry doesn't pile up alerts per loop
            # tick, then back off and try again — there's nothing for
            # the worker to do until the DB recovers.
            logger.warning(
                "PrionVault worker — DB unreachable on claim_next, "
                "backing off %ds: %s",
                _DB_DOWN_BACKOFF_S, str(exc).splitlines()[0][:200],
            )
            time.sleep(_DB_DOWN_BACKOFF_S)
            continue
        except Exception as exc:
            logger.warning("PrionVault worker — claim_next failed: %s", exc)
            time.sleep(_IDLE_SLEEP)
            continue

        if job is None:
            time.sleep(_IDLE_SLEEP)
            continue

        try:
            _process_job(job)
        except (OperationalError, DBAPIError, DisconnectionError) as exc:
            # DB died mid-job. We can't even bump_attempt_or_fail (that
            # also writes to Postgres). Leave the job in 'uploading'
            # status — when the DB comes back, the operator can re-queue
            # it from the Ingest queue UI's "Retry" button. Don't fire
            # Sentry: this is a known external condition, not a bug.
            logger.warning(
                "PrionVault worker — DB unreachable mid-job %d, "
                "leaving in 'uploading' for manual retry: %s",
                job.id, str(exc).splitlines()[0][:200],
            )
            time.sleep(_DB_DOWN_BACKOFF_S)
            continue
        except Exception as exc:
            logger.exception("PrionVault worker — unexpected error on job %d", job.id)
            try:
                ingest_queue.bump_attempt_or_fail(job.id, str(exc))
            except Exception:
                pass

        time.sleep(_BETWEEN_JOBS_SLEEP)
