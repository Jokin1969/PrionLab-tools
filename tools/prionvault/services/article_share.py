"""Share an article by email.

Builds the same HTML aesthetic as the ingest-confirmation email, but with
just the full publication data and the AI summary (no processing steps),
and sends it to a chosen recipient. Attaches the PDF when available.
"""
from __future__ import annotations

import html as _html
import logging
import re as _re
from typing import Optional

logger = logging.getLogger(__name__)


def _get_engine():
    from ..ingestion.queue import _get_engine as _e
    return _e()


def _base_url() -> str:
    try:
        from config import APP_URL
        return (APP_URL or "").rstrip("/")
    except Exception:
        return ""


def _fmt_authors(authors) -> str:
    if not authors:
        return ""
    if isinstance(authors, list):
        names = []
        for a in authors[:60]:
            if isinstance(a, dict):
                names.append(((a.get("given") or "") + " " +
                              (a.get("family") or "")).strip() or a.get("name") or "")
            else:
                names.append(str(a))
        return ", ".join(n for n in names if n)
    return str(authors)


def _summary_to_html(text: str) -> str:
    """Light Markdown → HTML: ## headings, **bold**, paragraphs. Escaped."""
    out: list[str] = []
    for block in (text or "").split("\n"):
        line = block.rstrip()
        if not line.strip():
            continue
        esc = _html.escape(line.strip())
        esc = _re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", esc)
        if line.startswith("## "):
            out.append(f'<h3 style="margin:16px 0 6px;font-size:14px;color:#0F3460;'
                       f'text-transform:uppercase;letter-spacing:0.04em;">'
                       f'{_html.escape(line[3:].strip())}</h3>')
        elif line.startswith("# "):
            out.append(f'<p style="margin:2px 0;font-weight:700;color:#111827;">'
                       f'{_html.escape(line[2:].strip())}</p>')
        else:
            out.append(f'<p style="margin:0 0 8px;font-size:13.5px;color:#374151;'
                       f'line-height:1.6;">{esc}</p>')
    return "\n".join(out)


def _fetch_article(article_id: str) -> Optional[dict]:
    from sqlalchemy import text as _t
    eng = _get_engine()
    with eng.connect() as conn:
        row = conn.execute(_t("""
            SELECT id::text AS article_id, title, authors, year, journal,
                   doi, pubmed_id, abstract, summary_ai, summary_ai_provider,
                   dropbox_path, pdf_md5
              FROM articles WHERE id = CAST(:aid AS uuid)
        """), {"aid": article_id}).mappings().first()
    return dict(row) if row else None


def build_share_html(a: dict, base_url: str, sender_name: str = "",
                     include_summary: bool = True, comment: str = "") -> str:
    link = f"{base_url}/prionvault/?open={a['article_id']}" if base_url else ""

    # Optional personal note at the top of the body.
    comment_block = ""
    if (comment or "").strip():
        safe = _html.escape(comment.strip()).replace("\n", "<br>")
        comment_block = f"""
        <tr><td style="padding:20px 28px 0;">
          <div style="background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;
                      padding:14px 16px;font-size:13.5px;color:#3730a3;line-height:1.6;">
            {safe}
          </div>
        </td></tr>"""

    def _row(label, value):
        if not value:
            return ""
        return (f'<tr><td style="padding:3px 12px 3px 0;color:#6b7280;'
                f'font-size:12.5px;white-space:nowrap;vertical-align:top;">{label}</td>'
                f'<td style="padding:3px 0;color:#111827;font-size:12.5px;">'
                f'{_html.escape(str(value))}</td></tr>')

    doi = a.get("doi")
    pmid = a.get("pubmed_id")
    meta_rows = "".join([
        _row("Título", a.get("title")),
        _row("Autores", _fmt_authors(a.get("authors"))),
        _row("Revista", a.get("journal")),
        _row("Año", a.get("year")),
        _row("DOI", doi),
        _row("PubMed", pmid),
    ])

    summary_block = ""
    if include_summary and a.get("summary_ai"):
        prov = a.get("summary_ai_provider") or ""
        prov_label = {"anthropic": "Claude", "openai": "GPT",
                      "gemini": "Gemini"}.get(prov, prov)
        summary_block = f"""
        <tr><td style="padding:20px 28px 4px;">
          <h2 style="margin:0 0 2px;font-size:15px;color:#111827;">🧠 Resumen generado por la IA</h2>
          {f'<p style="margin:0 0 10px;font-size:11px;color:#9ca3af;">Generado con {_html.escape(prov_label)}</p>' if prov_label else ''}
        </td></tr>
        <tr><td style="padding:0 28px 8px;">
          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;">
            {_summary_to_html(a["summary_ai"])}
          </div>
        </td></tr>"""

    sender_line = (f'<p style="margin:14px 0 0;font-size:11.5px;color:#9ca3af;">'
                   f'Compartido desde PrionVault{(" por " + _html.escape(sender_name)) if sender_name else ""}.</p>')
    btn = (f'<a href="{link}" style="display:inline-block;background:#0F3460;color:#fff;'
           f'font-size:13.5px;font-weight:600;padding:10px 22px;border-radius:8px;'
           f'text-decoration:none;">Ver en PrionVault →</a>' if link else "")

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
        <p style="margin:6px 0 0;font-size:13.5px;color:rgba(255,255,255,0.9);">Ficha del artículo</p>
      </td></tr>

      {comment_block}

      <tr><td style="padding:20px 28px 4px;">
        <h2 style="margin:0 0 10px;font-size:15px;color:#111827;">📄 Artículo</h2>
        <table cellpadding="0" cellspacing="0">{meta_rows}</table>
      </td></tr>

      {summary_block}

      <tr><td style="padding:16px 28px 22px;">
        {btn}
        {sender_line}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>"""


def _plain(a: dict, base_url: str, sender_name: str,
           include_summary: bool = True, comment: str = "") -> str:
    link = f"{base_url}/prionvault/?open={a['article_id']}" if base_url else ""
    lines = []
    if (comment or "").strip():
        lines += [comment.strip(), "", "─" * 20, ""]
    lines += ["Ficha del artículo — PrionVault", "", "DATOS DEL ARTÍCULO",
              "──────────────────"]
    if a.get("title"):   lines.append(f"  Título  : {a['title']}")
    au = _fmt_authors(a.get("authors"))
    if au:               lines.append(f"  Autores : {au}")
    if a.get("journal"): lines.append(f"  Revista : {a['journal']}")
    if a.get("year"):    lines.append(f"  Año     : {a['year']}")
    if a.get("doi"):     lines.append(f"  DOI     : {a['doi']}")
    if a.get("pubmed_id"): lines.append(f"  PubMed  : {a['pubmed_id']}")
    if include_summary and a.get("summary_ai"):
        lines += ["", "RESUMEN DE LA IA", "────────────────", a["summary_ai"].strip()]
    if link:
        lines += ["", f"Ver en PrionVault: {link}"]
    lines += ["", f"Compartido desde PrionVault{(' por ' + sender_name) if sender_name else ''}."]
    return "\n".join(lines)


_EMAIL_RE = _re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def render_preview(article_id: str, sender_name: str = "",
                   include_summary: bool = True, comment: str = "") -> str:
    """Return the share email HTML without sending it (for the preview)."""
    a = _fetch_article(article_id)
    if not a:
        raise LookupError("article_not_found")
    return build_share_html(a, _base_url(), sender_name, include_summary,
                            (comment or "").strip()[:2000])


def send_article_email(article_id: str, to: str,
                       sender_name: str = "",
                       include_summary: bool = True,
                       comment: str = "") -> dict:
    """Send the article's share email to `to`. Returns {ok, detail}."""
    to = (to or "").strip()
    if not _EMAIL_RE.match(to):
        raise ValueError("Dirección de email no válida.")

    a = _fetch_article(article_id)
    if not a:
        raise LookupError("article_not_found")

    comment = (comment or "").strip()[:2000]
    base = _base_url()
    html = build_share_html(a, base, sender_name, include_summary, comment)
    plain = _plain(a, base, sender_name, include_summary, comment)
    subject = f"PrionVault · {a.get('title') or 'Artículo'}"[:160]

    # Best-effort PDF attachment (same as the ingest confirmation email).
    attachments = []
    try:
        from .email_digest import _collect_pdf_attachments
        attachments, _ = _collect_pdf_attachments([a])
    except Exception as exc:
        logger.warning("article_share: PDF collect failed: %s", exc)

    from config import smtp_configured
    if not smtp_configured():
        raise RuntimeError("El servidor de correo no está configurado.")

    if attachments:
        from core.smtp_client import send_email_with_attachments
        ok = send_email_with_attachments(to, subject, plain, attachments, html=html)
    else:
        from core.smtp_client import send_email
        ok = send_email(to=to, subject=subject, body=plain, html=html)

    if not ok:
        raise RuntimeError("El envío del email falló (revisa el servidor SMTP).")
    return {
        "ok": True,
        "attached_pdf": bool(attachments),
        "has_pdf": bool(a.get("dropbox_path") or a.get("pdf_md5")),
    }
