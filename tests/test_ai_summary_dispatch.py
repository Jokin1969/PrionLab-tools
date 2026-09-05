"""Locks down the provider dispatch in ai_summary.generate_summary:

  - Unknown providers raise ValueError immediately (no SDK call).
  - Missing API key for the requested provider raises NotConfigured
    (so the route layer can map to HTTP 503 instead of 500).
  - _estimate_cost is monotonic in tokens for every catalogued
    provider — a 0-token call always costs 0; a 10× larger call
    always costs more than the smaller one.
"""
import os
import pytest

pytest.importorskip("sqlalchemy")
from tools.prionvault.services.ai_summary import (  # noqa: E402
    PROVIDERS,
    NotConfigured,
    generate_summary,
    _estimate_cost,
)


def test_unknown_provider_raises_value_error():
    with pytest.raises(ValueError, match="unknown provider"):
        generate_summary(title="x", provider="not-a-real-provider")


def test_missing_api_key_raises_notconfigured(monkeypatch):
    # Force every provider's env var unset so we don't accidentally
    # rely on a real key that happens to be in the dev shell.
    for p in PROVIDERS.values():
        monkeypatch.delenv(p["env"], raising=False)
    for name in PROVIDERS:
        with pytest.raises(NotConfigured):
            generate_summary(title="x", provider=name)


@pytest.mark.parametrize("provider", list(PROVIDERS.keys()))
def test_estimate_cost_is_monotonic(provider):
    base   = _estimate_cost(provider, 1_000, 200)
    bigger = _estimate_cost(provider, 10_000, 2_000)
    zero   = _estimate_cost(provider, 0, 0)
    assert zero == 0
    assert base is not None and bigger is not None
    assert bigger > base, (
        f"cost should grow with token count for {provider}: "
        f"{base} vs {bigger}"
    )


def test_estimate_cost_returns_none_when_tokens_unknown():
    """If the SDK didn't report token counts (e.g. some Gemini
    responses), we should return None instead of a misleading 0."""
    assert _estimate_cost("anthropic", None, 100) is None
    assert _estimate_cost("anthropic", 100, None) is None
    assert _estimate_cost("anthropic", None, None) is None


def test_estimate_cost_unknown_provider_returns_none():
    assert _estimate_cost("not-a-provider", 100, 100) is None
