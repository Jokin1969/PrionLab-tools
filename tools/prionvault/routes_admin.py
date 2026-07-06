"""Admin-only batch operation routes for PrionVault.

Extracted from routes.py to keep that file manageable.
Imported at the bottom of routes.py so these routes are
registered on prionvault_bp as a side effect of that import.
"""
import logging
import threading
import os
import re
from datetime import datetime

from flask import jsonify, request, session, Response, current_app
from sqlalchemy import text as sql_text

from core.decorators import admin_required, login_required
from database.config import db
from . import prionvault_bp, models
from ._helpers import _viewer_role, _viewer_id, _session

logger = logging.getLogger(__name__)

# ── Batch embedding indexing (Phase 4) ──────────────────────────────────────
@prionvault_bp.route("/api/admin/batch-index/status", methods=["GET"])
@admin_required
def api_batch_index_status():
    from .services import batch_index
    return jsonify(batch_index.get_status())


@prionvault_bp.route("/api/admin/batch-index/start", methods=["POST"])
@admin_required
def api_batch_index_start():
    from .services import batch_index
    data = request.get_json(force=True, silent=True) or {}
    limit = data.get("limit")
    if limit is not None:
        try:
            limit = int(limit)
            if limit <= 0:
                limit = None
        except (TypeError, ValueError):
            return jsonify({"error": "limit must be a positive integer"}), 400

    snap = batch_index.start_batch(viewer_user_id=_viewer_id(), limit=limit)
    if snap is None:
        return jsonify({"error": "already_running",
                        "status": batch_index.get_status()}), 409
    return jsonify({"ok": True, "status": snap})


@prionvault_bp.route("/api/admin/embeddings/coverage", methods=["GET"])
@admin_required
def api_embeddings_coverage():
    """Return chunk coverage stats per source_field (pdf / abstract / summary_ai)."""
    from sqlalchemy import text as _t
    from database.config import db as _db
    try:
        with _db.engine.connect() as conn:
            # Total articles
            total = conn.execute(_t("SELECT count(*) FROM articles")).scalar() or 0
            # PDF indexed
            pdf_indexed = conn.execute(_t(
                "SELECT count(DISTINCT article_id) FROM article_chunk "
                "WHERE source_field = 'extracted_text'"
            )).scalar() or 0
            # Abstracts available (not placeholder, not unavailable)
            abstracts_available = conn.execute(_t(
                """SELECT count(*) FROM articles
                    WHERE abstract IS NOT NULL AND length(abstract) > 50
                      AND (abstract_unavailable IS NULL OR abstract_unavailable = FALSE)
                      AND lower(abstract) NOT LIKE '%no abstract available%'
                      AND lower(abstract) NOT LIKE '%abstract not available%'
                      AND lower(abstract) NOT LIKE '%no abstract%'"""
            )).scalar() or 0
            # Abstracts indexed
            abstract_indexed = conn.execute(_t(
                "SELECT count(DISTINCT article_id) FROM article_chunk "
                "WHERE source_field = 'abstract'"
            )).scalar() or 0
            # Summaries available
            summaries_available = conn.execute(_t(
                "SELECT count(*) FROM articles "
                "WHERE summary_ai IS NOT NULL AND length(summary_ai) > 100"
            )).scalar() or 0
            # Summaries indexed
            summary_indexed = conn.execute(_t(
                "SELECT count(DISTINCT article_id) FROM article_chunk "
                "WHERE source_field = 'summary_ai'"
            )).scalar() or 0
    except Exception as exc:
        return jsonify({"error": str(exc)[:300]}), 500
    return jsonify({
        "total": total,
        "pdf":      {"available": total,        "indexed": pdf_indexed},
        "abstract": {"available": abstracts_available, "indexed": abstract_indexed},
        "summary":  {"available": summaries_available, "indexed": summary_indexed},
    })


@prionvault_bp.route("/api/admin/embeddings/add-pdf", methods=["POST"])
@admin_required
def api_embeddings_add_pdf():
    """Index extracted_text for articles that have PDF text but no extracted_text chunks yet.
    Non-destructive: existing abstract / summary_ai chunks are untouched."""
    from .embeddings.indexer import index_article_source
    from .embeddings.embedder import NotConfigured as VoyageNotConfigured
    from sqlalchemy import text as _t
    from database.config import db as _db
    import threading

    try:
        with _db.engine.connect() as conn:
            rows = conn.execute(_t(
                """
                SELECT a.id::text, a.title, a.extracted_text
                  FROM articles a
                 WHERE a.extracted_text IS NOT NULL
                   AND length(a.extracted_text) > 200
                   AND EXISTS (
                       SELECT 1 FROM article_chunk c WHERE c.article_id = a.id
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM article_chunk c
                        WHERE c.article_id = a.id AND c.source_field = 'extracted_text'
                   )
                 ORDER BY a.created_at DESC
                """
            )).all()
    except Exception as exc:
        return jsonify({"error": "query_failed", "detail": str(exc)[:300]}), 500

    total = len(rows)
    if total == 0:
        return jsonify({"ok": True, "queued": 0,
                        "detail": "All articles with PDF text already have extracted_text chunks."})

    def _run():
        ok = fail = 0
        for row in rows:
            try:
                index_article_source(
                    article_id=row[0],
                    source_field="extracted_text",
                    source_text=row[2],
                    title=row[1],
                )
                ok += 1
            except VoyageNotConfigured:
                break
            except Exception as exc:
                logger.warning("add-pdf: article %s failed: %s", row[0], exc)
                fail += 1
        logger.info("add-pdf finished: %d ok, %d failed", ok, fail)

    threading.Thread(target=_run, name="pv-add-pdf", daemon=True).start()
    return jsonify({"ok": True, "queued": total,
                    "detail": f"Indexing PDF text for {total} articles in background."})


@prionvault_bp.route("/api/admin/embeddings/add-abstracts", methods=["GET", "POST"])
@admin_required
def api_embeddings_add_abstracts():
    """GET: stats + first-10 pending articles for diagnosis.
    POST: index abstract for every article with valid abstract but no abstract chunk."""
    from .embeddings.indexer import index_article_source
    from .embeddings.embedder import NotConfigured as VoyageNotConfigured
    from sqlalchemy import text as _t
    from database.config import db as _db

    _ABSTRACT_FILTERS = """
        a.abstract IS NOT NULL
        AND length(a.abstract) > 50
        AND (a.abstract_unavailable IS NULL OR a.abstract_unavailable = FALSE)
        AND lower(a.abstract) NOT LIKE '%no abstract available%'
        AND lower(a.abstract) NOT LIKE '%abstract not available%'
        AND lower(a.abstract) NOT LIKE '%no abstract%'
        AND lower(a.abstract) NOT LIKE '%abstract not available in pubmed%'
        AND lower(a.abstract) NOT LIKE '%sin resumen disponible%'
    """

    try:
        with _db.engine.connect() as conn:
            rows = conn.execute(_t(
                f"""
                SELECT a.id::text, a.title, a.abstract
                  FROM articles a
                 WHERE {_ABSTRACT_FILTERS}
                   AND NOT EXISTS (
                       SELECT 1 FROM article_chunk c
                        WHERE c.article_id = a.id AND c.source_field = 'abstract'
                   )
                 ORDER BY a.created_at DESC
                """
            )).all()
    except Exception as exc:
        return jsonify({"error": "query_failed", "detail": str(exc)[:300]}), 500

    total = len(rows)

    if request.method == "GET":
        # Diagnostic: show pending count + first 10 article summaries
        samples = [
            {"id": r[0], "title": (r[1] or "")[:80],
             "abstract_len": len(r[2] or ""),
             "abstract_start": (r[2] or "")[:120]}
            for r in rows[:10]
        ]
        return jsonify({"pending": total, "samples": samples})

    if total == 0:
        return jsonify({"ok": True, "queued": 0,
                        "detail": "All articles already have abstract chunks."})

    import threading

    def _run():
        ok = fail = skip = 0
        for row in rows:
            try:
                result = index_article_source(
                    article_id=row[0],
                    source_field="abstract",
                    source_text=row[2],
                    title=row[1],
                )
                if result.chunks_written > 0:
                    ok += 1
                elif result.error:
                    logger.warning("add-abstracts: article %s skipped/failed: %s",
                                   row[0], result.error)
                    skip += 1
                else:
                    ok += 1
            except VoyageNotConfigured:
                logger.warning("add-abstracts: VOYAGE_API_KEY not set, stopping")
                break
            except Exception as exc:
                logger.warning("add-abstracts: article %s exception: %s", row[0], exc)
                fail += 1
        logger.info("add-abstracts finished: %d ok, %d skipped, %d failed",
                    ok, skip, fail)

    threading.Thread(target=_run, name="pv-add-abstracts", daemon=True).start()
    return jsonify({"ok": True, "queued": total,
                    "detail": f"Indexing abstracts for {total} articles in background."})


@prionvault_bp.route("/api/admin/embeddings/add-summaries", methods=["GET", "POST"])
@admin_required
def api_embeddings_add_summaries():
    """GET: return stats (how many have/don't have summary_ai chunks).
    POST: index summary_ai for articles missing those chunks."""
    from .embeddings.indexer import index_article_source
    from .embeddings.embedder import NotConfigured as VoyageNotConfigured
    from sqlalchemy import text as _t
    from database.config import db as _db
    import threading

    _SUMMARY_QUERY = """
        SELECT a.id::text, a.title, a.summary_ai
          FROM articles a
         WHERE a.summary_ai IS NOT NULL AND length(a.summary_ai) > 100
           AND NOT EXISTS (
               SELECT 1 FROM article_chunk c
                WHERE c.article_id = a.id AND c.source_field = 'summary_ai'
           )
         ORDER BY a.created_at DESC
    """

    try:
        with _db.engine.connect() as conn:
            rows = conn.execute(_t(_SUMMARY_QUERY)).all()
            total_with_summary = conn.execute(_t(
                "SELECT count(*) FROM articles "
                "WHERE summary_ai IS NOT NULL AND length(summary_ai) > 100"
            )).scalar() or 0
    except Exception as exc:
        return jsonify({"error": "query_failed", "detail": str(exc)[:300]}), 500

    already_indexed = total_with_summary - len(rows)

    if request.method == "GET":
        return jsonify({
            "total_with_summary": total_with_summary,
            "already_indexed": already_indexed,
            "pending": len(rows),
        })

    # POST — run the indexing
    if len(rows) == 0:
        return jsonify({"ok": True, "queued": 0,
                        "detail": "All articles with summaries already have summary_ai chunks."})

    def _run():
        ok = fail = skip = 0
        for row in rows:
            try:
                result = index_article_source(
                    article_id=row[0],
                    source_field="summary_ai",
                    source_text=row[2],
                    title=row[1],
                )
                if result.chunks_written > 0:
                    ok += 1
                elif result.error:
                    logger.warning("add-summaries: article %s skipped/failed: %s",
                                   row[0], result.error)
                    skip += 1
                else:
                    ok += 1
            except VoyageNotConfigured:
                logger.warning("add-summaries: VOYAGE_API_KEY not set, stopping")
                break
            except Exception as exc:
                logger.warning("add-summaries: article %s exception: %s", row[0], exc)
                fail += 1
        logger.info("add-summaries finished: %d ok, %d skipped, %d failed",
                    ok, skip, fail)

    threading.Thread(target=_run, name="pv-add-summaries", daemon=True).start()
    return jsonify({"ok": True, "queued": len(rows),
                    "detail": f"Indexing summaries for {len(rows)} articles in background."})


@prionvault_bp.route("/api/admin/embeddings/reset-and-reindex",
                     methods=["POST"])
@admin_required
def api_embeddings_reset_and_reindex():
    """Clean reindex: wipe every chunk + every index_version stamp,
    then kick the batch_index daemon to rebuild from scratch.

    Why this exists separately from /batch-index/start: a normal
    "start" only re-indexes articles whose stamp differs from the
    current MODEL. When you swap the embedding model entirely, you
    do NOT want the in-flight period where some articles already
    carry voyage-4 vectors and the rest still carry voyage-3 ones —
    pgvector mixes them in the same ORDER BY <=> ... query and the
    geometry between two different embedding spaces is meaningless.
    Better to return zero results for the not-yet-processed
    articles (clean miss) than wrong results from the mixed pool.

    Body (optional):
      { confirm: true }   guard so a misclicked button can't wipe
                          the chunk table by accident. Refused
                          without the flag.

    The wipe + reindex runs inside a single DB transaction (TRUNCATE
    + UPDATE) so the table is never in a partially-cleared state
    visible to readers.
    """
    from .services import batch_index
    from sqlalchemy import text as _t
    from database.config import db as _db

    body = request.get_json(force=True, silent=True) or {}
    if not body.get("confirm"):
        return jsonify({
            "error": "confirmation_required",
            "detail": ("Repeat the call with {\"confirm\": true}. "
                       "This wipes every chunk in article_chunk and "
                       "clears articles.index_version for every row."),
        }), 400

    if batch_index.get_status().get("running"):
        return jsonify({
            "error": "batch_index_running",
            "detail": "Stop the in-flight batch_index first."
        }), 409

    # Single transaction: either both succeed or neither.
    try:
        with _db.engine.begin() as conn:
            conn.execute(_t("TRUNCATE article_chunk"))
            conn.execute(_t(
                "UPDATE articles SET index_version = NULL "
                "WHERE index_version IS NOT NULL"
            ))
    except Exception as exc:
        logger.exception("reset-and-reindex: wipe failed")
        return jsonify({"error": "wipe_failed",
                        "detail": str(exc)[:300]}), 500

    # Now spin up the batch_index daemon — it'll see every article as
    # un-indexed and burn through the queue using the current MODEL.
    snap = batch_index.start_batch(viewer_user_id=_viewer_id(),
                                   limit=None)
    return jsonify({
        "ok": True,
        "wiped": True,
        "batch_started": bool(snap),
        "status": batch_index.get_status(),
        "note": ("Embeddings vacíados. El batch_index ahora va a "
                 "regenerar todo desde cero con el modelo actual."),
    })
    return jsonify({"ok": True, "status": snap})


@prionvault_bp.route("/api/admin/batch-index/stop", methods=["POST"])
@admin_required
def api_batch_index_stop():
    from .services import batch_index
    return jsonify({"ok": True, "status": batch_index.stop_batch()})


# ── Batch OCR for scanned PDFs (Phase 6) ────────────────────────────────────
@prionvault_bp.route("/api/admin/batch-ocr/status", methods=["GET"])
@admin_required
def api_batch_ocr_status():
    from .services import batch_ocr
    return jsonify(batch_ocr.get_status())


@prionvault_bp.route("/api/admin/batch-ocr/start", methods=["POST"])
@admin_required
def api_batch_ocr_start():
    from .services import batch_ocr
    data = request.get_json(force=True, silent=True) or {}
    limit = data.get("limit")
    if limit is not None:
        try:
            limit = int(limit)
            if limit <= 0:
                limit = None
        except (TypeError, ValueError):
            return jsonify({"error": "limit must be a positive integer"}), 400
    snap = batch_ocr.start_batch(viewer_user_id=_viewer_id(), limit=limit)
    if snap is None:
        return jsonify({"error": "already_running",
                        "status": batch_ocr.get_status()}), 409
    return jsonify({"ok": True, "status": snap})


@prionvault_bp.route("/api/admin/batch-ocr/stop", methods=["POST"])
@admin_required
def api_batch_ocr_stop():
    from .services import batch_ocr
    return jsonify({"ok": True, "status": batch_ocr.stop_batch()})


# ── Batch text extraction (pdfplumber, fast counterpart to OCR) ─────────────
@prionvault_bp.route("/api/admin/batch-extract/status", methods=["GET"])
@admin_required
def api_batch_extract_status():
    from .services import batch_extract
    return jsonify(batch_extract.get_status())


@prionvault_bp.route("/api/admin/batch-extract/start", methods=["POST"])
@admin_required
def api_batch_extract_start():
    from .services import batch_extract
    data = request.get_json(force=True, silent=True) or {}
    limit = data.get("limit")
    if limit is not None:
        try:
            limit = int(limit)
            if limit <= 0:
                limit = None
        except (TypeError, ValueError):
            return jsonify({"error": "limit must be a positive integer"}), 400
    snap = batch_extract.start_batch(viewer_user_id=_viewer_id(), limit=limit)
    if snap is None:
        return jsonify({"error": "already_running",
                        "status": batch_extract.get_status()}), 409
    return jsonify({"ok": True, "status": snap})


@prionvault_bp.route("/api/admin/batch-extract/stop", methods=["POST"])
@admin_required
def api_batch_extract_stop():
    from .services import batch_extract
    return jsonify({"ok": True, "status": batch_extract.stop_batch()})


# ── Batch "make PDFs searchable" (ocrmypdf — embed text layer) ──────────────
@prionvault_bp.route("/api/admin/batch-searchable/status", methods=["GET"])
@admin_required
def api_batch_searchable_status():
    from .services import batch_searchable_pdf
    return jsonify(batch_searchable_pdf.get_status())


@prionvault_bp.route("/api/admin/batch-searchable/start", methods=["POST"])
@admin_required
def api_batch_searchable_start():
    from .services import batch_searchable_pdf
    data = request.get_json(force=True, silent=True) or {}
    limit = data.get("limit")
    if limit is not None:
        try:
            limit = int(limit)
            if limit <= 0:
                limit = None
        except (TypeError, ValueError):
            return jsonify({"error": "limit must be a positive integer"}), 400
    snap = batch_searchable_pdf.start_batch(viewer_user_id=_viewer_id(),
                                            limit=limit)
    if snap is None:
        return jsonify({"error": "already_running",
                        "status": batch_searchable_pdf.get_status()}), 409
    return jsonify({"ok": True, "status": snap})


@prionvault_bp.route("/api/admin/batch-searchable/stop", methods=["POST"])
@admin_required
def api_batch_searchable_stop():
    from .services import batch_searchable_pdf
    return jsonify({"ok": True, "status": batch_searchable_pdf.stop_batch()})


# ── PubMed inventory ────────────────────────────────────────────────────────

@prionvault_bp.route("/api/admin/pubmed-inventory/stats", methods=["GET"])
@admin_required
def api_pubmed_inventory_stats():
    """Counts + last harvest summary + in-memory progress."""
    from .services import pubmed_inventory
    # Reconcile on every stats call so the "imported" count is fresh
    # without waiting for the next 7-day harvest. Cheap (single
    # indexed UPDATE).
    try:
        pubmed_inventory.reconcile()
    except Exception:
        pass
    return jsonify(pubmed_inventory.get_stats())


@prionvault_bp.route("/api/admin/pubmed-inventory/list", methods=["GET"])
@admin_required
def api_pubmed_inventory_list():
    """Paginated inventory listing.

    Query params:
      status   pending (default) | dismissed | imported
      q        substring filter on title / authors / journal
      year_min / year_max
      only_oa  "1" to limit to rows with a PMC ID
      page / size
    """
    from .services import pubmed_inventory
    q        = (request.args.get("q") or "").strip() or None
    year_min = request.args.get("year_min", type=int)
    year_max = request.args.get("year_max", type=int)
    only_oa  = request.args.get("only_oa") == "1"
    days     = request.args.get("days", type=int)
    status   = (request.args.get("status") or "pending").strip().lower()
    page     = request.args.get("page", default=1, type=int)
    size     = request.args.get("size", default=100, type=int)
    return jsonify(pubmed_inventory.list_pending(
        q=q, year_min=year_min, year_max=year_max,
        only_oa=only_oa, days=days, status=status, page=page, size=size,
    ))


# ── OA-PDF fetcher diagnostics ──────────────────────────────────────────────

@prionvault_bp.route("/api/admin/oa-fetcher/status", methods=["GET"])
@admin_required
def api_oa_fetcher_status():
    """Live snapshot of the OA-PDF fetcher daemon: running flag, the
    article it's currently processing (if any), session counters
    (fetched / marked_unavail / failed), last_error, and the rolling
    event log with per-source failure reasons. Used by the
    "Forzar descarga OA" panel in the Inventario PubMed modal so the
    operator can tell at a glance whether the daemon is alive and
    why specific articles weren't downloaded."""
    from .services import oa_pdf_fetcher
    return jsonify(oa_pdf_fetcher.get_status())


@prionvault_bp.route("/api/admin/oa-fetcher/run", methods=["POST"])
@admin_required
def api_oa_fetcher_run():
    """Wake the OA-PDF fetcher and have it drain the current queue
    immediately, instead of waiting for the next 60-second poll. The
    response includes the post-wake status snapshot so the UI can
    update its panel without a separate GET."""
    from .services import oa_pdf_fetcher
    oa_pdf_fetcher.request_drain_now()
    return jsonify({
        "ok":     True,
        "status": oa_pdf_fetcher.get_status(),
    })



@prionvault_bp.route("/api/admin/pubmed-inventory/refresh", methods=["POST"])
@admin_required
def api_pubmed_inventory_refresh():
    """Run a harvest pass right now. Accepts an optional JSON body:
      {
        "preset":       "all" | "<preset_name>" | "custom",   (default: "all")
        "custom_query": "<pubmed query string>"               (only when preset="custom")
      }
    We poke the daemon (in case it's listening) AND spawn a fresh
    background thread so the button works even if the daemon wasn't
    started on this worker.
    """
    import threading
    from .services import pubmed_inventory

    data         = request.get_json(silent=True) or {}
    preset       = (data.get("preset") or "all").strip()
    custom_query = (data.get("custom_query") or "").strip()
    min_year: Optional[int] = None
    try:
        _my_raw = data.get("min_year")
        if _my_raw is not None:
            min_year = int(_my_raw)
    except (TypeError, ValueError):
        min_year = None

    pubmed_inventory.request_harvest_now()

    # Don't spin up a second harvester if one is already running
    # (harvest_once is reentrant-safe but we'd waste resources).
    if not pubmed_inventory.get_progress().get("running"):
        if preset == "all":
            target = pubmed_inventory.harvest_all
            kwargs: dict = {"min_year": min_year} if min_year is not None else {}
        elif preset == "custom" and custom_query:
            target = pubmed_inventory.harvest_once
            kwargs = {"query": custom_query, "query_name": "custom"}
            if min_year is not None:
                kwargs["min_year"] = min_year
        elif preset in pubmed_inventory.PRESET_QUERIES:
            target = pubmed_inventory.harvest_once
            kwargs = {
                "query":      pubmed_inventory.PRESET_QUERIES[preset],
                "query_name": preset,
            }
            if min_year is not None:
                kwargs["min_year"] = min_year
        else:
            # Unknown preset: fall back to running all presets.
            target = pubmed_inventory.harvest_all
            kwargs = {"min_year": min_year} if min_year is not None else {}

        def _run():
            target(**kwargs)

        threading.Thread(
            target=_run,
            name="prionvault-harvest-on-demand",
            daemon=True,
        ).start()

    return jsonify({
        "ok":    True,
        "preset": preset,
        "status": pubmed_inventory.get_progress(),
    })


@prionvault_bp.route("/api/admin/pubmed-inventory/stop", methods=["POST"])
@admin_required
def api_pubmed_inventory_stop():
    from .services import pubmed_inventory
    pubmed_inventory.request_stop_harvest()
    return jsonify({"ok": True, "status": pubmed_inventory.get_progress()})


@prionvault_bp.route("/api/admin/pubmed-inventory/dismiss", methods=["POST"])
@admin_required
def api_pubmed_inventory_dismiss():
    """Body: {pmids: [...]} → marks them as 'not interested'."""
    from .services import pubmed_inventory
    body  = request.get_json(silent=True) or {}
    pmids = body.get("pmids") or []
    if not isinstance(pmids, list):
        return jsonify({"error": "pmids must be a list"}), 400
    updated = pubmed_inventory.dismiss(pmids, by_user=_viewer_id())
    return jsonify({"ok": True, "updated": updated})


@prionvault_bp.route("/api/admin/pubmed-inventory/undismiss", methods=["POST"])
@admin_required
def api_pubmed_inventory_undismiss():
    from .services import pubmed_inventory
    body  = request.get_json(silent=True) or {}
    pmids = body.get("pmids") or []
    if not isinstance(pmids, list):
        return jsonify({"error": "pmids must be a list"}), 400
    updated = pubmed_inventory.undismiss(pmids)
    return jsonify({"ok": True, "updated": updated})


# ── Biomedical query expansion (acronyms / synonyms / MeSH) ─────────────────

@prionvault_bp.route("/api/admin/query-expansion/list", methods=["GET"])
@admin_required
def api_query_expansion_list():
    """Full dictionary dump, ordered by kind then term. Includes
    'seed' and 'admin' entries undifferentiated — the response carries
    the `source` field so the UI can label them visually."""
    from .services import query_expansion as _qx
    return jsonify({"items": _qx.list_all()})


@prionvault_bp.route("/api/admin/query-expansion", methods=["POST"])
@admin_required
def api_query_expansion_upsert():
    """Body: {term, expansions, kind}. Upsert via the service's
    add(), which marks the row as source='admin' so the seed loader
    won't overwrite it on a future deploy."""
    from .services import query_expansion as _qx
    data = request.get_json(force=True, silent=True) or {}
    try:
        row = _qx.add(
            term=data.get("term") or "",
            expansions=data.get("expansions") or "",
            kind=data.get("kind") or "synonym",
            source="admin",
            created_by=_viewer_id(),
        )
    except ValueError as exc:
        return jsonify({"error": "invalid", "detail": str(exc)}), 400
    except Exception as exc:
        logger.exception("query_expansion upsert failed")
        return jsonify({"error": "internal",
                        "detail": str(exc)[:240]}), 500
    return jsonify({"ok": True, "item": row})


@prionvault_bp.route("/api/admin/query-expansion", methods=["DELETE"])
@admin_required
def api_query_expansion_delete():
    """Body: {term, kind}. Removes the entry. Equally valid for seed
    and admin entries — the operator decides. (Seed entries that are
    deleted will be re-added on the next ensure_seeded() boot, which
    is fine: it's the seed code's responsibility to define what
    "default" means.)"""
    from .services import query_expansion as _qx
    data = request.get_json(force=True, silent=True) or {}
    term = (data.get("term") or "").strip()
    kind = (data.get("kind") or "synonym").strip()
    if not term:
        return jsonify({"error": "term_required"}), 400
    n = _qx.delete(term, kind)
    return jsonify({"ok": True, "deleted": n})


@prionvault_bp.route("/api/admin/pubmed-inventory/purge-pending", methods=["DELETE"])
@admin_required
def api_pubmed_inventory_purge_pending():
    """Delete all pending rows (not dismissed, not kept, not imported).
    Resets the search history so future harvests start from a clean slate.
    Kept (★) and dismissed rows are untouched.
    """
    from .services import pubmed_inventory
    n = pubmed_inventory.purge_pending()
    return jsonify({"ok": True, "deleted": n})


@prionvault_bp.route("/api/admin/pubmed-inventory/keep", methods=["POST"])
@admin_required
def api_pubmed_inventory_keep():
    """Body: {pmids: [...]} → marks them as "Esta sí" (kept).

    The mark survives forever — it persists across PubMed harvests
    and across page reloads. The row keeps appearing in searches
    until either the operator imports it (imported_at gets set) or
    explicitly removes the mark with /unkeep.
    """
    from .services import pubmed_inventory
    body  = request.get_json(silent=True) or {}
    pmids = body.get("pmids") or []
    if not isinstance(pmids, list):
        return jsonify({"error": "pmids must be a list"}), 400
    updated = pubmed_inventory.keep(pmids, by_user=_viewer_id())
    return jsonify({"ok": True, "updated": updated})


@prionvault_bp.route("/api/admin/pubmed-inventory/unkeep", methods=["POST"])
@admin_required
def api_pubmed_inventory_unkeep():
    """Body: {pmids: [...]} → reverses a previous "Esta sí" decision.
    The row stays in the inventory but loses the kept_at stamp."""
    from .services import pubmed_inventory
    body  = request.get_json(silent=True) or {}
    pmids = body.get("pmids") or []
    if not isinstance(pmids, list):
        return jsonify({"error": "pmids must be a list"}), 400
    updated = pubmed_inventory.unkeep(pmids)
    return jsonify({"ok": True, "updated": updated})


@prionvault_bp.route("/api/admin/pubmed-inventory/import", methods=["POST"])
@admin_required
def api_pubmed_inventory_import():
    """Body: {pmids: [...]} → creates one `articles` row per PMID.
    Duplicates (PMID/DOI already in `articles`) are stamped as
    imported but not re-created."""
    from .services import pubmed_inventory
    body  = request.get_json(silent=True) or {}
    pmids = body.get("pmids") or []
    if not isinstance(pmids, list) or not pmids:
        return jsonify({"error": "pmids must be a non-empty list"}), 400
    if len(pmids) > 500:
        return jsonify({"error": "too many at once (cap=500)"}), 400
    summary = pubmed_inventory.import_pmids(pmids, by_user=_viewer_id())
    return jsonify({"ok": True, **summary})


@prionvault_bp.route("/api/admin/batch-searchable/clear-events", methods=["POST"])
@admin_required
def api_batch_searchable_clear_events():
    """Drop the in-memory per-paper outcome log. Counts (processed /
    failed / skipped) are NOT reset — only the verbose event list."""
    from .services import batch_searchable_pdf
    batch_searchable_pdf.clear_events()
    return jsonify({"ok": True, "status": batch_searchable_pdf.get_status()})


@prionvault_bp.route("/api/admin/batch-searchable/reset-session", methods=["POST"])
@admin_required
def api_batch_searchable_reset_session():
    """Stronger clear: events + last_error + session counters in one go.
    The "Limpiar log a fondo" button hits this so the modal returns to
    a blank-slate state without needing to restart the worker thread."""
    from .services import batch_searchable_pdf
    batch_searchable_pdf.reset_session()
    return jsonify({"ok": True, "status": batch_searchable_pdf.get_status()})


# ── PDF ↔ metadata verifier ─────────────────────────────────────────────────

@prionvault_bp.route("/api/admin/verify-metadata/status", methods=["GET"])
@admin_required
def api_verify_metadata_status():
    from .services import pdf_metadata_verifier
    return jsonify(pdf_metadata_verifier.get_status())


@prionvault_bp.route("/api/admin/verify-metadata/start", methods=["POST"])
@admin_required
def api_verify_metadata_start():
    from .services import pdf_metadata_verifier
    body     = request.get_json(silent=True) or {}
    provider = (body.get("provider") or "openai").strip().lower() or None
    recheck  = bool(body.get("recheck"))
    try:
        limit = int(body.get("limit")) if body.get("limit") else None
    except (TypeError, ValueError):
        limit = None
    snap = pdf_metadata_verifier.start_batch(
        llm_provider=provider, limit=limit, recheck=recheck,
    )
    if snap is None:
        return jsonify({"ok": False, "error": "already_running",
                        "status": pdf_metadata_verifier.get_status()}), 409
    return jsonify({"ok": True, "status": snap})


@prionvault_bp.route("/api/admin/verify-metadata/stop", methods=["POST"])
@admin_required
def api_verify_metadata_stop():
    from .services import pdf_metadata_verifier
    return jsonify({"ok": True, "status": pdf_metadata_verifier.stop_batch()})


@prionvault_bp.route("/api/admin/verify-metadata/clear-events", methods=["POST"])
@admin_required
def api_verify_metadata_clear_events():
    from .services import pdf_metadata_verifier
    pdf_metadata_verifier.clear_events()
    return jsonify({"ok": True})


@prionvault_bp.route("/api/admin/verify-metadata/list", methods=["GET"])
@admin_required
def api_verify_metadata_list():
    """Paginated listing of articles by verification status."""
    from .services import pdf_metadata_verifier
    status = (request.args.get("status") or "suspect").strip().lower()
    page   = request.args.get("page", default=1, type=int)
    size   = request.args.get("size", default=50, type=int)
    return jsonify(pdf_metadata_verifier.list_verified(
        status=status, page=page, size=size,
    ))


@prionvault_bp.route("/api/admin/verify-metadata/ids", methods=["GET"])
@admin_required
def api_verify_metadata_ids():
    """Return all article IDs for a given verification status (used to transfer selection to main list)."""
    from .services import pdf_metadata_verifier
    status = (request.args.get("status") or "mismatch").strip().lower()
    ids = pdf_metadata_verifier.list_ids_by_status(status=status)
    return jsonify({"ids": ids})


@prionvault_bp.route("/api/admin/verify-metadata/mark", methods=["POST"])
@admin_required
def api_verify_metadata_mark():
    """Bulk-set the status of a selection. Body: {ids:[...], status:'manual_ok'|...}"""
    from .services import pdf_metadata_verifier
    body = request.get_json(silent=True) or {}
    ids    = body.get("ids") or []
    status = (body.get("status") or "manual_ok").strip().lower()
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "ids must be a non-empty list"}), 400
    updated = pdf_metadata_verifier.mark_status(ids, status)
    return jsonify({"ok": True, "updated": updated, "status": status})


@prionvault_bp.route("/api/admin/verify-metadata/recheck", methods=["POST"])
@admin_required
def api_verify_metadata_recheck():
    """Clear the verdict on a selection so the next batch re-evaluates."""
    from .services import pdf_metadata_verifier
    body = request.get_json(silent=True) or {}
    ids  = body.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "ids must be a non-empty list"}), 400
    updated = pdf_metadata_verifier.recheck_ids(ids)
    return jsonify({"ok": True, "updated": updated})


@prionvault_bp.route("/api/admin/batch-searchable/problematic", methods=["GET"])
@admin_required
def api_batch_searchable_problematic():
    """Articles the operator needs to act on for the Make-PDFs-searchable
    flow. Returns two buckets:

      "failed"   — articles whose latest event in the in-memory log was
                   outcome=failed. Dedupes by article_id so the same
                   paper only appears once even if it failed twice.
                   Each entry carries stage/reason so the UI can show
                   *why* OCR died.
      "skipped"  — articles marked `pdf_ocr_unavailable = TRUE` (the
                   admin previously said "don't try this one again");
                   surfaced so they can be un-flagged or hard-deleted
                   from the same panel.

    Both buckets join `articles` for current title / authors / year so
    the panel stays informative even after the server restarts and the
    in-memory log is gone.
    """
    from .services import batch_searchable_pdf
    status = batch_searchable_pdf.get_status()

    # Failed events → dedup by article_id, keep the latest occurrence.
    by_aid: dict = {}
    for ev in (status.get("events") or []):
        if ev.get("outcome") != "failed":
            continue
        aid = ev.get("article_id")
        if not aid or aid in by_aid:
            continue
        by_aid[aid] = ev
    failed_ids = list(by_aid.keys())

    s = _session()
    try:
        meta_by_id: dict = {}
        if failed_ids:
            rows = s.execute(
                sql_text(
                    """SELECT id::text, title, authors, year, journal,
                              dropbox_path, pdf_ocr_unavailable
                       FROM articles
                       WHERE id::text = ANY(:ids)"""
                ),
                {"ids": failed_ids},
            ).mappings().all()
            for r in rows:
                meta_by_id[r["id"]] = dict(r)

        # Dedupe failed vs skipped: once the operator marked a row
        # "🚫 No procesar más", it belongs in the "Excluidos" bucket
        # only — keeping the historical failed event on screen too
        # was the source of the "Refrescar no va bien" complaint.
        failed_items = []
        for aid, ev in by_aid.items():
            meta = meta_by_id.get(aid) or {}
            if meta.get("pdf_ocr_unavailable"):
                continue
            failed_items.append({
                "id":      aid,
                "title":   meta.get("title") or ev.get("title") or "(sin título)",
                "authors": meta.get("authors"),
                "year":    meta.get("year"),
                "journal": meta.get("journal"),
                "dropbox_path": meta.get("dropbox_path"),
                "stage":   ev.get("stage"),
                "reason":  ev.get("reason"),
                "at":      ev.get("at"),
            })

        skipped_rows = s.execute(sql_text(
            """SELECT id::text, title, authors, year, journal, dropbox_path
               FROM articles
               WHERE pdf_ocr_unavailable = TRUE
               ORDER BY updated_at DESC NULLS LAST
               LIMIT 500"""
        )).mappings().all()
        skipped_items = [dict(r) for r in skipped_rows]

        return jsonify({
            "failed":   failed_items,
            "skipped":  skipped_items,
            "counts": {
                "failed":  len(failed_items),
                "skipped": len(skipped_items),
            },
        })
    finally:
        db.Session.remove()


@prionvault_bp.route("/api/admin/articles/<article_id>/ocr-unavailable",
                     methods=["POST", "DELETE"])
@admin_required
def api_article_ocr_unavailable(article_id):
    """Toggle the "no insistas más con esta PDF" flag on a single
    article. POST sets it TRUE (batch will skip), DELETE sets it FALSE
    (paper goes back into the eligible pool)."""
    new_val = (request.method == "POST")
    s = _session()
    try:
        row = s.execute(
            sql_text(
                """UPDATE articles
                   SET pdf_ocr_unavailable = :v,
                       updated_at = NOW()
                   WHERE id = :aid
                   RETURNING id::text"""
            ),
            {"aid": article_id, "v": new_val},
        ).first()
        s.commit()
        if not row:
            return jsonify({"error": "not_found"}), 404
        return jsonify({"ok": True, "id": row[0], "pdf_ocr_unavailable": new_val})
    except Exception as exc:
        s.rollback()
        logger.exception("toggle pdf_ocr_unavailable failed for %s", article_id)
        return jsonify({"error": "internal", "detail": str(exc)[:240]}), 500
    finally:
        db.Session.remove()


@prionvault_bp.route("/api/search/semantic", methods=["POST"])
@login_required
def api_semantic_search():
    """RAG search: returns a grounded answer + cited paper extracts.
    Body: { query, top_k?, provider? }."""
    from .services.rag import ask
    from .services.ai_summary import (PROVIDERS, DEFAULT_PROVIDER,
                                       NotConfigured as ProviderNotConfigured)
    from .embeddings.embedder import NotConfigured as VoyageNotConfigured

    data = request.get_json(force=True, silent=True) or {}
    query = (data.get("query") or "").strip()
    if not query:
        return jsonify({"error": "empty query"}), 400
    # Default raised from 20 to 50 and the hard cap raised from 50 to
    # 200. The frontend now asks for 50 on the first call and bumps
    # the request when the operator clicks "ver más"; the 200 ceiling
    # keeps a single call's cost bounded regardless.
    top_k = data.get("top_k", 50)
    try:
        top_k = max(1, min(200, int(top_k)))
    except (TypeError, ValueError):
        top_k = 50

    provider = (data.get("provider") or DEFAULT_PROVIDER).strip().lower()
    if provider not in PROVIDERS:
        return jsonify({"error": "unknown_provider",
                        "detail": f"Valid: {sorted(PROVIDERS)}"}), 400

    try:
        result = ask(query, top_k=top_k, provider=provider)
    except ProviderNotConfigured as exc:
        return jsonify({"error": "ai_unavailable",
                        "detail": str(exc)}), 503
    except VoyageNotConfigured:
        return jsonify({"error": "embed_unavailable",
                        "detail": "VOYAGE_API_KEY not set"}), 503
    except RuntimeError as exc:
        # Provider refusals (stop_reason=refusal) or empty-response errors
        # are expected edge cases, not internal failures.
        logger.warning("semantic search provider error [%s]: %s", provider, exc)
        return jsonify({"error": "rag_failed",
                        "detail": f"[{provider}] {str(exc)[:280]}"}), 502
    except Exception as exc:
        logger.exception("semantic search failed for provider=%s", provider)
        return jsonify({"error": "rag_failed",
                        "detail": f"[{provider}] {str(exc)[:280]}"}), 502

    # Best-effort usage tracking; skip when there is no viewer id so
    # a stale NOT NULL constraint cannot bubble up as 500.
    _uid = _viewer_id()
    if _uid is None:
        logger.info("semantic_search: skipping usage row (no viewer id)")
    try:
        if _uid is None:
            raise RuntimeError("skip")
        s = _session()
        try:
            usage = models.UsageEvent(
                user_id=_uid,
                action="semantic_search",
                cost_usd=result.cost_usd,
                tokens_in=result.tokens_in,
                tokens_out=result.tokens_out,
                meta={
                    "query":         result.query[:500],
                    "citations":     len(result.citations),
                    "cited_numbers": result.cited_numbers,
                    "confidence":    result.confidence,
                    "elapsed_ms":    result.elapsed_ms,
                    "retrieval_ms":  result.retrieval_ms,
                    "no_results":    result.no_results,
                },
            )
            s.add(usage)
            s.commit()
        finally:
            s.close()
    except Exception as exc:
        logger.warning("Could not record semantic_search usage: %s", exc)

    return jsonify({
        "ok":            True,
        "query":         result.query,
        "answer":        result.answer,
        "confidence":    result.confidence,
        "no_results":    result.no_results,
        "citations": [
            {
                "n":            c.n,
                "article_id":   c.article_id,
                "title":        c.title,
                "authors":      c.authors,
                "year":         c.year,
                "journal":      c.journal,
                "doi":          c.doi,
                "pubmed_id":    c.pubmed_id,
                "similarity":   round(c.similarity, 4),
                "rerank_score": (round(c.rerank_score, 4)
                                 if c.rerank_score is not None else None),
                "extract":      c.extract,
                "has_pdf":      bool(c.has_pdf),
            }
            for c in result.citations
        ],
        "cited_numbers":     result.cited_numbers,
        "tokens_in":         result.tokens_in,
        "tokens_out":        result.tokens_out,
        "cost_usd":          result.cost_usd,
        "elapsed_ms":        result.elapsed_ms,
        "retrieval_ms":      result.retrieval_ms,
        "top_k_used":        result.top_k_used,
        "total_candidates":  result.total_candidates,
        "has_more":          result.has_more,
        "expansion_matches": [
            {"term": m[0], "expansions": m[1]}
            for m in (result.expansion_matches or [])
        ],
        "requested_provider": result.requested_provider,
        "actual_provider":    result.actual_provider,
        "fallback_attempts":  result.fallback_attempts,
        "rerank_used":       result.rerank_used,
        "rerank_candidates": result.rerank_candidates,
        "rerank_cost_usd":   result.rerank_cost_usd,
        "hybrid_used":       result.hybrid_used,
        "hybrid_vector_hits": result.hybrid_vector_hits,
        "hybrid_bm25_hits":  result.hybrid_bm25_hits,
        "hybrid_fused":      result.hybrid_fused,
    })


# ── Migration runner: admin-only manual trigger + status ────────────────────
@prionvault_bp.route("/api/admin/migrations", methods=["GET"])
@admin_required
def api_migrations_status():
    """List which PrionVault migrations have been applied to this DB.

    Useful when the admin wants to confirm the schema is up to date without
    looking at server logs. Read-only.
    """
    s = _session()
    try:
        # Tolerant query — table may not exist yet on first boot.
        rows = s.execute(sql_text(
            """
            SELECT name, sha256, applied_at, runtime_ms
            FROM applied_migrations
            ORDER BY applied_at DESC
            """
        )).all()
        return jsonify({
            "applied": [
                {"name": r.name, "sha": r.sha256, "applied_at": r.applied_at.isoformat(),
                 "runtime_ms": r.runtime_ms}
                for r in rows
            ],
        })
    except Exception as e:
        return jsonify({"applied": [], "error": str(e)}), 200
    finally:
        s.close()


@prionvault_bp.route("/api/admin/migrations/run", methods=["POST"])
@admin_required
def api_migrations_run():
    """Force-run any pending PrionVault migrations now."""
    from .migrate import run_pending_migrations
    summary = run_pending_migrations()
    # Bust the per-process column cache so filters and SELECT lists
    # pick up any column that the migration just added (the cache is
    # only filled once per worker and a freshly-applied column would
    # otherwise stay invisible until the next restart).
    global _pv_columns_cache
    _pv_columns_cache = None
    try:
        from .ingestion import worker as _worker
        _worker._articles_col_cache = None
    except Exception:
        pass
    return jsonify(summary)


@prionvault_bp.route("/api/admin/collections/group", methods=["DELETE"])
@admin_required
def api_admin_delete_collection_group():
    """Wipe every collection whose group (and optionally subgroup)
    matches. Used by the × button on the group / subgroup headers in
    the sidebar — there isn't a database row representing a group per
    se, so "delete the group" means "delete all its collections".

    Query params:
      group     — required, exact match (case-insensitive).
      subgroup  — optional. When omitted, every subgroup under the
                  group is wiped. When set, only that one.

    The actual rows in prionvault_collection_article cascade-delete
    via the ON DELETE CASCADE on the FK.
    """
    from .services import collections as _collections
    group    = (request.args.get("group") or "").strip()
    subgroup = request.args.get("subgroup")
    if subgroup is not None:
        subgroup = subgroup.strip()
    if not group:
        return jsonify({"error": "group_required"}), 400

    ids = _collections.find_in_group(group, subgroup if subgroup else None)
    if not ids:
        return jsonify({"ok": True, "deleted": 0,
                        "group": group, "subgroup": subgroup})

    deleted = 0
    for cid in ids:
        try:
            if _collections.delete(cid):
                deleted += 1
        except Exception as exc:
            logger.warning("delete-group: failed to delete %s: %s", cid, exc)
    return jsonify({
        "ok": True,
        "deleted": deleted,
        "group": group,
        "subgroup": subgroup,
    })


@prionvault_bp.route("/api/admin/prionpacks/sync", methods=["POST"])
@admin_required
def api_admin_prionpacks_sync():
    """Full backfill of PrionPack reference lists into their
    auto-managed PrionVault collections (group=PrionPacks, subgroup=
    "<pack-id> — <title>", names "Introducción" and "Referencias
    generales"). Idempotent — re-runs are cheap (existing memberships
    are skipped, not re-added)."""
    from .services.prionpack_sync import sync_all
    try:
        return jsonify(sync_all())
    except Exception as exc:
        logger.exception("prionpacks sync_all failed")
        return jsonify({"error": "internal_error", "detail": str(exc)[:300]}), 500


@prionvault_bp.route("/api/admin/prionpacks/sync-debug/<pkg_id>", methods=["GET"])
@admin_required
def api_admin_prionpacks_sync_debug(pkg_id):
    """Dump everything the sync layer sees for one pack so the admin
    can tell at a glance whether (a) the deploy is current, (b) the
    expected subgroup label matches the one the admin already created
    by hand, and (c) which referenced DOIs are actually in PrionVault.
    Read-only — does NOT mutate any collections."""
    from .services.prionpack_sync import (
        _extract_dois, _subgroup_label_for, _resolve_dois_to_article_ids,
        PACK_GROUP_NAME, INTRO_COLL_NAME, GENERAL_COLL_NAME,
    )
    from .services import collections as _collections

    try:
        from tools.prionpacks import models as pp_models
    except Exception as exc:
        return jsonify({"error": "prionpacks_unavailable",
                        "detail": str(exc)[:200]}), 503

    pack = pp_models.get_package(pkg_id)
    if not pack:
        return jsonify({"error": "pack_not_found", "id": pkg_id}), 404

    expected_subgroup = _subgroup_label_for(pack)

    intro_refs   = pack.get("introReferences") or []
    general_refs = pack.get("references")      or []
    intro_dois   = sorted({d for r in intro_refs   for d in _extract_dois(r)})
    general_dois = sorted({d for r in general_refs for d in _extract_dois(r)})

    intro_aids   = _resolve_dois_to_article_ids(intro_dois)
    general_aids = _resolve_dois_to_article_ids(general_dois)

    # All collections that already live under "PrionPacks" group. Lets
    # the admin spot whether the sync's subgroup label matches the one
    # they created by hand (probably the most common reason "I don't
    # see anything" — the labels don't match exactly).
    matching = _collections.find_in_group(PACK_GROUP_NAME)
    existing_pack_collections = []
    for cid in matching:
        c = _collections.get(cid)
        if not c:
            continue
        existing_pack_collections.append({
            "id":            c["id"],
            "subgroup_name": c.get("subgroup_name"),
            "name":          c.get("name"),
            "article_count": c.get("article_count", 0),
        })

    # Which DOIs were found in PrionVault and which weren't, so the
    # admin can tell apart "DOI absent from catalogue" (sync can't
    # help) vs. "DOI is in catalogue but sync didn't pick it up"
    # (something else is wrong).
    def _doi_resolution(dois):
        if not dois:
            return []
        eng = _get_engine()
        with eng.connect() as conn:
            rows = conn.execute(sql_text(
                "SELECT id, lower(doi) AS doi FROM articles "
                "WHERE lower(doi) = ANY(:d)"
            ), {"d": dois}).all()
        hit = {r[1]: str(r[0]) for r in rows}
        return [{"doi": d, "article_id": hit.get(d)} for d in dois]

    return jsonify({
        "pack": {
            "id":     pack.get("id"),
            "title":  pack.get("title"),
            "active": pack.get("active", True),
        },
        "expected": {
            "group":    PACK_GROUP_NAME,
            "subgroup": expected_subgroup,
            "intro_collection_name":   INTRO_COLL_NAME,
            "general_collection_name": GENERAL_COLL_NAME,
        },
        "intro_refs_count":   len(intro_refs),
        "general_refs_count": len(general_refs),
        "intro_dois":         _doi_resolution(intro_dois),
        "general_dois":       _doi_resolution(general_dois),
        "intro_matched_count":   len(intro_aids),
        "general_matched_count": len(general_aids),
        "existing_pack_collections": existing_pack_collections,
    })


@prionvault_bp.route("/api/admin/auto-scan/status", methods=["GET"])
@admin_required
def api_admin_auto_scan_status():
    """Snapshot of the auto-scan daemon: when it last ran, what it did,
    current effective config (interval / folder / batch limit) and
    whether the daemon thread is alive in this worker process."""
    from .services.auto_scan import get_status
    return jsonify(get_status())


@prionvault_bp.route("/api/admin/auto-scan/run-now", methods=["POST"])
@admin_required
def api_admin_auto_scan_run_now():
    """Tell the daemon to run on its next loop iteration (bypassing the
    6-hour interval check). Returns immediately — the actual scan runs
    in the daemon thread and the result is visible via /status."""
    from .services.auto_scan import force_run_now
    force_run_now()
    return jsonify({"ok": True, "queued": True,
                    "detail": "El daemon ejecutará un escaneo en cuanto despierte (≤ 1 minuto)."})


@prionvault_bp.route("/api/admin/articles-schema", methods=["GET"])
@admin_required
def api_admin_articles_schema():
    """Inspect the live column types of `articles` straight from
    information_schema. Diagnostic-only — used to confirm whether
    a migration like 022 (VARCHAR → TEXT) actually took effect on
    production, or whether the applied_migrations row marked it
    "done" while the ALTER silently failed.
    """
    try:
        with db.engine.connect() as conn:
            rows = conn.execute(sql_text("""
                SELECT column_name, data_type, character_maximum_length, is_nullable
                  FROM information_schema.columns
                 WHERE table_name = 'articles'
                 ORDER BY ordinal_position
            """)).all()
    except Exception as exc:
        return jsonify({"error": "introspect_failed", "detail": str(exc)[:300]}), 500
    return jsonify({
        "columns": [
            {
                "name":       r[0],
                "data_type":  r[1],
                "max_length": int(r[2]) if r[2] is not None else None,
                "nullable":   (r[3] == "YES"),
            }
            for r in rows
        ],
    })


@prionvault_bp.route("/api/admin/email-ingest/status", methods=["GET"])
@admin_required
def api_email_ingest_status():
    from .services import email_ingest
    return jsonify(email_ingest.get_status())


@prionvault_bp.route("/api/admin/email-ingest/poll", methods=["POST"])
@admin_required
def api_email_ingest_poll():
    """Force the daemon to poll the IMAP mailbox right now (instead of
    waiting for the next interval). Useful as a smoke test after
    configuring the credentials."""
    from .services import email_ingest
    summary = email_ingest.poll_once()
    return jsonify({"ok": True, "summary": summary,
                    "status": email_ingest.get_status()})


@prionvault_bp.route("/api/admin/screen-references", methods=["POST"])
@admin_required
def api_screen_references():
    """Parse a pasted reference list and tell the operator, per entry,
    what's already in PrionVault, what's missing with OA PDF
    available, and what's missing with metadata only. Used by the
    "Cribar lista de referencias" modal in the sidebar.

    Body: {"text": "<the bibliography>", "check_unpaywall": false}
    """
    from .services import reference_screener
    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text is required"}), 400
    check = bool(body.get("check_unpaywall"))
    try:
        result = reference_screener.screen(text, check_unpaywall=check)
    except Exception as exc:
        logger.exception("screen-references failed")
        return jsonify({"error": "internal_error", "detail": str(exc)[:300]}), 500
    return jsonify(result)


@prionvault_bp.route("/api/admin/ai-providers-status", methods=["GET"])
@admin_required
def api_ai_providers_status():
    """Per-provider health snapshot (anthropic, openai, gemini,
    voyage, unpaywall). Fed by record_success / record_error in the
    respective service wrappers. Polled by the "Estado IA" modal in
    the sidebar AND by a tiny page-top banner that fires when one of
    them is in `quota_exhausted` / `invalid_key`."""
    from .services import provider_status
    return jsonify(provider_status.get_snapshot())


@prionvault_bp.route("/api/admin/ai-providers-status/reset", methods=["POST"])
@admin_required
def api_ai_providers_status_reset():
    """Clear stored state — useful right after topping up credit, so
    the banner goes away without waiting for the next real call to
    succeed."""
    from .services import provider_status
    body = request.get_json(silent=True) or {}
    provider = body.get("provider")
    n = provider_status.reset(provider)
    return jsonify({"ok": True, "reset": n})


@prionvault_bp.route("/api/admin/heal-schema", methods=["GET", "POST"])
@admin_required
def api_heal_schema():
    """One-shot schema self-heal — handy when the live schema lost
    columns to a Postgres restore. Accepts GET so the admin can paste
    the URL straight into their browser address bar without DevTools.

    Re-applies the idempotent column-defining migrations (every
    ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS in our
    history) so missing columns reappear without the operator having
    to clear the applied_migrations tracker.
    """
    from .migrate import _self_heal_schema
    summary = _self_heal_schema()
    # Drop SQLAlchemy's column-existence cache so the same request
    # context doesn't keep failing on the column it just recovered.
    global _pv_columns_cache
    _pv_columns_cache = None
    return jsonify({"ok": True, "summary": summary})


@prionvault_bp.route("/api/admin/migrations/force-rerun", methods=["POST"])
@admin_required
def api_migrations_force_rerun():
    """Delete the applied_migrations tracking rows and re-run migrations.

    All statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS guards,
    so re-running is safe even when the schema is mostly already there.

    Body options:
      {"all": true}             → clears every migration we know about
                                  and re-runs them. Use this when the
                                  catalogue schema is out of sync with
                                  the model (post-restore, post-outage).
      {"names": ["015_…","…"]}  → clears just the listed ones.
      (no body)                 → clears only 001+003 (the CREATE
                                  EXTENSION pair) and re-runs everything
                                  the tracker considers pending.
    """
    from .migrate import run_pending_migrations, _PRIONVAULT_MIGRATIONS
    from sqlalchemy import text as _text
    default_names = ["001_prionvault_tables.sql", "003_fix_step_column.sql"]
    body = request.get_json(silent=True) or {}
    if body.get("all"):
        names = list(_PRIONVAULT_MIGRATIONS)
    else:
        extra = body.get("names") or []
        if not isinstance(extra, list) or not all(isinstance(n, str) for n in extra):
            return jsonify({"error": "names must be a list of strings"}), 400
        names = list({*default_names, *extra})
    try:
        with db.engine.begin() as conn:
            conn.execute(_text(
                "DELETE FROM applied_migrations WHERE name = ANY(:names)"
            ), {"names": names})
    except Exception as exc:
        return jsonify({"error": f"could not clear migration log: {exc}"}), 500
    summary = run_pending_migrations()
    # Invalidate per-process column caches so the next request re-introspects.
    global _pv_columns_cache
    _pv_columns_cache = None
    try:
        from .ingestion import worker as _worker
        _worker._articles_col_cache = None
    except Exception:
        pass
    return jsonify({"forced": True, **summary})


@prionvault_bp.route("/api/admin/debug/db", methods=["GET"])
@admin_required
def api_admin_debug_db():
    """Surface what PrionVault sees about the DB connection.

    Helps diagnose situations where Phase 1 endpoints work (they go
    through `db.Session()`) but Phase 2 enqueue fails (we build a
    local engine). Lists which env vars are visible without leaking
    their values.
    """
    import os
    related = sorted(k for k in os.environ
                     if any(t in k.upper() for t in
                            ("DATABASE", "POSTGRES", "PG")))
    info = {
        "env_var_names_visible": related,
        "DATABASE_URL_present":  "DATABASE_URL" in os.environ,
        "DATABASE_URL_len":      len(os.environ.get("DATABASE_URL", "")),
        "POSTGRES_URL_present":  "POSTGRES_URL" in os.environ,
        "PGHOST_present":        "PGHOST" in os.environ,
    }
    try:
        from database.config import db as _db
        info["singleton_engine"]   = getattr(_db, "engine", None) is not None
        info["singleton_session"]  = getattr(_db, "Session", None) is not None
        info["singleton_url_len"]  = len(getattr(_db, "database_url", "") or "")
    except Exception as exc:
        info["singleton_error"] = str(exc)
    try:
        from .ingestion.queue import _get_engine
        eng = _get_engine()
        info["queue_engine"] = "ok"
        info["queue_engine_url_kind"] = (
            "shared singleton" if eng is getattr(__import__("database.config", fromlist=["db"]), "db").engine
            else "local fallback"
        )
    except Exception as exc:
        info["queue_engine_error"] = str(exc)
    return jsonify(info)


@prionvault_bp.route("/api/admin/migrate-prionread-pdfs", methods=["POST"])
@admin_required
def api_migrate_prionread_pdfs():
    """One-shot relocation of PrionRead's existing PDFs in Dropbox to the
    canonical /PrionVault/<year>/<doi>.pdf layout.

    Body (JSON, optional):
        {"dry_run": true,   "limit": 5}    # preview only
        {"dry_run": false}                  # do it
    """
    data = request.get_json(silent=True) or {}
    dry_run = bool(data.get("dry_run", False))
    limit   = data.get("limit")
    try:
        # Lazy import: this script is heavy and imports the Dropbox SDK.
        from importlib import import_module
        mod = import_module("migrations.002_relocate_prionread_pdfs")
        result = mod.relocate_all(dry_run=dry_run, limit=limit)
        return jsonify(result.to_dict())
    except Exception as exc:
        logger.exception("PrionRead PDF relocation failed")
        return jsonify({"error": str(exc)}), 500


@prionvault_bp.route("/api/admin/debug/schema", methods=["GET"])
@admin_required
def api_admin_debug_schema():
    """Return which columns actually exist in `articles` and whether the
    PrionVault migration columns are present. Helps diagnose 500 errors."""
    s = _session()
    try:
        rows = s.execute(sql_text("""
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'articles'
            ORDER BY ordinal_position
        """)).all()
        cols = {r[0]: {"type": r[1], "nullable": r[2]} for r in rows}
        pv_cols = ["pdf_md5", "pdf_size_bytes", "pdf_pages", "extracted_text",
                   "extraction_status", "extraction_error", "summary_ai",
                   "summary_human", "indexed_at", "index_version", "source",
                   "source_metadata", "added_by_id", "search_vector"]
        return jsonify({
            "all_columns": list(cols.keys()),
            "pv_migration_columns": {c: c in cols for c in pv_cols},
            "migration_complete": all(c in cols for c in pv_cols),
        })
    except Exception as exc:
        s.rollback()
        return jsonify({"error": str(exc)}), 500
    finally:
        db.Session.remove()



# ── Export references as .docx ────────────────────────────────────────────

@prionvault_bp.route("/api/articles/export-refs-docx", methods=["POST"])
@login_required
def api_export_refs_docx():
    """Generate a formatted Word document from a list of article IDs.

    Body JSON: { "article_ids": [...uuid...], "config": {...} }
    The order of article_ids determines the order in the document.
    """
    from .refs_exporter import generate_refs_docx

    data = request.get_json(silent=True) or {}
    article_ids = data.get('article_ids') or []
    config      = data.get('config') or {}

    if not article_ids:
        return jsonify({'error': 'article_ids required'}), 400

    s = _session()
    try:
        # Fetch in bulk then reorder to match the requested order
        rows = (
            s.query(models.PrionVaultArticle)
             .filter(models.PrionVaultArticle.id.in_(article_ids))
             .all()
        )
        by_id = {str(r.id): r for r in rows}
        ordered = [by_id[str(aid)] for aid in article_ids if str(aid) in by_id]

        articles = [
            {
                'id':              str(a.id),
                'title':           a.title or '',
                'authors':         a.authors or '',
                'year':            a.year,
                'journal':         a.journal or '',
                'doi':             a.doi or '',
                'pubmed_id':       a.pubmed_id or '',
                'source_metadata': a.source_metadata or {},
            }
            for a in ordered
        ]

        docx_bytes = generate_refs_docx(articles, config)

        filename = f'Referencias_{datetime.now().strftime("%Y%m%d")}.docx'
        return Response(
            docx_bytes,
            mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            headers={'Content-Disposition': f'attachment; filename="{filename}"'},
        )
    except Exception as exc:
        s.rollback()
        current_app.logger.exception('export-refs-docx failed')
        return jsonify({'error': str(exc)}), 500
    finally:
        db.Session.remove()





# ── Translation glossary ─────────────────────────────────────────────────────
# Admin-maintained EN→ES translations the AI must respect in summaries
# and article chat (e.g. "bank vole" → "topillo rojo").

@prionvault_bp.route("/api/admin/glossary", methods=["GET"])
@admin_required
def api_glossary_list():
    from .services import glossary
    return jsonify({"entries": glossary.list_entries()})


@prionvault_bp.route("/api/admin/glossary", methods=["POST"])
@admin_required
def api_glossary_add():
    from .services import glossary
    body = request.get_json(silent=True) or {}
    try:
        entry = glossary.add_entry(
            source_term=body.get("source_term", ""),
            target_term=body.get("target_term", ""),
            note=body.get("note"),
            created_by=_viewer_id(),
        )
    except ValueError as exc:
        return jsonify({"error": "bad_request", "detail": str(exc)}), 400
    except Exception as exc:
        logger.exception("glossary add failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500
    return jsonify({"ok": True, **entry})


@prionvault_bp.route("/api/admin/glossary/<uuid:entry_id>", methods=["PATCH"])
@admin_required
def api_glossary_update(entry_id):
    from .services import glossary
    body = request.get_json(silent=True) or {}
    try:
        ok = glossary.update_entry(
            str(entry_id),
            source_term=body.get("source_term", ""),
            target_term=body.get("target_term", ""),
            note=body.get("note"),
        )
    except ValueError as exc:
        return jsonify({"error": "bad_request", "detail": str(exc)}), 400
    except Exception as exc:
        logger.exception("glossary update failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500
    if not ok:
        return jsonify({"error": "not_found"}), 404
    return jsonify({"ok": True})


@prionvault_bp.route("/api/admin/glossary/<uuid:entry_id>", methods=["DELETE"])
@admin_required
def api_glossary_delete(entry_id):
    from .services import glossary
    ok = glossary.delete_entry(str(entry_id))
    if not ok:
        return jsonify({"error": "not_found"}), 404
    return jsonify({"ok": True})


# ── SCImago (SJR) journal quartile rankings ──────────────────────────────────
# Admin imports the yearly SCImago CSV; the Gobierno Vasco export uses it to
# auto-fill the quartile (best category in parentheses).

@prionvault_bp.route("/api/admin/scimago/stats", methods=["GET"])
@admin_required
def api_scimago_stats():
    from .services import scimago
    return jsonify({"stats": scimago.stats(), "import": scimago.import_state()})


@prionvault_bp.route("/api/admin/scimago/import", methods=["POST"])
@admin_required
def api_scimago_import():
    """Multipart upload: `file` (SCImago CSV) + `year`. Runs in the
    background so a big CSV (~30k journals) doesn't hit the request
    timeout; the UI polls /scimago/stats for progress."""
    from .services import scimago
    year_raw = (request.form.get("year") or "").strip()
    try:
        year = int(year_raw)
    except ValueError:
        return jsonify({"error": "bad_year", "detail": "Indica el año del CSV."}), 400
    if not (1990 <= year <= 2100):
        return jsonify({"error": "bad_year", "detail": "Año fuera de rango."}), 400

    f = request.files.get("file")
    if not f:
        return jsonify({"error": "no_file", "detail": "Adjunta el CSV de SCImago."}), 400
    try:
        content = f.read().decode("utf-8-sig", errors="replace")
    except Exception as exc:
        return jsonify({"error": "read_failed", "detail": str(exc)[:200]}), 400

    if scimago.import_state().get("running"):
        return jsonify({"error": "busy", "detail": "Ya hay una importación en curso."}), 409

    threading.Thread(target=scimago.run_import, args=(content, year),
                     daemon=True).start()
    return jsonify({"ok": True, "status": "started", "year": year}), 202


@prionvault_bp.route("/api/admin/scimago/clear", methods=["POST"])
@admin_required
def api_scimago_clear():
    from .services import scimago
    body = request.get_json(silent=True) or {}
    try:
        year = int(body.get("year"))
    except (TypeError, ValueError):
        return jsonify({"error": "bad_year"}), 400
    n = scimago.clear_year(year)
    return jsonify({"ok": True, "deleted": n, "year": year})
