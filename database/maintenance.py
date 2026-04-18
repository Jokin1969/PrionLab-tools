"""
Maintenance scheduler — runs periodic database housekeeping tasks.
Uses APScheduler (already in requirements).  Safe no-op when DB
is not configured or APScheduler is not importable.
"""
import logging
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)


class MaintenanceScheduler:

    def __init__(self, app):
        self.app = app
        self._scheduler = None

    def start(self) -> bool:
        from database.config import db
        if not db.is_configured():
            logger.info("Maintenance scheduler skipped — no DATABASE_URL")
            return False
        try:
            from apscheduler.schedulers.background import BackgroundScheduler
            from apscheduler.triggers.cron import CronTrigger
            from apscheduler.triggers.interval import IntervalTrigger
            sched = BackgroundScheduler(daemon=True, timezone="UTC")
            app = self.app

            def _run(fn):
                with app.app_context():
                    fn()

            # Every hour: clean expired sessions
            sched.add_job(lambda: _run(self.cleanup_expired_sessions),
                          IntervalTrigger(hours=1), id="cleanup_sessions",
                          replace_existing=True)
            # Daily at 02:00 UTC: log cleanup + search vector refresh
            sched.add_job(lambda: _run(self.cleanup_old_logs),
                          CronTrigger(hour=2, minute=0), id="cleanup_logs",
                          replace_existing=True)
            sched.add_job(lambda: _run(self.update_search_vectors),
                          CronTrigger(hour=2, minute=30), id="search_vectors",
                          replace_existing=True)
            # Weekly Sunday 03:00 UTC: backup + vacuum
            sched.add_job(lambda: _run(self.weekly_backup),
                          CronTrigger(day_of_week="sun", hour=3), id="weekly_backup",
                          replace_existing=True)
            sched.add_job(lambda: _run(self.vacuum_analyze),
                          CronTrigger(day_of_week="sun", hour=4), id="vacuum",
                          replace_existing=True)

            sched.start()
            self._scheduler = sched
            logger.info("Maintenance scheduler started (5 jobs)")
            return True
        except Exception as e:
            logger.warning("Could not start maintenance scheduler: %s", e)
            return False

    def stop(self) -> None:
        if self._scheduler and self._scheduler.running:
            self._scheduler.shutdown(wait=False)
            logger.info("Maintenance scheduler stopped")

    # ── Scheduled tasks ───────────────────────────────────────────────────────

    def cleanup_expired_sessions(self) -> int:
        from database.config import db
        if not db.is_configured():
            return 0
        try:
            from database.models import UserSession
            with db.get_session() as s:
                expired = s.query(UserSession).filter(
                    UserSession.expires_at < datetime.utcnow(),
                    UserSession.is_active.is_(True),
                ).all()
                for sess in expired:
                    sess.is_active = False
                count = len(expired)
            if count:
                logger.info("Deactivated %d expired sessions", count)
            return count
        except Exception as e:
            logger.error("cleanup_expired_sessions: %s", e)
            return 0

    def cleanup_old_logs(self, days: int = 90) -> int:
        from database.config import db
        if not db.is_configured():
            return 0
        try:
            from database.models import SystemLog
            cutoff = datetime.utcnow() - timedelta(days=days)
            with db.get_session() as s:
                deleted = s.query(SystemLog).filter(
                    SystemLog.timestamp < cutoff
                ).delete(synchronize_session=False)
            logger.info("Deleted %d log entries older than %d days", deleted, days)
            return deleted
        except Exception as e:
            logger.error("cleanup_old_logs: %s", e)
            return 0

    def update_search_vectors(self) -> int:
        from database.config import db
        if not db.is_configured():
            return 0
        try:
            from database.models import Publication
            updated = 0
            with db.get_session() as s:
                pubs = s.query(Publication).filter(
                    Publication.search_vector.is_(None)
                ).limit(500).all()
                for p in pubs:
                    p.update_search_vector()
                    updated += 1
            if updated:
                logger.info("Updated search vectors for %d publications", updated)
            return updated
        except Exception as e:
            logger.error("update_search_vectors: %s", e)
            return 0

    def weekly_backup(self) -> dict:
        try:
            from database.backup import BackupManager
            result = BackupManager().create_backup()
            logger.info("Weekly backup: %s", result)
            return result
        except Exception as e:
            logger.error("weekly_backup: %s", e)
            return {"success": False, "error": str(e)}

    def vacuum_analyze(self) -> bool:
        try:
            from database.services import DatabaseHealthService
            return DatabaseHealthService.vacuum_analyze()
        except Exception as e:
            logger.error("vacuum_analyze: %s", e)
            return False
