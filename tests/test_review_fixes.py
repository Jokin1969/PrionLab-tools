"""Regression tests for the Nov 2026 review fixes that need no database."""
import json
import os
import threading

import pytest


# ── PrionPacks JSON store ────────────────────────────────────────────────────

@pytest.fixture()
def packs(tmp_path, monkeypatch):
    pytest.importorskip("flask")
    try:
        from tools.prionpacks import models
    except Exception as exc:
        pytest.skip(f"prionpacks not importable: {exc}")
    monkeypatch.setattr(models, "PACKAGES_FILE", str(tmp_path / "prionpacks.json"))
    return models


def test_packs_unreadable_file_is_never_overwritten(packs):
    with open(packs.PACKAGES_FILE, "w") as f:
        f.write("{broken")
    packs.bootstrap_demo_data()                    # must not seed over it
    with pytest.raises(Exception):
        packs.create_package({"title": "x"})       # must not save [new] over it
    assert open(packs.PACKAGES_FILE).read() == "{broken"


def test_packs_concurrent_creates_all_survive(packs):
    packs._save([])
    errors = []

    def add(i):
        try:
            packs.create_package({"title": f"p{i}"})
        except Exception as exc:                   # pragma: no cover
            errors.append(exc)

    threads = [threading.Thread(target=add, args=(i,)) for i in range(12)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert not errors
    saved = json.load(open(packs.PACKAGES_FILE))
    assert len(saved) == 12 and len({p["id"] for p in saved}) == 12
    assert not [f for f in os.listdir(os.path.dirname(packs.PACKAGES_FILE)) if f.endswith(".tmp")]


# ── VC score parsing ─────────────────────────────────────────────────────────

def test_vc_scores_skip_malformed_entries():
    pytest.importorskip("sqlalchemy")
    try:
        from tools.prionvault.services.vc_generate import _parse_scores
    except Exception as exc:
        pytest.skip(f"vc_generate not importable: {exc}")
    got = _parse_scores({"scores": [{"i": 1, "s": "7.5", "why": "ok"}, {"i": "x", "s": 3},
                                    {"i": 3}, "junk", {"i": 4, "s": None}]})
    assert got == {1: {"s": 7.5, "why": "ok"}}
    assert _parse_scores(["not", "a", "dict"]) == {}


# ── OA fetcher: what counts as "try again later" ─────────────────────────────

def test_oa_transient_reasons():
    pytest.importorskip("sqlalchemy")
    try:
        from tools.prionvault.services.oa_pdf_fetcher import _is_transient
    except Exception as exc:
        pytest.skip(f"oa_pdf_fetcher not importable: {exc}")
    for r in ("unpaywall_lookup_failed", "pmc_timeout", "pmc_http_503", "pmc_http_429"):
        assert _is_transient(r), r
    for r in ("unpaywall_no_oa", "pmc_http_404", "pmc_html", None):
        assert not _is_transient(r), r


# ── Notification email target ────────────────────────────────────────────────

def test_notification_email_forced_to_own_for_non_admins():
    flask = pytest.importorskip("flask")
    pytest.importorskip("sqlalchemy")
    try:
        from tools.prionvault.routes_notifications import _notif_email
    except Exception as exc:
        pytest.skip(f"routes_notifications not importable: {exc}")
    app = flask.Flask(__name__)
    app.secret_key = "t"
    with app.test_request_context():
        flask.session["role"] = "reader"
        assert _notif_email("victim@x.org", "me@lab.es") == "me@lab.es"
        flask.session["role"] = "admin"
        assert _notif_email("other@x.org", "me@lab.es") == "other@x.org"
        assert _notif_email("not an email", "me@lab.es") == "me@lab.es"


# ── Email-digest HTML escaping ───────────────────────────────────────────────

def test_digest_card_escapes_titles():
    pytest.importorskip("sqlalchemy")
    try:
        from tools.prionvault.services.email_digest import _article_card
    except Exception as exc:
        pytest.skip(f"email_digest not importable: {exc}")
    html = _article_card({"title": "PrP <script>x</script> & p<0.05", "authors": "A B",
                          "journal": "J <i>X</i>", "year": 2026, "pmid": "1", "doi": "10.1/a\"b"},
                         "https://h/import")
    assert "<script>" not in html and "&lt;script&gt;" in html
    assert "<i>X</i>" not in html and 'a"b' not in html


# ── Search box field filters ─────────────────────────────────────────────────

def test_search_field_filters_are_parsed():
    pytest.importorskip("sqlalchemy")
    try:
        from tools.prionvault.services.search_v2 import parse_query
    except Exception as exc:
        pytest.skip(f"search_v2 not importable: {exc}")
    rest, f = parse_query('strain autor:castilla año:2024-2020 revista:"acta neuropathol" titulo:PrPSc')
    assert rest == "strain"
    assert f == {"authors": ["castilla"], "year_min": 2020, "year_max": 2024,
                 "journal": ["acta neuropathol"], "title": ["PrPSc"]}
    # unknown prefixes (a DOI, a protein name) stay in the free text
    assert parse_query("doi:10.1000/x PrP:mutant") == ("doi:10.1000/x PrP:mutant", {})
    assert parse_query("año:veinte prion") == ("año:veinte prion", {})
    assert parse_query("plain words") == ("plain words", {})


# ── Self-heal must not put the old search trigger function back ──────────────

def test_self_heal_skips_only_the_search_function_definition():
    """007 (re-run every few minutes by the schema self-heal) defines the
    article search trigger function with its original body. That statement
    must be skipped — but the CREATE TRIGGER that merely references the
    function must still run, or the trigger is dropped and never re-created."""
    import pathlib
    import re
    pytest.importorskip("sqlalchemy")
    try:
        from tools.prionvault.migrate import _split_sql
    except Exception as exc:
        pytest.skip(f"migrate not importable: {exc}")
    src = pathlib.Path(__file__).resolve().parents[1] / "tools" / "prionvault" / "migrate.py"
    pattern = re.search(r're\.match\(r"([^"]+)",\s*\n?\s*stmt, re\.I\)', src.read_text())
    assert pattern, "skip rule not found in migrate.py"
    rx = re.compile(pattern.group(1), re.I)
    sql = (pathlib.Path(__file__).resolve().parents[1] / "migrations" /
           "007_articles_columns_repair.sql").read_text()
    stmts = _split_sql(sql)
    skipped = [s for s in stmts if rx.match(s)]
    assert len(skipped) == 1 and "RETURNS trigger" in skipped[0]
    assert any(s.lstrip().upper().startswith("CREATE TRIGGER ARTICLES_SEARCH_VECTOR_TRG")
               and not rx.match(s) for s in stmts)
