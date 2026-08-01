"""Library chat routes — the persistent, whole-library AI chat that
replaced the old strict-grounding "AI search". See services/library_chat.py
for the retrieval + mixed-knowledge prompt + provider fallback.

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


@prionvault_bp.route("/api/library-chats", methods=["GET"])
@login_required
def api_library_chats_list():
    uid, err = _require_user()
    if err:
        return err
    from .services import library_chat
    try:
        chats = library_chat.list_chats(uid)
    except Exception as exc:
        logger.exception("library_chat list failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500
    return jsonify({"chats": chats})


@prionvault_bp.route("/api/library-chats", methods=["POST"])
@login_required
def api_library_chat_create():
    uid, err = _require_user()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    provider = (body.get("provider") or "anthropic").strip().lower()
    from .services import library_chat
    try:
        cid = library_chat.create_chat(uid, provider)
    except Exception as exc:
        logger.exception("library_chat create failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500
    return jsonify({"ok": True, "chat_id": cid})


@prionvault_bp.route("/api/library-chats/search", methods=["GET"])
@login_required
def api_library_chats_search():
    """Search this user's past conversations — the modal's chat-history
    search box. Hybrid vector+BM25 over message content."""
    uid, err = _require_user()
    if err:
        return err
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"results": []})
    from .services import library_chat
    try:
        results = library_chat.search_chats(uid, q)
    except Exception as exc:
        logger.exception("library_chat search failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500
    return jsonify({"results": results})


@prionvault_bp.route("/api/library-chats/<uuid:chat_id>", methods=["GET"])
@login_required
def api_library_chat_get(chat_id):
    uid, err = _require_user()
    if err:
        return err
    from .services import library_chat
    chat = library_chat.get_chat(str(chat_id), uid)
    if not chat:
        return jsonify({"error": "not_found"}), 404
    return jsonify(chat)


@prionvault_bp.route("/api/library-chats/<uuid:chat_id>", methods=["DELETE"])
@login_required
def api_library_chat_delete(chat_id):
    uid, err = _require_user()
    if err:
        return err
    from .services import library_chat
    ok = library_chat.delete_chat(str(chat_id), uid)
    if not ok:
        return jsonify({"error": "not_found"}), 404
    return jsonify({"ok": True})


@prionvault_bp.route("/api/library-chats/<uuid:chat_id>/ask", methods=["POST"])
@login_required
def api_library_chat_ask(chat_id):
    uid, err = _require_user()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    question = (body.get("question") or "").strip()
    provider = (body.get("provider") or "").strip().lower() or None
    if not question:
        return jsonify({"error": "empty_question"}), 400

    from .services import library_chat
    try:
        result = library_chat.ask(str(chat_id), uid, question, provider)
    except ValueError as exc:
        return jsonify({"error": "bad_request", "detail": str(exc)}), 400
    except LookupError:
        return jsonify({"error": "not_found"}), 404
    except library_chat.ChatError as exc:
        return jsonify({
            "error":    "all_providers_failed",
            "detail":   str(exc)[:300],
            "attempts": getattr(exc, "attempts", []),
        }), 502
    except Exception as exc:
        logger.exception("library_chat ask failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500

    return jsonify({"ok": True, **result})
