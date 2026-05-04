"""PrionVault migration runner.

Applies the SQL files under `migrations/` to the live database.

Design:
  - Idempotent: each migration uses CREATE IF NOT EXISTS / ADD COLUMN IF
    NOT EXISTS, so re-running has no side effects.
  - Tracked: a tiny table `applied_migrations` records what has been
    applied so subsequent boots are no-ops (they only check the table).
  - Resilient: failures are logged but do NOT crash the app — the rest
    of the Flask boot continues. This way a transient DB hiccup never
    takes the whole site down.
  - Auditable: applied_at, hash of the file, and runtime in ms are
    stored so we can verify what ran and when.

Usage from app.py boot:
    from tools.prionvault.migrate import run_pending_migrations
    run_pending_migrations(app)
"""
from __future__ import annotations

import hashlib
import logging
import os
import time
from pathlib import Path

logger = logging.getLogger(__name__)

# Project root (PrionLab-tools/) regardless of cwd.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_MIGRATIONS_DIR = _REPO_ROOT / "migrations"

# Migrations under this prefix are managed by PrionVault. Other modules
# (PrionRead etc.) keep their own migration paths separate.
_PRIONVAULT_MIGRATIONS = (
    "001_prionvault_tables.sql",
)

# DDL for the bookkeeping table — created on first run.
_BOOTSTRAP_SQL = """
CREATE TABLE IF NOT EXISTS applied_migrations (
    name        VARCHAR(255) PRIMARY KEY,
    sha256      CHAR(64)     NOT NULL,
    applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    runtime_ms  INTEGER
);
"""


def _file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _is_applied(conn, name: str) -> bool:
    cur = conn.execute(
        # Use parameterised query — `applied_migrations.name` is plain text.
        "SELECT 1 FROM applied_migrations WHERE name = :n",
        {"n": name},
    )
    return cur.first() is not None


def _record(conn, name: str, sha: str, runtime_ms: int):
    conn.execute(
        """
        INSERT INTO applied_migrations (name, sha256, applied_at, runtime_ms)
        VALUES (:n, :s, NOW(), :ms)
        ON CONFLICT (name) DO UPDATE
          SET sha256     = EXCLUDED.sha256,
              applied_at = NOW(),
              runtime_ms = EXCLUDED.runtime_ms
        """,
        {"n": name, "s": sha, "ms": runtime_ms},
    )


def run_pending_migrations(app=None) -> dict:
    """Apply any pending PrionVault migrations.

    Returns a dict like:
        {"applied": [...], "skipped": [...], "errors": [...]}

    Safe to call repeatedly. If DATABASE_URL is not set or the DB is
    unreachable we log a warning and return early — the app keeps booting.
    """
    summary = {"applied": [], "skipped": [], "errors": []}

    try:
        from sqlalchemy import text  # local import: only used if DB is set up
        from database.config import db
    except Exception as exc:
        logger.warning("PrionVault migrations skipped — SQLAlchemy or DB config not available: %s", exc)
        return summary

    if not getattr(db, "engine", None):
        logger.warning("PrionVault migrations skipped — db.engine is not configured (no DATABASE_URL?).")
        return summary

    if not _MIGRATIONS_DIR.exists():
        logger.warning("PrionVault migrations skipped — directory %s missing.", _MIGRATIONS_DIR)
        return summary

    try:
        with db.engine.begin() as conn:
            conn.execute(text(_BOOTSTRAP_SQL))
    except Exception as exc:
        # If we can't even create the bookkeeping table, the DB is clearly
        # not in a good state — log and abort, but don't crash the app.
        logger.error("PrionVault migration bootstrap failed: %s", exc, exc_info=False)
        summary["errors"].append({"phase": "bootstrap", "error": str(exc)})
        return summary

    for fname in _PRIONVAULT_MIGRATIONS:
        path = _MIGRATIONS_DIR / fname
        if not path.exists():
            logger.warning("PrionVault migration file missing: %s", path)
            summary["errors"].append({"name": fname, "error": "file not found"})
            continue

        sha = _file_hash(path)

        try:
            with db.engine.begin() as conn:
                if _is_applied(conn, fname):
                    summary["skipped"].append({"name": fname, "sha": sha})
                    logger.info("PrionVault migration %s already applied — skipping.", fname)
                    continue

                logger.info("PrionVault — applying migration %s …", fname)
                t0 = time.monotonic()
                # The SQL file is a single transactional block (BEGIN; … COMMIT;)
                # but executing it through SQLAlchemy in a single .execute() works
                # — psycopg2 splits the multi-statement string at the protocol level.
                conn.exec_driver_sql(path.read_text())
                runtime_ms = int((time.monotonic() - t0) * 1000)
                _record(conn, fname, sha, runtime_ms)
                summary["applied"].append({"name": fname, "sha": sha, "runtime_ms": runtime_ms})
                logger.info("PrionVault migration %s applied in %d ms.", fname, runtime_ms)
        except Exception as exc:
            logger.error("PrionVault migration %s FAILED: %s", fname, exc, exc_info=True)
            summary["errors"].append({"name": fname, "error": str(exc)})
            # Don't abort the loop — try the next migration. (Currently only
            # one migration exists; relevant when more are added.)

    return summary
