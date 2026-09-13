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
            pool_size=10,
            max_overflow=20,
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

        @event.listens_for(self.engine, "connect")
        def on_connect(dbapi_connection, connection_record):
            # Async commit improves write throughput; safe for this workload
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

    def run_migrations(self) -> None:
        """Execute all SQL migration files in order."""
        if not self.is_configured():
            logger.warning("Database not configured — skipping migrations")
            return

        import os
        from pathlib import Path

        migrations_dir = Path(__file__).parent.parent / "migrations"
        if not migrations_dir.exists():
            logger.warning("Migrations directory not found at %s", migrations_dir)
            return

        # Get all .sql files, sorted by filename (which includes sequential numbers)
        migration_files = sorted([f for f in migrations_dir.glob("*.sql")])
        if not migration_files:
            logger.info("No migration files found")
            return

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
            self._run_migrations_locked(migration_files)
        finally:
            try:
                lock_conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": self._MIGRATION_LOCK_KEY})
                lock_conn.commit()
            except Exception:
                pass
            lock_conn.close()

    def _run_migrations_locked(self, migration_files) -> None:
        # Ensure tracking table exists
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
            except Exception as e:
                # Table might already exist, try to continue
                try:
                    conn.execute(text("SELECT 1 FROM _schema_migrations LIMIT 1"))
                    conn.commit()
                    logger.info("_schema_migrations table already exists")
                except Exception as e2:
                    logger.error("Failed to initialize _schema_migrations: %s", e2)
                    return

        # Run each migration that hasn't been executed yet
        for migration_file in migration_files:
            filename = migration_file.name
            with self.engine.connect() as conn:
                try:
                    # Check if this migration has already been run
                    result = conn.execute(text(
                        "SELECT 1 FROM _schema_migrations WHERE filename = :fn"
                    ), {"fn": filename})
                    if result.fetchone():
                        logger.debug("Migration already executed: %s", filename)
                        continue
                except Exception:
                    # Table might not be accessible, skip check
                    pass

                # Read and execute the migration
                try:
                    with open(migration_file, 'r') as f:
                        sql_content = f.read()

                    # Execute migration (might contain multiple statements)
                    conn.execute(text(sql_content))

                    # Record it
                    try:
                        conn.execute(text(
                            "INSERT INTO _schema_migrations (filename) VALUES (:fn)"
                        ), {"fn": filename})
                    except Exception:
                        # Already recorded, continue
                        pass

                    conn.commit()
                    logger.info("Migration executed: %s", filename)
                except Exception as e:
                    conn.rollback()
                    logger.error("Migration failed for %s: %s", filename, e)


# Global singleton — safe to import anywhere
db = DatabaseConfig()
