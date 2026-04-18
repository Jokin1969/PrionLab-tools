"""
Database service layer — high-level operations over the ORM models.
Each service returns None / [] when the database is not configured,
so callers can fall back to CSV transparently.
"""
import logging
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import func, or_, text

logger = logging.getLogger(__name__)


def _db():
    from database.config import db
    return db if db.is_configured() else None


# ── User Service ───────────────────────────────────────────────────────────────

class UserService:

    @staticmethod
    def get_by_username(username: str) -> Optional[dict]:
        db = _db()
        if not db:
            return None
        try:
            from database.models import User
            with db.get_session() as s:
                u = s.query(User).filter_by(username=username.lower()).first()
                return u.to_dict(include_sensitive=True) if u else None
        except Exception as e:
            logger.error("UserService.get_by_username: %s", e)
            return None

    @staticmethod
    def get_by_email(email: str) -> Optional[dict]:
        db = _db()
        if not db:
            return None
        try:
            from database.models import User
            with db.get_session() as s:
                u = s.query(User).filter_by(email=email.lower()).first()
                return u.to_dict(include_sensitive=True) if u else None
        except Exception as e:
            logger.error("UserService.get_by_email: %s", e)
            return None

    @staticmethod
    def list_all() -> list[dict]:
        db = _db()
        if not db:
            return []
        try:
            from database.models import User
            with db.get_session() as s:
                return [u.to_dict() for u in s.query(User).order_by(User.username).all()]
        except Exception as e:
            logger.error("UserService.list_all: %s", e)
            return []

    @staticmethod
    def update(username: str, updates: dict) -> bool:
        db = _db()
        if not db:
            return False
        try:
            from database.models import User
            allowed = {"first_name", "last_name", "email", "affiliation", "position",
                       "research_areas", "orcid", "bio", "role", "language",
                       "is_active", "last_login", "lab_id", "password_hash",
                       "email_verified", "preferences"}
            with db.get_session() as s:
                u = s.query(User).filter_by(username=username.lower()).first()
                if not u:
                    return False
                for k, v in updates.items():
                    if k in allowed:
                        setattr(u, k, v)
            return True
        except Exception as e:
            logger.error("UserService.update: %s", e)
            return False

    @staticmethod
    def record_login(username: str) -> None:
        UserService.update(username, {"last_login": datetime.utcnow()})


# ── Lab Service ────────────────────────────────────────────────────────────────

class LabService:

    @staticmethod
    def get(lab_id: str) -> Optional[dict]:
        db = _db()
        if not db:
            return None
        try:
            from database.models import Lab
            with db.get_session() as s:
                lab = s.query(Lab).filter_by(id=uuid.UUID(lab_id)).first()
                return lab.to_dict() if lab else None
        except Exception as e:
            logger.error("LabService.get: %s", e)
            return None

    @staticmethod
    def get_by_code(code: str) -> Optional[dict]:
        db = _db()
        if not db:
            return None
        try:
            from database.models import Lab
            with db.get_session() as s:
                lab = s.query(Lab).filter(
                    func.upper(Lab.lab_code) == code.upper()
                ).first()
                return lab.to_dict() if lab else None
        except Exception as e:
            logger.error("LabService.get_by_code: %s", e)
            return None

    @staticmethod
    def get_members(lab_id: str) -> list[dict]:
        db = _db()
        if not db:
            return []
        try:
            from database.models import User
            with db.get_session() as s:
                members = s.query(User).filter(
                    User.lab_id == uuid.UUID(lab_id),
                    User.is_active.is_(True),
                ).all()
                return [u.to_dict() for u in members]
        except Exception as e:
            logger.error("LabService.get_members: %s", e)
            return []

    @staticmethod
    def list_all() -> list[dict]:
        db = _db()
        if not db:
            return []
        try:
            from database.models import Lab
            with db.get_session() as s:
                return [l.to_dict() for l in
                        s.query(Lab).filter_by(is_active=True).order_by(Lab.name).all()]
        except Exception as e:
            logger.error("LabService.list_all: %s", e)
            return []


# ── Publication Service ────────────────────────────────────────────────────────

class PublicationService:

    @staticmethod
    def get_all(lab_only: bool = False) -> list[dict]:
        db = _db()
        if not db:
            return []
        try:
            from database.models import Publication
            with db.get_session() as s:
                q = s.query(Publication)
                if lab_only:
                    q = q.filter_by(is_lab_publication=True)
                return [p.to_dict() for p in q.order_by(
                    Publication.year.desc(), Publication.title
                ).all()]
        except Exception as e:
            logger.error("PublicationService.get_all: %s", e)
            return []

    @staticmethod
    def search(query: str, filters: Optional[dict] = None) -> list[dict]:
        db = _db()
        if not db:
            return []
        try:
            from database.models import Publication
            with db.get_session() as s:
                q = s.query(Publication)
                if query:
                    term = f"%{query.lower()}%"
                    q = q.filter(or_(
                        Publication.search_vector.ilike(term),
                        Publication.title.ilike(term),
                        Publication.authors.ilike(term),
                        Publication.journal.ilike(term),
                    ))
                if filters:
                    if filters.get("year"):
                        q = q.filter(Publication.year == int(filters["year"]))
                    if filters.get("publication_type"):
                        q = q.filter_by(publication_type=filters["publication_type"])
                    if filters.get("lab_only"):
                        q = q.filter_by(is_lab_publication=True)
                return [p.to_dict() for p in q.order_by(
                    Publication.year.desc()
                ).limit(100).all()]
        except Exception as e:
            logger.error("PublicationService.search: %s", e)
            return []

    @staticmethod
    def analytics() -> dict:
        db = _db()
        if not db:
            return {}
        try:
            from database.models import Publication
            with db.get_session() as s:
                total = s.query(func.count(Publication.id)).scalar() or 0
                lab_pubs = s.query(func.count(Publication.id)).filter_by(
                    is_lab_publication=True).scalar() or 0
                avg_if = s.query(func.avg(Publication.impact_factor)).scalar()
                total_cites = s.query(func.sum(Publication.citation_count)).scalar() or 0
                by_year = s.query(
                    Publication.year, func.count(Publication.id)
                ).group_by(Publication.year).order_by(
                    Publication.year.desc()
                ).limit(10).all()
                by_type = s.query(
                    Publication.publication_type, func.count(Publication.id)
                ).group_by(Publication.publication_type).all()
                return {
                    "total": total,
                    "lab_publications": lab_pubs,
                    "avg_impact_factor": round(float(avg_if), 3) if avg_if else None,
                    "total_citations": int(total_cites),
                    "by_year": [{"year": y, "count": c} for y, c in by_year],
                    "by_type": [{"type": t, "count": c} for t, c in by_type],
                }
        except Exception as e:
            logger.error("PublicationService.analytics: %s", e)
            return {}


# ── Database Health Service ────────────────────────────────────────────────────

class DatabaseHealthService:

    @staticmethod
    def get_metrics() -> dict:
        db = _db()
        if not db:
            return {"configured": False}
        try:
            connected = db.test_connection()
            if not connected:
                return {"configured": True, "connected": False}
            with db.engine.connect() as conn:
                # PostgreSQL stats
                pool = db.engine.pool
                result = conn.execute(text("""
                    SELECT
                        pg_size_pretty(pg_database_size(current_database())) AS db_size,
                        (SELECT count(*) FROM pg_stat_activity
                         WHERE state = 'active') AS active_connections,
                        version() AS pg_version
                """)).fetchone()
            return {
                "configured": True,
                "connected": True,
                "db_size": result[0] if result else "?",
                "active_connections": result[1] if result else 0,
                "pg_version": (result[2] or "")[:40] if result else "?",
                "pool_size": pool.size(),
                "pool_checked_out": pool.checkedout(),
            }
        except Exception as e:
            logger.error("DatabaseHealthService.get_metrics: %s", e)
            return {"configured": True, "connected": False, "error": str(e)}

    @staticmethod
    def get_table_stats() -> list[dict]:
        db = _db()
        if not db:
            return []
        try:
            with db.engine.connect() as conn:
                rows = conn.execute(text("""
                    SELECT
                        relname AS table_name,
                        n_live_tup AS row_count,
                        pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
                        last_vacuum, last_analyze
                    FROM pg_stat_user_tables
                    ORDER BY n_live_tup DESC
                """)).fetchall()
            return [
                {
                    "table": r[0], "rows": r[1],
                    "size": r[2],
                    "last_vacuum": str(r[3])[:10] if r[3] else None,
                    "last_analyze": str(r[4])[:10] if r[4] else None,
                }
                for r in rows
            ]
        except Exception as e:
            logger.error("DatabaseHealthService.get_table_stats: %s", e)
            return []

    @staticmethod
    def vacuum_analyze(table: Optional[str] = None) -> bool:
        db = _db()
        if not db:
            return False
        try:
            target = f"VACUUM ANALYZE {table}" if table else "VACUUM ANALYZE"
            # VACUUM must run outside a transaction
            raw_conn = db.engine.raw_connection()
            raw_conn.set_isolation_level(0)  # AUTOCOMMIT
            try:
                with raw_conn.cursor() as cur:
                    cur.execute(target)
            finally:
                raw_conn.close()
            logger.info("VACUUM ANALYZE completed on %s", table or "all tables")
            return True
        except Exception as e:
            logger.error("VACUUM ANALYZE failed: %s", e)
            return False
