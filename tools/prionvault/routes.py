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
        Article = models.Article
        query = s.query(Article)

        # Full-text search (uses the GIN index on search_vector)
        if q:
            ts_query = func.plainto_tsquery("simple", q)
            query = query.filter(Article.search_vector.op("@@")(ts_query))

        if year_min is not None:
            query = query.filter(Article.year >= year_min)
        if year_max is not None:
            query = query.filter(Article.year <= year_max)
        if journal:
            query = query.filter(Article.journal.ilike(f"%{journal}%"))
        if tag_id:
            query = (query.join(models.ArticleTagLink,
                                models.ArticleTagLink.article_id == Article.id)
                          .filter(models.ArticleTagLink.tag_id == tag_id))
        if has_summary == "ai":
            query = query.filter(Article.summary_ai.isnot(None))
        elif has_summary == "human":
            query = query.filter(Article.summary_human.isnot(None))
        elif has_summary == "none":
            query = query.filter(Article.summary_ai.is_(None),
                                 Article.summary_human.is_(None))

        # Sorting
        order_map = {
            "added_desc":   Article.created_at.desc(),
            "added_asc":    Article.created_at.asc(),
            "year_desc":    Article.year.desc().nullslast(),
            "year_asc":     Article.year.asc().nullsfirst(),
            "title_asc":    Article.title.asc(),
        }
        query = query.order_by(order_map.get(sort, Article.created_at.desc()))

        total = query.count()
        items = query.offset((page - 1) * page_size).limit(page_size).all()

        return jsonify({
            "items":    [a.to_dict(viewer_role=_viewer_role()) for a in items],
            "total":    total,
            "page":     page,
            "size":     page_size,
        })
    finally:
        s.close()


@prionvault_bp.route("/api/articles/<uuid:aid>", methods=["GET"])
@login_required
def api_article_detail(aid):
    s = _session()
    try:
        a = s.get(models.Article, aid)
        if a is None:
            return jsonify({"error": "not found"}), 404
        out = a.to_dict(include_text=True, include_extracted=False,
                        viewer_role=_viewer_role())

        # Visible annotations: own + published-by-others; admin sees all.
        viewer_id = _viewer_id()
        ann_q = s.query(models.ArticleAnnotation).filter_by(article_id=aid)
        if _viewer_role() != "admin":
            ann_q = ann_q.filter(or_(
                models.ArticleAnnotation.user_id == viewer_id,
                models.ArticleAnnotation.is_published.is_(True),
            ))
        out["annotations"] = [ann.to_dict(viewer_user_id=viewer_id)
                              for ann in ann_q.order_by(models.ArticleAnnotation.created_at).all()]
        return jsonify(out)
    finally:
        s.close()


@prionvault_bp.route("/api/articles/stats", methods=["GET"])
@login_required
def api_article_stats():
    """Aggregate counts for the sidebar facets."""
    s = _session()
    try:
        Article = models.Article
        total            = s.query(func.count(Article.id)).scalar() or 0
        with_summary_ai  = s.query(func.count(Article.id))\
                            .filter(Article.summary_ai.isnot(None)).scalar() or 0
        with_extraction  = s.query(func.count(Article.id))\
                            .filter(Article.extraction_status == "extracted").scalar() or 0
        indexed          = s.query(func.count(Article.id))\
                            .filter(Article.indexed_at.isnot(None)).scalar() or 0
        return jsonify({
            "total":           total,
            "with_summary_ai": with_summary_ai,
            "with_extraction": with_extraction,
            "indexed":         indexed,
        })
    finally:
        s.close()


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


# ── Stubs reserved for upcoming phases ──────────────────────────────────────
@prionvault_bp.route("/api/ingest/upload", methods=["POST"])
@admin_required
def api_ingest_upload():
    """Stub. Wired up in Phase 2 (bulk PDF ingestion)."""
    return jsonify({"error": "not_implemented_yet"}), 501


@prionvault_bp.route("/api/ingest/status", methods=["GET"])
@admin_required
def api_ingest_status():
    """Stub. Returns the queue snapshot once the ingest worker is live."""
    return jsonify({"queued": 0, "processing": 0, "done": 0,
                    "failed": 0, "duplicate": 0, "recent": []})


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
