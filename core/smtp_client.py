import smtplib
import logging
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from config import SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, CONTACT_EMAIL

logger = logging.getLogger(__name__)

def send_email(
    to: str | list[str],
    subject: str,
    body: str,
    html: str | None = None,
) -> bool:
    if isinstance(to, str):
        to = [to]

    msg = MIMEMultipart("alternative")
    msg["From"] = CONTACT_EMAIL
    msg["To"] = ", ".join(to)
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain"))
    if html:
        msg.attach(MIMEText(html, "html"))

    try:
        if SMTP_SECURE == "ssl":
            server = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT)
        else:
            server = smtplib.SMTP(SMTP_HOST, SMTP_PORT)
            if SMTP_SECURE == "tls":
                server.starttls()

        if SMTP_USER and SMTP_PASS:
            server.login(SMTP_USER, SMTP_PASS)

        server.sendmail(CONTACT_EMAIL, to, msg.as_string())
        server.quit()
        logger.info("Email sent to %s: %s", to, subject)
        return True
    except Exception as e:
        logger.error("Failed to send email to %s: %s", to, e)
        return False


def send_email_with_attachments(
    to: str | list[str],
    subject: str,
    body: str,
    attachments: list[tuple[str, bytes, str]],
    html: str | None = None,
) -> bool:
    """Send a multipart/mixed email with file attachments.

    `attachments` is a list of (filename, content_bytes, mime_type).
    Use mime_type "application/pdf" for PDFs. The body is sent as a
    text/plain (and optional text/html) alternative inside the mixed
    message — same envelope and login flow as `send_email`.
    """
    if isinstance(to, str):
        to = [to]

    msg = MIMEMultipart("mixed")
    msg["From"] = CONTACT_EMAIL
    msg["To"] = ", ".join(to)
    msg["Subject"] = subject

    alt = MIMEMultipart("alternative")
    alt.attach(MIMEText(body, "plain"))
    if html:
        alt.attach(MIMEText(html, "html"))
    msg.attach(alt)

    for fname, content, mime in (attachments or []):
        maintype, _, subtype = mime.partition("/")
        part = MIMEApplication(content, _subtype=subtype or "octet-stream")
        part.add_header("Content-Disposition", "attachment", filename=fname)
        msg.attach(part)

    try:
        if SMTP_SECURE == "ssl":
            server = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT)
        else:
            server = smtplib.SMTP(SMTP_HOST, SMTP_PORT)
            if SMTP_SECURE == "tls":
                server.starttls()

        if SMTP_USER and SMTP_PASS:
            server.login(SMTP_USER, SMTP_PASS)

        server.sendmail(CONTACT_EMAIL, to, msg.as_string())
        server.quit()
        logger.info("Email (with %d attachments) sent to %s: %s",
                    len(attachments or []), to, subject)
        return True
    except Exception as e:
        logger.error("Failed to send email with attachments to %s: %s", to, e)
        return False
