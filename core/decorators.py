from functools import wraps
from flask import flash, redirect, request, session, url_for


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("auth.login", next=request.path))
        return f(*args, **kwargs)
    return decorated


def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("auth.login", next=request.path))
        if session.get("role") != "admin":
            flash("Unauthorized. Admin access required.", "error")
            return redirect(url_for("home"))
        return f(*args, **kwargs)
    return decorated


def editor_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("auth.login", next=request.path))
        if session.get("role") not in ("admin", "editor"):
            flash("Unauthorized. Editor access required.", "error")
            return redirect(url_for("home"))
        return f(*args, **kwargs)
    return decorated


def reader_required(f):
    """Any authenticated user (admin / editor / reader)."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("auth.login", next=request.path))
        return f(*args, **kwargs)
    return decorated
