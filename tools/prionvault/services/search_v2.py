"""Search v2 helpers for the article listing.

- `parse_query`     — field filters typed in the search box
                      (autor:castilla año:2020-2024 revista:nature titulo:"…").
- `did_you_mean`    — typo suggestion when a search finds nothing (pg_trgm
                      word similarity against titles and authors).
- `snippets`        — where each result matched, with the hit marked.
- `start_backfill`  — fills search_vector2/rank_vector (migration 112) for
                      the articles that existed before it, in small batches.
"""
from __future__ import annotations

import difflib
import logging
import re
import threading
import time
import unicodedata
from typing import Optional

from sqlalchemy import text as sql_text

logger = logging.getLogger(__name__)

TS_CONFIG = "pv_search"

# ── Field filters in the search box ──────────────────────────────────────────

_FIELD_ALIASES = {
    "autor": "authors", "autores": "authors", "author": "authors", "authors": "authors", "au": "authors",
    "año": "year", "ano": "year", "anio": "year", "year": "year", "y": "year",
    "revista": "journal", "journal": "journal", "j": "journal",
    "titulo": "title", "título": "title", "title": "title", "ti": "title",
}
_FIELD_RE = re.compile(r'(?<!\S)([A-Za-zñÑáéíóúÁÉÍÓÚ]{1,8}):(?:"([^"]*)"|(\S+))')


def parse_query(q: str) -> tuple[str, dict]:
    """Split `autor:x año:2020-2024 revista:y titulo:"z" free words` into
    (free words, {"authors": [...], "journal": [...], "title": [...],
    "year_min": int, "year_max": int}). Unknown prefixes (e.g. a DOI such as
    "doi:10.1/x", or "PrP:…") are left in the free text untouched."""
    fields: dict = {}
    if not q or ":" not in q:
        return q, fields

    def repl(m):
        key = _FIELD_ALIASES.get(m.group(1).lower())
        value = (m.group(2) if m.group(2) is not None else m.group(3) or "").strip()
        if not key or not value:
            return m.group(0)
        if key == "year":
            ym = re.fullmatch(r"(\d{4})(?:\s*[-–]\s*(\d{4}))?", value)
            if not ym:
                return m.group(0)
            a, b = int(ym.group(1)), int(ym.group(2) or ym.group(1))
            fields["year_min"], fields["year_max"] = min(a, b), max(a, b)
        else:
            fields.setdefault(key, []).append(value)
        return " "

    rest = re.sub(r"\s+", " ", _FIELD_RE.sub(repl, q)).strip()
    return rest, fields


# ── "Did you mean" ───────────────────────────────────────────────────────────

def _fold(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s or "") if not unicodedata.combining(c)).lower()


def did_you_mean(conn, q: str) -> Optional[str]:
    """A corrected query when some word looks like a typo of a word that
    does appear in titles/authors; None when there is nothing better."""
    words = q.split()
    if not words or len(words) > 8:
        return None
    out, changed = [], False
    for w in words:
        bare = w.strip('"()')
        if len(bare) < 4 or not bare.isalpha() or bare.upper() in ("AND", "OR", "NOT"):
            out.append(w)
            continue
        best = None
        try:
            # Looser than the default 0.6 so one wrong letter still matches
            # ("amiloid" → "amyloid"); scoped to this transaction.
            conn.execute(sql_text("SET LOCAL pg_trgm.word_similarity_threshold = 0.35"))
            rows = conn.execute(sql_text("""
                SELECT txt FROM (
                    SELECT title AS txt, word_similarity(:w, title) AS s
                      FROM articles WHERE :w <% title
                    UNION ALL
                    SELECT authors AS txt, word_similarity(:w, authors) AS s
                      FROM articles WHERE :w <% authors
                ) t ORDER BY s DESC LIMIT 25"""), {"w": bare}).all()
        except Exception as exc:
            logger.debug("did_you_mean: similarity query failed: %s", exc)
            return None
        vocab: dict[str, str] = {}
        for (txt,) in rows:
            for tok in re.findall(r"[^\W\d_]{4,}", txt or ""):
                vocab.setdefault(_fold(tok), tok)
        target = _fold(bare)
        if target in vocab:               # the word exists: not a typo
            out.append(w)
            continue
        close = difflib.get_close_matches(target, list(vocab), n=1, cutoff=0.75)
        if close:
            best = vocab[close[0]]
        if best and _fold(best) != target:
            out.append(best.lower() if bare.islower() else best)
            changed = True
        else:
            out.append(w)
    return " ".join(out) if changed else None


# ── Snippets ─────────────────────────────────────────────────────────────────

_HL = "StartSel=[[[, StopSel=]]], MaxFragments=1, MaxWords=22, MinWords=8, ShortWord=2"
_MAX_SNIPPETS = 60
_MAX_PDF_SNIPPETS = 25


def snippets(conn, ids: list[str], q: str) -> dict:
    """{article_id: {"where": "abstract"|"summary"|"pdf", "text": "… [[[hit]]] …"}}
    for results whose match is NOT already visible in the title. The markers
    are plain text; the client escapes the text and turns them into <mark>."""
    ids = [str(i) for i in ids][:_MAX_SNIPPETS]
    if not ids or not q.strip():
        return {}
    out: dict = {}
    rows = conn.execute(sql_text(f"""
        WITH qq AS (SELECT websearch_to_tsquery('{TS_CONFIG}', :q) AS tq)
        SELECT a.id::text,
               to_tsvector('{TS_CONFIG}', coalesce(a.title, '')) @@ qq.tq    AS in_title,
               to_tsvector('{TS_CONFIG}', coalesce(a.abstract, '')) @@ qq.tq AS in_abstract,
               to_tsvector('{TS_CONFIG}', coalesce(a.summary_ai, '')) @@ qq.tq AS in_summary,
               CASE WHEN to_tsvector('{TS_CONFIG}', coalesce(a.abstract, '')) @@ qq.tq
                    THEN ts_headline('{TS_CONFIG}', a.abstract, qq.tq, '{_HL}') END AS h_abs,
               CASE WHEN NOT (to_tsvector('{TS_CONFIG}', coalesce(a.abstract, '')) @@ qq.tq)
                     AND to_tsvector('{TS_CONFIG}', coalesce(a.summary_ai, '')) @@ qq.tq
                    THEN ts_headline('{TS_CONFIG}', a.summary_ai, qq.tq, '{_HL}') END AS h_sum
          FROM articles a, qq
         WHERE a.id = ANY(CAST(:ids AS uuid[]))"""), {"q": q, "ids": ids}).mappings().all()
    pdf_ids = []
    for r in rows:
        if r["h_abs"]:
            out[r["id"]] = {"where": "abstract", "text": r["h_abs"]}
        elif r["h_sum"]:
            out[r["id"]] = {"where": "summary", "text": r["h_sum"]}
        elif not r["in_title"]:
            pdf_ids.append(r["id"])
    if pdf_ids:
        # Only for results that matched nowhere visible: look in the PDF text
        # (bounded: ts_headline has to parse the text it is given).
        prow = conn.execute(sql_text(f"""
            WITH qq AS (SELECT websearch_to_tsquery('{TS_CONFIG}', :q) AS tq)
            SELECT a.id::text,
                   ts_headline('{TS_CONFIG}', left(a.extracted_text, 300000), qq.tq, '{_HL}') AS h
              FROM articles a, qq
             WHERE a.id = ANY(CAST(:ids AS uuid[]))
               AND a.extracted_text IS NOT NULL
               AND a.search_vector2 @@ qq.tq"""),
            {"q": q, "ids": pdf_ids[:_MAX_PDF_SNIPPETS]}).all()
        for aid, h in prow:
            if h and "[[[" in h:
                out[aid] = {"where": "pdf", "text": re.sub(r"\s+", " ", h).strip()}
    return out


# ── Backfill of the v2 vectors ───────────────────────────────────────────────

_state = {"running": False, "done": 0, "pending": None, "last_error": None}
_BATCH = 50


def _engine():
    from ..ingestion.queue import _get_engine
    return _get_engine()


_UPDATE_SQL = """
    UPDATE articles a
       SET search_vector2 = pv_build_search_vector2(a.title, a.abstract, a.summary_ai,
                                a.summary_human, a.authors, a.journal, a.extracted_text),
           rank_vector    = pv_build_rank_vector(a.title, a.authors, a.abstract, a.journal)
     WHERE a.id = ANY(CAST(:ids AS uuid[]))"""


def backfill_once() -> Optional[int]:
    """Fill the v2 vectors of every article that lacks them. Returns how
    many rows were processed (0 when up to date or not migrated yet)."""
    eng = _engine()
    with eng.connect() as conn:
        has = conn.execute(sql_text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = 'articles' AND column_name = 'search_vector2'")).first()
    if not has:
        return None                # migration 112 not applied yet: try again later
    total = 0
    while True:
        with eng.connect() as conn:
            ids = [str(r[0]) for r in conn.execute(sql_text(
                "SELECT id FROM articles WHERE search_vector2 IS NULL LIMIT :n"), {"n": _BATCH})]
        if not ids:
            break
        try:
            with eng.begin() as conn:
                conn.execute(sql_text(_UPDATE_SQL), {"ids": ids})
        except Exception as exc:
            # One bad document must not stall the rest: go one by one and
            # mark the offender as done with an empty vector.
            logger.warning("search_v2 backfill: batch failed (%s) — retrying row by row", exc)
            for aid in ids:
                try:
                    with eng.begin() as conn:
                        conn.execute(sql_text(_UPDATE_SQL), {"ids": [aid]})
                except Exception as exc2:
                    _state["last_error"] = str(exc2)[:200]
                    with eng.begin() as conn:
                        conn.execute(sql_text(
                            "UPDATE articles SET search_vector2 = ''::tsvector, "
                            "rank_vector = pv_build_rank_vector(title, authors, abstract, journal) "
                            "WHERE id = CAST(:id AS uuid)"), {"id": aid})
        total += len(ids)
        _state["done"] += len(ids)
        time.sleep(0.3)          # leave room for normal traffic
    return total


def status() -> dict:
    snap = dict(_state)
    try:
        with _engine().connect() as conn:
            snap["pending"] = conn.execute(sql_text(
                "SELECT COUNT(*) FROM articles WHERE search_vector2 IS NULL")).scalar()
    except Exception:
        snap["pending"] = None
    return snap


def start_backfill(delay_s: float = 90.0) -> None:
    """Background thread: waits for the boot migrations, then backfills.
    Runs in one gunicorn worker at a time (advisory lock)."""
    def run():
        time.sleep(delay_s)
        for _attempt in range(12):
            try:
                from database.singleton import run_once
                _state["running"] = True
                n = run_once("pv_search_v2_backfill", backfill_once)
                if n:
                    logger.info("search_v2 backfill: %s article(s) indexed", n)
                _state["running"] = False
                if n is not None:
                    return
            except Exception as exc:
                _state["running"] = False
                _state["last_error"] = str(exc)[:200]
                logger.warning("search_v2 backfill failed: %s", exc)
            time.sleep(300)
    threading.Thread(target=run, name="prionvault-search-v2-backfill", daemon=True).start()


_unaccent_ok: Optional[bool] = None


def has_unaccent(conn) -> bool:
    """Whether the unaccent() function can be used (cached once true)."""
    global _unaccent_ok
    if _unaccent_ok:
        return True
    try:
        _unaccent_ok = bool(conn.execute(sql_text(
            "SELECT 1 FROM pg_extension WHERE extname = 'unaccent'")).first())
    except Exception:
        _unaccent_ok = False
    return bool(_unaccent_ok)
