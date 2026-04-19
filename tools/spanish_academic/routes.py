"""Routes for Spanish Academic Systems (ANECA & CVN FECYT)."""
import logging

from flask import jsonify, make_response, request, session

from core.decorators import login_required
from tools.spanish_academic import spanish_academic_bp

logger = logging.getLogger(__name__)


def _current_username() -> str:
    return session.get("username", "")


# ── ANECA ─────────────────────────────────────────────────────────────────────

@spanish_academic_bp.route("/aneca/profile")
@login_required
def aneca_profile():
    """GET /api/spanish-academic/aneca/profile?username=<u>"""
    username = request.args.get("username") or _current_username()
    if not username:
        return jsonify({"success": False, "error": "username required"}), 400
    try:
        from tools.spanish_academic.aneca import export_json
        return jsonify({"success": True, "profile": export_json(username)})
    except ValueError as e:
        return jsonify({"success": False, "error": str(e)}), 404
    except Exception as e:
        logger.error("ANECA profile error: %s", e)
        return jsonify({"success": False, "error": str(e)}), 500


@spanish_academic_bp.route("/aneca/export")
@login_required
def aneca_export():
    """
    GET /api/spanish-academic/aneca/export?username=<u>&format=json|csv
    Downloads ANECA-formatted CV data.
    """
    username = request.args.get("username") or _current_username()
    fmt = request.args.get("format", "json").lower()
    if not username:
        return jsonify({"success": False, "error": "username required"}), 400
    try:
        if fmt == "csv":
            from tools.spanish_academic.aneca import export_csv
            csv_data = export_csv(username)
            resp = make_response(csv_data)
            resp.headers["Content-Type"] = "text/csv; charset=utf-8"
            resp.headers["Content-Disposition"] = f'attachment; filename="aneca_{username}.csv"'
            return resp
        else:
            from tools.spanish_academic.aneca import export_json
            return jsonify({"success": True, "profile": export_json(username)})
    except ValueError as e:
        return jsonify({"success": False, "error": str(e)}), 404
    except Exception as e:
        logger.error("ANECA export error: %s", e)
        return jsonify({"success": False, "error": str(e)}), 500


# ── CVN ───────────────────────────────────────────────────────────────────────

@spanish_academic_bp.route("/cvn/export")
@login_required
def cvn_export():
    """
    GET /api/spanish-academic/cvn/export?username=<u>
    Downloads CVN XML for the researcher.
    """
    username = request.args.get("username") or _current_username()
    if not username:
        return jsonify({"success": False, "error": "username required"}), 400
    try:
        from tools.spanish_academic.cvn import export_cvn_xml
        xml_str = export_cvn_xml(username)
        resp = make_response(xml_str)
        resp.headers["Content-Type"] = "application/xml; charset=utf-8"
        resp.headers["Content-Disposition"] = f'attachment; filename="cvn_{username}.xml"'
        return resp
    except ValueError as e:
        return jsonify({"success": False, "error": str(e)}), 404
    except Exception as e:
        logger.error("CVN export error: %s", e)
        return jsonify({"success": False, "error": str(e)}), 500


@spanish_academic_bp.route("/cvn/import", methods=["POST"])
@login_required
def cvn_import():
    """
    POST /api/spanish-academic/cvn/import
    Body: { "username": "...", "cvn_xml": "<xml>..." }
    Merges CVN publication data into the database.
    """
    data = request.get_json(silent=True) or {}
    username = data.get("username") or _current_username()
    cvn_xml = data.get("cvn_xml", "").strip()
    if not username:
        return jsonify({"success": False, "error": "username required"}), 400
    if not cvn_xml:
        return jsonify({"success": False, "error": "cvn_xml required"}), 400
    try:
        from tools.spanish_academic.cvn import import_cvn_xml
        result = import_cvn_xml(username, cvn_xml)
        return jsonify(result)
    except Exception as e:
        logger.error("CVN import error: %s", e)
        return jsonify({"success": False, "error": str(e)}), 500


# ── Dashboard ─────────────────────────────────────────────────────────────────

@spanish_academic_bp.route("/dashboard")
@login_required
def dashboard():
    """
    GET /api/spanish-academic/dashboard?username=<u>
    Combined ANECA + CVN status for the researcher dashboard.
    """
    username = request.args.get("username") or _current_username()
    if not username:
        return jsonify({"success": False, "error": "username required"}), 400
    try:
        from tools.spanish_academic.aneca import export_json
        profile = export_json(username)
        return jsonify({
            "success": True,
            "username": username,
            "aneca": {
                "full_name": profile.get("full_name"),
                "total_publications": profile.get("total_publications", 0),
                "q1_publications": profile.get("q1_publications", 0),
                "q2_publications": profile.get("q2_publications", 0),
                "total_merit_points": profile.get("total_merit_points", 0),
                "avg_impact_factor": profile.get("avg_impact_factor"),
                "total_citations": profile.get("total_citations", 0),
                "sexenios_eligible": profile.get("sexenios_eligible", 0),
            },
            "cvn_export_url": f"/api/spanish-academic/cvn/export?username={username}",
            "aneca_export_urls": {
                "json": f"/api/spanish-academic/aneca/export?username={username}&format=json",
                "csv": f"/api/spanish-academic/aneca/export?username={username}&format=csv",
            },
            "generated_at": profile.get("generated_at"),
        })
    except ValueError as e:
        return jsonify({"success": False, "error": str(e)}), 404
    except Exception as e:
        logger.error("Spanish academic dashboard error: %s", e)
        return jsonify({"success": False, "error": str(e)}), 500
