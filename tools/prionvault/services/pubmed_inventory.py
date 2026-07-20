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
# Named preset queries. Each preset is harvested independently so per-preset
# counts are meaningful and new presets don't disturb existing inventory rows.
PRESET_QUERIES: dict[str, str] = {
    "prion": (
        'prion[Title/Abstract] OR prions[MeSH Major Topic] OR '
        '"prion protein"[Title/Abstract] OR PrPSc[Title/Abstract]'
    ),
    "prion_like": (
        '"prion-like"[Title/Abstract] OR prionoid[Title/Abstract] OR '
        '"prion domain"[Title/Abstract]'
    ),
    "aav": (
        '(AAV[Title/Abstract] OR "adeno-associated virus"[Title/Abstract]) '
        'AND "gene therapy"[Title/Abstract]'
    ),
}

# Keep backward-compat alias used by legacy code / tests.
PUBMED_QUERY = PRESET_QUERIES["prion"]

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

def _year_buckets() -> list[tuple[int, int]]:
    """Range buckets that split the corpus into chunks small enough
    for retstart-paging to work without falling into PubMed's 9999
    cap. 5-year windows starting in 1960 cover every prion paper
    ever indexed by PubMed; per-bucket size is typically <3000."""
    from datetime import date
    buckets: list[tuple[int, int]] = []
    start = 1960
    end_year = date.today().year + 1   # include current calendar year
    while start <= end_year:
        buckets.append((start, min(start + 4, end_year)))
        start += 5
    return buckets


def _esearch_page(query: str, retstart: int, retmax: int
                  ) -> tuple[list[str], int, Optional[str]]:
    """One page of an esearch result set.

    Returns (idlist, total_count, error_msg). On a transient error
    (network, timeout, 5xx, JSON parse) the caller should retry; the
    error message is included for logging so the operator can see
    *why* the page failed.
    """
    try:
        r = requests.get(_PUBMED_ESEARCH, params={
            "db":       "pubmed",
            "term":     query,
            "retmax":   str(retmax),
            "retstart": str(retstart),
            "retmode":  "json",
        }, headers=_HDRS, timeout=20.0)
    except Exception as exc:
        return [], 0, f"network: {exc}"
    if r.status_code != 200:
        body = (r.text or "")[:200].replace("\n", " ")
        return [], 0, f"http_{r.status_code}: {body}"
    try:
        data = _loose_json(r) or {}
    except Exception as exc:
        body = (r.text or "")[:200].replace("\n", " ")
        return [], 0, f"json_parse: {exc} (body head: {body!r})"
    res = data.get("esearchresult") or {}
    try:
        total = int(res.get("count") or 0)
    except (TypeError, ValueError):
        total = 0
    batch = res.get("idlist") or []
    if not isinstance(batch, list):
        return [], total, f"unexpected idlist type: {type(batch).__name__}"
    return [str(p) for p in batch if str(p).isdigit()], total, None


def _esearch_one_bucket(query: str, ymin: int, ymax: int,
                        already_seen: set[str]) -> list[str]:
    """Paginate a single year-bucketed query. Each bucket is small
    enough (<<9999) that simple retstart paging works reliably without
    needing PubMed's History server."""
    scoped = f"({query}) AND ({ymin}:{ymax}[PDAT])"
    bucket_pmids: list[str] = []
    expected_total: Optional[int] = None
    retstart = 0
    page_idx = 0

    while True:
        page_idx += 1
        batch: list[str] = []
        total = 0
        last_err: Optional[str] = None
        for attempt in range(1, 4):
            batch, total, last_err = _esearch_page(scoped, retstart, _ESEARCH_RETMAX)
            if last_err is None:
                break
            logger.warning(
                "pubmed_inventory: bucket %d-%d page %d retstart=%d attempt %d/3: %s",
                ymin, ymax, page_idx, retstart, attempt, last_err,
            )
            time.sleep(2.0 * attempt)
        if last_err:
            logger.warning(
                "pubmed_inventory: giving up on bucket %d-%d page %d (%s)",
                ymin, ymax, page_idx, last_err,
            )
            break
        if expected_total is None:
            expected_total = total
        gained = 0
        for p in batch:
            if p in already_seen:
                continue
            already_seen.add(p)
            bucket_pmids.append(p)
            gained += 1
        logger.info(
            "pubmed_inventory: bucket %d-%d page %d → batch=%d gained=%d "
            "bucket_total=%d/%d",
            ymin, ymax, page_idx, len(batch), gained,
            len(bucket_pmids), expected_total,
        )
        if not batch or len(bucket_pmids) >= expected_total:
            break
        # Hard guard: don't paginate past PubMed's anonymous limit.
        retstart += len(batch)
        if retstart >= 9999:
            # This bucket has >9999 prion papers — shouldn't happen
            # for 5-year windows but if it does, log loudly.
            logger.warning(
                "pubmed_inventory: bucket %d-%d hit the 9999 retstart cap "
                "(consider shrinking the bucket width)",
                ymin, ymax,
            )
            break
        time.sleep(_INTER_BATCH_SLEEP_S)
    return bucket_pmids


def _esearch_all(query: str) -> list[str]:
    """Walk every PMID for `query` by chunking the date range into
    buckets that never exceed the 9999 retstart cap, then paging
    each bucket normally. Progress is reported via
    _set_state(pmids_seen=…) so the modal counter ticks up across
    buckets rather than jumping at the end.
    """
    seen: set[str] = set()
    all_pmids: list[str] = []
    buckets = _year_buckets()
    logger.info("pubmed_inventory: harvesting in %d year-buckets", len(buckets))
    for ymin, ymax in buckets:
        bucket_pmids = _esearch_one_bucket(query, ymin, ymax, seen)
        all_pmids.extend(bucket_pmids)
        _set_state(pmids_seen=len(all_pmids))
        # Polite pause between buckets so we never burst NCBI faster
        # than ~3 req/s without an API key.
        time.sleep(_INTER_BATCH_SLEEP_S)
    return all_pmids


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


# ── PMC OA verification ───────────────────────────────────────────────────────

_PMC_OA_API = "https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi"


def _check_pmc_oa_batch(pmcids: list[str]) -> set[str]:
    """Query the NCBI PMC OA web service for a batch of PMCIDs.
    Returns the subset that have a freely downloadable full text.
    Empty set on any error (fail-open: caller treats as unverified).
    """
    if not pmcids:
        return set()
    # API accepts comma-separated IDs, limit ~200 per call.
    try:
        r = requests.get(
            _PMC_OA_API,
            params={"id": ",".join(pmcids)},
            headers=_HDRS,
            timeout=15.0,
        )
        r.raise_for_status()
    except Exception as exc:
        logger.debug("pmc_oa_check: request failed (%s)", exc)
        return set()
    # Response is XML: <OA><records offset="0" limit="...">
    #   <record id="PMCxxxxxxx" ...><link format="pdf" href="..."/></record>
    # An absent <record> means not in OA subset.
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(r.text)
    except ET.ParseError as exc:
        logger.debug("pmc_oa_check: XML parse failed (%s)", exc)
        return set()
    verified: set[str] = set()
    for rec in root.iter("record"):
        pmcid = rec.get("id", "")
        # Only count records that have at least one downloadable link
        if list(rec.iter("link")):
            verified.add(pmcid.upper())
    return verified


# ── Upsert ───────────────────────────────────────────────────────────────────

def _upsert_batch(meta_by_pmid: dict[str, dict],
                  query_name: str = "prion") -> tuple[int, int]:
    """UPSERT a metadata batch. Returns (inserted, updated).

    `query_name` is stored on INSERT; on conflict it is NOT overwritten
    so the first preset that discovered a PMID retains ownership.
    """
    if not meta_by_pmid:
        return 0, 0
    rows = [
        {
            "pmid":       pmid,
            "title":      (m.get("title") or "")[:2000] or None,
            "authors":    m.get("authors"),
            "year":       m.get("year"),
            "journal":    (m.get("journal") or "")[:500] or None,
            "doi":        m.get("doi"),
            "pmcid":      m.get("pmcid"),
            "query_name": query_name,
        }
        for pmid, m in meta_by_pmid.items()
    ]

    # Verify OA availability via PMC OA web service for rows with a PMCID.
    pmcids_to_check = [r["pmcid"] for r in rows if r.get("pmcid")]
    oa_verified_set: set[str] = set()
    if pmcids_to_check:
        oa_verified_set = _check_pmc_oa_batch(pmcids_to_check)

    for r in rows:
        pmcid = (r.get("pmcid") or "").upper()
        r["oa_verified"] = pmcid in oa_verified_set if pmcid else False

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
                   query_name, oa_verified, discovered_at, last_seen_at)
                VALUES (:pmid, :title, :authors, :year, :journal, :doi, :pmcid,
                        :query_name, :oa_verified, NOW(), NOW())
                ON CONFLICT (pmid) DO UPDATE
                  SET title        = COALESCE(EXCLUDED.title, prionvault_pubmed_inventory.title),
                      authors      = COALESCE(EXCLUDED.authors, prionvault_pubmed_inventory.authors),
                      year         = COALESCE(EXCLUDED.year, prionvault_pubmed_inventory.year),
                      journal      = COALESCE(EXCLUDED.journal, prionvault_pubmed_inventory.journal),
                      doi          = COALESCE(EXCLUDED.doi, prionvault_pubmed_inventory.doi),
                      pmcid        = COALESCE(EXCLUDED.pmcid, prionvault_pubmed_inventory.pmcid),
                      oa_verified  = EXCLUDED.oa_verified OR prionvault_pubmed_inventory.oa_verified,
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
                    ) AS pending_with_oa,
                    -- "kept" = the operator clicked "Esta sí" and the
                    -- article has neither been imported nor dismissed
                    -- yet. Drives the new "⭐ Marcados" tab counter.
                    COUNT(*) FILTER (
                      WHERE kept_at IS NOT NULL
                        AND imported_at IS NULL
                        AND dismissed = FALSE
                    ) AS kept
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
            "kept":            int(row[5] or 0),
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
        # Per-preset pending counts.
        try:
            preset_rows = conn.execute(sql_text("""
                SELECT query_name, COUNT(*) AS count
                  FROM prionvault_pubmed_inventory
                 WHERE imported_at IS NULL AND dismissed = FALSE
                 GROUP BY query_name
            """)).mappings().all()
            out["per_preset"] = [
                {"query_name": r["query_name"], "count": int(r["count"])}
                for r in preset_rows
            ]
        except Exception:
            out["per_preset"] = []
        out["progress"] = get_progress()
        out["query"]    = PUBMED_QUERY
        out["presets"]  = list(PRESET_QUERIES.keys())
        return out
    except Exception as exc:
        logger.warning("pubmed_inventory: stats failed (%s)", exc)
        return {"error": str(exc)[:240]}


def list_pending(*, q: Optional[str] = None,
                 year_min: Optional[int] = None,
                 year_max: Optional[int] = None,
                 only_oa: bool = False,
                 days: Optional[int] = None,
                 status: str = "pending",
                 page: int = 1,
                 size: int = 100) -> dict:
    """Listado paginado del inventario.

    `status`:
      - "pending"   (default) — ni importados ni descartados
      - "dismissed" — los rechazados con ✗ Descartar
      - "imported"  — los que ya tienes en PrionVault
    """
    page = max(1, int(page or 1))
    size = max(1, min(500, int(size or 100)))

    status = (status or "pending").strip().lower()
    if status == "dismissed":
        conditions = ["dismissed = TRUE"]
        order_by   = "dismissed_at DESC NULLS LAST"
    elif status == "imported":
        conditions = ["imported_at IS NOT NULL"]
        order_by   = "imported_at DESC NULLS LAST"
    elif status == "kept":
        # "Esta sí" — the operator marked the row as wanted but hasn't
        # imported it yet. Sort by most-recently-kept on top so the
        # latest decisions are easy to find.
        conditions = ["kept_at IS NOT NULL",
                      "imported_at IS NULL",
                      "dismissed = FALSE"]
        order_by   = "kept_at DESC NULLS LAST"
    else:
        status = "pending"
        # Pending = neither imported nor dismissed. Note that kept rows
        # ALSO match "pending" — the operator wants them to keep showing
        # up in normal searches; the "kept" tab is just an extra lens.
        conditions = ["imported_at IS NULL", "dismissed = FALSE"]
        order_by   = "year ASC NULLS LAST, pmid ASC"

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
    if days is not None and days > 0:
        conditions.append("discovered_at >= NOW() - (:days * INTERVAL '1 day')")
        params["days"] = int(days)
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
                   query_name, discovered_at, last_seen_at, dismissed_at,
                   imported_at, kept_at, oa_verified
              FROM prionvault_pubmed_inventory
             WHERE {where}
             ORDER BY {order_by}
             LIMIT :lim OFFSET :off
        """), params).mappings().all()
    items = [dict(r) for r in rows]
    for it in items:
        # ISO strings for JSON. Postgres returns datetime, which Flask
        # will refuse to encode by default.
        for k in ("discovered_at", "last_seen_at", "dismissed_at",
                  "imported_at", "kept_at"):  # type: ignore[assignment]
            v = it.get(k)
            it[k] = v.isoformat() if hasattr(v, "isoformat") else v
        it["has_oa"] = bool(it.get("pmcid"))
        # Frontend convenience: a boolean is easier to switch button
        # state on than a nullable timestamp.
        it["kept"] = it.get("kept_at") is not None
    return {
        "total":  int(total),
        "page":   page,
        "size":   size,
        "status": status,
        "items":  items,
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


def keep(pmids: Iterable[str], *, by_user: Optional[str] = None) -> int:
    """Mark rows as "Esta sí" — the operator explicitly wants them.

    Idempotent: rows that are already kept stay kept (no-op). Rows
    that are already imported get the kept_at stamp anyway so the
    decision is recorded, but the "kept" tab filter still hides them
    via the imported_at != NULL check.

    Side effect: a kept row that was previously dismissed is
    un-dismissed in the same transaction. A "yes" decision overrides
    an earlier "no" — that's the intent the user usually has when
    re-evaluating a row.
    """
    ids = [str(p).strip() for p in pmids if str(p).strip()]
    if not ids:
        return 0
    eng = _get_engine()
    with eng.begin() as conn:
        r = conn.execute(sql_text("""
            UPDATE prionvault_pubmed_inventory
               SET kept_at      = COALESCE(kept_at, NOW()),
                   kept_by      = COALESCE(kept_by, :u),
                   dismissed    = FALSE,
                   dismissed_at = NULL,
                   dismissed_by = NULL
             WHERE pmid = ANY(:p)
        """), {"p": ids, "u": by_user})
    return r.rowcount or 0


def unkeep(pmids: Iterable[str]) -> int:
    """Reverse a previous "Esta sí" decision so the row goes back to
    being a plain pending entry. Does NOT mark it dismissed — the
    operator has to explicitly click "Esta no" for that."""
    ids = [str(p).strip() for p in pmids if str(p).strip()]
    if not ids:
        return 0
    eng = _get_engine()
    with eng.begin() as conn:
        r = conn.execute(sql_text("""
            UPDATE prionvault_pubmed_inventory
               SET kept_at = NULL,
                   kept_by = NULL
             WHERE pmid = ANY(:p)
               AND kept_at IS NOT NULL
        """), {"p": ids})
    return r.rowcount or 0



# ── Purge pending ─────────────────────────────────────────────────────────────

def purge_pending() -> int:
    """Delete all rows that are still pending (not dismissed, not kept,
    not imported). Returns the number of rows deleted.

    This lets the operator reset the search history without having to
    decide anything about the articles — they simply vanish as if the
    search had never happened. Kept (★) and dismissed rows are untouched.
    """
    eng = _get_engine()
    with eng.begin() as conn:
        r = conn.execute(sql_text("""
            DELETE FROM prionvault_pubmed_inventory
             WHERE dismissed = FALSE
               AND imported_at IS NULL
               AND kept_at    IS NULL
        """))
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

    Articles imported via email digest button are flagged for the importing
    user. PDFs are sourced via OA fetcher (Unpaywall + Europe PMC) or the
    ingest queue if readily available.
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
            # Try to fetch OA PDF for newly created articles
            # This integrates imports with the OA pipeline so they follow
            # the same processing path as email ingests
            if by_user:
                try:
                    _try_enqueue_oa_pdf(meta, by_user)
                except Exception as exc:
                    logger.debug("pubmed_inventory: OA enqueue skipped for %s (%s)",
                                pmid, exc)
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


def _try_enqueue_oa_pdf(meta: dict, by_user: str) -> None:
    """Attempt to download an OA PDF for an article and enqueue it.

    Tries Unpaywall (by DOI) and Europe PMC (by PMC ID) in parallel-ish.
    If a PDF is found, it's enqueued just like an email ingest so it
    follows the same processing pipeline (extraction, metadata, indexing).
    If not found or if the download fails, the OA PDF fetcher will try
    again later — this is best-effort only.
    """
    from ..ingestion.queue import enqueue_pdf
    from . import unpaywall

    doi = (meta.get("doi") or "").strip().lower() or None
    pmcid = meta.get("pmcid")
    pmid = meta.get("pmid")
    title = (meta.get("title") or "(sin título)")[:100]

    pdf_content = None
    pdf_source = None

    # Try Unpaywall first (usually faster)
    if doi:
        try:
            pdf_bytes = unpaywall.download_pdf(doi)
            if pdf_bytes:
                pdf_content = pdf_bytes
                pdf_source = "unpaywall"
        except Exception as exc:
            logger.debug("pubmed_inventory: Unpaywall failed for %s: %s", doi, exc)

    # Fallback to Europe PMC if we don't have a PDF yet
    if not pdf_content and pmcid:
        try:
            import requests
            pmc_url = f"https://europepmc.org/articles/{pmcid}/pdf"
            resp = requests.get(pmc_url, timeout=15, allow_redirects=True)
            if resp.status_code == 200 and len(resp.content) > 1000:
                pdf_content = resp.content
                pdf_source = "europe_pmc"
        except Exception as exc:
            logger.debug("pubmed_inventory: Europe PMC failed for %s: %s", pmcid, exc)

    # If we got a PDF, enqueue it
    if pdf_content:
        try:
            filename = f"pmid_{pmid}_{title[:50].replace(' ', '_')}.pdf"
            job_id = enqueue_pdf(
                content=pdf_content,
                filename=filename,
                user_id=by_user,
            )
            logger.info("pubmed_inventory: enqueued OA PDF for PMID %s (source=%s, job=%d)",
                       pmid, pdf_source, job_id)
        except Exception as exc:
            logger.warning("pubmed_inventory: enqueue failed for PMID %s: %s", pmid, exc)


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
        # Add flag for the importing user
        if by_user:
            conn.execute(sql_text("""
                INSERT INTO prionvault_user_state
                  (user_id, article_id, is_flagged, created_at, updated_at)
                VALUES (CAST(:uid AS uuid), CAST(:aid AS uuid), TRUE, NOW(), NOW())
                ON CONFLICT (user_id, article_id) DO UPDATE
                   SET is_flagged = TRUE, updated_at = NOW()
            """), {
                "uid": by_user,
                "aid": str(new_id),
            })
    return "created"


# ── Harvest orchestration ────────────────────────────────────────────────────

def harvest_once(query: Optional[str] = None,
                 query_name: Optional[str] = None,
                 min_year: Optional[int] = None) -> dict:
    """Run a single harvest pass for one query.

    If called with no args, uses the default "prion" preset.
    Returns summary {pmids_seen, inserted, updated, reconciled, runtime_ms}.
    Safe to call from any thread; the in-memory progress state is mutex-protected.
    """
    if query is None:
        query = PUBMED_QUERY
    if query_name is None:
        query_name = "prion"

    # Apply year filter if requested.
    if min_year is not None:
        query = f"({query}) AND {min_year}:3000[DP]"

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
        all_pmids = _esearch_all(query)
        _set_state(stage="esummary", pmids_seen=len(all_pmids))

        stopped = False
        # Batched esummary + UPSERT. Each batch upserts itself; we
        # don't accumulate everything in memory.
        for i in range(0, len(all_pmids), _ESUMMARY_BATCH):
            if _stop.is_set():
                _stop.clear()
                stopped = True
                break
            batch = all_pmids[i:i + _ESUMMARY_BATCH]
            meta = _esummary_one_batch(batch)
            ins, upd = _upsert_batch(meta, query_name=query_name)
            inserted += ins
            updated  += upd
            with _lock:
                _state["pmids_inserted"] = inserted
                _state["pmids_updated"]  = updated
            time.sleep(_INTER_BATCH_SLEEP_S)

        if not stopped:
            _set_state(stage="reconcile")
            reconciled = reconcile()
        _set_state(stage="stopped" if stopped else "done")
        if stopped:
            error = "stopped_by_user"
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
        "query_name":      query_name,
    }
    _record_run(status=("ok" if error is None else "error"),
                runtime_ms=runtime_ms, summary=summary, error=error)
    _set_state(running=False,
               finished_at=datetime.now(timezone.utc).isoformat())
    return summary


def harvest(query: Optional[str] = None,
            query_name: Optional[str] = None,
            min_year: Optional[int] = None) -> dict:
    """Convenience alias for harvest_once with explicit query/query_name."""
    return harvest_once(query=query, query_name=query_name, min_year=min_year)


def harvest_all(min_year: Optional[int] = None) -> list[dict]:
    """Run harvest_once() for every preset in PRESET_QUERIES in sequence.
    Returns a list of per-preset summaries. Used by the daemon and the
    refresh endpoint when preset='all'."""
    summaries = []
    for name, q in PRESET_QUERIES.items():
        summary = harvest_once(query=q, query_name=name, min_year=min_year)
        summaries.append(summary)
    return summaries


# ── Background daemon ────────────────────────────────────────────────────────

def request_harvest_now() -> None:
    """Asks the daemon to run a harvest immediately (bypassing the
    7-day interval). Safe to call from any thread."""
    _force.set()


def request_stop_harvest() -> None:
    """Ask the running harvest to stop after the current batch."""
    _stop.set()
    _force.clear()


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
                harvest_all()
            except Exception:
                logger.exception("pubmed_inventory: harvest_all crashed")

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
