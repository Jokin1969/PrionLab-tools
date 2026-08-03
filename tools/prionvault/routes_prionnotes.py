"""PrionNotes routes for PrionVault — generic floating post-it board.

Generic (entity_type, entity_id) board, private per user, NOT capped at 5
notes (unlike the existing per-article sticky notes in routes_notes.py,
which this module does not touch). Available to both admin and reader
roles — any logged-in user manages only their own notes, same permission
model as the per-article notes / `_viewer_id()` helper.

Imported at the bottom of routes.py so these routes register on
prionvault_bp as a side effect.
"""
import logging

from flask import jsonify, request

from core.decorators import login_required
from . import prionvault_bp
from ._helpers import _viewer_id

logger = logging.getLogger(__name__)


def _require_user():
    uid = _viewer_id()
    if not uid:
        return None, (jsonify({"error": "not_authenticated"}), 401)
    return uid, None


@prionvault_bp.route("/api/prionnotes/<entity_type>/<entity_id>", methods=["GET"])
@login_required
def api_prionnotes_list(entity_type, entity_id):
    uid, err = _require_user()
    if err:
        return err
    from .services import prionnotes
    try:
        notes = prionnotes.list_notes(uid, entity_type, entity_id)
    except ValueError:
        return jsonify({"error": "invalid_entity_type"}), 400
    except Exception as exc:
        logger.exception("prionnotes list failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500
    return jsonify(notes)


@prionvault_bp.route("/api/prionnotes/<entity_type>/<entity_id>", methods=["POST"])
@login_required
def api_prionnotes_create(entity_type, entity_id):
    uid, err = _require_user()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    text = data.get("text", "")
    color = data.get("color")
    from .services import prionnotes
    try:
        note = prionnotes.create_note(uid, entity_type, entity_id, text, color)
    except ValueError as exc:
        code = str(exc)
        if code == "invalid_entity_type":
            return jsonify({"error": "invalid_entity_type"}), 400
        if code == "text_too_long":
            return jsonify({"error": "text_too_long", "detail": "Texto demasiado largo (máx 500 KB)"}), 400
        if code == "empty_note":
            return jsonify({"error": "empty_note", "detail": "La nota no puede estar vacía"}), 400
        return jsonify({"error": "invalid_request"}), 400
    except Exception as exc:
        logger.exception("prionnotes create failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500
    return jsonify(note), 201


@prionvault_bp.route("/api/prionnotes/<entity_type>/<entity_id>/<note_id>", methods=["PUT"])
@login_required
def api_prionnotes_update(entity_type, entity_id, note_id):
    uid, err = _require_user()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    text = data.get("text")
    color = data.get("color")
    from .services import prionnotes
    try:
        note = prionnotes.update_note(uid, entity_type, entity_id, note_id, text, color)
    except ValueError as exc:
        code = str(exc)
        if code == "invalid_entity_type":
            return jsonify({"error": "invalid_entity_type"}), 400
        if code == "text_too_long":
            return jsonify({"error": "text_too_long", "detail": "Texto demasiado largo (máx 500 KB)"}), 400
        if code == "empty_note":
            return jsonify({"error": "empty_note", "detail": "La nota no puede estar vacía"}), 400
        return jsonify({"error": "invalid_request"}), 400
    except Exception as exc:
        logger.exception("prionnotes update failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500
    if note is None:
        return jsonify({"error": "not_found"}), 404
    return jsonify(note)


@prionvault_bp.route("/api/prionnotes/<entity_type>/<entity_id>/<note_id>", methods=["DELETE"])
@login_required
def api_prionnotes_delete(entity_type, entity_id, note_id):
    uid, err = _require_user()
    if err:
        return err
    from .services import prionnotes
    try:
        ok = prionnotes.delete_note(uid, entity_type, entity_id, note_id)
    except ValueError:
        return jsonify({"error": "invalid_entity_type"}), 400
    except Exception as exc:
        logger.exception("prionnotes delete failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500
    if not ok:
        return jsonify({"error": "not_found"}), 404
    return jsonify({"ok": True})


@prionvault_bp.route("/api/prionnotes/counts", methods=["GET"])
@login_required
def api_prionnotes_counts():
    uid, err = _require_user()
    if err:
        return err
    entity_type = request.args.get("entity_type", "")
    raw_ids = request.args.get("ids", "")
    ids = [i.strip() for i in raw_ids.split(",") if i.strip()]
    from .services import prionnotes
    try:
        counts = prionnotes.get_counts(uid, entity_type, ids)
    except ValueError:
        return jsonify({"error": "invalid_entity_type"}), 400
    except Exception as exc:
        logger.exception("prionnotes counts failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500
    return jsonify(counts)
