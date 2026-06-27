"""Tests for tag-related route permission decorators.

Standalone mini Flask apps — no DB, no heavy deps.
"""
import sys
import os
import uuid
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

pytest.importorskip("flask")


def _make_app(name):
    """Return a minimal Flask app with auth.login and home stubs registered."""
    from flask import Flask

    mini = Flask(name)
    mini.secret_key = "x"
    mini.config["TESTING"] = True

    def _login_view():
        return "login", 200

    def _home_view():
        return "home", 200

    mini.add_url_rule("/login", endpoint="auth.login", view_func=_login_view)
    mini.add_url_rule("/", endpoint="home", view_func=_home_view)
    return mini


# ── DELETE /api/tags/<id>  →  @admin_required ────────────────────────────────

def _make_delete_tag_app(name):
    from flask import jsonify
    from core.decorators import admin_required

    mini = _make_app(name)

    @mini.route("/api/tags/<int:tag_id>", methods=["DELETE"])
    @admin_required
    def _delete_tag(tag_id):
        return jsonify({"ok": True}), 200

    return mini


def test_delete_tag_anonymous_redirects():
    mini = _make_delete_tag_app(__name__ + ".dt1")
    with mini.test_client() as c:
        r = c.delete("/api/tags/1", follow_redirects=False)
        assert r.status_code == 302


def test_delete_tag_reader_redirects():
    mini = _make_delete_tag_app(__name__ + ".dt2")
    with mini.test_client() as c:
        with c.session_transaction() as sess:
            sess["logged_in"] = True
            sess["role"] = "reader"
        r = c.delete("/api/tags/1", follow_redirects=False)
        assert r.status_code == 302


def test_delete_tag_admin_allowed():
    mini = _make_delete_tag_app(__name__ + ".dt3")
    with mini.test_client() as c:
        with c.session_transaction() as sess:
            sess["logged_in"] = True
            sess["role"] = "admin"
        r = c.delete("/api/tags/1", follow_redirects=False)
        assert r.status_code == 200


# ── POST /api/tags  →  @login_required ──────────────────────────────────────

def _make_create_tag_app(name):
    from flask import jsonify
    from core.decorators import login_required

    mini = _make_app(name)

    @mini.route("/api/tags", methods=["POST"])
    @login_required
    def _create_tag():
        return jsonify({"ok": True}), 201

    return mini


def test_create_tag_anonymous_redirects():
    mini = _make_create_tag_app(__name__ + ".ct1")
    with mini.test_client() as c:
        r = c.post("/api/tags", follow_redirects=False)
        assert r.status_code == 302


def test_create_tag_reader_allowed():
    mini = _make_create_tag_app(__name__ + ".ct2")
    with mini.test_client() as c:
        with c.session_transaction() as sess:
            sess["logged_in"] = True
            sess["role"] = "reader"
        r = c.post("/api/tags", follow_redirects=False)
        assert r.status_code != 302


def test_create_tag_admin_allowed():
    mini = _make_create_tag_app(__name__ + ".ct3")
    with mini.test_client() as c:
        with c.session_transaction() as sess:
            sess["logged_in"] = True
            sess["role"] = "admin"
        r = c.post("/api/tags", follow_redirects=False)
        assert r.status_code != 302


# ── PUT /api/articles/<uuid>/tags/<int>  →  @login_required ─────────────────

def _make_put_article_tag_app(name):
    from flask import jsonify
    from core.decorators import login_required

    mini = _make_app(name)

    @mini.route("/api/articles/<article_id>/tags/<int:tag_id>", methods=["PUT"])
    @login_required
    def _put_article_tag(article_id, tag_id):
        return jsonify({"ok": True}), 200

    return mini


def test_put_article_tag_anonymous_redirects():
    mini = _make_put_article_tag_app(__name__ + ".pat1")
    article_id = str(uuid.uuid4())
    with mini.test_client() as c:
        r = c.put(f"/api/articles/{article_id}/tags/1", follow_redirects=False)
        assert r.status_code == 302


def test_put_article_tag_reader_allowed():
    mini = _make_put_article_tag_app(__name__ + ".pat2")
    article_id = str(uuid.uuid4())
    with mini.test_client() as c:
        with c.session_transaction() as sess:
            sess["logged_in"] = True
            sess["role"] = "reader"
        r = c.put(f"/api/articles/{article_id}/tags/1", follow_redirects=False)
        assert r.status_code != 302


# ── DELETE /api/articles/<uuid>/tags/<int>  →  @login_required ──────────────

def _make_delete_article_tag_app(name):
    from flask import jsonify
    from core.decorators import login_required

    mini = _make_app(name)

    @mini.route("/api/articles/<article_id>/tags/<int:tag_id>", methods=["DELETE"])
    @login_required
    def _delete_article_tag(article_id, tag_id):
        return jsonify({"ok": True}), 200

    return mini


def test_delete_article_tag_anonymous_redirects():
    mini = _make_delete_article_tag_app(__name__ + ".dat1")
    article_id = str(uuid.uuid4())
    with mini.test_client() as c:
        r = c.delete(f"/api/articles/{article_id}/tags/1", follow_redirects=False)
        assert r.status_code == 302


def test_delete_article_tag_reader_allowed():
    mini = _make_delete_article_tag_app(__name__ + ".dat2")
    article_id = str(uuid.uuid4())
    with mini.test_client() as c:
        with c.session_transaction() as sess:
            sess["logged_in"] = True
            sess["role"] = "reader"
        r = c.delete(f"/api/articles/{article_id}/tags/1", follow_redirects=False)
        assert r.status_code != 302
