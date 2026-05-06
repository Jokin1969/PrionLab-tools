"""PrionVault REST endpoints.

Phase 1 (this file): listing, detail, full-text search, tags read.
Admin-only stubs for ingest, write operations and semantic search return
501 (Not Implemented Yet) so the route table is final from day one and
the frontend can wire against it.
"""
import logging
from flask import jsonify, render_template, request, session
from sqlalchemy import or_, func, text as sql_text

from core.decorators import login_required, admin_required
from database.config import db
from . import prionvault_bp
from . import models

logger = logging.getLogger(__name__)


# ── Helpers ─────────────────────────────────────────────────────────────────
def _viewer_role():
    return session.get("role")


def _viewer_id():
    return session.get("user_id")


def _session():
    return db.Session()


# ── Index page ──────────────────────────────────────────────────────────────
@prionvault_bp.route("/")
@prionvault_bp.route("/index")
@login_required
def index():
    return render_template("prionvault/index.html")


# ── Listing & search ────────────────────────────────────────────────────────
@prionvault_bp.route("/api/articles", methods=["GET"])
@login_required
def api_list_articles():
    q          = (request.args.get("q") or "").strip()
    year_min   = request.args.get("year_min", type=int)
    year_max   = request.args.get("year_max", type=int)
    journal    = (request.args.get("journal") or "").strip()
    tag_id     = request.args.get("tag", type=int)
    has_summary = request.args.get("has_summary")
    sort       = request.args.get("sort", "added_desc")
    page       = max(1, request.args.get("page", 1, type=int))
    page_size  = min(100, max(1, request.args.get("size", 25, type=int)))

    s = _session()
    try:
        return _list_articles_impl(s, q, year_min, year_max, journal,
                                   tag_id, has_summary, sort, page, page_size)
    except Exception as exc:
        logger.exception("PrionVault api_list_articles failed")
        s.rollback()
        return jsonify({"error": "internal error", "detail": str(exc)}), 500
    finally:
        db.Session.remove()


def _list_articles_impl(s, q, year_min, year_max, journal,
                        tag_id, has_summary, sort, page, page_size):
    """Core of api_list_articles. Separated so the caller can cleanly catch
    all exceptions and still run the finally/remove."""

    # ── Detect which PrionVault columns exist (cached per process) ──────────
    pv_cols = _get_pv_columns(s)

    # ── Build WHERE clause using raw SQL to be resilient to missing cols ────
    conditions = []
    params: dict = {}

    if q:
        conditions.append(
            "search_vector @@ plainto_tsquery('simple', :q)"
            if "search_vector" in pv_cols
            else "(title ILIKE :q_like OR coalesce(abstract,'') ILIKE :q_like)"
        )
        params["q"] = q
        params["q_like"] = f"%{q}%"

    if year_min is not None:
        conditions.append("year >= :year_min")
        params["year_min"] = year_min
    if year_max is not None:
        conditions.append("year <= :year_max")
        params["year_max"] = year_max
    if journal:
        conditions.append("journal ILIKE :journal")
        params["journal"] = f"%{journal}%"

    if has_summary == "ai" and "summary_ai" in pv_cols:
        conditions.append("summary_ai IS NOT NULL")
    elif has_summary == "human" and "summary_human" in pv_cols:
        conditions.append("summary_human IS NOT NULL")
    elif has_summary == "none" and "summary_ai" in pv_cols:
        conditions.append("summary_ai IS NULL AND summary_human IS NULL")

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    sort_map = {
        "added_desc": "created_at DESC NULLS LAST",
        "added_asc":  "created_at ASC NULLS FIRST",
        "year_desc":  "year DESC NULLS LAST",
        "year_asc":   "year ASC NULLS FIRST",
        "title_asc":  "title ASC",
    }
    order = sort_map.get(sort, "created_at DESC NULLS LAST")

    # Build SELECT list: always include base columns; add pv cols if present.
    base_cols = "id, title, authors, year, journal, doi, pubmed_id, abstract, tags, is_milestone, priority, dropbox_path, dropbox_link, created_at, updated_at"
    pv_select = ", ".join(
        c for c in
        ["pdf_md5", "pdf_pages", "extraction_status", "indexed_at",
         "summary_ai", "summary_human", "source"]
        if c in pv_cols
    )
    select_cols = base_cols + (f", {pv_select}" if pv_select else "")

    if tag_id:
        from_clause = (
            "FROM articles "
            "JOIN article_tag_link ON article_tag_link.article_id = articles.id "
            "AND article_tag_link.tag_id = :tag_id"
        )
        params["tag_id"] = tag_id
    else:
        from_clause = "FROM articles"

    count_sql = sql_text(f"SELECT COUNT(*) {from_clause} {where}")
    total = s.execute(count_sql, params).scalar() or 0

    offset = (page - 1) * page_size
    params["limit"] = page_size
    params["offset"] = offset
    list_sql = sql_text(
        f"SELECT {select_cols} {from_clause} {where} ORDER BY {order} LIMIT :limit OFFSET :offset"
    )
    rows = s.execute(list_sql, params).all()
    col_names = list(rows[0]._fields) if rows else []

    # ── PrionRead counts (separate session) ─────────────────────────────────
    prionread_counts = {}
    if rows:
        try:
            import uuid as _uuid
            from sqlalchemy.orm import Session as _SASession
            item_ids = [_uuid.UUID(str(r[col_names.index("id")])) for r in rows]
            with _SASession(db.engine) as _s2:
                pr_rows = _s2.query(
                    models.UserArticleLink.article_id,
                    func.count(models.UserArticleLink.id)
                ).filter(
                    models.UserArticleLink.article_id.in_(item_ids)
                ).group_by(models.UserArticleLink.article_id).all()
                prionread_counts = {r[0]: r[1] for r in pr_rows}
        except Exception as exc:
            logger.warning("Could not query user_articles: %s", exc)

    role = _viewer_role()
    is_admin = (role == "admin")

    def _row_to_dict(r):
        d = dict(zip(col_names, r))
        aid = _uuid.UUID(str(d["id"]))
        in_pr = aid in prionread_counts
        out = {
            "id":            str(d["id"]),
            "title":         d.get("title") or "",
            "authors":       d.get("authors") or "",
            "journal":       d.get("journal"),
            "year":          d.get("year"),
            "doi":           d.get("doi"),
            "pubmed_id":     d.get("pubmed_id"),
            "tags_legacy":   d.get("tags") or [],
            "tags":          [],   # tag objects loaded separately if needed
            "priority":      d.get("priority"),
            "is_milestone":  d.get("is_milestone"),
            "pdf_pages":     d.get("pdf_pages"),
            "extraction_status": d.get("extraction_status") or "pending",
            "indexed_at":    d["indexed_at"].isoformat() if d.get("indexed_at") else None,
            "added_at":      d["created_at"].isoformat() if d.get("created_at") else None,
            "has_summary_ai":    bool(d.get("summary_ai")),
            "has_summary_human": False,
            "in_prionread":  in_pr,
            "prionread_count": prionread_counts.get(aid, 0),
        }
        if is_admin:
            out["pdf_md5"]          = d.get("pdf_md5")
            out["source"]           = d.get("source")
            out["pdf_dropbox_path"] = d.get("dropbox_path")
        return out

    import uuid as _uuid
    return jsonify({
        "items": [_row_to_dict(r) for r in rows],
        "total": total,
        "page":  page,
        "size":  page_size,
    })


_pv_columns_cache: set | None = None

def _get_pv_columns(s) -> set:
    """Return the set of column names that exist in `articles`. Cached."""
    global _pv_columns_cache
    if _pv_columns_cache is not None:
        return _pv_columns_cache
    try:
        rows = s.execute(sql_text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'articles'"
        )).all()
        _pv_columns_cache = {r[0] for r in rows}
    except Exception as exc:
        logger.warning("Could not introspect articles columns: %s", exc)
        _pv_columns_cache = set()
    return _pv_columns_cache


@prionvault_bp.route("/api/articles/<uuid:aid>", methods=["GET"])
@login_required
def api_article_detail(aid):
    s = _session()
    try:
        pv_cols = _get_pv_columns(s)

        # Build SELECT list dynamically so missing migration columns don't 500.
        base_cols = (
            "id, title, authors, year, journal, doi, pubmed_id, abstract, "
            "tags, is_milestone, priority, dropbox_path, dropbox_link, "
            "created_at, updated_at"
        )
        optional = [
            "pdf_md5", "pdf_size_bytes", "pdf_pages",
            "extraction_status", "extraction_error",
            "summary_ai", "summary_human",
            "indexed_at", "index_version",
            "source", "source_metadata", "added_by_id",
        ]
        pv_select = ", ".join(c for c in optional if c in pv_cols)
        select_cols = base_cols + (f", {pv_select}" if pv_select else "")

        row = s.execute(
            sql_text(f"SELECT {select_cols} FROM articles WHERE id = :aid"),
            {"aid": str(aid)},
        ).first()

        if row is None:
            return jsonify({"error": "not found"}), 404

        d = dict(zip(row._fields, row))
        role = _viewer_role()
        is_admin = (role == "admin")

        out = {
            "id":            str(d["id"]),
            "title":         d.get("title") or "",
            "authors":       d.get("authors") or "",
            "journal":       d.get("journal"),
            "year":          d.get("year"),
            "doi":           d.get("doi"),
            "pubmed_id":     d.get("pubmed_id"),
            "tags_legacy":   d.get("tags") or [],
            "tags":          [],
            "priority":      d.get("priority"),
            "is_milestone":  d.get("is_milestone"),
            "pdf_pages":     d.get("pdf_pages"),
            "extraction_status": d.get("extraction_status") or "pending",
            "extraction_error":  d.get("extraction_error"),
            "indexed_at":    d["indexed_at"].isoformat() if d.get("indexed_at") else None,
            "added_at":      d["created_at"].isoformat() if d.get("created_at") else None,
            "abstract":      d.get("abstract"),
            "summary_ai":    d.get("summary_ai"),
            "summary_human": d.get("summary_human"),
            "has_summary_ai":    bool(d.get("summary_ai")),
            "has_summary_human": bool(d.get("summary_human")),
            "in_prionread":  False,  # enriched below
        }
        if is_admin:
            out["pdf_md5"]          = d.get("pdf_md5")
            out["pdf_size_bytes"]   = d.get("pdf_size_bytes")
            out["source"]           = d.get("source")
            out["pdf_dropbox_path"] = d.get("dropbox_path")

        # Tags (use separate session to avoid contaminating main one)
        try:
            from sqlalchemy.orm import Session as _SASession
            with _SASession(db.engine) as _s2:
                tag_rows = _s2.execute(sql_text(
                    "SELECT t.id, t.name, t.color "
                    "FROM article_tag t "
                    "JOIN article_tag_link l ON l.tag_id = t.id "
                    "WHERE l.article_id = :aid"
                ), {"aid": str(aid)}).all()
                out["tags"] = [{"id": r.id, "name": r.name, "color": r.color}
                               for r in tag_rows]
        except Exception as exc:
            logger.warning("Could not load tags for article %s: %s", aid, exc)

        # PrionRead membership
        try:
            from sqlalchemy.orm import Session as _SASession
            with _SASession(db.engine) as _s2:
                pr_count = _s2.execute(sql_text(
                    "SELECT COUNT(*) FROM user_articles WHERE article_id = :aid"
                ), {"aid": str(aid)}).scalar() or 0
                out["in_prionread"] = pr_count > 0
                out["prionread_count"] = pr_count
        except Exception as exc:
            logger.warning("Could not query user_articles for article %s: %s", aid, exc)

        # Visible annotations: own + published-by-others; admin sees all.
        viewer_id = _viewer_id()
        try:
            ann_q = s.query(models.ArticleAnnotation).filter_by(article_id=aid)
            if not is_admin:
                ann_q = ann_q.filter(or_(
                    models.ArticleAnnotation.user_id == viewer_id,
                    models.ArticleAnnotation.is_published.is_(True),
                ))
            out["annotations"] = [ann.to_dict(viewer_user_id=viewer_id)
                                  for ann in ann_q.order_by(models.ArticleAnnotation.created_at).all()]
        except Exception as exc:
            logger.warning("Could not load annotations for article %s: %s", aid, exc)
            out["annotations"] = []

        return jsonify(out)
    except Exception as exc:
        logger.exception("PrionVault api_article_detail failed")
        s.rollback()
        return jsonify({"error": "internal error", "detail": str(exc)}), 500
    finally:
        db.Session.remove()


@prionvault_bp.route("/api/articles/stats", methods=["GET"])
@login_required
def api_article_stats():
    """Aggregate counts for the sidebar facets."""
    s = _session()
    try:
        # Try the full query first (requires migration 001 columns).
        try:
            row = s.execute(sql_text("""
                SELECT
                  COUNT(*)                                       AS total,
                  COUNT(*) FILTER (WHERE summary_ai IS NOT NULL) AS with_summary_ai,
                  COUNT(*) FILTER (WHERE extraction_status = 'extracted') AS with_extraction,
                  COUNT(*) FILTER (WHERE indexed_at IS NOT NULL) AS indexed
                FROM articles
            """)).first()
            return jsonify({
                "total":           row[0] if row else 0,
                "with_summary_ai": row[1] if row else 0,
                "with_extraction": row[2] if row else 0,
                "indexed":         row[3] if row else 0,
            })
        except Exception as col_exc:
            # Migration 001 columns not yet present — fall back to simple count.
            logger.warning("PrionVault stats full query failed (%s), falling back", col_exc)
            s.rollback()
            row = s.execute(sql_text("SELECT COUNT(*) FROM articles")).first()
            return jsonify({
                "total": row[0] if row else 0,
                "with_summary_ai": 0,
                "with_extraction": 0,
                "indexed": 0,
                "_migration_pending": True,
            })
    except Exception as exc:
        logger.exception("PrionVault api_article_stats failed")
        s.rollback()
        return jsonify({"error": "internal error", "detail": str(exc)}), 500
    finally:
        db.Session.remove()


# ── Tags (read available to all, write admin-only) ──────────────────────────
@prionvault_bp.route("/api/tags", methods=["GET"])
@login_required
def api_list_tags():
    s = _session()
    try:
        # Tag list with article counts
        rows = s.execute(sql_text(
            """
            SELECT t.id, t.name, t.color, count(l.article_id) AS n_articles
            FROM article_tag t
            LEFT JOIN article_tag_link l ON l.tag_id = t.id
            GROUP BY t.id
            ORDER BY t.name
            """
        )).all()
        return jsonify([
            {"id": r.id, "name": r.name, "color": r.color, "count": r.n_articles}
            for r in rows
        ])
    finally:
        s.close()


@prionvault_bp.route("/api/tags", methods=["POST"])
@admin_required
def api_create_tag():
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip()
    color = (data.get("color") or "").strip() or None
    if not name:
        return jsonify({"error": "name required"}), 400
    s = _session()
    try:
        t = models.ArticleTag(name=name, color=color)
        s.add(t)
        s.commit()
        return jsonify(t.to_dict()), 201
    except Exception as e:
        s.rollback()
        return jsonify({"error": str(e)}), 400
    finally:
        s.close()


@prionvault_bp.route("/api/articles/<uuid:aid>/tags/<int:tag_id>", methods=["PUT"])
@admin_required
def api_attach_tag(aid, tag_id):
    s = _session()
    try:
        a = s.get(models.Article, aid)
        if not a:
            return jsonify({"error": "article not found"}), 404
        t = s.get(models.ArticleTag, tag_id)
        if not t:
            return jsonify({"error": "tag not found"}), 404
        existing = s.query(models.ArticleTagLink).get((aid, tag_id))
        if not existing:
            link = models.ArticleTagLink(article_id=aid, tag_id=tag_id,
                                         added_by=_viewer_id())
            s.add(link)
            s.commit()
        return jsonify({"ok": True})
    finally:
        s.close()


@prionvault_bp.route("/api/articles/<uuid:aid>/tags/<int:tag_id>", methods=["DELETE"])
@admin_required
def api_detach_tag(aid, tag_id):
    s = _session()
    try:
        link = s.query(models.ArticleTagLink).get((aid, tag_id))
        if link:
            s.delete(link)
            s.commit()
        return jsonify({"ok": True})
    finally:
        s.close()


# ── Annotations (CRUD, multi-user) ──────────────────────────────────────────
@prionvault_bp.route("/api/articles/<uuid:aid>/annotations", methods=["POST"])
@login_required
def api_add_annotation(aid):
    data = request.get_json(force=True, silent=True) or {}
    body = (data.get("body") or "").strip()
    if not body:
        return jsonify({"error": "body required"}), 400
    s = _session()
    try:
        ann = models.ArticleAnnotation(
            article_id=aid,
            user_id=_viewer_id(),
            page=data.get("page"),
            body=body,
            is_published=bool(data.get("is_published") and _viewer_role() == "admin"),
        )
        s.add(ann)
        s.commit()
        return jsonify(ann.to_dict(viewer_user_id=_viewer_id())), 201
    finally:
        s.close()


@prionvault_bp.route("/api/annotations/<int:ann_id>", methods=["DELETE"])
@login_required
def api_delete_annotation(ann_id):
    s = _session()
    try:
        ann = s.get(models.ArticleAnnotation, ann_id)
        if not ann:
            return jsonify({"error": "not found"}), 404
        # Only the owner or an admin can delete.
        if str(ann.user_id) != str(_viewer_id()) and _viewer_role() != "admin":
            return jsonify({"error": "forbidden"}), 403
        s.delete(ann)
        s.commit()
        return jsonify({"ok": True})
    finally:
        s.close()


# ── Send to PrionRead ────────────────────────────────────────────────────────
@prionvault_bp.route("/api/articles/<uuid:aid>/send-to-prionread", methods=["POST"])
@login_required
def api_send_to_prionread(aid):
    """Create a user_articles row so the article appears in PrionRead."""
    user_id = _viewer_id()
    if not user_id:
        return jsonify({"error": "not authenticated"}), 401
    s = _session()
    try:
        a = s.get(models.Article, aid)
        if not a:
            return jsonify({"error": "not found"}), 404
        existing = s.query(models.UserArticleLink).filter_by(
            user_id=user_id, article_id=aid
        ).first()
        if existing:
            return jsonify({"ok": True, "in_prionread": True})
        import uuid as _uuid
        link = models.UserArticleLink(
            id=_uuid.uuid4(),
            user_id=user_id,
            article_id=aid,
            status="pending",
        )
        s.add(link)
        s.commit()
        return jsonify({"ok": True, "in_prionread": True})
    finally:
        s.close()


@prionvault_bp.route("/api/articles/<uuid:aid>/send-to-prionread", methods=["DELETE"])
@admin_required
def api_remove_from_prionread(aid):
    """Remove ALL user_articles rows for this article (admin only)."""
    s = _session()
    try:
        count = s.query(models.UserArticleLink).filter_by(article_id=aid).count()
        s.query(models.UserArticleLink).filter_by(article_id=aid).delete()
        s.commit()
        logger.info("Removed article %s from PrionRead (%d user rows deleted)", aid, count)
        return jsonify({"ok": True, "in_prionread": False, "removed_count": count})
    finally:
        s.close()


# ── Admin write endpoints (article metadata) ────────────────────────────────
_EDITABLE_FIELDS = {
    "title", "authors", "year", "journal", "doi", "pubmed_id",
    "abstract", "summary_ai", "summary_human", "is_milestone", "priority",
}


@prionvault_bp.route("/api/articles/<uuid:aid>", methods=["PATCH"])
@admin_required
def api_article_update(aid):
    data = request.get_json(force=True, silent=True) or {}
    updates = {k: v for k, v in data.items() if k in _EDITABLE_FIELDS}
    if not updates:
        return jsonify({"error": "no editable fields in payload"}), 400
    s = _session()
    try:
        a = s.get(models.Article, aid)
        if not a:
            return jsonify({"error": "not found"}), 404
        for k, v in updates.items():
            setattr(a, k, v)
        s.commit()
        return jsonify(a.to_dict(include_text=True, viewer_role="admin"))
    finally:
        s.close()


@prionvault_bp.route("/api/articles/<uuid:aid>", methods=["DELETE"])
@admin_required
def api_article_delete(aid):
    """Delete the row only — does NOT remove the PDF from Dropbox.
    A separate `?purge=1` flag will be added when the Dropbox cleanup
    pipeline is wired up.
    """
    s = _session()
    try:
        a = s.get(models.Article, aid)
        if not a:
            return jsonify({"error": "not found"}), 404
        s.delete(a)
        s.commit()
        return jsonify({"ok": True})
    finally:
        s.close()


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
    """List jobs filtered by status (full-page admin view)."""
    from .ingestion import queue as ingest_queue
    status = request.args.get("status")
    limit  = max(1, min(500, request.args.get("limit", 100, type=int)))
    return jsonify({"items": ingest_queue.list_jobs(status=status, limit=limit)})


@prionvault_bp.route("/api/ingest/retry/<int:job_id>", methods=["POST"])
@admin_required
def api_ingest_retry(job_id):
    from .ingestion import queue as ingest_queue
    if ingest_queue.retry(job_id):
        return jsonify({"ok": True})
    return jsonify({"error": "job not found or not in failed/duplicate state"}), 400


@prionvault_bp.route("/api/articles/<uuid:aid>/summary", methods=["POST"])
@admin_required
def api_generate_summary(aid):
    """Stub. Wired up in Phase 3-4 once the summary pipeline lands."""
    return jsonify({"error": "not_implemented_yet"}), 501


@prionvault_bp.route("/api/search/semantic", methods=["POST"])
@login_required
def api_semantic_search():
    """Stub. Wired up in Phase 5 with pgvector + Voyage + Claude."""
    return jsonify({"error": "not_implemented_yet"}), 501


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
    return jsonify(summary)


@prionvault_bp.route("/api/admin/migrations/force-rerun", methods=["POST"])
@admin_required
def api_migrations_force_rerun():
    """Delete the applied_migrations tracking rows and re-run all migrations.

    Use this when a migration was recorded as applied but some statements
    actually failed (e.g. CREATE EXTENSION needs superuser). All statements
    use IF NOT EXISTS guards so re-running is safe.
    """
    from .migrate import run_pending_migrations
    from sqlalchemy import text as _text
    try:
        with db.engine.begin() as conn:
            conn.execute(_text(
                "DELETE FROM applied_migrations WHERE name = ANY(:names)"
            ), {"names": ["001_prionvault_tables.sql", "003_fix_step_column.sql"]})
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


# ── Sync status: PrionVault ↔ PrionRead comparison ──────────────────────────
@prionvault_bp.route("/api/admin/sync/status", methods=["GET"])
@admin_required
def api_admin_sync_status():
    """Return articles categorised by presence in PrionVault and PrionRead.

    Categories:
    - in_both:            has PrionVault ingestion data AND user_articles rows
    - only_in_prionvault: has PrionVault data but no user_articles
    - only_in_prionread:  has user_articles but no PrionVault ingestion data
    - in_neither:         exists in articles table but neither above
    """
    s = _session()
    try:
        pv_cols = _get_pv_columns(s)
        has_pv = "pdf_md5" in pv_cols or "extraction_status" in pv_cols

        pv_parts = []
        if "pdf_md5" in pv_cols:
            pv_parts.append("a.pdf_md5 IS NOT NULL")
        if "extraction_status" in pv_cols:
            pv_parts.append("a.extraction_status IS NOT NULL AND a.extraction_status != 'pending'")
        pv_expr = "(" + " OR ".join(pv_parts) + ")" if pv_parts else "FALSE"

        # Select base fields + computed flags
        sql = sql_text(f"""
            SELECT
                a.id::text,
                a.title,
                a.authors,
                a.year,
                a.journal,
                a.doi,
                a.pubmed_id,
                a.tags,
                a.is_milestone,
                a.priority,
                a.dropbox_path,
                a.created_at,
                ({pv_expr}) AS in_prionvault,
                EXISTS (SELECT 1 FROM user_articles ua WHERE ua.article_id = a.id) AS in_prionread,
                (SELECT COUNT(*)::int FROM user_articles ua WHERE ua.article_id = a.id) AS student_count
            FROM articles a
            ORDER BY a.created_at DESC
        """)
        rows = s.execute(sql).all()
        fields = list(rows[0]._fields) if rows else []

        def _to_dict(r):
            d = dict(zip(fields, r))
            d["created_at"] = d["created_at"].isoformat() if d.get("created_at") else None
            d["tags"] = d.get("tags") or []
            return d

        all_rows = [_to_dict(r) for r in rows]

        in_both            = [r for r in all_rows if r["in_prionvault"] and r["in_prionread"]]
        only_in_prionvault = [r for r in all_rows if r["in_prionvault"] and not r["in_prionread"]]
        only_in_prionread  = [r for r in all_rows if not r["in_prionvault"] and r["in_prionread"]]
        in_neither         = [r for r in all_rows if not r["in_prionvault"] and not r["in_prionread"]]

        return jsonify({
            "has_prionvault_columns": has_pv,
            "summary": {
                "total":               len(all_rows),
                "in_both":             len(in_both),
                "only_in_prionvault":  len(only_in_prionvault),
                "only_in_prionread":   len(only_in_prionread),
                "in_neither":          len(in_neither),
            },
            "articles": {
                "in_both":             in_both,
                "only_in_prionvault":  only_in_prionvault,
                "only_in_prionread":   only_in_prionread,
                "in_neither":          in_neither,
            },
        })
    except Exception as exc:
        logger.exception("api_admin_sync_status failed")
        s.rollback()
        return jsonify({"error": "internal error", "detail": str(exc)}), 500
    finally:
        db.Session.remove()
