import sqlite3
import logging
from config import DB_PATH

logger = logging.getLogger(__name__)

class _ClosingConnection(sqlite3.Connection):
    """`with get_connection() as conn:` commits/rolls back AND closes
    (plain sqlite3 connections only commit, leaking a file descriptor)."""
    def __exit__(self, exc_type, exc, tb):
        try:
            return super().__exit__(exc_type, exc, tb)
        finally:
            self.close()


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, factory=_ClosingConnection)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    try:
        with get_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS app_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.commit()
        logger.info("Database initialized at %s", DB_PATH)
    except Exception:
        logger.exception("Failed to initialize database")
        raise
