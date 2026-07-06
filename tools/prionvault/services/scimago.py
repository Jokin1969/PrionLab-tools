"""SCImago (SJR) journal quartile rankings.

Import the yearly SCImago CSV (scimagojr.com → "Download data") and look
up a journal's best quartile for the Gobierno Vasco export.

The CSV is ';'-separated with a header. Relevant columns:
  Title, Issn, SJR, SJR Best Quartile, Categories
`Categories` looks like:
  "Cellular and Molecular Neuroscience (Q1); Neurology (Q2)"
so each category carries its own quartile. We parse those, keep the best
(Q1 > Q2 > …) and remember which category it came from.

Matching is by normalized journal title because PrionVault does not store
ISSNs. One DB row per (title_norm, year).
"""
from __future__ import annotations

import csv
import io
import logging
import re
import unicodedata
from typing import Optional

logger = logging.getLogger(__name__)


def _get_engine():
    from ..ingestion.queue import _get_engine as _e
    return _e()


def norm_title(s: str) -> str:
    """Lowercase, strip accents/punctuation, collapse spaces, drop a
    leading article, so 'Acta Neuropathol. Communications' and
    'Acta Neuropathologica Communications' have a chance to line up."""
    if not s:
        return ""
    s = unicodedata.normalize('NFD', s).encode('ascii', 'ignore').decode('ascii')
    s = s.lower()
    s = re.sub(r'[^a-z0-9]+', ' ', s).strip()
    s = re.sub(r'^(the|la|el|los|las|le|les)\s+', '', s)
    return re.sub(r'\s+', ' ', s).strip()


_CAT_RE = re.compile(r'^(.*?)\s*\(Q([1-4])\)\s*$')


def _parse_categories(cat_field: str) -> list[dict]:
    """Parse 'Neurology (Q1); Pathology (Q2)' → [{category, quartile}]."""
    out = []
    for part in (cat_field or "").split(';'):
        part = part.strip()
        if not part:
            continue
        m = _CAT_RE.match(part)
        if m:
            out.append({"category": m.group(1).strip(),
                        "quartile": f"Q{m.group(2)}"})
    return out


def _best(categories: list[dict], fallback_q: str) -> tuple[Optional[str], Optional[str]]:
    """Return (best_quartile, best_category). Best = lowest Q number."""
    best = None
    for c in categories:
        q = c["quartile"]
        if best is None or q < best[0]:   # 'Q1' < 'Q2' lexicographically
            best = (q, c["category"])
    if best:
        return best
    fb = (fallback_q or "").strip().upper()
    if re.match(r'^Q[1-4]$', fb):
        return fb, None
    return None, None


def _split_issns(raw: str) -> list[str]:
    return [re.sub(r'[^0-9Xx]', '', p).upper()
            for p in (raw or "").split(',') if re.sub(r'[^0-9Xx]', '', p)]


# ── Import ────────────────────────────────────────────────────────────────────

_import_state = {"running": False, "year": None, "rows": 0,
                 "quartiled": 0, "error": None}


def import_state() -> dict:
    return dict(_import_state)


def run_import(content: str, year: int) -> None:
    """Background-thread entry point: import + record progress/errors."""
    _import_state.update(running=True, year=year, error=None,
                         rows=0, quartiled=0)
    try:
        res = import_csv(content, year)
        _import_state.update(rows=res["rows"], quartiled=res["quartiled"])
        logger.info("scimago: imported %s rows for %s", res["rows"], year)
    except Exception as exc:
        logger.exception("scimago import failed")
        _import_state.update(error=str(exc)[:300])
    finally:
        _import_state.update(running=False)


def import_csv(content: str, year: int) -> dict:
    """Parse a SCImago yearly CSV and upsert its rows for `year`.
    Returns {rows, quartiled, year}."""
    # SCImago uses ';' as delimiter. Sniff just in case a comma variant
    # slips in, but default to ';'.
    sample = content[:4000]
    delim = ';' if sample.count(';') >= sample.count(',') else ','
    reader = csv.DictReader(io.StringIO(content), delimiter=delim)

    # Case-insensitive column resolution.
    def _col(row, *names):
        for n in names:
            for k in row:
                if k and k.strip().lower() == n.lower():
                    return row[k]
        return ""

    batch: list[dict] = []
    quartiled = 0
    seen: set = set()
    for row in reader:
        title = (_col(row, "Title") or "").strip()
        if not title:
            continue
        tn = norm_title(title)
        if not tn or (tn, year) in seen:
            continue
        seen.add((tn, year))
        cats = _parse_categories(_col(row, "Categories"))
        bq, bc = _best(cats, _col(row, "SJR Best Quartile"))
        if bq:
            quartiled += 1
        batch.append({
            "title_norm": tn,
            "title":      title,
            "issns":      _split_issns(_col(row, "Issn")),
            "year":       year,
            "best_quartile": bq,
            "best_category": bc,
            "categories": cats,
            "sjr":        (_col(row, "SJR") or "").strip() or None,
        })

    _upsert(batch)
    return {"rows": len(batch), "quartiled": quartiled, "year": year}


def _upsert(batch: list[dict]) -> None:
    if not batch:
        return
    import json as _json
    from sqlalchemy import text as _sql
    eng = _get_engine()
    CHUNK = 500
    with eng.begin() as conn:
        for i in range(0, len(batch), CHUNK):
            for r in batch[i:i + CHUNK]:
                conn.execute(_sql("""
                    INSERT INTO journal_ranking
                        (title_norm, title, issns, year, best_quartile,
                         best_category, categories, sjr, source, updated_at)
                    VALUES (:tn, :ti, CAST(:iss AS jsonb), :yr, :bq, :bc,
                            CAST(:cats AS jsonb), :sjr, 'scimago', NOW())
                    ON CONFLICT (title_norm, year) DO UPDATE SET
                        title         = EXCLUDED.title,
                        issns         = EXCLUDED.issns,
                        best_quartile = EXCLUDED.best_quartile,
                        best_category = EXCLUDED.best_category,
                        categories    = EXCLUDED.categories,
                        sjr           = EXCLUDED.sjr,
                        updated_at    = NOW()
                """), {
                    "tn": r["title_norm"], "ti": r["title"],
                    "iss": _json.dumps(r["issns"]), "yr": r["year"],
                    "bq": r["best_quartile"], "bc": r["best_category"],
                    "cats": _json.dumps(r["categories"]),
                    "sjr": r["sjr"],
                })


# ── Lookup ────────────────────────────────────────────────────────────────────

def lookup_quartile(journal: str, year: Optional[int] = None) -> Optional[dict]:
    """Return {quartile, category, year, database} for a journal, choosing
    the ranking year closest to (and not after) `year` when possible.
    None when the journal isn't in the imported data."""
    tn = norm_title(journal or "")
    if not tn:
        return None
    from sqlalchemy import text as _sql
    eng = _get_engine()
    try:
        with eng.connect() as conn:
            rows = conn.execute(_sql("""
                SELECT year, best_quartile, best_category
                  FROM journal_ranking
                 WHERE title_norm = :tn AND best_quartile IS NOT NULL
                 ORDER BY year
            """), {"tn": tn}).all()
    except Exception as exc:
        logger.warning("scimago lookup failed for %r: %s", journal, exc)
        return None
    if not rows:
        return None

    chosen = None
    if year:
        exact = [r for r in rows if r[0] == year]
        older = [r for r in rows if r[0] <= year]
        if exact:
            chosen = exact[0]
        elif older:
            chosen = older[-1]         # latest year not after the article
    if chosen is None:
        chosen = rows[-1]              # latest available overall

    return {
        "quartile": chosen[1],
        "category": chosen[2],
        "year":     chosen[0],
        "database": "SCImago (SJR)",
    }


def stats() -> dict:
    """Per-year row counts for the admin panel."""
    from sqlalchemy import text as _sql
    eng = _get_engine()
    try:
        with eng.connect() as conn:
            rows = conn.execute(_sql("""
                SELECT year, COUNT(*) AS total,
                       COUNT(*) FILTER (WHERE best_quartile IS NOT NULL) AS quartiled
                  FROM journal_ranking
                 GROUP BY year ORDER BY year DESC
            """)).mappings().all()
        return {"years": [dict(r) for r in rows],
                "total": sum(r["total"] for r in rows)}
    except Exception as exc:
        logger.warning("scimago stats failed: %s", exc)
        return {"years": [], "total": 0}


def clear_year(year: int) -> int:
    from sqlalchemy import text as _sql
    eng = _get_engine()
    with eng.begin() as conn:
        res = conn.execute(_sql(
            "DELETE FROM journal_ranking WHERE year = :y"), {"y": year})
    return res.rowcount or 0
