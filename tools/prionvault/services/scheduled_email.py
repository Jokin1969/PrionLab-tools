"""Scheduled email shares — send articles by email at a programmed time.

Entry points:
  schedule_article_email(article_id, to_email, scheduled_at, ...)  — save for later
  send_pending_scheduled_emails()  — called by APScheduler job, sends due emails
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)


def _get_engine():
    from ..ingestion.queue import _get_engine as _e
    return _e()


def schedule_article_email(
    article_id: str,
    to_email: str,
    scheduled_at: datetime,
    sender_name: str = "",
    include_summary: bool = True,
    comment: str = ""
) -> dict:
    """Save an article email to be sent at a specific time.

    Returns {ok: bool, scheduled_for: ISO string, message: str}
    """
    from sqlalchemy import text as _t

    # Validate inputs
    if not article_id or not to_email or not scheduled_at:
        raise ValueError("Missing required fields")

    # Ensure scheduled_at is timezone-aware and in the future
    if not scheduled_at.tzinfo:
        scheduled_at = scheduled_at.replace(tzinfo=timezone.utc)

    now = datetime.now(timezone.utc)
    if scheduled_at <= now:
        raise ValueError("scheduled_at must be in the future")

    eng = _get_engine()
    try:
        with eng.begin() as conn:
            conn.execute(_t("""
                INSERT INTO prionvault_scheduled_email
                  (article_id, to_email, sender_name, include_summary, comment, scheduled_at)
                VALUES (CAST(:aid AS uuid), :to, :sender, :inc_sum, :cmt, :sch_at)
            """), {
                "aid": article_id,
                "to": to_email,
                "sender": sender_name,
                "inc_sum": include_summary,
                "cmt": comment,
                "sch_at": scheduled_at
            })
        return {
            "ok": True,
            "scheduled_for": scheduled_at.isoformat(),
            "message": f"Email programado para {_fmt_datetime(scheduled_at)}"
        }
    except Exception as e:
        logger.exception("Failed to schedule email")
        raise


def send_pending_scheduled_emails() -> dict:
    """Check for emails whose scheduled_at has passed and send them.

    Called by APScheduler every minute. Returns {sent: int, failed: int, errors: [...]}.
    """
    from sqlalchemy import text as _t
    from . import article_share

    eng = _get_engine()

    # Fetch all emails that are due (scheduled_at <= now and not yet sent)
    with eng.connect() as conn:
        rows = conn.execute(_t("""
            SELECT id::text, article_id::text, to_email, sender_name,
                   include_summary, comment
              FROM prionvault_scheduled_email
             WHERE scheduled_at <= NOW() AND sent_at IS NULL
             ORDER BY scheduled_at ASC
             LIMIT 100
        """)).mappings().all()

    results = {"sent": 0, "failed": 0, "errors": []}

    for row in rows:
        try:
            # Send the email using the existing service
            article_share.send_article_email(
                row["article_id"],
                row["to_email"],
                sender_name=row["sender_name"],
                include_summary=row["include_summary"],
                comment=row["comment"]
            )
            # Mark as sent
            with eng.begin() as conn:
                conn.execute(_t("""
                    UPDATE prionvault_scheduled_email
                       SET sent_at = NOW()
                     WHERE id = CAST(:id AS uuid)
                """), {"id": row["id"]})
            results["sent"] += 1
        except Exception as e:
            logger.exception(f"Failed to send scheduled email {row['id']}")
            error_msg = str(e)[:500]
            try:
                with eng.begin() as conn:
                    conn.execute(_t("""
                        UPDATE prionvault_scheduled_email
                           SET error_msg = :err
                         WHERE id = CAST(:id AS uuid)
                    """), {"id": row["id"], "err": error_msg})
            except Exception:
                pass
            results["failed"] += 1
            results["errors"].append({"id": row["id"], "error": error_msg})

    if results["sent"] or results["failed"]:
        logger.info(f"Scheduled emails: {results['sent']} sent, {results['failed']} failed")

    return results


def _fmt_datetime(dt: datetime) -> str:
    """Format datetime in Spanish (e.g. '27 de julio, 15:30')."""
    if not dt:
        return ""
    try:
        import zoneinfo
        # Try to get a local timezone hint from environment
        # For now, just format in UTC
        months = ["enero", "febrero", "marzo", "abril", "mayo", "junio",
                  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
        day = dt.day
        month = months[dt.month - 1]
        hour = dt.hour
        minute = dt.minute
        return f"{day} de {month}, {hour:02d}:{minute:02d}"
    except Exception:
        return dt.isoformat()[:16]
