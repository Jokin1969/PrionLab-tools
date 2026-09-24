"""Tests for auth decorators and (optionally) the real Flask app.

Decorator tests run on minimal standalone Flask apps — no DB, no
flask_babel, no external dependencies. The full-app tests are skipped
automatically when flask_babel is not installed (e.g. bare CI images).
"""
import sys
import os
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

pytest.importorskip("flask")

# ── login_required decorator (standalone mini-app) ───────────────────────────

def test_login_required_blocks_anonymous():
    from flask import Flask
    from core.decorators import login_required

    mini = Flask(__name__ + ".lr")
    mini.secret_key = "x"

    # The decorator calls url_for("auth.login") — register with that exact endpoint.
    def _login_view():
        return "login page", 200
    mini.add_url_rule("/login", endpoint="auth.login", view_func=_login_view)

    @mini.route("/protected")
    @login_required
    def _protected():
        return "ok", 200

    with mini.test_client() as c:
        r = c.get("/protected")
        assert r.status_code in (301, 302)
        assert "login" in r.headers.get("Location", "").lower()


def test_login_required_allows_authenticated():
    from flask import Flask
    from core.decorators import login_required

    mini = Flask(__name__ + ".lr2")
    mini.secret_key = "x"

    @mini.route("/protected")
    @login_required
    def _protected():
        return "ok", 200

    with mini.test_client() as c:
        with c.session_transaction() as sess:
            sess["logged_in"] = True
        r = c.get("/protected")
        assert r.status_code == 200
        assert b"ok" in r.data


# ── admin_required decorator (standalone mini-app) ───────────────────────────

def _make_admin_app(name):
    """Mini Flask app with admin_required + minimal home + login stubs."""
    from flask import Flask
    from core.decorators import admin_required

    mini = Flask(name)
    mini.secret_key = "x"

    @mini.route("/")
    def home():
        return "home", 200

    @mini.route("/login")
    def login():
        return "login", 200

    # Alias so url_for("auth.login") works inside the decorator.
    mini.add_url_rule("/login", endpoint="auth.login", view_func=login)

    @mini.route("/admin-only")
    @admin_required
    def _admin():
        return "admin ok", 200

    return mini


def test_admin_required_blocks_reader():
    mini = _make_admin_app(__name__ + ".ar1")
    with mini.test_client() as c:
        with c.session_transaction() as sess:
            sess["logged_in"] = True
            sess["role"] = "reader"
        r = c.get("/admin-only", follow_redirects=False)
        # Redirect away — not granted.
        assert r.status_code in (301, 302)


def test_admin_required_blocks_anonymous():
    mini = _make_admin_app(__name__ + ".ar2")
    with mini.test_client() as c:
        r = c.get("/admin-only", follow_redirects=False)
        assert r.status_code in (301, 302)


def test_admin_required_allows_admin():
    mini = _make_admin_app(__name__ + ".ar3")
    with mini.test_client() as c:
        with c.session_transaction() as sess:
            sess["logged_in"] = True
            sess["role"] = "admin"
        r = c.get("/admin-only")
        assert r.status_code == 200
        assert b"admin ok" in r.data


# ── Full-app tests (skipped when heavy deps missing) ─────────────────────────

flask_babel = pytest.importorskip("flask_babel", reason="flask_babel not installed")


@pytest.fixture(scope="module")
def app():
    os.environ.setdefault("ADMIN_PASSWORD", "test-password-123")
    os.environ.setdefault("DATA_DIR", "/tmp/prionlab-test-data")

    import pathlib
    for sub in ("csv", "papers", "cache", "logs"):
        pathlib.Path(f"/tmp/prionlab-test-data/{sub}").mkdir(parents=True, exist_ok=True)

    try:
        from app import create_app
        flask_app = create_app()
    except Exception as exc:
        pytest.skip(f"Full app not importable in this env ({exc})")

    flask_app.config["TESTING"] = True
    flask_app.config["SERVER_NAME"] = "localhost"
    return flask_app


@pytest.fixture()
def client(app):
    return app.test_client()


def test_login_page_returns_200(client):
    r = client.get("/login")
    assert r.status_code == 200


def test_login_page_contains_password_field(client):
    body = client.get("/login").data.decode()
    assert "password" in body.lower()


@pytest.mark.parametrize("path", [
    "/",
    "/prionvault/",
    "/prionvault/api/articles",
])
def test_unauthenticated_redirects_to_login(client, path):
    r = client.get(path, follow_redirects=False)
    assert r.status_code in (301, 302, 303, 307, 308)
    assert "login" in r.headers.get("Location", "").lower()


def test_bad_login_stays_on_login_page(client):
    r = client.post("/login", data={
        "username": "nobody",
        "password": "wrongpassword",
    }, follow_redirects=True)
    assert "password" in r.data.decode().lower()


def test_security_headers_on_login_page(client):
    r = client.get("/login")
    assert r.headers.get("X-Frame-Options") == "SAMEORIGIN"
    assert r.headers.get("X-Content-Type-Options") == "nosniff"
    assert "Content-Security-Policy" in r.headers
