"""Glossary management routes for PrionVault.

Handles glossary CRUD, summary improvement, and statistics.
Routes registered as side-effect import at bottom of routes.py.
"""
import logging
import threading
from io import BytesIO
from datetime import datetime
from flask import jsonify, request, Response, current_app, send_file
from sqlalchemy import text as sql_text
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

from core.decorators import admin_required, login_required
from database.config import db
from . import prionvault_bp

logger = logging.getLogger(__name__)

# Track active batch processing
_batch_state = {"status": None, "error": None, "queued": 0, "processed": 0}


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

        # If table doesn't exist, return empty results
        if not table_exists:
            return jsonify({
                "articles": [],
                "current_glossary_version": current_version,
                "total_outdated": 0,
                "limit": limit,
                "offset": offset,
                "has_more": False,
            })

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
@prionvault_bp.route("/api/glossary/improve-next", methods=["POST"])
@admin_required
def api_glossary_improve_next():
    """Improve the next N unreviewed summaries with glossary."""
    from .services import summary_improver, glossary_manager

    data = request.get_json(force=True, silent=True) or {}
    count = data.get("count", 100)  # Default 100, can be 100, 500, or "all"
    dry_run = data.get("dry_run", False)

    # Validate count
    if count == "all":
        limit = 10000  # Get up to 10k (likely all unreviewed)
    elif isinstance(count, int):
        limit = max(1, min(10000, count))
    else:
        return jsonify({"error": "count must be an integer or 'all'"}), 400

    try:
        # Fetch unreviewed articles
        with db.engine.connect() as conn:
            article_ids = conn.execute(sql_text("""
                SELECT id::text FROM articles
                WHERE summary_ai IS NOT NULL
                  AND ai_summary_glossary_version IS NULL
                  AND char_length(summary_ai) > 50
                ORDER BY updated_at DESC
                LIMIT :lim
            """), {"lim": limit}).scalars().all()

        if not article_ids:
            return jsonify({
                "ok": True,
                "queued": 0,
                "message": "No unreviewed summaries found",
                "dry_run": dry_run,
            })

        # Fetch current glossary
        glossary_context = glossary_manager.get_glossary_context()
        glossary_version = glossary_manager.get_current_glossary_version()
        if not glossary_context:
            return jsonify({"error": "No glossary terms available"}), 400

        # Reset batch state
        _batch_state["status"] = "processing"
        _batch_state["error"] = None
        _batch_state["queued"] = len(article_ids)
        _batch_state["processed"] = 0
        _batch_state["batch_id"] = None

        # Run batch in background
        def _run():
            logger.info(f"🚀 THREAD STARTED: Batch thread beginning execution")
            try:
                logger.info(f"📋 Calling batch_improve_summaries with {len(article_ids)} articles")
                def progress_callback(count, article_title="", status="processing"):
                    _batch_state.update({
                        "processed": count,
                        "current_article": article_title,
                        "current_status": status,
                    })
                    logger.info(f"[PROGRESS] {count}/{len(article_ids)}: {article_title} - {status}")

                result = summary_improver.batch_improve_summaries(
                    article_ids=article_ids,
                    glossary_context=glossary_context,
                    glossary_version=glossary_version,
                    dry_run=dry_run,
                    progress_callback=progress_callback,
                )
                logger.info(f"✅ batch_improve_summaries returned successfully")
                _batch_state["status"] = "completed"
                _batch_state["processed"] = result.get("processed", 0)
                _batch_state["batch_id"] = result.get("batch_id")
                logger.info(f"🏁 Batch completed: {result}")
            except Exception as exc:
                logger.exception("❌ Batch improvement failed: %s", exc)
                _batch_state["status"] = "error"
                _batch_state["error"] = str(exc)[:200]
            finally:
                logger.info(f"🔚 THREAD ENDED: Final state = {_batch_state}")

        threading.Thread(target=_run, name="pv-glossary-batch", daemon=True).start()

        return jsonify({
            "ok": True,
            "queued": len(article_ids),
            "dry_run": dry_run,
            "glossary_version": glossary_version,
            "message": f"Queued {len(article_ids)} articles for improvement"
        })
    except Exception as e:
        logger.exception("Failed to queue improvement batch")
        return jsonify({"error": str(e)[:300]}), 500


@prionvault_bp.route("/api/glossary/batch-status", methods=["GET"])
@admin_required
def api_glossary_batch_status():
    """Get current batch processing status with real-time progress tracking."""
    return jsonify({
        "status": _batch_state.get("status"),
        "error": _batch_state.get("error"),
        "queued": _batch_state.get("queued", 0),
        "processed": _batch_state.get("processed", 0),
        "batch_id": _batch_state.get("batch_id"),
        "current_article": _batch_state.get("current_article", ""),
        "current_status": _batch_state.get("current_status", ""),
    })


@prionvault_bp.route("/api/glossary/batch-changes/<batch_id>", methods=["GET"])
@admin_required
def api_glossary_batch_changes(batch_id):
    """Get all corrections made in a batch, grouped and counted."""
    try:
        with db.engine.connect() as conn:
            # Get all corrections for this batch, grouped by original→corrected
            rows = conn.execute(sql_text("""
                SELECT
                    scd.original_text,
                    scd.corrected_text,
                    scd.term_en,
                    scd.recommended_es,
                    scd.correction_type,
                    COUNT(*) as change_count,
                    AVG(CAST(scd.confidence_score AS DECIMAL)) as avg_confidence
                FROM summary_correction_detail scd
                JOIN summary_improvement_log sil ON scd.improvement_log_id = sil.id
                WHERE sil.batch_id = :batch_id
                GROUP BY scd.original_text, scd.corrected_text, scd.term_en,
                         scd.recommended_es, scd.correction_type
                ORDER BY change_count DESC, scd.original_text
            """), {"batch_id": batch_id}).mappings().all()

            changes = [dict(r) for r in rows]

            return jsonify({
                "batch_id": batch_id,
                "total_changes": sum(c["change_count"] for c in changes),
                "unique_changes": len(changes),
                "changes": changes,
            })
    except Exception as e:
        logger.exception(f"Failed to fetch batch changes: {e}")
        return jsonify({"error": str(e)[:300]}), 500


@prionvault_bp.route("/api/glossary/batch-export/<batch_id>", methods=["GET"])
@admin_required
def api_glossary_batch_export(batch_id):
    """Export batch changes as a formatted Excel file."""
    try:
        with db.engine.connect() as conn:
            # Get batch info
            batch_info = conn.execute(sql_text("""
                SELECT COUNT(DISTINCT article_id) as articles_improved,
                       MAX(improved_at) as completed_at
                FROM summary_improvement_log
                WHERE batch_id = :batch_id
            """), {"batch_id": batch_id}).mappings().first()

            # Get all corrections with article info
            rows = conn.execute(sql_text("""
                SELECT
                    sil.article_id::text,
                    a.title,
                    scd.original_text,
                    scd.corrected_text,
                    scd.term_en,
                    scd.recommended_es,
                    scd.correction_type,
                    scd.confidence_score,
                    sil.improved_at
                FROM summary_correction_detail scd
                JOIN summary_improvement_log sil ON scd.improvement_log_id = sil.id
                JOIN articles a ON sil.article_id = a.id
                WHERE sil.batch_id = :batch_id
                ORDER BY sil.improved_at DESC, a.title, scd.original_text
            """), {"batch_id": batch_id}).mappings().all()

            changes = [dict(r) for r in rows]

        # Create Excel workbook
        wb = Workbook()
        ws = wb.active
        ws.title = "Cambios"

        # Define styles
        header_fill = PatternFill(start_color="366092", end_color="366092", fill_type="solid")
        header_font = Font(bold=True, color="FFFFFF", size=11)
        title_font = Font(bold=True, size=14, color="366092")
        subheader_fill = PatternFill(start_color="D9E8F5", end_color="D9E8F5", fill_type="solid")
        subheader_font = Font(bold=True, size=10)
        center_align = Alignment(horizontal="center", vertical="center", wrap_text=True)
        left_align = Alignment(horizontal="left", vertical="center", wrap_text=True)
        border = Border(
            left=Side(style="thin"),
            right=Side(style="thin"),
            top=Side(style="thin"),
            bottom=Side(style="thin"),
        )

        # Title and metadata
        ws['A1'] = "📊 REPORTE DE CAMBIOS - MEJORA DE RESÚMENES"
        ws['A1'].font = title_font
        ws.merge_cells('A1:F1')
        ws['A1'].alignment = left_align

        ws['A2'] = f"Batch ID: {batch_id}"
        ws['A2'].font = Font(size=9, italic=True, color="666666")
        ws['A3'] = f"Fecha: {datetime.now().strftime('%d/%m/%Y %H:%M')}"
        ws['A3'].font = Font(size=9, italic=True, color="666666")

        # Summary stats
        row = 5
        ws[f'A{row}'] = "RESUMEN"
        ws[f'A{row}'].font = subheader_font
        ws[f'A{row}'].fill = subheader_fill

        row += 1
        ws[f'A{row}'] = f"Artículos procesados:"
        ws[f'B{row}'] = batch_info['articles_improved'] if batch_info else 0
        ws[f'A{row}'].font = Font(bold=True)

        row += 1
        ws[f'A{row}'] = f"Total de cambios:"
        ws[f'B{row}'] = len(changes)
        ws[f'A{row}'].font = Font(bold=True)

        # Set column widths
        ws.column_dimensions['A'].width = 35
        ws.column_dimensions['B'].width = 35
        ws.column_dimensions['C'].width = 15
        ws.column_dimensions['D'].width = 15
        ws.column_dimensions['E'].width = 12

        # Group changes by article
        from collections import defaultdict
        by_article = defaultdict(list)
        for change in changes:
            key = (change['article_id'], change['title'])
            by_article[key].append(change)

        # Add data grouped by article
        row = 10
        for (article_id, article_title), article_changes in sorted(by_article.items()):
            # Article header with link to PrionVault
            ws[f'A{row}'] = f"📄 {article_title[:60]}"
            ws[f'A{row}'].font = article_font
            ws[f'A{row}'].fill = article_fill

            # Create hyperlink to PrionVault
            prionvault_url = f"/prionvault/?id={article_id}"
            ws[f'A{row}'].hyperlink = prionvault_url
            ws[f'A{row}'].font = Font(bold=True, color="0563C1", underline="single")

            ws.merge_cells(f'A{row}:E{row}')
            row += 1

            # Column headers for this article's changes
            headers = ["Texto Original", "Texto Corregido", "Término EN", "Recomendado ES", "Confianza (%)"]
            for col_idx, header in enumerate(headers, 1):
                cell = ws.cell(row=row, column=col_idx, value=header)
                cell.fill = header_fill
                cell.font = header_font
                cell.alignment = center_align
                cell.border = border

            row += 1

            # Data rows for this article
            for change in article_changes:
                confidence = f"{int(change['confidence_score'] * 100)}%" if change['confidence_score'] else "-"

                cells_data = [
                    change['original_text'],
                    change['corrected_text'],
                    change['term_en'] or "-",
                    change['recommended_es'] or "-",
                    confidence,
                ]

                for col_idx, value in enumerate(cells_data, 1):
                    cell = ws.cell(row=row, column=col_idx, value=value)
                    cell.border = border
                    cell.alignment = left_align if col_idx <= 2 else center_align
                    # Alternate row colors for readability
                    if row % 2 == 0:
                        cell.fill = PatternFill(start_color="F5F5F5", end_color="F5F5F5", fill_type="solid")

                row += 1

            # Blank row between articles
            row += 1

        # Freeze panes at header
        ws.freeze_panes = "A11"

        # Save to BytesIO
        output = BytesIO()
        wb.save(output)
        output.seek(0)

        # Return as file download
        return send_file(
            output,
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            as_attachment=True,
            download_name=f"batch-{batch_id[:8]}-cambios.xlsx"
        )

    except Exception as e:
        logger.exception(f"Failed to export batch changes: {e}")
        return jsonify({"error": str(e)[:300]}), 500


@prionvault_bp.route("/api/glossary/export-all-changes", methods=["GET"])
@admin_required
def api_glossary_export_all_changes():
    """Export all historical changes as a formatted Excel file."""
    try:
        with db.engine.connect() as conn:
            # Get all corrections with batch and article info
            rows = conn.execute(sql_text("""
                SELECT
                    sil.batch_id,
                    sil.article_id,
                    a.title,
                    scd.original_text,
                    scd.corrected_text,
                    scd.term_en,
                    scd.recommended_es,
                    scd.correction_type,
                    scd.confidence_score,
                    sil.improved_at,
                    sil.glossary_version_used
                FROM summary_correction_detail scd
                JOIN summary_improvement_log sil ON scd.improvement_log_id = sil.id
                JOIN articles a ON sil.article_id = a.id
                ORDER BY sil.improved_at DESC, sil.batch_id, a.title
            """)).mappings().all()

            changes = [dict(r) for r in rows]

        # Group by article for better organization
        from collections import defaultdict
        by_article = defaultdict(list)
        for change in changes:
            article_key = (change['article_id'], change['title'])
            by_article[article_key].append(change)

        # Create Excel workbook
        wb = Workbook()
        ws = wb.active
        ws.title = "Todos los cambios"

        # Define styles
        header_fill = PatternFill(start_color="366092", end_color="366092", fill_type="solid")
        header_font = Font(bold=True, color="FFFFFF", size=11)
        title_font = Font(bold=True, size=14, color="366092")
        article_fill = PatternFill(start_color="DCE6F1", end_color="DCE6F1", fill_type="solid")
        article_font = Font(bold=True, size=11, color="1F4E78")
        center_align = Alignment(horizontal="center", vertical="center", wrap_text=True)
        left_align = Alignment(horizontal="left", vertical="center", wrap_text=True)
        border = Border(
            left=Side(style="thin"),
            right=Side(style="thin"),
            top=Side(style="thin"),
            bottom=Side(style="thin"),
        )

        # Title and metadata
        ws['A1'] = "📊 HISTÓRICO COMPLETO DE CAMBIOS - MEJORA DE RESÚMENES"
        ws['A1'].font = title_font
        ws.merge_cells('A1:G1')
        ws['A1'].alignment = left_align

        ws['A2'] = f"Fecha de generación: {datetime.now().strftime('%d/%m/%Y %H:%M')}"
        ws['A2'].font = Font(size=9, italic=True, color="666666")
        ws['A3'] = f"Total de artículos procesados: {len(by_article)}"
        ws['A3'].font = Font(size=9, italic=True, color="666666")
        ws['A4'] = f"Total de cambios registrados: {len(changes)}"
        ws['A4'].font = Font(size=9, italic=True, color="666666")

        # Set column widths
        ws.column_dimensions['A'].width = 30
        ws.column_dimensions['B'].width = 25
        ws.column_dimensions['C'].width = 25
        ws.column_dimensions['D'].width = 15
        ws.column_dimensions['E'].width = 18
        ws.column_dimensions['F'].width = 12
        ws.column_dimensions['G'].width = 15

        current_row = 6

        # Add data grouped by article
        for (article_id, article_title) in sorted(by_article.keys(), key=lambda x: x[1]):
            article_changes = by_article[(article_id, article_title)]

            # Article header with link to PrionVault
            ws[f'A{current_row}'] = f"📄 {article_title[:60]}"
            ws[f'A{current_row}'].font = Font(bold=True, size=11, color="0563C1", underline="single")
            ws[f'A{current_row}'].fill = article_fill

            # Create hyperlink to PrionVault
            prionvault_url = f"/prionvault/?id={article_id}"
            ws[f'A{current_row}'].hyperlink = prionvault_url

            ws.merge_cells(f'A{current_row}:G{current_row}')
            current_row += 1

            # Column headers for this article
            headers = ["Texto Original", "Texto Corregido", "Término EN", "Recomendado ES", "Confianza", "Versión", "Fecha"]
            for col_idx, header in enumerate(headers, 1):
                cell = ws.cell(row=current_row, column=col_idx, value=header)
                cell.fill = header_fill
                cell.font = header_font
                cell.alignment = center_align
                cell.border = border

            current_row += 1

            # Data rows for this article
            for change in article_changes:
                confidence = f"{int(change['confidence_score'] * 100)}%" if change['confidence_score'] else "-"
                date_str = change['improved_at'].strftime('%d/%m/%Y') if change['improved_at'] else "-"

                cells_data = [
                    change['original_text'],
                    change['corrected_text'],
                    change['term_en'] or "-",
                    change['recommended_es'] or "-",
                    confidence,
                    f"v{change['glossary_version_used']}",
                    date_str,
                ]

                for col_idx, value in enumerate(cells_data, 1):
                    cell = ws.cell(row=current_row, column=col_idx, value=value)
                    cell.border = border
                    cell.alignment = left_align if col_idx <= 3 else center_align
                    if current_row % 2 == 0:
                        cell.fill = PatternFill(start_color="F5F5F5", end_color="F5F5F5", fill_type="solid")

                current_row += 1

            # Blank row between articles
            current_row += 1

        # Save to BytesIO
        output = BytesIO()
        wb.save(output)
        output.seek(0)

        # Return as file download
        return send_file(
            output,
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            as_attachment=True,
            download_name=f"cambios-completos-{datetime.now().strftime('%Y%m%d-%H%M')}.xlsx"
        )

    except Exception as e:
        logger.exception(f"Failed to export all changes: {e}")
        return jsonify({"error": str(e)[:300]}), 500


@prionvault_bp.route("/api/glossary/test-claude", methods=["GET"])
@admin_required
def api_glossary_test_claude():
    """Test if Claude API is working."""
    try:
        from anthropic import Anthropic
        import os

        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            return jsonify({"error": "ANTHROPIC_API_KEY not configured"}), 400

        client = Anthropic(api_key=api_key)
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=50,
            messages=[{"role": "user", "content": "Say OK"}],
        )

        return jsonify({
            "ok": True,
            "model": response.model,
            "message": response.content[0].text if response.content else "No response",
        })
    except Exception as e:
        logger.exception("Claude test failed")
        return jsonify({"error": str(e)}), 500


@prionvault_bp.route("/api/glossary/test-single", methods=["POST"])
@admin_required
def api_glossary_test_single():
    """Test improving a single article for debugging."""
    from .services import summary_improver, glossary_manager
    import time

    try:
        # Get one unreviewed article
        with db.engine.connect() as conn:
            article = conn.execute(sql_text("""
                SELECT id::text, summary_ai FROM articles
                WHERE summary_ai IS NOT NULL
                  AND ai_summary_glossary_version IS NULL
                  AND char_length(summary_ai) > 50
                LIMIT 1
            """)).first()

        if not article:
            return jsonify({"error": "No unreviewed articles found"}), 400

        article_id, summary = article
        logger.info(f"Testing improvement on {article_id}")

        # Get glossary
        glossary_context = glossary_manager.get_glossary_context()
        if not glossary_context:
            return jsonify({"error": "No glossary available"}), 400

        logger.info("Starting improve_summary call...")
        start = time.time()

        # Test improve (with timeout)
        improvement = summary_improver.improve_summary(
            article_id=article_id,
            original_summary=summary,
            glossary_context=glossary_context,
        )

        elapsed = time.time() - start

        logger.info(f"improve_summary completed in {elapsed:.2f}s")

        return jsonify({
            "ok": True,
            "article_id": article_id,
            "success": improvement.success,
            "original_length": improvement.original_length,
            "improved_length": improvement.improved_length,
            "error": improvement.error,
            "elapsed_seconds": elapsed,
        })

    except Exception as e:
        logger.exception("Test single improvement failed")
        return jsonify({"error": str(e)[:500]}), 500


@prionvault_bp.route("/glossary/test-single", methods=["GET"])
@admin_required
def glossary_test_single_page():
    """Page to test single article improvement."""
    html = """
    <h1>Prueba de Mejora Individual</h1>
    <style>body{font-family:sans-serif;margin:20px}button{padding:10px 20px;font-size:16px;background:#0066cc;color:white;border:none;cursor:pointer;border-radius:4px}button:hover{background:#0052a3}#result{margin-top:20px;padding:15px;background:#f5f5f5;border-radius:4px;white-space:pre-wrap;font-family:monospace}#loading{display:none;color:#666;margin-top:10px}.ok{color:green;font-weight:bold}.error{color:red;font-weight:bold}</style>
    <p>Haz clic para probar mejorar un artículo individual:</p>
    <button onclick="testSingle()">Probar Mejora</button>
    <div id="loading" style="display:none">⏳ Procesando... esto puede tomar 30 segundos o más</div>
    <div id="result"></div>

    <script>
    async function testSingle() {
        const btn = event.target;
        const loading = document.getElementById('loading');
        const result = document.getElementById('result');

        btn.disabled = true;
        loading.style.display = 'block';
        result.innerHTML = '';

        try {
            const res = await fetch('/prionvault/api/glossary/test-single', {
                method: 'POST',
                credentials: 'same-origin',
                headers: {'Content-Type': 'application/json'}
            });

            const data = await res.json();

            if (res.ok && data.ok) {
                result.innerHTML = `<span class="ok">✓ Éxito</span>
Artículo: ${data.article_id}
Tiempo: ${data.elapsed_seconds.toFixed(2)}s
Original: ${data.original_length} chars
Mejorado: ${data.improved_length} chars
Success: ${data.success}
Error: ${data.error || 'ninguno'}`;
            } else {
                result.innerHTML = `<span class="error">✗ Error</span>
${JSON.stringify(data, null, 2)}`;
            }
        } catch (e) {
            result.innerHTML = `<span class="error">✗ Error de conexión</span>
${e.message}`;
        } finally {
            btn.disabled = false;
            loading.style.display = 'none';
        }
    }
    </script>
    """
    return Response(html, mimetype='text/html')


@prionvault_bp.route("/glossary/diagnose", methods=["GET"])
@admin_required
def glossary_diagnose():
    """Diagnostic page for glossary processing."""
    import os
    from anthropic import Anthropic

    html = "<h1>Diagnóstico del Glosario</h1>"
    html += "<style>body{font-family:sans-serif;margin:20px}table{border-collapse:collapse;width:100%}td{border:1px solid #ccc;padding:10px}tr:nth-child(odd){background:#f9f9f9}.ok{color:green}.error{color:red}</style>"

    # Check API key
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    status = "✓" if api_key else "✗"
    html += f"<p><span class=\"{'ok' if api_key else 'error'}\">{status}</span> API Key configurada: {bool(api_key)}</p>"

    # Test Claude
    try:
        client = Anthropic(api_key=api_key) if api_key else None
        if client:
            response = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=50,
                messages=[{"role": "user", "content": "Say OK"}],
            )
            html += f"<p><span class=\"ok\">✓</span> Claude API funciona: {response.content[0].text if response.content else 'sin respuesta'}</p>"
        else:
            html += f"<p><span class=\"error\">✗</span> No se puede probar Claude sin API key</p>"
    except Exception as e:
        html += f"<p><span class=\"error\">✗</span> Error al conectar Claude: {str(e)}</p>"

    # Check database
    try:
        with db.engine.connect() as conn:
            count = conn.execute(sql_text("SELECT COUNT(*) FROM articles WHERE summary_ai IS NOT NULL")).scalar()
            html += f"<p><span class=\"ok\">✓</span> Base de datos OK: {count} artículos</p>"
    except Exception as e:
        html += f"<p><span class=\"error\">✗</span> Error de BD: {str(e)}</p>"

    # Batch status
    html += "<h2>Estado del Batch</h2>"
    html += f"<table>"
    html += f"<tr><td>Estado</td><td>{_batch_state.get('status', 'N/A')}</td></tr>"
    html += f"<tr><td>Procesados</td><td>{_batch_state.get('processed', 0)}</td></tr>"
    html += f"<tr><td>En cola</td><td>{_batch_state.get('queued', 0)}</td></tr>"
    if _batch_state.get('error'):
        html += f"<tr><td class=\"error\">Error</td><td class=\"error\">{_batch_state.get('error')}</td></tr>"
    html += "</table>"

    return Response(html, mimetype='text/html')


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


# ── Cost tracking ──────────────────────────────────────────────────────────
@prionvault_bp.route("/api/glossary/batch/cost/<batch_id>", methods=["GET"])
@admin_required
def api_batch_cost(batch_id):
    """Get estimated cost for a specific batch improvement.

    Returns:
      {
        "batch_id": "uuid",
        "articles_processed": 100,
        "estimated_cost_eur": 0.05,
        "estimated_cost_usd": 0.055,
        "note": "Estimation based on ~€0.0005 per article",
        "timestamp": "2026-07-19T12:34:56"
      }
    """
    try:
        with db.engine.connect() as conn:
            result = conn.execute(sql_text("""
                SELECT
                  COUNT(DISTINCT article_id) as articles,
                  MAX(improved_at) as timestamp
                FROM summary_improvement_log
                WHERE batch_id = :batch_id AND dry_run = FALSE
            """), {"batch_id": batch_id}).first()

            if not result or result[0] == 0:
                return jsonify({"error": "Batch not found"}), 404

            articles, timestamp = result
            # Claude Haiku cost: ~€0.00015-0.0002 per article for terminology replacement
            est_cost_eur = articles * 0.00015
            est_cost_usd = est_cost_eur * 1.10

            return jsonify({
                "batch_id": batch_id,
                "articles_processed": int(articles),
                "estimated_cost_eur": round(est_cost_eur, 4),
                "estimated_cost_usd": round(est_cost_usd, 4),
                "cost_summary": f"~€{round(est_cost_eur, 4)} (Claude Haiku - terminology replacement only)",
                "note": "Cost reflects Claude Haiku API calls for exact term replacement (no regeneration)",
                "timestamp": str(timestamp) if timestamp else None,
            })

    except Exception as e:
        logger.exception(f"Failed to fetch batch cost for {batch_id}")
        return jsonify({"error": str(e)[:300]}), 500


@prionvault_bp.route("/api/glossary/costs/summary", methods=["GET"])
@admin_required
def api_costs_summary():
    """Get estimated cost summary for glossary improvements.

    Query params:
      - days: Number of days to look back (default: 30)
      - limit: Max batches to return (default: 10)

    Returns estimated costs based on articles processed.
    """
    days = request.args.get("days", 30, type=int)
    limit = request.args.get("limit", 10, type=int)

    try:
        with db.engine.connect() as conn:
            # Get summary stats
            summary = conn.execute(sql_text("""
                SELECT
                  COUNT(DISTINCT batch_id) as batch_count,
                  COUNT(DISTINCT article_id) as article_count
                FROM summary_improvement_log
                WHERE dry_run = FALSE
                  AND improved_at >= NOW() - INTERVAL '1 day' * :days
            """), {"days": days}).first()

            batch_count, article_count = summary

            # Claude Haiku cost: ~€0.00015 per article
            est_total_eur = article_count * 0.00015
            est_total_usd = est_total_eur * 1.10
            avg_cost_per_article = 0.00015

            # Get recent batches
            batches = conn.execute(sql_text("""
                SELECT
                  batch_id,
                  COUNT(DISTINCT article_id) as articles,
                  MAX(improved_at) as timestamp
                FROM summary_improvement_log
                WHERE dry_run = FALSE
                  AND improved_at >= NOW() - INTERVAL '1 day' * :days
                GROUP BY batch_id
                ORDER BY timestamp DESC
                LIMIT :lim
            """), {"days": days, "lim": limit}).fetchall()

            recent_batches = []
            for batch_id, articles, ts in batches:
                batch_est_eur = articles * 0.00015
                batch_est_usd = batch_est_eur * 1.10
                recent_batches.append({
                    "batch_id": batch_id,
                    "articles": int(articles),
                    "estimated_cost_eur": round(batch_est_eur, 4),
                    "estimated_cost_usd": round(batch_est_usd, 4),
                    "timestamp": str(ts) if ts else None,
                })

            return jsonify({
                "period_days": days,
                "total_batches": int(batch_count),
                "total_articles": int(article_count),
                "estimated_total_eur": round(est_total_eur, 4),
                "estimated_total_usd": round(est_total_usd, 4),
                "avg_estimated_cost_per_article": round(avg_cost_per_article, 6),
                "note": "Cost reflects Claude Haiku API for exact terminology replacement (structure preserved)",
                "recent_batches": recent_batches,
            })

    except Exception as e:
        logger.exception("Failed to fetch cost summary")
        return jsonify({"error": str(e)[:300]}), 500


# ── Public glossary API (for other modules: PrionRead, PrionPacks, etc.) ─────
@prionvault_bp.route("/api/glossary/public/version", methods=["GET"])
@login_required
def api_glossary_public_version():
    """Get current glossary version (public API for other modules)."""
    from .services import glossary_manager
    try:
        version = glossary_manager.get_current_glossary_version()
        return jsonify({"version": version})
    except Exception as e:
        logger.exception("Failed to fetch glossary version")
        return jsonify({"error": str(e)[:300]}), 500


@prionvault_bp.route("/api/glossary/public/terms", methods=["GET"])
@login_required
def api_glossary_public_terms():
    """Get all glossary terms (public API for other modules).

    Optional query params:
    - category: Filter by category
    - limit: Max results (default 1000)
    - offset: Pagination offset (default 0)
    """
    from .services import glossary_manager

    try:
        category = request.args.get("category", "").strip() or None
        limit = min(int(request.args.get("limit", 1000)), 5000)
        offset = int(request.args.get("offset", 0))

        terms = glossary_manager.get_all_terms(category=category)
        total = len(terms)
        paginated = terms[offset:offset + limit]

        return jsonify({
            "version": glossary_manager.get_current_glossary_version(),
            "total": total,
            "returned": len(paginated),
            "offset": offset,
            "limit": limit,
            "terms": [
                {
                    "term_en": t.get("term_en", "").lower(),
                    "term_es_recommended": t.get("term_es_recommended", ""),
                    "term_es_avoid": t.get("term_es_avoid"),
                    "category": t.get("category"),
                    "notes": t.get("notes"),
                }
                for t in paginated
            ]
        })
    except Exception as e:
        logger.exception("Failed to fetch glossary terms")
        return jsonify({"error": str(e)[:300]}), 500


@prionvault_bp.route("/api/glossary/public/search", methods=["GET"])
@login_required
def api_glossary_public_search():
    """Search glossary terms by English or Spanish (public API).

    Query params:
    - q: Search query (required)
    - limit: Max results (default 50)
    """
    from .services import glossary_manager

    try:
        query = request.args.get("q", "").strip().lower()
        if not query:
            return jsonify({"error": "Missing 'q' parameter"}), 400

        limit = min(int(request.args.get("limit", 50)), 500)

        all_terms = glossary_manager.get_all_terms()
        matches = []

        for term in all_terms:
            term_en = (term.get("term_en") or "").lower()
            term_es = (term.get("term_es_recommended") or "").lower()
            avoid = (term.get("term_es_avoid") or "").lower()

            # Simple substring match (can be improved with fuzzy matching)
            if query in term_en or query in term_es or (avoid and query in avoid):
                matches.append({
                    "term_en": term.get("term_en", ""),
                    "term_es_recommended": term.get("term_es_recommended", ""),
                    "term_es_avoid": term.get("term_es_avoid"),
                    "category": term.get("category"),
                    "notes": term.get("notes"),
                })

            if len(matches) >= limit:
                break

        return jsonify({
            "query": query,
            "found": len(matches),
            "limited_to": limit if len(matches) >= limit else None,
            "results": matches[:limit]
        })
    except Exception as e:
        logger.exception("Failed to search glossary")
        return jsonify({"error": str(e)[:300]}), 500
