"""VC editors who are NOT admins must be able to run the generator's write
routes; plain readers must not. Mini Flask app, no DB."""
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

pytest.importorskip("flask")
pytest.importorskip("sqlalchemy")


def _client(monkeypatch, role, is_editor):
    from flask import Flask
    try:
        from tools.prionvault import prionvault_bp
        from tools.prionvault.services import vc_generate as g
    except Exception as exc:              # heavy optional deps missing in CI
        pytest.skip(f"prionvault not importable: {exc}")
    import core.users as cu

    monkeypatch.setattr(cu, "get_user", lambda u: {
        "username": u, "role": role, "is_vc_editor": "true" if is_editor else "false"})
    monkeypatch.setattr(g, "propose_articles", lambda *a, **k: {"added": 2, "skipped": 0})
    monkeypatch.setattr(g, "set_selected_many", lambda *a, **k: 3)
    monkeypatch.setattr(g, "start", lambda *a, **k: {"running": True})

    app = Flask("vc_perm_%s_%s" % (role, is_editor))
    app.secret_key = "x"
    app.config["TESTING"] = True
    app.add_url_rule("/login", endpoint="auth.login", view_func=lambda: "login")
    app.add_url_rule("/", endpoint="home", view_func=lambda: "home")
    app.register_blueprint(prionvault_bp, url_prefix="/prionvault")
    c = app.test_client()
    with c.session_transaction() as s:
        s.update(logged_in=True, role=role, username="u1", user_id=None, _chk=9e12)
    return c


CALLS = [
    ("/prionvault/api/vc/draft/2026/propose", {"ids": ["a", "b"]}),
    ("/prionvault/api/vc/draft/2026/items", {"ids": [1, 2, 3], "selected": False}),
    ("/prionvault/api/vc/draft/2026/run", {"step": "revise", "request": "añade una frase"}),
    ("/prionvault/api/vc/draft/2026/run", {"step": "narrow", "n": 30}),
    ("/prionvault/api/vc/draft/2026/run", {"step": "themes"}),
]


@pytest.mark.parametrize("url,body", CALLS)
def test_non_admin_vc_editor_can_write(monkeypatch, url, body):
    r = _client(monkeypatch, "reader", True).post(url, json=body)
    assert r.status_code == 200, r.get_data(as_text=True)


@pytest.mark.parametrize("url,body", CALLS)
def test_plain_reader_is_refused(monkeypatch, url, body):
    r = _client(monkeypatch, "reader", False).post(url, json=body)
    assert r.status_code == 403
