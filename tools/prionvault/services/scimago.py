"""SCImago (SJR) journal rankings — download, parse, percentiles, lookup.

Powers the automatic quality indicators in the Gobierno Vasco export.

Flow (no manual work needed):
  * download_year(year) fetches the yearly SCImago CSV straight from
    scimagojr.com, parses it, computes per-category percentiles/deciles,
    stores everything in Postgres, and archives the raw CSV to Dropbox.
  * lookup(journal, year) returns the best quartile + decile + percentile
    for a journal plus its ISSN and country (Publication place).

The SCImago CSV is ';'-separated (decimal comma) with columns including
Title, Issn, SJR, SJR Best Quartile, Categories, Country. `Categories`
looks like "Neurology (Q1); Pathology (Q2)". Matching is by normalized
journal title because PrionVault stores no ISSN.
"""
from __future__ import annotations

import csv
import io
import logging
import re
import threading
import unicodedata
from typing import Optional

logger = logging.getLogger(__name__)

# SCImago exposes the yearly ranking as a (semicolon) CSV at this URL
# despite the out=xls name.
_SCIMAGO_URL = "https://www.scimagojr.com/journalrank.php?out=xls&year={year}"
# Where the raw CSV backup lands in Dropbox.
_DROPBOX_DIR = "/PrionLab tools/SCImago"


def _get_engine():
    from ..ingestion.queue import _get_engine as _e
    return _e()


def norm_title(s: str) -> str:
    """Lowercase, strip accents/punctuation, collapse spaces, drop a
    leading article, so journal names line up despite formatting."""
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


def _parse_sjr(raw: str) -> float:
    """SCImago prints SJR with a decimal comma ('2,500'). Return a float."""
    s = (raw or "").strip().replace('.', '').replace(',', '.')
    try:
        return float(s) if s else 0.0
    except ValueError:
        return 0.0


def _format_issn(issns: list[str]) -> Optional[str]:
    """Return the first ISSN as XXXX-XXXX (SCImago stores them dash-less)."""
    for raw in issns:
        digits = re.sub(r'[^0-9Xx]', '', raw).upper()
        if len(digits) == 8:
            return f"{digits[:4]}-{digits[4:]}"
    return None


def _split_issns(raw: str) -> list[str]:
    return [re.sub(r'[^0-9Xx]', '', p).upper()
            for p in (raw or "").split(',') if re.sub(r'[^0-9Xx]', '', p)]


# ── State (shared by upload + auto-download background jobs) ───────────────────

_import_state = {"running": False, "year": None, "rows": 0,
                 "quartiled": 0, "error": None, "phase": None}
_state_lock = threading.Lock()


def import_state() -> dict:
    with _state_lock:
        return dict(_import_state)


def begin_import(year=None) -> bool:
    """Atomically claim the single import slot. Returns False (without
    changing anything) when an import is already running, so overlapping
    requests are rejected cleanly instead of clobbering each other."""
    with _state_lock:
        if _import_state["running"]:
            return False
        _import_state.update(running=True, year=year, error=None, rows=0,
                             quartiled=0, phase="starting")
        return True


def _finish_import(**kw) -> None:
    with _state_lock:
        _import_state.update(kw)
        _import_state["running"] = False
        _import_state["phase"] = None


def _set_phase(**kw) -> None:
    with _state_lock:
        _import_state.update(kw)


# ── Download from SCImago ──────────────────────────────────────────────────────

# A realistic browser UA + a warm-up request are needed: SCImago's
# download endpoint 403s bare/bot-looking requests.
_BROWSER_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/122.0.0.0 Safari/537.36"),
    "Accept": ("text/csv,application/vnd.ms-excel,text/html,"
               "application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
    "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
    "Referer": "https://www.scimagojr.com/journalrank.php",
}


def _do_download_year(year: int) -> dict:
    """Fetch + import + Dropbox-backup one year. Raises on failure."""
    import requests
    session = requests.Session()
    session.headers.update(_BROWSER_HEADERS)
    # Warm-up: visit the ranking page first so SCImago sets its cookies;
    # the CSV endpoint 403s otherwise. Best-effort — ignore its failures.
    try:
        session.get("https://www.scimagojr.com/journalrank.php",
                    timeout=60)
    except Exception:
        pass

    url = _SCIMAGO_URL.format(year=year)
    resp = session.get(url, timeout=120)
    if resp.status_code == 403:
        raise RuntimeError(
            f"SCImago rechazó la descarga de {year} (403). Puede que ese año "
            f"aún no esté publicado o que el sitio esté bloqueando la petición. "
            f"Prueba otro año o usa la subida manual del CSV.")
    resp.raise_for_status()
    content = resp.content.decode("utf-8-sig", errors="replace")
    if "Title" not in content[:2000] and "Rank" not in content[:2000]:
        raise RuntimeError("La respuesta de SCImago no parece un CSV válido "
                           "(¿aún no hay datos para ese año?).")
    res = import_csv(content, year)
    _backup_to_dropbox(resp.content, year)
    logger.info("scimago: downloaded+imported %s rows for %s", res["rows"], year)
    return res


def download_year(year: int) -> None:
    """Background worker: fetch one year from SCImago. Caller must have
    claimed the slot via begin_import()."""
    _set_phase(phase="downloading")
    try:
        res = _do_download_year(year)
        _finish_import(rows=res["rows"], quartiled=res["quartiled"])
    except Exception as exc:
        logger.exception("scimago download failed for %s", year)
        _finish_import(error=str(exc)[:300])


def run_download_years(years: list) -> None:
    """Background worker: fetch several years sequentially. Caller must
    have claimed the slot via begin_import()."""
    years = [int(y) for y in years]
    _set_phase(phase="downloading")
    errors = []
    total = 0
    for y in years:
        _set_phase(year=y, phase="downloading")
        try:
            res = _do_download_year(y)
            total += res["rows"]
        except Exception as exc:
            logger.warning("scimago: year %s failed: %s", y, exc)
            errors.append(f"{y}: {str(exc)[:120]}")
    _finish_import(rows=total, year=None,
                   error="; ".join(errors) if errors else None)


def run_import(content: str, year: int) -> None:
    """Background worker for a MANUAL CSV upload. The caller must have
    already claimed the slot via begin_import()."""
    _set_phase(phase="parsing")
    try:
        res = import_csv(content, year)
        _finish_import(rows=res["rows"], quartiled=res["quartiled"])
    except Exception as exc:
        logger.exception("scimago import failed")
        _finish_import(error=str(exc)[:300])


def _backup_to_dropbox(raw: bytes, year: int) -> None:
    try:
        from core.dropbox_client import get_client
        import dropbox
        dbx = get_client()
        if not dbx:
            return
        path = f"{_DROPBOX_DIR}/scimago_{year}.csv"
        dbx.files_upload(raw, path, mode=dropbox.files.WriteMode.overwrite)
    except Exception as exc:
        logger.warning("scimago: Dropbox backup failed for %s: %s", year, exc)


# ── Import + percentile computation ────────────────────────────────────────────

def import_csv(content: str, year: int) -> dict:
    """Parse a SCImago yearly CSV, compute per-category percentiles/deciles,
    and upsert. Returns {rows, quartiled, year}."""
    sample = content[:4000]
    delim = ';' if sample.count(';') >= sample.count(',') else ','
    reader = csv.DictReader(io.StringIO(content), delimiter=delim)

    def _col(row, *names):
        for n in names:
            for k in row:
                if k and k.strip().lower() == n.lower():
                    return row[k]
        return ""

    # Pass 1 — parse every journal.
    journals: list[dict] = []
    seen: set = set()
    for row in reader:
        title = (_col(row, "Title") or "").strip()
        if not title:
            continue
        tn = norm_title(title)
        if not tn or tn in seen:
            continue
        seen.add(tn)
        journals.append({
            "title_norm": tn,
            "title":      title,
            "issns":      _split_issns(_col(row, "Issn")),
            "country":    (_col(row, "Country") or "").strip() or None,
            "sjr":        _parse_sjr(_col(row, "SJR")),
            "sjr_raw":    (_col(row, "SJR") or "").strip() or None,
            "categories": _parse_categories(_col(row, "Categories")),
            "best_q_hint": (_col(row, "SJR Best Quartile") or "").strip(),
        })

    # Pass 2 — per-category ranking → percentile + decile.
    # Group journal indices by category, sort by SJR desc, assign.
    by_cat: dict[str, list[int]] = {}
    for i, j in enumerate(journals):
        for c in j["categories"]:
            by_cat.setdefault(c["category"], []).append(i)
    for cat, idxs in by_cat.items():
        idxs.sort(key=lambda i: journals[i]["sjr"], reverse=True)
        n = len(idxs)
        for rank, i in enumerate(idxs):           # rank 0 = top journal
            pct = round((n - rank) / n * 100, 1)   # 100 = top, →0 = bottom
            dec = min(10, int(rank / n * 10) + 1)  # D1 = top decile
            for c in journals[i]["categories"]:
                if c["category"] == cat:
                    c["percentile"] = pct
                    c["decile"] = f"D{dec}"

    # Pass 3 — pick each journal's best category (best quartile, then
    # highest percentile) and build the DB rows.
    batch: list[dict] = []
    quartiled = 0
    for j in journals:
        cats = j["categories"]
        best = None
        for c in cats:
            if "quartile" not in c:
                continue
            key = (c["quartile"], -(c.get("percentile") or 0))
            if best is None or key < best[0]:
                best = (key, c)
        bq = bc = bp = bd = None
        if best:
            bq = best[1]["quartile"]
            bc = best[1]["category"]
            bp = best[1].get("percentile")
            bd = best[1].get("decile")
            quartiled += 1
        elif re.match(r'^Q[1-4]$', j["best_q_hint"].upper()):
            bq = j["best_q_hint"].upper()
        batch.append({
            "title_norm":  j["title_norm"],
            "title":       j["title"],
            "issns":       j["issns"],
            "primary_issn": _format_issn(j["issns"]),
            "country":     j["country"],
            "year":        year,
            "best_quartile": bq,
            "best_category": bc,
            "best_percentile": bp,
            "best_decile": bd,
            "categories":  cats,
            "sjr":         j["sjr_raw"],
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
                        (title_norm, title, issns, primary_issn, country, year,
                         best_quartile, best_category, best_percentile,
                         best_decile, categories, sjr, source, updated_at)
                    VALUES (:tn, :ti, CAST(:iss AS jsonb), :pi, :co, :yr,
                            :bq, :bc, :bp, :bd, CAST(:cats AS jsonb), :sjr,
                            'scimago', NOW())
                    ON CONFLICT (title_norm, year) DO UPDATE SET
                        title           = EXCLUDED.title,
                        issns           = EXCLUDED.issns,
                        primary_issn    = EXCLUDED.primary_issn,
                        country         = EXCLUDED.country,
                        best_quartile   = EXCLUDED.best_quartile,
                        best_category   = EXCLUDED.best_category,
                        best_percentile = EXCLUDED.best_percentile,
                        best_decile     = EXCLUDED.best_decile,
                        categories      = EXCLUDED.categories,
                        sjr             = EXCLUDED.sjr,
                        updated_at      = NOW()
                """), {
                    "tn": r["title_norm"], "ti": r["title"],
                    "iss": _json.dumps(r["issns"]), "pi": r["primary_issn"],
                    "co": r["country"], "yr": r["year"],
                    "bq": r["best_quartile"], "bc": r["best_category"],
                    "bp": r["best_percentile"], "bd": r["best_decile"],
                    "cats": _json.dumps(r["categories"]), "sjr": r["sjr"],
                })


# ── Lookup ────────────────────────────────────────────────────────────────────

def lookup(journal: str, year: Optional[int] = None) -> Optional[dict]:
    """Return quality data for a journal (best quartile + decile +
    percentile + ISSN + country), choosing the ranking year closest to
    (not after) `year`. None when the journal isn't in the imported data."""
    tn = norm_title(journal or "")
    if not tn:
        return None
    from sqlalchemy import text as _sql
    eng = _get_engine()
    try:
        with eng.connect() as conn:
            rows = conn.execute(_sql("""
                SELECT year, best_quartile, best_category, best_percentile,
                       best_decile, primary_issn, country
                  FROM journal_ranking
                 WHERE title_norm = :tn
                 ORDER BY year
            """), {"tn": tn}).mappings().all()
    except Exception as exc:
        logger.warning("scimago lookup failed for %r: %s", journal, exc)
        return None
    if not rows:
        return None

    chosen = None
    if year:
        exact = [r for r in rows if r["year"] == year]
        older = [r for r in rows if r["year"] <= year]
        if exact:
            chosen = exact[0]
        elif older:
            chosen = older[-1]
    if chosen is None:
        chosen = rows[-1]

    return {
        "quartile":   chosen["best_quartile"],
        "category":   chosen["best_category"],
        "percentile": (float(chosen["best_percentile"])
                       if chosen["best_percentile"] is not None else None),
        "decile":     chosen["best_decile"],
        "issn":       chosen["primary_issn"],
        "country":    chosen["country"],
        "year":       chosen["year"],
        "database":   "SCImago (SJR)",
    }


# Backwards-compatible alias for older callers.
def lookup_quartile(journal: str, year: Optional[int] = None) -> Optional[dict]:
    return lookup(journal, year)


def stats() -> dict:
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
