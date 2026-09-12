"""Tests for collection-related route permission decorators.

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


def _reader_session(c):
    with c.session_transaction() as sess:
        sess["logged_in"] = True
        sess["role"] = "reader"


def _admin_session(c):
    with c.session_transaction() as sess:
        sess["logged_in"] = True
        sess["role"] = "admin"


# ── GET /api/collections  →  @login_required ────────────────────────────────

def _make_list_collections_app(name):
    from flask import jsonify
    from core.decorators import login_required

    mini = _make_app(name)

    @mini.route("/api/collections", methods=["GET"])
    @login_required
    def _list_collections():
        return jsonify([]), 200

    return mini


def test_list_collections_anonymous_redirects():
    mini = _make_list_collections_app(__name__ + ".lc1")
    with mini.test_client() as c:
        r = c.get("/api/collections", follow_redirects=False)
        assert r.status_code == 302


def test_list_collections_reader_allowed():
    mini = _make_list_collections_app(__name__ + ".lc2")
    with mini.test_client() as c:
        _reader_session(c)
        r = c.get("/api/collections", follow_redirects=False)
        assert r.status_code != 302


def test_list_collections_admin_allowed():
    mini = _make_list_collections_app(__name__ + ".lc3")
    with mini.test_client() as c:
        _admin_session(c)
        r = c.get("/api/collections", follow_redirects=False)
        assert r.status_code != 302


# ── POST /api/collections  →  @admin_required ───────────────────────────────

def _make_create_collection_app(name):
    from flask import jsonify
    from core.decorators import admin_required

    mini = _make_app(name)

    @mini.route("/api/collections", methods=["POST"])
    @admin_required
    def _create_collection():
        return jsonify({"ok": True}), 201

    return mini


def test_create_collection_anonymous_redirects():
    mini = _make_create_collection_app(__name__ + ".cc1")
    with mini.test_client() as c:
        r = c.post("/api/collections", follow_redirects=False)
        assert r.status_code == 302


def test_create_collection_reader_redirects():
    mini = _make_create_collection_app(__name__ + ".cc2")
    with mini.test_client() as c:
        _reader_session(c)
        r = c.post("/api/collections", follow_redirects=False)
        assert r.status_code == 302


def test_create_collection_admin_allowed():
    mini = _make_create_collection_app(__name__ + ".cc3")
    with mini.test_client() as c:
        _admin_session(c)
        r = c.post("/api/collections", follow_redirects=False)
        assert r.status_code == 201


# ── PATCH /api/collections/<uuid>  →  @admin_required ───────────────────────

def _make_patch_collection_app(name):
    from flask import jsonify
    from core.decorators import admin_required

    mini = _make_app(name)

    @mini.route("/api/collections/<coll_id>", methods=["PATCH"])
    @admin_required
    def _patch_collection(coll_id):
        return jsonify({"ok": True}), 200

    return mini


def test_patch_collection_anonymous_redirects():
    mini = _make_patch_collection_app(__name__ + ".pc1")
    coll_id = str(uuid.uuid4())
    with mini.test_client() as c:
        r = c.patch(f"/api/collections/{coll_id}", follow_redirects=False)
        assert r.status_code == 302


def test_patch_collection_reader_redirects():
    mini = _make_patch_collection_app(__name__ + ".pc2")
    coll_id = str(uuid.uuid4())
    with mini.test_client() as c:
        _reader_session(c)
        r = c.patch(f"/api/collections/{coll_id}", follow_redirects=False)
        assert r.status_code == 302


def test_patch_collection_admin_allowed():
    mini = _make_patch_collection_app(__name__ + ".pc3")
    coll_id = str(uuid.uuid4())
    with mini.test_client() as c:
        _admin_session(c)
        r = c.patch(f"/api/collections/{coll_id}", follow_redirects=False)
        assert r.status_code == 200


# ── DELETE /api/collections/<uuid>  →  @admin_required ──────────────────────

def _make_delete_collection_app(name):
    from flask import jsonify
    from core.decorators import admin_required

    mini = _make_app(name)

    @mini.route("/api/collections/<coll_id>", methods=["DELETE"])
    @admin_required
    def _delete_collection(coll_id):
        return jsonify({"ok": True}), 200

    return mini


def test_delete_collection_anonymous_redirects():
    mini = _make_delete_collection_app(__name__ + ".dc1")
    coll_id = str(uuid.uuid4())
    with mini.test_client() as c:
        r = c.delete(f"/api/collections/{coll_id}", follow_redirects=False)
        assert r.status_code == 302


def test_delete_collection_reader_redirects():
    mini = _make_delete_collection_app(__name__ + ".dc2")
    coll_id = str(uuid.uuid4())
    with mini.test_client() as c:
        _reader_session(c)
        r = c.delete(f"/api/collections/{coll_id}", follow_redirects=False)
        assert r.status_code == 302


def test_delete_collection_admin_allowed():
    mini = _make_delete_collection_app(__name__ + ".dc3")
    coll_id = str(uuid.uuid4())
    with mini.test_client() as c:
        _admin_session(c)
        r = c.delete(f"/api/collections/{coll_id}", follow_redirects=False)
        assert r.status_code == 200


# ── POST /api/collections/<uuid>/articles  →  @admin_required ───────────────

def _make_add_articles_app(name):
    from flask import jsonify
    from core.decorators import admin_required

    mini = _make_app(name)

    @mini.route("/api/collections/<coll_id>/articles", methods=["POST"])
    @admin_required
    def _add_articles(coll_id):
        return jsonify({"ok": True}), 200

    return mini


def test_add_articles_reader_redirects():
    mini = _make_add_articles_app(__name__ + ".aa1")
    coll_id = str(uuid.uuid4())
    with mini.test_client() as c:
        _reader_session(c)
        r = c.post(f"/api/collections/{coll_id}/articles", follow_redirects=False)
        assert r.status_code == 302


def test_add_articles_admin_allowed():
    mini = _make_add_articles_app(__name__ + ".aa2")
    coll_id = str(uuid.uuid4())
    with mini.test_client() as c:
        _admin_session(c)
        r = c.post(f"/api/collections/{coll_id}/articles", follow_redirects=False)
        assert r.status_code == 200


# ── DELETE /api/collections/<uuid>/articles  →  @admin_required ─────────────

def _make_remove_articles_app(name):
    from flask import jsonify
    from core.decorators import admin_required

    mini = _make_app(name)

    @mini.route("/api/collections/<coll_id>/articles", methods=["DELETE"])
    @admin_required
    def _remove_articles(coll_id):
        return jsonify({"ok": True}), 200

    return mini


def test_remove_articles_reader_redirects():
    mini = _make_remove_articles_app(__name__ + ".ra1")
    coll_id = str(uuid.uuid4())
    with mini.test_client() as c:
        _reader_session(c)
        r = c.delete(f"/api/collections/{coll_id}/articles", follow_redirects=False)
        assert r.status_code == 302


def test_remove_articles_admin_allowed():
    mini = _make_remove_articles_app(__name__ + ".ra2")
    coll_id = str(uuid.uuid4())
    with mini.test_client() as c:
        _admin_session(c)
        r = c.delete(f"/api/collections/{coll_id}/articles", follow_redirects=False)
        assert r.status_code == 200


# ── GET /api/collections/<uuid>  →  @login_required ─────────────────────────

def _make_get_collection_app(name):
    from flask import jsonify
    from core.decorators import login_required

    mini = _make_app(name)

    @mini.route("/api/collections/<coll_id>", methods=["GET"])
    @login_required
    def _get_collection(coll_id):
        return jsonify({"ok": True}), 200

    return mini


def test_get_collection_anonymous_redirects():
    mini = _make_get_collection_app(__name__ + ".gc1")
    coll_id = str(uuid.uuid4())
    with mini.test_client() as c:
        r = c.get(f"/api/collections/{coll_id}", follow_redirects=False)
        assert r.status_code == 302


def test_get_collection_reader_allowed():
    mini = _make_get_collection_app(__name__ + ".gc2")
    coll_id = str(uuid.uuid4())
    with mini.test_client() as c:
        _reader_session(c)
        r = c.get(f"/api/collections/{coll_id}", follow_redirects=False)
        assert r.status_code != 302


# ── GET /api/collections/<uuid>/article-ids  →  @login_required ─────────────

def _make_get_article_ids_app(name):
    from flask import jsonify
    from core.decorators import login_required

    mini = _make_app(name)

    @mini.route("/api/collections/<coll_id>/article-ids", methods=["GET"])
    @login_required
    def _get_article_ids(coll_id):
        return jsonify([]), 200

    return mini


def test_get_article_ids_anonymous_redirects():
    mini = _make_get_article_ids_app(__name__ + ".gai1")
    coll_id = str(uuid.uuid4())
    with mini.test_client() as c:
        r = c.get(f"/api/collections/{coll_id}/article-ids", follow_redirects=False)
        assert r.status_code == 302


def test_get_article_ids_reader_allowed():
    mini = _make_get_article_ids_app(__name__ + ".gai2")
    coll_id = str(uuid.uuid4())
    with mini.test_client() as c:
        _reader_session(c)
        r = c.get(f"/api/collections/{coll_id}/article-ids", follow_redirects=False)
        assert r.status_code != 302
