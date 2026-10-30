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


@prionvault_bp.route("/api/library-chats/open", methods=["GET"])
@login_required
def api_library_chat_open():
    """One-shot combo for the modal's open() flow: the sidebar chat
    list AND the full detail of the target chat (?chat_id=, default the
    most recently updated one) in a single request/DB connection —
    replaces what used to be two sequential round trips (list, then
    fetch), which were adding real wall-clock time on top of query cost
    on every single open."""
    uid, err = _require_user()
    if err:
        return err
    chat_id = request.args.get("chat_id") or None
    from .services import library_chat
    try:
        view = library_chat.open_view(uid, chat_id)
    except Exception as exc:
        logger.exception("library_chat open failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500
    return jsonify(view)


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
    # ?full=1 bypasses the default recent-only slice (see get_chat) — the
    # chat UI's "Cargar conversación completa" link when it's truncated.
    limit_pairs = None if request.args.get("full") == "1" else library_chat._DEFAULT_MESSAGE_PAIRS
    chat = library_chat.get_chat(str(chat_id), uid, limit_pairs=limit_pairs)
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
    cited_context = body.get("cited_context") or None
    if not question:
        return jsonify({"error": "empty_question"}), 400

    from .services import library_chat
    try:
        result = library_chat.ask(str(chat_id), uid, question, provider, cited_context)
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


@prionvault_bp.route("/api/library-chats/<uuid:chat_id>/messages/<int:message_id>", methods=["DELETE"])
@login_required
def api_library_chat_delete_message(chat_id, message_id):
    """Delete one question + its answer — the trash icon on a user bubble."""
    uid, err = _require_user()
    if err:
        return err
    from .services import library_chat
    try:
        ok = library_chat.delete_message_pair(str(chat_id), uid, message_id)
    except Exception as exc:
        logger.exception("library_chat delete message failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500
    if not ok:
        return jsonify({"error": "not_found"}), 404
    return jsonify({"ok": True})


@prionvault_bp.route("/api/library-chats/<uuid:chat_id>/report", methods=["GET"])
@login_required
def api_library_chat_report(chat_id):
    """Download a nicely-formatted report of this conversation, from the
    start up to (and including) one message pair — the 📄 button on a
    pair in the chat UI. ?format=pdf|docx (default pdf), ?up_to=<user
    message id> (default: the whole conversation)."""
    uid, err = _require_user()
    if err:
        return err
    fmt = (request.args.get("format") or "pdf").strip().lower()
    if fmt not in ("pdf", "docx"):
        return jsonify({"error": "bad_format", "detail": "format debe ser pdf o docx"}), 400
    up_to = request.args.get("up_to", type=int)

    from .services import library_chat, chat_report
    # Reports must cover the real conversation, never the recent-only
    # slice the chat UI loads by default for speed — see get_chat().
    chat = library_chat.get_chat(str(chat_id), uid, limit_pairs=None)
    if not chat:
        return jsonify({"error": "not_found"}), 404

    messages = chat["messages"]
    if up_to is not None:
        idx = next((i for i, m in enumerate(messages)
                   if m["role"] == "user" and m["id"] == up_to), None)
        if idx is not None:
            end = idx + 1
            if end < len(messages) and messages[end]["role"] == "assistant":
                end += 1
            messages = messages[:end]

    if not messages:
        return jsonify({"error": "empty", "detail": "Esta conversación no tiene mensajes."}), 400

    try:
        if fmt == "pdf":
            content = chat_report.render_pdf(chat, messages)
            mimetype = "application/pdf"
            ext = "pdf"
        else:
            content = chat_report.render_docx(chat, messages)
            mimetype = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            ext = "docx"
    except Exception as exc:
        logger.exception("chat report generation failed")
        return jsonify({"error": "internal", "detail": str(exc)[:200]}), 500

    from flask import Response
    filename = f"chat-prionvault-{str(chat_id)[:8]}.{ext}"
    return Response(content, mimetype=mimetype, headers={
        "Content-Disposition": f'attachment; filename="{filename}"',
    })
