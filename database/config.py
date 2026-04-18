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


# Global singleton — safe to import anywhere
db = DatabaseConfig()
