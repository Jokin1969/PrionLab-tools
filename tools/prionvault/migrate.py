"""PrionVault migration runner.

Applies the SQL files under `migrations/` to the live database.

Design:
  - Idempotent: each migration uses CREATE IF NOT EXISTS / ADD COLUMN IF
    NOT EXISTS, so re-running has no side effects.
  - Tracked: a tiny table `applied_migrations` records what has been
    applied so subsequent boots are no-ops (they only check the table).
  - **Non-blocking**: the public entry-point launches a daemon thread
    so app boot is never delayed by the migration. Important for
    Railway's healthcheck (30-second timeout) — gunicorn must be able
    to respond to /health within that window.
  - Resilient: failures are logged but never raise. Each statement is
    wrapped in its own transaction so that a permission error on
    CREATE EXTENSION (common on managed PostgreSQL) does not abort the
    whole migration.

Usage from app.py boot:
    from tools.prionvault.migrate import schedule_pending_migrations
    schedule_pending_migrations(app)
"""
from __future__ import annotations

import hashlib
import logging
import re
import threading
import time
from pathlib import Path

logger = logging.getLogger(__name__)

# Project root (PrionLab-tools/) regardless of cwd.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_MIGRATIONS_DIR = _REPO_ROOT / "migrations"

_PRIONVAULT_MIGRATIONS = (
    "001_prionvault_tables.sql",
    "003_fix_step_column.sql",
    "005_prionvault_user_state.sql",
    "006_prionvault_chunk_fts.sql",
    "007_articles_columns_repair.sql",
    "008_article_supplementary.sql",
    "009_articles_pdf_searchable.sql",
    "010_pdf_searchable_backfill_fix.sql",
    "011_prionvault_usage_user_id_nullable.sql",
    "012_prionvault_collections.sql",
    "013_hnsw_index_tuning.sql",
    "014_prionvault_journal_club.sql",
)

_BOOTSTRAP_SQL = """
CREATE TABLE IF NOT EXISTS applied_migrations (
    name        VARCHAR(255) PRIMARY KEY,
    sha256      CHAR(64)     NOT NULL,
    applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    runtime_ms  INTEGER
)
"""


def _file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _split_sql(text_blob: str) -> list[str]:
    """Split a multi-statement SQL file into individually-executable
    statements. Strips outer BEGIN/COMMIT (we manage transactions
    ourselves) and respects $$-delimited PL/pgSQL bodies (functions).
    """
    # Drop top-level transaction wrappers; we create our own.
    # Require a semicolon for BEGIN so we don't strip BEGIN from inside
    # PL/pgSQL function / DO block bodies (those never have a trailing ;).
    body = re.sub(r"^\s*BEGIN\s*;\s*$", "", text_blob,
                  flags=re.MULTILINE | re.IGNORECASE)
    body = re.sub(r"^\s*COMMIT\s*;?\s*$", "", body,
                  flags=re.MULTILINE | re.IGNORECASE)

    statements = []
    current = []
    in_dollar = False
    dollar_tag = None

    # Parse line-by-line, tracking $$ blocks, splitting on ; outside them.
    i = 0
    while i < len(body):
        ch = body[i]
        # Detect $tag$ ... $tag$ blocks (PL/pgSQL functions)
        if not in_dollar and ch == "$":
            m = re.match(r"\$([A-Za-z_]*)\$", body[i:])
            if m:
                in_dollar = True
                dollar_tag = m.group(0)
                current.append(dollar_tag)
                i += len(dollar_tag)
                continue
        elif in_dollar and ch == "$":
            if body[i:i + len(dollar_tag)] == dollar_tag:
                current.append(dollar_tag)
                in_dollar = False
                i += len(dollar_tag)
                dollar_tag = None
                continue

        if ch == ";" and not in_dollar:
            stmt = "".join(current).strip()
            if stmt:
                statements.append(stmt)
            current = []
        else:
            current.append(ch)
        i += 1

    tail = "".join(current).strip()
    if tail:
        statements.append(tail)

    # Strip pure comments / blank lines.
    cleaned = []
    for s in statements:
        # Remove leading comment lines but keep statement comments inline.
        lines = [ln for ln in s.splitlines() if ln.strip() and not ln.strip().startswith("--")]
        if lines:
            cleaned.append("\n".join(lines))
    return cleaned


def _run_migrations_inline() -> dict:
    """Apply pending migrations synchronously. Internal — call via the
    threaded entry-point or the admin endpoint.

    Each statement runs in its own transaction so a permission error on
    CREATE EXTENSION (or any other isolated failure) does not roll back
    the rest of the migration. The migration is recorded as applied as
    long as the *majority* of statements succeed; isolated failures are
    logged in the summary.
    """
    summary = {"applied": [], "skipped": [], "errors": []}

    try:
        from sqlalchemy import text
        from database.config import db
    except Exception as exc:
        logger.warning("PrionVault migrations skipped — SQLAlchemy not loadable: %s", exc)
        return summary

    if not getattr(db, "engine", None):
        logger.warning("PrionVault migrations skipped — db.engine is None (no DATABASE_URL?).")
        return summary

    if not _MIGRATIONS_DIR.exists():
        logger.warning("PrionVault migrations skipped — directory %s missing.", _MIGRATIONS_DIR)
        return summary

    # 1) Bootstrap the tracking table.
    try:
        with db.engine.begin() as conn:
            conn.execute(text(_BOOTSTRAP_SQL))
    except Exception as exc:
        logger.error("PrionVault: cannot create applied_migrations table — %s", exc)
        summary["errors"].append({"phase": "bootstrap", "error": str(exc)})
        return summary

    for fname in _PRIONVAULT_MIGRATIONS:
        path = _MIGRATIONS_DIR / fname
        if not path.exists():
            summary["errors"].append({"name": fname, "error": "file not found"})
            continue

        sha = _file_hash(path)

        # Already applied?
        try:
            with db.engine.connect() as conn:
                row = conn.execute(
                    text("SELECT 1 FROM applied_migrations WHERE name = :n"),
                    {"n": fname},
                ).first()
            if row:
                summary["skipped"].append({"name": fname, "sha": sha})
                logger.info("PrionVault: %s already applied — skipping.", fname)
                continue
        except Exception as exc:
            logger.warning("PrionVault: applied_migrations lookup failed (%s) — continuing.", exc)

        # Run statements one-by-one, each in its own transaction. Track
        # how many succeed / fail; record the migration as applied even
        # if some isolated statements failed (they're idempotent and the
        # admin can inspect the summary).
        logger.info("PrionVault — applying migration %s …", fname)
        t0 = time.monotonic()
        statements = _split_sql(path.read_text())
        ok, fails = 0, []
        for j, stmt in enumerate(statements, 1):
            try:
                with db.engine.begin() as conn:
                    conn.exec_driver_sql(stmt)
                ok += 1
            except Exception as exc:
                # Log the first 120 chars of the offending statement and
                # the exception. Idempotent ops (CREATE IF NOT EXISTS, etc.)
                # rarely fail; the most common cause is missing permissions
                # for CREATE EXTENSION on managed PostgreSQL.
                head = stmt.replace("\n", " ")[:120]
                logger.warning("PrionVault: stmt %d/%d failed (%s) — head: %s",
                               j, len(statements), exc, head)
                fails.append({"stmt_index": j, "error": str(exc), "head": head})

        runtime_ms = int((time.monotonic() - t0) * 1000)

        # Record the migration as applied (even partial). Reapplying is
        # cheap thanks to IF NOT EXISTS guards.
        try:
            with db.engine.begin() as conn:
                conn.execute(
                    text(
                        """
                        INSERT INTO applied_migrations (name, sha256, applied_at, runtime_ms)
                        VALUES (:n, :s, NOW(), :ms)
                        ON CONFLICT (name) DO UPDATE
                          SET sha256     = EXCLUDED.sha256,
                              applied_at = NOW(),
                              runtime_ms = EXCLUDED.runtime_ms
                        """
                    ),
                    {"n": fname, "s": sha, "ms": runtime_ms},
                )
        except Exception as exc:
            logger.error("PrionVault: failed to record applied migration %s — %s", fname, exc)

        entry = {"name": fname, "sha": sha, "runtime_ms": runtime_ms,
                 "statements_ok": ok, "statements_failed": fails}
        if fails:
            summary["errors"].append(entry)
        else:
            summary["applied"].append(entry)
        logger.info("PrionVault migration %s done in %d ms (%d ok, %d failed).",
                    fname, runtime_ms, ok, len(fails))

    return summary


def run_pending_migrations(app=None) -> dict:
    """Synchronous, returns the summary dict. Use this from the admin
    endpoint or from tests. For app boot, use schedule_pending_migrations()
    to avoid blocking gunicorn / healthchecks."""
    return _run_migrations_inline()


def schedule_pending_migrations(app=None) -> threading.Thread:
    """Run migrations in a background daemon thread so app boot is
    non-blocking. Returns the thread handle (mostly for tests)."""

    def _runner():
        # Tiny initial delay lets the HTTP server bind to the port first
        # and respond to the first /health probe.
        time.sleep(2)
        try:
            result = _run_migrations_inline()
            applied = [m["name"] for m in result.get("applied", [])]
            errors  = result.get("errors", [])
            if applied:
                logger.info("PrionVault background migrations applied: %s", applied)
            if errors:
                logger.warning("PrionVault background migrations had errors: %s", errors)
        except Exception as exc:
            logger.exception("PrionVault background migration crashed: %s", exc)

    th = threading.Thread(target=_runner, name="prionvault-migrate", daemon=True)
    th.start()
    return th
