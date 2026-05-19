"""Open-access PDF auto-fetcher.

For every article with metadata but no PDF (`dropbox_path IS NULL`)
that has a DOI or a PMC ID, this daemon tries:

  1. Unpaywall by DOI    → if the response carries a `url_for_pdf`,
                           download it via the existing
                           `unpaywall.download_pdf()` helper.
  2. Europe PMC direct   → `https://europepmc.org/articles/PMCxxxxx/pdf`
                           gives a stable redirect to the PDF for any
                           PMC-archived paper.

On success the bytes are uploaded to the canonical
`/PrionLab tools/PrionVault/<year>/<doi-slug>.pdf` path via
`dropbox_uploader.upload_pdf()` and the article row is updated with
`dropbox_path`, `pdf_md5`, `pdf_size_bytes`, `pdf_oa_status`. The
existing batch_extract / batch_searchable pipelines pick it up from
there.

Auto-runs in the background (1-minute poll). Also kicked synchronously
from the inventory import endpoint so a 50-paper import has its PDFs
arriving within seconds of the metadata.
"""
from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from collections import deque
from datetime import datetime
from typing import Optional

import requests
from sqlalchemy import text as sql_text

from ..ingestion.queue import _get_engine
from ..ingestion.dropbox_uploader import build_path, upload_pdf
from . import unpaywall

logger = logging.getLogger(__name__)


_USER_AGENT = (
    "PrionVault/1.0 (https://prionlab-tools.up.railway.app; "
    "open-access ingest)"
)
_TIMEOUT = 30.0
_MAX_PDF_BYTES = 60 * 1024 * 1024  # 60 MB, matches unpaywall.py
_BETWEEN_PAPERS_SLEEP_S = 0.4
_POLL_SECONDS = 60
_EVENT_LOG_MAX = 500


_state = {
    "running":         False,
    "started_at":      None,
    "finished_at":     None,
    "stop_requested":  False,
    "current":         None,
    "fetched":         0,    # PDFs uploaded this session
    "marked_unavail":  0,    # rows flipped to 'not_available' this session
    "failed":          0,    # transient failures this session
    "last_error":      None,
    "events":          deque(maxlen=_EVENT_LOG_MAX),
}
_lock   = threading.Lock()
_thread: Optional[threading.Thread] = None
_force  = threading.Event()
_stop   = threading.Event()


def _set(**kw) -> None:
    with _lock:
        _state.update(kw)


def _log_event(article_id, title: str, outcome: str, *,
               via: Optional[str] = None,
               reason: Optional[str] = None) -> None:
    entry = {
        "at":         datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "article_id": str(article_id) if article_id else None,
        "title":      (title or "")[:160],
        "outcome":    outcome,   # "fetched" | "not_available" | "failed"
        "via":        via,       # "unpaywall" | "pmc" | None
        "reason":     (reason[:240] if isinstance(reason, str) else None),
    }
    with _lock:
        _state["events"].append(entry)


def get_status() -> dict:
    with _lock:
        snap = {k: v for k, v in _state.items() if k != "events"}
        snap["events"] = list(reversed(_state["events"]))
    snap["pending"] = _count_pending()
    return snap


def _count_pending() -> int:
    try:
        eng = _get_engine()
        with eng.connect() as conn:
            n = conn.execute(sql_text(
                """SELECT COUNT(*) FROM articles
                   WHERE dropbox_path IS NULL
                     AND pdf_oa_status IS NULL
                     AND (doi IS NOT NULL OR pmc_id IS NOT NULL)"""
            )).scalar() or 0
        return int(n)
    except Exception as exc:
        logger.warning("oa_pdf_fetcher: pending count failed (%s)", exc)
        return 0


# ── Fetch one paper ──────────────────────────────────────────────────────────

def _try_unpaywall(doi: str) -> tuple[Optional[bytes], Optional[str]]:
    """Returns (pdf_bytes, source_url) or (None, None) if no OA via Unpaywall."""
    try:
        info = unpaywall.find_open_pdf(doi)
    except unpaywall.NotConfigured:
        return None, None
    except Exception as exc:
        logger.debug("oa_pdf_fetcher: unpaywall lookup failed for %s (%s)", doi, exc)
        return None, None
    if not info.is_oa or not info.pdf_url:
        return None, None
    try:
        data = unpaywall.download_pdf(info.pdf_url)
        return data, info.pdf_url
    except Exception as exc:
        logger.debug("oa_pdf_fetcher: unpaywall download failed (%s)", exc)
        return None, None


def _try_pmc(pmc_id: str) -> tuple[Optional[bytes], Optional[str]]:
    """Europe PMC serves a stable `/articles/<pmcid>/pdf` redirect for
    every archived paper. Use it as a fallback when Unpaywall didn't
    deliver (or there's no DOI)."""
    if not pmc_id:
        return None, None
    pmc_id = pmc_id.upper()
    if not pmc_id.startswith("PMC"):
        pmc_id = "PMC" + pmc_id
    url = f"https://europepmc.org/articles/{pmc_id}/pdf"
    headers = {"User-Agent": _USER_AGENT, "Accept": "application/pdf,*/*"}
    try:
        with requests.get(url, headers=headers, timeout=_TIMEOUT,
                          stream=True, allow_redirects=True) as r:
            r.raise_for_status()
            declared = r.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > _MAX_PDF_BYTES:
                return None, None
            ctype = (r.headers.get("content-type") or "").lower()
            if "text/html" in ctype:
                return None, None
            chunks: list[bytes] = []
            total = 0
            for chunk in r.iter_content(chunk_size=64 * 1024):
                if not chunk:
                    continue
                total += len(chunk)
                if total > _MAX_PDF_BYTES:
                    return None, None
                chunks.append(chunk)
        body = b"".join(chunks)
        if not body.startswith(b"%PDF"):
            return None, None
        return body, url
    except Exception as exc:
        logger.debug("oa_pdf_fetcher: PMC fetch failed for %s (%s)", pmc_id, exc)
        return None, None


def _process_one(row: dict) -> str:
    """Attempt OA fetch for one article. Returns the new pdf_oa_status."""
    aid     = row["id"]
    title   = row.get("title") or "(sin título)"
    doi     = (row.get("doi") or "").strip().lower() or None
    pmc_id  = row.get("pmc_id")
    year    = row.get("year")

    _set(current={"id": str(aid), "title": title[:160]})

    body, via = (None, None)
    if doi:
        body, _ = _try_unpaywall(doi)
        if body:
            via = "unpaywall"
    if not body and pmc_id:
        body, _ = _try_pmc(pmc_id)
        if body:
            via = "pmc"

    if not body:
        # Negative cache — don't try this article again on the next
        # daemon tick. The operator can still force a retry from the
        # main listing's "Retry OA fetch" action (if/when added).
        try:
            with _get_engine().begin() as conn:
                conn.execute(sql_text("""
                    UPDATE articles
                       SET pdf_oa_status = 'not_available',
                           updated_at = NOW()
                     WHERE id = :aid
                """), {"aid": str(aid)})
        except Exception as exc:
            logger.warning("oa_pdf_fetcher: mark-unavail failed for %s (%s)", aid, exc)
        with _lock:
            _state["marked_unavail"] += 1
        _log_event(aid, title, "not_available")
        return "not_available"

    # Got bytes — upload + persist.
    md5 = hashlib.md5(body).hexdigest()
    target = build_path(doi=doi, year=year, md5=md5)
    up = upload_pdf(body, target, overwrite=False)
    if up.error and "already_exists" not in (up.error or "").lower():
        # Genuine upload failure (network, permissions, etc.). Leave
        # pdf_oa_status NULL so the next pass retries.
        with _lock:
            _state["failed"] += 1
            _state["last_error"] = f"{title[:80]} — upload: {up.error[:160]}"
        _log_event(aid, title, "failed", via=via, reason=up.error)
        return "failed"

    new_status = "fetched_unpaywall" if via == "unpaywall" else "fetched_pmc"
    try:
        with _get_engine().begin() as conn:
            conn.execute(sql_text("""
                UPDATE articles
                   SET dropbox_path   = :p,
                       pdf_md5        = :m,
                       pdf_size_bytes = :sz,
                       pdf_oa_status  = :st,
                       updated_at     = NOW()
                 WHERE id = :aid
            """), {
                "aid": str(aid),
                "p":   up.dropbox_path,
                "m":   md5,
                "sz":  len(body),
                "st":  new_status,
            })
    except Exception as exc:
        # The bytes are in Dropbox; the DB lost. Leave pdf_oa_status NULL
        # so a future pass can stamp the DB once (idempotent overwrite
        # protects against duplicate Dropbox uploads).
        logger.warning("oa_pdf_fetcher: persist failed for %s (%s)", aid, exc)
        with _lock:
            _state["failed"] += 1
            _state["last_error"] = f"{title[:80]} — persist: {str(exc)[:160]}"
        _log_event(aid, title, "failed", via=via, reason=str(exc))
        return "failed"

    with _lock:
        _state["fetched"] += 1
    _log_event(aid, title, "fetched", via=via)
    return new_status


# ── Worker loop ──────────────────────────────────────────────────────────────

def _drain_once() -> dict:
    """Process every eligible article until the queue is empty OR the
    stop flag fires. Each paper in its own DB statement so a crash
    mid-loop leaves the table consistent."""
    started = time.monotonic()
    fetched = unavail = failed = 0

    eng = _get_engine()
    while True:
        if _stop.is_set():
            break
        with _lock:
            if _state["stop_requested"]:
                break
        try:
            with eng.connect() as conn:
                row = conn.execute(sql_text("""
                    SELECT id, title, doi, pmc_id, year
                      FROM articles
                     WHERE dropbox_path IS NULL
                       AND pdf_oa_status IS NULL
                       AND (doi IS NOT NULL OR pmc_id IS NOT NULL)
                     ORDER BY created_at DESC NULLS LAST
                     LIMIT 1
                """)).mappings().first()
        except Exception as exc:
            logger.warning("oa_pdf_fetcher: probe failed (%s)", exc)
            time.sleep(5.0)
            continue
        if not row:
            break
        try:
            outcome = _process_one(dict(row))
        except Exception as exc:
            logger.exception("oa_pdf_fetcher: process_one crashed")
            outcome = "failed"
            with _lock:
                _state["failed"] += 1
                _state["last_error"] = str(exc)[:240]
        if outcome.startswith("fetched"):
            fetched += 1
        elif outcome == "not_available":
            unavail += 1
        else:
            failed += 1
        time.sleep(_BETWEEN_PAPERS_SLEEP_S)

    return {
        "fetched":         fetched,
        "marked_unavail":  unavail,
        "failed":          failed,
        "runtime_ms":      int((time.monotonic() - started) * 1000),
    }


def request_drain_now() -> None:
    """Wake the worker immediately. Called from the inventory import
    endpoint so the operator's first PDFs arrive seconds after their
    metadata."""
    _force.set()


def stop_batch() -> dict:
    with _lock:
        if _state["running"]:
            _state["stop_requested"] = True
    return get_status()


def _run_loop() -> None:
    while not _stop.is_set():
        if os.environ.get("PRIONVAULT_OA_FETCHER_DISABLED",
                          "").strip() in ("1", "true", "True"):
            _stop.wait(timeout=_POLL_SECONDS)
            continue

        # Wait for force OR poll cycle.
        if not _force.is_set():
            _stop.wait(timeout=_POLL_SECONDS)
        _force.clear()
        if _stop.is_set():
            break

        # Drain only if there's actually work to do, so we don't burn
        # cycles when the catalogue is fully synced.
        if _count_pending() == 0:
            continue

        with _lock:
            if _state["running"]:
                continue
            _state.update({
                "running":        True,
                "started_at":     datetime.utcnow().isoformat(),
                "finished_at":    None,
                "stop_requested": False,
                "fetched":        0,
                "marked_unavail": 0,
                "failed":         0,
                "current":        None,
                "last_error":     None,
            })

        try:
            _drain_once()
        except Exception as exc:
            logger.exception("oa_pdf_fetcher: drain crashed")
            with _lock:
                _state["last_error"] = str(exc)[:240]
        finally:
            with _lock:
                _state["running"]     = False
                _state["finished_at"] = datetime.utcnow().isoformat()
                _state["current"]     = None


def start_oa_fetcher_daemon() -> Optional[threading.Thread]:
    """Idempotent daemon starter. Returns the live thread or None when
    disabled."""
    global _thread
    if _thread and _thread.is_alive():
        return _thread
    if os.environ.get("PRIONVAULT_OA_FETCHER_DISABLED",
                      "").strip() in ("1", "true", "True"):
        logger.info("oa_pdf_fetcher: disabled by env")
        return None
    _stop.clear()
    _thread = threading.Thread(target=_run_loop,
                               name="prionvault-oa-pdf-fetcher",
                               daemon=True)
    _thread.start()
    return _thread
