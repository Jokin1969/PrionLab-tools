"""Unit tests for _validate_notif_payload in prionvault/routes.py.

The function is a pure data-normalisation helper with no DB or network
calls, so it's safe to import and exercise directly.
"""
import json
import sys
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import pytest

# routes.py imports SQLAlchemy models at module level; skip the whole
# test file if SQLAlchemy is not available in the test env.
pytest.importorskip("sqlalchemy")

from tools.prionvault.routes import _validate_notif_payload  # noqa: E402

UEMAIL = "user@example.com"


# ── defaults ────────────────────────────────────────────────────────────────

def test_empty_payload_gives_safe_defaults():
    p = _validate_notif_payload({}, UEMAIL)
    assert p["source"]       == "pubmed"
    assert p["freq"]         == "weekly"
    assert p["dow"]          == 4
    assert p["days"]         == [4]
    assert p["hour"]         == 15
    assert p["minute"]       == 0
    assert p["lookback"]     == 7
    assert p["ape"]          == 5
    assert p["oa_only"]      is False
    assert p["enabled"]      is True
    assert p["include_pdfs"] is True
    assert p["email"]        == UEMAIL


# ── name / email ─────────────────────────────────────────────────────────────

def test_name_truncated_to_80_chars():
    p = _validate_notif_payload({"name": "x" * 200}, UEMAIL)
    assert len(p["name"]) == 80


def test_name_defaults_when_blank():
    p = _validate_notif_payload({"name": "   "}, UEMAIL)
    assert p["name"] == "Mi suscripción"


def test_email_falls_back_to_uemail():
    p = _validate_notif_payload({"email": ""}, UEMAIL)
    assert p["email"] == UEMAIL


def test_email_uses_provided_value():
    p = _validate_notif_payload({"email": "other@test.com"}, UEMAIL)
    assert p["email"] == "other@test.com"


# ── source ────────────────────────────────────────────────────────────────────

def test_source_pubmed():
    p = _validate_notif_payload({"source": "pubmed"}, UEMAIL)
    assert p["source"] == "pubmed"


def test_source_flagged():
    p = _validate_notif_payload({"source": "flagged"}, UEMAIL)
    assert p["source"] == "flagged"


def test_invalid_source_defaults_to_pubmed():
    p = _validate_notif_payload({"source": "evil"}, UEMAIL)
    assert p["source"] == "pubmed"


# ── frequency ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("freq", ["weekly", "biweekly", "monthly"])
def test_valid_frequency_accepted(freq):
    p = _validate_notif_payload({"frequency": freq}, UEMAIL)
    assert p["freq"] == freq


def test_invalid_frequency_defaults_to_weekly():
    p = _validate_notif_payload({"frequency": "hourly"}, UEMAIL)
    assert p["freq"] == "weekly"


# ── days_of_week ──────────────────────────────────────────────────────────────

def test_days_of_week_list():
    p = _validate_notif_payload({"days_of_week": [1, 3, 5]}, UEMAIL)
    assert p["days"] == [1, 3, 5]
    assert p["dow"] == 1   # first selected day


def test_days_of_week_clamps_to_0_6():
    p = _validate_notif_payload({"days_of_week": [-1, 7, 3]}, UEMAIL)
    assert 3 in p["days"]
    assert all(0 <= d <= 6 for d in p["days"])


def test_days_of_week_deduplicates():
    p = _validate_notif_payload({"days_of_week": [2, 2, 2]}, UEMAIL)
    assert p["days"] == [2]


def test_empty_days_falls_back_to_thursday():
    p = _validate_notif_payload({"days_of_week": []}, UEMAIL)
    assert p["days"] == [4]


# ── hour / minute ─────────────────────────────────────────────────────────────

def test_hour_clamps():
    assert _validate_notif_payload({"send_hour": -5},  UEMAIL)["hour"] == 0
    assert _validate_notif_payload({"send_hour": 25},  UEMAIL)["hour"] == 23
    assert _validate_notif_payload({"send_hour": "abc"}, UEMAIL)["hour"] == 15


def test_minute_clamps():
    assert _validate_notif_payload({"send_minute": -1},  UEMAIL)["minute"] == 0
    assert _validate_notif_payload({"send_minute": 60},  UEMAIL)["minute"] == 59
    assert _validate_notif_payload({"send_minute": None}, UEMAIL)["minute"] == 0


# ── lookback_days ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("n", [7, 14, 30])
def test_valid_lookback_accepted(n):
    assert _validate_notif_payload({"lookback_days": n}, UEMAIL)["lookback"] == n


def test_invalid_lookback_defaults_to_7():
    assert _validate_notif_payload({"lookback_days": 99}, UEMAIL)["lookback"] == 7


# ── articles_per_email ────────────────────────────────────────────────────────

def test_ape_clamps_min_1():
    assert _validate_notif_payload({"articles_per_email": 0}, UEMAIL)["ape"] == 1


def test_ape_clamps_max_50():
    assert _validate_notif_payload({"articles_per_email": 999}, UEMAIL)["ape"] == 50


# ── boolean flags ─────────────────────────────────────────────────────────────

def test_include_pdfs_true_by_default():
    assert _validate_notif_payload({}, UEMAIL)["include_pdfs"] is True


def test_include_pdfs_can_be_disabled():
    assert _validate_notif_payload({"include_pdfs": False}, UEMAIL)["include_pdfs"] is False


def test_oa_only_false_by_default():
    assert _validate_notif_payload({}, UEMAIL)["oa_only"] is False


def test_enabled_true_by_default():
    assert _validate_notif_payload({}, UEMAIL)["enabled"] is True


# ── topics serialised as JSON ─────────────────────────────────────────────────

def test_topics_serialised_to_json_string():
    p = _validate_notif_payload({"topics": ["prion", "cjd"]}, UEMAIL)
    parsed = json.loads(p["topics"])
    assert parsed == ["prion", "cjd"]


def test_empty_topics_defaults_to_prion():
    p = _validate_notif_payload({"topics": []}, UEMAIL)
    assert json.loads(p["topics"]) == ["prion"]


def test_non_string_topics_filtered_out():
    p = _validate_notif_payload({"topics": [1, "prion", None]}, UEMAIL)
    assert json.loads(p["topics"]) == ["prion"]
