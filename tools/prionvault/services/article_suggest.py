"""Email the admin when a non-admin Chrome-extension user proposes an
article for PrionVault instead of adding it directly.

Only admins can create articles via the extension (@admin_required on
/api/articles/create and /with-pdf) — everyone else gets this instead:
a single HTML email to the admin with the article's identifying info,
clickable DOI/PMID links, and a button back into PrionVault so they can
paste the DOI into the existing bulk DOI/PMID lookup and add it in one
click.
"""
from __future__ import annotations

import html as _html
import logging
from typing import Optional

logger = logging.getLogger(__name__)

SUGGESTION_RECIPIENT = "castilla@joaquincastilla.com"


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
        for a in authors[:20]:
            if isinstance(a, dict):
                names.append(((a.get("given") or "") + " " +
                              (a.get("family") or "")).strip() or a.get("name") or "")
            else:
                names.append(str(a))
        return ", ".join(n for n in names if n)
    return str(authors)


def _row(label: str, value_html: str) -> str:
    if not value_html:
        return ""
    return f"""
      <tr>
        <td style="padding:6px 12px 6px 0;font-size:11.5px;font-weight:700;color:#6b7280;
                    text-transform:uppercase;letter-spacing:0.04em;white-space:nowrap;vertical-align:top;">{label}</td>
        <td style="padding:6px 0;font-size:14px;color:#111827;line-height:1.5;">{value_html}</td>
      </tr>"""


def build_suggestion_html(*, title, authors=None, year=None, journal=None,
                           doi=None, pubmed_id=None, abstract=None,
                           page_url=None, suggester_name=None, suggester_email=None) -> str:
    base_url = _base_url()
    esc = _html.escape

    rows = []
    author_str = _fmt_authors(authors)
    if author_str:
        rows.append(_row("Autores", esc(author_str)))
    if journal or year:
        rows.append(_row("Revista", esc(" · ".join(str(x) for x in (journal, year) if x))))
    if doi:
        rows.append(_row("DOI", f'<a href="https://doi.org/{esc(doi)}" style="color:#1d4ed8;'
                                 f'text-decoration:none;">{esc(doi)}</a>'))
    if pubmed_id:
        rows.append(_row("PMID", f'<a href="https://pubmed.ncbi.nlm.nih.gov/{esc(str(pubmed_id))}/" '
                                  f'style="color:#1d4ed8;text-decoration:none;">{esc(str(pubmed_id))}</a>'))
    if page_url:
        rows.append(_row("Encontrado en", f'<a href="{esc(page_url)}" style="color:#1d4ed8;'
                                           f'text-decoration:none;word-break:break-all;">{esc(page_url)}</a>'))
    if suggester_name or suggester_email:
        who = " · ".join(x for x in (suggester_name, suggester_email) if x)
        rows.append(_row("Propuesto por", esc(who)))

    abstract_html = ""
    if abstract:
        snippet = (abstract or "").strip()
        if len(snippet) > 1200:
            snippet = snippet[:1200].rsplit(" ", 1)[0] + "…"
        abstract_html = f"""
        <div style="margin-top:18px;padding-top:16px;border-top:1px solid #f3f4f6;">
          <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;
                      letter-spacing:0.05em;margin-bottom:6px;">Abstract</div>
          <p style="margin:0;font-size:13.5px;color:#374151;line-height:1.65;">{esc(snippet)}</p>
        </div>"""

    button_html = ""
    if base_url:
        target = f"{base_url}/prionvault/"
        button_html = f"""
        <div style="margin-top:22px;text-align:center;">
          <a href="{esc(target)}" target="_blank"
             style="display:inline-block;padding:11px 26px;border-radius:8px;background:#be185d;
                    color:#fff;font-size:13.5px;font-weight:600;text-decoration:none;">
            Añadir en PrionVault →
          </a>
          <p style="margin:8px 0 0;font-size:11.5px;color:#9ca3af;">
            Pega el DOI en el buscador masivo de PrionVault (barra lateral) para añadirlo en un clic.
          </p>
        </div>"""

    return f"""<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#f3f4f6;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;
              box-shadow:0 1px 3px rgba(0,0,0,0.08);">
    <div style="background:#0F3460;padding:16px 24px;">
      <span style="color:#fff;font-size:13px;font-weight:700;letter-spacing:0.04em;">
        📚 PrionVault — Nueva sugerencia de artículo
      </span>
    </div>
    <div style="padding:22px 24px 26px;">
      <p style="margin:0 0 16px;font-size:15.5px;font-weight:700;color:#111827;line-height:1.4;">
        {esc(title)}
      </p>
      <table style="width:100%;border-collapse:collapse;">{''.join(rows)}</table>
      {abstract_html}
      {button_html}
    </div>
  </div>
  <p style="max-width:560px;margin:14px auto 0;text-align:center;font-size:11px;color:#9ca3af;">
    Enviado automáticamente desde la extensión de Chrome de PrionVault.
  </p>
</body></html>"""


def send_suggestion_email(*, title, authors=None, year=None, journal=None,
                          doi=None, pubmed_id=None, abstract=None,
                          page_url=None, suggester_name=None,
                          suggester_email: Optional[str] = None) -> bool:
    from core.smtp_client import send_email

    html = build_suggestion_html(
        title=title, authors=authors, year=year, journal=journal,
        doi=doi, pubmed_id=pubmed_id, abstract=abstract, page_url=page_url,
        suggester_name=suggester_name, suggester_email=suggester_email,
    )
    ident = doi or pubmed_id or ""
    subject = f"📚 Sugerencia para PrionVault: {title[:90]}" + ("…" if len(title) > 90 else "")
    body_plain = (
        f"Se ha propuesto un artículo para PrionVault:\n\n"
        f"{title}\n"
        + (f"DOI: {doi}\n" if doi else "")
        + (f"PMID: {pubmed_id}\n" if pubmed_id else "")
        + (f"Página: {page_url}\n" if page_url else "")
        + (f"Propuesto por: {suggester_name or ''} {suggester_email or ''}\n".strip() + "\n"
           if (suggester_name or suggester_email) else "")
    )
    try:
        return send_email(SUGGESTION_RECIPIENT, subject, body_plain, html=html)
    except Exception:
        logger.exception("send_suggestion_email failed for %r", ident)
        return False
