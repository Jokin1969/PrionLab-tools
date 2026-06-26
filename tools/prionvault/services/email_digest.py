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

def compute_next_send(sub: dict, after: Optional[datetime] = None) -> datetime:
    """Return the next UTC datetime when sub should fire.

    `sub` keys used: frequency, day_of_week (0=Mon…6=Sun), send_hour,
    send_minute, user_timezone, last_sent_at (optional ISO string).
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

    freq        = sub.get("frequency", "weekly")
    dow_target  = int(sub.get("day_of_week", 4))   # 0=Mon…6=Sun
    hour        = int(sub.get("send_hour",   15))
    minute      = int(sub.get("send_minute",  0))

    # Candidate: next occurrence of (dow_target, hour, minute) in local tz
    # Start from today at the target time.
    candidate = now_local.replace(hour=hour, minute=minute,
                                  second=0, microsecond=0)

    # Find the next matching day-of-week (0 = Monday in Python's .weekday())
    days_ahead = (dow_target - candidate.weekday()) % 7
    if days_ahead == 0 and candidate <= now_local:
        days_ahead = 7   # same weekday but already past → next week
    candidate += timedelta(days=days_ahead)

    if freq == "biweekly":
        # Align to fortnight from last send; if no last send use +1 week
        last = sub.get("last_sent_at")
        if last:
            try:
                last_dt = datetime.fromisoformat(last).astimezone(tz)
                two_weeks_after = last_dt + timedelta(weeks=2)
                two_weeks_after = two_weeks_after.replace(
                    hour=hour, minute=minute, second=0, microsecond=0)
                # Snap to correct weekday
                adj = (dow_target - two_weeks_after.weekday()) % 7
                two_weeks_after += timedelta(days=adj)
                if two_weeks_after > now_local:
                    candidate = two_weeks_after
            except Exception:
                pass

    elif freq == "monthly":
        last = sub.get("last_sent_at")
        if last:
            try:
                last_dt = datetime.fromisoformat(last).astimezone(tz)
                # First matching weekday >= 28 days after last send
                monthly_after = last_dt + timedelta(days=28)
                monthly_after = monthly_after.replace(
                    hour=hour, minute=minute, second=0, microsecond=0)
                adj = (dow_target - monthly_after.weekday()) % 7
                monthly_after += timedelta(days=adj)
                if monthly_after > now_local:
                    candidate = monthly_after
            except Exception:
                pass

    return candidate.astimezone(timezone.utc)


# ── Article fetching ─────────────────────────────────────────────────────────

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

    oa_filter = " AND i.is_oa = TRUE" if oa_only else ""

    sql = f"""
        SELECT
            i.pmid,
            i.title,
            i.authors,
            i.journal,
            i.pub_year,
            i.doi,
            i.is_oa,
            i.preset,
            i.first_seen_at
        FROM prionvault_pubmed_inventory i
        WHERE i.preset IN ({placeholders})
          AND i.first_seen_at >= :since
          AND i.imported_at IS NULL
          {oa_filter}
        ORDER BY i.pub_year DESC NULLS LAST, i.first_seen_at DESC
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


def _article_card(a: dict, import_base_url: str) -> str:
    title   = a.get("title") or "Sin título"
    authors = a.get("authors") or ""
    journal = a.get("journal") or ""
    year    = a.get("pub_year") or ""
    pmid    = a.get("pmid") or ""
    doi     = a.get("doi") or ""
    is_oa   = a.get("is_oa")
    preset  = a.get("preset", "prion")

    topic_label = TOPIC_LABELS.get(preset, preset)
    doi_url  = f"https://doi.org/{doi}" if doi else ""
    pmid_url = f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/" if pmid else ""

    # Authors: show first 3 then et al.
    if authors:
        auth_list = [x.strip() for x in authors.split(",") if x.strip()]
        if len(auth_list) > 3:
            authors_short = ", ".join(auth_list[:3]) + " et al."
        else:
            authors_short = ", ".join(auth_list)
    else:
        authors_short = ""

    # Import link (deep-link into PrionVault import-by-pmid)
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

    topic_chip = (
        f'<span style="display:inline-block;background:#eff6ff;color:#1e40af;'
        f'font-size:10px;font-weight:600;padding:2px 7px;border-radius:20px;'
        f'letter-spacing:0.04em;vertical-align:middle;">{topic_label}</span>'
    )

    return f"""
<tr>
  <td style="padding:0 0 16px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;
                  overflow:hidden;">
      <tr>
        <td style="padding:16px 18px 12px;">
          <!-- Title -->
          <p style="margin:0 0 6px;font-size:14.5px;font-weight:700;
                    color:#111827;line-height:1.4;">
            {title}
          </p>
          <!-- Authors + journal -->
          <p style="margin:0 0 8px;font-size:12px;color:#6b7280;line-height:1.5;">
            {authors_short}
            {"<br>" if authors_short and (journal or year) else ""}
            <em>{journal}</em>{(", " + str(year)) if journal and year else str(year)}
          </p>
          <!-- Badges row -->
          <p style="margin:0 0 12px;">
            {_oa_badge(is_oa)}
            &nbsp; {topic_chip}
          </p>
          <!-- Links row -->
          <table cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="padding-right:14px;">{doi_link}</td>
              <td style="padding-right:14px;">{pmid_link}</td>
              <td>{import_btn}</td>
            </tr>
          </table>
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
        body_content = f"""
        <tr><td style="padding:0 0 8px;">
          <p style="margin:0;font-size:13px;color:#6b7280;">
            Se encontraron <strong style="color:#111827;">{count} artículo{"s" if count != 1 else ""} nuevo{"s" if count != 1 else ""}</strong>
            en PubMed que aún no están en tu biblioteca.
          </p>
        </td></tr>
        {cards}"""

    settings_url = import_base_url.replace("/import", "") if "/import" in import_base_url else import_base_url

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
                  Recibes este email porque estás suscrito al digest de PrionVault.<br>
                  <a href="{settings_url}" style="color:#0F3460;text-decoration:none;">
                    Gestionar notificaciones
                  </a>
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

    # Determine lookback window
    lookback_days = int(sub.get("lookback_days") or 7)
    last_sent = sub.get("last_sent_at")
    if last_sent:
        try:
            since = datetime.fromisoformat(str(last_sent)).astimezone(timezone.utc)
        except Exception:
            since = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    else:
        since = datetime.now(timezone.utc) - timedelta(days=lookback_days)

    topics   = list(sub.get("topics") or ["prion"])
    oa_only  = bool(sub.get("include_oa_only"))
    articles = _fetch_new_articles(topics, since, oa_only)

    # Period label for email subject / header
    since_str = since.strftime("%-d %b")
    now_str   = datetime.now(timezone.utc).strftime("%-d %b %Y")
    period_label = f"{since_str} – {now_str}"

    # Import deep-link base (relative; email client will use full URL via APP_URL)
    try:
        from config import APP_URL
        base = (APP_URL or "").rstrip("/")
    except ImportError:
        base = ""
    import_base_url = f"{base}/prionvault/import" if base else "/prionvault/import"

    html_body = build_digest_html(articles, sub, import_base_url, period_label)

    count = len(articles)
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
    ok = send_email(
        to=sub["email"],
        subject=subject,
        body=plain,
        html=html_body,
    )

    if ok:
        now_utc = datetime.now(timezone.utc)
        next_send = compute_next_send(
            {**sub, "last_sent_at": now_utc.isoformat()}, after=now_utc)
        with eng.begin() as conn:
            conn.execute(_t("""
                UPDATE prionvault_notification_subscriptions
                   SET last_sent_at = :now,
                       next_send_at = :next,
                       updated_at   = :now
                 WHERE id = :id
            """), {"now": now_utc, "next": next_send, "id": sub_id})
        logger.info("email_digest: sent to %s (%d articles)", sub["email"], count)

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
        logger.error("email_digest: run_pending_digests failed: %s", exc)
