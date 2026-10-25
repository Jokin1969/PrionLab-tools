"""Regression tests for the security / data-safety hardening.

No DB needed: safe redirects, users.csv read-modify-write, the PrionPacks
admin gate, and the migration self-heal statement parser.
"""
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

pytest.importorskip("flask")
pytest.importorskip("bcrypt")


@pytest.mark.parametrize("url,ok", [
    ("/prionvault/?open=1", True),
    ("/", True),
    ("//evil.com", False),
    ("/\\evil.com", False),
    ("https://evil.com", False),
    ("javascript:alert(1)", False),
    ("", False),
    (None, False),
])
def test_safe_next_url(url, ok):
    from core.auth import safe_next_url
    got = safe_next_url(url)
    assert (got is not None and got == url) is ok


def test_users_csv_read_modify_write(tmp_path, monkeypatch):
    import core.users as u
    monkeypatch.setattr(u, "CSV_DIR", str(tmp_path))
    monkeypatch.setattr(u, "USERS_FILE", str(tmp_path / "users.csv"))
    u.create_user({"username": "a"}, sync=False)
    u.create_user({"username": "b"}, sync=False)
    assert u.update_user("a", {"full_name": "Ana"}, sync=False)
    assert u.delete_user("b", sync=False)
    rows = u.load_users()
    assert [(r["username"], r["full_name"]) for r in rows] == [("a", "Ana")]
    # No temp files left behind by the atomic write.
    assert not [p for p in os.listdir(tmp_path) if ".tmp." in p]


def test_users_csv_edit_aborts_on_unreadable_file(tmp_path, monkeypatch):
    import core.users as u
    monkeypatch.setattr(u, "CSV_DIR", str(tmp_path))
    monkeypatch.setattr(u, "USERS_FILE", str(tmp_path / "users.csv"))
    u.create_user({"username": "a"}, sync=False)

    def boom():
        raise OSError("disk hiccup")
    monkeypatch.setattr(u, "_read_users", boom)
    with pytest.raises(OSError):
        u.create_user({"username": "b"}, sync=False)
    monkeypatch.undo()
    monkeypatch.setattr(u, "USERS_FILE", str(tmp_path / "users.csv"))
    # The existing user list was NOT replaced by a one-row file.
    assert [r["username"] for r in u.load_users()] == ["a"]


def test_prionpacks_admin_gate():
    from flask import Flask, jsonify
    from tools.prionpacks.routes import _admin_api

    app = Flask("pp")
    app.secret_key = "x"

    @app.route("/x", methods=["POST"])
    @_admin_api
    def x():
        return jsonify(ok=True)

    c = app.test_client()
    with c.session_transaction() as s:
        s["logged_in"], s["role"] = True, "reader"
    assert c.post("/x").status_code == 403
    with c.session_transaction() as s:
        s["role"] = "admin"
    assert c.post("/x").status_code == 200


def test_self_heal_parser_picks_up_late_migrations():
    """Columns from every migration (e.g. 091) are covered by self-heal."""
    import re
    from tools.prionvault import migrate
    blob = (migrate._MIGRATIONS_DIR / "091_oa_author_requested.sql").read_text()
    stmts = [s for s in migrate._split_sql(blob) if re.match(r"\s*ALTER", s, re.I)]
    assert stmts and "oa_author_requested_at" in stmts[0]
