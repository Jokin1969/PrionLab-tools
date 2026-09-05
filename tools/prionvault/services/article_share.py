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

    def _row(label, value, html_value=None):
        if not value and not html_value:
            return ""
        cell = html_value if html_value is not None else _html.escape(str(value))
        return (f'<tr><td style="padding:3px 12px 3px 0;color:#6b7280;'
                f'font-size:12.5px;white-space:nowrap;vertical-align:top;">{label}</td>'
                f'<td style="padding:3px 0;color:#111827;font-size:12.5px;">{cell}</td></tr>')

    doi = (a.get("doi") or "").strip()
    pmid = (a.get("pubmed_id") or "").strip()
    doi_link = ""
    if doi:
        url = doi if doi.startswith("http") else f"https://doi.org/{doi}"
        doi_link = (f'<a href="{_html.escape(url)}" style="color:#0F3460;text-decoration:none;">'
                    f'{_html.escape(doi)} ↗</a>')
    pmid_link = ""
    if pmid:
        pmid_link = (f'<a href="https://pubmed.ncbi.nlm.nih.gov/{_html.escape(pmid)}/" '
                     f'style="color:#0F3460;text-decoration:none;">PMID {_html.escape(pmid)} ↗</a>')

    meta_rows = "".join([
        _row("Título", a.get("title")),
        _row("Autores", _fmt_authors(a.get("authors"))),
        _row("Revista", a.get("journal")),
        _row("Año", a.get("year")),
        _row("DOI", doi, html_value=doi_link if doi else None),
        _row("PubMed", pmid, html_value=pmid_link if pmid else None),
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


def build_share_list_html(articles: list, base_url: str, sender_name: str = "",
                          comment: str = "") -> str:
    """Same visual family as build_share_html, but a compact list of
    several articles instead of one full ficha — used when the cart's
    email action is sent with more than one article selected. Each row
    links straight to the article in PrionVault plus its DOI/PMID, same
    as the single-article version, but no PDF is ever attached here."""
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

    def _article_row(a: dict) -> str:
        link = f"{base_url}/prionvault/?open={a['article_id']}" if base_url else ""
        title_html = (f'<a href="{_html.escape(link)}" style="color:#111827;text-decoration:none;">'
                      f'{_html.escape(a.get("title") or "(sin título)")}</a>'
                      if link else _html.escape(a.get("title") or "(sin título)"))
        meta = " · ".join(x for x in [
            _fmt_authors(a.get("authors")), a.get("journal"),
            str(a.get("year")) if a.get("year") else "",
        ] if x)
        doi = (a.get("doi") or "").strip()
        pmid = (a.get("pubmed_id") or "").strip()
        links = []
        if doi:
            url = doi if doi.startswith("http") else f"https://doi.org/{doi}"
            links.append(f'<a href="{_html.escape(url)}" style="color:#0F3460;'
                        f'text-decoration:none;">DOI ↗</a>')
        if pmid:
            links.append(f'<a href="https://pubmed.ncbi.nlm.nih.gov/{_html.escape(pmid)}/" '
                        f'style="color:#0F3460;text-decoration:none;">PubMed ↗</a>')
        if link:
            links.append(f'<a href="{_html.escape(link)}" style="color:#0F3460;'
                        f'text-decoration:none;">Ver en PrionVault ↗</a>')
        links_html = " &nbsp;·&nbsp; ".join(links)
        return f"""
        <tr><td style="padding:12px 0;border-bottom:1px solid #f3f4f6;">
          <p style="margin:0 0 3px;font-size:13.5px;font-weight:600;">{title_html}</p>
          {f'<p style="margin:0 0 4px;font-size:12px;color:#6b7280;">{_html.escape(meta)}</p>' if meta else ''}
          {f'<p style="margin:0;font-size:11.5px;">{links_html}</p>' if links_html else ''}
        </td></tr>"""

    rows_html = "".join(_article_row(a) for a in articles)
    sender_line = (f'<p style="margin:14px 0 0;font-size:11.5px;color:#9ca3af;">'
                   f'Compartido desde PrionVault{(" por " + _html.escape(sender_name)) if sender_name else ""}.</p>')

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
          {len(articles)} artículo{'s' if len(articles) != 1 else ''} seleccionados
        </p>
      </td></tr>

      {comment_block}

      <tr><td style="padding:20px 28px 4px;">
        <table width="100%" cellpadding="0" cellspacing="0">{rows_html}</table>
      </td></tr>

      <tr><td style="padding:16px 28px 22px;">
        {sender_line}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>"""


def _plain_list(articles: list, base_url: str, sender_name: str, comment: str = "") -> str:
    lines = []
    if (comment or "").strip():
        lines += [comment.strip(), "", "─" * 20, ""]
    lines += [f"{len(articles)} artículo(s) seleccionados — PrionVault", ""]
    for a in articles:
        lines.append(f"• {a.get('title') or '(sin título)'}")
        meta = " · ".join(x for x in [
            _fmt_authors(a.get("authors")), a.get("journal"),
            str(a.get("year")) if a.get("year") else "",
        ] if x)
        if meta:
            lines.append(f"  {meta}")
        if a.get("doi"):
            lines.append(f"  DOI: {a['doi']}")
        if a.get("pubmed_id"):
            lines.append(f"  PubMed: {a['pubmed_id']}")
        if base_url:
            lines.append(f"  {base_url}/prionvault/?open={a['article_id']}")
        lines.append("")
    lines.append(f"Compartido desde PrionVault{(' por ' + sender_name) if sender_name else ''}.")
    return "\n".join(lines)


def send_article_list_email(article_ids: list, to: str,
                            sender_name: str = "", comment: str = "") -> dict:
    """Send a compact HTML list of several articles to `to`. No PDF is
    ever attached — that's reserved for the single-article send."""
    to = (to or "").strip()
    if not _EMAIL_RE.match(to):
        raise ValueError("Dirección de email no válida.")
    if not article_ids:
        raise ValueError("No hay artículos seleccionados.")

    articles = [a for a in (_fetch_article(aid) for aid in article_ids) if a]
    if not articles:
        raise LookupError("articles_not_found")

    comment = (comment or "").strip()[:2000]
    base = _base_url()
    html = build_share_list_html(articles, base, sender_name, comment)
    plain = _plain_list(articles, base, sender_name, comment)
    subject = f"PrionVault · {len(articles)} artículos seleccionados"[:160]

    from config import smtp_configured
    if not smtp_configured():
        raise RuntimeError("El servidor de correo no está configurado.")

    from core.smtp_client import send_email
    ok = send_email(to=to, subject=subject, body=plain, html=html)
    if not ok:
        raise RuntimeError("El envío del email falló (revisa el servidor SMTP).")
    return {"ok": True, "count": len(articles)}


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


# ── Journal Club inclusion request ──────────────────────────────────────────
# The "JC" button on an article not yet marked is_jc offers a choice: add a
# presentation directly, or ask the JC-responsible(s) to consider it. This
# builds that request — same polished article-details-+-PDF email as
# send_article_email, addressed to whoever is flagged responsible
# (core.users.list_jc_responsible), CC'd to every admin.

def send_jc_request_email(article_id: str, requester_name: str = "") -> dict:
    """Emails every JC-responsible user asking them to consider this
    article for Journal Club, CC'ing every admin. Raises if there's no
    responsible configured, the article doesn't exist, or SMTP isn't
    set up."""
    from core.users import list_jc_responsible, list_admin_emails

    responsibles = list_jc_responsible()
    if not responsibles:
        raise LookupError("no_jc_responsible")

    a = _fetch_article(article_id)
    if not a:
        raise LookupError("article_not_found")

    from config import smtp_configured
    if not smtp_configured():
        raise RuntimeError("El servidor de correo no está configurado.")

    base = _base_url()
    admins = list_admin_emails()
    requester = (requester_name or "").strip()

    # Best-effort PDF attachment, built once and reused for every send.
    attachments = []
    try:
        from .email_digest import _collect_pdf_attachments
        attachments, _ = _collect_pdf_attachments([a])
    except Exception as exc:
        logger.warning("article_share: PDF collect failed for JC request: %s", exc)

    subject = f"Journal Club · ¿Incluimos este artículo? — {a.get('title') or ''}"[:160]
    sent, failed = [], []
    for u in responsibles:
        to = (u.get("email") or "").strip()
        if not to:
            continue
        name = (u.get("full_name") or u.get("username") or "").strip()
        greeting = f"Hola {name}," if name else "Hola,"
        by = f" {requester}" if requester else " un compañero/a"
        comment = (
            f"{greeting}\n\n"
            f"Te escribo (envío automático desde PrionVault, solicitado por{by}) "
            f"para pedirte que valores incluir este artículo como futura sesión "
            f"de Journal Club. Tienes todos los datos y el PDF (si está "
            f"disponible) más abajo."
        )
        html = build_share_html(a, base, "", True, comment)
        plain = _plain(a, base, "", True, comment)
        try:
            if attachments:
                from core.smtp_client import send_email_with_attachments
                ok = send_email_with_attachments(to, subject, plain, attachments,
                                                 html=html, cc=admins)
            else:
                from core.smtp_client import send_email
                ok = send_email(to, subject, plain, html=html, cc=admins)
        except Exception:
            logger.exception("article_share: JC request send to %s failed", to)
            ok = False
        (sent if ok else failed).append(to)

    return {"ok": bool(sent), "sent": sent, "failed": failed,
            "attached_pdf": bool(attachments)}


# ── Journal Club convocation (lab-wide announcement) ────────────────────────
# Once an article is marked is_jc and the responsible has picked a date, this
# sends the actual "come to Journal Club" announcement to every active user
# — distinct from send_jc_request_email above, which only asks the
# responsible to CONSIDER an article, before any date is set.

def send_jc_convocation_email(article_id: str, *, when_text: str,
                              location_text: str = "", notes: str = "",
                              requester_name: str = "") -> dict:
    """Emails every active user announcing a Journal Club session for
    this article. `when_text` (date/time, free text so the responsible
    can phrase it however — "Jueves 14 de agosto, 12:00") is required;
    location and extra notes are optional. Sent To: the sender, Bcc:
    everyone else, so recipients don't see the full lab's email list.

    Raises ValueError if when_text is blank, LookupError if the article
    doesn't exist or there are no active users, RuntimeError if SMTP
    isn't configured or the send itself fails."""
    when_text = (when_text or "").strip()
    if not when_text:
        raise ValueError("Falta indicar cuándo es la sesión.")

    from core.users import list_active_users

    a = _fetch_article(article_id)
    if not a:
        raise LookupError("article_not_found")

    recipients = [u["email"].strip() for u in list_active_users() if u.get("email")]
    if not recipients:
        raise LookupError("no_active_users")

    from config import smtp_configured
    if not smtp_configured():
        raise RuntimeError("El servidor de correo no está configurado.")

    base = _base_url()

    comment = (
        f"Convocatoria de Journal Club{(' — la propone ' + requester_name) if requester_name else ''}."
        f"\n\n📅 Cuándo: {when_text}"
        + (f"\n📍 Dónde: {location_text.strip()}" if location_text.strip() else "")
        + (f"\n\n{notes.strip()}" if notes.strip() else "")
    )
    html = build_share_html(a, base, "", True, comment)
    plain = _plain(a, base, requester_name, True, comment)

    # Best-effort PDF attachment.
    attachments = []
    try:
        from .email_digest import _collect_pdf_attachments
        attachments, _ = _collect_pdf_attachments([a])
    except Exception as exc:
        logger.warning("article_share: PDF collect failed for JC convocation: %s", exc)

    subject = f"Journal Club — {when_text[:60]} — {a.get('title') or ''}"[:160]
    sender = recipients[0]
    bcc = recipients[1:] if len(recipients) > 1 else []
    try:
        if attachments:
            from core.smtp_client import send_email_with_attachments
            ok = send_email_with_attachments(sender, subject, plain, attachments,
                                             html=html, bcc=bcc)
        else:
            from core.smtp_client import send_email
            ok = send_email(sender, subject, plain, html=html, bcc=bcc)
    except Exception as exc:
        logger.exception("article_share: JC convocation send failed")
        raise RuntimeError(f"El envío del email falló: {exc}") from exc
    if not ok:
        raise RuntimeError("El envío del email falló (revisa el servidor SMTP).")

    return {"ok": True, "recipients": len(recipients), "attached_pdf": bool(attachments)}
