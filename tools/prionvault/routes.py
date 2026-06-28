"""PrionVault REST endpoints (core).

Ingestion, PDF streaming, and AI-summary routes live in routes_ingestion.py.
Admin batch-operation routes live in routes_admin.py.
Notification/subscription routes live in routes_notifications.py.
All three are registered on prionvault_bp via side-effect imports at the
bottom of this file.
"""
import logging
import threading
import time
import os
import re
import hashlib
from collections import OrderedDict
from datetime import datetime
from typing import Optional
from flask import jsonify, render_template, request, session, Response, current_app
from sqlalchemy import or_, func, text as sql_text
from sqlalchemy.exc import IntegrityError, DataError

from core.decorators import login_required, admin_required
from database.config import db
from . import prionvault_bp
from . import models
from ._helpers import (_viewer_role, _viewer_id, _session, _ensure_can_modify,  # noqa: F401
                       _get_pv_columns)

logger = logging.getLogger(__name__)


# ── Index page ──────────────────────────────────────────────────────────────
@prionvault_bp.route("/")
@prionvault_bp.route("/index")
@login_required
def index():
    return render_template("prionvault/index.html")


# ── Listing & search ────────────────────────────────────────────────────────
@prionvault_bp.route("/api/articles", methods=["GET", "POST"])
@login_required
def api_list_articles():
    # POST is used when the caller has many selected IDs — PUT them in the
    # JSON body to avoid Railway/nginx URI length limits (400). The body may
    # contain any of the same keys as the query-string; query-string values
    # win on collision so that normal GET behaviour is unaffected.
    _body = {}
    if request.method == "POST":
        _body = request.get_json(silent=True) or {}
    def _p(key, default=""):
        v = request.args.get(key)
        if v is not None:
            return v
        return _body.get(key, default)

    q           = (_p("q") or "").strip()
    # Optional "filter by article id list" — used by the bulk-bar's
    # "Ver sólo seleccionados" button so the operator can keep their
    # selection scoped to a working set even after leaving and
    # re-entering the page. Comma-separated (GET) or list (POST body),
    # capped at 5_000 ids so the IN-list stays reasonable.
    #
    # Preferred path for large selections: POST with ids=[...] in the body,
    # avoiding Railway/nginx URI length limits (→ 400).
    _ids_body = _body.get("ids") if request.method == "POST" else None
    ids_param   = (request.args.get("ids") or "").strip()
    ids_filter: list[str] = []
    _selected_only_requested = request.args.get("selected_only") == "1"
    if _selected_only_requested:
        from .services import user_selection as _us
        viewer_id = _viewer_id()
        ids_filter = _us.list_for_user(viewer_id) if viewer_id else []
    elif _ids_body and isinstance(_ids_body, list):
        ids_filter = [str(x).strip() for x in _ids_body if str(x).strip()][:5000]
    elif ids_param:
        for tok in ids_param.split(","):
            tok = tok.strip()
            if tok:
                ids_filter.append(tok)
        ids_filter = ids_filter[:5000]
    year_min    = _p("year_min") or None
    year_max    = _p("year_max") or None
    if year_min is not None:
        try: year_min = int(year_min)
        except (ValueError, TypeError): year_min = None
    if year_max is not None:
        try: year_max = int(year_max)
        except (ValueError, TypeError): year_max = None
    journal     = (_p("journal") or "").strip()
    authors_q   = (_p("authors") or "").strip()
    tag_id      = _p("tag") or None
    if tag_id is not None:
        try: tag_id = int(tag_id)
        except (ValueError, TypeError): tag_id = None
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
    abstract_status  = (request.args.get("abstract_status") or "").strip().lower() or None
    indexed_status   = (request.args.get("indexed_status") or "").strip().lower() or None
    color_label = (request.args.get("color_label") or "").strip().lower() or None
    priority_eq = request.args.get("priority_eq", type=int)
    extraction = (request.args.get("extraction_status") or "").strip().lower() or None
    is_favorite_raw = request.args.get("is_favorite")
    is_favorite = True if is_favorite_raw == "1" else (False if is_favorite_raw == "0" else None)
    is_read_raw = request.args.get("is_read")
    is_read = True if is_read_raw == "1" else (False if is_read_raw == "0" else None)
    has_pdf_raw = request.args.get("has_pdf")
    has_pdf = True if has_pdf_raw == "true" else (False if has_pdf_raw == "false" else None)
    has_doi_raw = request.args.get("has_doi")
    has_doi = True if has_doi_raw == "true" else (False if has_doi_raw == "false" else None)
    has_pmid_raw = request.args.get("has_pmid")
    has_pmid = True if has_pmid_raw == "true" else (False if has_pmid_raw == "false" else None)
    pdf_source_filter = (request.args.get("source") or "").strip() or None
    pdf_searchable_raw = request.args.get("pdf_searchable")
    pdf_searchable_filter = True if pdf_searchable_raw == "true" else (False if pdf_searchable_raw == "false" else None)
    pdf_is_scan_raw = request.args.get("pdf_is_scan")
    pdf_is_scan_filter = True if pdf_is_scan_raw == "true" else (False if pdf_is_scan_raw == "false" else None)
    needs_indexing_raw = request.args.get("needs_indexing")
    needs_indexing = True if needs_indexing_raw == "true" else None
    has_summary_ai_raw = request.args.get("has_summary_ai")
    has_summary_ai = True if has_summary_ai_raw == "true" else (False if has_summary_ai_raw == "false" else None)
    has_summary_notes_raw = request.args.get("has_summary_notes")
    has_summary_notes = True if has_summary_notes_raw == "true" else None
    pdf_verify_status = (request.args.get("pdf_verify_status") or "").strip() or None
    summary_ai_provider = (request.args.get("summary_ai_provider") or "").strip() or None
    has_title_raw = request.args.get("has_title")
    has_title = True if has_title_raw == "true" else (False if has_title_raw == "false" else None)
    has_authors_raw = request.args.get("has_authors")
    has_authors = True if has_authors_raw == "true" else (False if has_authors_raw == "false" else None)
    has_journal_raw = request.args.get("has_journal")
    has_journal = True if has_journal_raw == "true" else (False if has_journal_raw == "false" else None)
    has_year_raw = request.args.get("has_year")
    has_year = True if has_year_raw == "true" else (False if has_year_raw == "false" else None)
    _sf_raw     = (request.args.get("search_fields") or "").strip()
    search_fields = [f.strip() for f in _sf_raw.split(",") if f.strip() in ("title", "authors", "abstract")] if _sf_raw else []
    sort        = request.args.get("sort", "added_desc")
    page        = max(1, request.args.get("page", 1, type=int))
    page_size   = min(50000, max(1, request.args.get("size", 100, type=int)))

    # selected_only=1 with an empty server-side list means the user has nothing
    # selected (or the PUT hasn't landed yet). Return zero articles instead of
    # falling through to an unfiltered query that would return everything.
    if _selected_only_requested and not ids_filter:
        return jsonify({"items": [], "total": 0, "page": page, "size": page_size,
                        "pages": 0, "q": q})

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
            logger.debug("collection load failed for %s", collection_id, exc_info=True)
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
        return _list_articles_with_recovery(
            s, q, year_min, year_max, journal,
            authors_q,
            is_flagged, is_milestone, color_label,
            priority_eq, extraction, is_favorite, is_read,
            sort, page, page_size,
            search_fields=search_fields,
            tag_id=tag_id, has_summary=has_summary, in_prionread=in_prionread,
            collection_id=collection_id,
            collection_group=collection_group,
            collection_subgroup=collection_subgroup,
            has_jc=has_jc, jc_presenter=jc_presenter, jc_year=jc_year,
            has_pp=has_pp, pp_id=pp_id,
            abstract_status=abstract_status,
            indexed_status=indexed_status,
            ids_filter=ids_filter,
            has_pdf=has_pdf, has_doi=has_doi, has_pmid=has_pmid,
            has_title=has_title, has_authors=has_authors,
            has_journal=has_journal, has_year=has_year,
            pdf_source_filter=pdf_source_filter,
            pdf_searchable_filter=pdf_searchable_filter,
            pdf_is_scan_filter=pdf_is_scan_filter,
            needs_indexing=needs_indexing,
            has_summary_ai=has_summary_ai,
            has_summary_notes=has_summary_notes,
            pdf_verify_status=pdf_verify_status,
            summary_ai_provider=summary_ai_provider,
        )
    except Exception as exc:
        logger.exception("PrionVault api_list_articles failed")
        s.rollback()
        return jsonify({"error": "internal error", "detail": str(exc)}), 500
    finally:
        db.Session.remove()


def _list_articles_with_recovery(s, *args, **kwargs):
    """Thin wrapper around _list_articles_impl that self-heals when the
    Postgres schema has lost a column the per-process column cache still
    thinks exists.

    Symptom this guards against: Railway / Postgres restores have twice
    dropped `pdf_md5` (and similar) AFTER the cache was already populated.
    The first request after a drop fires UndefinedColumn — we invalidate
    the cache, fire the self-heal in the background to re-add the
    column, and rebuild + retry the query without the missing field so
    the user never sees a 500.
    """
    try:
        return _list_articles_impl(s, *args, **kwargs)
    except Exception as exc:
        msg = str(exc).lower()
        if "undefinedcolumn" not in msg and "does not exist" not in msg:
            raise
        logger.warning(
            "list_articles: schema drift detected (%s) — flushing cache, "
            "scheduling self-heal, retrying once.", str(exc)[:200],
        )
        s.rollback()
        global _pv_columns_cache
        _pv_columns_cache = None
        # Kick the self-heal asynchronously so a future request gets
        # the column back. Don't block this request on it.
        try:
            import threading
            from .migrate import _self_heal_schema
            threading.Thread(target=_self_heal_schema,
                             name="prionvault-list-recover-heal",
                             daemon=True).start()
        except Exception:
            logger.debug("schema self-heal thread failed to start", exc_info=True)
        # Retry with the freshly-rebuilt column set.
        return _list_articles_impl(s, *args, **kwargs)


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


# DOI-index cache: rebuilding the {doi → pack_ids} map on every
# /api/articles request was a measurable chunk of the listing time
# (it scans every active pack and parses every reference). The map
# only changes when a pack is created / edited / activated, none of
# which happen often. A 60-second TTL keeps the listing latency
# constant in the steady state without making edit→see-it-in-listing
# feel sluggish.
_DOI_INDEX_TTL_S = 60.0
_doi_index_cache: tuple[float, dict, dict, dict] | None = None
_doi_index_lock = threading.Lock()


def _prionpacks_doi_index() -> tuple[dict, dict, dict]:
    """Returns ({pack_id: pack_title}, {doi_lower: [pack_id, ...]}, {article_id_str: [pack_id, ...]}).
    Empty maps if the prionpacks module fails to load (best effort).
    Cached with a 60 s TTL — see _DOI_INDEX_TTL_S."""
    global _doi_index_cache
    now = time.monotonic()
    cached = _doi_index_cache
    if cached and (now - cached[0]) < _DOI_INDEX_TTL_S:
        return cached[1], cached[2], cached[3]
    with _doi_index_lock:
        cached = _doi_index_cache
        if cached and (now - cached[0]) < _DOI_INDEX_TTL_S:
            return cached[1], cached[2], cached[3]
        titles: dict[str, str] = {}
        doi_to_packs: dict[str, list[str]] = {}
        aid_to_packs: dict[str, list[str]] = {}
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
                    if isinstance(ref, dict) and ref.get("type") == "linked":
                        aid = ref.get("article_id")
                        if aid:
                            bucket = aid_to_packs.setdefault(str(aid), [])
                            if pid not in bucket:
                                bucket.append(pid)
                    else:
                        for doi in _extract_dois(ref):
                            bucket = doi_to_packs.setdefault(doi, [])
                            if pid not in bucket:
                                bucket.append(pid)
            # Resolve linked article_ids → DOIs so DOI-based lookup also works
            if aid_to_packs:
                try:
                    aid_list = list(aid_to_packs.keys())
                    rows = db.session.execute(
                        sql_text("SELECT id::text, doi FROM prionvault_articles WHERE id::text = ANY(:ids) AND doi IS NOT NULL AND doi != ''"),
                        {"ids": aid_list}
                    ).fetchall()
                    for row in rows:
                        aid_str = str(row[0])
                        doi_val = (row[1] or "").strip().lower()
                        if not doi_val:
                            continue
                        for pid in aid_to_packs.get(aid_str, []):
                            bucket = doi_to_packs.setdefault(doi_val, [])
                            if pid not in bucket:
                                bucket.append(pid)
                except Exception as exc2:
                    logger.warning("prionpacks linked-ref DOI resolution failed: %s", exc2)
        except Exception as exc:
            logger.warning("prionpacks DOI index failed: %s", exc)
        _doi_index_cache = (now, titles, doi_to_packs, aid_to_packs)
        return titles, doi_to_packs, aid_to_packs


def _invalidate_doi_index_cache() -> None:
    """Force the next /api/articles call to rebuild the DOI index.
    Call this from any code path that mutates a pack so the listing
    surfaces the new mapping immediately."""
    global _doi_index_cache
    _doi_index_cache = None


@prionvault_bp.route("/api/prionpacks", methods=["GET"])
@login_required
def api_prionpacks_list():
    """Minimal pack list used by the article-listing filter dropdown."""
    titles, _, _aid = _prionpacks_doi_index()
    items = [{"id": pid, "title": t} for pid, t in titles.items()]
    items.sort(key=lambda x: x["id"])
    return jsonify({"items": items})


def _list_articles_impl(s, q, year_min, year_max, journal,
                        authors_q,
                        is_flagged, is_milestone, color_label,
                        priority_eq, extraction,
                        is_favorite, is_read,
                        sort, page, page_size,
                        *, search_fields=None,
                        tag_id=None, has_summary=None, in_prionread=None,
                        collection_id=None,
                        collection_group=None, collection_subgroup=None,
                        has_jc=None, jc_presenter=None, jc_year=None,
                        has_pp=None, pp_id=None,
                        abstract_status=None,
                        indexed_status=None,
                        ids_filter=None,
                        has_pdf=None, has_doi=None, has_pmid=None,
                        has_title=None, has_authors=None, has_journal=None, has_year=None,
                        pdf_source_filter=None, pdf_searchable_filter=None,
                        pdf_is_scan_filter=None, needs_indexing=None,
                        has_summary_ai=None, has_summary_notes=None,
                        pdf_verify_status=None, summary_ai_provider=None):
    """Core of api_list_articles. Separated so the caller can cleanly catch
    all exceptions and still run the finally/remove."""

    # ── Detect which PrionVault columns exist (cached per process) ──────────
    pv_cols = _get_pv_columns(s)

    # ── Build WHERE clause using raw SQL to be resilient to missing cols ────
    conditions = []
    params: dict = {}

    # Hard filter by explicit article-id list (powers the "Ver sólo
    # seleccionados" toggle in the bulk bar). An empty list naturally
    # yields zero rows since ANY('{}') matches nothing.
    if ids_filter:
        conditions.append("articles.id::text = ANY(:ids_filter)")
        params["ids_filter"] = ids_filter

    if q:
        # websearch_to_tsquery (Postgres >= 11) gives the user a
        # Google-like syntax for free:
        #   "prion protein"   — exact phrase
        #   BSE -review       — BSE without "review"
        #   Castilla OR Soto  — either author
        #   Castilla BSE      — both (default AND between bare terms)
        # plainto_tsquery is kept as a fallback for clusters where
        # websearch is unavailable (very old Postgres).
        #
        # `search_fields` restricts which columns are matched.
        # [] / None means all fields (title + abstract + FTS).
        _sf = set(search_fields or []) & {"title", "authors", "abstract"}
        if not _sf:
            # Default: FTS on search_vector OR ILIKE on title/abstract
            conditions.append(
                "(search_vector @@ websearch_to_tsquery('simple', :q) "
                "   OR title ILIKE :q_like "
                "   OR coalesce(authors,'') ILIKE :q_like "
                "   OR coalesce(abstract,'') ILIKE :q_like)"
                if "search_vector" in pv_cols
                else "(title ILIKE :q_like OR coalesce(authors,'') ILIKE :q_like "
                     "OR coalesce(abstract,'') ILIKE :q_like)"
            )
        else:
            parts = []
            if "title"    in _sf: parts.append("title ILIKE :q_like")
            if "authors"  in _sf: parts.append("coalesce(authors,'') ILIKE :q_like")
            if "abstract" in _sf: parts.append("coalesce(abstract,'') ILIKE :q_like")
            conditions.append("(" + " OR ".join(parts) + ")")
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

    # Abstract filter — `pending` is the one the admin actually wants
    # to chase (no abstract yet, never asked PubMed). `unavailable`
    # surfaces papers whose lookup confirmed there's no abstract to
    # find. `has` is the "everything OK" subset.
    if abstract_status == "has":
        conditions.append("coalesce(abstract, '') <> ''")
    elif abstract_status == "pending" and "abstract_unavailable" in pv_cols:
        conditions.append(
            "coalesce(abstract, '') = '' AND abstract_unavailable = FALSE"
        )
    elif abstract_status == "unavailable" and "abstract_unavailable" in pv_cols:
        # Defensive: a row may carry abstract_unavailable=TRUE from
        # before a manual edit pasted the abstract in. Treat "confirmed
        # missing" as "the flag AND the abstract is empty" so the
        # filter only ever surfaces rows the admin actually has to
        # rescue by hand.
        conditions.append(
            "abstract_unavailable = TRUE AND coalesce(abstract, '') = ''"
        )

    if indexed_status == "yes" and "indexed_at" in pv_cols:
        conditions.append("indexed_at IS NOT NULL")
    elif indexed_status == "no" and "indexed_at" in pv_cols:
        conditions.append("indexed_at IS NULL")

    if in_prionread is True:
        conditions.append(
            "EXISTS (SELECT 1 FROM user_articles ua WHERE ua.article_id = articles.id)"
        )
    elif in_prionread is False:
        conditions.append(
            "NOT EXISTS (SELECT 1 FROM user_articles ua WHERE ua.article_id = articles.id)"
        )

    # Per-user marks (migration 037): is_flagged / is_milestone live on
    # prionvault_user_state via the LEFT JOIN _pus added below the
    # filters block. Reading from articles.is_flagged / is_milestone
    # would surface the soon-to-be-deprecated global columns.
    if is_flagged is True:
        conditions.append("_pus.is_flagged IS TRUE")
    elif is_flagged is False:
        conditions.append("(_pus.is_flagged IS NOT TRUE)")   # NULL or FALSE

    if is_milestone is True:
        conditions.append("_pus.is_milestone IS TRUE")
    elif is_milestone is False:
        conditions.append("(_pus.is_milestone IS NOT TRUE)")

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
    pp_titles, pp_doi_to_packs, pp_aid_to_packs = _prionpacks_doi_index()
    if pp_id:
        scoped_dois = [d for d, packs in pp_doi_to_packs.items() if pp_id in packs]
        scoped_aids = [a for a, packs in pp_aid_to_packs.items() if pp_id in packs]
        conditions.append("(lower(doi) = ANY(:pp_scoped_dois) OR id::text = ANY(:pp_scoped_aids))")
        params["pp_scoped_dois"] = scoped_dois or [""]
        params["pp_scoped_aids"] = scoped_aids or [""]
    elif has_pp is True:
        all_pp_dois = list(pp_doi_to_packs.keys())
        all_pp_aids = list(pp_aid_to_packs.keys())
        conditions.append("(lower(doi) = ANY(:pp_all_dois) OR id::text = ANY(:pp_all_aids))")
        params["pp_all_dois"] = all_pp_dois or [""]
        params["pp_all_aids"] = all_pp_aids or [""]
    elif has_pp is False:
        all_pp_dois = list(pp_doi_to_packs.keys())
        all_pp_aids = list(pp_aid_to_packs.keys())
        if all_pp_dois or all_pp_aids:
            conditions.append("(doi IS NULL OR lower(doi) <> ALL(:pp_all_dois)) AND id::text <> ALL(:pp_all_aids)")
            params["pp_all_dois"] = all_pp_dois or [""]
            params["pp_all_aids"] = all_pp_aids or [""]
        # If there are no PrionPacks at all, "sin PrionPack" matches everything → no filter.

    # Per-user marks: read from prionvault_user_state via _pus join.
    if color_label in _VALID_COLOR_LABELS:
        conditions.append("_pus.color_label = :color_label")
        params["color_label"] = color_label
    elif color_label == "none":
        conditions.append("_pus.color_label IS NULL")

    if priority_eq is not None:
        conditions.append("_pus.priority = :priority_eq")
        params["priority_eq"] = priority_eq

    if extraction and "extraction_status" in pv_cols:
        if extraction == "extracted":
            conditions.append("extraction_status = 'extracted'")
        elif extraction == "pending":
            conditions.append("(extraction_status IS NULL OR extraction_status = 'pending')")
        elif extraction == "failed":
            conditions.append("extraction_status = 'failed'")

    # ── Health-dashboard filters ─────────────────────────────────────────────
    if has_pdf is True:
        conditions.append("dropbox_path IS NOT NULL")
    elif has_pdf is False:
        conditions.append("dropbox_path IS NULL")

    if has_doi is True:
        conditions.append("doi IS NOT NULL AND doi <> ''")
    elif has_doi is False:
        conditions.append("(doi IS NULL OR doi = '')")

    if has_pmid is True:
        conditions.append("pubmed_id IS NOT NULL AND pubmed_id <> ''")
    elif has_pmid is False:
        conditions.append("(pubmed_id IS NULL OR pubmed_id = '')")

    if has_title is True:
        conditions.append("title IS NOT NULL AND title <> ''")
    elif has_title is False:
        conditions.append("(title IS NULL OR title = '')")

    if has_authors is True:
        conditions.append("authors IS NOT NULL AND authors <> ''")
    elif has_authors is False:
        conditions.append("(authors IS NULL OR authors = '')")

    if has_journal is True:
        conditions.append("journal IS NOT NULL AND journal <> ''")
    elif has_journal is False:
        conditions.append("(journal IS NULL OR journal = '')")

    if has_year is True:
        conditions.append("year IS NOT NULL")
    elif has_year is False:
        conditions.append("year IS NULL")

    if pdf_source_filter:
        conditions.append("source = :source_filter")
        params["source_filter"] = pdf_source_filter

    if pdf_searchable_filter is True and "pdf_searchable" in pv_cols:
        conditions.append("pdf_searchable = TRUE")
    elif pdf_searchable_filter is False and "pdf_searchable" in pv_cols:
        conditions.append("pdf_searchable = FALSE")

    if pdf_is_scan_filter is True and "pdf_is_scan" in pv_cols:
        conditions.append("pdf_is_scan = TRUE")
    elif pdf_is_scan_filter is False and "pdf_is_scan" in pv_cols:
        conditions.append("pdf_is_scan = FALSE")

    if needs_indexing is True and "indexed_at" in pv_cols:
        conditions.append("indexed_at IS NULL AND extraction_status = 'extracted'")

    if has_summary_ai is True and "summary_ai" in pv_cols:
        conditions.append("summary_ai IS NOT NULL AND summary_ai <> ''")
    elif has_summary_ai is False and "summary_ai" in pv_cols:
        conditions.append("(summary_ai IS NULL OR summary_ai = '')")

    if has_summary_notes is True and "summary_ai_notes" in pv_cols:
        conditions.append("summary_ai_notes IS NOT NULL AND summary_ai_notes <> ''")

    if pdf_verify_status and "pdf_metadata_match_status" in pv_cols:
        if pdf_verify_status == "ok_any":
            conditions.append("pdf_metadata_match_status IN ('ok', 'manual_ok')")
        elif pdf_verify_status == "unverified":
            conditions.append("pdf_metadata_match_status IS NULL")
        else:
            conditions.append("pdf_metadata_match_status = :pdf_verify_status")
            params["pdf_verify_status"] = pdf_verify_status

    if summary_ai_provider and "summary_ai_provider" in pv_cols:
        if summary_ai_provider == "unknown":
            conditions.append("(summary_ai IS NOT NULL AND summary_ai <> '' AND (summary_ai_provider IS NULL OR summary_ai_provider = ''))")
        else:
            conditions.append("summary_ai_provider = :summary_ai_provider")
            params["summary_ai_provider"] = summary_ai_provider

    _viewer_uid = _viewer_id()
    # NOTE: params["_viewer_uid"] is set unconditionally further down
    # (the _pus LEFT JOIN needs it on EVERY query). This block only
    # adds the is_favorite / is_read conditions when requested.
    if _viewer_uid and (is_favorite is not None or is_read is not None):
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

    # `created_at` is now ambiguous because the LEFT JOIN _pus
    # also has one. Qualify with articles.* explicitly. Other
    # columns (year, title, authors, journal) only live on
    # articles so no disambiguation is needed.
    sort_map = {
        "added_desc":    "articles.created_at DESC NULLS LAST",
        "added_asc":     "articles.created_at ASC NULLS FIRST",
        "year_desc":     "year DESC NULLS LAST",
        "year_asc":      "year ASC NULLS FIRST",
        "title_asc":     "lower(title) ASC",
        # Authors / journal collation: use lower() + NULLS LAST so the
        # blanks settle at the bottom regardless of direction, and the
        # comparison is case-insensitive ("Aguzzi" sorts with "aguzzi").
        # Authors field is semicolon-separated; the natural sort by the
        # first surname falls out of the ordinary lexicographic order
        # since that surname is the first token.
        "authors_asc":   "lower(authors) ASC NULLS LAST",
        "authors_desc":  "lower(authors) DESC NULLS LAST",
        "journal_asc":   "lower(journal) ASC NULLS LAST",
        "journal_desc":  "lower(journal) DESC NULLS LAST",
    }
    order = sort_map.get(sort, "created_at DESC NULLS LAST")

    # Build SELECT list: always include base columns; add pv cols if present.
    # NOTE: jc_count used to be a correlated subquery here. With 1 000+
    # rows per page that subquery executed once per row, dominating the
    # listing cost. We now fetch the counts in a single batched
    # GROUP BY query below, keyed by the article ids the main SELECT
    # actually returned — O(1) round-trip regardless of page size.
    # is_milestone / is_flagged / color_label / priority are now read
    # from prionvault_user_state via the LEFT JOIN built below — they
    # are per-user marks since migration 037. The legacy columns on
    # `articles` are kept for one more release cycle as a rollback
    # safety net but no longer participate in the API contract.
    base_cols = ("articles.id, title, authors, year, journal, doi, pubmed_id, "
                 "tags, dropbox_path, dropbox_link, articles.created_at, articles.updated_at, "
                 "COALESCE(_pus.is_milestone, FALSE) AS is_milestone, "
                 "COALESCE(_pus.is_flagged,   FALSE) AS is_flagged, "
                 "_pus.color_label                  AS color_label, "
                 "_pus.priority                     AS priority")
    pv_select = ", ".join(
        c for c in
        ["pdf_md5", "pdf_pages", "pdf_is_scan",
         "extraction_status", "indexed_at",
         # summary_ai / summary_human / abstract intentionally excluded from the
         # list query — they are large TEXT fields only needed in the detail
         # view (fetched by GET /api/articles/<id>). The list only needs the
         # boolean flags below.
         "source",
         "abstract_unavailable", "pdf_oa_status",
         "pdf_metadata_match_status", "summary_ai_provider",
         "summary_ai_model",
         "summary_tokens_in", "summary_tokens_out"]
        if c in pv_cols
    )
    # has_summary_* are computed booleans — cheaper than transferring full text.
    has_flags = ", ".join(
        f"(({c}) IS NOT NULL AND ({c}) <> '') AS has_{c}"
        for c in ["summary_ai", "summary_human", "abstract"]
        if c in pv_cols
    )
    if has_flags:
        select_cols = base_cols + (f", {pv_select}" if pv_select else "") + f", {has_flags}"
    else:
        select_cols = base_cols + (f", {pv_select}" if pv_select else "")

    # The per-user state JOIN is attached unconditionally so every
    # row carries the viewer's marks (or NULL defaults if they have
    # no row yet for that article). _viewer_uid is captured at
    # endpoint entry and always passed in params below.
    _viewer_uid_str = str(_viewer_uid) if _viewer_uid else None
    params["_viewer_uid"] = _viewer_uid_str

    join_parts = [
        "FROM articles",
        "LEFT JOIN prionvault_user_state _pus "
        "       ON _pus.article_id = articles.id "
        "      AND _pus.user_id = CAST(:_viewer_uid AS uuid)",
    ]
    if tag_id:
        # Per-user tag filter (migration 038): only surface articles
        # where the CURRENT VIEWER tagged them, not just anyone.
        # Without the added_by clause readers would see articles
        # admins tagged but they themselves didn't, which contradicts
        # the new per-user semantics.
        join_parts.append(
            "JOIN article_tag_link ON article_tag_link.article_id = articles.id "
            "AND article_tag_link.tag_id  = :tag_id "
            "AND article_tag_link.added_by = CAST(:_viewer_uid AS uuid)"
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
            aids = _coll.aggregate_article_ids(
                cids, viewer_id=_viewer_uid) if cids else []
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

    # Single query: window COUNT(*) avoids a second round-trip to the DB.
    offset = (page - 1) * page_size
    params["limit"] = page_size
    params["offset"] = offset
    list_sql = sql_text(
        f"SELECT {select_cols}, COUNT(*) OVER() AS _total_count "
        f"{from_clause} {where} ORDER BY {order} LIMIT :limit OFFSET :offset"
    )
    rows = s.execute(list_sql, params).all()
    total = int(rows[0]._mapping["_total_count"]) if rows else 0
    col_names = list(rows[0]._fields) if rows else []

    # ── PrionRead counts (separate session) ─────────────────────────────────
    prionread_counts = {}
    rating_aggs = {}        # aid -> {"avg": float, "count": int}
    my_ratings  = {}        # aid -> int (viewer's rating, if any)
    user_states = {}        # aid -> {"is_favorite": bool, "is_read": bool, "read_at": iso}
    # jc_count was previously a correlated subquery in the main SELECT.
    # Now batched here as one GROUP BY scan over the JC table.
    jc_counts: dict = {}    # aid -> int
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

                # jc_count: batched GROUP BY against the JC table,
                # indexed via 034_articles_perf_indexes.sql. Articles
                # with no presentation simply don't appear in the
                # result map — _row_to_dict defaults missing keys to 0.
                jc_rows = _s2.execute(sql_text(
                    "SELECT article_id, COUNT(*) "
                    "  FROM prionvault_jc_presentation "
                    " WHERE article_id = ANY(CAST(:ids AS uuid[])) "
                    " GROUP BY article_id"
                ), {"ids": [str(i) for i in item_ids]}).all()
                jc_counts = {r[0]: int(r[1]) for r in jc_rows}

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
        aid_str = str(d["id"])
        pp_ids_by_doi = pp_doi_to_packs.get(adoi, []) if adoi else []
        pp_ids_by_aid = pp_aid_to_packs.get(aid_str, [])
        pp_ids = list({*pp_ids_by_doi, *pp_ids_by_aid})
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
            "has_abstract":  bool(d.get("has_abstract")),
            "abstract_unavailable": bool(d.get("abstract_unavailable")),
            "has_pdf":       bool(d.get("dropbox_path")),
            "source":        d.get("source"),
            "pdf_oa_status": d.get("pdf_oa_status"),
            "jc_count":      int(jc_counts.get(aid, 0)),
            "has_jc":        bool(jc_counts.get(aid, 0)),
            "extraction_status": d.get("extraction_status") or "pending",
            "indexed_at":    d["indexed_at"].isoformat() if d.get("indexed_at") else None,
            "added_at":      d["created_at"].isoformat() if d.get("created_at") else None,
            "has_summary_ai":       bool(d.get("has_summary_ai")),
            "summary_ai_provider":  d.get("summary_ai_provider") if d.get("has_summary_ai") else None,
            "summary_ai_model":     d.get("summary_ai_model")    if d.get("has_summary_ai") else None,
            "summary_tokens_in":    int(d["summary_tokens_in"]) if d.get("summary_tokens_in") else None,
            "summary_tokens_out":   int(d["summary_tokens_out"]) if d.get("summary_tokens_out") else None,
            "has_summary_human": bool(d.get("has_summary_human")),
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
            out["pdf_md5"]               = d.get("pdf_md5")
            out["pdf_dropbox_path"]      = d.get("dropbox_path")
            out["pdf_verify_status"]     = d.get("pdf_metadata_match_status")
        return out

    import uuid as _uuid
    return jsonify({
        "items": [_row_to_dict(r) for r in rows],
        "total": total,
        "page":  page,
        "size":  page_size,
    })




@prionvault_bp.route("/api/articles/<uuid:aid>", methods=["GET"])
@login_required
def api_article_detail(aid):
    s = _session()
    try:
        pv_cols = _get_pv_columns(s)

        # Per-user marks: read from prionvault_user_state via LEFT JOIN
        # so the detail view shows THIS user's flag / milestone / color /
        # priority — same per-user semantics as the listing endpoint.
        # Build SELECT list dynamically so missing migration columns don't 500.
        base_cols = (
            "articles.id, title, authors, year, journal, doi, pubmed_id, abstract, "
            "tags, "
            "COALESCE(_pus.is_milestone, FALSE) AS is_milestone, "
            "COALESCE(_pus.is_flagged,   FALSE) AS is_flagged, "
            "_pus.color_label                  AS color_label, "
            "_pus.priority                     AS priority, "
            "dropbox_path, dropbox_link, articles.created_at, articles.updated_at, "
            "(SELECT COUNT(*) FROM prionvault_jc_presentation jp "
            " WHERE jp.article_id = articles.id) AS jc_count"
        )
        optional = [
            "pdf_md5", "pdf_size_bytes", "pdf_pages", "pdf_is_scan",
            "extraction_status", "extraction_error",
            "summary_ai", "summary_human", "summary_ai_notes",
            "indexed_at", "index_version",
            "source", "source_metadata", "added_by_id",
            "abstract_unavailable", "pubmed_unavailable",
            "pdf_metadata_match_status", "pdf_metadata_match_score",
            "pdf_metadata_match_detail", "pdf_metadata_match_checked_at",
            "summary_ai_provider", "summary_ai_model",
            "summary_tokens_in", "summary_tokens_out",
        ]
        pv_select = ", ".join(c for c in optional if c in pv_cols)
        select_cols = base_cols + (f", {pv_select}" if pv_select else "")

        _vuid = _viewer_id()
        row = s.execute(
            sql_text(
                f"SELECT {select_cols} FROM articles "
                f" LEFT JOIN prionvault_user_state _pus "
                f"        ON _pus.article_id = articles.id "
                f"       AND _pus.user_id = CAST(:_vuid AS uuid) "
                f" WHERE articles.id = :aid"
            ),
            {"aid": str(aid), "_vuid": str(_vuid) if _vuid else None},
        ).first()

        if row is None:
            return jsonify({"error": "not found"}), 404

        d = dict(zip(row._fields, row))

        # Fetch summary-related columns directly, bypassing the pv_cols cache.
        # These columns may have been added after the cache was populated, so
        # they could be absent from pv_select even though they exist in the DB.
        # Each column is fetched individually so a missing column causes only
        # that key to be skipped, not the whole request.
        for _col in ("summary_ai_notes", "summary_ai_provider",
                     "summary_tokens_in", "summary_tokens_out"):
            if _col not in d:
                try:
                    _r = s.execute(
                        sql_text(f"SELECT {_col} FROM articles WHERE id = :aid"),
                        {"aid": str(aid)},
                    ).first()
                    d[_col] = _r[0] if _r else None
                except Exception:
                    d.setdefault(_col, None)
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
            "has_abstract":  bool((d.get("abstract") or "").strip()),
            "abstract_unavailable": bool(d.get("abstract_unavailable")),
            "has_pdf":       bool(d.get("dropbox_path")),
            "source":        d.get("source"),
            "pdf_oa_status": d.get("pdf_oa_status"),
            "jc_count":      int(d.get("jc_count") or 0),
            "has_jc":        bool(d.get("jc_count") or 0),
            "extraction_status": d.get("extraction_status") or "pending",
            "extraction_error":  d.get("extraction_error"),
            "indexed_at":    d["indexed_at"].isoformat() if d.get("indexed_at") else None,
            "added_at":      d["created_at"].isoformat() if d.get("created_at") else None,
            "abstract":      d.get("abstract"),
            "summary_ai":    d.get("summary_ai"),
            "summary_human": d.get("summary_human"),
            "summary_ai_notes": d.get("summary_ai_notes"),
            "summary_ai_provider":  d.get("summary_ai_provider") if bool(d.get("summary_ai")) else None,
            "summary_ai_model":     d.get("summary_ai_model") if bool(d.get("summary_ai")) else None,
            "summary_tokens_in":    int(d["summary_tokens_in"]) if d.get("summary_tokens_in") else None,
            "summary_tokens_out":   int(d["summary_tokens_out"]) if d.get("summary_tokens_out") else None,
            "has_summary_ai":    bool(d.get("summary_ai")),
            "has_summary_human": bool(d.get("summary_human")),
            "in_prionread":  False,  # enriched below
        }
        # PDF metadata verification (admin-only, only when verification has run)
        _pmms = d.get("pdf_metadata_match_status")
        if is_admin and _pmms:
            _ca = d.get("pdf_metadata_match_checked_at")
            out["pdf_verify"] = {
                "status":     _pmms,
                "score":      d.get("pdf_metadata_match_score"),
                "detail":     d.get("pdf_metadata_match_detail"),
                "checked_at": _ca.isoformat() if hasattr(_ca, "isoformat") else _ca,
            }

        if is_admin:
            out["pdf_md5"]          = d.get("pdf_md5")
            out["pdf_size_bytes"]   = d.get("pdf_size_bytes")
            out["pdf_dropbox_path"] = d.get("dropbox_path")

        # Per-user tag chips (migration 038): show only the tags the
        # CURRENT VIEWER has assigned to this article, not anyone
        # else's.
        try:
            from sqlalchemy.orm import Session as _SASession
            with _SASession(db.engine) as _s2:
                tag_rows = _s2.execute(sql_text(
                    "SELECT t.id, t.name, t.color "
                    "  FROM article_tag t "
                    "  JOIN article_tag_link l ON l.tag_id = t.id "
                    " WHERE l.article_id = :aid "
                    "   AND l.added_by   = CAST(:vuid AS uuid)"
                ), {"aid": str(aid),
                    "vuid": str(_vuid) if _vuid else None}).all()
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
                  COUNT(*) FILTER (WHERE indexed_at IS NOT NULL) AS indexed,
                  COUNT(*) FILTER (WHERE summary_human IS NOT NULL
                                     AND summary_human <> '') AS with_notes
                FROM articles
            """)).first()
            return jsonify({
                "total":           row[0] if row else 0,
                "with_summary_ai": row[1] if row else 0,
                "with_extraction": row[2] if row else 0,
                "indexed":         row[3] if row else 0,
                "with_notes":      row[4] if row else 0,
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


@prionvault_bp.route("/api/articles/health", methods=["GET"])
@login_required
def api_article_health():
    """Aggregate counts for the Library Health dashboard."""
    s = _session()
    try:
        pv_cols = _get_pv_columns(s)

        def _col(col, expr_true, expr_false="0"):
            if col in pv_cols:
                return expr_true
            return expr_false

        pdf_needs_searchable_expr = (
            "COUNT(*) FILTER (WHERE dropbox_path IS NOT NULL"
            + (" AND pdf_searchable = FALSE" if "pdf_searchable" in pv_cols else "")
            + (" AND pdf_ocr_unavailable = FALSE" if "pdf_ocr_unavailable" in pv_cols else "")
            + ")"
        )

        # Resolve the active embedding model — needed to distinguish
        # "indexed with current model" from "indexed with old model".
        # We import lazily so a missing voyager key doesn't crash the page.
        current_embed_model = None
        if "index_version" in pv_cols:
            try:
                from .embeddings.embedder import MODEL as _EMBED_MODEL
                current_embed_model = _EMBED_MODEL
            except Exception:
                pass

        if current_embed_model and "index_version" in pv_cols:
            indexed_expr = (
                f"COUNT(*) FILTER (WHERE indexed_at IS NOT NULL "
                f"AND index_version = :embed_model)"
            )
            needs_indexing_expr = (
                "COUNT(*) FILTER (WHERE "
                + ("((extracted_text IS NOT NULL AND length(extracted_text) > 200) "
                   "OR (summary_ai IS NOT NULL AND length(summary_ai) > 100) "
                   "OR (abstract IS NOT NULL AND length(abstract) > 100)) AND " if "extraction_status" in pv_cols else "")
                + "(indexed_at IS NULL OR index_version IS DISTINCT FROM :embed_model))"
            )
        else:
            indexed_expr = (
                "COUNT(*) FILTER (WHERE indexed_at IS NOT NULL)"
                if "indexed_at" in pv_cols else "0"
            )
            needs_indexing_expr = (
                "COUNT(*) FILTER (WHERE indexed_at IS NULL"
                + (" AND extraction_status = 'extracted'" if "extraction_status" in pv_cols else "")
                + ")"
                if "indexed_at" in pv_cols else "0"
            )

        query = f"""
            SELECT
              COUNT(*)                                                            AS total,
              COUNT(*) FILTER (WHERE dropbox_path IS NOT NULL)                   AS with_pdf,
              COUNT(*) FILTER (WHERE dropbox_path IS NULL)                       AS without_pdf,
              COUNT(*) FILTER (WHERE doi IS NOT NULL AND doi <> '')              AS with_doi,
              COUNT(*) FILTER (WHERE doi IS NULL OR doi = '')                    AS without_doi,
              COUNT(*) FILTER (WHERE pubmed_id IS NOT NULL AND pubmed_id <> '')  AS with_pmid,
              COUNT(*) FILTER (WHERE pubmed_id IS NULL OR pubmed_id = '')        AS without_pmid,
              COUNT(*) FILTER (WHERE abstract IS NOT NULL AND abstract <> '')    AS with_abstract,
              {_col("abstract_unavailable",
                    "COUNT(*) FILTER (WHERE (abstract IS NULL OR abstract = '') AND abstract_unavailable IS NOT TRUE)",
                    "COUNT(*) FILTER (WHERE abstract IS NULL OR abstract = '')")} AS without_abstract,
              {_col("pdf_is_scan",
                    "COUNT(*) FILTER (WHERE pdf_is_scan = TRUE)")}               AS pdf_ocr,
              {_col("pdf_searchable",
                    "COUNT(*) FILTER (WHERE pdf_searchable = TRUE)")}            AS pdf_searchable,
              {_col("pdf_searchable", pdf_needs_searchable_expr)}                AS pdf_needs_searchable,
              {_col("extraction_status",
                    "COUNT(*) FILTER (WHERE extraction_status = 'extracted')")}  AS text_extracted,
              {_col("extraction_status",
                    "COUNT(*) FILTER (WHERE extraction_status = 'pending' OR extraction_status IS NULL)")} AS text_pending,
              {_col("extraction_status",
                    "COUNT(*) FILTER (WHERE extraction_status = 'failed')")}     AS text_failed,
              {indexed_expr}                                                     AS indexed,
              {needs_indexing_expr}                                               AS needs_indexing,
              {_col("summary_ai",
                    "COUNT(*) FILTER (WHERE summary_ai IS NOT NULL AND summary_ai <> '')")} AS with_summary_ai,
              {_col("summary_human",
                    "COUNT(*) FILTER (WHERE summary_human IS NOT NULL AND summary_human <> '')")} AS with_summary_human,
              {_col("source",
                    "COUNT(*) FILTER (WHERE source = 'pubmed_inventory')")}      AS from_inventory,
              {_col("source",
                    "COUNT(*) FILTER (WHERE source = 'manual')")}                AS from_manual,
              {_col("pdf_pages",
                    "COUNT(*) FILTER (WHERE pdf_pages IS NOT NULL)")}            AS with_page_count,
              {_col("pdf_pages",
                    "COUNT(*) FILTER (WHERE pdf_pages IS NULL AND dropbox_path IS NOT NULL)")} AS missing_page_count,
              {_col("summary_ai_notes",
                    "COUNT(*) FILTER (WHERE summary_ai_notes IS NOT NULL AND summary_ai_notes <> '')",
                    "0")}                                                           AS with_summary_notes,
              {_col("pdf_metadata_match_status",
                    "COUNT(*) FILTER (WHERE pdf_metadata_match_status = 'mismatch')",
                    "0")}                                                           AS verify_mismatch,
              {_col("pdf_metadata_match_status",
                    "COUNT(*) FILTER (WHERE pdf_metadata_match_status = 'suspect')",
                    "0")}                                                           AS verify_suspect,
              {_col("pdf_metadata_match_status",
                    "COUNT(*) FILTER (WHERE pdf_metadata_match_status IN ('ok','manual_ok'))",
                    "0")}                                                           AS verify_ok,
              {_col("pdf_metadata_match_status",
                    "COUNT(*) FILTER (WHERE pdf_metadata_match_status IS NULL AND dropbox_path IS NOT NULL)",
                    "0")}                                                           AS verify_pending,
              {_col("summary_ai_provider",
                    "COUNT(*) FILTER (WHERE summary_ai_provider = 'anthropic')",
                    "0")}                                                           AS summary_by_claude,
              {_col("summary_ai_provider",
                    "COUNT(*) FILTER (WHERE summary_ai_provider = 'openai')",
                    "0")}                                                           AS summary_by_gpt,
              {_col("summary_ai_provider",
                    "COUNT(*) FILTER (WHERE summary_ai_provider = 'gemini')",
                    "0")}                                                           AS summary_by_gemini,
              {_col("summary_ai_provider",
                    "COUNT(*) FILTER (WHERE summary_ai IS NOT NULL AND summary_ai <> '' AND (summary_ai_provider IS NULL OR summary_ai_provider = ''))",
                    "0")}                                                           AS summary_by_unknown,
              {_col("summary_tokens_in",
                    "COALESCE(SUM(summary_tokens_in)  FILTER (WHERE summary_ai_provider = 'anthropic'), 0)",
                    "0")}                                                           AS tokens_claude_in,
              {_col("summary_tokens_out",
                    "COALESCE(SUM(summary_tokens_out) FILTER (WHERE summary_ai_provider = 'anthropic'), 0)",
                    "0")}                                                           AS tokens_claude_out,
              {_col("summary_tokens_in",
                    "COALESCE(SUM(summary_tokens_in)  FILTER (WHERE summary_ai_provider = 'openai'), 0)",
                    "0")}                                                           AS tokens_gpt_in,
              {_col("summary_tokens_out",
                    "COALESCE(SUM(summary_tokens_out) FILTER (WHERE summary_ai_provider = 'openai'), 0)",
                    "0")}                                                           AS tokens_gpt_out,
              {_col("summary_tokens_in",
                    "COALESCE(SUM(summary_tokens_in)  FILTER (WHERE summary_ai_provider = 'gemini'), 0)",
                    "0")}                                                           AS tokens_gemini_in,
              {_col("summary_tokens_out",
                    "COALESCE(SUM(summary_tokens_out) FILTER (WHERE summary_ai_provider = 'gemini'), 0)",
                    "0")}                                                           AS tokens_gemini_out,
              COUNT(*) FILTER (WHERE title IS NULL OR title = '')                    AS missing_title,
              COUNT(*) FILTER (WHERE authors IS NULL OR authors = '')                AS missing_authors,
              COUNT(*) FILTER (WHERE journal IS NULL OR journal = '')                AS missing_journal,
              COUNT(*) FILTER (WHERE year IS NULL)                                   AS missing_year,
              COUNT(*) FILTER (WHERE abstract IS NULL OR abstract = '')              AS missing_abstract,
              COUNT(*) FILTER (WHERE doi IS NULL OR doi = '')                        AS missing_doi,
              COUNT(*) FILTER (WHERE pubmed_id IS NULL OR pubmed_id = '')            AS missing_pmid
            FROM articles
        """
        query_params = {}
        if current_embed_model:
            query_params["embed_model"] = current_embed_model
        row = s.execute(sql_text(query), query_params).first()
        keys = [
            "total", "with_pdf", "without_pdf",
            "with_doi", "without_doi",
            "with_pmid", "without_pmid",
            "with_abstract", "without_abstract",
            "pdf_ocr", "pdf_searchable", "pdf_needs_searchable",
            "text_extracted", "text_pending", "text_failed",
            "indexed", "needs_indexing",
            "with_summary_ai", "with_summary_human",
            "from_inventory", "from_manual",
            "with_page_count", "missing_page_count",
            "with_summary_notes",
            "verify_mismatch", "verify_suspect", "verify_ok", "verify_pending",
            "summary_by_claude", "summary_by_gpt", "summary_by_gemini", "summary_by_unknown",
            "tokens_claude_in", "tokens_claude_out",
            "tokens_gpt_in", "tokens_gpt_out",
            "tokens_gemini_in", "tokens_gemini_out",
            "missing_title", "missing_authors", "missing_journal", "missing_year",
            "missing_abstract", "missing_doi", "missing_pmid",
        ]
        result = {k: int(row[i]) if row and row[i] is not None else 0
                  for i, k in enumerate(keys)}
        result["embed_model"] = current_embed_model or "unknown"
        return jsonify(result)
    except Exception as exc:
        logger.exception("PrionVault api_article_health failed")
        s.rollback()
        return jsonify({"error": "internal error", "detail": str(exc)}), 500
    finally:
        db.Session.remove()


# ── Tags (read available to all, write admin-only) ──────────────────────────
@prionvault_bp.route("/api/tags", methods=["GET"])
@login_required
def api_list_tags():
    """List every tag the dictionary knows about, with `count` reflecting
    how many articles the CURRENT VIEWER has tagged with each. The
    dictionary itself stays global (admins curate the palette) — only
    the assignments are per-user since migration 038."""
    s = _session()
    try:
        rows = s.execute(sql_text(
            """
            SELECT t.id, t.name, t.color,
                   count(l.article_id) FILTER (WHERE l.added_by = CAST(:vuid AS uuid))
                                       AS n_articles
              FROM article_tag t
         LEFT JOIN article_tag_link l ON l.tag_id = t.id
          GROUP BY t.id
          ORDER BY t.name
            """
        ), {"vuid": str(_viewer_id()) if _viewer_id() else None}).all()
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
@login_required
def api_create_tag():
    """Add a tag to the shared dictionary. Open to any logged-in
    user — the dictionary is global so the same tag name + color
    can be reused by everyone in the lab."""
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip()
    color = (data.get("color") or "").strip() or None
    if not name:
        return jsonify({"error": "name required"}), 400
    s = _session()
    try:
        # Tag names must be unique by DB constraint. Surface a 409
        # when the user tries to re-create an existing tag so the
        # UI can recover gracefully (most often the operator types
        # a name that already exists and just wants to attach it).
        existing = s.execute(sql_text(
            "SELECT id, name, color FROM article_tag WHERE lower(name) = lower(:n)"
        ), {"n": name}).first()
        if existing:
            return jsonify({"id": existing.id, "name": existing.name,
                            "color": existing.color}), 200
        t = models.ArticleTag(name=name, color=color,
                              created_by=_viewer_id())
        s.add(t)
        s.commit()
        return jsonify(t.to_dict()), 201
    except Exception as e:
        s.rollback()
        return jsonify({"error": str(e)}), 400
    finally:
        s.close()


@prionvault_bp.route("/api/articles/<uuid:aid>/tags/<int:tag_id>", methods=["PUT"])
@login_required
def api_attach_tag(aid, tag_id):
    """Attach a tag to an article FOR THE CURRENT VIEWER. With migration
    038 the PK includes added_by, so two operators each tagging the
    same article with the same tag coexist as separate rows — and
    each one only sees their own assignments."""
    s = _session()
    try:
        a = s.get(models.Article, aid)
        if not a:
            return jsonify({"error": "article not found"}), 404
        t = s.get(models.ArticleTag, tag_id)
        if not t:
            return jsonify({"error": "tag not found"}), 404
        vid = _viewer_id()
        if not vid:
            return jsonify({"error": "not_authenticated"}), 401
        # Per-user composite key now: (article_id, tag_id, added_by).
        s.execute(sql_text(
            """
            INSERT INTO article_tag_link (article_id, tag_id, added_by)
            VALUES (:aid, :tid, CAST(:uid AS uuid))
            ON CONFLICT (article_id, tag_id, added_by) DO NOTHING
            """
        ), {"aid": str(aid), "tid": tag_id, "uid": str(vid)})
        s.commit()
        return jsonify({"ok": True})
    finally:
        s.close()


@prionvault_bp.route("/api/articles/<uuid:aid>/tags/<int:tag_id>", methods=["DELETE"])
@login_required
def api_detach_tag(aid, tag_id):
    """Remove THE VIEWER'S assignment of `tag_id` on `aid`. Doesn't
    affect anyone else's tagging of the same article."""
    s = _session()
    try:
        vid = _viewer_id()
        if not vid:
            return jsonify({"error": "not_authenticated"}), 401
        s.execute(sql_text(
            """
            DELETE FROM article_tag_link
             WHERE article_id = :aid
               AND tag_id     = :tid
               AND added_by   = CAST(:uid AS uuid)
            """
        ), {"aid": str(aid), "tid": tag_id, "uid": str(vid)})
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


# ── Article write endpoints (metadata admin-only, per-user marks open) ──────
_EDITABLE_FIELDS = {
    "title", "authors", "year", "journal", "doi", "pubmed_id",
    "abstract", "summary_ai", "summary_human", "summary_ai_provider",
    "summary_ai_notes", "is_milestone",
    "is_flagged", "color_label", "priority",
}
# Subset of _EDITABLE_FIELDS that became per-user in migration 037.
# A regular reader is allowed to PATCH these; everything else stays
# behind the admin gate (article metadata is shared so misedits
# would affect everyone).
_PER_USER_MARKS = {"is_flagged", "is_milestone", "color_label", "priority"}


@prionvault_bp.route("/api/articles/<uuid:aid>", methods=["PATCH"])
@login_required
def api_article_update(aid):
    # Gate: metadata edits remain admin-only; per-user marks (is_flagged,
    # is_milestone, color_label, priority) are open to any logged-in
    # user since migration 037 moved them off the global articles row.
    # We split here in-endpoint rather than via a separate URL so the
    # frontend keeps using one PATCH call for the common
    # "flip color + edit title" mixed payload — the server tells the
    # client exactly which fields, if any, it rejected.
    data = request.get_json(force=True, silent=True) or {}
    updates = {k: v for k, v in data.items() if k in _EDITABLE_FIELDS}
    if not updates:
        return jsonify({"error": "no editable fields in payload"}), 400

    # Per-user gate: a reader can only PATCH _PER_USER_MARKS.
    # Anything else needs admin role. Tell the caller exactly which
    # fields were rejected so the UI can recover gracefully.
    is_admin = (_viewer_role() == "admin")
    if not is_admin:
        metadata_requested = set(updates) - _PER_USER_MARKS
        if metadata_requested:
            return jsonify({
                "error":            "admin_required",
                "detail":           "Only admins can edit article metadata.",
                "rejected_fields":  sorted(metadata_requested),
            }), 403

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

    if "summary_ai_provider" in updates:
        v = updates["summary_ai_provider"]
        if v in ("", None):
            updates["summary_ai_provider"] = None
        elif v not in ("anthropic", "openai", "gemini"):
            return jsonify({"error": "invalid summary_ai_provider",
                            "allowed": ["anthropic", "openai", "gemini", None]}), 400

    # Allow explicitly clearing summary_ai_notes (pass null/empty string)
    if "summary_ai_notes" in updates:
        v = updates["summary_ai_notes"]
        updates["summary_ai_notes"] = v if (v and str(v).strip()) else None

    # If the admin is filling in an abstract by hand, clear the
    # "confirmed unavailable" flag so the row stops showing under
    # that filter and the "📕 sin abstract" chip disappears.
    if updates.get("abstract") and isinstance(updates["abstract"], str) \
            and updates["abstract"].strip():
        updates["abstract_unavailable"] = False

    # Per-user marks (migration 037): peel these four off the updates
    # dict — they do NOT touch articles.* anymore; they upsert into
    # prionvault_user_state for the current viewer. Validation above
    # already normalised them, so we just need to route them.
    _per_user_marks = {}
    for _k in ("is_flagged", "is_milestone", "color_label", "priority"):
        if _k in updates:
            _per_user_marks[_k] = updates.pop(_k)

    s = _session()
    try:
        a = s.get(models.Article, aid)
        if not a:
            return jsonify({"error": "not found"}), 404

        # Pre-check uniqueness for the two columns whose constraint
        # violation we want to translate into a clean 409. The edit
        # modal's "Buscar de nuevo" already warns when the looked-up
        # DOI/PMID match another article, but the user can still
        # press Save — catching it here turns a 500 + Sentry alert
        # into a usable response with `duplicate_of`.
        for col, src in (("doi", "doi"), ("pubmed_id", "pubmed_id")):
            new_val = updates.get(col)
            if not new_val or not isinstance(new_val, str):
                continue
            new_val = new_val.strip()
            if not new_val:
                continue
            pred = f"lower({col}) = lower(:v)" if col == "doi" else f"{col} = :v"
            row = s.execute(sql_text(
                f"SELECT id FROM articles WHERE {pred} AND id <> :self LIMIT 1"
            ), {"v": new_val, "self": str(aid)}).first()
            if row:
                return jsonify({
                    "error":        "duplicate",
                    "duplicate_of": str(row[0]),
                    "matched_on":   col,
                }), 409

        # Use raw SQL to bypass any ORM mapper column-declaration gaps.
        if updates:
            _set_clauses = ", ".join(f"{k} = :{k}" for k in updates)
            s.execute(sql_text(
                f"UPDATE articles SET {_set_clauses}, updated_at = NOW() WHERE id = CAST(:_aid AS uuid)"
            ), {**updates, "_aid": str(aid)})

        # Upsert per-user marks for the current viewer. We do this
        # inside the same session so a downstream commit error rolls
        # both pieces back together (the user shouldn't see a
        # partial save).
        if _per_user_marks:
            _uid = _viewer_id()
            if _uid:
                _cols = list(_per_user_marks.keys())
                _set  = ", ".join(f"{c} = EXCLUDED.{c}" for c in _cols)
                _vals = ", ".join(f":{c}" for c in _cols)
                _params = {"u": str(_uid), "a": str(aid), **_per_user_marks}
                s.execute(sql_text(
                    f"""
                    INSERT INTO prionvault_user_state
                      (user_id, article_id, {', '.join(_cols)})
                    VALUES (CAST(:u AS uuid), CAST(:a AS uuid), {_vals})
                    ON CONFLICT (user_id, article_id) DO UPDATE
                       SET {_set}
                    """
                ), _params)

        try:
            s.commit()
        except IntegrityError as exc:
            # Race against a concurrent INSERT that flipped a DOI/PMID
            # between the SELECT above and this commit. Roll back so
            # the session is reusable and surface the same 409 shape.
            s.rollback()
            return jsonify({
                "error":  "duplicate",
                "detail": str(exc.orig)[:200] if exc.orig else str(exc)[:200],
            }), 409
        except DataError as exc:
            # Almost always the StringDataRightTruncation that fires
            # when articles.title (or another column) is still VARCHAR(
            # 255) on production because migration 022/023 didn't take.
            # Convert the 500 into a 422 so the user (and Sentry) get a
            # clean, actionable message instead of an unhandled-error
            # alert.
            s.rollback()
            msg = str(exc.orig)[:300] if getattr(exc, "orig", None) else str(exc)[:300]
            logger.warning("api_article_update %s: DataError — %s", aid, msg)
            return jsonify({
                "error":  "value_too_long",
                "detail": ("Algún campo supera el límite de su columna "
                           "(casi siempre title > 255 chars). Esquema "
                           "desactualizado en producción: corre la migración "
                           "023 desde /api/admin/migrations/force-rerun con "
                           "{\"names\":[\"023_articles_text_columns_verified.sql\"]} "
                           "o reploy para que se aplique sola."),
                "db_error": msg,
            }), 422

        # Auto-link to PrionPack collections that cite this DOI. The
        # PATCH form lets admins paste / correct a DOI by hand, which
        # is the moment the link makes sense. Best-effort — failures
        # are logged and swallowed.
        new_doi = (updates.get("doi") or "").strip()
        if new_doi:
            try:
                from .services.prionpack_sync import sync_doi
                sync_doi(new_doi)
            except Exception as exc:
                logger.warning("api_article_update %s: prionpack sync_doi failed: %s",
                               aid, exc)

        return jsonify(a.to_dict(include_text=True, viewer_role="admin"))
    finally:
        s.close()


_BULK_ALLOWED = {"priority", "color_label", "is_flagged", "is_milestone"}
_BULK_MAX_IDS = 10_000


@prionvault_bp.route("/api/articles/bulk", methods=["PATCH"])
@login_required
def api_articles_bulk_update():
    """Apply the same set of edits to many articles in a single UPDATE.

    Per-user marks only (the four columns moved off `articles` in
    migration 037) — every field in _BULK_ALLOWED is now per-user.
    No metadata fields are bulk-editable, so login_required is the
    correct gate for the whole endpoint.

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
    ids = list(dict.fromkeys(str(x) for x in ids if x))  # dedup, preserve order

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

    # All four allowed columns are per-user marks since migration 037,
    # so the bulk UPDATE switches from updating articles.* to upserting
    # prionvault_user_state for the current viewer. We INSERT a row
    # per article in one round-trip via unnest(), ON CONFLICT updating
    # only the keys the caller actually sent (so a "set priority=4"
    # bulk call doesn't blank out the user's color_label).
    _uid = _viewer_id()
    if not _uid:
        return jsonify({"error": "not_authenticated"}), 401

    cols = list(safe.keys())
    col_list   = ", ".join(cols)
    excl_set   = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols)
    # Constant per-call value tuple: every target row gets the same
    # marks. `SELECT :u, x::uuid, :col1, :col2, ... FROM unnest(:ids)`.
    select_consts = ", ".join(f":{c}" for c in cols)
    params = dict(safe)
    params["u"]   = str(_uid)
    params["ids"] = ids

    s = _session()
    try:
        res = s.execute(sql_text(
            f"""
            INSERT INTO prionvault_user_state
              (user_id, article_id, {col_list})
            SELECT DISTINCT CAST(:u AS uuid), x::uuid, {select_consts}
              FROM unnest(CAST(:ids AS text[])) AS x
            ON CONFLICT (user_id, article_id) DO UPDATE
               SET {excl_set}
            """
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


# ── Per-user article selection (persisted checkboxes) ──────────────────────

@prionvault_bp.route("/api/user-selection", methods=["GET"])
@login_required
def api_user_selection_get():
    """Return the article ids the viewer has currently ticked.
    Empty list for an anonymous session (shouldn't happen under
    @login_required, but defensive)."""
    from .services import user_selection
    return jsonify({"items": user_selection.list_for_user(_viewer_id())})


@prionvault_bp.route("/api/user-selection", methods=["POST"])
@login_required
def api_user_selection_post():
    """Body shape: {add?: [...ids], remove?: [...ids]}.

    Both arrays are optional; we apply them in (remove → add) order
    inside their own transactions so a single click that ticks one
    row and unticks another can be batched in one request. Useful
    for the "Marcar todos los visibles" / "Limpiar selección"
    bulk actions the bulk-bar drives.

    Returns {added: N, removed: M, total: T} so the UI can verify
    its in-memory state hasn't drifted from the server."""
    from .services import user_selection
    uid = _viewer_id()
    body = request.get_json(silent=True) or {}
    add_ids    = body.get("add")    or []
    remove_ids = body.get("remove") or []
    if not isinstance(add_ids, list) or not isinstance(remove_ids, list):
        return jsonify({"error": "add/remove must be arrays"}), 400
    removed = user_selection.remove(uid, remove_ids) if remove_ids else 0
    added   = user_selection.add(uid, add_ids)       if add_ids    else 0
    total   = len(user_selection.list_for_user(uid))
    return jsonify({"added": added, "removed": removed, "total": total})


@prionvault_bp.route("/api/user-selection", methods=["PUT"])
@login_required
def api_user_selection_put():
    """Body: {ids: [...]}. Replace the entire selection with this
    exact list, atomically. Used by "paste a working set" flows."""
    from .services import user_selection
    body = request.get_json(silent=True) or {}
    ids = body.get("ids") or []
    if not isinstance(ids, list):
        return jsonify({"error": "ids must be an array"}), 400
    out = user_selection.replace(_viewer_id(), ids)
    out["total"] = len(user_selection.list_for_user(_viewer_id()))
    return jsonify(out)


@prionvault_bp.route("/api/user-selection", methods=["DELETE"])
@login_required
def api_user_selection_delete():
    """Wipe the viewer's selection. Powers "Limpiar selección"."""
    from .services import user_selection
    n = user_selection.clear(_viewer_id())
    return jsonify({"removed": n, "total": 0})


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
@login_required
def api_articles_bulk_tags():
    """Attach or detach tags from many articles in one call, for the
    CURRENT VIEWER. Each user maintains their own tag assignments
    since migration 038, so this endpoint is open to readers.

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

    vid = _viewer_id()
    if not vid:
        return jsonify({"error": "not_authenticated"}), 401

    s = _session()
    try:
        added = 0
        if add_tags:
            res = s.execute(sql_text(
                """
                INSERT INTO article_tag_link (article_id, tag_id, added_by)
                SELECT a.article_id, t.tag_id, CAST(:uid AS uuid)
                  FROM unnest(CAST(:ids  AS uuid[])) AS a(article_id)
                 CROSS JOIN unnest(CAST(:tags AS int[]))  AS t(tag_id)
                  JOIN articles    ar ON ar.id = a.article_id
                  JOIN article_tag tg ON tg.id = t.tag_id
                ON CONFLICT (article_id, tag_id, added_by) DO NOTHING
                """
            ), {"ids": ids, "tags": add_tags, "uid": str(vid)})
            added = res.rowcount or 0

        removed = 0
        if remove_tags:
            # Only remove THIS viewer's assignments — never anyone
            # else's. The new (article_id, tag_id, added_by) PK
            # composition makes the constraint air-tight.
            res = s.execute(sql_text(
                """
                DELETE FROM article_tag_link
                 WHERE article_id = ANY(CAST(:ids  AS uuid[]))
                   AND tag_id     = ANY(CAST(:tags AS int[]))
                   AND added_by   = CAST(:uid AS uuid)
                """
            ), {"ids": ids, "tags": remove_tags, "uid": str(vid)})
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
        # Per-user marks (migration 037): join prionvault_user_state
        # for the current viewer so priority / flag / milestone /
        # color reflect THEIR view of these articles, not the legacy
        # global columns.
        _vuid = _viewer_id()
        cols = ("SELECT articles.id, title, doi, pubmed_id, year, authors, journal, "
                "       (dropbox_path IS NOT NULL) AS has_pdf, "
                "       (summary_ai IS NOT NULL)   AS has_summary, "
                "       _pus.priority                     AS priority, "
                "       COALESCE(_pus.is_flagged,   FALSE) AS is_flagged, "
                "       COALESCE(_pus.is_milestone, FALSE) AS is_milestone, "
                "       _pus.color_label                  AS color_label "
                "FROM articles "
                "LEFT JOIN prionvault_user_state _pus "
                "       ON _pus.article_id = articles.id "
                "      AND _pus.user_id = CAST(:_vuid AS uuid) ")
        if dois:
            rows = s.execute(sql_text(
                cols + "WHERE lower(doi) = ANY(:vals)"
            ), {"vals": list(set(dois)),
                "_vuid": str(_vuid) if _vuid else None}).mappings().all()
            for r in rows:
                if r["doi"]:
                    doi_rows[r["doi"].lower()] = r
        if pmids:
            rows = s.execute(sql_text(
                cols + "WHERE pubmed_id = ANY(:vals)"
            ), {"vals": list(set(pmids)),
                "_vuid": str(_vuid) if _vuid else None}).mappings().all()
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


@prionvault_bp.route("/api/articles/with-pdf", methods=["POST"])
@admin_required
def api_article_create_with_pdf():
    """Create an article from caller-supplied metadata AND attach a local PDF.

    Skips the metadata-extraction step of the ingest pipeline because
    the caller (typically the Add-by-DOI modal) has already resolved
    metadata against CrossRef / PubMed. The PDF still goes through MD5
    dedup, Dropbox upload, and best-effort text extraction so search and
    AI features keep working — they just don't try to re-derive the DOI.

    Accepts multipart/form-data:
      - `pdf`       (required, file): the local PDF.
      - `metadata`  (required, JSON string): {title, authors, year,
                    journal, doi, pubmed_id, abstract, …}
    """
    import hashlib as _hashlib
    import json as _json
    import uuid as _uuid_mod
    from .ingestion.pdf_extractor import extract_pdf, normalise_doi
    from .ingestion.dropbox_uploader import build_path, upload_pdf

    f = request.files.get("pdf")
    if not f or not f.filename:
        return jsonify({"error": "pdf is required"}), 400

    try:
        meta = _json.loads(request.form.get("metadata") or "{}")
    except _json.JSONDecodeError:
        return jsonify({"error": "metadata must be valid JSON"}), 400
    if not isinstance(meta, dict):
        return jsonify({"error": "metadata must be a JSON object"}), 400

    title = (meta.get("title") or "").strip()
    if not title:
        return jsonify({"error": "title is required"}), 400

    doi  = normalise_doi(meta.get("doi") or "") if meta.get("doi") else None
    pmid = (meta.get("pubmed_id") or "").strip() or None
    try:
        year = int(meta.get("year")) if meta.get("year") not in (None, "") else None
    except (TypeError, ValueError):
        year = None

    content = f.read()
    if not content:
        return jsonify({"error": "empty pdf"}), 400
    pdf_md5  = _hashlib.md5(content).hexdigest()
    pdf_size = len(content)

    s = _session()
    try:
        # Dedup: by md5 first (cheapest, identifies the exact same PDF
        # already in the library), then by DOI / PMID.
        for col, val in (("pdf_md5", pdf_md5), ("doi", doi), ("pubmed_id", pmid)):
            if not val:
                continue
            sql = (f"SELECT id FROM articles "
                   f"WHERE {('lower(doi)' if col == 'doi' else col)} = :v "
                   f"LIMIT 1")
            params = {"v": val.lower() if col == "doi" else val}
            row = s.execute(sql_text(sql), params).first()
            if row:
                return jsonify({"error": "duplicate",
                                "duplicate_of": str(row[0]),
                                "matched_on": col}), 409

        # Upload to Dropbox at the canonical path. Conflicts (file already
        # at the same path on the remote) are surfaced as info, not fatal —
        # the DB row is what makes the article visible to the rest of the
        # app.
        target = build_path(doi=doi, year=year, md5=pdf_md5,
                            filename_hint=f.filename)
        upload = upload_pdf(content, target, overwrite=False)
        if upload.error and "conflict" not in upload.error.lower():
            return jsonify({"error": "dropbox_upload_failed",
                            "detail": upload.error}), 502
        dropbox_path = upload.dropbox_path or target

        # Best-effort text extraction. A scan with no embedded text layer
        # will produce empty text and the OCR worker will pick the row up
        # later (extraction_status='pending').
        extraction = extract_pdf(content)
        has_text   = bool(extraction and extraction.text)
        new_id     = _uuid_mod.uuid4()

        s.execute(sql_text("""
            INSERT INTO articles
              (id, title, authors, year, journal, doi, pubmed_id, abstract,
               pdf_md5, pdf_size_bytes, pdf_pages, extracted_text,
               dropbox_path, source, added_by_id, extraction_status,
               created_at, updated_at)
            VALUES
              (:id, :title, :authors, :year, :journal, :doi, :pmid, :abstract,
               :md5, :size, :pages, :text,
               :path, 'add_by_doi', :added_by, :status,
               NOW(), NOW())
        """), {
            "id":       str(new_id),
            "title":    title,
            "authors":  (meta.get("authors")  or "").strip() or None,
            "year":     year,
            "journal":  (meta.get("journal")  or "").strip() or None,
            "doi":      doi,
            "pmid":     pmid,
            "abstract": (meta.get("abstract") or "").strip() or None,
            "md5":      pdf_md5,
            "size":     pdf_size,
            "pages":    extraction.pages if has_text else None,
            "text":     extraction.text  if has_text else None,
            "path":     dropbox_path,
            "added_by": _viewer_id(),
            "status":   "extracted" if has_text else "pending",
        })
        s.commit()

        return jsonify({
            "id":            str(new_id),
            "title":         title,
            "doi":           doi,
            "pubmed_id":     pmid,
            "dropbox_path":  dropbox_path,
            "pdf_md5":       pdf_md5,
            "pdf_size_bytes": pdf_size,
            "pdf_pages":     extraction.pages if has_text else None,
            "extraction_status": "extracted" if has_text else "pending",
        }), 201
    except Exception as exc:
        s.rollback()
        logger.exception("api_article_create_with_pdf failed")
        return jsonify({"error": "internal error", "detail": str(exc)[:300]}), 500
    finally:
        s.close()


@prionvault_bp.route("/api/articles/create", methods=["POST"])
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
    on title tokens (lowercased, stopwords stripped). Pairs the admin
    has already dismissed via /api/duplicates/dismiss are filtered out.
    """
    threshold = max(0.0, min(1.0,
                             request.args.get("threshold", default=0.75, type=float)))
    s = _session()
    try:
        # Load the dismissed set up-front (stored canonical so
        # article_a < article_b). Cheap — typically a handful of rows.
        try:
            dis_rows = s.execute(sql_text(
                "SELECT article_a, article_b FROM prionvault_dismissed_duplicates"
            )).all()
            dismissed = {(str(r[0]), str(r[1])) for r in dis_rows}
        except Exception:
            # Table may not exist yet on a stale deploy — degrade
            # gracefully to "no dismissals" so the scanner still runs.
            dismissed = set()

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
                    # Honour the user's "no son duplicados" decisions.
                    # Compare with canonical ordering (smaller uuid first)
                    # so the dismissal hides the pair no matter which
                    # member appears first in the scan.
                    aid, bid = str(a["id"]), str(b["id"])
                    canon = (aid, bid) if aid < bid else (bid, aid)
                    if canon in dismissed:
                        continue
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
        return jsonify({
            "total":          len(pairs),
            "pairs":          pairs,
            "dismissed_count": len(dismissed),
        })
    finally:
        s.close()


@prionvault_bp.route("/api/duplicates/dismiss", methods=["POST"])
@admin_required
def api_duplicates_dismiss():
    """Mark a pair as "not a duplicate" so the scanner stops surfacing
    it. Body: { a: <uuid>, b: <uuid>, reason?: str }. The pair is
    stored canonicalised (smaller-uuid first) so subsequent dismiss
    calls with the arguments flipped collapse to the same row."""
    data = request.get_json(force=True, silent=True) or {}
    aid_a = (data.get("a") or "").strip()
    aid_b = (data.get("b") or "").strip()
    reason = (data.get("reason") or "").strip() or None
    if not aid_a or not aid_b:
        return jsonify({"error": "a_and_b_required"}), 400
    if aid_a == aid_b:
        return jsonify({"error": "same_id"}), 400
    lo, hi = (aid_a, aid_b) if aid_a < aid_b else (aid_b, aid_a)
    s = _session()
    try:
        try:
            s.execute(sql_text("""
                INSERT INTO prionvault_dismissed_duplicates
                  (article_a, article_b, dismissed_by, reason)
                VALUES (:a, :b, :u, :r)
                ON CONFLICT (article_a, article_b) DO UPDATE
                   SET dismissed_at = NOW(),
                       dismissed_by = EXCLUDED.dismissed_by,
                       reason       = EXCLUDED.reason
            """), {"a": lo, "b": hi,
                   "u": str(_viewer_id()) if _viewer_id() else None,
                   "r": reason})
            s.commit()
        except Exception as exc:
            s.rollback()
            msg = str(exc)[:200]
            # ForeignKeyViolation when one of the ids no longer exists
            # — give a clean 404 rather than the SQL detail.
            if "ForeignKeyViolation" in type(exc).__name__ or \
               "violates foreign key" in msg.lower():
                return jsonify({"error": "article_not_found",
                                "detail": msg}), 404
            logger.exception("dismiss-duplicate failed")
            return jsonify({"error": "internal_error", "detail": msg}), 500
        return jsonify({"ok": True, "a": lo, "b": hi})
    finally:
        s.close()


@prionvault_bp.route("/api/duplicates/dismiss", methods=["DELETE"])
@admin_required
def api_duplicates_undismiss():
    """Reverse a previous dismissal so the pair shows up again on the
    next scan. Body: { a: <uuid>, b: <uuid> } in any order."""
    data = request.get_json(force=True, silent=True) or {}
    aid_a = (data.get("a") or "").strip()
    aid_b = (data.get("b") or "").strip()
    if not aid_a or not aid_b:
        return jsonify({"error": "a_and_b_required"}), 400
    lo, hi = (aid_a, aid_b) if aid_a < aid_b else (aid_b, aid_a)
    s = _session()
    try:
        res = s.execute(sql_text("""
            DELETE FROM prionvault_dismissed_duplicates
             WHERE article_a = :a AND article_b = :b
        """), {"a": lo, "b": hi})
        s.commit()
        return jsonify({"ok": True, "deleted": res.rowcount or 0})
    except Exception as exc:
        s.rollback()
        logger.exception("undismiss-duplicate failed")
        return jsonify({"error": "internal_error", "detail": str(exc)[:200]}), 500
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


@prionvault_bp.route("/api/collections/rollup", methods=["GET"])
@login_required
def api_collections_rollup():
    """Per-group / per-subgroup deduplicated counts for the sidebar.

    Distinct from /api/collections because that endpoint returns one
    row per collection (with its raw article_count). The sidebar
    rollups need DEDUPLICATED counts — an article in two collections
    under the same parent should be counted once, not twice — and
    those are expensive enough that we don't want every visitor to
    pay for them when they just want the flat list.
    """
    from .services import collections as _coll
    try:
        return jsonify(_coll.rollup_unique_counts())
    except Exception as exc:
        logger.exception("collections rollup failed")
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
        ids = _coll.resolve_article_ids(cid, viewer_id=_viewer_id())
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


@prionvault_bp.route("/api/admin/batch-summary/reset", methods=["POST"])
@admin_required
def api_batch_summary_reset():
    """Force-reset the batch state. Use when a run is stuck."""
    from .services import batch_summary
    from datetime import datetime
    with batch_summary._lock:
        batch_summary._state["running"]        = False
        batch_summary._state["stop_requested"] = False
        batch_summary._state["finished_at"]    = datetime.utcnow().isoformat()
        batch_summary._state["last_error"]     = "Reset manual por administrador"
    return jsonify({"ok": True, "status": batch_summary.get_status()})


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

        aid_str = str(aid)
        packs = []
        try:
            from tools.prionpacks import models as pp_models

            def _ref_matches(ref) -> bool:
                if isinstance(ref, dict):
                    return ref.get("article_id") and str(ref["article_id"]) == aid_str
                return bool(doi and doi in (ref or "").lower())

            for pkg in pp_models.list_packages():
                if not pkg.get("active", True):
                    continue
                lists = []
                for ref in (pkg.get("introReferences") or []):
                    if _ref_matches(ref):
                        lists.append("intro")
                        break
                for ref in (pkg.get("references") or []):
                    if _ref_matches(ref):
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
@login_required
def api_supplementary_upload(aid):
    """Upload one supplementary file. multipart/form-data:
       file=<binary>, caption=<optional string>.
    Returns the created row metadata.

    Any logged-in user may add supplementary material — the
    `added_by` column records the creator so PATCH and DELETE can
    enforce a creator-or-admin gate downstream."""
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
@login_required
def api_supplementary_update(aid, sid):
    # Creator-or-admin gate (added_by stores the uploader's user_id).
    err = _ensure_can_modify("article_supplementary", "added_by", sid)
    if err: return err
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
@login_required
def api_supplementary_delete(aid, sid):
    err = _ensure_can_modify("article_supplementary", "added_by", sid)
    if err: return err
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
@login_required
def api_jc_create(aid):
    """Create a JC presentation row + optionally attach files in the
    same multipart request. Body fields:
       presented_at (YYYY-MM-DD), presenter_name, presenter_id?,
       file (one or many, optional).

    Open to any logged-in user — `created_by` records who registered
    the presentation so PATCH and DELETE can enforce a creator-or-
    admin gate downstream.
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
@login_required
def api_jc_update(pid):
    err = _ensure_can_modify("prionvault_jc_presentation", "created_by", pid)
    if err: return err
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
@login_required
def api_jc_delete(pid):
    err = _ensure_can_modify("prionvault_jc_presentation", "created_by", pid)
    if err: return err
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
@login_required
def api_jc_add_files(pid):
    """Attach extra files to an existing presentation. Same ownership
    rule as PATCH: creator or admin only."""
    err = _ensure_can_modify("prionvault_jc_presentation", "created_by", pid)
    if err: return err
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
@login_required
def api_jc_delete_file(fid):
    # JC file rows don't carry their own owner — ownership lives on
    # the parent presentation. Resolve presentation_id from the file
    # first, then apply the standard creator-or-admin gate.
    if _viewer_role() != "admin":
        s = _session()
        try:
            row = s.execute(sql_text(
                "SELECT presentation_id FROM prionvault_jc_file WHERE id = :fid"
            ), {"fid": str(fid)}).first()
        finally:
            s.close()
        if not row:
            return jsonify({"error": "not_found"}), 404
        err = _ensure_can_modify(
            "prionvault_jc_presentation", "created_by", row[0])
        if err: return err
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
@prionvault_bp.route("/api/articles/<uuid:aid>/fetch-abstract", methods=["POST"])
@admin_required
def api_article_fetch_abstract(aid):
    """Try to recover a missing abstract from CrossRef / PubMed.

    Strategy mirrors PrionRead's admin button but adds two improvements:

    1. When we have a DOI but no PMID, do a PubMed lookup-by-DOI first.
       If it succeeds we record the PMID on the article — that PMID is
       reusable for every subsequent feature (manual look-up, RAG, etc.)
       and is a cheap byproduct of the search.
    2. If neither source returns text, flip `abstract_unavailable` so
       the UI can colour the article differently and stop suggesting a
       refetch.

    Returns:
        200 + {ok: true,  source, abstract}            on hit
        200 + {ok: false, status: 'unavailable'}       on confirmed miss
        400 + {error: 'no_identifier'}                 if no DOI / PMID
        404 / 502                                       infra errors
    """
    from .ingestion.metadata_resolver import (
        resolve_metadata, pubmed_by_doi, pubmed_by_pmid,
    )

    s = _session()
    try:
        a = s.get(models.Article, aid)
        if not a:
            return jsonify({"error": "not_found"}), 404
        doi  = (a.doi or "").strip() or None
        pmid = (a.pubmed_id or "").strip() if a.pubmed_id else None
        if not doi and not pmid:
            return jsonify({"error": "no_identifier",
                            "detail": "El artículo necesita un DOI o un PMID."}), 400

        # Step 1: opportunistically resolve a missing PMID via PubMed
        # using the DOI. Cheap, often successful, and the PMID stays
        # useful even if the abstract path below ends up empty.
        if doi and not pmid:
            try:
                meta = pubmed_by_doi(doi)
                if meta and meta.pubmed_id:
                    pmid = meta.pubmed_id
                    a.pubmed_id = pmid
                    s.flush()
            except IntegrityError as exc:
                # PMID already belongs to another article — discard the update
                # and continue without it; we can still fetch the abstract.
                s.rollback()
                orig_pmid = pmid
                pmid = None
                a = s.get(models.Article, aid)
                if a is None:
                    return jsonify({"error": "not_found"}), 404
                logger.warning(
                    "fetch-abstract: PMID %s already in DB for doi=%s, skipping: %s",
                    orig_pmid, doi, exc,
                )
            except Exception as exc:
                # Any other failure (network, parse, etc.) — roll back so the
                # session is clean for the abstract-save commit that follows.
                s.rollback()
                a = s.get(models.Article, aid)
                if a is None:
                    return jsonify({"error": "not_found"}), 404
                logger.warning("fetch-abstract: pubmed_by_doi failed for %s: %s",
                               doi, exc)

        # Step 2: full metadata resolve (CrossRef → PubMed) and pick
        # whichever source returned an abstract.
        abstract = None
        source   = None
        try:
            meta = resolve_metadata(doi=doi, pmid_hint=pmid)
            if meta and meta.abstract:
                abstract = meta.abstract.strip()
                source   = meta.source or "resolver"
        except Exception as exc:
            logger.warning("fetch-abstract: resolve_metadata failed: %s", exc)

        # Step 3: PubMed direct retry — sometimes resolve_metadata
        # short-circuits on CrossRef even when PubMed has the abstract.
        if not abstract and pmid:
            try:
                pm = pubmed_by_pmid(pmid)
                if pm and pm.abstract:
                    abstract = pm.abstract.strip()
                    source   = "pubmed"
            except Exception as exc:
                logger.warning("fetch-abstract: pubmed_by_pmid failed for %s: %s",
                               pmid, exc)

        if abstract:
            a.abstract = abstract
            a.abstract_unavailable = False
            s.commit()
            return jsonify({"ok": True, "source": source,
                            "abstract": abstract,
                            "pubmed_id": pmid})
        # Confirmed miss — both sources came back empty.
        a.abstract_unavailable = True
        s.commit()
        return jsonify({"ok": False, "status": "unavailable",
                        "pubmed_id": pmid})
    except Exception as exc:
        s.rollback()
        logger.exception("api_article_fetch_abstract failed")
        return jsonify({"error": "internal_error", "detail": str(exc)[:300]}), 500
    finally:
        s.close()


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


@prionvault_bp.route("/api/articles/<uuid:aid>/fetch-oa-pdf", methods=["POST"])
@admin_required
def api_article_fetch_oa_pdf(aid):
    """Synchronously attempt OA PDF fetch for one article (Unpaywall + PMC).
    Returns {ok, status, dropbox_path?} where status is the new pdf_oa_status.
    Used by the per-row OA download button in the article list.
    """
    from .services import oa_pdf_fetcher
    from sqlalchemy import text as sql_text

    s = _session()
    try:
        a = s.get(models.Article, aid)
        if not a:
            return jsonify({"error": "not_found"}), 404
        if getattr(a, "dropbox_path", None):
            return jsonify({"error": "already_has_pdf"}), 409
        row = {
            "id":      str(aid),
            "title":   a.title or "(sin título)",
            "doi":     (a.doi or "").strip().lower() or None,
            "pmc_id":  getattr(a, "pmc_id", None),
            "year":    a.year,
        }
    finally:
        s.close()

    if not row["doi"] and not row["pmc_id"]:
        return jsonify({"ok": False, "reason": "no_doi_no_pmc"}), 400

    status = oa_pdf_fetcher._process_one(row)
    ok = status not in ("not_available", "failed")

    # Read back dropbox_path so the frontend can confirm the file is linked.
    dropbox_path = None
    if ok:
        try:
            eng = oa_pdf_fetcher._get_engine()
            with eng.connect() as conn:
                r = conn.execute(sql_text(
                    "SELECT dropbox_path FROM articles WHERE id = :aid"
                ), {"aid": str(aid)}).first()
                if r:
                    dropbox_path = r[0]
        except Exception:
            pass

    return jsonify({"ok": ok, "status": status, "dropbox_path": dropbox_path})


# Ingestion, PDF streaming, and AI-summary routes live in their own module.
from . import routes_ingestion  # noqa: F401, E402

# Admin batch-operation routes live in their own module.
from . import routes_admin  # noqa: F401, E402

# Notification subscription routes live in their own module.
from . import routes_notifications  # noqa: F401, E402
# Re-export so existing callers (tests, etc.) can still import from here.
from .routes_notifications import _validate_notif_payload, _notif_sub_to_dict  # noqa: F401, E402
