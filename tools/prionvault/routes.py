"""PrionVault REST endpoints.

Phase 1 (this file): listing, detail, full-text search, tags read.
Admin-only stubs for ingest, write operations and semantic search return
501 (Not Implemented Yet) so the route table is final from day one and
the frontend can wire against it.
"""
import logging
import re
from datetime import datetime
from flask import jsonify, render_template, request, session, Response
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
    uid = session.get("user_id")
    if uid:
        return uid
    # Backwards-compat: sessions opened before user_id was added at
    # login still have a valid username. Resolve it lazily once and
    # cache in the session so we don't re-query on every request.
    uname = session.get("username")
    if not uname:
        return None
    try:
        from core.auth import _lookup_db_user_id
        uid = _lookup_db_user_id(uname)
    except Exception:
        return None
    if uid:
        session["user_id"] = uid
    return uid


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
    q           = (request.args.get("q") or "").strip()
    year_min    = request.args.get("year_min", type=int)
    year_max    = request.args.get("year_max", type=int)
    journal     = (request.args.get("journal") or "").strip()
    authors_q   = (request.args.get("authors") or "").strip()
    tag_id      = request.args.get("tag", type=int)
    collection_id    = (request.args.get("collection") or "").strip() or None
    collection_group    = (request.args.get("collection_group") or "").strip() or None
    collection_subgroup = (request.args.get("collection_subgroup") or "").strip() or None
    has_summary = request.args.get("has_summary")
    in_prionread_raw = request.args.get("in_prionread")
    in_prionread = True if in_prionread_raw == "1" else (False if in_prionread_raw == "0" else None)
    is_flagged_raw   = request.args.get("is_flagged")
    is_flagged       = True if is_flagged_raw == "1" else (False if is_flagged_raw == "0" else None)
    is_milestone_raw = request.args.get("is_milestone")
    is_milestone     = True if is_milestone_raw == "1" else (False if is_milestone_raw == "0" else None)
    has_jc_raw       = request.args.get("has_jc")
    has_jc           = True if has_jc_raw == "1" else (False if has_jc_raw == "0" else None)
    jc_presenter     = (request.args.get("jc_presenter") or "").strip() or None
    jc_year          = request.args.get("jc_year", type=int)
    has_pp_raw       = request.args.get("has_pp")
    has_pp           = True if has_pp_raw == "1" else (False if has_pp_raw == "0" else None)
    pp_id            = (request.args.get("pp_id") or "").strip() or None
    color_label = (request.args.get("color_label") or "").strip().lower() or None
    priority_eq = request.args.get("priority_eq", type=int)
    extraction = (request.args.get("extraction_status") or "").strip().lower() or None
    is_favorite_raw = request.args.get("is_favorite")
    is_favorite = True if is_favorite_raw == "1" else (False if is_favorite_raw == "0" else None)
    is_read_raw = request.args.get("is_read")
    is_read = True if is_read_raw == "1" else (False if is_read_raw == "0" else None)
    sort        = request.args.get("sort", "added_desc")
    page        = max(1, request.args.get("page", 1, type=int))
    page_size   = min(50000, max(1, request.args.get("size", 100, type=int)))

    # When the caller filters by a SMART collection, the membership is
    # not stored anywhere — it's computed by merging the saved rules
    # into the active filter set. The URL-driven filter still wins
    # whenever the user explicitly sets the same field (so the user can
    # narrow a smart collection further from the toolbar).
    if collection_id:
        try:
            from .services import collections as _coll
            c = _coll.get(collection_id)
        except Exception:
            c = None
        if c and c["kind"] == "smart":
            merged = _coll.merge_rules_into_filters(c.get("rules") or {}, {
                "q": q, "authors": authors_q, "journal": journal,
                "year_min": year_min, "year_max": year_max,
                "tag": tag_id, "priority_eq": priority_eq,
                "color_label": color_label, "has_summary": has_summary,
                "extraction_status": extraction,
                "is_flagged": is_flagged, "is_milestone": is_milestone,
                "in_prionread": in_prionread,
                "is_favorite": is_favorite, "is_read": is_read,
            })
            q          = merged.get("q") or ""
            authors_q  = merged.get("authors") or ""
            journal    = merged.get("journal") or ""
            year_min   = merged.get("year_min")
            year_max   = merged.get("year_max")
            tag_id     = merged.get("tag")
            priority_eq = merged.get("priority_eq")
            color_label = merged.get("color_label")
            has_summary = merged.get("has_summary")
            extraction  = merged.get("extraction_status")
            is_flagged   = merged.get("is_flagged")
            is_milestone = merged.get("is_milestone")
            in_prionread = merged.get("in_prionread")
            is_favorite  = merged.get("is_favorite")
            is_read      = merged.get("is_read")
            collection_id = None   # do NOT join the link table

    s = _session()
    try:
        return _list_articles_impl(s, q, year_min, year_max, journal,
                                   authors_q,
                                   tag_id, has_summary, in_prionread,
                                   is_flagged, is_milestone, color_label,
                                   priority_eq, extraction,
                                   is_favorite, is_read,
                                   sort, page, page_size,
                                   collection_id=collection_id,
                                   collection_group=collection_group,
                                   collection_subgroup=collection_subgroup,
                                   has_jc=has_jc,
                                   jc_presenter=jc_presenter,
                                   jc_year=jc_year,
                                   has_pp=has_pp,
                                   pp_id=pp_id)
    except Exception as exc:
        logger.exception("PrionVault api_list_articles failed")
        s.rollback()
        return jsonify({"error": "internal error", "detail": str(exc)}), 500
    finally:
        db.Session.remove()


_VALID_COLOR_LABELS = {"red", "orange", "yellow", "green", "blue", "purple"}


# ── PrionPacks DOI index ────────────────────────────────────────────────────
# Articles are linked to packs implicitly: a pack's `references` /
# `introReferences` are free-text strings that contain a DOI. We extract
# the DOIs once per request and build a two-way map for filtering and for
# per-article badges in the listing.

_DOI_RE = re.compile(r"10\.\d{4,}/[^\s'\";,)>\]]+", re.IGNORECASE)


def _extract_dois(ref: str) -> list[str]:
    if not isinstance(ref, str):
        return []
    return [m.group(0).rstrip(".,;").lower() for m in _DOI_RE.finditer(ref)]


def _prionpacks_doi_index() -> tuple[dict, dict]:
    """Returns ({pack_id: pack_title}, {doi_lower: [pack_id, ...]}).
    Empty maps if the prionpacks module fails to load (best effort)."""
    titles: dict[str, str] = {}
    doi_to_packs: dict[str, list[str]] = {}
    try:
        from tools.prionpacks import models as pp_models
        for pkg in pp_models.list_packages():
            if not pkg.get("active", True):
                continue
            pid = pkg.get("id")
            if not pid:
                continue
            titles[pid] = pkg.get("title") or pid
            for ref in (pkg.get("references") or []) + (pkg.get("introReferences") or []):
                for doi in _extract_dois(ref):
                    bucket = doi_to_packs.setdefault(doi, [])
                    if pid not in bucket:
                        bucket.append(pid)
    except Exception as exc:
        logger.warning("prionpacks DOI index failed: %s", exc)
    return titles, doi_to_packs


@prionvault_bp.route("/api/prionpacks", methods=["GET"])
@login_required
def api_prionpacks_list():
    """Minimal pack list used by the article-listing filter dropdown."""
    titles, _ = _prionpacks_doi_index()
    items = [{"id": pid, "title": t} for pid, t in titles.items()]
    items.sort(key=lambda x: x["id"])
    return jsonify({"items": items})


def _list_articles_impl(s, q, year_min, year_max, journal,
                        authors_q,
                        tag_id, has_summary, in_prionread,
                        is_flagged, is_milestone, color_label,
                        priority_eq, extraction,
                        is_favorite, is_read,
                        sort, page, page_size,
                        *, collection_id=None,
                        collection_group=None, collection_subgroup=None,
                        has_jc=None, jc_presenter=None, jc_year=None,
                        has_pp=None, pp_id=None):
    """Core of api_list_articles. Separated so the caller can cleanly catch
    all exceptions and still run the finally/remove."""

    # ── Detect which PrionVault columns exist (cached per process) ──────────
    pv_cols = _get_pv_columns(s)

    # ── Build WHERE clause using raw SQL to be resilient to missing cols ────
    conditions = []
    params: dict = {}

    if q:
        # websearch_to_tsquery (Postgres >= 11) gives the user a
        # Google-like syntax for free:
        #   "prion protein"   — exact phrase
        #   BSE -review       — BSE without "review"
        #   Castilla OR Soto  — either author
        #   Castilla BSE      — both (default AND between bare terms)
        # plainto_tsquery is kept as a fallback for clusters where
        # websearch is unavailable (very old Postgres).
        conditions.append(
            "search_vector @@ websearch_to_tsquery('simple', :q)"
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
    if authors_q:
        # Search only the authors column so "Castilla" never matches
        # "Castilla-La Mancha" in the body / summary.
        conditions.append("coalesce(authors,'') ILIKE :authors_q")
        params["authors_q"] = f"%{authors_q}%"

    if has_summary == "ai" and "summary_ai" in pv_cols:
        conditions.append("summary_ai IS NOT NULL")
    elif has_summary == "human" and "summary_human" in pv_cols:
        conditions.append("summary_human IS NOT NULL")
    elif has_summary == "none" and "summary_ai" in pv_cols:
        conditions.append("summary_ai IS NULL AND summary_human IS NULL")

    if in_prionread is True:
        conditions.append(
            "EXISTS (SELECT 1 FROM user_articles ua WHERE ua.article_id = articles.id)"
        )
    elif in_prionread is False:
        conditions.append(
            "NOT EXISTS (SELECT 1 FROM user_articles ua WHERE ua.article_id = articles.id)"
        )

    if is_flagged is True:
        conditions.append("is_flagged IS TRUE")
    elif is_flagged is False:
        conditions.append("(is_flagged IS FALSE OR is_flagged IS NULL)")

    if is_milestone is True:
        conditions.append("is_milestone IS TRUE")
    elif is_milestone is False:
        conditions.append("(is_milestone IS FALSE OR is_milestone IS NULL)")

    # Journal-Club filters — single semi-join against
    # prionvault_jc_presentation rather than a JOIN to avoid row
    # duplication when an article has more than one presentation.
    if has_jc is True:
        conditions.append(
            "EXISTS (SELECT 1 FROM prionvault_jc_presentation jp "
            "WHERE jp.article_id = articles.id)"
        )
    elif has_jc is False:
        conditions.append(
            "NOT EXISTS (SELECT 1 FROM prionvault_jc_presentation jp "
            "WHERE jp.article_id = articles.id)"
        )
    if jc_presenter:
        conditions.append(
            "EXISTS (SELECT 1 FROM prionvault_jc_presentation jp "
            "WHERE jp.article_id = articles.id "
            "AND lower(jp.presenter_name) LIKE :jc_presenter)"
        )
        params["jc_presenter"] = f"%{jc_presenter.lower()}%"
    if jc_year is not None:
        conditions.append(
            "EXISTS (SELECT 1 FROM prionvault_jc_presentation jp "
            "WHERE jp.article_id = articles.id "
            "AND EXTRACT(YEAR FROM jp.presented_at) = :jc_year)"
        )
        params["jc_year"] = jc_year

    # ── PrionPacks: filter and attach per-article. The DOI index is built
    # once per request so we can also decorate every returned row with the
    # list of packs it belongs to (used by the listing badges).
    pp_titles, pp_doi_to_packs = _prionpacks_doi_index()
    if pp_id:
        scoped_dois = [d for d, packs in pp_doi_to_packs.items() if pp_id in packs]
        conditions.append("lower(doi) = ANY(:pp_scoped_dois)")
        params["pp_scoped_dois"] = scoped_dois or [""]   # empty list breaks ANY
    elif has_pp is True:
        all_pp_dois = list(pp_doi_to_packs.keys())
        conditions.append("lower(doi) = ANY(:pp_all_dois)")
        params["pp_all_dois"] = all_pp_dois or [""]
    elif has_pp is False:
        all_pp_dois = list(pp_doi_to_packs.keys())
        if all_pp_dois:
            conditions.append("(doi IS NULL OR lower(doi) <> ALL(:pp_all_dois))")
            params["pp_all_dois"] = all_pp_dois
        # If there are no PrionPacks at all, "sin PrionPack" matches everything → no filter.

    if color_label in _VALID_COLOR_LABELS:
        conditions.append("color_label = :color_label")
        params["color_label"] = color_label
    elif color_label == "none":
        conditions.append("color_label IS NULL")

    if priority_eq is not None:
        conditions.append("priority = :priority_eq")
        params["priority_eq"] = priority_eq

    if extraction and "extraction_status" in pv_cols:
        if extraction == "extracted":
            conditions.append("extraction_status = 'extracted'")
        elif extraction == "pending":
            conditions.append("(extraction_status IS NULL OR extraction_status = 'pending')")
        elif extraction == "failed":
            conditions.append("extraction_status = 'failed'")

    _viewer_uid = _viewer_id()
    if _viewer_uid and (is_favorite is not None or is_read is not None):
        params["_viewer_uid"] = str(_viewer_uid)
        if is_favorite is True:
            conditions.append(
                "EXISTS (SELECT 1 FROM prionvault_user_state s "
                "WHERE s.article_id = articles.id "
                "AND s.user_id = :_viewer_uid AND s.is_favorite IS TRUE)"
            )
        elif is_favorite is False:
            conditions.append(
                "NOT EXISTS (SELECT 1 FROM prionvault_user_state s "
                "WHERE s.article_id = articles.id "
                "AND s.user_id = :_viewer_uid AND s.is_favorite IS TRUE)"
            )
        if is_read is True:
            conditions.append(
                "EXISTS (SELECT 1 FROM prionvault_user_state s "
                "WHERE s.article_id = articles.id "
                "AND s.user_id = :_viewer_uid AND s.read_at IS NOT NULL)"
            )
        elif is_read is False:
            conditions.append(
                "NOT EXISTS (SELECT 1 FROM prionvault_user_state s "
                "WHERE s.article_id = articles.id "
                "AND s.user_id = :_viewer_uid AND s.read_at IS NOT NULL)"
            )

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
    base_cols = ("id, title, authors, year, journal, doi, pubmed_id, abstract, "
                 "tags, is_milestone, is_flagged, color_label, priority, "
                 "dropbox_path, dropbox_link, created_at, updated_at, "
                 "(SELECT COUNT(*) FROM prionvault_jc_presentation jp "
                 " WHERE jp.article_id = articles.id) AS jc_count")
    pv_select = ", ".join(
        c for c in
        ["pdf_md5", "pdf_pages", "pdf_is_scan",
         "extraction_status", "indexed_at",
         "summary_ai", "summary_human", "source"]
        if c in pv_cols
    )
    select_cols = base_cols + (f", {pv_select}" if pv_select else "")

    join_parts = ["FROM articles"]
    if tag_id:
        join_parts.append(
            "JOIN article_tag_link ON article_tag_link.article_id = articles.id "
            "AND article_tag_link.tag_id = :tag_id"
        )
        params["tag_id"] = tag_id
    # Manual collection membership join — smart collections are
    # resolved by injecting their rules into the filter set in the
    # endpoint layer, not here.
    if collection_id:
        join_parts.append(
            "JOIN prionvault_collection_article pca "
            "  ON pca.article_id = articles.id "
            " AND pca.collection_id = CAST(:collection_id AS uuid)"
        )
        params["collection_id"] = collection_id
    # Group / subgroup filter: aggregate the article ids across every
    # matching collection (manual + smart) and filter the list to that
    # union. Done server-side so the URL stays clean and an empty group
    # short-circuits to total=0 without scanning articles.
    if collection_group:
        try:
            from .services import collections as _coll
            cids = _coll.find_in_group(collection_group, collection_subgroup)
            aids = _coll.aggregate_article_ids(cids) if cids else []
        except Exception as exc:
            logger.exception("collection group filter failed")
            aids = []
        if not aids:
            # Quick-return: no article matches, save Postgres a scan.
            return jsonify({
                "items": [], "total": 0, "page": page,
                "size": page_size, "filtered_by_group": True,
            })
        conditions.append("articles.id = ANY(CAST(:agg_ids AS uuid[]))")
        params["agg_ids"] = aids
        # Re-build the WHERE because we appended after the previous join.
        where = "WHERE " + " AND ".join(conditions) if conditions else ""

    from_clause = " ".join(join_parts)

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
    rating_aggs = {}        # aid -> {"avg": float, "count": int}
    my_ratings  = {}        # aid -> int (viewer's rating, if any)
    user_states = {}        # aid -> {"is_favorite": bool, "is_read": bool, "read_at": iso}
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

                # Aggregate ratings: avg + count per article id
                rating_rows = _s2.query(
                    models.ArticleRating.article_id,
                    func.avg(models.ArticleRating.rating),
                    func.count(models.ArticleRating.id),
                ).filter(
                    models.ArticleRating.article_id.in_(item_ids)
                ).group_by(models.ArticleRating.article_id).all()
                rating_aggs = {
                    r[0]: {"avg": round(float(r[1]), 2), "count": int(r[2])}
                    for r in rating_rows
                }

                viewer_id = _viewer_id()
                if viewer_id:
                    own_rows = _s2.query(
                        models.ArticleRating.article_id,
                        models.ArticleRating.rating,
                    ).filter(
                        models.ArticleRating.article_id.in_(item_ids),
                        models.ArticleRating.user_id == viewer_id,
                    ).all()
                    my_ratings = {r[0]: int(r[1]) for r in own_rows}
                    state_rows = _s2.query(
                        models.PrionVaultUserState.article_id,
                        models.PrionVaultUserState.is_favorite,
                        models.PrionVaultUserState.read_at,
                    ).filter(
                        models.PrionVaultUserState.article_id.in_(item_ids),
                        models.PrionVaultUserState.user_id == viewer_id,
                    ).all()
                    user_states = {
                        r[0]: {"is_favorite": bool(r[1]),
                               "is_read": r[2] is not None,
                               "read_at": r[2].isoformat() if r[2] else None}
                        for r in state_rows
                    }
        except Exception as exc:
            logger.warning("Could not query user_articles / ratings / state: %s", exc)

    role = _viewer_role()
    is_admin = (role == "admin")

    def _row_to_dict(r):
        d = dict(zip(col_names, r))
        aid = _uuid.UUID(str(d["id"]))
        in_pr = aid in prionread_counts
        adoi = (d.get("doi") or "").strip().lower()
        pp_ids = pp_doi_to_packs.get(adoi, []) if adoi else []
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
            "is_milestone":  bool(d.get("is_milestone")),
            "is_flagged":    bool(d.get("is_flagged")),
            "color_label":   d.get("color_label"),
            "pdf_pages":     d.get("pdf_pages"),
            "pdf_is_scan":   bool(d.get("pdf_is_scan")),
            "has_pdf":       bool(d.get("dropbox_path")),
            "jc_count":      int(d.get("jc_count") or 0),
            "has_jc":        bool(d.get("jc_count") or 0),
            "extraction_status": d.get("extraction_status") or "pending",
            "indexed_at":    d["indexed_at"].isoformat() if d.get("indexed_at") else None,
            "added_at":      d["created_at"].isoformat() if d.get("created_at") else None,
            "has_summary_ai":    bool(d.get("summary_ai")),
            "has_summary_human": False,
            "in_prionread":  in_pr,
            "prionread_count": prionread_counts.get(aid, 0),
            "avg_rating":     (rating_aggs.get(aid) or {}).get("avg"),
            "rating_count":   (rating_aggs.get(aid) or {}).get("count", 0),
            "my_rating":      my_ratings.get(aid),
            "is_favorite":    (user_states.get(aid) or {}).get("is_favorite", False),
            "is_read":        (user_states.get(aid) or {}).get("is_read", False),
            "read_at":        (user_states.get(aid) or {}).get("read_at"),
            "prionpacks":     [{"id": p, "title": pp_titles.get(p, p)} for p in pp_ids],
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
            "tags, is_milestone, is_flagged, color_label, priority, "
            "dropbox_path, dropbox_link, created_at, updated_at, "
            "(SELECT COUNT(*) FROM prionvault_jc_presentation jp "
            " WHERE jp.article_id = articles.id) AS jc_count"
        )
        optional = [
            "pdf_md5", "pdf_size_bytes", "pdf_pages", "pdf_is_scan",
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
            "is_milestone":  bool(d.get("is_milestone")),
            "is_flagged":    bool(d.get("is_flagged")),
            "color_label":   d.get("color_label"),
            "pdf_pages":     d.get("pdf_pages"),
            "pdf_is_scan":   bool(d.get("pdf_is_scan")),
            "has_pdf":       bool(d.get("dropbox_path")),
            "jc_count":      int(d.get("jc_count") or 0),
            "has_jc":        bool(d.get("jc_count") or 0),
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

        # Ratings: list + aggregate + own rating shortcut
        try:
            r_items, r_avg, r_count = _load_ratings_for_article(s, aid)
            out["ratings"]      = [_serialize_rating(it, viewer_id=viewer_id)
                                    for it in r_items]
            out["avg_rating"]   = r_avg
            out["rating_count"] = r_count
            out["my_rating"]    = next(
                (int(it["rating"]) for it in r_items
                 if str(it["user_id"]) == str(viewer_id)),
                None,
            )
        except Exception as exc:
            logger.warning("Could not load ratings for article %s: %s", aid, exc)
            out["ratings"] = []
            out["avg_rating"] = None
            out["rating_count"] = 0
            out["my_rating"] = None

        # Personal state (favorite / read) for the viewer
        out["is_favorite"] = False
        out["is_read"]     = False
        out["read_at"]     = None
        if viewer_id:
            try:
                st = s.get(models.PrionVaultUserState, (viewer_id, aid))
                if st:
                    out["is_favorite"] = bool(st.is_favorite)
                    out["is_read"]     = st.read_at is not None
                    out["read_at"]     = st.read_at.isoformat() if st.read_at else None
            except Exception as exc:
                logger.warning("Could not load user state for %s: %s", aid, exc)

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


@prionvault_bp.route("/api/tags/<int:tag_id>", methods=["DELETE"])
@admin_required
def api_delete_tag(tag_id):
    """Delete a tag definition. Cascade removes article_tag_link rows
    so any article previously carrying the tag just stops showing it
    in the chip list."""
    s = _session()
    try:
        t = s.get(models.ArticleTag, tag_id)
        if not t:
            return jsonify({"error": "not_found"}), 404
        s.delete(t)
        s.commit()
        return jsonify({"ok": True})
    except Exception as e:
        s.rollback()
        logger.exception("api_delete_tag failed")
        return jsonify({"error": "internal_error", "detail": str(e)[:300]}), 500
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


# ── Ratings ─────────────────────────────────────────────────────────────────
def _serialize_rating(r, viewer_id=None):
    return {
        "id":         str(r["id"]),
        "user_id":    str(r["user_id"]),
        "user_name":  r.get("user_name") or "—",
        "user_photo": r.get("user_photo"),
        "is_own":     str(r["user_id"]) == str(viewer_id) if viewer_id else False,
        "rating":     int(r["rating"]),
        "comment":    r.get("comment"),
        "created_at": r["created_at"].isoformat() if r.get("created_at") else None,
        "updated_at": r["updated_at"].isoformat() if r.get("updated_at") else None,
    }


def _load_ratings_for_article(s, aid):
    """Return (ratings_list_dicts, avg, count) for a given article."""
    rows = s.execute(sql_text(
        """SELECT ar.id, ar.user_id, ar.rating, ar.comment,
                  ar.created_at, ar.updated_at,
                  u.name AS user_name, u.photo_url AS user_photo
           FROM article_ratings ar
           LEFT JOIN users u ON u.id = ar.user_id
           WHERE ar.article_id = :aid
           ORDER BY ar.updated_at DESC"""
    ), {"aid": str(aid)}).all()
    if not rows:
        return [], None, 0
    items = [dict(zip(r._fields, r)) for r in rows]
    total = len(items)
    avg = round(sum(it["rating"] for it in items) / total, 2)
    return items, avg, total


@prionvault_bp.route("/api/articles/<uuid:aid>/ratings", methods=["GET"])
@login_required
def api_list_ratings(aid):
    """Return all ratings for an article + avg + count + own rating flag."""
    viewer_id = _viewer_id()
    s = _session()
    try:
        items, avg, total = _load_ratings_for_article(s, aid)
        return jsonify({
            "ratings":    [_serialize_rating(it, viewer_id=viewer_id) for it in items],
            "avg_rating": avg,
            "total":      total,
        })
    finally:
        s.close()


@prionvault_bp.route("/api/articles/<uuid:aid>/ratings", methods=["POST"])
@login_required
def api_create_or_update_rating(aid):
    """Upsert the viewer's rating on an article."""
    viewer_id = _viewer_id()
    if not viewer_id:
        return jsonify({"error": "not authenticated"}), 401

    data = request.get_json(force=True, silent=True) or {}
    try:
        rating = int(data.get("rating"))
    except (TypeError, ValueError):
        return jsonify({"error": "rating must be int 1-5"}), 400
    if not 1 <= rating <= 5:
        return jsonify({"error": "rating must be int 1-5"}), 400

    comment = (data.get("comment") or "").strip() or None
    if comment and len(comment) > 500:
        return jsonify({"error": "comment must be ≤ 500 characters"}), 400

    s = _session()
    try:
        # Verify article exists
        exists = s.execute(sql_text(
            "SELECT id FROM articles WHERE id = :aid"
        ), {"aid": str(aid)}).fetchone()
        if not exists:
            return jsonify({"error": "article not found"}), 404

        existing = s.query(models.ArticleRating).filter_by(
            user_id=viewer_id, article_id=aid).one_or_none()

        if existing:
            existing.rating = rating
            existing.comment = comment
            existing.updated_at = datetime.utcnow()
            status = 200
        else:
            r = models.ArticleRating(
                user_id=viewer_id, article_id=aid,
                rating=rating, comment=comment,
            )
            s.add(r)
            status = 201
        s.commit()

        items, avg, total = _load_ratings_for_article(s, aid)
        return jsonify({
            "ratings":    [_serialize_rating(it, viewer_id=viewer_id) for it in items],
            "avg_rating": avg,
            "total":      total,
        }), status
    except Exception as exc:
        s.rollback()
        logger.exception("api_create_or_update_rating failed")
        return jsonify({"error": "internal error", "detail": str(exc)[:300]}), 500
    finally:
        s.close()


@prionvault_bp.route("/api/articles/<uuid:aid>/ratings", methods=["DELETE"])
@login_required
def api_delete_rating(aid):
    """Delete the viewer's own rating on an article."""
    viewer_id = _viewer_id()
    if not viewer_id:
        return jsonify({"error": "not authenticated"}), 401
    s = _session()
    try:
        existing = s.query(models.ArticleRating).filter_by(
            user_id=viewer_id, article_id=aid).one_or_none()
        if not existing:
            return jsonify({"error": "rating not found"}), 404
        s.delete(existing)
        s.commit()
        items, avg, total = _load_ratings_for_article(s, aid)
        return jsonify({
            "ratings":    [_serialize_rating(it, viewer_id=viewer_id) for it in items],
            "avg_rating": avg,
            "total":      total,
        })
    finally:
        s.close()


# ── Personal user state (favorite / read) ───────────────────────────────────
def _get_or_create_state(s, user_id, article_id):
    state = s.get(models.PrionVaultUserState, (user_id, article_id))
    if state is None:
        # Verify the article exists before creating the row.
        exists = s.execute(sql_text(
            "SELECT id FROM articles WHERE id = :aid"
        ), {"aid": str(article_id)}).fetchone()
        if not exists:
            return None
        state = models.PrionVaultUserState(
            user_id=user_id, article_id=article_id,
            is_favorite=False, read_at=None,
        )
        s.add(state)
        s.flush()
    return state


def _state_to_dict(state):
    return {
        "is_favorite": bool(state.is_favorite),
        "read_at":     state.read_at.isoformat() if state.read_at else None,
        "is_read":     state.read_at is not None,
    }


@prionvault_bp.route("/api/articles/<uuid:aid>/favorite", methods=["POST"])
@login_required
def api_set_favorite(aid):
    """Set is_favorite for the viewer on this article. Body: {value: bool}."""
    user_id = _viewer_id()
    if not user_id:
        return jsonify({"error": "not authenticated"}), 401
    data = request.get_json(force=True, silent=True) or {}
    value = bool(data.get("value", True))
    s = _session()
    try:
        state = _get_or_create_state(s, user_id, aid)
        if state is None:
            return jsonify({"error": "article not found"}), 404
        state.is_favorite = value
        state.updated_at = datetime.utcnow()
        s.commit()
        return jsonify(_state_to_dict(state))
    except Exception as exc:
        s.rollback()
        logger.exception("api_set_favorite failed")
        return jsonify({"error": "internal error", "detail": str(exc)[:300]}), 500
    finally:
        s.close()


@prionvault_bp.route("/api/articles/<uuid:aid>/read", methods=["POST"])
@login_required
def api_set_read(aid):
    """Mark or unmark the article as personally read.
    Body: {value: bool}. If true, sets read_at = now(); if false, clears it.
    """
    user_id = _viewer_id()
    if not user_id:
        return jsonify({"error": "not authenticated"}), 401
    data = request.get_json(force=True, silent=True) or {}
    value = bool(data.get("value", True))
    s = _session()
    try:
        state = _get_or_create_state(s, user_id, aid)
        if state is None:
            return jsonify({"error": "article not found"}), 404
        state.read_at = datetime.utcnow() if value else None
        state.updated_at = datetime.utcnow()
        s.commit()
        return jsonify(_state_to_dict(state))
    except Exception as exc:
        s.rollback()
        logger.exception("api_set_read failed")
        return jsonify({"error": "internal error", "detail": str(exc)[:300]}), 500
    finally:
        s.close()


# ── Send to PrionRead ────────────────────────────────────────────────────────
@prionvault_bp.route("/api/articles/<uuid:aid>/send-to-prionread", methods=["POST"])
@login_required
def api_send_to_prionread(aid):
    """Assign article to all non-admin users in PrionRead (admin) or self (reader)."""
    user_id = _viewer_id()
    if not user_id:
        return jsonify({"error": "not authenticated"}), 401
    s = _session()
    try:
        # Verify article exists
        exists = s.execute(
            sql_text("SELECT id FROM articles WHERE id = :aid"),
            {"aid": str(aid)}
        ).fetchone()
        if not exists:
            return jsonify({"error": "not found"}), 404

        if _viewer_role() == "admin":
            # Assign to all non-admin users that don't already have it
            s.execute(sql_text(
                """INSERT INTO user_articles (id, user_id, article_id, status, created_at, updated_at)
                   SELECT gen_random_uuid(), u.id, :aid, 'pending', NOW(), NOW()
                   FROM users u
                   WHERE u.role != 'admin'
                     AND NOT EXISTS (
                       SELECT 1 FROM user_articles ua
                       WHERE ua.user_id = u.id AND ua.article_id = :aid
                     )"""
            ), {"aid": str(aid)})
        else:
            # Assign only to self
            already = s.execute(sql_text(
                "SELECT id FROM user_articles WHERE user_id = :uid AND article_id = :aid"
            ), {"uid": str(user_id), "aid": str(aid)}).fetchone()
            if not already:
                import uuid as _uuid
                s.execute(sql_text(
                    """INSERT INTO user_articles (id, user_id, article_id, status, created_at, updated_at)
                       VALUES (:id, :uid, :aid, 'pending', NOW(), NOW())"""
                ), {"id": str(_uuid.uuid4()), "uid": str(user_id), "aid": str(aid)})

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
    "abstract", "summary_ai", "summary_human", "is_milestone",
    "is_flagged", "color_label", "priority",
}


@prionvault_bp.route("/api/articles/<uuid:aid>", methods=["PATCH"])
@admin_required
def api_article_update(aid):
    data = request.get_json(force=True, silent=True) or {}
    updates = {k: v for k, v in data.items() if k in _EDITABLE_FIELDS}
    if not updates:
        return jsonify({"error": "no editable fields in payload"}), 400

    if "color_label" in updates:
        v = updates["color_label"]
        if v in ("", None):
            updates["color_label"] = None
        elif isinstance(v, str) and v.lower() in _VALID_COLOR_LABELS:
            updates["color_label"] = v.lower()
        else:
            return jsonify({"error": "invalid color_label",
                            "allowed": sorted(_VALID_COLOR_LABELS) + [None]}), 400

    if "priority" in updates:
        try:
            p = int(updates["priority"])
        except (TypeError, ValueError):
            return jsonify({"error": "priority must be int 1-5"}), 400
        if not 1 <= p <= 5:
            return jsonify({"error": "priority must be int 1-5"}), 400
        updates["priority"] = p

    for k in ("is_flagged", "is_milestone"):
        if k in updates:
            updates[k] = bool(updates[k])

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


_BULK_ALLOWED = {"priority", "color_label", "is_flagged", "is_milestone"}
_BULK_MAX_IDS = 10_000


@prionvault_bp.route("/api/articles/bulk", methods=["PATCH"])
@admin_required
def api_articles_bulk_update():
    """Apply the same set of edits to many articles in a single UPDATE.

    Body:
      {
        "ids":     ["<uuid>", ...],   // explicit selection
        "updates": {"priority": 4}    // any subset of _BULK_ALLOWED
      }
    Returns: { ok, updated: <rowcount> }.
    """
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "no_ids",
                        "detail": "Pasa una lista de UUIDs en `ids`."}), 400
    if len(ids) > _BULK_MAX_IDS:
        return jsonify({"error": "too_many",
                        "detail": f"Máximo {_BULK_MAX_IDS} ids por llamada."}), 400
    ids = [str(x) for x in ids if x]

    updates = data.get("updates") or {}
    if not isinstance(updates, dict):
        return jsonify({"error": "invalid_updates"}), 400
    safe = {k: v for k, v in updates.items() if k in _BULK_ALLOWED}
    if not safe:
        return jsonify({"error": "no_allowed_updates",
                        "allowed": sorted(_BULK_ALLOWED)}), 400

    if "priority" in safe:
        try:
            p = int(safe["priority"])
        except (TypeError, ValueError):
            return jsonify({"error": "priority must be int 1-5"}), 400
        if not 1 <= p <= 5:
            return jsonify({"error": "priority must be int 1-5"}), 400
        safe["priority"] = p

    if "color_label" in safe:
        v = safe["color_label"]
        if v in ("", None):
            safe["color_label"] = None
        elif isinstance(v, str) and v.lower() in _VALID_COLOR_LABELS:
            safe["color_label"] = v.lower()
        else:
            return jsonify({"error": "invalid color_label",
                            "allowed": sorted(_VALID_COLOR_LABELS) + [None]}), 400

    for k in ("is_flagged", "is_milestone"):
        if k in safe:
            safe[k] = bool(safe[k])

    set_clauses = ", ".join(f"{k} = :{k}" for k in safe)
    params = dict(safe)
    params["ids"] = ids

    s = _session()
    try:
        # SQLAlchemy's parameter binding parses `:name`, so the
        # Postgres `:: ` cast syntax confuses it ("LINE 1: …WHERE
        # id = ANY(:ids::uuid…"). Use CAST(:ids AS uuid[]) instead so
        # the parameter ends cleanly at `:ids` and the cast lives
        # inside a normal function call.
        res = s.execute(sql_text(
            f"UPDATE articles SET {set_clauses}, updated_at = NOW() "
            f"WHERE id = ANY(CAST(:ids AS uuid[]))"
        ), params)
        s.commit()
        return jsonify({"ok": True, "updated": res.rowcount or 0,
                        "fields": sorted(safe.keys())})
    except Exception as exc:
        s.rollback()
        logger.exception("bulk update failed")
        return jsonify({"error": "internal_error",
                        "detail": str(exc)[:300]}), 500
    finally:
        s.close()


@prionvault_bp.route("/api/articles/bulk-user-state", methods=["POST"])
@login_required
def api_articles_bulk_user_state():
    """Set is_favorite and/or read_at for the viewer across many articles.

    Body:
      {
        "ids":         ["<uuid>", ...],
        "is_favorite": true | false,    // optional
        "is_read":     true | false,    // optional
      }
    At least one of is_favorite / is_read must be provided.
    """
    user_id = _viewer_id()
    if not user_id:
        return jsonify({"error": "not authenticated"}), 401

    data = request.get_json(force=True, silent=True) or {}
    ids = data.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "no_ids",
                        "detail": "Pasa una lista de UUIDs en `ids`."}), 400
    if len(ids) > _BULK_MAX_IDS:
        return jsonify({"error": "too_many",
                        "detail": f"Máximo {_BULK_MAX_IDS} ids por llamada."}), 400
    ids = [str(x) for x in ids if x]

    set_fav  = "is_favorite" in data
    set_read = "is_read" in data
    if not (set_fav or set_read):
        return jsonify({"error": "no_fields",
                        "detail": "Indica is_favorite y/o is_read."}), 400

    fav  = bool(data.get("is_favorite")) if set_fav  else None
    read = bool(data.get("is_read"))     if set_read else None

    # Build the UPSERT — only the columns actually requested move.
    set_parts = []
    params = {"uid": str(user_id), "ids": ids, "now": datetime.utcnow()}
    if set_fav:
        set_parts.append("is_favorite = :fav")
        params["fav"] = fav
    if set_read:
        # read_at is the source of truth; is_read is derived (`read_at IS NOT NULL`).
        if read:
            set_parts.append("read_at = COALESCE(prionvault_user_state.read_at, :now)")
        else:
            set_parts.append("read_at = NULL")

    insert_cols = ["user_id", "article_id", "created_at", "updated_at"]
    insert_vals = [":uid", "x.article_id", ":now", ":now"]
    if set_fav:
        insert_cols.append("is_favorite")
        insert_vals.append(":fav")
    if set_read:
        insert_cols.append("read_at")
        insert_vals.append(":now" if read else "NULL")

    set_parts.append("updated_at = :now")

    s = _session()
    try:
        sql = sql_text(f"""
            INSERT INTO prionvault_user_state ({", ".join(insert_cols)})
            SELECT {", ".join(insert_vals)}
              FROM unnest(CAST(:ids AS uuid[])) AS x(article_id)
              JOIN articles a ON a.id = x.article_id
            ON CONFLICT (user_id, article_id) DO UPDATE
              SET {", ".join(set_parts)}
        """)
        res = s.execute(sql, params)
        s.commit()
        updated_fields = []
        if set_fav:  updated_fields.append("is_favorite")
        if set_read: updated_fields.append("is_read")
        return jsonify({"ok": True, "updated": res.rowcount or 0,
                        "fields": updated_fields})
    except Exception as exc:
        s.rollback()
        logger.exception("bulk user-state failed")
        return jsonify({"error": "internal_error",
                        "detail": str(exc)[:300]}), 500
    finally:
        s.close()


@prionvault_bp.route("/api/articles/bulk-tags", methods=["POST"])
@admin_required
def api_articles_bulk_tags():
    """Attach or detach tags from many articles in one call.

    Body:
      {
        "ids":            ["<uuid>", ...],
        "add_tag_ids":    [1, 2, ...],   // optional
        "remove_tag_ids": [3, ...],      // optional
      }
    """
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "no_ids"}), 400
    if len(ids) > _BULK_MAX_IDS:
        return jsonify({"error": "too_many",
                        "detail": f"Máximo {_BULK_MAX_IDS} ids por llamada."}), 400
    ids = [str(x) for x in ids if x]

    def _clean_int_list(value):
        out = []
        for v in (value or []):
            try:
                out.append(int(v))
            except (TypeError, ValueError):
                continue
        return out

    add_tags    = _clean_int_list(data.get("add_tag_ids"))
    remove_tags = _clean_int_list(data.get("remove_tag_ids"))
    if not add_tags and not remove_tags:
        return jsonify({"error": "no_tags"}), 400

    s = _session()
    try:
        added = 0
        if add_tags:
            res = s.execute(sql_text(
                """
                INSERT INTO article_tag_link (article_id, tag_id, added_by)
                SELECT a.article_id, t.tag_id, :uid
                  FROM unnest(CAST(:ids  AS uuid[])) AS a(article_id)
                 CROSS JOIN unnest(CAST(:tags AS int[]))  AS t(tag_id)
                  JOIN articles    ar ON ar.id = a.article_id
                  JOIN article_tag tg ON tg.id = t.tag_id
                ON CONFLICT (article_id, tag_id) DO NOTHING
                """
            ), {"ids": ids, "tags": add_tags, "uid": _viewer_id()})
            added = res.rowcount or 0

        removed = 0
        if remove_tags:
            res = s.execute(sql_text(
                """
                DELETE FROM article_tag_link
                 WHERE article_id = ANY(CAST(:ids  AS uuid[]))
                   AND tag_id     = ANY(CAST(:tags AS int[]))
                """
            ), {"ids": ids, "tags": remove_tags})
            removed = res.rowcount or 0

        s.commit()
        return jsonify({"ok": True, "added": added, "removed": removed})
    except Exception as exc:
        s.rollback()
        logger.exception("bulk tags failed")
        return jsonify({"error": "internal_error",
                        "detail": str(exc)[:300]}), 500
    finally:
        s.close()


_LOOKUP_BULK_MAX = 500


@prionvault_bp.route("/api/articles/lookup-bulk", methods=["POST"])
@login_required
def api_articles_lookup_bulk():
    """Given a paste of DOIs / PMIDs in any common format, report which
    ones already live in the library.

    Body: { identifiers: "<paste>"  OR  [ "<id1>", "<id2>", … ] }
    Accepts whitespace, commas, semicolons, tabs, newlines as
    separators. Token-level normalisation strips DOI URL prefixes
    ("https://doi.org/", "doi:") and PMID prefixes ("PMID: ").

    Returns the input list in the same order, each entry tagged with
    its match (or null) and the column it matched on. Caps at 500
    identifiers per call to keep the SQL small.
    """
    data = request.get_json(force=True, silent=True) or {}
    raw = data.get("identifiers", "")
    if isinstance(raw, str):
        tokens = re.split(r"[\s,;\t\r\n]+", raw.strip())
    elif isinstance(raw, list):
        tokens = []
        for x in raw:
            tokens += re.split(r"[\s,;\t\r\n]+", str(x).strip())
    else:
        return jsonify({"error": "invalid_input",
                        "detail": "identifiers debe ser string o lista"}), 400

    tokens = [t for t in tokens if t]
    if not tokens:
        return jsonify({"error": "empty",
                        "detail": "No se han pegado identificadores."}), 400
    if len(tokens) > _LOOKUP_BULK_MAX:
        return jsonify({"error": "too_many",
                        "detail": f"Máximo {_LOOKUP_BULK_MAX} ids por llamada."}), 400

    # Per-token normalisation: figure out if it looks like a DOI or PMID.
    classified = []   # list of (original, kind, normalised)
    dois  = []
    pmids = []
    for t in tokens:
        s = t.strip().rstrip(".,;:)")
        s = re.sub(r"^(?:https?://)?(?:dx\.)?doi\.org/", "", s,
                   flags=re.IGNORECASE)
        s = re.sub(r"^doi[:\s]+", "", s, flags=re.IGNORECASE)
        pmid_s = re.sub(r"^(?:pubmed(?:\s+id)?|pmid)[:\s]+", "", s,
                        flags=re.IGNORECASE)
        if re.match(r"^10\.\d{4,}/\S+$", s):
            classified.append((t, "doi", s.lower()))
            dois.append(s.lower())
        elif re.match(r"^\d{5,9}$", pmid_s):
            classified.append((t, "pmid", pmid_s))
            pmids.append(pmid_s)
        else:
            classified.append((t, "unknown", None))

    s = _session()
    try:
        doi_rows  = {}
        pmid_rows = {}
        cols = ("SELECT id, title, doi, pubmed_id, year, authors, journal, "
                "       (dropbox_path IS NOT NULL) AS has_pdf, "
                "       (summary_ai IS NOT NULL)   AS has_summary, "
                "       priority, is_flagged, is_milestone, color_label "
                "FROM articles ")
        if dois:
            rows = s.execute(sql_text(
                cols + "WHERE lower(doi) = ANY(:vals)"
            ), {"vals": list(set(dois))}).mappings().all()
            for r in rows:
                if r["doi"]:
                    doi_rows[r["doi"].lower()] = r
        if pmids:
            rows = s.execute(sql_text(
                cols + "WHERE pubmed_id = ANY(:vals)"
            ), {"vals": list(set(pmids))}).mappings().all()
            for r in rows:
                if r["pubmed_id"]:
                    pmid_rows[str(r["pubmed_id"])] = r

        def _shape(r, found_by):
            return {
                "id":           str(r["id"]),
                "title":        r["title"],
                "doi":          r["doi"],
                "pubmed_id":    r["pubmed_id"],
                "year":         r["year"],
                "authors":      r["authors"],
                "journal":      r["journal"],
                "has_pdf":      bool(r["has_pdf"]),
                "has_summary":  bool(r["has_summary"]),
                "priority":     r["priority"],
                "is_flagged":   bool(r["is_flagged"]),
                "is_milestone": bool(r["is_milestone"]),
                "color_label":  r["color_label"],
                "found_by":     found_by,
            }

        items = []
        for original, kind, norm in classified:
            match = None
            if kind == "doi" and norm in doi_rows:
                match = _shape(doi_rows[norm], "doi")
            elif kind == "pmid" and norm in pmid_rows:
                match = _shape(pmid_rows[norm], "pmid")
            items.append({
                "input":       original,
                "kind":        kind,
                "normalised":  norm,
                "match":       match,
            })

        total = len(items)
        found = sum(1 for it in items if it["match"])
        unparseable = sum(1 for it in items if it["kind"] == "unknown")
        return jsonify({
            "items":       items,
            "total":       total,
            "found":       found,
            "not_found":   total - found - unparseable,
            "unparseable": unparseable,
        })
    except Exception as exc:
        logger.exception("lookup-bulk failed")
        return jsonify({"error": "internal_error",
                        "detail": str(exc)[:300]}), 500
    finally:
        s.close()


@prionvault_bp.route("/api/articles/bulk-delete", methods=["POST"])
@admin_required
def api_articles_bulk_delete():
    """Bulk-delete every article in `ids` and best-effort remove its
    Dropbox PDF. Body: { ids: ["<uuid>", ...] }. Returns counts of
    rows actually removed and Dropbox files cleaned up."""
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "no_ids"}), 400
    if len(ids) > _BULK_MAX_IDS:
        return jsonify({"error": "too_many",
                        "detail": f"Máximo {_BULK_MAX_IDS} ids por llamada."}), 400
    ids = [str(x) for x in ids if x]

    s = _session()
    dropbox_deleted = 0
    dropbox_failed  = 0
    try:
        # First collect the Dropbox paths so we can clean up after
        # the DB rows are gone. Doing it in this order is fine —
        # losing a Dropbox file orphans nothing because the row is
        # the only thing that pointed at it.
        rows = s.execute(sql_text(
            "SELECT dropbox_path FROM articles "
            "WHERE id = ANY(CAST(:ids AS uuid[])) "
            "  AND dropbox_path IS NOT NULL"
        ), {"ids": ids}).all()
        paths = [r[0] for r in rows if r[0]]

        res = s.execute(sql_text(
            "DELETE FROM articles WHERE id = ANY(CAST(:ids AS uuid[]))"
        ), {"ids": ids})
        deleted = res.rowcount or 0
        s.commit()

        if paths:
            try:
                from core.dropbox_client import get_client
                client = get_client()
                if client is not None:
                    for p in paths:
                        try:
                            client.files_delete_v2(p)
                            dropbox_deleted += 1
                        except Exception as exc:
                            dropbox_failed += 1
                            logger.warning("bulk-delete: Dropbox delete "
                                           "failed for %s: %s", p, exc)
            except Exception as exc:
                logger.warning("bulk-delete: Dropbox client unavailable: %s", exc)

        return jsonify({
            "ok":              True,
            "deleted":         deleted,
            "dropbox_deleted": dropbox_deleted,
            "dropbox_failed":  dropbox_failed,
        })
    except Exception as exc:
        s.rollback()
        logger.exception("bulk-delete failed")
        return jsonify({"error": "internal_error",
                        "detail": str(exc)[:300]}), 500
    finally:
        s.close()


@prionvault_bp.route("/api/articles/<uuid:aid>", methods=["DELETE"])
@admin_required
def api_article_delete(aid):
    """Delete the article row AND its PDF from Dropbox.

    The `articles` table is shared with PrionRead, so removing the row also
    removes the article from PrionRead's listings. The PDF in Dropbox is the
    same file both apps point to, so we delete it here to keep PrionRead's
    `DELETE /api/articles/:id` behaviour symmetric.

    A Dropbox failure does NOT block the row deletion — it is logged so the
    orphan file can be cleaned up manually.
    """
    s = _session()
    try:
        a = s.get(models.Article, aid)
        if not a:
            return jsonify({"error": "not found"}), 404

        dropbox_path = getattr(a, "dropbox_path", None)
        dropbox_deleted = False
        dropbox_error = None
        if dropbox_path:
            try:
                from core.dropbox_client import get_client
                client = get_client()
                if client is None:
                    dropbox_error = "dropbox client unavailable"
                    logger.warning(
                        "Dropbox client unavailable; PDF not deleted: %s",
                        dropbox_path,
                    )
                else:
                    client.files_delete_v2(dropbox_path)
                    dropbox_deleted = True
            except Exception as exc:
                dropbox_error = str(exc)[:300]
                logger.warning(
                    "Dropbox delete failed for %s: %s", dropbox_path, exc
                )

        s.delete(a)
        s.commit()
        return jsonify({
            "ok": True,
            "dropbox_path": dropbox_path,
            "dropbox_deleted": dropbox_deleted,
            "dropbox_error": dropbox_error,
        })
    finally:
        s.close()


# ── Metadata lookup (synchronous, no PDF) ──────────────────────────────────
@prionvault_bp.route("/api/articles/lookup", methods=["POST"])
@admin_required
def api_article_lookup():
    """Resolve bibliographic metadata for a DOI or PMID without ingesting.

    Body: {"doi": "10.xxxx/yyy"} or {"pubmed_id": "12345678"}.
    Returns the metadata fields the resolver could fill, plus a flag
    telling the caller if an article with that DOI/PMID already exists
    in the library (so the UI can warn before creating a duplicate).
    """
    from .ingestion.metadata_resolver import resolve_metadata
    from .ingestion.pdf_extractor import normalise_doi

    data = request.get_json(force=True, silent=True) or {}
    doi  = (data.get("doi") or "").strip()
    pmid = (data.get("pubmed_id") or data.get("pmid") or "").strip()
    if not doi and not pmid:
        return jsonify({"error": "provide doi or pubmed_id"}), 400
    if doi:
        doi = normalise_doi(doi)

    meta = resolve_metadata(doi=doi or None, pmid_hint=pmid or None)
    if not meta or not meta.title:
        return jsonify({
            "found": False,
            "doi": doi or None,
            "pubmed_id": pmid or None,
        })

    s = _session()
    try:
        dup_id = None
        if meta.doi:
            row = s.execute(sql_text(
                "SELECT id FROM articles WHERE lower(doi) = :d LIMIT 1"
            ), {"d": meta.doi.lower()}).first()
            if row:
                dup_id = str(row[0])
        if not dup_id and meta.pubmed_id:
            row = s.execute(sql_text(
                "SELECT id FROM articles WHERE pubmed_id = :p LIMIT 1"
            ), {"p": meta.pubmed_id}).first()
            if row:
                dup_id = str(row[0])

        return jsonify({
            "found":      True,
            "duplicate_of": dup_id,
            "metadata": {
                "title":     meta.title,
                "authors":   meta.authors,
                "year":      meta.year,
                "journal":   meta.journal,
                "doi":       meta.doi,
                "pubmed_id": meta.pubmed_id,
                "abstract":  meta.abstract,
                "volume":    meta.volume,
                "issue":     meta.issue,
                "pages":     meta.pages,
                "source":    meta.source,
            },
        })
    finally:
        s.close()


# ── Manual article create (no PDF) ─────────────────────────────────────────
_CREATE_ALLOWED = {
    "title", "authors", "year", "journal", "doi", "pubmed_id",
    "abstract", "is_milestone", "is_flagged", "color_label", "priority",
    "source",
}


@prionvault_bp.route("/api/articles", methods=["POST"])
@admin_required
def api_article_create():
    """Create an article from supplied metadata. Returns 409 on duplicate."""
    import uuid as _uuid_mod
    from .ingestion.pdf_extractor import normalise_doi

    data = request.get_json(force=True, silent=True) or {}
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "title is required"}), 400

    payload = {k: v for k, v in data.items() if k in _CREATE_ALLOWED}
    payload["title"] = title

    if "doi" in payload and payload["doi"]:
        payload["doi"] = normalise_doi(payload["doi"])
    if "color_label" in payload:
        v = payload["color_label"]
        if v in ("", None):
            payload["color_label"] = None
        elif isinstance(v, str) and v.lower() in _VALID_COLOR_LABELS:
            payload["color_label"] = v.lower()
        else:
            return jsonify({"error": "invalid color_label"}), 400
    if "priority" in payload and payload["priority"] is not None:
        try:
            p = int(payload["priority"])
            if not 1 <= p <= 5:
                raise ValueError
            payload["priority"] = p
        except (TypeError, ValueError):
            return jsonify({"error": "priority must be int 1-5"}), 400
    for k in ("is_flagged", "is_milestone"):
        if k in payload:
            payload[k] = bool(payload[k])

    s = _session()
    try:
        # Duplicate check by DOI or PMID before INSERT.
        dup_id = None
        if payload.get("doi"):
            row = s.execute(sql_text(
                "SELECT id FROM articles WHERE lower(doi) = :d LIMIT 1"
            ), {"d": payload["doi"].lower()}).first()
            if row:
                dup_id = str(row[0])
        if not dup_id and payload.get("pubmed_id"):
            row = s.execute(sql_text(
                "SELECT id FROM articles WHERE pubmed_id = :p LIMIT 1"
            ), {"p": payload["pubmed_id"]}).first()
            if row:
                dup_id = str(row[0])
        if dup_id:
            return jsonify({"error": "duplicate", "duplicate_of": dup_id}), 409

        new_id = _uuid_mod.uuid4()
        a = models.Article(
            id=new_id,
            added_by_id=_viewer_id(),
            source=payload.pop("source", "manual"),
            **payload,
        )
        s.add(a)
        s.commit()
        return jsonify(a.to_dict(include_text=True, viewer_role="admin")), 201
    except Exception as exc:
        s.rollback()
        logger.exception("api_article_create failed")
        return jsonify({"error": "internal error", "detail": str(exc)[:300]}), 500
    finally:
        s.close()


# ── Duplicates detection ───────────────────────────────────────────────────
_TOKEN_STRIP_RE = re.compile(r"[^a-z0-9\s]")
_STOPWORDS = frozenset({
    "the", "a", "an", "of", "and", "in", "for", "to", "on", "by", "with",
    "as", "is", "are", "be", "from", "at", "or", "via", "into"
})


def _tokenize_title(s: str) -> set:
    if not s:
        return set()
    text = _TOKEN_STRIP_RE.sub(" ", s.lower())
    return {w for w in text.split() if w and w not in _STOPWORDS and len(w) >= 3}


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a) + len(b) - inter
    return inter / union if union else 0.0


def _norm_doi(doi):
    if not doi:
        return ""
    return re.sub(r"^https?://(dx\.)?doi\.org/", "",
                  doi.strip().lower(), flags=re.IGNORECASE)


@prionvault_bp.route("/api/duplicates", methods=["GET"])
@admin_required
def api_duplicates():
    """Return pairs of articles that look like duplicates of each other.

    Reasons: identical DOI, identical PMID, or Jaccard similarity ≥ 0.75
    on title tokens (lowercased, stopwords stripped).
    """
    threshold = max(0.0, min(1.0,
                             request.args.get("threshold", default=0.75, type=float)))
    s = _session()
    try:
        rows = s.execute(sql_text(
            "SELECT id, title, authors, year, journal, doi, pubmed_id "
            "FROM articles ORDER BY year DESC NULLS LAST, title"
        )).all()
        items = [dict(zip(r._fields, r)) for r in rows]
        for it in items:
            it["_tok"] = _tokenize_title(it.get("title") or "")
            it["_doi"] = _norm_doi(it.get("doi"))
            it["_pmid"] = (it.get("pubmed_id") or "").strip()

        pairs = []
        n = len(items)
        for i in range(n):
            a = items[i]
            for j in range(i + 1, n):
                b = items[j]
                reasons = []
                score = 0.0
                if a["_doi"] and a["_doi"] == b["_doi"]:
                    reasons.append("DOI idéntico")
                    score = 1.0
                if a["_pmid"] and a["_pmid"] == b["_pmid"]:
                    reasons.append("PMID idéntico")
                    score = max(score, 1.0)
                title_score = _jaccard(a["_tok"], b["_tok"])
                if title_score >= threshold:
                    reasons.append(f"Título similar ({int(round(title_score * 100))}%)")
                    score = max(score, title_score)
                if reasons:
                    pairs.append({
                        "a": {k: a[k] for k in ("id", "title", "authors", "year",
                                                 "journal", "doi", "pubmed_id")},
                        "b": {k: b[k] for k in ("id", "title", "authors", "year",
                                                 "journal", "doi", "pubmed_id")},
                        "score": round(score, 2),
                        "reasons": reasons,
                    })

        pairs.sort(key=lambda p: -p["score"])
        # Stringify UUIDs for JSON
        for p in pairs:
            p["a"]["id"] = str(p["a"]["id"])
            p["b"]["id"] = str(p["b"]["id"])
        return jsonify({"total": len(pairs), "pairs": pairs})
    finally:
        s.close()


# ── Collections (manual groupings + future smart filters) ──────────────────
@prionvault_bp.route("/api/collections", methods=["GET"])
@login_required
def api_collections_list():
    from .services import collections as _coll
    try:
        return jsonify({"items": _coll.list_all(viewer_id=_viewer_id())})
    except Exception as exc:
        logger.exception("collections list failed")
        return jsonify({"error": "internal_error",
                        "detail": str(exc)[:300]}), 500


@prionvault_bp.route("/api/collections", methods=["POST"])
@admin_required
def api_collections_create():
    from .services import collections as _coll
    data = request.get_json(force=True, silent=True) or {}
    try:
        c = _coll.create(
            name=data.get("name") or "",
            description=data.get("description"),
            kind=(data.get("kind") or "manual").strip().lower(),
            rules=data.get("rules") or None,
            color=(data.get("color") or "").strip() or None,
            group_name=data.get("group_name"),
            subgroup_name=data.get("subgroup_name"),
            created_by=_viewer_id(),
        )
        return jsonify(c), 201
    except ValueError as exc:
        return jsonify({"error": "invalid", "detail": str(exc)}), 400
    except Exception as exc:
        logger.exception("collections create failed")
        return jsonify({"error": "internal_error",
                        "detail": str(exc)[:300]}), 500


@prionvault_bp.route("/api/collections/<uuid:cid>", methods=["GET"])
@login_required
def api_collections_get(cid):
    from .services import collections as _coll
    c = _coll.get(cid)
    if not c:
        return jsonify({"error": "not_found"}), 404
    return jsonify(c)


@prionvault_bp.route("/api/collections/<uuid:cid>", methods=["PATCH"])
@admin_required
def api_collections_update(cid):
    from .services import collections as _coll
    data = request.get_json(force=True, silent=True) or {}
    try:
        c = _coll.update(
            cid,
            name=data.get("name"),
            description=data.get("description"),
            rules=data.get("rules"),
            color=data.get("color"),
            group_name=data.get("group_name"),
            subgroup_name=data.get("subgroup_name"),
        )
    except ValueError as exc:
        return jsonify({"error": "invalid", "detail": str(exc)}), 400
    if not c:
        return jsonify({"error": "not_found"}), 404
    return jsonify(c)


@prionvault_bp.route("/api/collections/<uuid:cid>", methods=["DELETE"])
@admin_required
def api_collections_delete(cid):
    from .services import collections as _coll
    if not _coll.delete(cid):
        return jsonify({"error": "not_found"}), 404
    return jsonify({"ok": True})


@prionvault_bp.route("/api/collections/<uuid:cid>/article-ids", methods=["GET"])
@login_required
def api_collections_article_ids(cid):
    """Return every article id currently in the collection. For smart
    collections this evaluates the rules live. Used by the sidebar
    "send to PrionPack" shortcut."""
    from .services import collections as _coll
    try:
        ids = _coll.resolve_article_ids(cid)
    except LookupError:
        return jsonify({"error": "not_found"}), 404
    except Exception as exc:
        logger.exception("collections article-ids failed for %s", cid)
        return jsonify({"error": "internal_error",
                        "detail": str(exc)[:300]}), 500
    return jsonify({"ids": ids, "count": len(ids)})


@prionvault_bp.route("/api/collections/<uuid:cid>/articles", methods=["POST"])
@admin_required
def api_collections_add_articles(cid):
    """Body: { ids: ["<uuid>", …] }. Manual collections only."""
    from .services import collections as _coll
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "no_ids"}), 400
    if len(ids) > 10_000:
        return jsonify({"error": "too_many"}), 400
    try:
        result = _coll.add_articles(cid, ids, added_by=_viewer_id())
    except LookupError:
        return jsonify({"error": "not_found"}), 404
    except ValueError as exc:
        return jsonify({"error": "invalid", "detail": str(exc)}), 400
    except Exception as exc:
        logger.exception("collections add failed")
        return jsonify({"error": "internal_error",
                        "detail": str(exc)[:300]}), 500
    return jsonify({"ok": True, **result})


@prionvault_bp.route("/api/collections/<uuid:cid>/articles", methods=["DELETE"])
@admin_required
def api_collections_remove_articles(cid):
    """Body: { ids: ["<uuid>", …] }. Removes those rows from the link
    table; the articles themselves are untouched."""
    from .services import collections as _coll
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "no_ids"}), 400
    removed = _coll.remove_articles(cid, ids)
    return jsonify({"ok": True, "removed": removed})


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


@prionvault_bp.route("/api/ingest/clear-failed", methods=["POST"])
@admin_required
def api_ingest_clear_failed():
    """Remove every failed/duplicate row from the ingest queue.
    Convenient when /tmp has been wiped and the staged PDFs are gone
    — the rows are useless and a Retry would just fail again."""
    from .ingestion import queue as ingest_queue
    deleted = ingest_queue.clear_failed()
    return jsonify({"ok": True, "deleted": deleted})


# ── PDF streaming (inline viewer) ───────────────────────────────────────────
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
            "ok":          True,
            "summary_ai":  result.text,
            "model":       result.model,
            "tokens_in":   result.tokens_in,
            "tokens_out":  result.tokens_out,
            "cost_usd":    result.cost_usd,
            "elapsed_ms":  result.elapsed_ms,
            "used_full_text": result.used_full_text,
        })
    except Exception as exc:
        s.rollback()
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


# ── Batch AI summary generation ─────────────────────────────────────────────
@prionvault_bp.route("/api/admin/batch-summary/status", methods=["GET"])
@admin_required
def api_batch_summary_status():
    from .services import batch_summary
    return jsonify(batch_summary.get_status())


@prionvault_bp.route("/api/admin/batch-summary/start", methods=["POST"])
@admin_required
def api_batch_summary_start():
    """Kick off a background batch run.

    Body (optional JSON): {"limit": int} — max articles to process this run.
    Returns 409 if a run is already in progress.
    """
    from .services import batch_summary
    data = request.get_json(force=True, silent=True) or {}
    limit = data.get("limit")
    if limit is not None:
        try:
            limit = int(limit)
            if limit <= 0:
                limit = None
        except (TypeError, ValueError):
            return jsonify({"error": "limit must be a positive integer"}), 400

    from .services.ai_summary import PROVIDERS
    provider = (data.get("provider") or "").strip().lower()
    if not provider:
        return jsonify({"error": "missing_provider",
                        "detail": "Elige un proveedor de IA "
                                  "(anthropic / openai / gemini)."}), 400
    if provider not in PROVIDERS:
        return jsonify({"error": "unknown_provider",
                        "detail": f"Valid: {sorted(PROVIDERS)}"}), 400
    # Reject providers whose API key is not configured so the batch
    # doesn't start just to crash on the first article.
    import os as _os
    if not _os.getenv(PROVIDERS[provider]["env"], "").strip():
        return jsonify({"error": "provider_not_configured",
                        "detail": (f"{PROVIDERS[provider]['env']} no está "
                                   f"configurada en el entorno.")}), 400

    # Optional selection: process only these article ids (regenerating
    # any existing summary). When omitted, the default eligibility
    # filter applies.
    ids = data.get("ids")
    if ids is not None:
        if not isinstance(ids, list):
            return jsonify({"error": "invalid_ids",
                            "detail": "ids debe ser una lista."}), 400
        ids = [str(x) for x in ids if x]
        if len(ids) > 5000:
            return jsonify({"error": "too_many_ids",
                            "detail": "Máximo 5000 ids."}), 400

    snap = batch_summary.start_batch(
        viewer_user_id=_viewer_id(), limit=limit, provider=provider,
        ids=ids or None)
    if snap is None:
        return jsonify({"error": "already_running",
                        "status": batch_summary.get_status()}), 409
    return jsonify({"ok": True, "status": snap})


@prionvault_bp.route("/api/admin/batch-summary/stop", methods=["POST"])
@admin_required
def api_batch_summary_stop():
    """Signal the running batch to stop after the current article."""
    from .services import batch_summary
    return jsonify({"ok": True, "status": batch_summary.stop_batch()})


@prionvault_bp.route("/api/admin/ai-providers", methods=["GET"])
@admin_required
def api_ai_providers():
    """List the AI providers wired into ai_summary, with availability info
    (whether their API key is set) so the bulk-summary modal can render
    the picker and disable misconfigured options."""
    from .services.ai_summary import provider_status
    return jsonify({"providers": provider_status()})


# ── Used in: PrionPacks + student assignments for an article ────────────────
@prionvault_bp.route("/api/articles/<uuid:aid>/used-in", methods=["GET"])
@login_required
def api_article_used_in(aid):
    """Return which PrionPacks reference this article and which users
    have it assigned.

    Match against PrionPacks is done by DOI substring (case-insensitive)
    on the references and introReferences lists. Inactive packs are
    skipped.
    """
    s = _session()
    try:
        row = s.execute(sql_text(
            "SELECT id, doi, title FROM articles WHERE id = :aid"
        ), {"aid": str(aid)}).first()
        if not row:
            return jsonify({"error": "not found"}), 404
        doi = ((row.doi or "")).strip().lower()

        packs = []
        try:
            from tools.prionpacks import models as pp_models
            for pkg in pp_models.list_packages():
                if not pkg.get("active", True):
                    continue
                lists = []
                if doi:
                    for ref in (pkg.get("introReferences") or []):
                        if doi in (ref or "").lower():
                            lists.append("intro")
                            break
                    for ref in (pkg.get("references") or []):
                        if doi in (ref or "").lower():
                            lists.append("general")
                            break
                if lists:
                    packs.append({
                        "id":           pkg.get("id"),
                        "title":        pkg.get("title"),
                        "type":         pkg.get("type"),
                        "responsible":  pkg.get("responsible"),
                        "lists":        lists,
                    })
        except Exception as exc:
            logger.warning("used-in: prionpacks scan failed: %s", exc)

        students = []
        try:
            rows = s.execute(sql_text(
                """SELECT ua.user_id, ua.status,
                          ua.created_at, ua.updated_at,
                          u.name, u.email, u.photo_url
                   FROM user_articles ua
                   LEFT JOIN users u ON u.id = ua.user_id
                   WHERE ua.article_id = :aid
                   ORDER BY ua.updated_at DESC"""
            ), {"aid": str(aid)}).all()
            for r in rows:
                students.append({
                    "user_id":    str(r.user_id) if r.user_id else None,
                    "name":       r.name or "—",
                    "email":      r.email,
                    "photo_url":  r.photo_url,
                    "status":     r.status,
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                    "updated_at": r.updated_at.isoformat() if r.updated_at else None,
                })
        except Exception as exc:
            logger.warning("used-in: students lookup failed: %s", exc)

        return jsonify({"packs": packs, "students": students})
    finally:
        s.close()


# ── Similar articles (vector neighbours of an article) ─────────────────────
@prionvault_bp.route("/api/articles/<uuid:aid>/similar", methods=["GET"])
@login_required
def api_article_similar(aid):
    """Return the N articles whose chunks are closest in vector space to
    this one. Empty list if the source article has no embeddings yet.
    """
    from .embeddings.retriever import find_similar_articles
    try:
        limit = max(1, min(30, int(request.args.get("limit", 10))))
    except (TypeError, ValueError):
        limit = 10
    try:
        items = find_similar_articles(aid, limit=limit)
        return jsonify({"items": items})
    except Exception as exc:
        logger.exception("similar lookup failed for %s", aid)
        return jsonify({"error": "internal_error",
                        "detail": str(exc)[:300]}), 500


# ── Supplementary material ─────────────────────────────────────────────────
@prionvault_bp.route("/api/articles/<uuid:aid>/supplementary", methods=["GET"])
@login_required
def api_supplementary_list(aid):
    from .services import supplementary
    try:
        return jsonify({"items": supplementary.list_for_article(aid)})
    except Exception as exc:
        logger.exception("supplementary list failed for %s", aid)
        return jsonify({"error": "internal_error",
                        "detail": str(exc)[:300]}), 500


@prionvault_bp.route("/api/articles/<uuid:aid>/supplementary", methods=["POST"])
@admin_required
def api_supplementary_upload(aid):
    """Upload one supplementary file. multipart/form-data:
       file=<binary>, caption=<optional string>.
    Returns the created row metadata."""
    from .services import supplementary
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "no file"}), 400
    caption = (request.form.get("caption") or "").strip() or None
    try:
        content = f.read()
        row = supplementary.create(
            article_id=aid,
            content=content,
            filename=f.filename,
            caption=caption,
            added_by=_viewer_id(),
        )
        return jsonify(row), 201
    except ValueError as exc:
        return jsonify({"error": "invalid", "detail": str(exc)}), 400
    except RuntimeError as exc:
        logger.warning("supplementary upload failed for %s: %s", aid, exc)
        return jsonify({"error": "upload_failed", "detail": str(exc)}), 502
    except Exception as exc:
        logger.exception("supplementary upload crashed for %s", aid)
        return jsonify({"error": "internal_error",
                        "detail": str(exc)[:300]}), 500


@prionvault_bp.route(
    "/api/articles/<uuid:aid>/supplementary/<uuid:sid>",
    methods=["PATCH"])
@admin_required
def api_supplementary_update(aid, sid):
    from .services import supplementary
    data = request.get_json(force=True, silent=True) or {}
    if "caption" not in data:
        return jsonify({"error": "no editable fields"}), 400
    caption = data.get("caption")
    if caption is not None:
        caption = str(caption)[:2000]
    try:
        ok = supplementary.update_caption(sid, caption)
    except Exception as exc:
        logger.exception("supplementary patch failed for %s", sid)
        return jsonify({"error": "internal_error",
                        "detail": str(exc)[:300]}), 500
    if not ok:
        return jsonify({"error": "not_found"}), 404
    return jsonify({"ok": True, "caption": caption or ""})


@prionvault_bp.route(
    "/api/articles/<uuid:aid>/supplementary/<uuid:sid>",
    methods=["DELETE"])
@admin_required
def api_supplementary_delete(aid, sid):
    from .services import supplementary
    try:
        ok = supplementary.delete(sid)
    except Exception as exc:
        logger.exception("supplementary delete failed for %s", sid)
        return jsonify({"error": "internal_error",
                        "detail": str(exc)[:300]}), 500
    if not ok:
        return jsonify({"error": "not_found"}), 404
    return jsonify({"ok": True})


@prionvault_bp.route(
    "/api/articles/<uuid:aid>/supplementary/<uuid:sid>/url",
    methods=["GET"])
@login_required
def api_supplementary_url(aid, sid):
    """Return a short-lived Dropbox download URL for the file."""
    from .services import supplementary
    url = supplementary.temporary_link(sid)
    if not url:
        return jsonify({"error": "unavailable"}), 502
    return jsonify({"url": url})


# ── Diagnostics: who am I + users table introspection ──────────────────────
@prionvault_bp.route("/api/admin/whoami", methods=["GET"])
@admin_required
def api_admin_whoami():
    """Return everything we know about the current session and the
    shape of the public.users table. Used to diagnose
    'why is _viewer_id() returning None' / 'why does column X not
    exist' classes of bug without needing psql access."""
    from sqlalchemy import text as _text
    info = {
        "session": {
            "logged_in": bool(session.get("logged_in")),
            "username":  session.get("username"),
            "user_id":   session.get("user_id"),
            "role":      session.get("role"),
            "full_name": session.get("full_name"),
        },
        "viewer_id_resolves_to": _viewer_id(),
    }
    s = _session()
    try:
        cols = s.execute(_text(
            "SELECT column_name, data_type, is_nullable "
            "FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = 'users' "
            "ORDER BY ordinal_position"
        )).all()
        info["users_table_columns"] = [
            {"name": c[0], "type": c[1], "nullable": c[2]} for c in cols
        ]

        # Probe a few likely identifier-style columns to see which one
        # actually matches the current session.username.
        uname = session.get("username") or ""
        probes = {}
        for cand in ("username", "user_name", "login", "handle", "email"):
            if not any(c[0] == cand for c in cols):
                probes[cand] = "(column missing)"
                continue
            try:
                row = s.execute(_text(
                    f"SELECT id FROM users WHERE lower({cand}) = lower(:u) LIMIT 1"
                ), {"u": uname}).first()
                probes[cand] = str(row[0]) if row else None
            except Exception as exc:
                probes[cand] = f"error: {str(exc)[:120]}"
        info["lookups_for_session_username"] = probes
    except Exception as exc:
        info["introspection_error"] = str(exc)[:300]
    finally:
        s.close()
    return jsonify(info)


# ── Journal Club presentations ──────────────────────────────────────────────
@prionvault_bp.route("/api/articles/<uuid:aid>/jc", methods=["GET"])
@login_required
def api_jc_list(aid):
    """Return every JC presentation attached to one article."""
    from .services import jc as _jc
    try:
        return jsonify({"items": _jc.list_for_article(aid)})
    except Exception as exc:
        logger.exception("jc list failed for %s", aid)
        return jsonify({"error": "internal_error",
                        "detail": str(exc)[:300]}), 500


def _parse_iso_date(s):
    from datetime import date as _d
    try:
        y, m, d = s.split("-")
        return _d(int(y), int(m), int(d))
    except Exception:
        raise ValueError("date must be YYYY-MM-DD")


@prionvault_bp.route("/api/articles/<uuid:aid>/jc", methods=["POST"])
@admin_required
def api_jc_create(aid):
    """Create a JC presentation row + optionally attach files in the
    same multipart request. Body fields:
       presented_at (YYYY-MM-DD), presenter_name, presenter_id?,
       file (one or many, optional).
    """
    from .services import jc as _jc
    data = request.form if request.form else (request.get_json(silent=True) or {})
    presented_at = (data.get("presented_at") or "").strip()
    presenter_name = (data.get("presenter_name") or "").strip()
    presenter_id   = (data.get("presenter_id") or "").strip() or None
    if not presented_at or not presenter_name:
        return jsonify({"error": "missing_fields",
                        "detail": "presented_at and presenter_name are required."}), 400
    try:
        date_obj = _parse_iso_date(presented_at)
    except ValueError as exc:
        return jsonify({"error": "invalid_date", "detail": str(exc)}), 400

    try:
        pres = _jc.create(
            article_id=aid,
            presented_at=date_obj,
            presenter_name=presenter_name,
            presenter_id=presenter_id,
            created_by=_viewer_id(),
        )
    except ValueError as exc:
        return jsonify({"error": "invalid", "detail": str(exc)}), 400
    except Exception as exc:
        logger.exception("jc create failed for %s", aid)
        return jsonify({"error": "internal_error",
                        "detail": str(exc)[:300]}), 500

    # Optional initial files (one form field "file" can repeat).
    files = (request.files.getlist("file") +
             request.files.getlist("files"))
    files = [f for f in files if f and f.filename]
    file_results = []
    for f in files:
        try:
            row = _jc.add_file(pres["id"], content=f.read(), filename=f.filename)
            file_results.append(row)
        except (ValueError, RuntimeError) as exc:
            logger.warning("jc create: file %s rejected: %s", f.filename, exc)
            file_results.append({"filename": f.filename, "error": str(exc)})
    pres["files"] = [x for x in file_results if "error" not in x]
    pres["file_errors"] = [x for x in file_results if "error" in x]
    return jsonify(pres), 201


@prionvault_bp.route("/api/jc/<uuid:pid>", methods=["PATCH"])
@admin_required
def api_jc_update(pid):
    from .services import jc as _jc
    data = request.get_json(force=True, silent=True) or {}
    kwargs = {}
    if "presented_at" in data:
        try:
            kwargs["presented_at"] = _parse_iso_date(data["presented_at"])
        except ValueError as exc:
            return jsonify({"error": "invalid_date", "detail": str(exc)}), 400
    if "presenter_name" in data:
        kwargs["presenter_name"] = (data["presenter_name"] or "").strip()
    if "presenter_id" in data:
        kwargs["presenter_id"] = data["presenter_id"] or None
    if not kwargs:
        return jsonify({"error": "no_fields"}), 400
    try:
        ok = _jc.update(pid, **kwargs)
    except ValueError as exc:
        return jsonify({"error": "invalid", "detail": str(exc)}), 400
    except Exception as exc:
        logger.exception("jc update failed for %s", pid)
        return jsonify({"error": "internal_error",
                        "detail": str(exc)[:300]}), 500
    if not ok:
        return jsonify({"error": "not_found"}), 404
    return jsonify({"ok": True})


@prionvault_bp.route("/api/jc/<uuid:pid>", methods=["DELETE"])
@admin_required
def api_jc_delete(pid):
    from .services import jc as _jc
    try:
        ok = _jc.delete(pid)
    except Exception as exc:
        logger.exception("jc delete failed for %s", pid)
        return jsonify({"error": "internal_error",
                        "detail": str(exc)[:300]}), 500
    if not ok:
        return jsonify({"error": "not_found"}), 404
    return jsonify({"ok": True})


@prionvault_bp.route("/api/jc/<uuid:pid>/files", methods=["POST"])
@admin_required
def api_jc_add_files(pid):
    """Attach extra files to an existing presentation."""
    from .services import jc as _jc
    files = (request.files.getlist("file") +
             request.files.getlist("files"))
    files = [f for f in files if f and f.filename]
    if not files:
        return jsonify({"error": "no_files"}), 400
    results = []
    for f in files:
        try:
            row = _jc.add_file(pid, content=f.read(), filename=f.filename)
            results.append(row)
        except LookupError:
            return jsonify({"error": "not_found"}), 404
        except ValueError as exc:
            results.append({"filename": f.filename, "error": str(exc)})
        except RuntimeError as exc:
            results.append({"filename": f.filename, "error": str(exc)})
    return jsonify({"ok": True, "files": results})


@prionvault_bp.route("/api/jc/files/<uuid:fid>", methods=["DELETE"])
@admin_required
def api_jc_delete_file(fid):
    from .services import jc as _jc
    if not _jc.delete_file(fid):
        return jsonify({"error": "not_found"}), 404
    return jsonify({"ok": True})


@prionvault_bp.route("/api/jc/files/<uuid:fid>/url", methods=["GET"])
@login_required
def api_jc_file_url(fid):
    from .services import jc as _jc
    url = _jc.temporary_link(fid)
    if not url:
        return jsonify({"error": "unavailable"}), 502
    return jsonify({"url": url})


# ── Per-article reindex (Phase 4) ───────────────────────────────────────────
@prionvault_bp.route("/api/articles/<uuid:aid>/reindex", methods=["POST"])
@admin_required
def api_article_reindex(aid):
    """Chunk + embed + index a single article via Voyage. Synchronous."""
    from .embeddings.indexer import index_article
    from .embeddings.embedder import NotConfigured as VoyageNotConfigured

    s = _session()
    try:
        a = s.get(models.Article, aid)
        if not a:
            return jsonify({"error": "not found"}), 404
        try:
            result = index_article(
                article_id=a.id,
                title=a.title,
                extracted_text=a.extracted_text,
                summary_ai=a.summary_ai,
                abstract=a.abstract,
            )
        except VoyageNotConfigured:
            return jsonify({"error": "embed_unavailable",
                            "detail": "VOYAGE_API_KEY not set"}), 503
        except Exception as exc:
            logger.exception("reindex failed for %s", aid)
            return jsonify({"error": "index_failed",
                            "detail": str(exc)[:300]}), 502
    finally:
        s.close()

    if result.error:
        return jsonify({"ok": False, "error": result.error,
                        "result": result.__dict__}), 422
    return jsonify({"ok": True, "result": result.__dict__})


# ── Fetch open-access PDF via Unpaywall (Phase 6) ───────────────────────────
@prionvault_bp.route("/api/articles/<uuid:aid>/fetch-pdf", methods=["POST"])
@admin_required
def api_article_fetch_pdf(aid):
    """Try to find an open-access PDF for this article via Unpaywall and
    enqueue it for ingestion. Requires the article to have a DOI and no
    PDF attached yet (returns 409 otherwise).
    """
    from .services.unpaywall import find_open_pdf, download_pdf, NotConfigured as UnpaywallNotConfigured
    from .ingestion import queue as ingest_queue

    s = _session()
    try:
        a = s.get(models.Article, aid)
        if not a:
            return jsonify({"error": "not found"}), 404
        if getattr(a, "dropbox_path", None):
            return jsonify({"error": "already_has_pdf",
                            "dropbox_path": a.dropbox_path}), 409
        doi = (a.doi or "").strip()
        if not doi:
            return jsonify({"error": "no_doi"}), 400
        title = a.title or "article"
    finally:
        s.close()

    try:
        lookup = find_open_pdf(doi)
    except UnpaywallNotConfigured:
        return jsonify({"error": "unpaywall_unavailable",
                        "detail": "UNPAYWALL_EMAIL not set"}), 503
    except Exception as exc:
        logger.exception("Unpaywall lookup failed for %s", doi)
        return jsonify({"error": "lookup_failed",
                        "detail": str(exc)[:300]}), 502

    if not lookup.is_oa or not lookup.pdf_url:
        return jsonify({
            "ok": False,
            "is_oa": lookup.is_oa,
            "landing_url": lookup.landing_url,
            "reason": lookup.error or
                      ("oa_but_no_pdf_url" if lookup.is_oa else "not_open_access"),
        }), 200

    try:
        content = download_pdf(lookup.pdf_url)
    except Exception as exc:
        return jsonify({
            "ok": False,
            "is_oa": True,
            "pdf_url": lookup.pdf_url,
            "reason": "download_failed",
            "detail": str(exc)[:300],
        }), 200

    safe_name = "".join(c if c.isalnum() else "_" for c in doi)[:80] or "article"
    job_id = ingest_queue.enqueue_pdf(
        content=content,
        filename=f"{safe_name}.pdf",
        user_id=_viewer_id(),
    )
    return jsonify({
        "ok": True,
        "is_oa": True,
        "pdf_url": lookup.pdf_url,
        "host_type": lookup.host_type,
        "license": lookup.license,
        "version": lookup.version,
        "size_bytes": len(content),
        "job_id": job_id,
        "title": title,
    })


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
    top_k = data.get("top_k", 20)
    try:
        top_k = max(1, min(50, int(top_k)))
    except (TypeError, ValueError):
        top_k = 20

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
            }
            for c in result.citations
        ],
        "cited_numbers":     result.cited_numbers,
        "tokens_in":         result.tokens_in,
        "tokens_out":        result.tokens_out,
        "cost_usd":          result.cost_usd,
        "elapsed_ms":        result.elapsed_ms,
        "retrieval_ms":      result.retrieval_ms,
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
    return jsonify(summary)


@prionvault_bp.route("/api/admin/migrations/force-rerun", methods=["POST"])
@admin_required
def api_migrations_force_rerun():
    """Delete the applied_migrations tracking rows and re-run all migrations.

    Use this when a migration was recorded as applied but some statements
    actually failed (e.g. CREATE EXTENSION needs superuser). All statements
    use IF NOT EXISTS guards so re-running is safe.

    By default it clears only the two early migrations whose statements
    historically need root privileges (CREATE EXTENSION). Pass a JSON body
    `{"names": ["015_collection_hierarchy.sql", ...]}` to clear additional
    migrations whose recorded apply was incomplete.
    """
    from .migrate import run_pending_migrations
    from sqlalchemy import text as _text
    default_names = ["001_prionvault_tables.sql", "003_fix_step_column.sql"]
    body = request.get_json(silent=True) or {}
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

