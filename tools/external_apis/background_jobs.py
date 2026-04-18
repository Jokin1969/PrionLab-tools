"""Background job processing for async enrichment workflows."""
import asyncio
import logging
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class Job:
    """Represents a background enrichment job."""
    id: str
    type: str
    status: str = "pending"       # pending | running | completed | failed | cancelled
    progress: float = 0.0         # 0.0 – 1.0
    result: Optional[Any] = None
    error: Optional[str] = None
    created_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    metadata: Dict = field(default_factory=dict)
    _cancel: threading.Event = field(default_factory=threading.Event, repr=False)

    def to_dict(self) -> Dict:
        return {
            "id": self.id,
            "type": self.type,
            "status": self.status,
            "progress": self.progress,
            "result": self.result,
            "error": self.error,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "metadata": self.metadata,
        }

    def _touch(self) -> None:
        self.updated_at = datetime.utcnow().isoformat()


class JobManager:
    """Thread-safe in-memory job queue with ThreadPoolExecutor backend."""

    MAX_HISTORY = 100

    def __init__(self, max_workers: int = 2):
        self._jobs: Dict[str, Job] = {}
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="prionlab-job")

    # ── Public API ────────────────────────────────────────────────────────────

    def submit(self, job_type: str, fn: Callable, **kwargs) -> str:
        """Create and enqueue a job. `fn(job, **kwargs)` is called in a thread."""
        job_id = str(uuid.uuid4())
        job = Job(id=job_id, type=job_type)
        with self._lock:
            self._jobs[job_id] = job
            self._prune()
        self._executor.submit(self._run_job, job, fn, kwargs)
        logger.info("Job %s submitted: %s", job_id[:8], job_type)
        return job_id

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def list_recent(self, limit: int = 20) -> List[Dict]:
        with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)
        return [j.to_dict() for j in jobs[:limit]]

    def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if job is None:
            return False
        if job.status in ("completed", "failed", "cancelled"):
            return False
        job._cancel.set()
        job.status = "cancelled"
        job._touch()
        logger.info("Job %s cancelled", job_id[:8])
        return True

    def shutdown(self, wait: bool = True) -> None:
        self._executor.shutdown(wait=wait)

    # ── Internal ──────────────────────────────────────────────────────────────

    def _run_job(self, job: Job, fn: Callable, kwargs: Dict) -> None:
        job.status = "running"
        job._touch()
        try:
            result = fn(job, **kwargs)
            job.result = result
            job.status = "completed"
            job.progress = 1.0
        except Exception as exc:
            logger.error("Job %s failed: %s", job.id[:8], exc)
            job.status = "failed"
            job.error = str(exc)
        finally:
            job._touch()

    def _prune(self) -> None:
        """Remove oldest completed/failed/cancelled jobs beyond MAX_HISTORY."""
        done = [j for j in self._jobs.values() if j.status in ("completed", "failed", "cancelled")]
        done.sort(key=lambda j: j.created_at)
        for old in done[: max(0, len(done) - self.MAX_HISTORY)]:
            del self._jobs[old.id]


# ── Bulk enrichment job ───────────────────────────────────────────────────────

def _bulk_enrichment_worker(job: Job, criteria: Dict, max_publications: int, max_concurrent: int) -> Dict:
    """Worker that runs bulk enrichment for all matching publications."""
    from .enrichment_service import EnrichmentService

    service = EnrichmentService()
    enriched = 0
    failed = 0

    # Gather publications (CSV-based fallback when DB not configured)
    publications = _gather_publications(criteria, max_publications)
    total = len(publications)
    job.metadata["total"] = total
    job._touch()

    for i, pub in enumerate(publications):
        if job._cancel.is_set():
            break
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                result = loop.run_until_complete(service.enrich_publication(pub))
                if result.get("success"):
                    enriched += 1
                else:
                    failed += 1
            finally:
                loop.close()
        except Exception as exc:
            logger.warning("Bulk enrichment: pub %d failed: %s", i, exc)
            failed += 1

        job.progress = (i + 1) / max(total, 1)
        job._touch()

    return {"enriched": enriched, "failed": failed, "total": total, "cancelled": job._cancel.is_set()}


def _gather_publications(criteria: Dict, max_publications: int) -> List[Dict]:
    """Return publications from DB or CSV matching the given criteria."""
    publications: List[Dict] = []
    try:
        from database.config import db
        if db.is_configured():
            from database.models import Publication
            with db.get_session() as s:
                query = s.query(Publication)
                if criteria.get("missing_doi_only"):
                    query = query.filter(Publication.doi.is_(None))
                pubs = query.limit(max_publications).all()
                for p in pubs:
                    publications.append({
                        "pub_id": p.pub_id,
                        "title": p.title,
                        "doi": p.doi,
                        "authors": p.authors,
                        "year": p.year,
                    })
            return publications
    except Exception:
        pass

    # CSV fallback
    try:
        from tools.research.models import get_all_publications
        for p in get_all_publications()[:max_publications]:
            publications.append({
                "pub_id": p.get("pub_id", ""),
                "title": p.get("title", ""),
                "doi": p.get("doi", ""),
                "authors": p.get("authors", ""),
                "year": p.get("year", ""),
            })
    except Exception as exc:
        logger.warning("_gather_publications CSV fallback: %s", exc)

    return publications


# ── Module singletons ─────────────────────────────────────────────────────────

_job_manager: Optional[JobManager] = None


def get_job_manager() -> JobManager:
    global _job_manager
    if _job_manager is None:
        _job_manager = JobManager(max_workers=2)
    return _job_manager


def start_background_jobs() -> None:
    """Initialise the job manager (call once at startup)."""
    get_job_manager()
    logger.info("Background job manager started")


def stop_background_jobs() -> None:
    """Gracefully shut down the job manager."""
    global _job_manager
    if _job_manager is not None:
        _job_manager.shutdown(wait=False)
        _job_manager = None
        logger.info("Background job manager stopped")
