"""In-memory health tracker for the external AI / metadata providers.

Every LLM / Voyage / Unpaywall call funnels through one of the wrappers
under tools/prionvault/services/. Each wrapper calls record_success() on
success and record_error() on failure; this module classifies the error
text and stores a snapshot per provider (anthropic, openai, gemini,
voyage, unpaywall, …).

The snapshot powers two surfaces:

  GET /api/admin/ai-providers-status — JSON for the "Estado IA" modal.
  Sticky banner — drawn in the page when at least one provider is in a
                  "definite" failure state (quota_exhausted /
                  invalid_key) so the operator notices before pulling
                  their hair out wondering why summaries stopped.

The tracker is process-local. With multiple gunicorn workers each holds
its own copy — that's fine for UX (one worker's status is
representative) and avoids the complexity of shared state.

Error classifications:
  ok                — last call succeeded.
  quota_exhausted   — provider says no credit / billing issue.
  invalid_key       — API key rejected (401 / auth error).
  rate_limited      — 429 with a rate-limit message (recoverable).
  transient         — 5xx / network / timeout (will likely self-heal).
  unknown           — error doesn't match any pattern.
"""
from __future__ import annotations

import re
import threading
from datetime import datetime, timezone
from typing import Optional


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
        # Running totals so the operator can spot a flaky provider even
        # when the latest call happened to succeed.
        "success_count":      0,
        "error_count":        0,
    }


_state: dict[str, dict] = {p: _empty_entry() for p in KNOWN_PROVIDERS}
_lock = threading.Lock()


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

def record_success(provider: str, *, action: Optional[str] = None) -> None:
    """Stamp a successful call against `provider`. Clears any prior
    alerting state — if the operator's quota was reloaded, the banner
    disappears on the next call."""
    p = (provider or "").strip().lower()
    if not p:
        return
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with _lock:
        s = _state.setdefault(p, _empty_entry())
        s["status"]              = "ok"
        s["last_success_at"]     = now
        s["last_success_action"] = action
        s["success_count"]      += 1


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
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with _lock:
        s = _state.setdefault(p, _empty_entry())
        s["last_error_at"]     = now
        s["last_error"]        = text
        s["last_error_kind"]   = kind
        s["last_error_action"] = action
        s["error_count"]      += 1
        # Don't downgrade a sticky-alert state to a softer one — we
        # want the operator to keep seeing the banner until success.
        if kind in ALERTING_KINDS:
            s["status"] = kind
        elif s["status"] not in ALERTING_KINDS:
            s["status"] = kind
    return kind


# ── Reading ─────────────────────────────────────────────────────────────────

def get_snapshot() -> dict:
    """Full per-provider state plus a top-level convenience field
    `alerting` = list of providers in a banner-worthy state."""
    with _lock:
        snap = {p: dict(v) for p, v in _state.items()}
    alerting = [p for p, v in snap.items() if v.get("status") in ALERTING_KINDS]
    return {"providers": snap, "alerting": alerting}


def reset(provider: Optional[str] = None) -> int:
    """Clear stored state. Without args, clears every provider; with
    a name, clears just that one. Useful from an admin endpoint when
    the operator has just topped up their credit and wants the banner
    to go away without waiting for the next call to succeed."""
    with _lock:
        if provider is None:
            n = len(_state)
            for k in list(_state):
                _state[k] = _empty_entry()
            return n
        p = provider.strip().lower()
        if p in _state:
            _state[p] = _empty_entry()
            return 1
        return 0
