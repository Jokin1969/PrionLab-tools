from functools import wraps
from flask import flash, g, jsonify, redirect, request, session, url_for


def _ext_authed() -> bool:
    """True when the request carries a valid extension API key."""
    return bool(getattr(g, "_ext_authed", False))


def _ext_role() -> str:
    """Role associated with the extension key that authenticated this
    request. Defaults to 'admin' for backward compatibility with the
    original single shared PRIONVAULT_EXTENSION_API_KEY, which never
    set this attribute explicitly — only the newer reader key does."""
    return getattr(g, "_ext_authed_role", "admin")


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if _ext_authed():
            return f(*args, **kwargs)
        if not session.get("logged_in"):
            return redirect(url_for("auth.login", next=request.full_path))
        return f(*args, **kwargs)
    return decorated


def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if _ext_authed():
            if _ext_role() == "admin":
                return f(*args, **kwargs)
            # A reader-level extension key hitting an admin-only endpoint —
            # this is an API consumed by the Chrome extension's fetch()
            # calls, not a browser page load, so a JSON 403 is the right
            # response (a redirect would just come back as an opaque
            # failure to the extension's error handling).
            return jsonify({"error": "forbidden",
                            "detail": "admin access required"}), 403
        if not session.get("logged_in"):
            return redirect(url_for("auth.login", next=request.full_path))
        if session.get("role") != "admin":
            flash("Unauthorized. Admin access required.", "error")
            return redirect(url_for("home"))
        return f(*args, **kwargs)
    return decorated


def admin_or_extension_required(f):
    """Admin browser sessions, OR any authenticated extension key
    (admin- or reader-role). Used by the extension's article-create
    endpoints: readers are allowed to call them directly (unlike a
    plain admin_required route), while a non-admin BROWSER session
    still can't — this only relaxes the check for the extension's own
    shared-key auth, not for regular logged-in readers using the app."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if _ext_authed():
            return f(*args, **kwargs)
        if not session.get("logged_in"):
            return redirect(url_for("auth.login", next=request.full_path))
        if session.get("role") != "admin":
            flash("Unauthorized. Admin access required.", "error")
            return redirect(url_for("home"))
        return f(*args, **kwargs)
    return decorated


def editor_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if _ext_authed():
            if _ext_role() in ("admin", "editor"):
                return f(*args, **kwargs)
            return jsonify({"error": "forbidden",
                            "detail": "editor access required"}), 403
        if not session.get("logged_in"):
            return redirect(url_for("auth.login", next=request.full_path))
        if session.get("role") not in ("admin", "editor"):
            flash("Unauthorized. Editor access required.", "error")
            return redirect(url_for("home"))
        return f(*args, **kwargs)
    return decorated


def reader_required(f):
    """Any authenticated user (admin / editor / reader)."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if _ext_authed():
            return f(*args, **kwargs)
        if not session.get("logged_in"):
            return redirect(url_for("auth.login", next=request.full_path))
        return f(*args, **kwargs)
    return decorated
