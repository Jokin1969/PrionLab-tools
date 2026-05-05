"""Persistent ingest queue — a thin wrapper over `prionvault_ingest_job`.

Why persistent (BD-backed) instead of in-memory:
  - Railway can restart the container at any time. An in-memory queue
    loses work on restart; the BD-backed one resumes seamlessly.
  - The user sees real progress in the UI even after a deploy.
  - `SELECT ... FOR UPDATE SKIP LOCKED` lets multiple workers (current
    or future) pull jobs without stepping on each other.

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

import base64
import io
import logging
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import IO, List, Optional, Union
from uuid import UUID

from sqlalchemy import text

from database.config import db

logger = logging.getLogger(__name__)

_MAX_ATTEMPTS = 3
# Where the worker stages PDFs on disk before processing. Containers on
# Railway have ephemeral storage but it survives within a single boot,
# which is enough for the worker's own pipeline.
_STAGING_DIR = Path(os.environ.get("PRIONVAULT_STAGING_DIR",
                                   tempfile.gettempdir())) / "prionvault_staging"
_STAGING_DIR.mkdir(parents=True, exist_ok=True)


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
    staged_path:  Optional[str]   # local on-disk PDF (set by enqueue, used by worker)


def _ensure_db():
    """Raise a clear error if the SQLAlchemy engine is missing.

    Both `db.engine` and `db.Session` are set together in
    `DatabaseConfig._setup()`; a missing engine usually means
    DATABASE_URL was not present at import time. Surfacing the message
    here is much friendlier than a downstream AttributeError.
    """
    if not getattr(db, "engine", None) or not getattr(db, "Session", None):
        raise RuntimeError(
            "PrionVault: database not configured (DATABASE_URL missing or "
            "engine failed to initialise). Check Railway env vars."
        )


# ── Enqueue ────────────────────────────────────────────────────────────────
def enqueue_pdf(*, content: bytes, filename: str,
                user_id: Optional[UUID] = None) -> int:
    """Stage `content` to a temp file and create a queued job.

    Returns the new job id. Raises if the DB is unreachable.
    """
    _ensure_db()
    # Stage to disk first so the worker doesn't keep large blobs in memory.
    safe_name = "".join(c if c.isalnum() or c in "._-" else "_" for c in filename)[:120]
    staged = _STAGING_DIR / f"{int(datetime.utcnow().timestamp() * 1000)}_{safe_name}"
    staged.write_bytes(content)

    md5 = _md5_of(content)
    s = db.Session()
    try:
        row = s.execute(text(
            """
            INSERT INTO prionvault_ingest_job
              (pdf_filename, pdf_md5, status, step, created_by, created_at)
            VALUES (:fn, :md5, 'queued', 'staged', :uid, NOW())
            RETURNING id
            """
        ), {"fn": str(staged), "md5": md5,
            "uid": str(user_id) if user_id else None}).first()
        s.commit()
        return int(row[0])
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


# ── Worker-side: claim the next job ────────────────────────────────────────
def claim_next() -> Optional[Job]:
    """Atomically pick the oldest queued job and mark it as `uploading`.

    Uses SELECT ... FOR UPDATE SKIP LOCKED so concurrent workers never
    pick the same job.
    """
    if not getattr(db, "engine", None):
        return None
    s = db.Session()
    try:
        row = s.execute(text(
            """
            SELECT id FROM prionvault_ingest_job
            WHERE status = 'queued'
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
            """
        )).first()
        if row is None:
            s.commit()
            return None
        jid = int(row[0])
        s.execute(text(
            """
            UPDATE prionvault_ingest_job
               SET status = 'uploading', step = 'claimed',
                   started_at = NOW()
             WHERE id = :id
            """
        ), {"id": jid})

        full = s.execute(text(
            "SELECT id, article_id, pdf_filename, pdf_md5, status, step,"
            " error, attempts, created_by FROM prionvault_ingest_job WHERE id = :id"
        ), {"id": jid}).first()
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()

    return Job(
        id=full.id, article_id=full.article_id, pdf_filename=full.pdf_filename,
        pdf_md5=full.pdf_md5, status=full.status, step=full.step,
        error=full.error, attempts=full.attempts, created_by=full.created_by,
        staged_path=full.pdf_filename if full.pdf_filename and Path(full.pdf_filename).exists() else None,
    )


# ── Worker-side: progress / completion ─────────────────────────────────────
def mark_step(job_id: int, *, status: str, step: str,
              article_id: Optional[UUID] = None,
              error: Optional[str] = None) -> None:
    finishing = status in ("done", "failed", "duplicate")
    s = db.Session()
    try:
        s.execute(text(
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
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


def bump_attempt_or_fail(job_id: int, error: str, max_attempts: int = _MAX_ATTEMPTS) -> str:
    """Increment attempts; if at limit, mark failed; otherwise re-queue.

    Returns the new status.
    """
    s = db.Session()
    try:
        row = s.execute(text(
            "SELECT attempts FROM prionvault_ingest_job WHERE id = :id"
        ), {"id": job_id}).first()
        attempts = (row.attempts if row else 0) + 1
        new_status = "failed" if attempts >= max_attempts else "queued"
        s.execute(text(
            """
            UPDATE prionvault_ingest_job
               SET attempts = :a,
                   status = :st,
                   error = :err,
                   finished_at = CASE WHEN :st = 'failed' THEN NOW() ELSE NULL END
             WHERE id = :id
            """
        ), {"a": attempts, "st": new_status, "err": error[:500], "id": job_id})
        s.commit()
        return new_status
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


# ── Status snapshot for the admin panel ─────────────────────────────────────
def snapshot(*, recent: int = 30) -> dict:
    if not getattr(db, "engine", None):
        return {"queued": 0, "processing": 0, "done": 0, "failed": 0,
                "duplicate": 0, "recent": []}
    s = db.Session()
    try:
        agg_rows = s.execute(text(
            "SELECT status, COUNT(*) FROM prionvault_ingest_job GROUP BY status"
        )).all()
        agg = {r[0]: int(r[1]) for r in agg_rows}
        # Map "uploading|extracting|resolving|indexing" -> "processing".
        processing = sum(agg.get(st, 0) for st in
                         ("uploading", "extracting", "resolving", "indexing"))

        recent_rows = s.execute(text(
            """
            SELECT id, article_id, pdf_filename, status, step, error,
                   attempts, created_at, finished_at
            FROM prionvault_ingest_job
            ORDER BY created_at DESC
            LIMIT :n
            """
        ), {"n": recent}).all()
    finally:
        s.close()

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


def list_jobs(*, status: Optional[str] = None, limit: int = 100) -> List[dict]:
    if not getattr(db, "engine", None):
        return []
    sql = ("SELECT id, article_id, pdf_filename, status, step, error,"
           " attempts, created_at, finished_at FROM prionvault_ingest_job")
    params = {}
    if status:
        sql += " WHERE status = :s"
        params["s"] = status
    sql += " ORDER BY created_at DESC LIMIT :n"
    params["n"] = limit
    s = db.Session()
    try:
        rows = s.execute(text(sql), params).all()
    finally:
        s.close()
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
    if not getattr(db, "engine", None):
        return False
    s = db.Session()
    try:
        res = s.execute(text(
            """
            UPDATE prionvault_ingest_job
               SET status = 'queued', step = 'retry-requested',
                   error = NULL, finished_at = NULL
             WHERE id = :id AND status IN ('failed', 'duplicate')
            """
        ), {"id": job_id})
        s.commit()
        return res.rowcount > 0
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


# ── Helpers ────────────────────────────────────────────────────────────────
def _md5_of(content: bytes) -> str:
    import hashlib
    return hashlib.md5(content).hexdigest()
