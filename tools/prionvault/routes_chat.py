"""Per-article AI chat routes for PrionVault.

Lets a logged-in user hold (and later revisit) conversations with an AI
about a single article. The prompt behind each question bundles the
article metadata, its AI summary, its indexed full text, and the prior
turns of the conversation. Provider fallback (Claude → GPT → Gemini) is
handled in services/article_chat.py.

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
    """Return (user_id, None) or (None, (response, status)) when the
    request has no resolvable user."""
    uid = _viewer_id()
    if not uid:
        return None, (jsonify({"error": "not_authenticated"}), 401)
    return uid, None


# ── Provider catalogue (available to any logged-in user) ─────────────────────

@prionvault_bp.route("/api/chat-providers", methods=["GET"])
@login_required
def api_chat_providers():
    """List AI providers with availability, so the chat picker can render
    for readers as well as admins (the /admin/ai-providers route is
    admin-only)."""
    from .services.ai_summary import provider_status
    return jsonify({"providers": provider_status()})


# ── Conversations for one article ─────────────────────────────────────────────

@prionvault_bp.route("/api/articles/<uuid:aid>/chats", methods=["GET"])
@login_required
def api_article_chats_list(aid):
    uid, err = _require_user()
    if err:
        return err
    from .services import article_chat
    try:
        chats = article_chat.list_chats(str(aid), uid)
    except Exception as exc:
        logger.exception("article_chat list failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500
    return jsonify({"chats": chats})


@prionvault_bp.route("/api/articles/<uuid:aid>/chats", methods=["POST"])
@login_required
def api_article_chat_create(aid):
    uid, err = _require_user()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    provider = (body.get("provider") or "anthropic").strip().lower()
    from .services import article_chat
    try:
        cid = article_chat.create_chat(str(aid), uid, provider)
    except Exception as exc:
        logger.exception("article_chat create failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500
    return jsonify({"ok": True, "chat_id": cid})


# ── A single conversation ─────────────────────────────────────────────────────

@prionvault_bp.route("/api/chats/<uuid:chat_id>", methods=["GET"])
@login_required
def api_chat_get(chat_id):
    uid, err = _require_user()
    if err:
        return err
    from .services import article_chat
    chat = article_chat.get_chat(str(chat_id), uid)
    if not chat:
        return jsonify({"error": "not_found"}), 404
    return jsonify(chat)


@prionvault_bp.route("/api/chats/<uuid:chat_id>", methods=["DELETE"])
@login_required
def api_chat_delete(chat_id):
    uid, err = _require_user()
    if err:
        return err
    from .services import article_chat
    ok = article_chat.delete_chat(str(chat_id), uid)
    if not ok:
        return jsonify({"error": "not_found"}), 404
    return jsonify({"ok": True})


@prionvault_bp.route("/api/chats/<uuid:chat_id>/ask", methods=["POST"])
@login_required
def api_chat_ask(chat_id):
    uid, err = _require_user()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    question = (body.get("question") or "").strip()
    provider = (body.get("provider") or "").strip().lower() or None
    if not question:
        return jsonify({"error": "empty_question"}), 400

    from .services import article_chat
    try:
        result = article_chat.ask(str(chat_id), uid, question, provider)
    except ValueError as exc:
        return jsonify({"error": "bad_request", "detail": str(exc)}), 400
    except LookupError:
        return jsonify({"error": "not_found"}), 404
    except article_chat.ChatError as exc:
        # Every provider in the chain failed — surface the attempt list
        # so the UI can explain which providers were tried and why.
        return jsonify({
            "error":    "all_providers_failed",
            "detail":   str(exc)[:300],
            "attempts": getattr(exc, "attempts", []),
        }), 502
    except Exception as exc:
        logger.exception("article_chat ask failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500

    return jsonify({"ok": True, **result})
