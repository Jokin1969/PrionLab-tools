"""PrionVault ingestion & PDF routes.

Covers:
  - Bulk ingest queue  (/api/ingest/*)
  - PMID backfill      (/api/admin/pmid-*)
  - PDF streaming      (/api/articles/<aid>/pdf, /pdf-view, /upload-pdf)
  - Article thumbnail  (/api/articles/<aid>/thumbnail)
  - Chunk inspection   (/api/articles/<aid>/chunks, /api/chunks/<id>/similar)
  - AI-assisted PMID   (/api/articles/<aid>/identify-pmid)
  - PDF page counting  (/api/articles/<aid>/count-pages, /api/admin/backfill-pdf-pages)
  - Abstract retry     (/api/admin/retry-abstracts)
  - Metadata cleanup   (/api/admin/clean-metadata)
  - AI summary CRUD    (/api/articles/<aid>/summary)
  - Semantic search    (/api/articles/search-by-idea)

Registered on prionvault_bp via side-effect import at the bottom of routes.py.
"""
import hashlib
import io
import logging
import os
import threading
import zipfile
from collections import OrderedDict
from datetime import datetime
from typing import Optional

from flask import Response, jsonify, request, send_file
from sqlalchemy import text as sql_text
from sqlalchemy.exc import IntegrityError

from core.decorators import admin_required, login_required
from database.config import db
from . import models, prionvault_bp
from ._helpers import _ensure_can_modify, _get_pv_columns, _session, _viewer_id  # noqa: F401

logger = logging.getLogger(__name__)



# ── Bulk ingestion (Phase 2) ────────────────────────────────────────────────
@prionvault_bp.route("/api/ingest/upload", methods=["POST"])
@admin_required
def api_ingest_upload():
    """Receive one or more PDFs and enqueue ingest jobs.

    Accepts `multipart/form-data` with one or more files under field name
    `file` (or `files`). Returns the ids of the enqueued jobs.
    """
    from .ingestion import queue as ingest_queue

    files = request.files.getlist("file") + request.files.getlist("files")
    files = [f for f in files if f and f.filename]
    if not files:
        return jsonify({"error": "no files"}), 400

    user_id = _viewer_id()
    job_ids = []
    for f in files:
        try:
            content = f.read()
            if not content:
                continue
            jid = ingest_queue.enqueue_pdf(content=content,
                                           filename=f.filename,
                                           user_id=user_id)
            job_ids.append(jid)
        except Exception as exc:
            logger.exception("PrionVault enqueue failed for %s", f.filename)
            return jsonify({"error": f"enqueue failed: {exc}",
                            "queued": len(job_ids), "job_ids": job_ids}), 500

    return jsonify({"queued": len(job_ids), "job_ids": job_ids}), 202


@prionvault_bp.route("/api/ingest/status", methods=["GET"])
@admin_required
def api_ingest_status():
    """Aggregate counts + last 30 jobs for the admin progress panel."""
    from .ingestion import queue as ingest_queue
    recent = max(1, min(100, request.args.get("recent", 30, type=int)))
    return jsonify(ingest_queue.snapshot(recent=recent))


@prionvault_bp.route("/api/ingest/jobs", methods=["GET"])
@admin_required
def api_ingest_jobs():
    """List jobs filtered by status and/or explicit ids.

    The Import modal uses `?ids=1,2,3` to poll only the jobs it just
    created, so the user sees progress scoped to their upload session
    instead of aggregates mixed in with background work.
    """
    from .ingestion import queue as ingest_queue
    status = request.args.get("status")
    limit  = max(1, min(1000, request.args.get("limit", 100, type=int)))

    ids_raw = request.args.get("ids")
    ids: list[int] = []
    if ids_raw:
        for tok in ids_raw.split(","):
            tok = tok.strip()
            if not tok:
                continue
            try:
                ids.append(int(tok))
            except ValueError:
                continue

    return jsonify({"items": ingest_queue.list_jobs(
        status=status, limit=limit, ids=ids or None,
    )})


@prionvault_bp.route("/api/ingest/retry/<int:job_id>", methods=["POST"])
@admin_required
def api_ingest_retry(job_id):
    from .ingestion import queue as ingest_queue
    if ingest_queue.retry(job_id):
        return jsonify({"ok": True})
    return jsonify({"error": "job not found or not in failed/duplicate state"}), 400


@prionvault_bp.route("/api/ingest/clear-failed", methods=["POST"])
@admin_required
def api_ingest_clear_failed():
    """Remove every failed/duplicate row from the ingest queue.
    Convenient when /tmp has been wiped and the staged PDFs are gone
    — the rows are useless and a Retry would just fail again."""
    from .ingestion import queue as ingest_queue
    deleted = ingest_queue.clear_failed()
    return jsonify({"ok": True, "deleted": deleted})


@prionvault_bp.route("/api/ingest/jobs/<int:job_id>", methods=["DELETE"])
@admin_required
def api_ingest_job_delete(job_id):
    """Force-delete a single job row.

    Used to clear zombie jobs whose status is still in a 'processing'
    bucket (extracting / resolving / …) because the worker crashed
    or got restarted mid-flight. The bulk "Limpiar terminados" path
    deliberately leaves those alone so a live worker isn't
    interrupted; this endpoint is the explicit escape hatch.
    """
    from .ingestion import queue as ingest_queue
    deleted, staged_removed = ingest_queue.delete_job(job_id)
    if not deleted:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True, "staged_removed": staged_removed})


# ── PMID backfill (find missing PubMed IDs for known articles) ─────────────

@prionvault_bp.route("/api/admin/pmid-missing", methods=["GET"])
@admin_required
def api_pmid_missing():
    """Articles still without a PMID after the automatic backfill.

    Drives the "Asignar a mano" panel in the Recuperar PMIDs modal —
    the admin sees one row per paper with title / year / journal /
    DOI, a click-through to a PubMed search pre-filled with the
    title, and a tiny input for pasting the PMID found by hand.

    Excludes papers explicitly marked `pubmed_unavailable = TRUE`
    (books / conference abstracts / theses that genuinely don't
    have a PubMed entry, and which the admin has flagged via the
    "✗ No existe PMID" button). Pass ?include_unavailable=true to
    see those too if the admin wants to review the flagged list.
    """
    limit  = max(1, min(500, request.args.get("limit", 200, type=int)))
    include_unavailable = request.args.get("include_unavailable", "false").lower() == "true"
    s = _session()
    try:
        pv_cols = _get_pv_columns(s)
        has_unavail_col = "pubmed_unavailable" in pv_cols
        unavail_clause = ""
        if has_unavail_col and not include_unavailable:
            unavail_clause = " AND pubmed_unavailable = FALSE"

        rows = s.execute(sql_text(f"""
            SELECT id, title, authors, year, journal, doi, created_at
                   {", pubmed_unavailable" if has_unavail_col else ""}
              FROM articles
             WHERE pubmed_id IS NULL{unavail_clause}
             ORDER BY (doi IS NULL), created_at
             LIMIT :n
        """), {"n": limit}).all()

        total = s.execute(sql_text(
            f"SELECT COUNT(*) FROM articles WHERE pubmed_id IS NULL{unavail_clause}"
        )).scalar() or 0
    finally:
        s.close()

    return jsonify({
        "total":   int(total),
        "items": [
            {
                "id":      str(r.id),
                "title":   r.title or "",
                "authors": r.authors or "",
                "year":    r.year,
                "journal": r.journal,
                "doi":     r.doi,
                "pubmed_unavailable": bool(getattr(r, "pubmed_unavailable", False)),
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
    })


@prionvault_bp.route("/api/articles/<uuid:aid>/mark-no-pmid", methods=["POST"])
@admin_required
def api_article_mark_no_pmid(aid):
    """Flag (or un-flag) an article as confirmed-not-in-PubMed.

    Body: { "value": true|false }   — defaults to true.

    Sets `pubmed_unavailable` on the article so the backfill batch,
    the manual-entry list, and any future "🤖 Buscar PMID con IA"
    nudge skip this paper instead of wasting NCBI roundtrips. Used
    for books, conference abstracts, theses, and other items that
    genuinely don't have a PubMed entry.
    """
    body  = request.get_json(silent=True) or {}
    value = bool(body.get("value", True))
    s = _session()
    try:
        pv_cols = _get_pv_columns(s)
        if "pubmed_unavailable" not in pv_cols:
            return jsonify({
                "error": "schema_missing",
                "detail": "Run migration 024 (force-rerun) to add the pubmed_unavailable column.",
            }), 503
        res = s.execute(sql_text("""
            UPDATE articles
               SET pubmed_unavailable = :v, updated_at = NOW()
             WHERE id = :aid
             RETURNING id, pubmed_unavailable
        """), {"v": value, "aid": str(aid)}).first()
        if not res:
            s.rollback()
            return jsonify({"error": "not_found"}), 404
        s.commit()
        return jsonify({
            "ok": True,
            "id": str(res[0]),
            "pubmed_unavailable": bool(res[1]),
        })
    except Exception as exc:
        s.rollback()
        logger.exception("mark-no-pmid failed for %s", aid)
        return jsonify({"error": "internal_error", "detail": str(exc)[:200]}), 500
    finally:
        s.close()


@prionvault_bp.route("/api/admin/pmid-stats", methods=["GET"])
@admin_required
def api_pmid_stats():
    """Counts that drive the PMID backfill modal: how many articles
    in the library have DOI, PMID, both, just DOI, just PMID, neither.
    """
    s = _session()
    try:
        pv_cols = _get_pv_columns(s)
        # The `confirmed_no_pmid` bucket only exists once migration 024
        # has run. Until then we report 0 and the manual flow is a no-op.
        has_unavail_col = "pubmed_unavailable" in pv_cols
        confirmed_expr = (
            "COUNT(*) FILTER (WHERE pubmed_id IS NULL AND pubmed_unavailable = TRUE)"
            if has_unavail_col else "0::int"
        )
        # When the column exists, exclude its TRUE rows from the
        # "missing" bucket — those don't need any more PubMed work.
        missing_filter = " AND pubmed_unavailable = FALSE" if has_unavail_col else ""
        row = s.execute(sql_text(f"""
            SELECT
              COUNT(*)                                              AS total,
              COUNT(*) FILTER (WHERE doi       IS NOT NULL)         AS has_doi,
              COUNT(*) FILTER (WHERE pubmed_id IS NOT NULL)         AS has_pmid,
              COUNT(*) FILTER (WHERE doi IS NOT NULL
                              AND pubmed_id IS NOT NULL)            AS has_both,
              COUNT(*) FILTER (WHERE doi IS NOT NULL
                              AND pubmed_id IS NULL{missing_filter}) AS has_doi_only,
              COUNT(*) FILTER (WHERE doi IS NULL
                              AND pubmed_id IS NOT NULL)            AS has_pmid_only,
              COUNT(*) FILTER (WHERE doi IS NULL
                              AND pubmed_id IS NULL{missing_filter}) AS has_neither,
              {confirmed_expr}                                       AS confirmed_no_pmid
            FROM articles
        """)).first()
        return jsonify({
            "total":             int(row.total or 0),
            "has_doi":           int(row.has_doi or 0),
            "has_pmid":          int(row.has_pmid or 0),
            "has_both":          int(row.has_both or 0),
            "has_doi_only":      int(row.has_doi_only or 0),
            "has_pmid_only":     int(row.has_pmid_only or 0),
            "has_neither":       int(row.has_neither or 0),
            "confirmed_no_pmid": int(row.confirmed_no_pmid or 0),
            "missing_pmid":      int((row.has_doi_only or 0) + (row.has_neither or 0)),
        })
    finally:
        s.close()


@prionvault_bp.route("/api/admin/pmid-backfill", methods=["POST"])
@admin_required
def api_pmid_backfill():
    """Process one batch of PMID-less articles.

    For each candidate:
      - If it has a DOI, query PubMed esearch by DOI (precise).
      - Otherwise fall back to title + first-author + year search.
    The newly-found PMID is written back. Articles where the resolved
    PMID is already owned by another row are reported as duplicates
    (no update — the existing duplicate-detection flow handles those).

    Body: { "limit": 50 }   — defaults to 50 so the request stays
    well inside the gunicorn 30 s timeout (~200-500 ms per PubMed call).
    """
    from .ingestion.metadata_resolver import (
        pubmed_by_doi, pubmed_search_pmid_by_title,
    )

    data  = request.get_json(force=True, silent=True) or {}
    limit = max(1, min(200, int(data.get("limit") or 50)))

    s = _session()
    try:
        # Prefer DOI-holding rows first — they're cheaper and more
        # reliable than title search, so the user sees fast wins
        # before we burn time on heuristic title hits.
        # `pubmed_unavailable = TRUE` rows are explicitly excluded —
        # the admin has confirmed those papers don't have a PMID
        # (books, conference abstracts, theses) so we'd just be
        # wasting NCBI roundtrips on every batch.
        pv_cols = _get_pv_columns(s)
        unavail_filter = " AND pubmed_unavailable = FALSE" \
            if "pubmed_unavailable" in pv_cols else ""
        rows = s.execute(sql_text(f"""
            SELECT id, title, authors, year, doi
              FROM articles
             WHERE pubmed_id IS NULL{unavail_filter}
             ORDER BY (doi IS NULL), created_at
             LIMIT :n
        """), {"n": limit}).all()
    finally:
        s.close()

    items: list[dict] = []
    found = 0

    for r in rows:
        aid     = str(r.id)
        title   = r.title
        authors = r.authors or ""
        year    = r.year
        doi     = r.doi

        pmid: Optional[str] = None
        via: Optional[str]  = None
        reason: Optional[str] = None

        # 1) DOI-based lookup.
        if doi:
            try:
                meta = pubmed_by_doi(doi)
                if meta and meta.pubmed_id:
                    pmid = str(meta.pubmed_id)
                    via  = "doi"
            except Exception as exc:
                logger.info("pmid-backfill DOI lookup failed for %s: %s", aid, exc)

        # 2) Title + author + year fallback.
        if not pmid and title:
            first_author = (authors.split(";")[0] if authors else "").strip()
            # "Stack M" → "Stack". The resolver also strips initials
            # internally, but keeping the surname-only here makes the
            # esearch term tighter.
            first_author = first_author.split()[0] if first_author else None
            try:
                pmid = pubmed_search_pmid_by_title(
                    title=title, author=first_author, year=year,
                )
                if pmid:
                    via = "title"
            except Exception as exc:
                logger.info("pmid-backfill title lookup failed for %s: %s", aid, exc)

        if not pmid:
            items.append({
                "id":        aid,
                "title":     title,
                "doi":       doi,
                "found_pmid": None,
                "via":       None,
                "reason":    "not_found",
            })
            continue

        # 3) Write back. Unique constraint on pubmed_id means another
        #    row already owns this PMID — surface that without raising.
        s = _session()
        try:
            try:
                s.execute(sql_text("""
                    UPDATE articles
                       SET pubmed_id = :p, updated_at = NOW()
                     WHERE id = :id AND pubmed_id IS NULL
                """), {"p": pmid, "id": aid})
                s.commit()
                found += 1
                items.append({
                    "id":         aid,
                    "title":      title,
                    "doi":        doi,
                    "found_pmid": pmid,
                    "via":        via,
                })
            except Exception as exc:
                s.rollback()
                msg = str(exc)[:200]
                items.append({
                    "id":        aid,
                    "title":     title,
                    "doi":       doi,
                    "found_pmid": pmid,
                    "via":       via,
                    "reason":    "duplicate" if "unique" in msg.lower()
                                              or "pubmed_id" in msg.lower()
                                              else "update_failed",
                    "error":     msg,
                })
        finally:
            s.close()

    return jsonify({
        "processed": len(items),
        "found":     found,
        "items":     items,
    })


_DEFAULT_WATCH_FOLDER = "/PrionLab tools/PDFs"


@prionvault_bp.route("/api/ingest/scan-folder", methods=["POST"])
@admin_required
def api_ingest_scan_folder():
    """List PDFs in a Dropbox folder and enqueue each one for ingestion.

    The worker's success / duplicate transitions delete the source file
    from the folder, so over time the folder ends up containing only the
    PDFs that couldn't be auto-ingested (scans without text, etc.).

    Body (all optional):
      { "folder": "/PrionLab tools/PDFs", "limit": 50 }
    """
    from .services.folder_scanner import scan_folder_into_queue

    data   = request.get_json(silent=True) or {}
    folder = (data.get("folder") or _DEFAULT_WATCH_FOLDER).strip()
    try:
        per_call_limit = int(data.get("limit", 50))
    except (TypeError, ValueError):
        per_call_limit = 50

    result = scan_folder_into_queue(
        folder=folder, per_call_limit=per_call_limit, user_id=_viewer_id(),
    )
    if not result.get("ok"):
        status = (404 if result.get("error") == "folder_not_accessible"
                  else 503 if result.get("error") in ("dropbox_unavailable",
                                                       "dropbox_not_configured")
                  else 502)
        return jsonify(result), status
    return jsonify(result), 202


# ── PDF streaming (inline viewer) ───────────────────────────────────────────
@prionvault_bp.route("/api/articles/<uuid:aid>/pdf-view", methods=["GET"])
@login_required
def api_article_pdf_view(aid):
    """HTML wrapper that renders the article's PDF with a sticky
    "← Volver" bar and a real scrollable viewer.

    iOS Safari (and some Chrome builds) refuse to scroll a PDF
    rendered inside an iframe — only the first page shows up. We
    instead pull the PDF via PDF.js (Mozilla, CDN-hosted) and draw
    each page into its own canvas stacked vertically inside a
    normal scrolling div, so the browser's native momentum scroll
    just works.

    Pages are rendered lazily via IntersectionObserver — a 50-page
    paper costs the memory of ~3 visible canvases at a time, not
    the whole document.
    """
    from flask import Response
    s = _session()
    try:
        row = s.execute(sql_text(
            "SELECT title FROM articles WHERE id = :aid"
        ), {"aid": str(aid)}).first()
        if not row:
            return jsonify({"error": "article not found"}), 404
        title = (row[0] or "PDF")
    finally:
        s.close()
    esc = (title.replace("&", "&amp;")
                .replace("<", "&lt;").replace(">", "&gt;")
                .replace('"', "&quot;"))
    pdf_url = f"/prionvault/api/articles/{aid}/pdf"
    # NOTE: PDF.js 3.x — UMD bundle, stable, well-tested on mobile.
    # We pin the version explicitly so a CDN-side upgrade can't break
    # the viewer overnight.
    html = (
        '<!doctype html><html><head>'
        '<meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f'<title>{esc}</title>'
        '<style>'
        '  html,body{margin:0;padding:0;height:100%;background:#444;'
        '            font:500 14px/1.3 -apple-system,system-ui,sans-serif;'
        '            -webkit-overflow-scrolling:touch;}'
        '  #pv-pdf-topbar{position:sticky;top:0;z-index:10;display:flex;'
        '    align-items:center;gap:10px;background:#0F3460;color:white;'
        '    padding:10px 14px;box-shadow:0 1px 4px rgba(0,0,0,0.25);}'
        '  #pv-pdf-back{background:rgba(255,255,255,0.18);color:white;'
        '    text-decoration:none;padding:8px 14px;border-radius:8px;'
        '    font-weight:600;flex-shrink:0;min-height:36px;'
        '    display:inline-flex;align-items:center;}'
        '  #pv-pdf-back:hover,#pv-pdf-back:active{background:rgba(255,255,255,0.30);}'
        '  #pv-pdf-title{flex:1;min-width:0;overflow:hidden;'
        '    text-overflow:ellipsis;white-space:nowrap;'
        '    color:rgba(255,255,255,0.92);}'
        '  #pv-pdf-pages{display:flex;flex-direction:column;align-items:center;'
        '    gap:10px;padding:10px;}'
        '  .pv-pdf-page{background:white;box-shadow:0 2px 10px rgba(0,0,0,0.4);'
        '    display:block;max-width:100%;}'
        '  #pv-pdf-status{color:rgba(255,255,255,0.85);padding:20px;text-align:center;}'
        '</style></head><body>'
        '<div id="pv-pdf-topbar">'
        '  <a id="pv-pdf-back" href="/prionvault/" '
        '     title="Volver al listado de PrionVault">← Volver</a>'
        f'  <span id="pv-pdf-title" title="{esc}">{esc}</span>'
        '</div>'
        '<div id="pv-pdf-pages">'
        '  <div id="pv-pdf-status">Cargando PDF…</div>'
        '</div>'
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>'
        '<script>'
        '(function(){'
        '  var lib = window["pdfjs-dist/build/pdf"] || window.pdfjsLib;'
        '  if (!lib) {'
        '    document.getElementById("pv-pdf-status").textContent = '
        '      "No se pudo cargar el visor PDF (CDN no disponible)."; return;'
        '  }'
        '  lib.GlobalWorkerOptions.workerSrc = '
        '    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";'
        f'  var url = "{pdf_url}";'
        '  var container = document.getElementById("pv-pdf-pages");'
        '  var status    = document.getElementById("pv-pdf-status");'
        '  var dpr = Math.min(window.devicePixelRatio || 1, 2);'
        '  /* getDocument with credentials so the same-origin session '
        '     cookie is sent and our @login_required passes. */'
        '  lib.getDocument({url: url, withCredentials: true}).promise.then(function(pdf){'
        '    status.remove();'
        '    var width = Math.min(container.clientWidth - 20, 900);'
        '    var observer = new IntersectionObserver(function(entries){'
        '      entries.forEach(function(e){'
        '        var canvas = e.target;'
        '        if (e.isIntersecting && !canvas.dataset.rendered) {'
        '          canvas.dataset.rendered = "1";'
        '          canvas._page.render({'
        '            canvasContext: canvas.getContext("2d"),'
        '            viewport: canvas._viewport,'
        '          });'
        '        }'
        '      });'
        '    }, { rootMargin: "600px 0px 600px 0px" });'
        '    var chain = Promise.resolve();'
        '    for (var n = 1; n <= pdf.numPages; n++) {'
        '      (function(pageNum){'
        '        chain = chain.then(function(){'
        '          return pdf.getPage(pageNum).then(function(page){'
        '            var base = page.getViewport({scale: 1});'
        '            var scale = (width / base.width) * dpr;'
        '            var viewport = page.getViewport({scale: scale});'
        '            var canvas = document.createElement("canvas");'
        '            canvas.className = "pv-pdf-page";'
        '            canvas.width = Math.floor(viewport.width);'
        '            canvas.height = Math.floor(viewport.height);'
        '            canvas.style.width = width + "px";'
        '            canvas.style.height = (viewport.height / dpr) + "px";'
        '            canvas._page = page;'
        '            canvas._viewport = viewport;'
        '            container.appendChild(canvas);'
        '            observer.observe(canvas);'
        '          });'
        '        });'
        '      })(n);'
        '    }'
        '  }).catch(function(err){'
        '    status.innerHTML = "<strong>Error cargando PDF:</strong> " +'
        '      (err && err.message ? err.message : String(err)) +'
        '      "<br><br><a href=\\"" + url + "\\" target=\\"_blank\\"'
        ' style=\\"color:#93c5fd;\\">Abrir directamente</a>";'
        '  });'
        '})();'
        '</script>'
        '</body></html>'
    )
    return Response(html, mimetype="text/html")


@prionvault_bp.route("/api/articles/<uuid:aid>/upload-pdf", methods=["POST"])
@admin_required
def api_article_upload_pdf(aid):
    """Attach a PDF file to an existing article.

    Reads the multipart-uploaded file (field name "file" or "pdf"),
    uploads it to the canonical Dropbox path via the existing
    dropbox_uploader, and stamps dropbox_path / pdf_md5 /
    pdf_size_bytes on the article row. The background batches
    (extract → searchable → index → summarise) will pick it up
    automatically afterwards.

    Refuses the upload if another article in the catalogue already
    owns this PDF (md5 match) to keep the duplicate guarantees
    consistent with the ingest queue.

    Body: multipart/form-data with a single "file" field.
    """
    import hashlib
    from .ingestion.dropbox_uploader import build_path, upload_pdf

    fs = request.files.get("file") or request.files.get("pdf")
    if not fs or not fs.filename:
        return jsonify({"error": "missing PDF file"}), 400
    content = fs.read()
    if not content:
        return jsonify({"error": "empty file"}), 400
    if not content.startswith(b"%PDF"):
        return jsonify({"error": "el fichero no parece un PDF (falta cabecera %PDF)"}), 400
    if len(content) > 80 * 1024 * 1024:
        return jsonify({"error": "PDF demasiado grande (límite 80 MB)"}), 413

    s = _session()
    try:
        row = s.execute(sql_text(
            "SELECT doi, year, dropbox_path FROM articles WHERE id = :aid"
        ), {"aid": str(aid)}).first()
        if not row:
            return jsonify({"error": "article not found"}), 404
        doi, year, current_path = row[0], row[1], row[2]
    finally:
        s.close()

    md5 = hashlib.md5(content).hexdigest()

    # Dedup by md5 against the rest of the catalogue. If another row
    # already has this exact PDF, surface it so the operator merges
    # by hand instead of ending up with duplicate files.
    s = _session()
    try:
        dup = s.execute(sql_text(
            "SELECT id::text FROM articles WHERE pdf_md5 = :m AND id <> :aid LIMIT 1"
        ), {"m": md5, "aid": str(aid)}).first()
    finally:
        s.close()
    if dup:
        return jsonify({
            "error":        "duplicate_pdf",
            "detail":       "Otro artículo de la biblioteca ya tiene este mismo PDF.",
            "duplicate_of": dup[0],
        }), 409

    target = build_path(doi=doi, year=year, md5=md5,
                        filename_hint=fs.filename)
    # If a different article tried before us and already wrote the same
    # path, overwrite is safe (deterministic path → identical content).
    # Otherwise, autorename would be confusing here — pass overwrite=True
    # only when current_path matches target (re-attaching).
    overwrite = (current_path == target)
    upload = upload_pdf(content, target, overwrite=overwrite)
    if upload.error and "already_exists" not in (upload.error or "").lower():
        return jsonify({"error": "dropbox_upload_failed",
                        "detail": upload.error[:300]}), 502
    dropbox_path = upload.dropbox_path or target

    # Count pages here too so the operator sees a "12 pages" badge
    # without having to wait for a separate backfill pass. We already
    # have the bytes in memory; pdfplumber is fast for the page
    # enumeration alone (no text extraction).
    pdf_pages = None
    try:
        import pdfplumber
        import io as _io
        with pdfplumber.open(_io.BytesIO(content)) as pdf:
            pdf_pages = len(pdf.pages)
    except Exception as exc:
        logger.warning("upload_pdf: page count failed for %s (%s)", aid, exc)

    s = _session()
    try:
        s.execute(sql_text("""
            UPDATE articles
               SET dropbox_path   = :p,
                   dropbox_link   = :lnk,
                   pdf_md5        = :m,
                   pdf_size_bytes = :sz,
                   pdf_pages      = COALESCE(:pages, pdf_pages),
                   pdf_oa_status  = COALESCE(NULLIF(pdf_oa_status, ''), 'manual_upload'),
                   updated_at     = NOW()
             WHERE id = :aid
        """), {
            "aid":   str(aid),
            "p":     dropbox_path,
            "lnk":   upload.dropbox_link,
            "m":     md5,
            "sz":    len(content),
            "pages": pdf_pages,
        })
        s.commit()
    except Exception as exc:
        s.rollback()
        logger.exception("upload_pdf: persist failed for %s", aid)
        return jsonify({"error": "persist_failed",
                        "detail": str(exc)[:300]}), 500
    finally:
        s.close()
    return jsonify({
        "ok":           True,
        "dropbox_path": dropbox_path,
        "pdf_md5":      md5,
        "size_bytes":   len(content),
        "pdf_pages":    pdf_pages,
    })


@prionvault_bp.route("/api/articles/<uuid:aid>/pdf", methods=["GET"])
@login_required
def api_article_pdf(aid):
    """Stream the article's PDF from Dropbox so the browser can render it.

    Proxying through Flask avoids CORS / X-Frame-Options issues that
    appear when embedding Dropbox URLs directly in an iframe, and keeps
    the file gated behind the same login as the rest of the app.
    """
    s = _session()
    try:
        row = s.execute(sql_text(
            "SELECT dropbox_path, title FROM articles WHERE id = :aid"
        ), {"aid": str(aid)}).first()
        if not row:
            return jsonify({"error": "article not found"}), 404
        dropbox_path = row[0]
        if not dropbox_path:
            return jsonify({"error": "no PDF for this article"}), 404
    finally:
        s.close()

    try:
        from core.dropbox_client import get_client
    except Exception as exc:
        logger.warning("api_article_pdf: dropbox import failed: %s", exc)
        return jsonify({"error": "dropbox client unavailable"}), 503

    client = get_client()
    if client is None:
        return jsonify({"error": "dropbox client unavailable"}), 503

    try:
        _meta, response = client.files_download(dropbox_path)
        content = response.content
    except Exception as exc:
        logger.warning("api_article_pdf(%s): %s", dropbox_path, exc)
        return jsonify({"error": "could not fetch PDF",
                        "detail": str(exc)[:300]}), 502

    filename = (dropbox_path.rsplit("/", 1)[-1] or "article.pdf").replace('"', "")
    return Response(
        content,
        mimetype="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{filename}"',
            "Cache-Control": "private, max-age=600",
            "X-Frame-Options": "SAMEORIGIN",
        },
    )


@prionvault_bp.route("/api/articles/search-by-idea", methods=["POST"])
@login_required
def api_articles_search_by_idea():
    """Semantic search for articles that support or contradict a given idea."""
    data = request.get_json(silent=True) or {}
    idea_text = (data.get("idea") or "").strip()
    mode = (data.get("mode") or "support").strip().lower()
    limit = int(data.get("limit") or 15)

    if not idea_text:
        return jsonify({"error": "idea is required"}), 400
    if mode not in ("support", "contradict"):
        return jsonify({"error": "mode must be 'support' or 'contradict'"}), 400
    limit = max(1, min(50, limit))

    # Generate embedding for the idea
    try:
        from .embeddings.embedder import embed_query, NotConfigured as VoyageNotConfigured
        qvec = embed_query(idea_text)
    except VoyageNotConfigured as exc:
        return jsonify({"error": "embedder not configured", "detail": str(exc)[:200]}), 503
    except Exception as exc:
        logger.exception("search-by-idea: embed_query failed")
        return jsonify({"error": "embedding failed", "detail": str(exc)[:200]}), 500

    if not qvec:
        return jsonify({"error": "empty embedding returned"}), 500

    vec_str = "[" + ",".join(str(v) for v in qvec) + "]"
    k = 30 if mode == "contradict" else limit

    sql = sql_text("""
        SELECT a.id, a.title, a.authors, a.year, a.journal, a.doi, a.pubmed_id,
               (a.dropbox_path IS NOT NULL) AS has_pdf,
               a.summary_ai,
               MIN(c.embedding <=> (:vec)::vector) AS distance
        FROM article_chunk c
        JOIN articles a ON a.id = c.article_id
        WHERE c.embedding IS NOT NULL
        GROUP BY a.id, a.title, a.authors, a.year, a.journal, a.doi, a.pubmed_id,
                 a.dropbox_path, a.summary_ai
        ORDER BY distance ASC
        LIMIT :k
    """)

    s = _session()
    try:
        rows = s.execute(sql, {"vec": vec_str, "k": k}).fetchall()
    except Exception as exc:
        logger.exception("search-by-idea: pgvector query failed")
        return jsonify({"error": "database query failed", "detail": str(exc)[:200]}), 500
    finally:
        s.close()

    candidates = [
        {
            "id":         str(r[0]),
            "title":      r[1] or "",
            "authors":    r[2] or "",
            "year":       r[3],
            "journal":    r[4] or "",
            "doi":        r[5] or "",
            "pubmed_id":  r[6] or "",
            "has_pdf":    bool(r[7]),
            "summary_ai": r[8] or "",
            "similarity": round(1 - float(r[9]), 4) if r[9] is not None else None,
        }
        for r in rows
    ]

    if mode == "support":
        items = candidates[:limit]
        for it in items:
            it.pop("summary_ai", None)
        return jsonify({"items": items, "mode": "support"})

    # contradict mode — ask Claude to pick articles that challenge/refute the idea
    try:
        from .services.llm_pool import call_llm_json_with_fallback
    except ImportError as exc:
        return jsonify({"error": "llm_pool unavailable", "detail": str(exc)[:200]}), 503

    candidate_lines = "\n".join(
        f"{c['id']} | {c['title']} | {c['summary_ai'][:400] if c['summary_ai'] else '(sin resumen)'}"
        for c in candidates
    )
    system_prompt = (
        "Eres un científico experto evaluando artículos científicos. "
        "Tu tarea es identificar qué artículos contradicen, refutan o cuestionan "
        "significativamente una idea dada.\n"
        'Responde ÚNICAMENTE con JSON: {"contradicting": [{"id": "...", "reason": "..."}]}'
    )
    user_msg = (
        f"Idea: {idea_text}\n\n"
        f"Artículos candidatos (id | título | resumen):\n{candidate_lines}"
    )
    try:
        parsed, _info = call_llm_json_with_fallback(
            providers=["anthropic", "openai", "gemini"],
            system=system_prompt,
            user=user_msg,
            max_tokens=1500,
        )
    except Exception as exc:
        logger.warning("search-by-idea: contradict LLM call failed: %s", exc)
        return jsonify({"error": "LLM call failed", "detail": str(exc)[:200]}), 502

    contradicting_list = parsed.get("contradicting") or []
    reason_by_id = {
        item.get("id"): item.get("reason", "")
        for item in contradicting_list
        if isinstance(item, dict) and item.get("id")
    }
    cand_by_id = {c["id"]: c for c in candidates}

    items = []
    for cid, reason in reason_by_id.items():
        c = cand_by_id.get(str(cid))
        if not c:
            continue
        entry = {k: v for k, v in c.items() if k != "summary_ai"}
        entry["reason"] = reason
        items.append(entry)
        if len(items) >= limit:
            break

    return jsonify({"items": items, "mode": "contradict"})


_thumb_cache: OrderedDict = OrderedDict()   # aid → jpeg_bytes
_thumb_cache_lock = threading.Lock()
_THUMB_CACHE_MAX = 200                       # max entries (~5 MB at ~25 KB each)


@prionvault_bp.route("/api/articles/<uuid:aid>/thumbnail", methods=["GET"])
@login_required
def api_article_thumbnail(aid):
    """Return a JPEG thumbnail of the first PDF page.

    Uses PyMuPDF (already a dependency for OCR) to render page 0 at
    low resolution. Aggressive browser caching (7 days) means each
    article thumbnail is fetched at most once per browser per week.
    """
    aid_str = str(aid)

    # Serve from in-process cache when available
    with _thumb_cache_lock:
        if aid_str in _thumb_cache:
            _thumb_cache.move_to_end(aid_str)
            jpeg_bytes = _thumb_cache[aid_str]
            etag = hashlib.md5(jpeg_bytes).hexdigest()
            if request.headers.get("If-None-Match") == etag:
                return Response(status=304)
            return Response(
                jpeg_bytes,
                mimetype="image/jpeg",
                headers={"Cache-Control": "private, max-age=604800", "ETag": etag},
            )

    s = _session()
    try:
        row = s.execute(sql_text(
            "SELECT dropbox_path FROM articles WHERE id = :aid"
        ), {"aid": aid_str}).first()
        if not row or not row[0]:
            return Response(status=404)
        dropbox_path = row[0]
    finally:
        s.close()

    try:
        from core.dropbox_client import get_client
        import fitz  # PyMuPDF
    except Exception as exc:
        logger.warning("api_article_thumbnail: import failed: %s", exc)
        return Response(status=503)

    client = get_client()
    if client is None:
        return Response(status=503)

    try:
        _meta, response = client.files_download(dropbox_path)
        pdf_bytes = response.content
    except Exception as exc:
        logger.warning("api_article_thumbnail(%s): download failed: %s", dropbox_path, exc)
        return Response(status=502)

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        page = doc[0]
        mat = fitz.Matrix(1.0, 1.0)   # 72 dpi — fast, enough for a thumbnail
        pix = page.get_pixmap(matrix=mat, alpha=False)
        jpeg_bytes = pix.tobytes("jpeg", jpg_quality=75)
        doc.close()
    except Exception as exc:
        logger.warning("api_article_thumbnail: render failed: %s", exc)
        return Response(status=500)

    # Store in in-process LRU cache
    with _thumb_cache_lock:
        _thumb_cache[aid_str] = jpeg_bytes
        _thumb_cache.move_to_end(aid_str)
        if len(_thumb_cache) > _THUMB_CACHE_MAX:
            _thumb_cache.popitem(last=False)

    etag = hashlib.md5(jpeg_bytes).hexdigest()
    return Response(
        jpeg_bytes,
        mimetype="image/jpeg",
        headers={"Cache-Control": "private, max-age=604800", "ETag": etag},  # 7 days
    )


@prionvault_bp.route("/api/articles/<uuid:aid>/chunks", methods=["GET"])
@admin_required
def api_article_chunks(aid):
    """Return the article's chunked text + a peek at each chunk's
    Voyage embedding. Powers the "Indexed" badge → "Ver chunks"
    modal in the listing.

    The full 1024-dim vector is way too big to ship to the UI for
    every chunk; we only send `embedding_preview` (first 8 dims)
    so the admin can sanity-check that the column is populated.
    `has_embedding` flags chunks that haven't been indexed yet.
    """
    s = _session()
    try:
        head = s.execute(sql_text(
            "SELECT title, year FROM articles WHERE id = :aid"
        ), {"aid": str(aid)}).first()
        if not head:
            return jsonify({"error": "article not found"}), 404

        rows = s.execute(sql_text(
            """
            SELECT id, chunk_index, source_field, chunk_text, tokens,
                   page_from, page_to,
                   (embedding IS NOT NULL) AS has_embedding,
                   -- pgvector serialises a vector as "[v0,v1,...]" text;
                   -- splitting once gives us cheap access to the first
                   -- few dims without dragging the whole 1024-element
                   -- array across the wire.
                   CASE WHEN embedding IS NOT NULL
                        THEN substring(embedding::text, 1, 220)
                        ELSE NULL END AS embedding_head,
                   created_at
              FROM article_chunk
             WHERE article_id = :aid
             ORDER BY source_field, chunk_index
            """
        ), {"aid": str(aid)}).mappings().all()
    finally:
        s.close()

    chunks = []
    for r in rows:
        head_txt = (r["embedding_head"] or "")
        first_dims: list[float] = []
        if head_txt.startswith("["):
            for tok in head_txt[1:].split(",")[:8]:
                try:
                    first_dims.append(float(tok))
                except ValueError:
                    break
        text = r["chunk_text"] or ""
        chunks.append({
            "id":            int(r["id"]),
            "chunk_index":   int(r["chunk_index"]),
            "source_field":  r["source_field"],
            "tokens":        int(r["tokens"]) if r["tokens"] is not None else None,
            "chars":         len(text),
            "page_from":     int(r["page_from"]) if r["page_from"] is not None else None,
            "page_to":       int(r["page_to"])   if r["page_to"]   is not None else None,
            "preview":       text[:240],
            "chunk_text":    text,
            "has_embedding": bool(r["has_embedding"]),
            "embedding_preview": first_dims,
            "created_at":    r["created_at"].isoformat() if r["created_at"] else None,
        })

    total = len(chunks)
    indexed = sum(1 for c in chunks if c["has_embedding"])
    total_tokens = sum((c["tokens"] or 0) for c in chunks)
    total_chars  = sum(c["chars"]         for c in chunks)
    return jsonify({
        "article_id":    str(aid),
        "title":         head[0],
        "year":          head[1],
        "total_chunks":  total,
        "indexed":       indexed,
        "missing":       total - indexed,
        "total_tokens":  total_tokens,
        "total_chars":   total_chars,
        "embedding_dim": 1024,           # voyage-4-large
        "model":         "voyage-4-large",
        "chunks":        chunks,
    })


@prionvault_bp.route("/api/chunks/<int:chunk_id>/similar", methods=["GET"])
@admin_required
def api_chunk_similar(chunk_id):
    """Find the chunks closest to this one in Voyage embedding space.

    Powers the "🔍 Buscar similares" link in the chunks inspector
    modal. Excludes chunks from the same source article by default
    so the result is "other papers that talk about this", which is
    what makes the feature interesting; pass ?same_article=true
    to include in-paper chunks too (rare — useful for verifying
    chunking quality).

    Cosine DISTANCE (pgvector's <=>) ranges 0 (identical) to 2
    (opposite); we surface the conventional "similarity" (1 -
    distance) since that's what humans expect when reading a
    "97% similar" badge.
    """
    same_article  = request.args.get("same_article", "false").lower() == "true"
    limit = max(1, min(20, request.args.get("limit", 5, type=int)))

    s = _session()
    try:
        src = s.execute(sql_text(
            "SELECT article_id, embedding "
            "  FROM article_chunk "
            " WHERE id = :id AND embedding IS NOT NULL"
        ), {"id": chunk_id}).first()
        if not src:
            return jsonify({"error": "chunk_not_found_or_unindexed"}), 404
        src_article = src[0]

        # pgvector binds happily through SQLAlchemy when we cast
        # the source vector to ::vector. Cosine distance via the
        # <=> operator uses the existing HNSW index for fast top-K.
        if same_article:
            where_clause = "c.id <> :chunk_id"
        else:
            where_clause = "c.id <> :chunk_id AND c.article_id <> :src_article"

        rows = s.execute(sql_text(f"""
            SELECT c.id, c.article_id, c.chunk_index, c.chunk_text,
                   c.page_from, c.page_to,
                   a.title, a.year, a.pubmed_id, a.doi,
                   (c.embedding <=> (SELECT embedding FROM article_chunk WHERE id = :chunk_id))
                       AS distance
              FROM article_chunk c
              JOIN articles a ON a.id = c.article_id
             WHERE {where_clause}
               AND c.embedding IS NOT NULL
             ORDER BY c.embedding <=> (SELECT embedding FROM article_chunk WHERE id = :chunk_id)
             LIMIT :limit
        """), {
            "chunk_id":    chunk_id,
            "src_article": str(src_article),
            "limit":       limit,
        }).mappings().all()
    finally:
        s.close()

    return jsonify({
        "source_chunk_id":  chunk_id,
        "source_article":   str(src_article),
        "same_article":     same_article,
        "results": [
            {
                "chunk_id":    int(r["id"]),
                "article_id":  str(r["article_id"]),
                "chunk_index": int(r["chunk_index"]),
                "page_from":   int(r["page_from"]) if r["page_from"] is not None else None,
                "page_to":     int(r["page_to"])   if r["page_to"]   is not None else None,
                "title":       r["title"],
                "year":        r["year"],
                "pubmed_id":   r["pubmed_id"],
                "doi":         r["doi"],
                "preview":     (r["chunk_text"] or "")[:240],
                "distance":    float(r["distance"]),
                "similarity":  round(1.0 - float(r["distance"]), 4),
            }
            for r in rows
        ],
    })


@prionvault_bp.route("/api/articles/<uuid:aid>/identify-pmid", methods=["POST"])
@admin_required
def api_article_identify_pmid(aid):
    """AI-assisted PMID lookup from the article's PDF.

    Flow:
      1. Download the article's saved PDF from Dropbox.
      2. Extract text from the first pages with pdfplumber.
      3. gpt-4o-mini returns {title, first_author_lastname, year}.
      4. PubMed esearch resolves a PMID from those hints.
      5. If another article already owns that PMID, this row is a
         duplicate — move its PDF to `<parent>/_duplicates/<file>`
         (same convention used by the ingest worker), detach
         dropbox_path on the row, and return duplicate=true so the
         UI can warn instead of chaining the metadata fetch.

    Returns 200 in every "we ran successfully" case (including the
    duplicate one), 404 if no PDF, 422 if the AI couldn't identify
    a title, 502 if Dropbox / pdfplumber failed, 503 if OpenAI is
    not configured.
    """
    from .ingestion.metadata_resolver import (
        pubmed_search_pmid_by_title, pubmed_resolve_aiassisted,
    )
    from .ingestion.pdf_extractor import extract_pdf
    from .services.ai_identifier import (
        identify_article_from_pdf_text, AIIdentifierError,
    )

    s = _session()
    try:
        row = s.execute(sql_text(
            "SELECT dropbox_path FROM articles WHERE id = :aid"
        ), {"aid": str(aid)}).first()
        if not row:
            return jsonify({"error": "article not found"}), 404
        dropbox_path = row[0]
    finally:
        s.close()

    if not dropbox_path:
        return jsonify({"error": "Este artículo no tiene PDF guardado"}), 422

    try:
        from core.dropbox_client import get_client
    except Exception as exc:
        logger.warning("identify_pmid: dropbox import failed: %s", exc)
        return jsonify({"error": "dropbox client unavailable"}), 503

    client = get_client()
    if client is None:
        return jsonify({"error": "dropbox client unavailable"}), 503

    try:
        _meta, response = client.files_download(dropbox_path)
        pdf_bytes = response.content
    except Exception as exc:
        logger.warning("identify_pmid: dropbox download failed (%s): %s", dropbox_path, exc)
        return jsonify({"error": f"No se pudo descargar el PDF: {exc}"}), 502

    extraction = extract_pdf(pdf_bytes)
    if extraction.error and not extraction.text:
        return jsonify({"error": f"No se pudo leer el PDF: {extraction.error}"}), 502

    try:
        identified = identify_article_from_pdf_text(extraction.text)
    except AIIdentifierError as exc:
        status_map = {
            "NOT_CONFIGURED": 503,
            "INVALID_KEY":    503,
            "INVALID_INPUT":  422,
            "RATE_LIMITED":   429,
            "EMPTY_RESPONSE": 502,
            "UPSTREAM_ERROR": 502,
        }
        return jsonify({"error": str(exc)}), status_map.get(exc.code, 500)

    if not identified.get("title"):
        return jsonify({
            "error":      "La IA no pudo identificar el título en el PDF",
            "identified": identified,
        }), 422

    pmid = pubmed_search_pmid_by_title(
        title=identified["title"],
        author=identified.get("first_author_lastname"),
        year=identified.get("year"),
    )
    # Second pass: if the direct title query came up empty, let the AI
    # pull a shortlist of broader candidates (by author / journal / year)
    # and pick the matching PMID. This emulates the manual workflow the
    # operator would otherwise have to do by hand on PubMed's website.
    if not pmid:
        try:
            pmid = pubmed_resolve_aiassisted(
                pdf_excerpt=extraction.text or "",
                title=identified.get("title"),
                authors=identified.get("authors") or [],
                journal=identified.get("journal"),
                year=identified.get("year"),
            )
        except Exception as exc:
            logger.warning("identify_pmid: ai-assisted pass crashed (%s)", exc)
            pmid = None
        if pmid:
            identified["resolved_via"] = "ai_assisted"
    if not pmid:
        return jsonify({
            "error":      "PubMed no encontró ningún PMID para el artículo identificado",
            "identified": identified,
        }), 404

    # Duplicate guard: if any OTHER article already owns this PMID,
    # the row being edited is a duplicate of that one.
    s = _session()
    try:
        dup = s.execute(sql_text(
            "SELECT id, title, doi, pubmed_id, year FROM articles "
            "WHERE pubmed_id = :p AND id <> :aid LIMIT 1"
        ), {"p": str(pmid), "aid": str(aid)}).first()
    finally:
        s.close()

    if dup:
        # Move PDF to <parent>/_duplicates/<file> — same shape the
        # ingest worker uses in cleanup_source_pdf().
        parent  = dropbox_path.rsplit("/", 1)[0]
        base    = dropbox_path.rsplit("/", 1)[1]
        dup_dir = f"{parent}/_duplicates"
        dest    = f"{dup_dir}/{base}"
        moved_to    = None
        move_error  = None
        try:
            import dropbox
            try:
                client.files_create_folder_v2(dup_dir)
            except dropbox.exceptions.ApiError as exc:
                if "conflict" not in str(exc).lower():
                    raise
            result = client.files_move_v2(dropbox_path, dest, autorename=True)
            meta = getattr(result, "metadata", None)
            moved_to = getattr(meta, "path_display", None) or dest
        except Exception as exc:
            move_error = str(exc)[:300]
            logger.warning("identify_pmid: move-to-duplicates failed (%s -> %s): %s",
                           dropbox_path, dest, exc)

        # Detach the PDF from the row so the UI no longer claims it.
        if moved_to:
            s = _session()
            try:
                s.execute(sql_text(
                    "UPDATE articles SET dropbox_path = NULL, dropbox_link = NULL, "
                    "                    updated_at = NOW() "
                    "WHERE id = :aid"
                ), {"aid": str(aid)})
                s.commit()
            finally:
                s.close()

        return jsonify({
            "pmid":         pmid,
            "identified":   identified,
            "duplicate":    True,
            "duplicate_of": {
                "id":        str(dup[0]),
                "title":     dup[1],
                "doi":       dup[2],
                "pubmed_id": dup[3],
                "year":      dup[4],
            },
            "moved_to":   moved_to,
            "move_error": move_error,
        })

    return jsonify({"pmid": pmid, "identified": identified})


@prionvault_bp.route("/api/articles/<uuid:aid>/count-pages", methods=["POST"])
@admin_required
def api_count_pdf_pages(aid):
    """Download the article PDF from Dropbox and store its page count.

    Fetches `dropbox_path` from the DB, downloads the file via the Dropbox
    SDK, counts pages with pdfplumber, then writes `pdf_pages` back to the
    articles row. Safe to call multiple times — will overwrite an existing value.
    """
    s = _session()
    try:
        row = s.execute(
            sql_text("SELECT dropbox_path, pdf_pages FROM articles WHERE id = :aid"),
            {"aid": str(aid)},
        ).first()
        if row is None:
            return jsonify({"error": "not found"}), 404

        dropbox_path = row[0]
        if not dropbox_path:
            return jsonify({"error": "no dropbox_path on this article"}), 422

        pages = _count_pages_from_dropbox(dropbox_path)
        if pages is None:
            return jsonify({"error": "could not count pages — check Dropbox config or PDF path"}), 500

        s.execute(
            sql_text("UPDATE articles SET pdf_pages = :p WHERE id = :aid"),
            {"p": pages, "aid": str(aid)},
        )
        s.commit()
        return jsonify({"pdf_pages": pages})
    except Exception as exc:
        logger.exception("api_count_pdf_pages failed for %s", aid)
        s.rollback()
        return jsonify({"error": str(exc)}), 500
    finally:
        db.Session.remove()


@prionvault_bp.route("/api/admin/retry-abstracts", methods=["POST"])
@admin_required
def api_admin_retry_abstracts():
    """Re-attempt the abstract lookup for articles that still don't
    have one but carry a DOI or PMID. Includes the rows we previously
    marked as 'abstract_unavailable', so a parser improvement (e.g.
    pubmed_efetch_abstract) can rescue them.

    Body (optional): {"limit": 250}. Default 250, capped at 500.

    Time-budgeted: each call processes as many rows as fit in
    ~_TIME_BUDGET_S seconds, then returns. The JS already loops on
    `remaining > 0` so the operator's single click can chew through
    the whole backlog without hitting gunicorn's request timeout
    (which previously killed the worker with SystemExit).
    """
    import time as _time
    from .ingestion.metadata_resolver import (
        resolve_metadata, pubmed_by_doi, pubmed_efetch_abstract,
    )

    # Leave a comfortable margin below Railway's typical 30 s HTTP
    # timeout — 25 s lets a slow PubMed call finish + still return
    # cleanly. Tunable via env if a future deploy uses a different
    # gateway timeout.
    _TIME_BUDGET_S = float(os.environ.get(
        "PRIONVAULT_RETRY_ABSTRACTS_BUDGET_S", "25"))
    started_at = _time.monotonic()

    data  = request.get_json(silent=True) or {}
    try:
        limit = int(data.get("limit", 250))
    except (TypeError, ValueError):
        limit = 250
    limit = max(1, min(500, limit))

    s = _session()
    try:
        rows = s.execute(sql_text(
            """SELECT id, doi, pubmed_id FROM articles
               WHERE coalesce(abstract, '') = ''
                 AND (doi IS NOT NULL OR pubmed_id IS NOT NULL)
               ORDER BY abstract_unavailable DESC, updated_at ASC
               LIMIT :limit"""
        ), {"limit": limit}).mappings().all()

        recovered    = 0
        still_missing = 0
        learned_pmids = 0
        pmid_conflicts = 0
        time_exhausted = False
        for r in rows:
            # Stop early if we're about to bump into gunicorn's timeout.
            # The remaining rows go on the next click — UI loops on
            # `remaining > 0` so the operator doesn't have to babysit.
            if _time.monotonic() - started_at > _TIME_BUDGET_S:
                time_exhausted = True
                break
            aid  = str(r["id"])
            doi  = (r["doi"] or "").strip() or None
            pmid = (r["pubmed_id"] or "").strip() if r["pubmed_id"] else None

            new_pmid_for_save = None
            if doi and not pmid:
                try:
                    m = pubmed_by_doi(doi)
                    if m and m.pubmed_id:
                        pmid = m.pubmed_id
                        new_pmid_for_save = pmid
                except Exception:
                    pass

            abstract = None
            try:
                meta = resolve_metadata(doi=doi, pmid_hint=pmid)
                if meta and meta.abstract:
                    abstract = meta.abstract.strip()
            except Exception:
                pass
            if not abstract and pmid:
                try:
                    abstract = pubmed_efetch_abstract(pmid)
                except Exception:
                    abstract = None

            # Build the per-row UPDATE. Use a savepoint so a unique-
            # constraint clash on pubmed_id (another article in the
            # library already owns the PMID PubMed resolved from the
            # DOI) doesn't abort the whole batch — we retry the row
            # without writing pubmed_id, keeping the abstract.
            base_params = {"id": aid}
            base_set    = []
            if abstract:
                base_set.append("abstract = :abs")
                base_set.append("abstract_unavailable = FALSE")
                base_params["abs"] = abstract
            else:
                base_set.append("abstract_unavailable = TRUE")

            wrote_pmid = False
            try:
                with s.begin_nested():           # savepoint
                    params   = dict(base_params)
                    set_part = list(base_set)
                    if new_pmid_for_save:
                        set_part.append("pubmed_id = :pmid")
                        params["pmid"] = new_pmid_for_save
                    s.execute(sql_text(
                        f"UPDATE articles SET {', '.join(set_part)}, "
                        "updated_at = NOW() WHERE id = :id"
                    ), params)
                    wrote_pmid = bool(new_pmid_for_save)
            except IntegrityError as exc:
                # Most common reason: pubmed_id collides with another
                # row (the PMID we just resolved is already owned). Re-
                # apply the same UPDATE without touching pubmed_id so
                # the abstract still lands.
                if new_pmid_for_save and "pubmed_id" in str(exc).lower():
                    pmid_conflicts += 1
                    logger.info(
                        "retry-abstracts: PMID %s already owned by another "
                        "article — skipping pubmed_id write for %s, keeping "
                        "abstract.", new_pmid_for_save, aid,
                    )
                    try:
                        with s.begin_nested():
                            s.execute(sql_text(
                                f"UPDATE articles SET {', '.join(base_set)}, "
                                "updated_at = NOW() WHERE id = :id"
                            ), base_params)
                    except Exception:
                        logger.exception(
                            "retry-abstracts: retry without pubmed_id also "
                            "failed for %s", aid,
                        )
                        continue
                else:
                    logger.exception(
                        "retry-abstracts: unexpected IntegrityError for %s", aid,
                    )
                    continue

            if abstract:
                recovered += 1
            else:
                still_missing += 1
            if wrote_pmid:
                learned_pmids += 1
            # Commit per row so a later failure (or worker restart)
            # doesn't lose work that already succeeded.
            s.commit()

        # Quick "how much is left?" count so the UI can suggest
        # another run when the batch is full.
        remaining = s.execute(sql_text(
            """SELECT COUNT(*) FROM articles
               WHERE coalesce(abstract, '') = ''
                 AND (doi IS NOT NULL OR pubmed_id IS NOT NULL)"""
        )).scalar() or 0

        s.commit()
        # `processed` is what we ACTUALLY touched in this call, not
        # `len(rows)` (which is the slice we asked for from the DB).
        # Under the time budget we may have stopped early.
        processed_this_call = recovered + still_missing
        return jsonify({
            "ok":              True,
            "processed":       processed_this_call,
            "recovered":       recovered,
            "still_missing":   still_missing,
            "learned_pmids":   learned_pmids,
            "pmid_conflicts":  pmid_conflicts,
            "remaining":       int(remaining),
            "time_exhausted":  time_exhausted,
        })
    except Exception as exc:
        s.rollback()
        logger.exception("retry-abstracts failed")
        return jsonify({"error": "internal_error", "detail": str(exc)[:300]}), 500
    finally:
        s.close()


@prionvault_bp.route("/api/admin/clean-metadata", methods=["POST"])
@admin_required
def api_admin_clean_metadata():
    """Re-run the text-cleanup pass over every article in the library.

    Picks up rows that were ingested before clean_metadata_text was in
    place and surfaces them with proper Unicode characters
    (Ca²⁺ instead of `Ca<sup>2+</sup>`, María instead of `Mar&iacute;a`,
    etc.).

    No-op rows (already-clean text) skip the UPDATE so the audit trail
    stays meaningful. Returns counts so the admin can see how much
    work the pass actually did.
    """
    from .services.text_cleanup import clean_metadata_text

    s = _session()
    try:
        rows = s.execute(sql_text(
            "SELECT id, title, authors, journal, abstract FROM articles"
        )).mappings().all()

        FIELDS = ("title", "authors", "journal", "abstract")
        changed_rows = 0
        per_field = {f: 0 for f in FIELDS}

        for r in rows:
            updates = {}
            for f in FIELDS:
                original = r[f]
                cleaned  = clean_metadata_text(original) if original else original
                if cleaned != original:
                    updates[f] = cleaned
            if not updates:
                continue
            set_clause = ", ".join(f"{k} = :{k}" for k in updates)
            s.execute(sql_text(
                f"UPDATE articles SET {set_clause}, updated_at = NOW() "
                f"WHERE id = :id"
            ), {**updates, "id": str(r["id"])})
            changed_rows += 1
            for f in updates:
                per_field[f] += 1
        s.commit()
        return jsonify({
            "ok": True,
            "scanned": len(rows),
            "changed_rows": changed_rows,
            "per_field":    per_field,
        })
    except Exception as exc:
        s.rollback()
        logger.exception("clean-metadata backfill failed")
        return jsonify({"error": "internal_error", "detail": str(exc)[:300]}), 500
    finally:
        s.close()


@prionvault_bp.route("/api/admin/backfill-pdf-pages", methods=["POST"])
@admin_required
def api_backfill_pdf_pages():
    """Count pages for all articles that have a dropbox_path but no pdf_pages.

    Body (JSON, optional): {"limit": 20}   — cap how many to process at once
    (default 50). Returns counts of how many succeeded/failed.
    """
    data = request.get_json(silent=True) or {}
    limit = max(1, min(500, int(data.get("limit", 50))))

    s = _session()
    try:
        pv_cols = _get_pv_columns(s)
        if "pdf_pages" not in pv_cols:
            return jsonify({"error": "pdf_pages column not present — run migrations first"}), 422

        rows = s.execute(sql_text(
            "SELECT id::text, dropbox_path FROM articles "
            "WHERE dropbox_path IS NOT NULL AND pdf_pages IS NULL "
            "ORDER BY created_at DESC LIMIT :lim"
        ), {"lim": limit}).all()

        done, failed = 0, 0
        errors = []
        for art_id, dpath in rows:
            try:
                pages = _count_pages_from_dropbox(dpath)
                if pages is not None:
                    s.execute(
                        sql_text("UPDATE articles SET pdf_pages = :p WHERE id = :aid"),
                        {"p": pages, "aid": art_id},
                    )
                    done += 1
                else:
                    failed += 1
                    errors.append({"id": art_id, "error": "count returned None"})
            except Exception as exc:
                failed += 1
                errors.append({"id": art_id, "error": str(exc)[:200]})
        s.commit()
        return jsonify({
            "processed": done + failed,
            "updated":   done,
            "failed":    failed,
            "errors":    errors[:20],
        })
    except Exception as exc:
        logger.exception("api_backfill_pdf_pages failed")
        s.rollback()
        return jsonify({"error": str(exc)}), 500
    finally:
        db.Session.remove()


def _count_pages_from_dropbox(dropbox_path: str):
    """Download PDF from Dropbox and return page count, or None on failure."""
    try:
        from core.dropbox_client import get_client
        import pdfplumber
        import io as _io
    except Exception as exc:
        logger.warning("_count_pages_from_dropbox: import failed: %s", exc)
        return None

    client = get_client()
    if client is None:
        return None
    try:
        _meta, response = client.files_download(dropbox_path)
        content = response.content
        with pdfplumber.open(_io.BytesIO(content)) as pdf:
            return len(pdf.pages)
    except Exception as exc:
        logger.warning("_count_pages_from_dropbox(%s): %s", dropbox_path, exc)
        return None


@prionvault_bp.route("/api/articles/<uuid:aid>/summary", methods=["POST"])
@admin_required
def api_generate_summary(aid):
    """Generate (or regenerate) an AI summary for the article.

    Synchronous: blocks until Claude responds (~5-15 s typically). The
    caller's UI should show a spinner during the wait. The new summary is
    stored in `articles.summary_ai`; the existing Postgres trigger updates
    `search_vector` automatically so the text becomes searchable at once.
    Usage cost is recorded in `prionvault_usage` for budget tracking.
    """
    from .services.ai_summary import (generate_summary, NotConfigured,
                                       PROVIDERS, DEFAULT_PROVIDER)

    data = request.get_json(force=True, silent=True) or {}
    provider = (data.get("provider") or DEFAULT_PROVIDER).strip().lower()
    if provider not in PROVIDERS:
        return jsonify({"error": "unknown_provider",
                        "detail": f"Valid: {sorted(PROVIDERS)}"}), 400
    title_hint = bool(data.get("title_hint", False))

    s = _session()
    try:
        a = s.get(models.Article, aid)
        if not a:
            return jsonify({"error": "not found"}), 404

        try:
            result = generate_summary(
                title=a.title,
                authors=a.authors,
                year=a.year,
                journal=a.journal,
                abstract=a.abstract,
                doi=a.doi,
                pubmed_id=a.pubmed_id,
                extracted_text=a.extracted_text,
                provider=provider,
                title_hint=title_hint,
            )
        except NotConfigured as exc:
            return jsonify({"error": "ai_unavailable",
                            "detail": str(exc)}), 503
        except Exception as exc:
            logger.exception("AI summary generation failed for %s", aid)
            return jsonify({"error": "generation_failed",
                            "detail": str(exc)[:300]}), 502

        a.summary_ai = result.text
        a.updated_at = datetime.utcnow()

        # Persist provider + token counts via raw SQL to bypass any ORM
        # mapper gaps (the ORM path is kept above for summary_ai itself).
        try:
            s.execute(sql_text(
                """UPDATE articles
                   SET summary_ai_provider = :prov,
                       summary_ai_model    = :model,
                       summary_ai_notes    = NULL,
                       summary_tokens_in   = :tin,
                       summary_tokens_out  = :tout
                   WHERE id = CAST(:aid AS uuid)"""
            ), {"prov":  result.provider,
                "model": result.model,
                "tin":   result.tokens_in,
                "tout":  result.tokens_out,
                "aid":   str(aid)})
        except Exception as exc:
            logger.warning("api_generate_summary: could not save provider/tokens: %s", exc)

        # Usage row is best-effort. Skip the INSERT entirely if we
        # can't pin it to a user (the prionvault_usage.user_id
        # constraint is being relaxed via migration 011, but on
        # deployments where that migration has not yet landed we
        # would otherwise lose the actually-saved summary to a
        # rollback at commit time).
        _uid = _viewer_id()
        try:
            if _uid is None:
                raise RuntimeError("no viewer id — skipping usage row")
            usage = models.UsageEvent(
                user_id=_uid,
                action="summary_generate",
                cost_usd=result.cost_usd,
                tokens_in=result.tokens_in,
                tokens_out=result.tokens_out,
                meta={
                    "article_id":     str(aid),
                    "model":          result.model,
                    "used_full_text": result.used_full_text,
                    "input_chars":    result.input_chars,
                    "elapsed_ms":     result.elapsed_ms,
                },
            )
            s.add(usage)
        except Exception as exc:
            logger.warning("Could not record summary usage: %s", exc)

        s.commit()
        return jsonify({
            "ok":                 True,
            "summary_ai":         result.text,
            "summary_ai_provider": result.provider,
            "summary_tokens_in":  result.tokens_in,
            "summary_tokens_out": result.tokens_out,
            "model":              result.model,
            "tokens_in":          result.tokens_in,
            "tokens_out":         result.tokens_out,
            "cost_usd":           result.cost_usd,
            "elapsed_ms":         result.elapsed_ms,
            "used_full_text":     result.used_full_text,
        })
    except Exception as exc:
        s.rollback()
        try:
            from anthropic import APITimeoutError as _AnthropicTimeout
            if isinstance(exc, _AnthropicTimeout):
                logger.warning("api_generate_summary: Anthropic timeout")
                return jsonify({"error": "timeout", "detail": "La API de IA tardó demasiado. Inténtalo de nuevo."}), 504
        except ImportError:
            pass
        logger.exception("api_generate_summary failed")
        return jsonify({"error": "internal_error", "detail": str(exc)[:300]}), 500
    finally:
        s.close()


@prionvault_bp.route("/api/articles/<uuid:aid>/summary", methods=["DELETE"])
@admin_required
def api_delete_summary(aid):
    """Clear the AI-generated summary so it can be regenerated cleanly."""
    s = _session()
    try:
        a = s.get(models.Article, aid)
        if not a:
            return jsonify({"error": "not found"}), 404
        a.summary_ai = None
        a.updated_at = datetime.utcnow()
        s.commit()
        return jsonify({"ok": True})
    finally:
        s.close()



# ── Chrome Extension download ─────────────────────────────────────────────────

@prionvault_bp.route("/extension/download")
@login_required
def download_extension():
    """Serve the prionvault-extension/ folder as a ZIP for Chrome installation."""
    ext_dir = os.path.join(os.path.dirname(__file__), "..", "..", "prionvault-extension")
    ext_dir = os.path.normpath(ext_dir)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _dirs, files in os.walk(ext_dir):
            for fname in files:
                fpath = os.path.join(root, fname)
                arcname = os.path.relpath(fpath, ext_dir)
                zf.write(fpath, arcname)
    buf.seek(0)
    return send_file(
        buf,
        mimetype="application/zip",
        as_attachment=True,
        download_name="prionvault-extension.zip",
    )
