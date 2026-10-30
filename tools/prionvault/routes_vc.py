"""Vigilancia competitiva — HTTP API (see services/vc.py).

Everyone can read the reports; resolving references / importing articles
and fixing ambiguous references is admin-only.
"""
import logging

from flask import jsonify, request

from core.decorators import admin_required, login_required
from tools.prionvault import prionvault_bp

from ._helpers import _viewer_id

logger = logging.getLogger(__name__)


@prionvault_bp.route("/api/vc/reports", methods=["GET"])
@login_required
def api_vc_reports():
    from .services import vc
    try:
        return jsonify({"reports": vc.list_reports(), "status": vc.get_status()})
    except Exception as exc:
        if "does not exist" in str(exc):
            return jsonify({"reports": [], "status": vc.get_status(), "needs_setup": True})
        logger.exception("vc reports failed")
        return jsonify({"error": "internal", "detail": str(exc)[:300]}), 500


@prionvault_bp.route("/api/vc/reports/<int:year>", methods=["GET"])
@login_required
def api_vc_report(year):
    from .services import vc
    rep = vc.get_report(year)
    if not rep:
        return jsonify({"error": "not_found"}), 404
    return jsonify(rep)


@prionvault_bp.route("/api/vc/resolve", methods=["POST"])
@admin_required
def api_vc_resolve():
    """Load the historical reports (idempotent) and resolve every pending
    reference into PrionVault articles + the "VC <year>" collections."""
    from .services import vc
    body = request.get_json(silent=True) or {}
    snap = vc.start_resolve(by_user=_viewer_id(),
                            retry_ambiguous=bool(body.get("retry_ambiguous")))
    if snap is None:
        return jsonify({"error": "already_running", "status": vc.get_status()}), 409
    return jsonify({"ok": True, "status": snap})


@prionvault_bp.route("/api/vc/resolve/status", methods=["GET"])
@login_required
def api_vc_resolve_status():
    from .services import vc
    return jsonify(vc.get_status())


@prionvault_bp.route("/api/vc/resolve/stop", methods=["POST"])
@admin_required
def api_vc_resolve_stop():
    from .services import vc
    return jsonify(vc.stop())


@prionvault_bp.route("/api/vc/refs/<int:ref_id>/pick", methods=["POST"])
@admin_required
def api_vc_ref_pick(ref_id):
    """Fix a reference by hand: {"pmid": "..."} (imported if missing)."""
    from .services import vc
    pmid = str((request.get_json(silent=True) or {}).get("pmid") or "").strip()
    if not pmid.isdigit():
        return jsonify({"error": "bad_pmid", "detail": "Indica un PMID numérico."}), 400
    try:
        status = vc.pick_pmid(ref_id, pmid, by_user=_viewer_id())
    except LookupError as exc:
        return jsonify({"error": "not_found", "detail": str(exc)}), 404
    return jsonify({"ok": True, "status": status})
