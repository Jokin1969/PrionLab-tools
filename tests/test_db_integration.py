"""Integration tests against a real, THROWAWAY Postgres.

Skipped unless TEST_DATABASE_URL is set (they create/drop tables), e.g.
    TEST_DATABASE_URL=postgresql://postgres@localhost/test pytest tests/test_db_integration.py
"""
import gzip
import os
import sys
import uuid

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL not set")


@pytest.fixture()
def engine():
    sqlalchemy = pytest.importorskip("sqlalchemy")
    url = URL.replace("postgres://", "postgresql://", 1)
    if url.startswith("postgresql://"):
        pass  # same driver as production (SQLAlchemy default)
    eng = sqlalchemy.create_engine(url)
    yield eng
    eng.dispose()


def test_claim_due_hands_each_row_to_one_caller_and_backs_off(engine):
    from sqlalchemy import text
    from tools.prionvault.services import send_claim
    t = f"t_claim_{uuid.uuid4().hex[:8]}"
    with engine.begin() as c:
        c.execute(text(f"CREATE TABLE {t} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "
                       "scheduled_at timestamptz, sent_at timestamptz)"))
        c.execute(text(f"INSERT INTO {t}(scheduled_at) VALUES (now() - interval '1 min'), "
                       "(now() + interval '1 day')"))
    try:
        first = send_claim.claim_due(engine, t, "t.id")
        second = send_claim.claim_due(engine, t, "t.id")
        assert len(first) == 1 and second == []          # no double send
        with engine.begin() as c:                         # after the backoff…
            c.execute(text(f"UPDATE {t} SET last_attempt_at = now() - interval '11 min'"))
        assert len(send_claim.claim_due(engine, t, "t.id")) == 1   # …retried
        with engine.begin() as c:
            c.execute(text(f"UPDATE {t} SET attempts = {send_claim.MAX_ATTEMPTS}, "
                           "last_attempt_at = now() - interval '1 day'"))
        assert send_claim.claim_due(engine, t, "t.id") == []        # gave up
    finally:
        with engine.begin() as c:
            c.execute(text(f"DROP TABLE {t}"))


def test_heal_missing_columns_readds_only_missing(engine):
    import types
    from sqlalchemy import text
    from tools.prionvault import migrate
    with engine.begin() as c:
        c.execute(text("DROP TABLE IF EXISTS prionvault_reminder"))
        c.execute(text("CREATE TABLE prionvault_reminder (id uuid)"))
    try:
        db = types.SimpleNamespace(engine=engine)
        added = migrate._heal_missing_columns(db)
        cols = {c for a in added if a["table"] == "prionvault_reminder" for c in a["columns"]}
        assert {"attempts", "last_attempt_at"} <= cols
        assert not [a for a in migrate._heal_missing_columns(db)
                    if a["table"] == "prionvault_reminder"]
    finally:
        with engine.begin() as c:
            c.execute(text("DROP TABLE prionvault_reminder"))


def test_pg_dump_backup_streams_and_restores(engine, tmp_path, monkeypatch):
    import shutil
    from sqlalchemy import text
    if not shutil.which("pg_dump") or not shutil.which("psql"):
        pytest.skip("pg_dump/psql not installed")
    import database.backup as backup
    from database.config import db
    monkeypatch.setattr(backup, "BACKUP_DIR", tmp_path)
    t = f"t_dump_{uuid.uuid4().hex[:8]}"
    with engine.begin() as c:
        c.execute(text(f"CREATE TABLE {t} (id int, s text)"))
        c.execute(text(f"INSERT INTO {t} SELECT g, 'v%:'||g FROM generate_series(1, 5000) g"))
    try:
        cls = next(c for c in vars(backup).values()
                   if isinstance(c, type) and hasattr(c, "_pg_dump_backup"))
        mgr = cls.__new__(cls)
        res = mgr._pg_dump_backup(URL, "t")
        assert res["success"], res
        assert f"CREATE TABLE public.{t}" in gzip.open(res["path"], "rt").read()
        with engine.begin() as c:
            c.execute(text(f"DROP TABLE {t}"))
        monkeypatch.setattr(db, "database_url", URL)
        monkeypatch.setattr(db, "is_configured", lambda: True)
        assert mgr.restore_from_backup(res["path"])["success"]
        with engine.connect() as c:
            assert c.execute(text(f"SELECT count(*) FROM {t}")).scalar() == 5000
    finally:
        with engine.begin() as c:
            c.execute(text(f"DROP TABLE IF EXISTS {t}"))


def test_users_postgres_store(engine, tmp_path, monkeypatch):
    """users.csv → prionlab_users import, CRUD through core.users' public
    API, CSV snapshot, and read fallback when the DB fails."""
    import types
    from sqlalchemy import text
    import core.users as u
    monkeypatch.setitem(sys.modules, "core.sync",
                        types.SimpleNamespace(push_to_dropbox=lambda *a, **k: True))
    monkeypatch.setattr(u, "CSV_DIR", str(tmp_path))
    monkeypatch.setattr(u, "USERS_FILE", str(tmp_path / "users.csv"))
    monkeypatch.setattr(u, "_engine", lambda: engine)
    monkeypatch.setitem(u._db_state, "ready", None)
    sql = open(os.path.join(ROOT, "migrations", "102_prionlab_users.sql")).read()
    with engine.begin() as c:
        c.execute(text("DROP TABLE IF EXISTS prionlab_users"))
        c.exec_driver_sql(sql)
    try:
        # Existing users.csv (CSV mode write) is imported on first use.
        u._csv_write([{"username": "Ana", "email": "Ana@Lab.es", "role": "admin",
                       "active": "true", "is_jc_responsible": "true"},
                      {"username": "bea", "email": "bea@lab.es", "role": "reader",
                       "active": "true"}], sync=False)
        assert u.ensure_db_store() is True
        assert u.ensure_db_store() is True          # idempotent, no double import
        assert [x["username"] for x in u.load_users()] == ["Ana", "bea"]
        assert u.get_user("ana")["role"] == "admin"            # case-insensitive
        assert u.get_user_by_email(" ana@lab.es ")["username"] == "Ana"
        assert u.get_user_by_username_or_email("bea@lab.es")["username"] == "bea"
        assert u.list_admin_emails() == ["Ana@Lab.es"]
        assert [x["username"] for x in u.list_jc_responsible()] == ["Ana"]

        u.create_user({"username": "cris", "email": "c@lab.es", "role": "reader",
                       "active": "true"}, sync=False)
        assert u.user_exists("CRIS") and u.email_exists("C@lab.es")
        assert u.update_user("cris", {"full_name": "Cris", "nope": "x"}, sync=False)
        assert u.get_user("cris")["full_name"] == "Cris"
        assert not u.update_user("ghost", {"full_name": "x"}, sync=False)
        assert u.delete_user("bea", sync=False) and not u.user_exists("bea")

        # users.csv mirrors the DB after every change.
        assert [x["username"] for x in u._csv_read()] == ["Ana", "cris"]

        # DB outage: reads fall back to the users.csv snapshot.
        def broken():
            raise RuntimeError("db down")
        monkeypatch.setattr(u, "_db_rows", broken)
        monkeypatch.setattr(u, "_db_one", lambda *a, **k: broken())
        assert u.get_user("cris")["full_name"] == "Cris"
        assert len(u.load_users()) == 2
    finally:
        with engine.begin() as c:
            c.execute(text("DROP TABLE IF EXISTS prionlab_users"))
