from functools import wraps
from flask import flash, g, redirect, request, session, url_for


def _ext_authed() -> bool:
    """True when the request carries a valid extension API key."""
    return bool(getattr(g, "_ext_authed", False))


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
            return f(*args, **kwargs)
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
