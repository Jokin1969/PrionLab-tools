"""PubMed inventory — persistent "what's out there vs. what I have" tracker.

Runs the canonical prion query against PubMed E-utilities, stores every
returned PMID in `prionvault_pubmed_inventory`, and reconciles against
`articles.pubmed_id` so the "still pending" set is a single LEFT JOIN
away.

Design knobs that drove this file:

  - **Idempotent UPSERT**: every harvest pass is safe to repeat. New
    PMIDs are inserted with defaults, existing rows just get their
    `last_seen_at` bumped and metadata refreshed (PubMed corrections
    do happen; we always show the latest title/authors).
  - **Lease-gated daemon**: the 7-day refresh is wrapped in the same
    `prionvault_scheduled_runs` lease used by `auto_scan`, so multiple
    gunicorn workers don't all hammer PubMed.
  - **Reconciliation = LEFT JOIN UPDATE**: the operator can import a
    paper through any other path (manual creation, PDF ingest, DOI
    batch) and the inventory will catch up on the next harvest /
    stats call without us having to wire `imported_at` into every
    ingest entry-point.
  - **Bulk import = reuse `Article` model**: the import endpoint
    forwards inventory metadata into the existing duplicate-checked
    `Article` creation path so badges / collections / abstract retry
    work without changes.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import uuid as _uuid
from datetime import datetime, timezone
from typing import Iterable, Optional

import requests
from sqlalchemy import text as sql_text


def _loose_json(resp: requests.Response) -> dict:
    """Parse a PubMed response that may carry raw control characters in
    its title / abstract strings (PubMed serialises some XML escapes
    that way). `json.loads(..., strict=False)` accepts these; the
    default strict mode raises JSONDecodeError mid-harvest.
    """
    return json.loads(resp.text or "{}", strict=False)

from ..ingestion.metadata_resolver import (
    _PUBMED_ESEARCH, _PUBMED_ESUMMARY, _HDRS, _TIMEOUT,
)
from ..ingestion.queue import _get_engine

logger = logging.getLogger(__name__)

# ── Configuration ────────────────────────────────────────────────────────────
# The umbrella query the operator settled on. We use a fixed query so
# reruns are reproducible and the "X PMIDs catalogados" counter is
# meaningful; if it ever needs to change, a follow-up migration can
# trigger a full re-harvest by truncating the table.
PUBMED_QUERY  = "prion[Title/Abstract] OR prions[MeSH Major Topic]"

# Lease key (same row pattern as auto-scan).
LEASE_NAME    = "pubmed_inventory_harvest"

# 7 days. Tuned for a stable corpus — new prion papers per week are
# typically <50, so a weekly pass keeps the inventory fresh without
# poking NCBI any more than necessary.
DEFAULT_INTERVAL_DAYS = 7

# PubMed E-utilities behaviour.
_ESEARCH_RETMAX = 9_999          # the doc-documented hard ceiling
_ESUMMARY_BATCH = 200            # esummary accepts up to 500; 200 keeps the URL short
_INTER_BATCH_SLEEP_S = 0.20      # politeness pause between esummary batches


# ── In-memory progress (for the modal poller) ────────────────────────────────
_state = {
    "running":        False,
    "started_at":     None,
    "finished_at":    None,
    "stage":          None,    # "esearch" | "esummary" | "reconcile" | "done"
    "pmids_seen":     0,
    "pmids_inserted": 0,
    "pmids_updated":  0,
    "last_error":     None,
}
_lock = threading.Lock()
_thread: Optional[threading.Thread] = None
_force = threading.Event()
_stop  = threading.Event()


def _set_state(**kwargs) -> None:
    with _lock:
        _state.update(kwargs)


def get_progress() -> dict:
    with _lock:
        snap = dict(_state)
    return snap


# ── Lease (mirror of auto_scan._claim_lease) ─────────────────────────────────

def _claim_lease(interval_days: int) -> bool:
    try:
        eng = _get_engine()
        with eng.begin() as conn:
            row = conn.execute(sql_text("""
                INSERT INTO prionvault_scheduled_runs
                  (name, last_run_at, last_status, updated_at)
                VALUES (:n, NOW(), 'running', NOW())
                ON CONFLICT (name) DO UPDATE
                  SET last_run_at = NOW(),
                      last_status = 'running',
                      updated_at  = NOW()
                  WHERE prionvault_scheduled_runs.last_run_at IS NULL
                     OR prionvault_scheduled_runs.last_run_at
                          < NOW() - make_interval(days => :d)
                RETURNING name
            """), {"n": LEASE_NAME, "d": interval_days}).first()
            return row is not None
    except Exception as exc:
        logger.warning("pubmed_inventory: lease claim failed (%s)", exc)
        return False


def _record_run(*, status: str, runtime_ms: int,
                summary: Optional[dict] = None,
                error: Optional[str] = None) -> None:
    import json
    try:
        eng = _get_engine()
        with eng.begin() as conn:
            conn.execute(sql_text("""
                INSERT INTO prionvault_scheduled_runs
                  (name, last_run_at, last_status, last_error, last_runtime_ms,
                   payload, updated_at)
                VALUES (:n, NOW(), :s, :e, :ms, CAST(:p AS JSONB), NOW())
                ON CONFLICT (name) DO UPDATE
                  SET last_status     = EXCLUDED.last_status,
                      last_error      = EXCLUDED.last_error,
                      last_runtime_ms = EXCLUDED.last_runtime_ms,
                      payload         = EXCLUDED.payload,
                      updated_at      = NOW()
            """), {
                "n":  LEASE_NAME,
                "s":  status,
                "e":  (error[:600] if error else None),
                "ms": int(runtime_ms),
                "p":  json.dumps(summary or {}),
            })
    except Exception as exc:
        logger.warning("pubmed_inventory: record_run failed (%s)", exc)


# ── PubMed calls ─────────────────────────────────────────────────────────────

def _esearch_all(query: str) -> list[str]:
    """Walk every page of E-Search results for `query`, returning the
    full PMID list. Uses `retmax=9999` + `retstart` paging (the
    documented stable strategy for retrieving large result sets)."""
    pmids: list[str] = []
    retstart = 0
    while True:
        try:
            r = requests.get(_PUBMED_ESEARCH, params={
                "db":      "pubmed",
                "term":    query,
                "retmax":  str(_ESEARCH_RETMAX),
                "retstart": str(retstart),
                "retmode": "json",
            }, headers=_HDRS, timeout=_TIMEOUT)
            r.raise_for_status()
        except Exception as exc:
            logger.warning("pubmed_inventory: esearch failed at %d (%s)",
                           retstart, exc)
            raise
        try:
            data = _loose_json(r) or {}
        except Exception as exc:
            logger.warning("pubmed_inventory: esearch JSON parse failed at %d (%s)",
                           retstart, exc)
            # Don't kill the whole harvest over one malformed page;
            # treat as "no more results" and exit the loop.
            break
        res = data.get("esearchresult") or {}
        batch = res.get("idlist") or []
        pmids.extend(str(p) for p in batch if str(p).isdigit())
        try:
            total = int(res.get("count") or 0)
        except (TypeError, ValueError):
            total = len(pmids)
        if len(batch) < _ESEARCH_RETMAX or len(pmids) >= total:
            break
        retstart += _ESEARCH_RETMAX
        time.sleep(_INTER_BATCH_SLEEP_S)
    return pmids


def _esummary_one_batch(pmids: list[str]) -> dict[str, dict]:
    """One esummary call. Returns {pmid: {title, authors, year, journal,
    doi, pmcid}}. Missing PMIDs are silently dropped."""
    if not pmids:
        return {}
    try:
        r = requests.get(_PUBMED_ESUMMARY, params={
            "db":      "pubmed",
            "id":      ",".join(pmids),
            "retmode": "json",
        }, headers=_HDRS, timeout=_TIMEOUT)
        r.raise_for_status()
    except Exception as exc:
        logger.debug("pubmed_inventory: esummary batch failed (%s)", exc)
        return {}
    try:
        res = (_loose_json(r).get("result") or {})
    except Exception as exc:
        # PubMed occasionally serves a chunk with bare control bytes.
        # Skip this batch so the harvest keeps moving; the next pass
        # will retry the same PMIDs.
        logger.warning("pubmed_inventory: esummary JSON parse failed (%s)", exc)
        return {}
    out: dict[str, dict] = {}
    for pid in pmids:
        s = res.get(pid)
        if not isinstance(s, dict):
            continue
        authors = "; ".join(
            (a.get("name") or "").strip()
            for a in (s.get("authors") or []) if a.get("name")
        ) or None
        year = None
        m = re.match(r"(\d{4})", s.get("pubdate") or "")
        if m:
            year = int(m.group(1))
        doi = None
        pmcid = None
        for aid in s.get("articleids") or []:
            kind = (aid.get("idtype") or "").lower()
            val  = (aid.get("value") or "").strip()
            if not val:
                continue
            if kind == "doi" and not doi:
                doi = val.lower()
            elif kind in ("pmc", "pmcid") and not pmcid:
                # Normalise to "PMCNNNNN" if PubMed gave a bare digit.
                pmcid = val if val.lower().startswith("pmc") else f"PMC{val}"
        out[pid] = {
            "title":   (s.get("title") or "").rstrip(".").strip() or None,
            "authors": authors,
            "year":    year,
            "journal": s.get("fulljournalname") or s.get("source") or None,
            "doi":     doi,
            "pmcid":   pmcid,
        }
    return out


# ── Upsert ───────────────────────────────────────────────────────────────────

def _upsert_batch(meta_by_pmid: dict[str, dict]) -> tuple[int, int]:
    """UPSERT a metadata batch. Returns (inserted, updated)."""
    if not meta_by_pmid:
        return 0, 0
    rows = [
        {
            "pmid":    pmid,
            "title":   (m.get("title") or "")[:2000] or None,
            "authors": m.get("authors"),
            "year":    m.get("year"),
            "journal": (m.get("journal") or "")[:500] or None,
            "doi":     m.get("doi"),
            "pmcid":   m.get("pmcid"),
        }
        for pmid, m in meta_by_pmid.items()
    ]
    eng = _get_engine()
    inserted = updated = 0
    # Run the upserts in one transaction; xmax = 0 on the result row
    # means INSERT (not UPDATE) — that's how Postgres surfaces "was
    # this row newly created?" from a single ON CONFLICT statement.
    with eng.begin() as conn:
        for row in rows:
            res = conn.execute(sql_text("""
                INSERT INTO prionvault_pubmed_inventory
                  (pmid, title, authors, year, journal, doi, pmcid,
                   discovered_at, last_seen_at)
                VALUES (:pmid, :title, :authors, :year, :journal, :doi, :pmcid,
                        NOW(), NOW())
                ON CONFLICT (pmid) DO UPDATE
                  SET title        = COALESCE(EXCLUDED.title, prionvault_pubmed_inventory.title),
                      authors      = COALESCE(EXCLUDED.authors, prionvault_pubmed_inventory.authors),
                      year         = COALESCE(EXCLUDED.year, prionvault_pubmed_inventory.year),
                      journal      = COALESCE(EXCLUDED.journal, prionvault_pubmed_inventory.journal),
                      doi          = COALESCE(EXCLUDED.doi, prionvault_pubmed_inventory.doi),
                      pmcid        = COALESCE(EXCLUDED.pmcid, prionvault_pubmed_inventory.pmcid),
                      last_seen_at = NOW()
                RETURNING (xmax = 0) AS was_inserted
            """), row).first()
            if res is None:
                continue
            if res[0]:
                inserted += 1
            else:
                updated += 1
    return inserted, updated


# ── Reconciliation ───────────────────────────────────────────────────────────

def reconcile() -> int:
    """Stamp `imported_at` on every inventory row whose PMID is already
    in `articles`. Returns the number of newly-stamped rows.

    Two-way safety net: a manual ingest, a `/api/articles` POST, the
    DOI-batch importer — none of them touch the inventory directly, so
    we resync via LEFT JOIN here. Cheap (single indexed update)."""
    eng = _get_engine()
    try:
        with eng.begin() as conn:
            r = conn.execute(sql_text("""
                UPDATE prionvault_pubmed_inventory inv
                   SET imported_at = NOW()
                  FROM articles a
                 WHERE a.pubmed_id = inv.pmid
                   AND inv.imported_at IS NULL
                RETURNING inv.pmid
            """))
            return r.rowcount or 0
    except Exception as exc:
        logger.warning("pubmed_inventory: reconcile failed (%s)", exc)
        return 0


# ── Listing / stats ──────────────────────────────────────────────────────────

def get_stats() -> dict:
    eng = _get_engine()
    try:
        with eng.connect() as conn:
            row = conn.execute(sql_text("""
                SELECT
                    COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE imported_at IS NOT NULL) AS imported,
                    COUNT(*) FILTER (WHERE imported_at IS NULL AND dismissed = FALSE) AS pending,
                    COUNT(*) FILTER (WHERE dismissed = TRUE) AS dismissed,
                    COUNT(*) FILTER (
                      WHERE imported_at IS NULL AND dismissed = FALSE AND pmcid IS NOT NULL
                    ) AS pending_with_oa
                FROM prionvault_pubmed_inventory
            """)).first()
            # Imported-but-PDF-pending: the OA fetcher hasn't grabbed
            # them yet (or there's no OA copy at all). Counted on the
            # `articles` side because that's where dropbox_path lives.
            oa_row = conn.execute(sql_text("""
                SELECT
                    COUNT(*) FILTER (
                      WHERE source = 'pubmed_inventory'
                        AND dropbox_path IS NULL
                    ) AS inv_no_pdf,
                    COUNT(*) FILTER (
                      WHERE source = 'pubmed_inventory'
                        AND dropbox_path IS NOT NULL
                    ) AS inv_with_pdf,
                    COUNT(*) FILTER (
                      WHERE source = 'pubmed_inventory'
                        AND pdf_oa_status = 'not_available'
                    ) AS inv_no_oa
                  FROM articles
            """)).first()
            last = conn.execute(sql_text("""
                SELECT last_run_at, last_status, last_error,
                       last_runtime_ms, payload
                  FROM prionvault_scheduled_runs
                 WHERE name = :n
            """), {"n": LEASE_NAME}).first()
        out = {
            "total":           int(row[0] or 0),
            "imported":        int(row[1] or 0),
            "pending":         int(row[2] or 0),
            "dismissed":       int(row[3] or 0),
            "pending_with_oa": int(row[4] or 0),
            "inv_no_pdf":      int(oa_row[0] or 0),
            "inv_with_pdf":    int(oa_row[1] or 0),
            "inv_no_oa":       int(oa_row[2] or 0),
        }
        # OA fetcher snapshot (best-effort — never fails the stats call).
        try:
            from .oa_pdf_fetcher import get_status as _oa_status
            out["oa_fetcher"] = _oa_status()
        except Exception:
            pass
        if last:
            out["last_run_at"]     = last[0].isoformat() if last[0] else None
            out["last_status"]     = last[1]
            out["last_error"]      = last[2]
            out["last_runtime_ms"] = last[3]
            out["last_summary"]    = last[4]
        out["progress"] = get_progress()
        out["query"]    = PUBMED_QUERY
        return out
    except Exception as exc:
        logger.warning("pubmed_inventory: stats failed (%s)", exc)
        return {"error": str(exc)[:240]}


def list_pending(*, q: Optional[str] = None,
                 year_min: Optional[int] = None,
                 year_max: Optional[int] = None,
                 only_oa: bool = False,
                 page: int = 1,
                 size: int = 100) -> dict:
    """Listado paginado de PMIDs pendientes (ni importados ni descartados)."""
    page = max(1, int(page or 1))
    size = max(1, min(500, int(size or 100)))
    conditions = ["imported_at IS NULL", "dismissed = FALSE"]
    params: dict = {}
    if q:
        conditions.append(
            "(title ILIKE :q OR authors ILIKE :q OR journal ILIKE :q)"
        )
        params["q"] = f"%{q}%"
    if year_min is not None:
        conditions.append("year >= :ymin")
        params["ymin"] = year_min
    if year_max is not None:
        conditions.append("year <= :ymax")
        params["ymax"] = year_max
    if only_oa:
        conditions.append("pmcid IS NOT NULL")
    where = " AND ".join(conditions)

    eng = _get_engine()
    with eng.connect() as conn:
        total = conn.execute(sql_text(
            f"SELECT COUNT(*) FROM prionvault_pubmed_inventory WHERE {where}"
        ), params).scalar() or 0
        params["lim"] = size
        params["off"] = (page - 1) * size
        rows = conn.execute(sql_text(f"""
            SELECT pmid, title, authors, year, journal, doi, pmcid,
                   discovered_at, last_seen_at
              FROM prionvault_pubmed_inventory
             WHERE {where}
             ORDER BY year DESC NULLS LAST, last_seen_at DESC
             LIMIT :lim OFFSET :off
        """), params).mappings().all()
    items = [dict(r) for r in rows]
    for it in items:
        # ISO strings for JSON. Postgres returns datetime, which Flask
        # will refuse to encode by default.
        for k in ("discovered_at", "last_seen_at"):
            v = it.get(k)
            it[k] = v.isoformat() if hasattr(v, "isoformat") else v
        it["has_oa"] = bool(it.get("pmcid"))
    return {
        "total": int(total),
        "page":  page,
        "size":  size,
        "items": items,
    }


def dismiss(pmids: Iterable[str], *, by_user: Optional[str] = None) -> int:
    ids = [str(p).strip() for p in pmids if str(p).strip()]
    if not ids:
        return 0
    eng = _get_engine()
    with eng.begin() as conn:
        r = conn.execute(sql_text("""
            UPDATE prionvault_pubmed_inventory
               SET dismissed = TRUE,
                   dismissed_at = NOW(),
                   dismissed_by = :u
             WHERE pmid = ANY(:p)
               AND dismissed = FALSE
        """), {"p": ids, "u": by_user})
    return r.rowcount or 0


def undismiss(pmids: Iterable[str]) -> int:
    ids = [str(p).strip() for p in pmids if str(p).strip()]
    if not ids:
        return 0
    eng = _get_engine()
    with eng.begin() as conn:
        r = conn.execute(sql_text("""
            UPDATE prionvault_pubmed_inventory
               SET dismissed = FALSE,
                   dismissed_at = NULL,
                   dismissed_by = NULL
             WHERE pmid = ANY(:p)
               AND dismissed = TRUE
        """), {"p": ids})
    return r.rowcount or 0


# ── Import: inventory row → articles row ─────────────────────────────────────

def import_pmids(pmids: Iterable[str], *, by_user: Optional[str] = None) -> dict:
    """Promote inventory rows to `articles`. Returns
       {created: N, duplicates: M, failed: K, errors: [...]}.

    Each PMID is processed in its own savepoint so a partial failure
    (e.g. one duplicate-by-DOI) doesn't poison the rest of the batch.
    Uses the inventory's cached metadata — abstracts are deliberately
    left empty; the existing "Recuperar abstracts" batch picks them
    up via PubMed efetch.
    """
    ids = [str(p).strip() for p in pmids if str(p).strip()]
    if not ids:
        return {"created": 0, "duplicates": 0, "failed": 0, "errors": []}

    eng = _get_engine()
    summary = {"created": 0, "duplicates": 0, "failed": 0, "errors": []}

    # Load the inventory rows in one shot.
    with eng.connect() as conn:
        rows = conn.execute(sql_text("""
            SELECT pmid, title, authors, year, journal, doi, pmcid
              FROM prionvault_pubmed_inventory
             WHERE pmid = ANY(:p)
        """), {"p": ids}).mappings().all()
    meta_by_pmid = {r["pmid"]: dict(r) for r in rows}

    for pmid in ids:
        meta = meta_by_pmid.get(pmid)
        if not meta:
            summary["failed"] += 1
            summary["errors"].append({"pmid": pmid, "error": "not_in_inventory"})
            continue
        try:
            created = _create_article_from_meta(meta, by_user=by_user)
        except Exception as exc:
            summary["failed"] += 1
            summary["errors"].append({"pmid": pmid, "error": str(exc)[:200]})
            logger.warning("pubmed_inventory: import %s failed (%s)", pmid, exc)
            continue
        if created == "created":
            summary["created"] += 1
        elif created == "duplicate":
            summary["duplicates"] += 1
        # Mark imported either way — duplicates mean the article already
        # exists, which is exactly the state the inventory wants to
        # reflect.
        try:
            with eng.begin() as conn:
                conn.execute(sql_text("""
                    UPDATE prionvault_pubmed_inventory
                       SET imported_at = NOW()
                     WHERE pmid = :p
                       AND imported_at IS NULL
                """), {"p": pmid})
        except Exception as exc:
            logger.warning("pubmed_inventory: imported_at stamp failed for %s (%s)",
                           pmid, exc)

    # Wake the OA-PDF fetcher so the new rows get their PDFs as soon
    # as the daemon can manage. Best-effort — a hot import that lands
    # before the fetcher boots will still be picked up on the next
    # 60-second poll cycle.
    if summary["created"]:
        try:
            from .oa_pdf_fetcher import request_drain_now
            request_drain_now()
        except Exception as exc:
            logger.warning("pubmed_inventory: could not wake OA fetcher (%s)", exc)
    return summary


def _create_article_from_meta(meta: dict, *, by_user: Optional[str]) -> str:
    """Insert one inventory row into `articles`. Returns "created" or
    "duplicate". Raises on unexpected errors."""
    eng = _get_engine()
    pmid    = meta.get("pmid")
    doi     = (meta.get("doi") or "").strip().lower() or None
    title   = meta.get("title") or "(sin título)"
    with eng.begin() as conn:
        # Duplicate-by-PMID is the common case (article ingested by some
        # other path, but never reconciled into the inventory). Use the
        # same checks as POST /api/articles so behaviour matches.
        if pmid:
            dup = conn.execute(sql_text(
                "SELECT 1 FROM articles WHERE pubmed_id = :p LIMIT 1"
            ), {"p": pmid}).first()
            if dup:
                return "duplicate"
        if doi:
            dup = conn.execute(sql_text(
                "SELECT 1 FROM articles WHERE lower(doi) = :d LIMIT 1"
            ), {"d": doi}).first()
            if dup:
                return "duplicate"

        new_id = _uuid.uuid4()
        conn.execute(sql_text("""
            INSERT INTO articles
              (id, title, authors, year, journal, doi, pubmed_id, pmc_id,
               source, added_by_id, created_at, updated_at)
            VALUES
              (:id, :title, :authors, :year, :journal, :doi, :pmid, :pmcid,
               'pubmed_inventory', :added_by, NOW(), NOW())
        """), {
            "id":       str(new_id),
            "title":    title,
            "authors":  meta.get("authors"),
            "year":     meta.get("year"),
            "journal": (meta.get("journal") or "")[:500] or None,
            "doi":      doi,
            "pmid":     pmid,
            "pmcid":    meta.get("pmcid"),
            "added_by": by_user,
        })
    return "created"


# ── Harvest orchestration ────────────────────────────────────────────────────

def harvest_once() -> dict:
    """Run a single harvest pass. Returns summary {pmids_seen, inserted,
    updated, reconciled, runtime_ms}. Safe to call from any thread; the
    in-memory progress state is mutex-protected."""
    if _state["running"]:
        return {"skipped": "already_running", "progress": get_progress()}
    _set_state(running=True, started_at=datetime.now(timezone.utc).isoformat(),
               finished_at=None, stage="esearch",
               pmids_seen=0, pmids_inserted=0, pmids_updated=0,
               last_error=None)
    started = time.monotonic()
    inserted = updated = reconciled = 0
    error: Optional[str] = None

    try:
        all_pmids = _esearch_all(PUBMED_QUERY)
        _set_state(stage="esummary", pmids_seen=len(all_pmids))

        # Batched esummary + UPSERT. Each batch upserts itself; we
        # don't accumulate everything in memory.
        for i in range(0, len(all_pmids), _ESUMMARY_BATCH):
            batch = all_pmids[i:i + _ESUMMARY_BATCH]
            meta = _esummary_one_batch(batch)
            ins, upd = _upsert_batch(meta)
            inserted += ins
            updated  += upd
            with _lock:
                _state["pmids_inserted"] = inserted
                _state["pmids_updated"]  = updated
            time.sleep(_INTER_BATCH_SLEEP_S)

        _set_state(stage="reconcile")
        reconciled = reconcile()
        _set_state(stage="done")
    except Exception as exc:
        logger.exception("pubmed_inventory: harvest crashed")
        error = str(exc)[:600]
        _set_state(last_error=error)

    runtime_ms = int((time.monotonic() - started) * 1000)
    summary = {
        "pmids_seen":      len(all_pmids) if 'all_pmids' in locals() else 0,
        "pmids_inserted":  inserted,
        "pmids_updated":   updated,
        "reconciled":      reconciled,
        "runtime_ms":      runtime_ms,
    }
    _record_run(status=("ok" if error is None else "error"),
                runtime_ms=runtime_ms, summary=summary, error=error)
    _set_state(running=False,
               finished_at=datetime.now(timezone.utc).isoformat())
    return summary


# ── Background daemon ────────────────────────────────────────────────────────

def request_harvest_now() -> None:
    """Asks the daemon to run a harvest immediately (bypassing the
    7-day interval). Safe to call from any thread."""
    _force.set()


def _config() -> dict:
    """Daemon configuration read at start-up + on every loop tick."""
    return {
        "disabled":     os.environ.get("PRIONVAULT_PUBMED_INVENTORY_DISABLED",
                                       "").strip() in ("1", "true", "True"),
        "interval_days": _env_int("PRIONVAULT_PUBMED_INVENTORY_INTERVAL_DAYS",
                                  DEFAULT_INTERVAL_DAYS),
        "poll_seconds": _env_int("PRIONVAULT_PUBMED_INVENTORY_POLL_SECONDS",
                                 3_600),    # 1 h
    }


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        logger.warning("pubmed_inventory: %s=%r not an int, using %d",
                       name, raw, default)
        return default


def _run_loop() -> None:
    while not _stop.is_set():
        cfg = _config()
        if cfg["disabled"]:
            # Sleep on _force so an env-flip + "Refrescar" click wakes
            # us instead of waiting a full poll cycle.
            _force.wait(timeout=cfg["poll_seconds"])
            _force.clear()
            continue

        was_forced = _force.is_set()
        _force.clear()

        if was_forced:
            # Bypass the lease's interval check by stealing the lease
            # unconditionally — mirrors auto_scan.
            claimed = _claim_lease(interval_days=0)
        else:
            claimed = _claim_lease(interval_days=cfg["interval_days"])

        if claimed:
            try:
                harvest_once()
            except Exception:
                logger.exception("pubmed_inventory: harvest_once crashed")

        # Sleep on _force so the modal's "Refrescar PubMed" button
        # wakes us immediately instead of waiting up to a full hour.
        # threading.Event.wait returns True if the event was set,
        # False on timeout — either way we loop, but the wake on
        # force lets the operator drive the daemon interactively.
        _force.wait(timeout=cfg["poll_seconds"])


def start_inventory_daemon() -> Optional[threading.Thread]:
    """Start the background daemon. Idempotent — repeated calls return
    the existing thread. Returns None if the daemon is disabled by env."""
    global _thread
    if _thread and _thread.is_alive():
        return _thread
    cfg = _config()
    if cfg["disabled"]:
        logger.info("pubmed_inventory: daemon disabled by env")
        return None
    _stop.clear()
    _thread = threading.Thread(target=_run_loop,
                               name="prionvault-pubmed-inventory",
                               daemon=True)
    _thread.start()
    return _thread
