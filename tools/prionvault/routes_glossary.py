"""Glossary management routes for PrionVault.

Handles glossary CRUD, summary improvement, and statistics.
Routes registered as side-effect import at bottom of routes.py.
"""
import logging
import threading
from flask import jsonify, request, Response, current_app
from sqlalchemy import text as sql_text

from core.decorators import admin_required, login_required
from database.config import db
from . import prionvault_bp

logger = logging.getLogger(__name__)


# ── Glossary stats & dashboard ─────────────────────────────────────────────
@prionvault_bp.route("/api/glossary/stats", methods=["GET"])
@admin_required
def api_glossary_stats():
    """Get comprehensive glossary statistics for dashboard."""
    from .services import summary_improver

    try:
        stats = summary_improver.get_improvement_stats()
        return jsonify(stats)
    except Exception as e:
        logger.exception("Failed to fetch glossary stats")
        return jsonify({"error": str(e)[:300]}), 500


@prionvault_bp.route("/api/glossary/stats/detailed", methods=["GET"])
@admin_required
def api_glossary_stats_detailed():
    """Get detailed glossary review status breakdown."""
    from .services import glossary_manager

    current_version = glossary_manager.get_current_glossary_version()

    try:
        # Check if summary_improvement_log table exists using information_schema
        table_exists = False
        try:
            with db.engine.connect() as check_conn:
                result = check_conn.execute(sql_text("""
                    SELECT EXISTS (
                        SELECT 1 FROM information_schema.tables
                        WHERE table_name = 'summary_improvement_log'
                    )
                """)).scalar()
                table_exists = bool(result)
        except Exception as e:
            logger.warning(f"Failed to check table existence: {e}")
            table_exists = False

        with db.engine.connect() as conn:
            # Pending: unreviewed summaries (ai_summary_glossary_version IS NULL)
            pending = conn.execute(sql_text("""
                SELECT COUNT(*) FROM articles
                WHERE summary_ai IS NOT NULL
                  AND ai_summary_glossary_version IS NULL
                  AND char_length(summary_ai) > 50
            """)).scalar() or 0

            # Reviewed stats: only query if table exists
            if table_exists:
                # Reviewed with changes: articles with improvement log entries
                reviewed_with_changes = conn.execute(sql_text("""
                    SELECT COUNT(DISTINCT article_id)
                    FROM summary_improvement_log
                    WHERE changes_count > 0 AND dry_run = FALSE
                """)).scalar() or 0

                # Reviewed without changes: articles with improvement log but no changes
                reviewed_without_changes = conn.execute(sql_text("""
                    SELECT COUNT(DISTINCT article_id)
                    FROM summary_improvement_log
                    WHERE changes_count = 0 AND dry_run = FALSE
                """)).scalar() or 0

                total_reviewed = reviewed_with_changes + reviewed_without_changes
            else:
                reviewed_with_changes = 0
                reviewed_without_changes = 0
                total_reviewed = 0

        return jsonify({
            "pending": int(pending),
            "reviewed_with_changes": int(reviewed_with_changes),
            "reviewed_without_changes": int(reviewed_without_changes),
            "total_reviewed": int(total_reviewed),
            "current_glossary_version": current_version,
        })
    except Exception as e:
        logger.exception("Failed to fetch glossary detailed stats")
        return jsonify({"error": str(e)[:300]}), 500


# ── Unreviewed summaries (glossary_version IS NULL) ──────────────────────
@prionvault_bp.route("/api/glossary/unreviewed", methods=["GET"])
@admin_required
def api_glossary_unreviewed():
    """Get articles with unreviewed AI summaries (ai_summary_glossary_version IS NULL)."""
    limit = max(1, min(100, request.args.get("limit", 50, type=int)))
    offset = max(0, request.args.get("offset", 0, type=int))

    try:
        with db.engine.connect() as conn:
            rows = conn.execute(sql_text("""
                SELECT id::text, title, authors, year, summary_ai,
                       char_length(summary_ai) as summary_length,
                       created_at, updated_at
                FROM articles
                WHERE summary_ai IS NOT NULL
                  AND ai_summary_glossary_version IS NULL
                  AND char_length(summary_ai) > 50
                ORDER BY updated_at DESC
                LIMIT :lim OFFSET :off
            """), {"lim": limit, "off": offset}).mappings().all()

            total = conn.execute(sql_text("""
                SELECT COUNT(*) FROM articles
                WHERE summary_ai IS NOT NULL AND ai_summary_glossary_version IS NULL
            """)).scalar() or 0

        return jsonify({
            "articles": [dict(r) for r in rows],
            "total": int(total),
            "limit": limit,
            "offset": offset,
            "has_more": (offset + limit) < total,
        })
    except Exception as e:
        logger.exception(f"Failed to fetch unreviewed summaries: {e}")
        return jsonify({"error": str(e)[:300]}), 500


# ── Outdated summaries (glossary_version < current) ──────────────────────
@prionvault_bp.route("/api/glossary/outdated", methods=["GET"])
@admin_required
def api_glossary_outdated():
    """Get articles improved with older glossary versions."""
    from .services import glossary_manager

    limit = max(1, min(100, request.args.get("limit", 50, type=int)))
    offset = max(0, request.args.get("offset", 0, type=int))

    try:
        current_version = glossary_manager.get_current_glossary_version()

        with db.engine.connect() as conn:
            rows = conn.execute(sql_text("""
                SELECT
                  a.id::text,
                  a.title,
                  a.authors,
                  a.year,
                  sil.glossary_version_used,
                  sil.improved_at,
                  sil.changes_count,
                  char_length(a.summary_ai) as summary_length
                FROM summary_improvement_log sil
                JOIN articles a ON a.id = sil.article_id
                WHERE sil.glossary_version_used < :current
                  AND sil.dry_run = FALSE
                ORDER BY sil.glossary_version_used ASC, sil.improved_at DESC
                LIMIT :lim OFFSET :off
            """), {
                "current": current_version,
                "lim": limit,
                "off": offset,
            }).mappings().all()

            total = conn.execute(sql_text("""
                SELECT COUNT(*) FROM summary_improvement_log
                WHERE glossary_version_used < :current
                  AND dry_run = FALSE
            """), {"current": current_version}).scalar() or 0

        return jsonify({
            "articles": [dict(r) for r in rows],
            "current_glossary_version": current_version,
            "total_outdated": int(total),
            "limit": limit,
            "offset": offset,
            "has_more": (offset + limit) < total,
        })
    except Exception as e:
        logger.exception(f"Failed to fetch outdated summaries: {e}")
        return jsonify({"error": str(e)[:300]}), 500


# ── Improvement log ────────────────────────────────────────────────────────
@prionvault_bp.route("/api/glossary/log", methods=["GET"])
@admin_required
def api_glossary_log():
    """Get detailed improvement history, optionally filtered by batch."""
    from .services import summary_improver

    batch_id = request.args.get("batch_id")
    limit = max(1, min(100, request.args.get("limit", 50, type=int)))
    offset = max(0, request.args.get("offset", 0, type=int))

    result = summary_improver.get_improvement_log(
        batch_id=batch_id,
        limit=limit,
        offset=offset,
    )
    return jsonify(result)


# ── Batch improve summaries ────────────────────────────────────────────────
@prionvault_bp.route("/api/glossary/improve-batch", methods=["POST"])
@admin_required
def api_glossary_improve_batch():
    """Start a batch improvement run with glossary."""
    from .services import summary_improver, glossary_manager

    data = request.get_json(force=True, silent=True) or {}
    article_ids = data.get("article_ids", [])
    dry_run = data.get("dry_run", False)

    if not isinstance(article_ids, list) or not article_ids:
        return jsonify({"error": "article_ids must be a non-empty list"}), 400

    # Fetch current glossary
    try:
        glossary_context = glossary_manager.get_glossary_context()
        glossary_version = glossary_manager.get_current_glossary_version()
        if not glossary_context:
            return jsonify({"error": "No glossary terms available"}), 400
    except Exception as e:
        logger.exception("Failed to load glossary")
        return jsonify({"error": f"Glossary load failed: {str(e)[:200]}"}), 500

    # Run batch in background
    def _run():
        try:
            summary_improver.batch_improve_summaries(
                article_ids=article_ids,
                glossary_context=glossary_context,
                glossary_version=glossary_version,
                dry_run=dry_run,
            )
        except Exception as exc:
            logger.exception("Batch improvement failed: %s", exc)

    threading.Thread(target=_run, name="pv-glossary-batch", daemon=True).start()

    return jsonify({
        "ok": True,
        "queued": len(article_ids),
        "dry_run": dry_run,
        "glossary_version": glossary_version,
        "message": f"Queued {len(article_ids)} articles for improvement"
    })


# ── Glossary term operations ───────────────────────────────────────────────
@prionvault_bp.route("/api/glossary/terms", methods=["GET"])
@login_required
def api_glossary_terms():
    """Get all glossary terms, optionally filtered by category."""
    from .services import glossary_manager

    category = request.args.get("category", "")

    try:
        terms = glossary_manager.get_all_terms(category=category if category else None)
        return jsonify({
            "terms": terms,
            "count": len(terms),
        })
    except Exception as e:
        logger.exception("Failed to fetch glossary terms")
        return jsonify({"error": str(e)[:300]}), 500


@prionvault_bp.route("/api/glossary/term", methods=["PUT"])
@admin_required
def api_glossary_update_term():
    """Update a glossary term in-place."""
    from .services import glossary_manager

    data = request.get_json(force=True, silent=True) or {}
    term_en = (data.get("term_en") or "").strip().lower()
    term_es = (data.get("term_es_recommended") or "").strip()
    avoid = (data.get("term_es_avoid") or "").strip() or None
    notes = (data.get("notes") or "").strip() or None
    category = (data.get("category") or "").strip() or None
    version = data.get("version", 1)

    if not term_en or not term_es:
        return jsonify({"error": "term_en and term_es_recommended are required"}), 400

    try:
        result = glossary_manager.update_term(
            term_en=term_en,
            term_es_recommended=term_es,
            term_es_avoid=avoid,
            notes=notes,
            category=category,
            version=version
        )
        return jsonify({"ok": True, "updated": result})
    except Exception as e:
        logger.exception("Failed to update glossary term")
        return jsonify({"error": str(e)[:300]}), 500


@prionvault_bp.route("/api/glossary/categories", methods=["GET"])
@login_required
def api_glossary_categories():
    """Get all glossary categories."""
    from .services import glossary_manager

    try:
        categories = glossary_manager.get_categories()
        return jsonify({
            "categories": categories,
            "count": len(categories),
        })
    except Exception as e:
        logger.exception("Failed to fetch categories")
        return jsonify({"error": str(e)[:300]}), 500


@prionvault_bp.route("/api/glossary/version", methods=["GET"])
@login_required
def api_glossary_version():
    """Get current glossary version."""
    from .services import glossary_manager

    try:
        version = glossary_manager.get_current_glossary_version()
        return jsonify({"version": version})
    except Exception as e:
        logger.exception("Failed to fetch glossary version")
        return jsonify({"error": str(e)[:300]}), 500


@prionvault_bp.route("/api/glossary/import", methods=["POST"])
@admin_required
def api_glossary_import():
    """Import glossary terms from JSON or TSV.

    Accepts either:
    - JSON: {"terms": [{...}, ...]}
    - TSV: {"tsv_content": "English\\tCastellano...\\n..."}
    """
    from .services import glossary_manager

    data = request.get_json(force=True, silent=True) or {}

    # Try JSON format first
    terms = data.get("terms", [])
    if terms and isinstance(terms, list):
        try:
            result = glossary_manager.import_glossary(terms)
            return jsonify(result.__dict__ if hasattr(result, '__dict__') else result)
        except Exception as e:
            logger.exception("Glossary import failed")
            return jsonify({"error": str(e)[:300]}), 500

    # Try TSV format
    tsv_content = data.get("tsv_content", "")
    if tsv_content:
        try:
            # Validate first
            is_valid, errors, preview_rows = glossary_manager.validate_tsv_format(tsv_content)
            if not is_valid:
                return jsonify({"error": "TSV validation failed", "details": errors}), 400

            # Parse and import
            terms = glossary_manager.parse_tsv_to_terms(tsv_content)
            result = glossary_manager.import_glossary(terms)
            return jsonify(result.__dict__ if hasattr(result, '__dict__') else result)
        except Exception as e:
            logger.exception("TSV import failed")
            return jsonify({"error": str(e)[:300]}), 500

    return jsonify({"error": "Either 'terms' (JSON) or 'tsv_content' (TSV) is required"}), 400


# ── Excel export ───────────────────────────────────────────────────────────
@prionvault_bp.route("/api/glossary/export", methods=["GET"])
@admin_required
def api_glossary_export():
    """Export glossary improvement statistics as Excel file."""
    try:
        import io
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill, Alignment
        from .services import summary_improver

        stats = summary_improver.get_improvement_stats()

        wb = Workbook()
        ws = wb.active
        ws.title = "Estadísticas"

        # Header styling
        header_fill = PatternFill(start_color="4472C4", end_color="4472C4", fill_type="solid")
        header_font = Font(bold=True, color="FFFFFF")

        # Title
        ws['A1'] = "Estadísticas de mejora de resúmenes con glosario"
        ws['A1'].font = Font(bold=True, size=14)
        ws.merge_cells('A1:D1')

        # Summary metrics
        row = 3
        ws[f'A{row}'] = "Métrica"
        ws[f'B{row}'] = "Valor"
        ws[f'A{row}'].fill = header_fill
        ws[f'A{row}'].font = header_font
        ws[f'B{row}'].fill = header_fill
        ws[f'B{row}'].font = header_font

        row += 1
        metrics = [
            ("Artículos mejorados", stats.get("total_articles_improved", 0)),
            ("Total de cambios", stats.get("total_changes", 0)),
            ("Cambios promedio/artículo", f"{stats.get('avg_changes_per_article', 0.0):.2f}"),
            ("Lotes procesados", stats.get("total_batches", 0)),
            ("Versión actual del glosario", stats.get("current_glossary_version", 0)),
            ("Última mejora", stats.get("last_improvement_at", "N/A")),
        ]

        for label, value in metrics:
            ws[f'A{row}'] = label
            ws[f'B{row}'] = value
            row += 1

        # By-version breakdown
        row += 2
        ws[f'A{row}'] = "Versión del glosario"
        ws[f'B{row}'] = "Artículos"
        ws[f'C{row}'] = "Cambios totales"
        for col in ['A', 'B', 'C']:
            ws[f'{col}{row}'].fill = header_fill
            ws[f'{col}{row}'].font = header_font

        row += 1
        for v in stats.get("by_version", []):
            ws[f'A{row}'] = v["glossary_version"]
            ws[f'B{row}'] = v["articles_improved"]
            ws[f'C{row}'] = v["total_changes"]
            row += 1

        # Most common corrections
        row += 2
        ws[f'A{row}'] = "Término original"
        ws[f'B{row}'] = "Término corregido"
        ws[f'C{row}'] = "Frecuencia"
        for col in ['A', 'B', 'C']:
            ws[f'{col}{row}'].fill = header_fill
            ws[f'{col}{row}'].font = header_font

        row += 1
        for corr in stats.get("most_common_corrections", []):
            ws[f'A{row}'] = corr["original"]
            ws[f'B{row}'] = corr["corrected"]
            ws[f'C{row}'] = corr["frequency"]
            row += 1

        # Auto-size columns
        ws.column_dimensions['A'].width = 30
        ws.column_dimensions['B'].width = 20
        ws.column_dimensions['C'].width = 20

        # Write to bytes
        output = io.BytesIO()
        wb.save(output)
        output.seek(0)

        return Response(
            output.getvalue(),
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": "attachment;filename=estadisticas_glosario.xlsx"}
        )

    except Exception as e:
        logger.exception(f"Failed to export statistics: {e}")
        return jsonify({"error": str(e)[:300]}), 500
