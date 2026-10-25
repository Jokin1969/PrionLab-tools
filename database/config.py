import json
import logging
import os
from contextlib import contextmanager

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker, scoped_session
from sqlalchemy.pool import QueuePool

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


class DatabaseConfig:
    """Database configuration and connection management."""

    def __init__(self):
        self.Base = Base
        self.engine = None
        self.Session = None
        self.database_url = self._get_database_url()
        if self.database_url:
            self._setup()

    def _get_database_url(self) -> str:
        url = os.getenv('DATABASE_URL', '')
        # Railway uses postgres:// but SQLAlchemy 2.x requires postgresql://
        if url.startswith('postgres://'):
            url = url.replace('postgres://', 'postgresql://', 1)
        return url

    def _setup(self) -> None:
        self.engine = create_engine(
            self.database_url,
            poolclass=QueuePool,
            # Per gunicorn worker (×2), plus daemon threads: keep the total
            # well under Railway Postgres' ~100 connection limit.
            pool_size=int(os.getenv("DB_POOL_SIZE", "5")),
            max_overflow=int(os.getenv("DB_MAX_OVERFLOW", "10")),
            pool_pre_ping=True,
            pool_recycle=300,
            echo=os.getenv('FLASK_ENV') == 'development',
            json_serializer=lambda obj: json.dumps(obj, ensure_ascii=False),
        )
        session_factory = sessionmaker(
            bind=self.engine,
            autocommit=False,
            autoflush=True,
            expire_on_commit=False,
        )
        self.Session = scoped_session(session_factory)

        # Async commit (faster writes, but the last ~0.5 s of commits can be
        # lost on a Postgres crash — e.g. an email's sent_at, so it would be
        # sent again). Off by default now; opt in with PG_ASYNC_COMMIT=1.
        if os.getenv("PG_ASYNC_COMMIT", "") == "1":
            @event.listens_for(self.engine, "connect")
            def on_connect(dbapi_connection, connection_record):
                with dbapi_connection.cursor() as cur:
                    cur.execute("SET synchronous_commit = off")

    def is_configured(self) -> bool:
        return bool(self.database_url) and self.engine is not None

    @contextmanager
    def get_session(self):
        if not self.is_configured():
            raise RuntimeError("Database not configured — DATABASE_URL is not set.")
        session = self.Session()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def test_connection(self) -> bool:
        if not self.is_configured():
            return False
        try:
            with self.engine.connect() as conn:
                conn.execute(text('SELECT 1'))
            return True
        except Exception as e:
            logger.error("Database connection test failed: %s", e)
            return False

    def create_all_tables(self) -> None:
        import database.models  # noqa: F401 — registers all models with Base
        Base.metadata.create_all(self.engine)
        logger.info("Database tables created successfully")

    # Session-scoped Postgres advisory lock key for run_migrations(), so
    # concurrent gunicorn workers (each calls create_app() -> run_migrations()
    # independently at startup) serialize instead of racing. Without this,
    # two workers can both see a migration as "not yet applied" and both
    # execute it — harmless for idempotent DDL like `CREATE TABLE IF NOT
    # EXISTS`, but `CREATE EXTENSION IF NOT EXISTS` is NOT race-safe: both
    # transactions can pass the not-exists check before either commits, and
    # the second hits a UniqueViolation on pg_extension_name_index. ASCII
    # "prv_mig" packed as a bigint, distinct from email_ingest's leader lock.
    _MIGRATION_LOCK_KEY = 0x7072765F6D6967

    def run_migrations(self) -> dict:
        """Execute all pending SQL migration files in order — the ONE
        migration runner (boot, and PrionVault's "Force migrations"
        button). Returns {"applied", "skipped", "errors"}."""
        if not self.is_configured():
            logger.warning("Database not configured — skipping migrations")
            return {"applied": [], "skipped": [], "errors": []}

        import os
        from pathlib import Path

        migrations_dir = Path(__file__).parent.parent / "migrations"
        if not migrations_dir.exists():
            logger.warning("Migrations directory not found at %s", migrations_dir)
            return {"applied": [], "skipped": [], "errors": []}

        # Get all .sql files, sorted by filename (which includes sequential numbers)
        migration_files = sorted([f for f in migrations_dir.glob("*.sql")])
        if not migration_files:
            logger.info("No migration files found")
            return {"applied": [], "skipped": [], "errors": []}

        # Block here until any other worker's migration run finishes —
        # pg_advisory_lock (not the _try_ variant) waits rather than
        # failing, which is what we want: whichever worker loses the race
        # just waits its turn, then finds every migration already applied
        # and skips them all via the _schema_migrations check below.
        lock_conn = self.engine.connect()
        try:
            lock_conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": self._MIGRATION_LOCK_KEY})
            lock_conn.commit()
        except Exception as e:
            logger.warning("Could not acquire migration advisory lock, proceeding unlocked: %s", e)

        try:
            return self._run_migrations_locked(migration_files)
        finally:
            try:
                lock_conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": self._MIGRATION_LOCK_KEY})
                lock_conn.commit()
            except Exception:
                pass
            lock_conn.close()

    # Statement failures that are environmental, not schema bugs (managed
    # Postgres without superuser for CREATE EXTENSION, objects owned by
    # another role): tolerated so the file still counts as applied.
    _TOLERATED_ERRORS = ("permission denied", "must be owner", "must be superuser",
                         "could not open extension control file", "is not available")

    def _run_migrations_locked(self, migration_files) -> dict:
        from tools.prionvault.migrate import _split_sql
        summary = {"applied": [], "skipped": [], "errors": []}
        with self.engine.connect() as conn:
            try:
                conn.execute(text("""
                    CREATE TABLE IF NOT EXISTS _schema_migrations (
                        id SERIAL PRIMARY KEY,
                        filename TEXT UNIQUE NOT NULL,
                        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """))
                conn.commit()
                done = {r[0] for r in conn.execute(text("SELECT filename FROM _schema_migrations"))}
            except Exception as e:
                logger.error("Failed to initialize _schema_migrations: %s", e)
                summary["errors"].append({"phase": "bootstrap", "error": str(e)})
                return summary

        for migration_file in migration_files:
            filename = migration_file.name
            if filename in done:
                summary["skipped"].append({"name": filename})
                continue
            # Statement by statement, each autocommitted (CREATE INDEX
            # CONCURRENTLY can't run in a transaction), executed raw so
            # ':' / '%' in SQL are never mistaken for bind parameters.
            statements = _split_sql(migration_file.read_text(encoding="utf-8"))
            ok, tolerated, fails = 0, 0, []
            for j, stmt in enumerate(statements, 1):
                raw = None
                try:
                    raw = self.engine.raw_connection()
                    # On the DRIVER connection (the pool proxy would just
                    # store the attribute and the work would be rolled back).
                    raw.driver_connection.autocommit = True
                    cur = raw.driver_connection.cursor()
                    cur.execute(stmt)  # no params → '%' / ':' are literal
                    cur.close()
                    ok += 1
                except Exception as e:
                    msg = str(e).splitlines()[0][:300]
                    if any(t in msg.lower() for t in self._TOLERATED_ERRORS):
                        tolerated += 1
                        logger.info("Migration %s stmt %d tolerated: %s", filename, j, msg)
                    else:
                        fails.append({"stmt_index": j, "error": msg,
                                      "head": stmt.replace("\n", " ")[:120]})
                finally:
                    if raw is not None:
                        try:
                            raw.driver_connection.autocommit = False
                        except Exception:
                            pass
                        raw.close()
            entry = {"name": filename, "statements_ok": ok,
                     "statements_tolerated": tolerated, "statements_failed": fails}
            if fails:
                # Not recorded: retried on the next boot / forced run.
                logger.error("Migration failed for %s (%d statement(s)): %s",
                             filename, len(fails), fails[0]["error"])
                summary["errors"].append(entry)
                continue
            try:
                with self.engine.begin() as conn:
                    conn.execute(text(
                        "INSERT INTO _schema_migrations (filename) VALUES (:fn) "
                        "ON CONFLICT (filename) DO NOTHING"), {"fn": filename})
            except Exception as e:
                logger.error("Could not record migration %s: %s", filename, e)
            logger.info("Migration executed: %s", filename)
            summary["applied"].append(entry)
        return summary


# Global singleton — safe to import anywhere
db = DatabaseConfig()
