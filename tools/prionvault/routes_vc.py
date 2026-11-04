"""Vigilancia competitiva — HTTP API (see services/vc.py).

Everyone can read the reports; resolving references / importing articles
and fixing ambiguous references is admin-only.
"""
import logging

from flask import jsonify, request

from core.decorators import login_required
from tools.prionvault import prionvault_bp

from ._helpers import _viewer_id, _viewer_is_vc_editor


def vc_editor_required(f):
    """Admins and users flagged 'Editor de Vigilancia competitiva'."""
    from functools import wraps

    @wraps(f)
    def wrapper(*a, **kw):
        from flask import session
        if not session.get("logged_in"):
            return jsonify({"error": "not_authenticated"}), 401
        if not _viewer_is_vc_editor():
            return jsonify({"error": "forbidden",
                            "detail": "Solo administradores o editores de Vigilancia competitiva."}), 403
        return f(*a, **kw)
    return wrapper

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
@vc_editor_required
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
@vc_editor_required
def api_vc_resolve_stop():
    from .services import vc
    return jsonify(vc.stop())


@prionvault_bp.route("/api/vc/refs/<int:ref_id>/pick", methods=["POST"])
@vc_editor_required
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


# ── Generator for the current year's report (services/vc_generate.py) ───────

@prionvault_bp.route("/api/vc/draft/<int:year>", methods=["GET"])
@login_required
def api_vc_draft(year):
    from .services import vc_generate as g
    return jsonify({**g.get_draft(year), "job": g.get_status()})


@prionvault_bp.route("/api/vc/draft/<int:year>/run", methods=["POST"])
@vc_editor_required
def api_vc_draft_run(year):
    """Start a step: {"step": "select"|"themes"|"write", "n": 38, "instructions": "..."}."""
    from .services import vc_generate as g
    body = request.get_json(silent=True) or {}
    step = body.get("step")
    kwargs = {}
    if step == "select":
        kwargs["viewer_id"] = _viewer_id()   # their notes/marks feed the evidence
        try:
            kwargs["n_final"] = max(5, min(80, int(body.get("n") or g.N_FINAL)))
        except (TypeError, ValueError):
            kwargs["n_final"] = g.N_FINAL
    elif step == "write":
        kwargs["instructions"] = str(body.get("instructions") or "")[:2000]
        kwargs["by_user"] = _viewer_id()
    elif step == "revise":
        kwargs["request"] = str(body.get("request") or "")[:4000]
        kwargs["by_user"] = _viewer_id()
        if not kwargs["request"].strip():
            return jsonify({"error": "empty_request", "detail": "Escribe qué cambios quieres."}), 400
    elif step != "themes":
        return jsonify({"error": "bad_step"}), 400
    snap = g.start(step, year, **kwargs)
    if snap is None:
        return jsonify({"error": "already_running", "status": g.get_status()}), 409
    return jsonify({"ok": True, "status": snap})


@prionvault_bp.route("/api/vc/draft/status", methods=["GET"])
@login_required
def api_vc_draft_status():
    from .services import vc_generate as g
    return jsonify(g.get_status())


@prionvault_bp.route("/api/vc/draft/stop", methods=["POST"])
@vc_editor_required
def api_vc_draft_stop():
    from .services import vc_generate as g
    return jsonify(g.stop())


@prionvault_bp.route("/api/vc/items/<int:item_id>", methods=["POST"])
@vc_editor_required
def api_vc_item_toggle(item_id):
    from .services import vc_generate as g
    g.set_selected(item_id, bool((request.get_json(silent=True) or {}).get("selected")))
    return jsonify({"ok": True})


@prionvault_bp.route("/api/vc/draft/<int:year>/add", methods=["POST"])
@vc_editor_required
def api_vc_draft_add(year):
    from .services import vc_generate as g
    pmid = str((request.get_json(silent=True) or {}).get("pmid") or "").strip()
    if not pmid.isdigit():
        return jsonify({"error": "bad_pmid", "detail": "Indica un PMID numérico."}), 400
    try:
        g.add_pmid(year, pmid)
    except LookupError as exc:
        return jsonify({"error": "not_found", "detail": str(exc)}), 404
    return jsonify({"ok": True})


@prionvault_bp.route("/api/vc/draft/<int:year>/text", methods=["PUT"])
@vc_editor_required
def api_vc_draft_text(year):
    from .services import vc_generate as g
    body = request.get_json(silent=True) or {}
    paras = body.get("paragraphs")
    if not isinstance(paras, list) or not all(isinstance(p, str) for p in paras):
        return jsonify({"error": "bad_paragraphs"}), 400
    g.save_text(year, str(body.get("title") or ""), str(body.get("authors") or ""), paras,
                by_user=_viewer_id())
    return jsonify({"ok": True})


@prionvault_bp.route("/api/vc/reports/<int:year>/docx", methods=["GET"])
@login_required
def api_vc_docx(year):
    from flask import Response
    from .services import vc_generate as g
    try:
        data = g.export_docx(year)
    except LookupError:
        return jsonify({"error": "not_found"}), 404
    return Response(data, mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    headers={"Content-Disposition":
                             f'attachment; filename="Competitive_Surveillance_{year}.docx"'})


@prionvault_bp.route("/api/vc/draft/<int:year>/versions/<int:vid>/restore", methods=["POST"])
@vc_editor_required
def api_vc_restore(year, vid):
    from .services import vc_generate as g
    try:
        g.restore_version(year, vid, by_user=_viewer_id())
    except LookupError:
        return jsonify({"error": "not_found"}), 404
    return jsonify({"ok": True})


@prionvault_bp.route("/api/vc/draft/<int:year>/cite-style", methods=["POST"])
@vc_editor_required
def api_vc_cite_style(year):
    from .services import vc_generate as g
    try:
        g.set_cite_style(year, str((request.get_json(silent=True) or {}).get("style") or ""))
    except ValueError:
        return jsonify({"error": "bad_style"}), 400
    return jsonify({"ok": True})


@prionvault_bp.route("/api/vc/draft/<int:year>/accept", methods=["POST"])
@vc_editor_required
def api_vc_accept(year):
    """Accept the current draft as the year's final report (links its cited
    papers and fills the 'VC <year>' collection)."""
    from .services import vc_generate as g
    try:
        return jsonify({"ok": True, **g.accept_final(year, by_user=_viewer_id())})
    except ValueError as exc:
        return jsonify({"error": "nothing_to_accept", "detail": str(exc)}), 400


@prionvault_bp.route("/api/vc/draft/<int:year>/reopen", methods=["POST"])
@vc_editor_required
def api_vc_reopen(year):
    from .services import vc_generate as g
    g.reopen(year)
    return jsonify({"ok": True})
