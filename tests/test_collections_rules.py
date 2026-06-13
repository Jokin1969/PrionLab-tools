"""Locks down the smart-collection rule plumbing:

  - `_filter_rules` is a security boundary: it strips any key that
    the live article-list filter doesn't recognise, so a malicious
    payload to POST /api/collections can never reach raw SQL.
  - `merge_rules_into_filters` honours the URL-driven filter and
    only fills in keys the user didn't override, so opening a
    smart collection and then narrowing with the toolbar combines
    them as AND rather than as OR.
"""
import pytest

pytest.importorskip("sqlalchemy")
from tools.prionvault.services.collections import (  # noqa: E402
    _filter_rules,
    merge_rules_into_filters,
)


def test_filter_rules_drops_unknown_keys():
    raw = {
        "authors":   "Castilla",
        "year_min":  2010,
        "EVIL DROP": "DROP TABLE articles",   # not in the allow-list
        "rules":     {"nested": "thing"},
        "__class__": "uh oh",
    }
    out = _filter_rules(raw)
    assert "authors" in out and out["authors"] == "Castilla"
    assert "year_min" in out and out["year_min"] == 2010
    assert "EVIL DROP" not in out
    assert "rules"     not in out
    assert "__class__" not in out


def test_filter_rules_empty_or_invalid_input():
    assert _filter_rules({}) == {}
    assert _filter_rules(None) == {}
    assert _filter_rules("not a dict") == {}
    assert _filter_rules(42) == {}


def test_merge_rules_url_value_wins():
    """The URL-driven filter narrows a smart collection, not the
    other way round. When both set the same key, the URL keeps it."""
    rules   = {"authors": "Castilla", "year_min": 2010}
    current = {"authors": "Soto", "year_min": None, "priority_eq": 5}
    merged  = merge_rules_into_filters(rules, current)
    assert merged["authors"]      == "Soto"     # URL kept
    assert merged["year_min"]     == 2010       # rule filled in
    assert merged["priority_eq"]  == 5          # URL kept


def test_merge_rules_coerces_bool_strings():
    """The rules JSON may carry "1" / "0" / "true" / "false" from
    the legacy frontend payload — merge_rules_into_filters should
    coerce them into real booleans, not leave the keys unset."""
    rules   = {"is_flagged": "1", "is_milestone": "false"}
    current = {"is_flagged": None, "is_milestone": None}
    merged  = merge_rules_into_filters(rules, current)
    assert merged["is_flagged"]   is True
    assert merged["is_milestone"] is False


def test_merge_rules_handles_missing_keys():
    """current has every filter slot None; rules has only a couple.
    The result populates only those, no spurious keys appear."""
    rules   = {"q": "BSE", "year_max": 2024}
    current = {k: None for k in (
        "q", "authors", "journal", "year_min", "year_max",
        "tag", "priority_eq", "color_label", "has_summary",
        "extraction_status",
        "is_flagged", "is_milestone",
        "in_prionread", "is_favorite", "is_read",
    )}
    merged = merge_rules_into_filters(rules, current)
    assert merged["q"]        == "BSE"
    assert merged["year_max"] == 2024
    assert merged["authors"]  is None
    assert merged["is_read"]  is None
