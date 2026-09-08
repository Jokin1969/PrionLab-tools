"""Per-user article notes routes for PrionVault.

Up to 5 sticky notes per article per user; the colour is assigned
automatically (see services/article_notes.py). Imported at the bottom
of routes.py so these routes register on prionvault_bp as a side effect.
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


@prionvault_bp.route("/api/articles/<uuid:aid>/notes", methods=["GET"])
@login_required
def api_article_notes_list(aid):
    uid, err = _require_user()
    if err:
        return err
    from .services import article_notes
    try:
        notes = article_notes.list_notes(str(aid), uid)
    except Exception as exc:
        logger.exception("notes list failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500
    return jsonify({"notes": notes, "max": article_notes.MAX_NOTES})


@prionvault_bp.route("/api/articles/<uuid:aid>/notes", methods=["POST"])
@login_required
def api_article_note_create(aid):
    uid, err = _require_user()
    if err:
        return err
    body = (request.get_json(silent=True) or {}).get("body", "")
    from .services import article_notes
    try:
        note = article_notes.create_note(str(aid), uid, body)
    except article_notes.NoteLimitReached as exc:
        return jsonify({"error": "limit_reached", "detail": str(exc)}), 409
    except Exception as exc:
        logger.exception("notes create failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500
    return jsonify({"ok": True, "note": note})


@prionvault_bp.route("/api/articles/<uuid:aid>/notes/ai-generate", methods=["POST"])
@login_required
def api_article_note_ai_generate(aid):
    """Generate a new sticky note from free text the user types in — the
    "🤖 IA" button in the notes modal. The AI is given the user's text as
    the main subject and the article's indexed content only as
    supporting context (see services/article_chat.generate_freetext_note),
    same Claude → GPT → Gemini fallback chain as everywhere else."""
    uid, err = _require_user()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        return jsonify({"error": "empty_text", "detail": "Escribe el texto para la nota."}), 400

    from .services import article_chat, article_notes
    try:
        result = article_chat.generate_freetext_note(str(aid), uid, text)
    except ValueError as exc:
        return jsonify({"error": "bad_request", "detail": str(exc)}), 400
    except LookupError:
        return jsonify({"error": "not_found"}), 404
    except article_chat.ChatError as exc:
        return jsonify({
            "error":    "all_providers_failed",
            "detail":   str(exc)[:300],
            "attempts": getattr(exc, "attempts", []),
        }), 502
    except Exception as exc:
        logger.exception("freetext note generation failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500

    try:
        note = article_notes.create_note(str(aid), uid, result["note_text"])
    except article_notes.NoteLimitReached as exc:
        # The generated text is still useful even without a free slot —
        # hand it back so the UI can offer "copiar" instead of failing.
        return jsonify({
            "error": "limit_reached", "detail": str(exc),
            "note_text": result["note_text"],
        }), 409
    except Exception as exc:
        logger.exception("freetext note save failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500

    return jsonify({
        "ok": True, "note": note, "provider": result["provider"],
        "requested_provider": result["requested_provider"], "switched": result["switched"],
    })


@prionvault_bp.route("/api/notes/<uuid:note_id>", methods=["PATCH"])
@login_required
def api_note_update(note_id):
    uid, err = _require_user()
    if err:
        return err
    body = (request.get_json(silent=True) or {}).get("body", "")
    from .services import article_notes
    note = article_notes.update_note(str(note_id), uid, body)
    if not note:
        return jsonify({"error": "not_found"}), 404
    return jsonify({"ok": True, "note": note})


@prionvault_bp.route("/api/notes/<uuid:note_id>", methods=["DELETE"])
@login_required
def api_note_delete(note_id):
    uid, err = _require_user()
    if err:
        return err
    from .services import article_notes
    ok = article_notes.delete_note(str(note_id), uid)
    if not ok:
        return jsonify({"error": "not_found"}), 404
    return jsonify({"ok": True})
