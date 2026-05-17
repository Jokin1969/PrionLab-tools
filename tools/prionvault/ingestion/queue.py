"""Persistent ingest queue — a thin wrapper over `prionvault_ingest_job`.

Why persistent (BD-backed) instead of in-memory:
  - Railway can restart the container at any time. An in-memory queue
    loses work on restart; the BD-backed one resumes seamlessly.
  - The user sees real progress in the UI even after a deploy.
  - `SELECT ... FOR UPDATE SKIP LOCKED` lets multiple workers (current
    or future) pull jobs without stepping on each other.

Why we build our own engine:
  - We try the project-wide singleton from `database.config.db` first,
    but fall back to a fresh engine built from $DATABASE_URL if the
    singleton is None for any reason. This makes the queue robust to
    import-order quirks during gunicorn worker boot.

Lifecycle of a job:
    queued
      -> uploading       (worker picked it up, uploading to Dropbox)
      -> extracting      (extracting text + page count from the PDF)
      -> resolving       (calling CrossRef / PubMed for metadata)
      -> indexing        (Phase 4 — embeddings; not yet active)
      -> done            (Article row created / updated)
      -> duplicate       (an existing article matched by DOI or MD5)
      -> failed          (error after `_MAX_ATTEMPTS` retries)
"""
from __future__ import annotations

import logging
import os
import tempfile
import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import List, Optional
from uuid import UUID

from sqlalchemy import create_engine, text

logger = logging.getLogger(__name__)

_MAX_ATTEMPTS = 3
# Where the worker stages PDFs on disk before processing. Resolution
# order, first existing/writable wins:
#   1. PRIONVAULT_STAGING_DIR if set explicitly.
#   2. /data/prionvault_staging  ← Railway persistent volume mount.
#                                  Survives container restarts / deploys.
#   3. /tmp/prionvault_staging   ← ephemeral fallback for dev / no volume.
# Anything staged in (3) is at risk of disappearing on the next
# Railway redeploy, which is exactly the "staged_missing" failure mode.
def _resolve_staging_dir() -> Path:
    explicit = os.environ.get("PRIONVAULT_STAGING_DIR")
    if explicit:
        return Path(explicit)
    persistent = Path("/data")
    if persistent.exists() and os.access(persistent, os.W_OK):
        return persistent / "prionvault_staging"
    return Path(tempfile.gettempdir()) / "prionvault_staging"

_STAGING_DIR = _resolve_staging_dir()
_STAGING_DIR.mkdir(parents=True, exist_ok=True)
logger.info("PrionVault staging dir: %s", _STAGING_DIR)


# ── Engine bootstrap (resilient) ───────────────────────────────────────────
_local_engine = None
_engine_lock = threading.Lock()


def _normalise_url(url: str) -> str:
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    return url


def _build_url_from_components() -> Optional[str]:
    """Some Railway plans inject PG* components instead of (or in
    addition to) DATABASE_URL. Build the URL ourselves if we have them."""
    host = os.environ.get("PGHOST") or os.environ.get("POSTGRES_HOST")
    user = os.environ.get("PGUSER") or os.environ.get("POSTGRES_USER")
    pwd  = os.environ.get("PGPASSWORD") or os.environ.get("POSTGRES_PASSWORD")
    db_  = os.environ.get("PGDATABASE") or os.environ.get("POSTGRES_DB") or "railway"
    port = os.environ.get("PGPORT") or os.environ.get("POSTGRES_PORT") or "5432"
    if host and user and pwd:
        from urllib.parse import quote_plus
        return (f"postgresql://{quote_plus(user)}:{quote_plus(pwd)}"
                f"@{host}:{port}/{db_}")
    return None


def _discover_database_url() -> str:
    """Try every place the URL might live. Return empty if truly nothing."""
    raw = (os.environ.get("DATABASE_URL")
           or os.environ.get("POSTGRES_URL")
           or os.environ.get("PG_URL")
           or "").strip()
    if raw:
        return _normalise_url(raw)
    built = _build_url_from_components()
    if built:
        return built
    # Last resort: look at the singleton, in case it captured a URL we
    # cannot see directly (e.g. injected through python-dotenv at boot).
    try:
        from database.config import db as _db
        url = getattr(_db, "database_url", "") or ""
        if url:
            return _normalise_url(url)
    except Exception:
        pass
    return ""


def _get_engine():
    """Return a working SQLAlchemy engine.

    Order of preference:
      1. The project-wide singleton at `database.config.db.engine`.
      2. A locally-built fallback engine, URL discovered via every
         common env-var name.

    Raises RuntimeError only if every path fails.
    """
    try:
        from database.config import db as _db
        if getattr(_db, "engine", None) is not None:
            return _db.engine
    except Exception as exc:
        logger.warning("PrionVault queue: cannot use database.config.db (%s)", exc)

    global _local_engine
    if _local_engine is not None:
        return _local_engine
    with _engine_lock:
        if _local_engine is not None:
            return _local_engine
        url = _discover_database_url()
        if not url:
            available = sorted(k for k in os.environ
                               if any(t in k.upper() for t in
                                      ("DATABASE", "POSTGRES", "PG")))
            raise RuntimeError(
                "PrionVault queue: cannot find a Postgres URL. Tried "
                "DATABASE_URL, POSTGRES_URL, PG_URL and PG*/POSTGRES_* "
                "components. Visible related env vars: " + (", ".join(available) or "(none)")
            )
        _local_engine = create_engine(
            url, pool_pre_ping=True, pool_recycle=300, future=True,
        )
        logger.info("PrionVault queue: built local fallback engine from discovered URL.")
        return _local_engine


@dataclass
class Job:
    id:           int
    article_id:   Optional[UUID]
    pdf_filename: Optional[str]
    pdf_md5:      Optional[str]
    status:       str
    step:         Optional[str]
    error:        Optional[str]
    attempts:     int
    created_by:   Optional[UUID]
    staged_path:  Optional[str]
    # Path of the PDF in the Dropbox watch folder, if any. Empty for
    # hand-uploaded jobs (Import PDFs modal) since they're staged
    # locally on the server and never sit on Dropbox first.
    source_dropbox_path: Optional[str] = None


# ── Enqueue ────────────────────────────────────────────────────────────────
def enqueue_pdf(*, content: bytes, filename: str,
                user_id: Optional[UUID] = None,
                source_dropbox_path: Optional[str] = None) -> int:
    """Stage `content` to a temp file and create a queued job.

    `source_dropbox_path` (optional): when the PDF was pulled from a
    Dropbox watch folder, recording its path here lets `cleanup_source_pdf`
    delete the original after a successful ingest. Hand-uploaded jobs
    leave it unset.

    Returns the new job id. Raises if the DB is unreachable.
    """
    safe_name = "".join(c if c.isalnum() or c in "._-" else "_" for c in filename)[:120]
    staged = _STAGING_DIR / f"{int(datetime.utcnow().timestamp() * 1000)}_{safe_name}"
    staged.write_bytes(content)

    md5 = _md5_of(content)
    eng = _get_engine()
    with eng.begin() as conn:
        row = conn.execute(text(
            """
            INSERT INTO prionvault_ingest_job
              (pdf_filename, pdf_md5, status, step, created_by,
               source_dropbox_path, created_at)
            VALUES (:fn, :md5, 'queued', 'staged', :uid, :sp, NOW())
            RETURNING id
            """
        ), {"fn": str(staged), "md5": md5,
            "uid": str(user_id) if user_id else None,
            "sp": source_dropbox_path}).first()
    return int(row[0])


def cleanup_source_pdf(job_id: int, *, status: str = "done") -> None:
    """Best-effort: tidy up the scanner's source PDF in Dropbox.

    - status='done':       delete the source (the article is now in
                           the library at its canonical path).
    - status='duplicate':  move the source to a `_duplicates/`
                           sibling folder so the admin can see what
                           was skipped and decide whether to discard.

    Called by the worker right after a successful / duplicate
    transition. Any Dropbox failure is logged but never propagated.
    """
    eng = _get_engine()
    with eng.connect() as conn:
        row = conn.execute(text(
            "SELECT source_dropbox_path FROM prionvault_ingest_job WHERE id = :id"
        ), {"id": job_id}).first()
    src = row[0] if row else None
    if not src:
        return
    try:
        from core.dropbox_client import get_client
        import dropbox
        client = get_client()
        if client is None:
            logger.warning("cleanup_source_pdf: no Dropbox client, skipping %s", src)
            return
        if status == "duplicate":
            parent  = src.rsplit("/", 1)[0]
            base    = src.rsplit("/", 1)[1]
            dup_dir = f"{parent}/_duplicates"
            dest    = f"{dup_dir}/{base}"
            try:
                client.files_create_folder_v2(dup_dir)
            except dropbox.exceptions.ApiError as exc:
                # CONFLICT = folder already exists; that's fine.
                if "conflict" not in str(exc).lower():
                    raise
            client.files_move_v2(src, dest, autorename=True)
            logger.info("cleanup_source_pdf: moved duplicate %s → %s", src, dest)
        else:
            client.files_delete_v2(src)
            logger.info("cleanup_source_pdf: removed %s after job %d", src, job_id)
    except Exception as exc:
        logger.warning("cleanup_source_pdf: %s — %s", src, exc)


# ── Worker-side: claim the next job ────────────────────────────────────────
def claim_next() -> Optional[Job]:
    """Atomically pick the oldest queued job and mark it as `uploading`.

    Uses SELECT ... FOR UPDATE SKIP LOCKED so concurrent workers never
    pick the same job.
    """
    eng = _get_engine()
    with eng.begin() as conn:
        row = conn.execute(text(
            """
            SELECT id FROM prionvault_ingest_job
            WHERE status = 'queued'
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
            """
        )).first()
        if row is None:
            return None
        jid = int(row[0])
        conn.execute(text(
            """
            UPDATE prionvault_ingest_job
               SET status = 'uploading', step = 'claimed',
                   started_at = NOW()
             WHERE id = :id
            """
        ), {"id": jid})
        full = conn.execute(text(
            "SELECT id, article_id, pdf_filename, pdf_md5, status, step,"
            " error, attempts, created_by, source_dropbox_path "
            "FROM prionvault_ingest_job WHERE id = :id"
        ), {"id": jid}).first()

    return Job(
        id=full.id, article_id=full.article_id, pdf_filename=full.pdf_filename,
        pdf_md5=full.pdf_md5, status=full.status, step=full.step,
        error=full.error, attempts=full.attempts, created_by=full.created_by,
        staged_path=(full.pdf_filename
                     if full.pdf_filename and Path(full.pdf_filename).exists()
                     else None),
        source_dropbox_path=full.source_dropbox_path,
    )


# ── Worker-side: progress / completion ─────────────────────────────────────
def mark_step(job_id: int, *, status: str, step: str,
              article_id: Optional[UUID] = None,
              error: Optional[str] = None) -> None:
    finishing = status in ("done", "failed", "duplicate")
    eng = _get_engine()
    with eng.begin() as conn:
        conn.execute(text(
            """
            UPDATE prionvault_ingest_job
               SET status = :status,
                   step = :step,
                   error = :error,
                   article_id = COALESCE(:aid, article_id),
                   finished_at = CASE WHEN :finishing THEN NOW() ELSE finished_at END
             WHERE id = :id
            """
        ), {
            "status": status, "step": step, "error": error,
            "aid": str(article_id) if article_id else None,
            "finishing": finishing, "id": job_id,
        })


def bump_attempt_or_fail(job_id: int, error: str,
                         max_attempts: int = _MAX_ATTEMPTS) -> str:
    """Increment attempts; if at limit, mark failed; otherwise re-queue.

    Returns the new status.
    """
    eng = _get_engine()
    with eng.begin() as conn:
        row = conn.execute(text(
            "SELECT attempts FROM prionvault_ingest_job WHERE id = :id"
        ), {"id": job_id}).first()
        attempts = (row.attempts if row else 0) + 1
        new_status = "failed" if attempts >= max_attempts else "queued"
        conn.execute(text(
            """
            UPDATE prionvault_ingest_job
               SET attempts = :a,
                   status = :st,
                   error = :err,
                   finished_at = CASE WHEN :st = 'failed' THEN NOW() ELSE NULL END
             WHERE id = :id
            """
        ), {"a": attempts, "st": new_status, "err": error[:500], "id": job_id})
    return new_status


# ── Status snapshot for the admin panel ─────────────────────────────────────
def snapshot(*, recent: int = 30) -> dict:
    try:
        eng = _get_engine()
    except Exception as exc:
        logger.warning("PrionVault queue: snapshot — no engine (%s)", exc)
        return {"queued": 0, "processing": 0, "done": 0, "failed": 0,
                "duplicate": 0, "recent": []}

    with eng.connect() as conn:
        agg_rows = conn.execute(text(
            "SELECT status, COUNT(*) FROM prionvault_ingest_job GROUP BY status"
        )).all()
        agg = {r[0]: int(r[1]) for r in agg_rows}
        processing = sum(agg.get(st, 0) for st in
                         ("uploading", "extracting", "resolving", "indexing"))

        recent_rows = conn.execute(text(
            """
            SELECT id, article_id, pdf_filename, status, step, error,
                   attempts, created_at, finished_at
            FROM prionvault_ingest_job
            ORDER BY created_at DESC
            LIMIT :n
            """
        ), {"n": recent}).all()

    def _short_filename(p):
        if not p:
            return None
        return Path(p).name[:80]

    return {
        "queued":     agg.get("queued", 0),
        "processing": processing,
        "done":       agg.get("done", 0),
        "failed":     agg.get("failed", 0),
        "duplicate":  agg.get("duplicate", 0),
        "recent": [
            {
                "id":           int(r.id),
                "article_id":   str(r.article_id) if r.article_id else None,
                "pdf_filename": _short_filename(r.pdf_filename),
                "status":       r.status,
                "step":         r.step,
                "error":        (r.error[:200] if r.error else None),
                "attempts":     int(r.attempts or 0),
                "created_at":   r.created_at.isoformat() if r.created_at else None,
                "finished_at":  r.finished_at.isoformat() if r.finished_at else None,
            }
            for r in recent_rows
        ],
    }


def list_jobs(*, status: Optional[str] = None, limit: int = 100,
              ids: Optional[List[int]] = None) -> List[dict]:
    """List ingest jobs.

    `ids` lets the Import modal poll only the jobs from the current
    upload session, so the user no longer sees aggregate counters
    mixing in unrelated background work.
    """
    try:
        eng = _get_engine()
    except Exception:
        return []
    sql = ("SELECT id, article_id, pdf_filename, status, step, error,"
           " attempts, created_at, finished_at FROM prionvault_ingest_job")
    where: List[str] = []
    params: dict = {}
    if status:
        where.append("status = :s")
        params["s"] = status
    if ids:
        # Cap to avoid pathological IN-lists; one upload session is
        # bounded by what fits in the dropzone anyway.
        ids = [int(x) for x in ids[:1000]]
        if not ids:
            return []
        placeholders = ", ".join(f":id{i}" for i in range(len(ids)))
        where.append(f"id IN ({placeholders})")
        for i, x in enumerate(ids):
            params[f"id{i}"] = x
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at DESC LIMIT :n"
    params["n"] = limit
    with eng.connect() as conn:
        rows = conn.execute(text(sql), params).all()
    return [
        {
            "id":           int(r.id),
            "article_id":   str(r.article_id) if r.article_id else None,
            "pdf_filename": Path(r.pdf_filename).name if r.pdf_filename else None,
            "status":       r.status,
            "step":         r.step,
            "error":        r.error,
            "attempts":     int(r.attempts or 0),
            "created_at":   r.created_at.isoformat() if r.created_at else None,
            "finished_at":  r.finished_at.isoformat() if r.finished_at else None,
        } for r in rows
    ]


def retry(job_id: int) -> bool:
    """Reset a failed/duplicate job to queued so the worker tries again."""
    try:
        eng = _get_engine()
    except Exception:
        return False
    with eng.begin() as conn:
        res = conn.execute(text(
            """
            UPDATE prionvault_ingest_job
               SET status = 'queued', step = 'retry-requested',
                   error = NULL, finished_at = NULL
             WHERE id = :id AND status IN ('failed', 'duplicate')
            """
        ), {"id": job_id})
        return res.rowcount > 0


def clear_finished() -> int:
    """Delete every terminal job (failed, duplicate, done) from the
    queue table. Returns the number of rows removed.

    Active rows (queued / uploading / extracting / resolving / indexing)
    are intentionally left alone — wiping them would orphan whatever
    the worker is currently doing.
    """
    try:
        eng = _get_engine()
    except Exception:
        return 0
    with eng.begin() as conn:
        res = conn.execute(text(
            """DELETE FROM prionvault_ingest_job
               WHERE status IN ('failed', 'duplicate', 'done')"""
        ))
        return res.rowcount or 0


# Backward-compatible alias — callers that import clear_failed keep
# working but get the new behaviour.
clear_failed = clear_finished


# ── Helpers ────────────────────────────────────────────────────────────────
def _md5_of(content: bytes) -> str:
    import hashlib
    return hashlib.md5(content).hexdigest()
