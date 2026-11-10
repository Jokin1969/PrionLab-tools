"""Readers must not reach tools outside PrionVault/PrionRead, and the login
rate limit must really be applied."""
import pytest

pytest.importorskip("flask")
pytest.importorskip("flask_limiter")


@pytest.fixture(scope="module")
def app():
    try:
        from app import create_app
        a = create_app()
    except Exception as exc:          # missing optional deps in CI
        pytest.skip(f"app not importable: {exc}")
    a.config["TESTING"] = True
    return a


def _login(client, role):
    with client.session_transaction() as s:
        s["logged_in"] = True
        s["role"] = role
        s["username"] = "t_" + role


def test_reader_blocked_outside_allowed_tools(app):
    allowed = {"auth", "prionvault", "prionread", "home_notes", "help"}
    c = app.test_client()
    _login(c, "reader")
    checked = 0
    for rule in app.url_map.iter_rules():
        bp = rule.endpoint.split(".")[0] if "." in rule.endpoint else None
        if rule.arguments or "GET" not in rule.methods:
            continue
        if bp in allowed or rule.endpoint in ("home", "health", "static"):
            continue
        r = c.get(rule.rule)
        assert r.status_code in (302, 403), (rule.rule, r.status_code)
        if r.status_code == 302:
            assert "login" not in r.headers["Location"], rule.rule
        checked += 1
    assert checked > 20


def test_reader_post_is_403(app):
    c = app.test_client()
    _login(c, "reader")
    assert c.post("/lab/create", data={"lab_name": "x"}).status_code == 403


def test_login_rate_limit_is_wired(app):
    c = app.test_client()
    codes = [c.post("/login", data={"username": "nobody", "password": "x"}).status_code
             for _ in range(12)]
    assert 429 in codes


def test_sender_address_ignores_display_name():
    from tools.prionvault.services.email_ingest import _extract_address, _is_allowed_sender
    assert _extract_address('"boss@lab.es" <attacker@evil.com>') == "attacker@evil.com"
    assert _extract_address("Ana <Ana@Lab.es>") == "ana@lab.es"
    assert not _is_allowed_sender("evilana@lab.es", ["ana@lab.es"])
    assert _is_allowed_sender("x@lab.es", ["@lab.es"])
