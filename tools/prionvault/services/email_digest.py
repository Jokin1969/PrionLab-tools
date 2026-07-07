"""Weekly (or biweekly / monthly) PrionVault email digest.

Fetches articles from `prionvault_pubmed_inventory` that appeared since
`last_sent_at` and are not yet imported into PrionVault, then formats a
beautiful HTML email and sends it via core.smtp_client.

Entry points
------------
send_digest_for_user(sub_id)  — send one subscription now (called by scheduler)
run_pending_digests()         — called every 15 min by APScheduler; fires any
                                subscription whose `next_send_at` has passed
compute_next_send(sub)        — pure helper: returns the next UTC datetime
                                given frequency / day_of_week / hour / minute /
                                timezone for a subscription dict
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# ── Topic display names ──────────────────────────────────────────────────────
TOPIC_LABELS: dict[str, str] = {
    "prion":      "Prion",
    "prion_like": "Prion-like",
    "aav":        "AAV / Gene therapy",
}

DAY_NAMES = ["Lunes", "Martes", "Miércoles", "Jueves",
             "Viernes", "Sábado", "Domingo"]

FREQ_LABELS = {
    "weekly":   "Semanal",
    "biweekly": "Quincenal",
    "monthly":  "Mensual",
}


# ── Next-send computation ────────────────────────────────────────────────────

def _next_occurrence_in_days(days: list[int], hour: int, minute: int,
                              now_local: "datetime") -> "datetime":
    """Return the nearest future local datetime matching one of `days` (0=Mon…6=Sun)."""
    base = now_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    best = None
    for dow in days:
        ahead = (dow - base.weekday()) % 7
        if ahead == 0 and base <= now_local:
            ahead = 7
        cand = base + timedelta(days=ahead)
        if best is None or cand < best:
            best = cand
    return best  # type: ignore[return-value]


def compute_next_send(sub: dict, after: "Optional[datetime]" = None) -> "datetime":
    """Return the next UTC datetime when sub should fire.

    `sub` keys used: days_of_week (list[int], 0=Mon…6=Sun; falls back to
    legacy day_of_week int), send_hour, send_minute, frequency,
    user_timezone, last_sent_at (optional ISO string).
    `after` defaults to now(UTC).
    """
    try:
        import zoneinfo
        tz = zoneinfo.ZoneInfo(sub.get("user_timezone") or "UTC")
    except Exception:
        from datetime import timezone as _tz
        tz = _tz.utc

    now_utc = after or datetime.now(timezone.utc)
    now_local = now_utc.astimezone(tz)

    freq   = sub.get("frequency", "weekly")
    hour   = int(sub.get("send_hour",   15))
    minute = int(sub.get("send_minute",  0))

    # Resolve days list — support both new array and legacy scalar field.
    raw_days = sub.get("days_of_week")
    if raw_days:
        days = [int(d) for d in raw_days]
    else:
        days = [int(sub.get("day_of_week", 4))]
    if not days:
        days = [4]  # Friday fallback

    candidate = _next_occurrence_in_days(days, hour, minute, now_local)

    if freq == "biweekly":
        last = sub.get("last_sent_at")
        if last:
            try:
                last_dt = datetime.fromisoformat(last).astimezone(tz)
                after_two = last_dt + timedelta(weeks=2)
                # Find nearest matching day on or after the two-week mark.
                biweekly_cand = _next_occurrence_in_days(
                    days, hour, minute,
                    after_two.replace(hour=hour, minute=minute,
                                      second=0, microsecond=0) - timedelta(seconds=1))
                if biweekly_cand > now_local:
                    candidate = biweekly_cand
            except Exception:
                pass

    elif freq == "monthly":
        last = sub.get("last_sent_at")
        if last:
            try:
                last_dt = datetime.fromisoformat(last).astimezone(tz)
                after_month = last_dt + timedelta(days=28)
                monthly_cand = _next_occurrence_in_days(
                    days, hour, minute,
                    after_month.replace(hour=hour, minute=minute,
                                        second=0, microsecond=0) - timedelta(seconds=1))
                if monthly_cand > now_local:
                    candidate = monthly_cand
            except Exception:
                pass

    return candidate.astimezone(timezone.utc)


# ── Article fetching ─────────────────────────────────────────────────────────

def _fetch_flagged_articles(user_id: str, n: int) -> list[dict]:
    """Return up to N random articles flagged by user_id (PrionVault Picks)."""
    from ..ingestion.queue import _get_engine
    from sqlalchemy import text as _t
    try:
        eng = _get_engine()
        with eng.connect() as conn:
            rows = conn.execute(_t("""
                SELECT
                    a.id::text  AS article_id,
                    a.title,
                    a.doi,
                    a.year,
                    a.journal,
                    a.pubmed_id AS pmid,
                    a.authors,
                    a.dropbox_path,
                    a.pdf_md5
                FROM prionvault_user_state us
                JOIN articles a ON a.id = us.article_id
                WHERE us.user_id = :uid
                  AND us.is_flagged = TRUE
                ORDER BY RANDOM()
                LIMIT :n
            """), {"uid": user_id, "n": n}).mappings().all()
        return [dict(r) for r in rows]
    except Exception as exc:
        logger.error("email_digest: fetch_flagged failed: %s", exc)
        return []


def _unflag_articles(eng, user_id: str, article_ids: list[str]) -> None:
    """Clear is_flagged for the given articles for this user."""
    if not article_ids:
        return
    from sqlalchemy import text as _t
    placeholders = ", ".join(f":aid{i}" for i in range(len(article_ids)))
    params = {f"aid{i}": aid for i, aid in enumerate(article_ids)}
    params["uid"] = user_id
    try:
        with eng.begin() as conn:
            conn.execute(_t(f"""
                UPDATE prionvault_user_state
                   SET is_flagged = FALSE, updated_at = NOW()
                 WHERE user_id = :uid
                   AND article_id::text IN ({placeholders})
            """), params)
    except Exception as exc:
        logger.error("email_digest: unflag failed: %s", exc)


def _fetch_new_articles(topics: list[str], since: datetime,
                        oa_only: bool) -> list[dict]:
    """Return inventory rows for the given topics seen after `since` that
    haven't been imported yet, ordered newest-first."""
    from ..ingestion.queue import _get_engine
    from sqlalchemy import text as _t

    if not topics:
        return []

    # Build placeholders for the IN clause
    placeholders = ", ".join(f":t{i}" for i in range(len(topics)))
    params: dict = {f"t{i}": t for i, t in enumerate(topics)}
    params["since"] = since

    oa_having = "HAVING BOOL_OR(i.oa_verified) = TRUE" if oa_only else ""

    sql = f"""
        SELECT
            i.pmid,
            i.title,
            i.authors,
            i.journal,
            i.year,
            i.doi,
            BOOL_OR(i.oa_verified)           AS oa_verified,
            array_agg(DISTINCT i.query_name) AS presets,
            MIN(i.discovered_at)             AS first_seen_at
        FROM prionvault_pubmed_inventory i
        WHERE i.query_name IN ({placeholders})
          AND i.discovered_at >= :since
          AND i.imported_at IS NULL
        GROUP BY i.pmid, i.title, i.authors, i.journal, i.year, i.doi
        {oa_having}
        ORDER BY i.year DESC NULLS LAST, MIN(i.discovered_at) DESC
        LIMIT 200
    """
    try:
        eng = _get_engine()
        with eng.connect() as conn:
            rows = conn.execute(_t(sql), params).mappings().all()
        return [dict(r) for r in rows]
    except Exception as exc:
        logger.error("email_digest: fetch failed: %s", exc)
        return []


# ── HTML email builder ────────────────────────────────────────────────────────

def _oa_badge(is_oa: bool | None) -> str:
    if is_oa:
        return ('<span style="display:inline-block;background:#d1fae5;color:#065f46;'
                'font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px;'
                'letter-spacing:0.04em;vertical-align:middle;">🔓 Open Access</span>')
    return ('<span style="display:inline-block;background:#f3f4f6;color:#6b7280;'
            'font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px;'
            'letter-spacing:0.04em;vertical-align:middle;">🔒 Restringido</span>')


def _format_authors_short(authors: str) -> str:
    if not authors:
        return ""
    auth_list = [x.strip() for x in authors.split(",") if x.strip()]
    if len(auth_list) > 3:
        return ", ".join(auth_list[:3]) + " et al."
    return ", ".join(auth_list)


def _article_card(a: dict, import_base_url: str) -> str:
    """Card for PubMed digest — articles NOT yet in the library."""
    title   = a.get("title") or "Sin título"
    authors = _format_authors_short(a.get("authors") or "")
    journal = a.get("journal") or ""
    year    = a.get("year") or ""
    pmid    = a.get("pmid") or ""
    doi     = a.get("doi") or ""
    is_oa   = a.get("oa_verified")
    presets_raw = a.get("presets") or [a.get("preset", "prion")]
    if isinstance(presets_raw, str):
        presets_raw = [presets_raw]

    doi_url  = f"https://doi.org/{doi}" if doi else ""
    pmid_url = f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/" if pmid else ""
    import_url = f"{import_base_url}?pmid={pmid}" if pmid else ""

    doi_link = (f'<a href="{doi_url}" style="color:#0F3460;text-decoration:none;'
                f'font-size:11.5px;">DOI ↗</a>' if doi_url else "")
    pmid_link = (f'<a href="{pmid_url}" style="color:#6b7280;text-decoration:none;'
                 f'font-size:11.5px;">PubMed ↗</a>' if pmid_url else "")
    import_btn = ""
    if import_url:
        import_btn = (
            f'<a href="{import_url}" '
            f'style="display:inline-block;background:#0F3460;color:#fff;'
            f'font-size:11.5px;font-weight:600;padding:5px 14px;border-radius:6px;'
            f'text-decoration:none;letter-spacing:0.02em;">⬇ Importar a PrionVault</a>'
        )

    topic_chips = " ".join(
        f'<span style="display:inline-block;background:#eff6ff;color:#1e40af;'
        f'font-size:10px;font-weight:600;padding:2px 7px;border-radius:20px;'
        f'letter-spacing:0.04em;vertical-align:middle;">{TOPIC_LABELS.get(p, p)}</span>'
        for p in presets_raw
    )

    return f"""
<tr>
  <td style="padding:0 0 16px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;
                  overflow:hidden;">
      <tr>
        <td style="padding:16px 18px 12px;">
          <p style="margin:0 0 6px;font-size:14.5px;font-weight:700;
                    color:#111827;line-height:1.4;">{title}</p>
          <p style="margin:0 0 8px;font-size:12px;color:#6b7280;line-height:1.5;">
            {authors}{"<br>" if authors and (journal or year) else ""}
            <em>{journal}</em>{(", " + str(year)) if journal and year else str(year)}
          </p>
          <p style="margin:0 0 12px;">{_oa_badge(is_oa)}&nbsp;{topic_chips}</p>
          <table cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="padding-right:14px;">{doi_link}</td>
            <td style="padding-right:14px;">{pmid_link}</td>
            <td>{import_btn}</td>
          </tr></table>
        </td>
      </tr>
    </table>
  </td>
</tr>"""


def _picks_article_card(a: dict, server_base_url: str, has_pdf: bool) -> str:
    """Card for PrionVault Picks — articles already IN the library."""
    title      = a.get("title") or "Sin título"
    authors    = _format_authors_short(a.get("authors") or "")
    journal    = a.get("journal") or ""
    year       = a.get("year") or ""
    pmid       = a.get("pmid") or ""
    doi        = a.get("doi") or ""
    article_id = a.get("article_id") or ""
    # The article has a PDF in the library if it has EITHER a Dropbox path
    # or an md5 — older rows may have only one of the two.
    has_pdf_in_db = bool(a.get("pdf_md5") or a.get("dropbox_path"))

    doi_url  = f"https://doi.org/{doi}" if doi else ""
    pmid_url = f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/" if pmid else ""
    view_url = (f"{server_base_url}/prionvault/?open={article_id}"
                if server_base_url and article_id else "")
    pdf_url  = (f"{server_base_url}/prionvault/api/articles/{article_id}/pdf-view"
                if server_base_url and article_id and has_pdf_in_db else "")

    doi_link = (f'<a href="{doi_url}" style="color:#0F3460;text-decoration:none;'
                f'font-size:11.5px;">DOI ↗</a>' if doi_url else "")
    pmid_link = (f'<a href="{pmid_url}" style="color:#6b7280;text-decoration:none;'
                 f'font-size:11.5px;">PubMed ↗</a>' if pmid_url else "")
    view_btn = ""
    if view_url:
        view_btn = (
            f'<a href="{view_url}" '
            f'style="display:inline-block;background:#0F3460;color:#fff;'
            f'font-size:11.5px;font-weight:600;padding:5px 14px;border-radius:6px;'
            f'text-decoration:none;letter-spacing:0.02em;">Ver en PrionVault →</a>'
        )

    if has_pdf:
        pdf_note = (
            '<p style="margin:8px 0 0;font-size:11px;color:#065f46;'
            'background:#d1fae5;padding:4px 8px;border-radius:4px;display:inline-block;">'
            '📎 PDF adjunto en este email</p>'
        )
    elif has_pdf_in_db and pdf_url:
        pdf_note = (
            f'<p style="margin:8px 0 0;font-size:11px;color:#1e40af;'
            f'background:#eff6ff;padding:4px 8px;border-radius:4px;display:inline-block;">'
            f'📄 <a href="{pdf_url}" style="color:#1e40af;">Ver PDF en PrionVault →</a></p>'
        )
    else:
        pdf_note = (
            '<p style="margin:8px 0 0;font-size:11px;color:#6b7280;'
            'background:#f3f4f6;padding:4px 8px;border-radius:4px;display:inline-block;">'
            '— Sin PDF</p>'
        )

    return f"""
<tr>
  <td style="padding:0 0 16px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;
                  overflow:hidden;">
      <tr>
        <td style="padding:16px 18px 12px;">
          <p style="margin:0 0 6px;font-size:14.5px;font-weight:700;
                    color:#111827;line-height:1.4;">{title}</p>
          <p style="margin:0 0 8px;font-size:12px;color:#6b7280;line-height:1.5;">
            {authors}{"<br>" if authors and (journal or year) else ""}
            <em>{journal}</em>{(", " + str(year)) if journal and year else str(year)}
          </p>
          <table cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="padding-right:14px;">{doi_link}</td>
            <td style="padding-right:14px;">{pmid_link}</td>
            <td>{view_btn}</td>
          </tr></table>
          {pdf_note}
        </td>
      </tr>
    </table>
  </td>
</tr>"""


def build_digest_html(articles: list[dict], sub: dict,
                      import_base_url: str, period_label: str) -> str:
    """Return the full HTML email string."""
    topic_names = [TOPIC_LABELS.get(t, t) for t in (sub.get("topics") or ["prion"])]
    topics_str  = " · ".join(topic_names)
    count       = len(articles)
    freq_label  = FREQ_LABELS.get(sub.get("frequency", "weekly"), "Semanal")

    if count == 0:
        body_content = """
        <tr><td style="text-align:center;padding:40px 0;">
          <p style="font-size:15px;color:#6b7280;">
            No hay artículos nuevos en PubMed para tus temas este período.
          </p>
          <p style="font-size:13px;color:#9ca3af;">
            PrionVault te avisará en el próximo envío programado.
          </p>
        </td></tr>"""
    else:
        cards = "\n".join(_article_card(a, import_base_url) for a in articles)
        # Build bulk-import URL (PMIDs comma-separated, max 100 in URL)
        all_pmids = [str(a["pmid"]) for a in articles if a.get("pmid")]
        _base_for_bulk = import_base_url.replace("/import", "") if import_base_url != "#" else ""
        bulk_url = ""
        if _base_for_bulk and all_pmids:
            bulk_url = f"{_base_for_bulk}/prionvault/import?pmids={','.join(all_pmids[:100])}"
        import_all_btn = ""
        if bulk_url:
            import_all_btn = f"""
        <tr><td style="text-align:center;padding:8px 0 20px;">
          <a href="{bulk_url}"
             style="display:inline-block;background:#059669;color:#fff;
                    font-size:12px;font-weight:700;padding:8px 20px;border-radius:8px;
                    text-decoration:none;letter-spacing:0.02em;">
            ⬇ Importar todos los artículos a PrionVault
          </a>
        </td></tr>"""
        body_content = f"""
        <tr><td style="padding:0 0 8px;">
          <p style="margin:0;font-size:13px;color:#6b7280;">
            Se encontraron <strong style="color:#111827;">{count} artículo{"s" if count != 1 else ""} nuevo{"s" if count != 1 else ""}</strong>
            en PubMed que aún no están en tu biblioteca.
          </p>
        </td></tr>
        {cards}
        {import_all_btn}"""

    _base = import_base_url.replace("/import", "") if import_base_url != "#" else ""
    settings_url = f"{_base}/prionvault" if _base else ""

    return f"""<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PrionVault – Digest {period_label}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">

<!-- Wrapper -->
<table width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:#f3f4f6;padding:32px 16px;">
  <tr><td align="center">

    <!-- Card -->
    <table width="600" cellpadding="0" cellspacing="0" border="0"
           style="max-width:600px;width:100%;">

      <!-- Header -->
      <tr>
        <td style="background:#0F3460;border-radius:12px 12px 0 0;
                   padding:24px 28px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td>
                <p style="margin:0;font-size:22px;font-weight:800;
                          color:#ffffff;letter-spacing:-0.5px;">
                  🔬 PrionVault
                </p>
                <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.65);">
                  Digest {freq_label} · {period_label}
                </p>
              </td>
              <td align="right" valign="middle">
                <p style="margin:0;font-size:11.5px;color:rgba(255,255,255,0.5);
                          text-align:right;">
                  Temas:<br>
                  <strong style="color:rgba(255,255,255,0.85);">{topics_str}</strong>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Body -->
      <tr>
        <td style="background:#f9fafb;padding:24px 28px;
                   border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            {body_content}
          </table>
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="background:#ffffff;border:1px solid #e5e7eb;
                   border-top:none;border-radius:0 0 12px 12px;
                   padding:16px 28px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td>
                <p style="margin:0;font-size:11px;color:#9ca3af;line-height:1.6;">
                  Recibes este email porque estás suscrito al digest de PrionVault.
                  {f'<br><a href="{settings_url}" style="color:#0F3460;text-decoration:none;">Gestionar notificaciones</a>' if settings_url else ''}
                </p>
              </td>
              <td align="right">
                <p style="margin:0;font-size:11px;color:#d1d5db;">
                  PrionVault &copy; {datetime.now().year}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>

    </table>
  </td></tr>
</table>

</body>
</html>"""


def _build_picks_html(cards_html: str, sub: dict, import_base_url: str,
                      count: int) -> str:
    """Minimal HTML wrapper for PrionVault Picks emails."""
    name = sub.get("name") or "PrionVault Picks"
    base = import_base_url.replace("/import", "") if import_base_url != "#" else ""
    return f"""<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>PrionVault Picks</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0">
  <tr><td align="center" style="padding:32px 16px;">
    <table width="600" cellpadding="0" cellspacing="0"
           style="background:#fff;border-radius:12px;overflow:hidden;
                  box-shadow:0 1px 3px rgba(0,0,0,0.08);">
      <tr><td style="background:#0F3460;padding:24px 28px;">
        <p style="margin:0;font-size:20px;font-weight:700;color:#fff;">⚑ PrionVault Picks</p>
        <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.65);">
          {name} · {count} artículo{'s' if count != 1 else ''} seleccionado{'s' if count != 1 else ''}
        </p>
      </td></tr>
      {cards_html}
      <tr><td style="background:#f9fafb;padding:16px 28px;text-align:center;
                     font-size:11.5px;color:#9ca3af;">
        PrionVault Picks &copy; {datetime.now().year}
        {f' · <a href="{base}/prionvault" style="color:#0F3460;">Ir a PrionVault</a>' if base else ''}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>"""


# ── PDF attachment helper ─────────────────────────────────────────────────────

_PDF_ATTACH_MAX_BYTES = 25 * 1024 * 1024   # 25 MB per PDF — sane email attachment cap
_PDF_ATTACH_TIMEOUT  = 30                   # seconds per Dropbox download


def _collect_pdf_attachments(
        articles: list[dict]) -> tuple[list[tuple[str, bytes, str]], set]:
    """Download PDFs from Dropbox for articles that have one.

    Returns (attachments, attached_ids) where attachments is a list of
    (filename, bytes, mime_type) tuples ready for
    send_email_with_attachments, and attached_ids is the set of
    article_ids whose PDF was actually attached (so each card can be
    labelled correctly). Silently skips articles without a PDF, PDFs
    above the size cap, or when the download fails.

    Prefers the stored dropbox_path; for older rows that only have
    pdf_md5, reconstructs the canonical Dropbox path before giving up.
    """
    import re as _re
    result: list[tuple[str, bytes, str]] = []
    attached_ids: set = set()
    try:
        from core.dropbox_client import get_client
        dbx = get_client()
    except Exception as exc:
        logger.warning("email_digest: Dropbox client unavailable for Picks PDFs: %s", exc)
        dbx = None

    if not dbx:
        return result, attached_ids

    for a in articles:
        path = a.get("dropbox_path")

        # Fallback: reconstruct path from doi/year/md5 for older articles
        if not path and a.get("pdf_md5"):
            try:
                from ..ingestion.dropbox_uploader import build_path
                path = build_path(
                    doi=a.get("doi"),
                    year=a.get("year"),
                    md5=a.get("pdf_md5"),
                )
            except Exception:
                pass

        if not path:
            continue

        try:
            # NOTE: the Dropbox SDK's files_download() takes NO per-call
            # timeout kwarg (timeout is set on the client) — passing one
            # raised a TypeError that silently killed every attachment.
            meta, resp = dbx.files_download(path)
            declared = getattr(meta, "size", None)
            if declared and declared > _PDF_ATTACH_MAX_BYTES:
                logger.info(
                    "email_digest: skipping PDF attachment (%.1f MB > limit): %s",
                    declared / 1024 / 1024, path,
                )
                continue
            content = resp.content
            if len(content) > _PDF_ATTACH_MAX_BYTES:
                logger.info(
                    "email_digest: skipping PDF attachment after download (%.1f MB): %s",
                    len(content) / 1024 / 1024, path,
                )
                continue
            raw_name = path.rsplit("/", 1)[-1] or "article.pdf"
            safe_name = _re.sub(r'[^\w.\-]', '_', raw_name)
            result.append((safe_name, content, "application/pdf"))
            if a.get("article_id"):
                attached_ids.add(str(a["article_id"]))
        except Exception as exc:
            logger.warning("email_digest: PDF download failed for %s: %s", path, exc)

    return result, attached_ids


# ── Send one subscription ─────────────────────────────────────────────────────

def send_digest_for_sub(sub_id: str, *, force: bool = False) -> bool:
    """Load subscription, fetch articles, send email, update last_sent_at.
    Returns True on success. `force=True` skips the next_send_at check."""
    from ..ingestion.queue import _get_engine
    from sqlalchemy import text as _t
    from config import smtp_configured

    if not smtp_configured():
        logger.warning("email_digest: SMTP not configured, skipping %s", sub_id)
        return False

    eng = _get_engine()
    with eng.connect() as conn:
        row = conn.execute(_t(
            "SELECT * FROM prionvault_notification_subscriptions WHERE id = :id"
        ), {"id": sub_id}).mappings().first()
    if not row:
        logger.warning("email_digest: subscription %s not found", sub_id)
        return False

    sub = dict(row)
    if not sub.get("enabled") and not force:
        return False

    try:
        from config import APP_URL
        base = (APP_URL or "").rstrip("/")
    except ImportError:
        base = ""
    # Relative URLs are meaningless in email clients; fall back to a safe
    # placeholder so links render as text rather than "[/prionvault]foo".
    import_base_url = f"{base}/prionvault/import" if base else "#"

    source = sub.get("source") or "pubmed"
    now_utc = datetime.now(timezone.utc)

    if source == "flagged":
        # ── PrionVault Picks ─────────────────────────────────────────────
        n        = max(1, int(sub.get("articles_per_email") or 5))
        articles = _fetch_flagged_articles(str(sub["user_id"]), n)
        count    = len(articles)

        # Collect PDF attachments first so we can tell each card if it has one.
        # Only skip when the subscription EXPLICITLY disabled PDFs; a missing
        # or NULL value defaults to attaching.
        attachments: list[tuple[str, bytes, str]] = []
        attached_ids: set = set()
        if count and sub.get("include_pdfs") is not False:
            attachments, attached_ids = _collect_pdf_attachments(articles)

        if count == 0:
            picks_cards = """
            <tr><td style="text-align:center;padding:40px 20px;">
              <p style="font-size:15px;color:#6b7280;margin:0 0 8px;">
                No hay artículos marcados en tu biblioteca.
              </p>
              <p style="font-size:13px;color:#9ca3af;margin:0;">
                Marca artículos con ⚑ en PrionVault para recibirlos aquí.
              </p>
            </td></tr>"""
        else:
            picks_cards = "\n".join(
                _picks_article_card(
                    a,
                    server_base_url=base,
                    has_pdf=str(a.get("article_id")) in attached_ids,
                )
                for a in articles
            )

        subject = (
            f"PrionVault Picks · {count} artículo{'s' if count != 1 else ''} seleccionado{'s' if count != 1 else ''}"
            if count else
            "PrionVault Picks · Sin artículos marcados"
        )
        plain = (
            f"PrionVault Picks – {count} artículo(s) seleccionado(s) de tu biblioteca.\n\n"
            if count else
            "No hay artículos marcados en tu biblioteca PrionVault.\n\n"
        ) + f"Accede en: {base}/prionvault/index"

        html_body = _build_picks_html(picks_cards, sub, import_base_url, count)

        if attachments:
            from core.smtp_client import send_email_with_attachments
            ok = send_email_with_attachments(
                to=sub["email"], subject=subject, body=plain,
                html=html_body, attachments=attachments,
            )
        else:
            from core.smtp_client import send_email
            ok = send_email(to=sub["email"], subject=subject, body=plain, html=html_body)

        if ok and count > 0:
            _unflag_articles(eng, str(sub["user_id"]),
                             [a["article_id"] for a in articles])

    else:
        # ── PubMed digest (existing behaviour) ───────────────────────────
        lookback_days = int(sub.get("lookback_days") or 7)
        last_sent = sub.get("last_sent_at")
        if last_sent:
            try:
                since = datetime.fromisoformat(str(last_sent)).astimezone(timezone.utc)
            except Exception:
                since = now_utc - timedelta(days=lookback_days)
        else:
            since = now_utc - timedelta(days=lookback_days)

        topics   = list(sub.get("topics") or ["prion"])
        oa_only  = bool(sub.get("include_oa_only"))
        articles = _fetch_new_articles(topics, since, oa_only)
        count    = len(articles)

        since_str    = since.strftime("%-d %b")
        now_str      = now_utc.strftime("%-d %b %Y")
        period_label = f"{since_str} – {now_str}"

        html_body = build_digest_html(articles, sub, import_base_url, period_label)
        subject = (
            f"PrionVault · {count} artículo{'s' if count != 1 else ''} nuevo{'s' if count != 1 else ''} "
            f"({period_label})"
            if count else
            f"PrionVault · Sin novedades esta semana ({period_label})"
        )
        plain = (
            f"PrionVault Digest – {period_label}\n\n"
            + (f"{count} artículo(s) nuevos en PubMed para los temas: "
               + ", ".join(TOPIC_LABELS.get(t, t) for t in topics) + "\n\n"
               if count else "No hay artículos nuevos este período.\n\n")
            + "Gestiona tus notificaciones en: " + import_base_url.replace("/import", "")
        )
        from core.smtp_client import send_email
        ok = send_email(to=sub["email"], subject=subject, body=plain, html=html_body)

    if ok:
        next_send = compute_next_send({**sub, "last_sent_at": now_utc.isoformat()},
                                      after=now_utc)
        with eng.begin() as conn:
            conn.execute(_t("""
                UPDATE prionvault_notification_subscriptions
                   SET last_sent_at = :now,
                       next_send_at = :next,
                       updated_at   = :now
                 WHERE id = :id
            """), {"now": now_utc, "next": next_send, "id": sub_id})
        logger.info("email_digest: sent to %s (%d articles, source=%s)",
                    sub["email"], count, source)

    return ok


# ── Scheduler entry point ─────────────────────────────────────────────────────

def run_pending_digests() -> None:
    """Fire all enabled subscriptions whose next_send_at has passed.
    Called every 15 min by APScheduler."""
    from ..ingestion.queue import _get_engine
    from sqlalchemy import text as _t

    try:
        eng = _get_engine()
        with eng.connect() as conn:
            rows = conn.execute(_t("""
                SELECT id::text
                  FROM prionvault_notification_subscriptions
                 WHERE enabled = TRUE
                   AND next_send_at IS NOT NULL
                   AND next_send_at <= NOW()
            """)).all()
        for (sub_id,) in rows:
            try:
                send_digest_for_sub(sub_id)
            except Exception as exc:
                logger.error("email_digest: error for sub %s: %s", sub_id, exc)
    except Exception as exc:
        # Suppress UndefinedTable until migration 046 has been applied.
        msg = str(exc)
        if "UndefinedTable" in type(exc).__name__ or "does not exist" in msg:
            logger.debug("email_digest: table not yet created, skipping (%s)", msg[:120])
            return
        logger.error("email_digest: run_pending_digests failed: %s", exc)
