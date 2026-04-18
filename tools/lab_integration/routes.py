"""Lab Integration API routes."""
import asyncio
import io
import logging

from flask import jsonify, request, send_file, session

from core.decorators import admin_required, login_required
from . import lab_integration_bp
from .ai_discovery import DiscoveryQuery, get_ai_discovery
from .csv_importer import get_csv_importer
from .orcid_lab_importer import LabMember, get_lab_importer

logger = logging.getLogger(__name__)


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ── ORCID bulk import ──────────────────────────────────────────────────────────

@lab_integration_bp.route("/import/orcid", methods=["POST"])
@login_required
@admin_required
def import_lab_from_orcid():
    data = request.get_json(silent=True) or {}
    pi_data = data.get("principal_investigator", {})
    if not pi_data or not pi_data.get("orcid_id"):
        return jsonify({"success": False, "error": "principal_investigator.orcid_id required"}), 400

    pi = LabMember(
        name=pi_data.get("name", "Principal Investigator"),
        orcid_id=pi_data["orcid_id"],
        email=pi_data.get("email", ""),
        role="principal_investigator",
    )
    members = [
        LabMember(
            name=m.get("name", "Lab Member"),
            orcid_id=m["orcid_id"],
            email=m.get("email", ""),
            role=m.get("role", "researcher"),
            active=m.get("active", True),
        )
        for m in data.get("lab_members", []) if m.get("orcid_id")
    ]

    try:
        result = _run(
            get_lab_importer().import_full_lab(
                pi, members,
                years_back=int(data.get("years_back", 10)),
                min_relevance_score=float(data.get("min_relevance_score", 0.3)),
            )
        )
        return jsonify({
            "success": result.success,
            "publications_found": result.publications_found,
            "publications_imported": result.publications_imported,
            "duplicates_found": result.duplicates_found,
            "lab_collaborations": result.lab_collaborations,
            "external_collaborations": result.external_collaborations,
            "processed_members": result.processed_members,
            "errors": result.errors[:10],
        })
    except Exception as exc:
        logger.error("import_lab_from_orcid: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


# ── AI discovery ───────────────────────────────────────────────────────────────

@lab_integration_bp.route("/discover/ai", methods=["POST"])
@login_required
def ai_discover_publications():
    data = request.get_json(silent=True) or {}
    raw_queries = data.get("queries", [])
    queries = [
        DiscoveryQuery(
            author_name=q["author_name"],
            institution=q.get("institution", ""),
            research_keywords=q.get("research_keywords", []),
            years_back=int(q.get("years_back", 5)),
            max_results=int(q.get("max_results", 50)),
            confidence_threshold=float(q.get("confidence_threshold", 0.7)),
        )
        for q in raw_queries if q.get("author_name")
    ]
    if not queries:
        return jsonify({"success": False, "error": "At least one query with author_name required"}), 400

    try:
        discoveries = _run(
            get_ai_discovery().discover_lab_publications(queries, cross_validate=True)
        )
        return jsonify({
            "success": True,
            "discoveries": [d.to_dict() for d in discoveries],
            "total_found": len(discoveries),
            "high_confidence": sum(1 for d in discoveries if d.confidence_score >= 0.8),
        })
    except Exception as exc:
        logger.error("ai_discover_publications: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


# ── CSV import ─────────────────────────────────────────────────────────────────

@lab_integration_bp.route("/import/csv/validate", methods=["POST"])
@login_required
def validate_csv():
    data = request.get_json(silent=True) or {}
    csv_content = data.get("csv_content", "")
    if not csv_content:
        return jsonify({"success": False, "error": "csv_content required"}), 400
    result = get_csv_importer().validate_csv_content(csv_content)
    return jsonify({
        "success": result.success,
        "valid_rows": result.valid_rows,
        "invalid_rows": result.invalid_rows,
        "errors": result.errors[:20],
        "warnings": result.warnings[:20],
        "can_import": result.success,
    })


@lab_integration_bp.route("/import/csv/execute", methods=["POST"])
@login_required
def import_csv():
    data = request.get_json(silent=True) or {}
    csv_content = data.get("csv_content", "")
    if not csv_content:
        return jsonify({"success": False, "error": "csv_content required"}), 400

    importer = get_csv_importer()
    validation = importer.validate_csv_content(csv_content)
    if not validation.success:
        return jsonify({"success": False, "error": "CSV validation failed", "validation_errors": validation.errors[:10]}), 400

    result = importer.import_csv_data(
        validation.parsed_data,
        update_existing=bool(data.get("update_existing", True)),
        username=session.get("username", ""),
    )
    return jsonify({
        "success": result.success,
        "total_rows": result.total_rows,
        "imported": result.imported,
        "updated": result.updated,
        "skipped": result.skipped,
        "errors": result.errors[:10],
    })


@lab_integration_bp.route("/template/csv")
@login_required
def download_csv_template():
    try:
        content = get_csv_importer().generate_csv_template()
        buf = io.BytesIO(content.encode("utf-8"))
        buf.seek(0)
        return send_file(buf, mimetype="text/csv", as_attachment=True,
                         download_name="lab_publications_template.csv")
    except Exception as exc:
        logger.error("download_csv_template: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


# ── Analytics ─────────────────────────────────────────────────────────────────

@lab_integration_bp.route("/analytics/lab")
@login_required
def lab_analytics():
    analytics: dict = {
        "total_publications": 0,
        "publications_by_year": {},
        "top_journals": [],
        "research_areas": {},
        "citation_metrics": {"total_citations": 0, "avg_citations": 0.0},
    }
    try:
        from tools.research.models import get_all_publications
        pubs = get_all_publications()
        analytics["total_publications"] = len(pubs)
        year_counts: dict = {}
        journal_counts: dict = {}
        area_counts: dict = {}
        total_cites = 0
        for p in pubs:
            yr = str(p.get("year", ""))
            if yr:
                year_counts[yr] = year_counts.get(yr, 0) + 1
            j = p.get("journal", "")
            if j:
                journal_counts[j] = journal_counts.get(j, 0) + 1
            area = p.get("research_area", "") or p.get("research_areas", "")
            if area:
                area_counts[str(area)] = area_counts.get(str(area), 0) + 1
            try:
                total_cites += int(p.get("citation_count", 0) or 0)
            except (TypeError, ValueError):
                pass
        analytics["publications_by_year"] = dict(sorted(year_counts.items(), reverse=True))
        top_journals = sorted(journal_counts.items(), key=lambda x: x[1], reverse=True)[:10]
        analytics["top_journals"] = [{"journal": j, "count": c} for j, c in top_journals]
        analytics["research_areas"] = area_counts
        analytics["citation_metrics"]["total_citations"] = total_cites
        if pubs:
            analytics["citation_metrics"]["avg_citations"] = round(total_cites / len(pubs), 2)
    except Exception as exc:
        logger.warning("lab_analytics: %s", exc)
    return jsonify({"success": True, "analytics": analytics})
