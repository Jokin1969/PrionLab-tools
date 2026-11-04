"""Reference-suggestion routes — "Sugerir referencias" modal in PrionVault.

Imported at the bottom of routes.py so these routes register on
prionvault_bp as a side effect. See services/ref_suggest.py for the
actual pipeline.
"""
import logging

from flask import jsonify, request

from core.decorators import login_required
from . import prionvault_bp
from ._helpers import _viewer_id

logger = logging.getLogger(__name__)


@prionvault_bp.route("/api/ref-suggest", methods=["POST"])
@login_required
def api_ref_suggest():
    body = request.get_json(silent=True) or {}
    text = body.get("text") or ""
    mode = (body.get("mode") or "marked").strip().lower()
    provider = body.get("provider")

    from .services.ref_suggest import RefSuggestError, suggest_references
    try:
        result = suggest_references(text, mode, provider=provider, viewer_id=_viewer_id())
    except RefSuggestError as exc:
        return jsonify({"error": "bad_request", "detail": str(exc)}), 400
    except Exception as exc:
        logger.exception("ref_suggest failed")
        return jsonify({"error": "internal", "detail": str(exc)[:300]}), 500
    return jsonify(result)
