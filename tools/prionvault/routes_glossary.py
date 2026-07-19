"""Glossary management routes for PrionVault.

Handles glossary CRUD, summary improvement, and statistics.
Routes registered as side-effect import at bottom of routes.py.
"""
import logging
import threading
from datetime import datetime
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
    except Exception as e:
        logger.exception("Failed to queue improvement batch")
        return jsonify({"error": str(e)[:300]}), 500


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


# ── Admin: Test single improvement ──────────────────────────────────────────
@prionvault_bp.route("/api/admin/test-improvement", methods=["POST"])
@admin_required
def api_admin_test_improvement():
    """Test a single article improvement synchronously (not in background).

    This helps diagnose if the improvement logic works, without waiting for
    the background thread.

    Returns the improvement result immediately.
    """
    from .services import summary_improver, glossary_manager

    try:
        # Get one unreviewed article
        with db.engine.connect() as conn:
            article = conn.execute(sql_text("""
                SELECT id::text, summary_ai FROM articles
                WHERE summary_ai IS NOT NULL
                  AND ai_summary_glossary_version IS NULL
                  AND char_length(summary_ai) > 50
                ORDER BY RANDOM()
                LIMIT 1
            """)).mappings().first()

        if not article:
            return jsonify({
                "error": "No unreviewed articles found",
                "status": "No articles to test with"
            }), 400

        article_id = article['id']
        summary = article['summary_ai']

        # Get glossary
        glossary_context = glossary_manager.get_glossary_context()
        if not glossary_context:
            return jsonify({"error": "No glossary available"}), 400

        # Try to improve synchronously
        logger.info(f"🧪 TESTING improvement for {article_id}...")
        result = summary_improver.improve_summary(
            article_id=article_id,
            original_summary=summary,
            glossary_context=glossary_context,
            use_fuzzy_matching=True
        )

        return jsonify({
            "success": result.success,
            "article_id": article_id,
            "original_length": result.original_length,
            "improved_length": result.improved_length,
            "error": result.error,
            "message": "✅ Improvement successful" if result.success else "❌ Improvement failed"
        })

    except Exception as e:
        logger.exception(f"Test improvement failed: {e}")
        return jsonify({
            "error": str(e),
            "status": "❌ Error during test"
        }), 500


# ── Admin: Diagnostics ──────────────────────────────────────────────────────
@prionvault_bp.route("/api/admin/diagnostics", methods=["GET"])
@admin_required
def api_admin_diagnostics():
    """Diagnostic endpoint to check batch improvement system status.

    Shows:
    - Model version being used
    - Database table existence
    - Recent improvement logs
    - Unreviewed article count
    """
    import os
    from tools.prionvault.services import summary_improver

    diagnostics = {
        "timestamp": datetime.utcnow().isoformat(),
        "model_in_use": "claude-haiku-4-5-20251001",  # Current model
    }

    try:
        # Check database tables
        with db.engine.connect() as conn:
            tables_check = {}
            for table in ['summary_improvement_log', 'summary_correction_detail', 'glossary_improvement_stats']:
                result = conn.execute(sql_text(f"""
                    SELECT EXISTS (
                        SELECT 1 FROM information_schema.tables
                        WHERE table_name = '{table}'
                    )
                """)).scalar()
                tables_check[table] = bool(result)

            diagnostics["tables"] = tables_check

            # Get unreviewed count
            unreviewed = conn.execute(sql_text("""
                SELECT COUNT(*) FROM articles
                WHERE summary_ai IS NOT NULL
                  AND ai_summary_glossary_version IS NULL
                  AND char_length(summary_ai) > 50
            """)).scalar() or 0
            diagnostics["unreviewed_count"] = unreviewed

            # Check recent logs
            if tables_check['summary_improvement_log']:
                recent = conn.execute(sql_text("""
                    SELECT COUNT(*) as total,
                           MAX(improved_at) as latest
                    FROM summary_improvement_log
                    WHERE improved_at > NOW() - INTERVAL '1 hour'
                """)).mappings().first()
                if recent:
                    diagnostics["recent_improvements_1h"] = {
                        "count": recent['total'] or 0,
                        "latest": str(recent['latest']) if recent['latest'] else None
                    }

        diagnostics["status"] = "✅ All systems operational"

    except Exception as e:
        diagnostics["error"] = str(e)
        diagnostics["status"] = f"❌ Error: {str(e)[:100]}"

    return jsonify(diagnostics)


# ── Admin: Run database migrations ──────────────────────────────────────────
@prionvault_bp.route("/api/admin/run-migrations", methods=["POST"])
@admin_required
def api_admin_run_migrations():
    """Run pending database migrations to create missing tables.

    This endpoint is useful when tables haven't been created yet (e.g.,
    summary_improvement_log, summary_correction_detail, glossary_improvement_stats).

    Admin-only endpoint.
    """
    try:
        logger.info("🔧 Starting database migrations...")
        db.run_migrations()
        logger.info("✅ Database migrations completed successfully")

        return jsonify({
            "ok": True,
            "message": "Database migrations completed successfully. Tables created if they didn't exist.",
        })
    except Exception as e:
        logger.exception(f"❌ Failed to run migrations: {e}")
        return jsonify({
            "error": f"Migration failed: {str(e)[:300]}",
            "details": str(e)
        }), 500


@prionvault_bp.route("/api/admin/create-tables", methods=["POST"])
@admin_required
def api_admin_create_tables():
    """Force creation of glossary tracking tables using raw SQL.

    Creates missing tables directly:
    - summary_improvement_log
    - summary_correction_detail
    - glossary_improvement_stats

    Useful when migrations don't work or haven't run.
    """
    try:
        logger.info("🔧 FORCE creating glossary tracking tables...")

        with db.engine.begin() as conn:
            # Create summary_improvement_log
            conn.execute(sql_text("""
                CREATE TABLE IF NOT EXISTS summary_improvement_log (
                    id                      BIGSERIAL  PRIMARY KEY,
                    article_id              UUID       NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
                    glossary_version_used   INTEGER    NOT NULL,
                    improved_at             TIMESTAMPTZ DEFAULT NOW(),
                    original_summary        TEXT       NOT NULL,
                    improved_summary        TEXT       NOT NULL,
                    changes_count           INTEGER    DEFAULT 0,
                    batch_id                UUID,
                    dry_run                 BOOLEAN    DEFAULT FALSE
                )
            """))
            logger.info("✅ Created summary_improvement_log")

            # Create indexes for summary_improvement_log
            conn.execute(sql_text("""
                CREATE INDEX IF NOT EXISTS idx_summary_improvement_log_article_id
                ON summary_improvement_log (article_id)
            """))
            conn.execute(sql_text("""
                CREATE INDEX IF NOT EXISTS idx_summary_improvement_log_glossary_version
                ON summary_improvement_log (glossary_version_used)
            """))
            conn.execute(sql_text("""
                CREATE INDEX IF NOT EXISTS idx_summary_improvement_log_improved_at
                ON summary_improvement_log (improved_at)
            """))
            conn.execute(sql_text("""
                CREATE INDEX IF NOT EXISTS idx_summary_improvement_log_batch_id
                ON summary_improvement_log (batch_id)
            """))

            # Create summary_correction_detail
            conn.execute(sql_text("""
                CREATE TABLE IF NOT EXISTS summary_correction_detail (
                    id                     BIGSERIAL   PRIMARY KEY,
                    improvement_log_id     BIGINT      NOT NULL REFERENCES summary_improvement_log(id) ON DELETE CASCADE,
                    original_text          TEXT        NOT NULL,
                    corrected_text         TEXT        NOT NULL,
                    term_en                VARCHAR(255),
                    recommended_es         VARCHAR(255),
                    correction_type        VARCHAR(50),
                    confidence_score       DECIMAL(3,2),
                    context_before         TEXT,
                    context_after          TEXT
                )
            """))
            logger.info("✅ Created summary_correction_detail")

            conn.execute(sql_text("""
                CREATE INDEX IF NOT EXISTS idx_summary_correction_detail_improvement_log_id
                ON summary_correction_detail (improvement_log_id)
            """))
            conn.execute(sql_text("""
                CREATE INDEX IF NOT EXISTS idx_summary_correction_detail_term_en
                ON summary_correction_detail (term_en)
            """))

            # Create glossary_improvement_stats
            conn.execute(sql_text("""
                CREATE TABLE IF NOT EXISTS glossary_improvement_stats (
                    id                      BIGSERIAL   PRIMARY KEY,
                    calculated_at           TIMESTAMPTZ DEFAULT NOW(),
                    total_articles_improved INTEGER     DEFAULT 0,
                    total_changes           INTEGER     DEFAULT 0,
                    articles_with_v1        INTEGER     DEFAULT 0,
                    articles_with_v2        INTEGER     DEFAULT 0,
                    articles_with_v3        INTEGER     DEFAULT 0,
                    articles_with_v4        INTEGER     DEFAULT 0,
                    articles_with_v5        INTEGER     DEFAULT 0,
                    avg_changes_per_article DECIMAL(5,2) DEFAULT 0,
                    most_common_correction  VARCHAR(255),
                    last_improvement_at     TIMESTAMPTZ
                )
            """))
            logger.info("✅ Created glossary_improvement_stats")

            conn.execute(sql_text("""
                CREATE UNIQUE INDEX IF NOT EXISTS glossary_stats_latest_idx
                ON glossary_improvement_stats ((1))
            """))

        logger.info("✅ All glossary tracking tables created successfully")
        return jsonify({
            "ok": True,
            "message": "All glossary tracking tables created successfully",
            "tables_created": [
                "summary_improvement_log",
                "summary_correction_detail",
                "glossary_improvement_stats"
            ]
        })

    except Exception as e:
        logger.exception(f"❌ Failed to create tables: {e}")
        return jsonify({
            "error": f"Failed to create tables: {str(e)[:300]}",
            "details": str(e)
        }), 500
