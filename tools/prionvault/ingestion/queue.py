"""Persistent ingest queue — a thin wrapper over `prionvault_ingest_job`.

Uses db.get_session() from database.config — the same singleton the rest of
the app uses — instead of building its own engine. This eliminates the timing
issue where the singleton engine was None at request time.

Requires DATABASE_URL to be set in Railway (service environment variables).
If it is not set, all queue operations fail with a clear, actionable message.
"""
from __future__ import annotations

import logging
import os
import tempfile
import threading
from datetime import datetime
from pathlib import Path
from typing import List, Optional
from uuid import UUID

from dataclasses import dataclass
from sqlalchemy import text

from database.config import db

logger = logging.getLogger(__name__)

_MAX_ATTEMPTS = 3


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
_STAGING_DIR = Path(os.environ.get("PRIONVAULT_STAGING_DIR",
                                   tempfile.gettempdir())) / "prionvault_staging"
_STAGING_DIR.mkdir(parents=True, exist_ok=True)


# ── Engine helper (kept for the debug endpoint in routes.py) ──────────────
def _get_engine():
    """Return the shared db engine.  Used only by the /debug/db endpoint."""
    if db.is_configured():
        return db.engine
    return None


def _require_db(context: str = "PrionVault queue") -> None:
    """Raise a clear, actionable error if DATABASE_URL is not configured."""
    if not db.is_configured():
        raise RuntimeError(
            f"{context}: DATABASE_URL is not set. "
            "Please add DATABASE_URL to your Railway service environment variables "
            "(Service → Variables → add DATABASE_URL pointing to your PostgreSQL instance)."
        )


# ── Enqueue ────────────────────────────────────────────────────────────────
def enqueue_pdf(*, content: bytes, filename: str,
                user_id: Optional[UUID] = None) -> int:
    """Stage `content` to a temp file and create a queued job.
    Returns the new job id. Raises if DB is not configured or unreachable.
    """
    _require_db()

    safe_name = "".join(c if c.isalnum() or c in "._-" else "_" for c in filename)[:120]
    staged = _STAGING_DIR / f"{int(datetime.utcnow().timestamp() * 1000)}_{safe_name}"
    staged.write_bytes(content)

    md5 = _md5_of(content)
    with db.get_session() as sess:
        row = sess.execute(text("""
            INSERT INTO prionvault_ingest_job
              (pdf_filename, pdf_md5, status, step, created_by, created_at)
            VALUES (:fn, :md5, 'queued', 'staged', :uid, NOW())
            RETURNING id
        """), {
            "fn":  str(staged),
            "md5": md5,
            "uid": str(user_id) if user_id else None,
        }).first()
    return int(row[0])


# ── Worker-side: claim the next job ────────────────────────────────────────
def claim_next() -> Optional[Job]:
    """Atomically pick the oldest queued job and mark it 'uploading'.
    Returns a Job or None if the queue is empty.
    """
    if not db.is_configured():
        return None
    try:
        with db.get_session() as sess:
            row = sess.execute(text("""
                UPDATE prionvault_ingest_job
                   SET status = 'uploading', step = 'claimed', started_at = NOW()
                 WHERE id = (
                     SELECT id FROM prionvault_ingest_job
                     WHERE status = 'queued'
                     ORDER BY created_at
                     LIMIT 1
                     FOR UPDATE SKIP LOCKED
                 )
                RETURNING id, article_id, pdf_filename, pdf_md5,
                          status, step, error, attempts, created_by
            """)).first()
        if row is None:
            return None
        fn = row.pdf_filename
        return Job(
            id=int(row.id),
            article_id=row.article_id,
            pdf_filename=fn,
            pdf_md5=row.pdf_md5,
            status=row.status,
            step=row.step,
            error=row.error,
            attempts=int(row.attempts or 0),
            created_by=row.created_by,
            staged_path=fn if fn and Path(fn).exists() else None,
        )
    except Exception as e:
        logger.error("PrionVault claim_next error: %s", e)
        return None


# ── Worker-side: progress / completion ─────────────────────────────────────
def mark_step(job_id: int, *, status: str, step: str,
              article_id=None, error: Optional[str] = None) -> None:
    if not db.is_configured():
        return
    finishing = status in ("done", "failed", "duplicate")
    try:
        with db.get_session() as sess:
            sess.execute(text("""
                UPDATE prionvault_ingest_job
                   SET status = :status,
                       step = :step,
                       error = :error,
                       article_id = COALESCE(:aid, article_id),
                       finished_at = CASE WHEN :finishing THEN NOW() ELSE finished_at END
                 WHERE id = :id
            """), {
                "status":   status,
                "step":     step,
                "error":    error,
                "aid":      str(article_id) if article_id else None,
                "finishing": finishing,
                "id":       job_id,
            })
    except Exception as e:
        logger.error("PrionVault mark_step error: %s", e)


def bump_attempt_or_fail(job_id: int, error: str,
                         max_attempts: int = _MAX_ATTEMPTS) -> str:
    """Increment attempts; mark failed if at limit, else re-queue."""
    if not db.is_configured():
        return "failed"
    try:
        with db.get_session() as sess:
            row = sess.execute(
                text("SELECT attempts FROM prionvault_ingest_job WHERE id = :id"),
                {"id": job_id},
            ).first()
            attempts   = (row[0] if row else 0) + 1
            new_status = "failed" if attempts >= max_attempts else "queued"
            sess.execute(text("""
                UPDATE prionvault_ingest_job
                   SET attempts = :a,
                       status = :st,
                       error = :err,
                       finished_at = CASE WHEN :st = 'failed' THEN NOW() ELSE NULL END
                 WHERE id = :id
            """), {"a": attempts, "st": new_status, "err": error[:500], "id": job_id})
        return new_status
    except Exception as e:
        logger.error("PrionVault bump_attempt_or_fail error: %s", e)
        return "failed"


# ── Status snapshot for the admin panel ─────────────────────────────────────
def snapshot(*, recent: int = 30) -> dict:
    empty = {"queued": 0, "processing": 0, "done": 0,
             "failed": 0, "duplicate": 0, "recent": []}

    if not db.is_configured():
        return {**empty, "error": "DATABASE_URL not configured in Railway"}

    try:
        with db.get_session() as sess:
            agg_rows = sess.execute(text(
                "SELECT status, COUNT(*) FROM prionvault_ingest_job GROUP BY status"
            )).all()
            agg = {r[0]: int(r[1]) for r in agg_rows}
            processing = sum(agg.get(st, 0) for st in
                             ("uploading", "extracting", "resolving", "indexing"))
            recent_rows = sess.execute(text("""
                SELECT id, article_id, pdf_filename, status, step, error,
                       attempts, created_at, finished_at
                FROM prionvault_ingest_job
                ORDER BY created_at DESC
                LIMIT :n
            """), {"n": recent}).all()

        def _short(p):
            return Path(p).name[:80] if p else None

        return {
            "queued":     agg.get("queued", 0),
            "processing": processing,
            "done":       agg.get("done", 0),
            "failed":     agg.get("failed", 0),
            "duplicate":  agg.get("duplicate", 0),
            "recent": [{
                "id":           int(r.id),
                "article_id":   str(r.article_id) if r.article_id else None,
                "pdf_filename": _short(r.pdf_filename),
                "status":       r.status,
                "step":         r.step,
                "error":        (r.error[:200] if r.error else None),
                "attempts":     int(r.attempts or 0),
                "created_at":   r.created_at.isoformat() if r.created_at else None,
                "finished_at":  r.finished_at.isoformat() if r.finished_at else None,
            } for r in recent_rows],
        }
    except Exception as e:
        logger.error("PrionVault snapshot error: %s", e)
        return {**empty, "error": str(e)}


def list_jobs(*, status: Optional[str] = None, limit: int = 100) -> List[dict]:
    if not db.is_configured():
        return []
    try:
        sql = ("SELECT id, article_id, pdf_filename, status, step, error,"
               " attempts, created_at, finished_at FROM prionvault_ingest_job")
        params: dict = {}
        if status:
            sql += " WHERE status = :s"
            params["s"] = status
        sql += " ORDER BY created_at DESC LIMIT :n"
        params["n"] = limit
        with db.get_session() as sess:
            rows = sess.execute(text(sql), params).all()
        return [{
            "id":           int(r.id),
            "article_id":   str(r.article_id) if r.article_id else None,
            "pdf_filename": Path(r.pdf_filename).name if r.pdf_filename else None,
            "status":       r.status,
            "step":         r.step,
            "error":        r.error,
            "attempts":     int(r.attempts or 0),
            "created_at":   r.created_at.isoformat() if r.created_at else None,
            "finished_at":  r.finished_at.isoformat() if r.finished_at else None,
        } for r in rows]
    except Exception as e:
        logger.error("PrionVault list_jobs error: %s", e)
        return []


def retry(job_id: int) -> bool:
    """Reset a failed/duplicate job to queued."""
    if not db.is_configured():
        return False
    try:
        with db.get_session() as sess:
            res = sess.execute(text("""
                UPDATE prionvault_ingest_job
                   SET status = 'queued', step = 'retry-requested',
                       error = NULL, finished_at = NULL
                 WHERE id = :id AND status IN ('failed', 'duplicate')
            """), {"id": job_id})
            return res.rowcount > 0
    except Exception as e:
        logger.error("PrionVault retry error: %s", e)
        return False


# ── Helpers ────────────────────────────────────────────────────────────────
def _md5_of(content: bytes) -> str:
    import hashlib
    return hashlib.md5(content).hexdigest()
