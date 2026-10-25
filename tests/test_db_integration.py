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
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
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
