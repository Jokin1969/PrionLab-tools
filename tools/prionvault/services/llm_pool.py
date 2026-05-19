"""Multi-provider LLM caller for one-shot prompts (no streaming).

`ai_summary.py` already calls Anthropic / OpenAI / Gemini, but its
prompts are baked-in for the scientific-summary use case. This
module exposes a thin `call_llm(provider, system, user, …)` that
forwards arbitrary prompts and returns the raw text + a small
metadata bag, so callers like pack_suggest can reuse the same
auth + retry plumbing without redefining it.

Env var per provider matches ai_summary's PROVIDERS table so the
operator only configures keys in one place.
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


# Models tuned for short structured output (lists / JSON) — not the
# bigger summary models. Cheap, fast, deterministic-ish.
_MODELS = {
    "anthropic": "claude-sonnet-4-6",
    "openai":    "gpt-4o-mini",
    "gemini":    "gemini-2.0-flash",
}
_ENV_KEYS = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai":    "OPENAI_API_KEY",
    "gemini":    "GEMINI_API_KEY",
}

_MAX_ATTEMPTS  = 3
_BASE_BACKOFF  = 1.8


class NotConfigured(RuntimeError):
    """Raised when the requested provider's API key is missing."""


@dataclass
class LLMResult:
    text:       str
    provider:   str
    model:      str
    tokens_in:  Optional[int] = None
    tokens_out: Optional[int] = None
    elapsed_ms: int = 0


def _resolve(provider: str) -> tuple[str, str]:
    p = (provider or "").strip().lower()
    if p not in _MODELS:
        raise ValueError(
            f"unknown provider: {provider!r}. Valid: {sorted(_MODELS)}"
        )
    key = os.environ.get(_ENV_KEYS[p], "").strip()
    if not key:
        raise NotConfigured(
            f"{_ENV_KEYS[p]} is not set (needed for provider={p})"
        )
    return p, key


def call_llm(*, provider: str, system: str, user: str,
             max_tokens: int = 2400, temperature: float = 0.2,
             want_json: bool = False) -> LLMResult:
    """Send `system` + `user` to the chosen provider and return the
    raw text. `want_json` switches on the provider's JSON-only mode
    when available (OpenAI / Gemini); for Anthropic we rely on the
    prompt asking for "JSON estricto" since there's no native flag.
    """
    p, key = _resolve(provider)
    last_error: Optional[Exception] = None
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            if p == "anthropic":
                return _call_anthropic(key, system, user, max_tokens, temperature)
            if p == "openai":
                return _call_openai(key, system, user, max_tokens, temperature, want_json)
            if p == "gemini":
                return _call_gemini(key, system, user, max_tokens, temperature, want_json)
        except Exception as exc:
            last_error = exc
            logger.warning("llm_pool[%s] attempt %d: %s", p, attempt, exc)
            if attempt < _MAX_ATTEMPTS:
                time.sleep(_BASE_BACKOFF ** attempt)
    raise RuntimeError(
        f"{p} failed after {_MAX_ATTEMPTS} attempts: {last_error}"
    )


def call_llm_json(*, provider: str, system: str, user: str,
                  max_tokens: int = 2400) -> dict:
    """Convenience: call_llm() + json.loads(). Defensively strips a
    leading / trailing markdown code-fence the model sometimes adds
    despite the prompt asking for raw JSON."""
    r = call_llm(provider=provider, system=system, user=user,
                 max_tokens=max_tokens, temperature=0.0, want_json=True)
    text = r.text.strip()
    if text.startswith("```"):
        # Drop ```json or ``` fence + the trailing ```
        text = text.split("```", 2)
        text = text[1] if len(text) >= 2 else ""
        if text.startswith("json"):
            text = text[4:]
        text = text.rstrip("` \n")
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"{r.provider} returned non-JSON: {exc} — got: {r.text[:200]}"
        ) from exc


def call_llm_json_with_fallback(*, providers: list[str], system: str,
                                user: str, max_tokens: int = 2400
                                ) -> tuple[dict, dict]:
    """Try each provider in `providers` until one returns parseable JSON.
    Empty responses, transient errors and JSON-decode failures all
    cause the next provider to be tried; only an exhausted list raises.

    Returns (parsed_dict, info) where info is:
      {"provider": "<winner>", "attempts": [{"provider":..., "error":...}, ...]}
    so the caller can show a "served by Gemini after Anthropic empty
    response" hint in the UI.
    """
    attempts: list[dict] = []
    seen: set[str] = set()
    for p in providers:
        p = (p or "").strip().lower()
        if not p or p in seen:
            continue
        seen.add(p)
        try:
            parsed = call_llm_json(provider=p, system=system, user=user,
                                   max_tokens=max_tokens)
            return parsed, {"provider": p, "attempts": attempts}
        except (NotConfigured, RuntimeError, ValueError) as exc:
            attempts.append({"provider": p, "error": str(exc)[:240]})
            logger.info("llm_pool fallback: %s failed (%s) — trying next", p, exc)
            continue
    raise RuntimeError(
        "all providers failed: "
        + "; ".join(f"{a['provider']}={a['error']}" for a in attempts)
    )


# ── Provider call implementations ────────────────────────────────────────────

def _call_anthropic(api_key: str, system: str, user: str,
                    max_tokens: int, temperature: float) -> LLMResult:
    import anthropic
    client = anthropic.Anthropic(api_key=api_key, timeout=60.0)
    model = _MODELS["anthropic"]
    start = time.monotonic()
    message = client.messages.create(
        model=model, max_tokens=max_tokens, temperature=temperature,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    elapsed_ms = int((time.monotonic() - start) * 1000)
    text = "".join(
        b.text for b in message.content if getattr(b, "type", None) == "text"
    ).strip()
    if not text:
        raise RuntimeError("Claude returned an empty response")
    usage = getattr(message, "usage", None)
    return LLMResult(
        text=text, provider="anthropic", model=model,
        tokens_in=getattr(usage, "input_tokens", None) if usage else None,
        tokens_out=getattr(usage, "output_tokens", None) if usage else None,
        elapsed_ms=elapsed_ms,
    )


def _call_openai(api_key: str, system: str, user: str,
                 max_tokens: int, temperature: float,
                 want_json: bool) -> LLMResult:
    from openai import OpenAI
    client = OpenAI(api_key=api_key, timeout=60.0)
    model = _MODELS["openai"]
    kwargs: dict = dict(
        model=model, max_tokens=max_tokens, temperature=temperature,
        messages=[
            {"role": "system", "content": system},
            {"role": "user",   "content": user},
        ],
    )
    if want_json:
        kwargs["response_format"] = {"type": "json_object"}
    start = time.monotonic()
    completion = client.chat.completions.create(**kwargs)
    elapsed_ms = int((time.monotonic() - start) * 1000)
    choice = completion.choices[0] if completion.choices else None
    text = (choice.message.content if choice and choice.message else "") or ""
    text = text.strip()
    if not text:
        raise RuntimeError("OpenAI returned an empty response")
    usage = getattr(completion, "usage", None)
    return LLMResult(
        text=text, provider="openai", model=model,
        tokens_in=getattr(usage, "prompt_tokens", None) if usage else None,
        tokens_out=getattr(usage, "completion_tokens", None) if usage else None,
        elapsed_ms=elapsed_ms,
    )


def _call_gemini(api_key: str, system: str, user: str,
                 max_tokens: int, temperature: float,
                 want_json: bool) -> LLMResult:
    from google import genai
    from google.genai import types
    client = genai.Client(api_key=api_key)
    model = _MODELS["gemini"]
    config = types.GenerateContentConfig(
        system_instruction=system,
        max_output_tokens=max_tokens,
        temperature=temperature,
        response_mime_type="application/json" if want_json else "text/plain",
    )
    start = time.monotonic()
    response = client.models.generate_content(
        model=model, contents=user, config=config,
    )
    elapsed_ms = int((time.monotonic() - start) * 1000)
    text = (response.text or "").strip()
    if not text:
        raise RuntimeError("Gemini returned an empty response")
    usage = getattr(response, "usage_metadata", None)
    return LLMResult(
        text=text, provider="gemini", model=model,
        tokens_in=getattr(usage, "prompt_token_count", None) if usage else None,
        tokens_out=getattr(usage, "candidates_token_count", None) if usage else None,
        elapsed_ms=elapsed_ms,
    )
