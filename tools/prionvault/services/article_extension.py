"""Notifications for the browser extension's reader-key "add article"
path (see routes.py: api_article_create, api_article_create_with_pdf).

A reader's identity is deliberately not tracked (see CLAUDE.md/Ayuda —
the operator chose simplicity over per-user attribution), but the
admin still gets told an article was added and how it went. Two
notification shapes:

  - metadata-only (`notify_metadata_added`): fired synchronously right
    after the immediate insert, since there's no further processing to
    wait for (no PDF means no extraction/summary steps run).
  - with-PDF: NOT this module — that path is routed through the same
    ingest queue/worker as email-ingest (see routes.py), so the
    worker's own _notify_outcome (ingestion/worker.py) sends the final
    email once the full pipeline completes, using Job.notify_anonymous.
"""
from __future__ import annotations

import html as _html
import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

_PUBLIC_BASE_URL = os.environ.get(
    "PRIONVAULT_PUBLIC_BASE_URL",
    "https://web-production-5517e.up.railway.app",
)


def _article_link(article_id) -> str:
    return f"{_PUBLIC_BASE_URL}/prionvault/?open={article_id}"


def _row(label: str, value) -> str:
    if not value:
        return ""
    return (f'<tr><td style="padding:3px 12px 3px 0;color:#6b7280;'
            f'font-size:12.5px;white-space:nowrap;vertical-align:top;">{label}</td>'
            f'<td style="padding:3px 0;color:#111827;font-size:12.5px;">'
            f'{_html.escape(str(value))}</td></tr>')


def _compose_html(meta: dict, article_id) -> str:
    meta_rows = "".join([
        _row("Título", meta.get("title")),
        _row("Autores", meta.get("authors")),
        _row("Revista", meta.get("journal")),
        _row("Año", meta.get("year")),
        _row("DOI", meta.get("doi")),
        _row("PubMed", meta.get("pubmed_id")),
    ])
    link = _article_link(article_id)
    return f"""<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>PrionVault</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:28px 16px;">
  <tr><td align="center">
    <table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
      <tr><td style="background:#0F3460;padding:22px 28px;">
        <p style="margin:0;font-size:20px;font-weight:800;color:#fff;">🔬 PrionVault</p>
        <p style="margin:6px 0 0;font-size:13.5px;color:rgba(255,255,255,0.9);">
          Un usuario ha añadido este artículo desde la extensión del navegador (solo metadatos, sin PDF).
        </p>
      </td></tr>

      <tr><td style="padding:20px 28px 4px;">
        <h2 style="margin:0 0 10px;font-size:15px;color:#111827;">📄 Artículo</h2>
        <table cellpadding="0" cellspacing="0">{meta_rows}</table>
      </td></tr>

      <tr><td style="padding:16px 28px 22px;">
        <a href="{link}" style="display:inline-block;background:#0F3460;color:#fff;font-size:13.5px;
                  font-weight:600;padding:10px 22px;border-radius:8px;text-decoration:none;">
          Ver en PrionVault →</a>
        <p style="margin:14px 0 0;font-size:11.5px;color:#9ca3af;">
          Sin PDF adjunto — si alguien lo encuentra más tarde, puede subirlo desde la ficha del artículo.
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>"""


def _compose_text(meta: dict, article_id) -> str:
    lines = [
        "Hola,",
        "",
        "Un usuario ha añadido este artículo a PrionVault desde la extensión",
        "del navegador (solo metadatos, sin PDF).",
        "",
        "DATOS DEL ARTÍCULO",
        "──────────────────",
    ]
    if meta.get("title"):
        lines.append(f"  Título    : {meta['title']}")
    if meta.get("authors"):
        lines.append(f"  Autores   : {meta['authors']}")
    if meta.get("journal"):
        lines.append(f"  Revista   : {meta['journal']}")
    if meta.get("year"):
        lines.append(f"  Año       : {meta['year']}")
    if meta.get("doi"):
        lines.append(f"  DOI       : {meta['doi']}")
    if meta.get("pubmed_id"):
        lines.append(f"  PubMed    : {meta['pubmed_id']}")
    lines += [
        "",
        f"Verlo en PrionVault: {_article_link(article_id)}",
        "",
        "— PrionVault",
    ]
    return "\n".join(lines)


def notify_metadata_added(meta: dict, article_id) -> None:
    """Best-effort: tell every admin a reader added an article (metadata
    only, no PDF) via the extension. Never raises — a notification
    failure must not affect the article creation that already
    succeeded."""
    try:
        from core.users import list_admin_emails
        admins = list_admin_emails()
        if not admins:
            return
        from core.smtp_client import send_email
        send_email(
            admins,
            f"[PrionVault] ✓ Añadido (vía extensión) — {meta.get('title') or '(sin título)'}",
            _compose_text(meta, article_id),
            html=_compose_html(meta, article_id),
        )
    except Exception:
        logger.exception("article_extension: admin notify failed")
