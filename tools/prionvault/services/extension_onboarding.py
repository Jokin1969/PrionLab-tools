"""Onboarding email for the PrionVault browser extension.

Sent from the admin panel (tools/admin/__init__.py's
api_admin_send_extension_email) to any set of users, so the admin
never has to explain the extension by hand: what it does, how to
install it, and the reader key needed to use it, all in one email —
with the .zip attached when possible, a direct download link either
way.
"""
from __future__ import annotations

import html as _html
import io
import logging
import os
import zipfile

logger = logging.getLogger(__name__)

# Mirrors the size check pattern used elsewhere for email attachments
# (email_digest.py's _PDF_ATTACH_MAX_BYTES) — the extension zip is a
# few dozen KB, this is just a sane backstop.
_MAX_ATTACH_BYTES = 5 * 1024 * 1024


def _base_url() -> str:
    try:
        from config import APP_URL
        return (APP_URL or "").rstrip("/")
    except Exception:
        return ""


def build_extension_zip() -> bytes:
    """Zips prionvault-extension/ in-memory — same contents as
    GET /prionvault/extension/download, so the download link and the
    emailed attachment are always identical."""
    ext_dir = os.path.normpath(os.path.join(
        os.path.dirname(__file__), "..", "..", "..", "prionvault-extension"))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _dirs, files in os.walk(ext_dir):
            for fname in files:
                fpath = os.path.join(root, fname)
                arcname = os.path.relpath(fpath, ext_dir)
                zf.write(fpath, arcname)
    return buf.getvalue()


def _compose_html(reader_key: str, download_url: str, help_url: str,
                  attached: bool) -> str:
    key_html = _html.escape(reader_key) if reader_key else "(pide la clave al administrador)"
    attach_note = (
        "El archivo <strong>prionvault-extension.zip</strong> va adjunto a este email."
        if attached else
        f'Descárgala directamente desde <a href="{_html.escape(download_url)}" style="color:#0F3460;">{_html.escape(download_url)}</a>.'
    )
    return f"""<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>PrionVault</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:28px 16px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
      <tr><td style="background:#0F3460;padding:26px 28px;">
        <p style="margin:0;font-size:20px;font-weight:800;color:#fff;">🔬 PrionVault</p>
        <p style="margin:6px 0 0;font-size:14px;color:rgba(255,255,255,0.92);">
          Añade artículos con un clic desde cualquier página
        </p>
      </td></tr>

      <tr><td style="padding:24px 28px 6px;">
        <p style="margin:0 0 14px;font-size:13.5px;line-height:1.6;color:#374151;">
          Hay una extensión de navegador para PrionVault. Cuando estés viendo un
          artículo científico (en PubMed, la web de una revista, etc.), abre la
          extensión y te dice al momento si ese artículo <strong>ya está en la
          biblioteca</strong> o no — y si no está, lo puedes añadir tú mismo,
          con o sin PDF, sin tener que avisar a nadie.
        </p>
      </td></tr>

      <tr><td style="padding:6px 28px 4px;">
        <h2 style="margin:0 0 10px;font-size:14px;color:#111827;">🧩 Instalación (2 minutos)</h2>
        <table cellpadding="0" cellspacing="0" width="100%">
          <tr><td style="padding:4px 10px 4px 0;font-size:15px;width:22px;vertical-align:top;">1️⃣</td>
              <td style="padding:4px 0;font-size:13px;color:#111827;">{attach_note}
                Descomprímelo en una carpeta que no vayas a borrar.</td></tr>
          <tr><td style="padding:4px 10px 4px 0;font-size:15px;width:22px;vertical-align:top;">2️⃣</td>
              <td style="padding:4px 0;font-size:13px;color:#111827;">
                En Chrome, ve a <code style="background:#f3f4f6;padding:1px 5px;border-radius:4px;">chrome://extensions</code>
                y activa <strong>"Modo de desarrollador"</strong> (arriba a la derecha).</td></tr>
          <tr><td style="padding:4px 10px 4px 0;font-size:15px;width:22px;vertical-align:top;">3️⃣</td>
              <td style="padding:4px 0;font-size:13px;color:#111827;">
                Pulsa <strong>"Cargar descomprimida"</strong> y selecciona la carpeta que descomprimiste.</td></tr>
          <tr><td style="padding:4px 10px 4px 0;font-size:15px;width:22px;vertical-align:top;">4️⃣</td>
              <td style="padding:4px 0;font-size:13px;color:#111827;">
                Haz clic en el icono de PrionVault en la barra del navegador y pega la
                <strong>URL del servidor</strong> y la <strong>clave de abajo</strong>.</td></tr>
        </table>
      </td></tr>

      <tr><td style="padding:18px 28px 4px;">
        <h2 style="margin:0 0 8px;font-size:14px;color:#111827;">🔑 Tu clave (usuario)</h2>
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;">
          <code style="font-size:13px;color:#0F3460;font-weight:700;word-break:break-all;">{key_html}</code>
        </div>
        <p style="margin:8px 0 0;font-size:11.5px;color:#9ca3af;">
          URL del servidor: <code style="background:#f9fafb;padding:1px 5px;border-radius:4px;">{_html.escape(_base_url() or '(pídesela al administrador)')}</code>
        </p>
      </td></tr>

      <tr><td style="padding:20px 28px 24px;">
        <a href="{_html.escape(help_url)}" style="display:inline-block;background:#0F3460;color:#fff;font-size:13.5px;
                  font-weight:600;padding:10px 22px;border-radius:8px;text-decoration:none;">
          Ver la guía completa en Ayuda →</a>
        <p style="margin:14px 0 0;font-size:11.5px;color:#9ca3af;">
          Cualquier duda, responde a este email.<br>— PrionVault
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>"""


def _compose_text(reader_key: str, download_url: str, help_url: str) -> str:
    return "\n".join([
        "Hola,",
        "",
        "Hay una extensión de navegador para PrionVault: cuando estés viendo",
        "un artículo científico, te dice al momento si ya está en la",
        "biblioteca, y si no, lo puedes añadir tú mismo (con o sin PDF).",
        "",
        "INSTALACIÓN",
        "───────────",
        f"1. Descarga la extensión: {download_url}",
        "   (o usa el .zip adjunto a este email, si lo incluye)",
        "2. Descomprímela en una carpeta que no vayas a borrar.",
        "3. En Chrome, ve a chrome://extensions y activa 'Modo de desarrollador'.",
        "4. Pulsa 'Cargar descomprimida' y selecciona esa carpeta.",
        "5. Haz clic en el icono de PrionVault en la barra del navegador y",
        "   pega la URL del servidor y tu clave (abajo).",
        "",
        "TU CLAVE (usuario)",
        "───────────────────",
        f"  {reader_key or '(pide la clave al administrador)'}",
        "",
        f"URL del servidor: {_base_url() or '(pídesela al administrador)'}",
        "",
        f"Guía completa: {help_url}",
        "",
        "Cualquier duda, responde a este email.",
        "",
        "— PrionVault",
    ])


def send_onboarding_email(to: str, reader_key: str) -> bool:
    """Best-effort single send. Attaches the extension zip when it's
    under the size cap; the download link is always included too, so
    the email is still useful if the attachment gets stripped by a
    mail gateway."""
    base = _base_url()
    download_url = f"{base}/prionvault/extension/download" if base else "/prionvault/extension/download"
    help_url = f"{base}/prionvault/?help=1" if base else "/prionvault/?help=1"

    attachments = []
    try:
        zip_bytes = build_extension_zip()
        if zip_bytes and len(zip_bytes) <= _MAX_ATTACH_BYTES:
            attachments.append(("prionvault-extension.zip", zip_bytes, "application/zip"))
    except Exception:
        logger.exception("extension_onboarding: zip build failed, falling back to link-only")

    html = _compose_html(reader_key, download_url, help_url, attached=bool(attachments))
    text = _compose_text(reader_key, download_url, help_url)
    subject = "🧩 Añade artículos a PrionVault desde tu navegador"

    try:
        if attachments:
            from core.smtp_client import send_email_with_attachments
            return send_email_with_attachments(to, subject, text, attachments, html=html)
        from core.smtp_client import send_email
        return send_email(to, subject, text, html=html)
    except Exception:
        logger.exception("extension_onboarding: send to %s failed", to)
        return False
