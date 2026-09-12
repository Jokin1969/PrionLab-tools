"""Recordatorios — one-time (not recurring) email reminders.

Distinct from PrionVault Picks (recurring digest, see email_digest.py):
one row = one send at a specific date/time, optionally attaching a JC
(Journal Club) presentation file. Sending clears the article's purple-
book `is_jc` mark as a side effect, so the same presentation stops
being nagged about once the reminder has gone out.

Entry points:
  create_reminder(...)        — save for later
  update_reminder(...)        — edit a not-yet-sent reminder
  delete_reminder(id)
  list_reminders()            — every reminder, newest scheduled first
  send_reminder(id, force=False)  — send now (used by the poller AND the
                                     admin "send now" button)
  send_pending_reminders()    — called by APScheduler every minute
"""
from __future__ import annotations

import html as _html
import logging
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

DEFAULT_MESSAGE = (
    "Hola, [Usuario]:\n\n"
    "Sirva este mensaje para recordarte que debes adjuntar la presentación "
    "del Journal Club que has realizado recientemente, al artículo "
    "[datos del artículo adjunto].\n\n"
    "Gracias y un saludo."
)


def _get_engine():
    from ..ingestion.queue import _get_engine as _e
    return _e()


def _row_to_dict(r: dict) -> dict:
    return {
        "id":           str(r["id"]),
        "created_by":   str(r["created_by"]) if r.get("created_by") else None,
        "to_email":     r["to_email"],
        "subject":      r["subject"],
        "message":      r["message"],
        "article_id":   str(r["article_id"]) if r.get("article_id") else None,
        "jc_file_id":   str(r["jc_file_id"]) if r.get("jc_file_id") else None,
        "scheduled_at": r["scheduled_at"].isoformat() if r["scheduled_at"] else None,
        "sent_at":      r["sent_at"].isoformat() if r.get("sent_at") else None,
        "error_msg":    r.get("error_msg"),
        "created_at":   r["created_at"].isoformat() if r.get("created_at") else None,
        # Denormalised for the list UI — filled in by list_reminders().
        "article_title":  r.get("article_title"),
        "jc_filename":    r.get("jc_filename"),
    }


def list_reminders() -> list[dict]:
    from sqlalchemy import text as _t
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(_t("""
            SELECT r.id, r.created_by, r.to_email, r.subject, r.message,
                   r.article_id, r.jc_file_id, r.scheduled_at, r.sent_at,
                   r.error_msg, r.created_at,
                   a.title AS article_title, jf.filename AS jc_filename
              FROM prionvault_reminder r
              LEFT JOIN articles a ON a.id = r.article_id
              LEFT JOIN prionvault_jc_file jf ON jf.id = r.jc_file_id
             ORDER BY r.sent_at IS NULL DESC, r.scheduled_at ASC
        """)).mappings().all()
    return [_row_to_dict(dict(r)) for r in rows]


def _validate(to_email: str, scheduled_at: datetime) -> datetime:
    import re
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", to_email or ""):
        raise ValueError("Dirección de email no válida.")
    if not scheduled_at:
        raise ValueError("Falta la fecha/hora del recordatorio.")
    if not scheduled_at.tzinfo:
        scheduled_at = scheduled_at.replace(tzinfo=timezone.utc)
    if scheduled_at <= datetime.now(timezone.utc):
        raise ValueError("La fecha/hora debe ser futura.")
    return scheduled_at


def create_reminder(*, to_email: str, scheduled_at: datetime,
                    subject: str = "", message: str = "",
                    article_id: Optional[str] = None,
                    jc_file_id: Optional[str] = None,
                    created_by=None) -> dict:
    from sqlalchemy import text as _t
    scheduled_at = _validate(to_email, scheduled_at)
    subject = (subject or "").strip() or "Recordatorio — PrionVault"
    message = (message or "").strip() or DEFAULT_MESSAGE

    eng = _get_engine()
    with eng.begin() as conn:
        row = conn.execute(_t("""
            INSERT INTO prionvault_reminder
              (created_by, to_email, subject, message, article_id, jc_file_id, scheduled_at)
            VALUES (:cb, :to, :subj, :msg, CAST(:aid AS uuid), CAST(:fid AS uuid), :sch)
            RETURNING id
        """), {
            "cb": str(created_by) if created_by else None,
            "to": to_email.strip(), "subj": subject, "msg": message,
            "aid": article_id, "fid": jc_file_id, "sch": scheduled_at,
        }).first()
    return {"id": str(row[0]), "scheduled_at": scheduled_at.isoformat()}


def update_reminder(reminder_id, **fields) -> Optional[dict]:
    from sqlalchemy import text as _t
    eng = _get_engine()
    with eng.connect() as conn:
        existing = conn.execute(_t(
            "SELECT sent_at FROM prionvault_reminder WHERE id = CAST(:id AS uuid)"
        ), {"id": str(reminder_id)}).first()
    if not existing:
        return None
    if existing[0] is not None:
        raise ValueError("Este recordatorio ya se ha enviado y no se puede editar.")

    sets, params = [], {"id": str(reminder_id)}
    if "to_email" in fields:
        sets.append("to_email = :to_email")
        params["to_email"] = (fields["to_email"] or "").strip()
    if "subject" in fields:
        sets.append("subject = :subject")
        params["subject"] = (fields["subject"] or "").strip()
    if "message" in fields:
        sets.append("message = :message")
        params["message"] = (fields["message"] or "").strip()
    if "article_id" in fields:
        sets.append("article_id = CAST(:article_id AS uuid)")
        params["article_id"] = fields["article_id"]
    if "jc_file_id" in fields:
        sets.append("jc_file_id = CAST(:jc_file_id AS uuid)")
        params["jc_file_id"] = fields["jc_file_id"]
    if "scheduled_at" in fields:
        sat = fields["scheduled_at"]
        if not sat.tzinfo:
            sat = sat.replace(tzinfo=timezone.utc)
        if sat <= datetime.now(timezone.utc):
            raise ValueError("La fecha/hora debe ser futura.")
        sets.append("scheduled_at = :scheduled_at")
        params["scheduled_at"] = sat
    if not sets:
        return get_reminder(reminder_id)
    sets.append("updated_at = NOW()")

    eng = _get_engine()
    with eng.begin() as conn:
        conn.execute(_t(
            f"UPDATE prionvault_reminder SET {', '.join(sets)} WHERE id = CAST(:id AS uuid)"
        ), params)
    return get_reminder(reminder_id)


def get_reminder(reminder_id) -> Optional[dict]:
    from sqlalchemy import text as _t
    eng = _get_engine()
    with eng.connect() as conn:
        row = conn.execute(_t("""
            SELECT r.id, r.created_by, r.to_email, r.subject, r.message,
                   r.article_id, r.jc_file_id, r.scheduled_at, r.sent_at,
                   r.error_msg, r.created_at,
                   a.title AS article_title, jf.filename AS jc_filename
              FROM prionvault_reminder r
              LEFT JOIN articles a ON a.id = r.article_id
              LEFT JOIN prionvault_jc_file jf ON jf.id = r.jc_file_id
             WHERE r.id = CAST(:id AS uuid)
        """), {"id": str(reminder_id)}).mappings().first()
    return _row_to_dict(dict(row)) if row else None


def delete_reminder(reminder_id) -> bool:
    from sqlalchemy import text as _t
    eng = _get_engine()
    with eng.begin() as conn:
        res = conn.execute(_t(
            "DELETE FROM prionvault_reminder WHERE id = CAST(:id AS uuid)"
        ), {"id": str(reminder_id)})
    return res.rowcount > 0


# ── Email building + sending ────────────────────────────────────────────────

def _message_to_html(message: str) -> str:
    """Plain-text message → paragraphs, preserving line breaks."""
    paras = [p.strip() for p in (message or "").split("\n\n") if p.strip()]
    if not paras:
        paras = [(message or "").strip()]
    out = []
    for p in paras:
        safe = _html.escape(p).replace("\n", "<br>")
        out.append(f'<p style="margin:0 0 12px;font-size:14px;color:#374151;line-height:1.6;">{safe}</p>')
    return "\n".join(out)


def build_reminder_html(subject: str, message: str, article: Optional[dict] = None) -> str:
    article_block = ""
    if article:
        meta = " · ".join(x for x in [article.get("journal"), str(article.get("year") or "")] if x)
        article_block = f"""
        <tr><td style="padding:0 28px 20px;">
          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;">
            <p style="margin:0 0 3px;font-size:13.5px;font-weight:700;color:#111827;">
              {_html.escape(article.get('title') or '')}
            </p>
            {f'<p style="margin:0;font-size:12px;color:#6b7280;">{_html.escape(meta)}</p>' if meta else ''}
          </div>
        </td></tr>"""

    return f"""<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>{_html.escape(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:28px 16px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
      <tr><td style="background:#0F3460;padding:22px 28px;">
        <p style="margin:0;font-size:20px;font-weight:800;color:#fff;">🔔 PrionVault</p>
        <p style="margin:6px 0 0;font-size:13.5px;color:rgba(255,255,255,0.9);">Recordatorio</p>
      </td></tr>
      <tr><td style="padding:24px 28px 4px;">
        {_message_to_html(message)}
      </td></tr>
      {article_block}
      <tr><td style="padding:4px 28px 22px;">
        <p style="margin:14px 0 0;font-size:11.5px;color:#9ca3af;">Enviado desde PrionVault.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>"""


def send_reminder(reminder_id, force: bool = False) -> dict:
    """Send one reminder now. Attaches the chosen JC file as a PDF, if
    any, and — on success — clears the target article's `is_jc` mark
    so the same presentation doesn't keep getting reminders."""
    from sqlalchemy import text as _t
    from config import smtp_configured

    r = get_reminder(reminder_id)
    if not r:
        raise LookupError("reminder_not_found")
    if r["sent_at"] and not force:
        raise ValueError("Este recordatorio ya se ha enviado.")

    article = None
    if r["article_id"]:
        eng = _get_engine()
        with eng.connect() as conn:
            row = conn.execute(_t(
                "SELECT title, journal, year FROM articles WHERE id = CAST(:id AS uuid)"
            ), {"id": r["article_id"]}).mappings().first()
        article = dict(row) if row else None

    html = build_reminder_html(r["subject"], r["message"], article)
    plain = (r["message"] or "").strip()

    attachments = []
    if r["jc_file_id"]:
        try:
            from . import jc as _jc
            pdf_bytes = _jc.get_or_convert_pdf(r["jc_file_id"])
            if pdf_bytes:
                filename = (r["jc_filename"] or "presentacion").rsplit(".", 1)[0] + ".pdf"
                attachments.append((filename, pdf_bytes, "application/pdf"))
        except Exception as exc:
            logger.warning("reminder %s: JC PDF attach failed: %s", reminder_id, exc)

    if not smtp_configured():
        raise RuntimeError("El servidor de correo no está configurado.")

    if attachments:
        from core.smtp_client import send_email_with_attachments
        ok = send_email_with_attachments(r["to_email"], r["subject"], plain, attachments, html=html)
    else:
        from core.smtp_client import send_email
        ok = send_email(to=r["to_email"], subject=r["subject"], body=plain, html=html)

    if not ok:
        eng = _get_engine()
        with eng.begin() as conn:
            conn.execute(_t(
                "UPDATE prionvault_reminder SET error_msg = :e WHERE id = CAST(:id AS uuid)"
            ), {"e": "El envío falló (revisa el servidor SMTP).", "id": reminder_id})
        raise RuntimeError("El envío del email falló (revisa el servidor SMTP).")

    eng = _get_engine()
    with eng.begin() as conn:
        conn.execute(_t(
            "UPDATE prionvault_reminder SET sent_at = NOW(), error_msg = NULL WHERE id = CAST(:id AS uuid)"
        ), {"id": reminder_id})
        if r["article_id"]:
            # Silent side effect, per spec: clears the purple-book mark
            # so this JC presentation stops showing up as "missing".
            conn.execute(_t(
                "UPDATE articles SET is_jc = FALSE, updated_at = NOW() WHERE id = CAST(:id AS uuid)"
            ), {"id": r["article_id"]})

    return {"ok": True, "attached_pdf": bool(attachments)}


def render_preview(reminder_id) -> str:
    r = get_reminder(reminder_id)
    if not r:
        raise LookupError("reminder_not_found")
    article = None
    if r["article_id"]:
        from sqlalchemy import text as _t
        eng = _get_engine()
        with eng.connect() as conn:
            row = conn.execute(_t(
                "SELECT title, journal, year FROM articles WHERE id = CAST(:id AS uuid)"
            ), {"id": r["article_id"]}).mappings().first()
        article = dict(row) if row else None
    return build_reminder_html(r["subject"], r["message"], article)


def send_pending_reminders() -> dict:
    """Called by APScheduler every minute — send every reminder whose
    scheduled_at has passed and hasn't been sent yet."""
    from sqlalchemy import text as _t
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(_t("""
            SELECT id FROM prionvault_reminder
             WHERE scheduled_at <= NOW() AND sent_at IS NULL
             ORDER BY scheduled_at ASC LIMIT 100
        """)).all()

    results = {"sent": 0, "failed": 0, "errors": []}
    for (rid,) in rows:
        try:
            send_reminder(str(rid))
            results["sent"] += 1
        except Exception as exc:
            logger.exception("reminder %s send failed", rid)
            results["failed"] += 1
            results["errors"].append({"id": str(rid), "error": str(exc)[:300]})
    if results["sent"] or results["failed"]:
        logger.info("Reminders: %d sent, %d failed", results["sent"], results["failed"])
    return results
