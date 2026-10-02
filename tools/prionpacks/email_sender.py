import logging
import os
import smtplib
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

logger = logging.getLogger(__name__)

SMTP_HOST   = os.environ.get('SMTP_HOST',   '')
SMTP_PORT   = int(os.environ.get('SMTP_PORT', '587'))
SMTP_USER   = os.environ.get('SMTP_USER',   '')
SMTP_PASS   = os.environ.get('SMTP_PASS',   '')
SMTP_SSL    = os.environ.get('SMTP_SSL',    '').lower() in ('1', 'true', 'yes')
SENDER_NAME = os.environ.get('SENDER_NAME', 'Jokin')


def is_configured() -> bool:
    return bool(SMTP_HOST and SMTP_USER)


def send_review_email(
    *,
    recipient_email: str,
    recipient_name: str,
    pkg_title: str,
    docx_bytes: bytes,
    version: int,
) -> None:
    msg = MIMEMultipart()
    msg['Subject'] = f'Revisión solicitada: {pkg_title} (v{version})'
    msg['From']    = f'{SENDER_NAME} <{SMTP_USER}>'
    msg['To']      = recipient_email

    body = (
        f'Hola {recipient_name},\n\n'
        f'Te escribo para pedirte, por favor, que eches un vistazo al PrionPack '
        f'"{pkg_title}" (versión {version}), que te adjunto en formato Word.\n\n'
        f'Cualquier comentario o sugerencia será bienvenido. Muchas gracias de antemano '
        f'por tu tiempo y por tu revisión.\n\n'
        f'Un saludo,\n{SENDER_NAME}'
    )
    msg.attach(MIMEText(body, 'plain', 'utf-8'))

    attachment = MIMEApplication(docx_bytes, Name=f'PrionPack_v{version}.docx')
    attachment['Content-Disposition'] = f'attachment; filename="PrionPack_v{version}.docx"'
    msg.attach(attachment)

    if SMTP_SSL:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT) as s:
            if SMTP_PASS:
                s.login(SMTP_USER, SMTP_PASS)
            s.sendmail(SMTP_USER, recipient_email, msg.as_string())
    else:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as s:
            s.ehlo()
            s.starttls()
            s.ehlo()
            if SMTP_PASS:
                s.login(SMTP_USER, SMTP_PASS)
            s.sendmail(SMTP_USER, recipient_email, msg.as_string())

    logger.info('Review email sent to %s for package "%s" v%d', recipient_email, pkg_title, version)
