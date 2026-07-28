"""DB-backed health tracker for the external AI / metadata providers.

Every LLM / Voyage / Unpaywall call funnels through one of the wrappers
under tools/prionvault/services/. Each wrapper calls record_success() on
success and record_error() on failure; this module classifies the error
text and stores a snapshot per provider (anthropic, openai, gemini,
voyage, unpaywall, …) in prionvault_provider_status (migration 072).

Why DB-backed and not a module-level dict: Railway runs several gunicorn
worker processes (and background/scheduler work may live in yet another
process). A plain in-memory dict is process-local, so the worker that
happens to serve the "Estado IA" GET request almost never is the one
that made the actual LLM call — the modal showed "Sin datos" for every
provider essentially permanently, not because nothing was happening but
because the status lived somewhere else. Persisting to Postgres makes
every worker see the same state.

The snapshot powers two surfaces:

  GET /api/admin/ai-providers-status — JSON for the "Estado IA" modal.
  Sticky banner — drawn in the page when at least one provider is in a
                  "definite" failure state (quota_exhausted /
                  invalid_key) so the operator notices before pulling
                  their hair out wondering why summaries stopped.

Error classifications:
  ok                — last call succeeded.
  quota_exhausted   — provider says no credit / billing issue.
  invalid_key       — API key rejected (401 / auth error).
  rate_limited      — 429 with a rate-limit message (recoverable).
  transient         — 5xx / network / timeout (will likely self-heal).
  unknown           — error doesn't match any pattern, or no calls yet.
"""
from __future__ import annotations

import logging
import re
from typing import Optional

from sqlalchemy import text as sql_text

logger = logging.getLogger(__name__)

KNOWN_PROVIDERS = ("anthropic", "openai", "gemini", "voyage", "unpaywall")

# Categories the UI shows with a red "needs attention" banner. The
# others (rate_limited, transient, unknown) are noisy short-term
# states that usually self-recover before the operator notices.
ALERTING_KINDS = frozenset({"quota_exhausted", "invalid_key"})


def _empty_entry() -> dict:
    return {
        "status":             "unknown",   # one of OK / quota_exhausted / …
        "last_success_at":    None,
        "last_success_action": None,
        "last_error_at":      None,
        "last_error":         None,
        "last_error_kind":    None,
        "last_error_action":  None,
        "success_count":      0,
        "error_count":        0,
    }


def _engine():
    from database.config import db
    return db.engine


# ── Error classification ────────────────────────────────────────────────────

# Substrings (lowercase) that point at billing exhaustion across the
# common SDKs. Conservative — we want false negatives (treat as
# transient) over false positives (panic banner) when in doubt.
_QUOTA_HINTS = (
    "insufficient_quota",
    "credit_balance_too_low",
    "credit balance is too low",
    "you exceeded your current quota",
    "billing",
    "payment required",
    "free trial credit",
    "monthly quota",
    "out of credits",
    "limit reached",
    "limit_reached",
)
_INVALID_KEY_HINTS = (
    "invalid_api_key",
    "invalid api key",
    "incorrect api key",
    "authentication_error",
    "authentication failed",
    "api key not valid",
    "unauthorized",
)
_RATE_LIMIT_HINTS = (
    "rate_limit",
    "rate limit",
    "resource_exhausted",
    "too many requests",
    "overloaded",
)
_TRANSIENT_HINTS = (
    "timeout",
    "timed out",
    "connection",
    "temporary",
    "service unavailable",
    "bad gateway",
    "gateway timeout",
    "internal server error",
)
# Numeric HTTP codes — we look for these as a whole-word match to
# avoid matching "500" inside a token count.
_TRANSIENT_CODES = (500, 502, 503, 504, 529)


def classify(err_text: str) -> str:
    """Return one of OK / quota_exhausted / invalid_key / rate_limited /
    transient / unknown for the given error text."""
    if not err_text:
        return "unknown"
    t = err_text.lower()
    if any(h in t for h in _QUOTA_HINTS):
        return "quota_exhausted"
    if any(h in t for h in _INVALID_KEY_HINTS):
        return "invalid_key"
    if any(h in t for h in _RATE_LIMIT_HINTS):
        return "rate_limited"
    if any(h in t for h in _TRANSIENT_HINTS):
        return "transient"
    if any(re.search(rf"\b{code}\b", t) for code in _TRANSIENT_CODES):
        return "transient"
    if re.search(r"\b401\b|\b403\b", t):
        return "invalid_key"
    if re.search(r"\b429\b|\b402\b", t):
        # 402 = Payment Required → quota for many providers.
        if "402" in t:
            return "quota_exhausted"
        return "rate_limited"
    return "unknown"


# ── Recording ───────────────────────────────────────────────────────────────
# Both functions swallow DB errors — a status-tracking hiccup must never
# break the actual LLM/embedding call that triggered it.

def record_success(provider: str, *, action: Optional[str] = None) -> None:
    """Stamp a successful call against `provider`. Clears any prior
    alerting state — if the operator's quota was reloaded, the banner
    disappears on the next call."""
    p = (provider or "").strip().lower()
    if not p:
        return
    try:
        with _engine().begin() as conn:
            conn.execute(sql_text(
                """
                INSERT INTO prionvault_provider_status
                    (provider, status, last_success_at, last_success_action, success_count)
                VALUES (:p, 'ok', NOW(), :action, 1)
                ON CONFLICT (provider) DO UPDATE SET
                    status               = 'ok',
                    last_success_at      = NOW(),
                    last_success_action  = :action,
                    success_count        = prionvault_provider_status.success_count + 1
                """
            ), {"p": p, "action": action})
    except Exception:
        logger.debug("provider_status.record_success(%s) failed", p, exc_info=True)


def record_error(provider: str, err_text: str, *,
                 action: Optional[str] = None) -> str:
    """Stamp a failure against `provider`. Returns the classification
    so callers can decide whether to retry / fallback / abort.

    Sticky behaviour: if the classification is `quota_exhausted` or
    `invalid_key`, the status stays in that state across subsequent
    calls until a record_success() clears it. Transient errors are
    "overwritten" by the next OK.
    """
    p = (provider or "").strip().lower()
    if not p:
        return "unknown"
    text = (err_text or "")[:400]
    kind = classify(text)
    try:
        with _engine().begin() as conn:
            conn.execute(sql_text(
                """
                INSERT INTO prionvault_provider_status
                    (provider, status, last_error_at, last_error, last_error_kind,
                     last_error_action, error_count)
                VALUES (:p, :kind, NOW(), :text, :kind, :action, 1)
                ON CONFLICT (provider) DO UPDATE SET
                    last_error_at     = NOW(),
                    last_error        = :text,
                    last_error_kind   = :kind,
                    last_error_action = :action,
                    error_count       = prionvault_provider_status.error_count + 1,
                    status = CASE
                        WHEN :kind = ANY(:alerting) THEN :kind
                        WHEN prionvault_provider_status.status = ANY(:alerting)
                            THEN prionvault_provider_status.status
                        ELSE :kind
                    END
                """
            ), {"p": p, "kind": kind, "text": text, "action": action,
                "alerting": list(ALERTING_KINDS)})
    except Exception:
        logger.debug("provider_status.record_error(%s) failed", p, exc_info=True)
    return kind


# ── Reading ─────────────────────────────────────────────────────────────────

def get_snapshot() -> dict:
    """Full per-provider state plus a top-level convenience field
    `alerting` = list of providers in a banner-worthy state."""
    snap = {p: _empty_entry() for p in KNOWN_PROVIDERS}
    try:
        with _engine().connect() as conn:
            rows = conn.execute(sql_text(
                "SELECT provider, status, last_success_at, last_success_action, "
                "last_error_at, last_error, last_error_kind, last_error_action, "
                "success_count, error_count FROM prionvault_provider_status"
            )).all()
        for r in rows:
            snap[r.provider] = {
                "status":              r.status,
                "last_success_at":     r.last_success_at.isoformat() if r.last_success_at else None,
                "last_success_action": r.last_success_action,
                "last_error_at":       r.last_error_at.isoformat() if r.last_error_at else None,
                "last_error":          r.last_error,
                "last_error_kind":     r.last_error_kind,
                "last_error_action":   r.last_error_action,
                "success_count":       int(r.success_count or 0),
                "error_count":         int(r.error_count or 0),
            }
    except Exception:
        logger.debug("provider_status.get_snapshot failed", exc_info=True)
    alerting = [p for p, v in snap.items() if v.get("status") in ALERTING_KINDS]
    return {"providers": snap, "alerting": alerting}


def reset(provider: Optional[str] = None) -> int:
    """Clear stored state. Without args, clears every provider; with
    a name, clears just that one. Useful from an admin endpoint when
    the operator has just topped up their credit and wants the banner
    to go away without waiting for the next call to succeed."""
    try:
        with _engine().begin() as conn:
            if provider is None:
                n = conn.execute(sql_text(
                    "SELECT COUNT(*) FROM prionvault_provider_status"
                )).scalar() or 0
                conn.execute(sql_text("DELETE FROM prionvault_provider_status"))
                return int(n)
            p = provider.strip().lower()
            res = conn.execute(sql_text(
                "DELETE FROM prionvault_provider_status WHERE provider = :p"
            ), {"p": p})
            return res.rowcount or 0
    except Exception:
        logger.debug("provider_status.reset failed", exc_info=True)
        return 0
