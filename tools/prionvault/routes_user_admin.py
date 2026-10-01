"""PrionVault's own, independent user-management mini-panel.

Lets someone manage user accounts (list, create, edit profile fields,
activate/deactivate, reset password) from inside PrionVault — "Miscelánea
→ Administración" — without needing the broader PrionLab admin panel
(backups, database, other tools). Reachable by a real global admin OR any
user carrying the is_prionvault_admin flag (see core/decorators.py and
core/users.py's _ROLE_FLAG_COLS) — a permission deliberately independent
of the global admin/editor/reader role, so someone can be given control
over PrionVault's users without that leaking into the rest of the app.

Guardrails baked into every route below, not just the decorator:
  - A non-global-admin (flag-only) can never touch a user whose global
    role is "admin" — editing, (de)activating or resetting their
    password all 403. Only a real global admin can act on another admin.
  - A non-global-admin can never set or change someone's global `role`
    (admin/editor/reader) — new users created here are always "reader".
    Only is_prionvault_admin itself (the delegated flag) and the
    operational profile fields are editable by a flag-only user.
  - Nobody can deactivate their own account through this panel (avoids
    an accidental lockout with no one left to undo it).
  - No delete here — that stays admin-panel-only, a deliberately smaller
    surface than the full user CRUD.

Imported at the bottom of routes.py so these routes register on
prionvault_bp as a side effect.
"""
import logging

from flask import jsonify, request, session

from core.auth import hash_password
from core.decorators import prionvault_user_admin_required
from core.users import create_user, get_user, load_users, update_user, user_exists
from . import prionvault_bp

logger = logging.getLogger(__name__)

_EDITABLE_FIELDS = ("full_name", "email", "language")


def _gen_password(length: int = 12) -> str:
    import secrets
    import string
    alphabet = string.ascii_letters + string.digits + "!@#$%"
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _is_global_admin() -> bool:
    return session.get("role") == "admin"


def _public_user(u: dict) -> dict:
    return {
        "username":            u.get("username"),
        "full_name":           u.get("full_name"),
        "email":               u.get("email"),
        "role":                u.get("role"),
        "language":            u.get("language"),
        "active":              u.get("active") == "true",
        "is_prionvault_admin": u.get("is_prionvault_admin") == "true",
    }


@prionvault_bp.route("/api/admin/pv-users", methods=["GET"])
@prionvault_user_admin_required
def api_pv_users_list():
    return jsonify({"users": [_public_user(u) for u in load_users()]})


@prionvault_bp.route("/api/admin/pv-users", methods=["POST"])
@prionvault_user_admin_required
def api_pv_users_create():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip().lower()
    password = data.get("password") or ""
    full_name = (data.get("full_name") or "").strip()
    email = (data.get("email") or "").strip()
    language = (data.get("language") or "es").strip()
    is_pv_admin = bool(data.get("is_prionvault_admin"))

    if not username or not password:
        return jsonify({"error": "username_and_password_required"}), 400
    if user_exists(username):
        return jsonify({"error": "username_exists"}), 409

    # A flag-only (non-global-admin) user-admin can never grant a global
    # role above "reader" — that's the whole point of this being a
    # separate, narrower permission.
    role = "reader"
    if _is_global_admin():
        requested_role = (data.get("role") or "reader").strip()
        if requested_role in ("admin", "editor", "reader"):
            role = requested_role

    from datetime import date
    create_user({
        "username":            username,
        "password_hash":       hash_password(password),
        "full_name":           full_name,
        "email":               email,
        "role":                role,
        "language":            language,
        "active":              "true",
        "is_prionvault_admin": "true" if is_pv_admin else "false",
        "created_at":          date.today().isoformat(),
        "last_login":          "",
    })
    return jsonify({"ok": True, "user": _public_user(get_user(username))})


@prionvault_bp.route("/api/admin/pv-users/<username>", methods=["PATCH"])
@prionvault_user_admin_required
def api_pv_users_update(username):
    target = get_user(username)
    if not target:
        return jsonify({"error": "not_found"}), 404
    if target.get("role") == "admin" and not _is_global_admin():
        return jsonify({"error": "forbidden",
                        "detail": "Solo un administrador global puede editar a otro administrador."}), 403

    data = request.get_json(silent=True) or {}
    updates = {k: (data[k] or "").strip() for k in _EDITABLE_FIELDS if k in data}

    if "is_prionvault_admin" in data:
        updates["is_prionvault_admin"] = "true" if data["is_prionvault_admin"] else "false"

    if "role" in data:
        if not _is_global_admin():
            return jsonify({"error": "forbidden",
                            "detail": "Solo un administrador global puede cambiar el rol general."}), 403
        role = (data.get("role") or "").strip()
        if role in ("admin", "editor", "reader"):
            updates["role"] = role

    if "active" in data:
        if not data["active"] and username == session.get("username"):
            return jsonify({"error": "cannot_deactivate_self"}), 400
        updates["active"] = "true" if data["active"] else "false"

    if not updates:
        return jsonify({"error": "no_fields"}), 400

    update_user(username, updates)
    return jsonify({"ok": True, "user": _public_user(get_user(username))})


@prionvault_bp.route("/api/admin/pv-users/<username>/toggle", methods=["POST"])
@prionvault_user_admin_required
def api_pv_users_toggle(username):
    target = get_user(username)
    if not target:
        return jsonify({"error": "not_found"}), 404
    if target.get("role") == "admin" and not _is_global_admin():
        return jsonify({"error": "forbidden",
                        "detail": "Solo un administrador global puede (des)activar a otro administrador."}), 403
    if username == session.get("username"):
        return jsonify({"error": "cannot_deactivate_self"}), 400

    new_state = "false" if target.get("active", "true") == "true" else "true"
    update_user(username, {"active": new_state})
    return jsonify({"ok": True, "active": new_state == "true"})


@prionvault_bp.route("/api/admin/pv-users/<username>/reset-password", methods=["POST"])
@prionvault_user_admin_required
def api_pv_users_reset_password(username):
    target = get_user(username)
    if not target:
        return jsonify({"error": "not_found"}), 404
    if target.get("role") == "admin" and not _is_global_admin():
        return jsonify({"error": "forbidden",
                        "detail": "Solo un administrador global puede resetear la contraseña de otro administrador."}), 403

    new_pwd = _gen_password()
    update_user(username, {"password_hash": hash_password(new_pwd)})
    return jsonify({"ok": True, "password": new_pwd})
