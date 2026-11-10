"""Vigilancia competitiva — AI generator for the current year's report.

Three user-triggered steps, each a background job (they make dozens of LLM
calls), mirroring how the lab writes the report by hand:

1. select  — gather every candidate paper of the year (PrionVault's PubMed
             inventory + the library), screen titles in batches, fetch the
             abstracts of the best ~120 and let the strongest model score
             them (impact, novelty, relevance to the group; SCImago
             quartile as a signal). Top N (default 38) are pre-selected;
             the user can then add/remove papers.
2. themes  — group the selected papers into 4–6 themes, with the previous
             reports (and what last year's report expected for this year)
             as memory, so the narrative shows continuity.
3. write   — draft the report in the required format (title, authors,
             ¼ context / ½ advances with "(PMID: …)" citations / ¼ outlook),
             in the style of past reports, ≤ 3,500 characters, validated
             and automatically revised until it complies.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import xml.etree.ElementTree as ET
from datetime import datetime
from typing import Optional

from sqlalchemy import text as sql_text

from ..ingestion.queue import _get_engine
from . import job_lock as _job_lock

logger = logging.getLogger(__name__)

AUTHORS = "Joaquín Castilla and Hasier Eraña, Prion Research Laboratory"
MAX_CHARS = 3500
N_FINAL = 38
N_SHORTLIST = 120
_PROVIDERS = ["anthropic", "openai", "gemini"]
_STRONG = {"anthropic": "claude-opus-5"}        # "mucha potencia de IA"

_lock = threading.Lock()
_state: dict = {"running": False, "step": None, "phase": None, "done": 0, "total": 0,
                "started_at": None, "finished_at": None, "last_error": None,
                "stop_requested": False, "result": None}

_GUIDELINES = f"""Report guidelines (ISO 56001 "Vigilancia competitiva", institute's Scientific Annual Review):
- Length: maximum {MAX_CHARS:,} characters INCLUDING spaces (body text; title and author line excluded). Aim for 3,300–3,480.
- References: PMID references in brackets directly within the text, e.g. "(PMID: 30289599)" or several "(PMID: 39440977, 39396118)". No reference list.
- Format: Title (descriptive) · Author line · three paragraphs:
  1. ~1/4 of the length: the research area and its global challenges, in layman's terms.
  2. ~1/2 of the length: the major scientific advances of the year, with references to key publications.
  3. ~1/4 of the length: expectations for the coming year; scientific and societal opportunities.
- It will be reviewed for editorial consistency: do NOT copy sentences from previous years; write fresh, coherent, high-quality prose."""


def _call(system: str, user: str, *, strong: bool, max_tokens: int, timeout: float = 240) -> dict:
    from .llm_pool import call_llm_json_with_fallback
    parsed, _info = call_llm_json_with_fallback(
        providers=_PROVIDERS, system=system, user=user, max_tokens=max_tokens,
        models=_STRONG if strong else None, timeout=timeout, max_attempts=1)
    return parsed if isinstance(parsed, dict) else {}


def _set(**kw) -> None:
    with _lock:
        _state.update(kw)


def _stopped() -> bool:
    with _lock:
        return bool(_state["stop_requested"])


# ── Report row ───────────────────────────────────────────────────────────────

def ensure_draft(year: int) -> None:
    with _get_engine().begin() as conn:
        conn.execute(sql_text("""
            INSERT INTO prionvault_vc_report (year, title, authors, body, status)
            VALUES (:y, '', :a, '', 'draft') ON CONFLICT (year) DO NOTHING"""),
            {"y": year, "a": AUTHORS})


def _log(year: int, step: str, info: dict) -> None:
    with _get_engine().begin() as conn:
        conn.execute(sql_text("""
            UPDATE prionvault_vc_report
               SET pipeline = jsonb_set(coalesce(pipeline, '{}'::jsonb), ARRAY[:k],
                                        CAST(:v AS jsonb), true),
                   updated_at = NOW()
             WHERE year = :y"""),
            {"y": year, "k": step,
             "v": json.dumps({**info, "at": datetime.utcnow().isoformat()}, ensure_ascii=False)})


# ── Step 1: selection ────────────────────────────────────────────────────────

def _gather_candidates(year: int) -> int:
    """Upsert the year's candidates (inventory + library) into vc_item."""
    eng = _get_engine()
    with eng.connect() as conn:
        inv = conn.execute(sql_text("""
            SELECT pmid, title, authors, journal, doi, year FROM prionvault_pubmed_inventory
             WHERE year = :y AND NOT dismissed AND title IS NOT NULL"""), {"y": year}).mappings().all()
        lib = conn.execute(sql_text("""
            SELECT id, pubmed_id AS pmid, title, authors, journal, doi, year, abstract FROM articles
             WHERE year = :y AND title IS NOT NULL"""), {"y": year}).mappings().all()
    by_pmid = {}
    by_doi = {}
    for r in lib:
        d = dict(r)
        d["in_library"] = True
        if d.get("pmid"):
            by_pmid[str(d["pmid"])] = d
        elif d.get("doi"):
            by_doi[d["doi"].lower()] = d
    for r in inv:
        d = dict(r)
        p = str(d["pmid"])
        if p in by_pmid:
            continue
        if d.get("doi") and d["doi"].lower() in by_doi:
            lib_row = by_doi.pop(d["doi"].lower())
            lib_row["pmid"] = p
            by_pmid[p] = lib_row
            continue
        d["in_library"] = False
        by_pmid[p] = d
    rows = list(by_pmid.values()) + list(by_doi.values())
    with eng.begin() as conn:
        for d in rows:
            params = {"y": year, "pmid": str(d["pmid"]) if d.get("pmid") else None,
                      "doi": (d.get("doi") or "").lower() or None,
                      "aid": str(d["id"]) if d.get("id") else None,
                      "t": d.get("title") or "", "a": (d.get("authors") or "")[:2000],
                      "j": d.get("journal") or "", "py": d.get("year"),
                      "lib": bool(d.get("in_library")), "abs": d.get("abstract")}
            if params["pmid"]:
                conn.execute(sql_text("""
                    INSERT INTO prionvault_vc_item (year, pmid, doi, article_id, title, authors,
                                                    journal, pub_year, in_library, abstract)
                    VALUES (:y, :pmid, :doi, :aid, :t, :a, :j, :py, :lib, :abs)
                    ON CONFLICT (year, pmid) WHERE pmid IS NOT NULL DO UPDATE
                       SET in_library = EXCLUDED.in_library OR prionvault_vc_item.in_library,
                           article_id = coalesce(prionvault_vc_item.article_id, EXCLUDED.article_id),
                           abstract   = coalesce(prionvault_vc_item.abstract, EXCLUDED.abstract)"""),
                    params)
            elif not conn.execute(sql_text(
                    "SELECT 1 FROM prionvault_vc_item WHERE year = :y AND lower(doi) = :doi"),
                    params).first():
                conn.execute(sql_text("""
                    INSERT INTO prionvault_vc_item (year, pmid, doi, article_id, title, authors,
                                                    journal, pub_year, in_library, abstract)
                    VALUES (:y, NULL, :doi, :aid, :t, :a, :j, :py, TRUE, :abs)"""), params)
    return len(rows)


def _fill_quartiles(year: int) -> None:
    from . import scimago
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text(
            "SELECT id, journal, pub_year FROM prionvault_vc_item WHERE year = :y AND quartile IS NULL"),
            {"y": year}).mappings().all()
    if not rows:
        return
    try:
        idx = scimago.build_lookup_index([r["journal"] for r in rows if r["journal"]])
    except Exception as exc:
        logger.info("vc: SCImago unavailable (%s)", exc)
        return
    with eng.begin() as conn:
        for r in rows:
            info = scimago.lookup_indexed(idx, r["journal"], r["pub_year"]) if r["journal"] else None
            q = (info or {}).get("quartile")
            if q:
                conn.execute(sql_text("UPDATE prionvault_vc_item SET quartile = :q WHERE id = :id"),
                             {"q": str(q), "id": r["id"]})


_SCREEN_SYSTEM = """You are a senior prion-disease researcher (Prion Research Lab: TSE/prion biology, strains, structure, \
recombinant prions, PMCA/RT-QuIC seeding assays, diagnostics, therapies incl. PrP-lowering, CWD, animal prions, \
prion-like mechanisms in other neurodegenerative diseases) preparing the yearly competitive-surveillance report. \
Rate each paper, from its title and journal only, for how likely it is to be one of the year's KEY advances worth \
citing (0 = irrelevant/minor, 10 = landmark). Reviews, case reports and minor incremental work score low unless \
exceptional. Answer only JSON: {"scores": [{"i": <number>, "s": <0-10>}]} with one entry per paper."""


def _parse_scores(parsed) -> dict[int, dict]:
    """{position: {"s": float, "why": str}} from an LLM answer, skipping any
    malformed entry instead of failing the whole batch."""
    out: dict[int, dict] = {}
    entries = parsed.get("scores") if isinstance(parsed, dict) else None
    for e in entries if isinstance(entries, list) else []:
        try:
            out[int(e["i"])] = {"s": float(e["s"]), "why": str(e.get("why") or "")[:400]}
        except (KeyError, TypeError, ValueError):
            continue
    return out


def _screen(year: int) -> None:
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text("""
            SELECT id, title, journal FROM prionvault_vc_item
             WHERE year = :y AND screen_score IS NULL ORDER BY id"""), {"y": year}).mappings().all()
    batch = 60
    _set(phase="Cribado por título", done=0, total=len(rows))
    for k in range(0, len(rows), batch):
        if _stopped():
            return
        chunk = rows[k:k + batch]
        user = "\n".join(f"{i + 1}. {r['title']} — {r['journal']}" for i, r in enumerate(chunk))
        try:
            parsed = _call(_SCREEN_SYSTEM, user, strong=False, max_tokens=2500, timeout=120)
            scores = _parse_scores(parsed)
        except Exception as exc:
            logger.warning("vc screen batch failed: %s", exc)
            scores = {}
        # Only papers the AI really scored are written. The rest stay
        # unscored (NULL) and are screened again on the next run, instead
        # of being buried with a 0 because of one failed call.
        with eng.begin() as conn:
            for i, r in enumerate(chunk, 1):
                if i in scores:
                    conn.execute(sql_text(
                        "UPDATE prionvault_vc_item SET screen_score = :s WHERE id = :id"),
                        {"s": scores[i]["s"], "id": r["id"]})
        _set(done=min(k + batch, len(rows)))


def _efetch_abstracts(pmids: list[str]) -> dict[str, str]:
    import requests
    from ..ingestion.metadata_resolver import _PUBMED_EFETCH, _USER_AGENT
    out: dict[str, str] = {}
    for k in range(0, len(pmids), 100):
        ids = pmids[k:k + 100]
        try:
            r = requests.get(_PUBMED_EFETCH, params={"db": "pubmed", "id": ",".join(ids),
                                                     "retmode": "xml", "rettype": "abstract"},
                             headers={"User-Agent": _USER_AGENT}, timeout=30)
            r.raise_for_status()
            root = ET.fromstring(r.content)
        except Exception as exc:
            logger.warning("vc efetch failed: %s", exc)
            continue
        for art in root.iter("PubmedArticle"):
            pmid = art.findtext(".//MedlineCitation/PMID")
            parts = []
            for at in art.iter("AbstractText"):
                label = at.get("Label")
                txt = "".join(at.itertext()).strip()
                if txt:
                    parts.append(f"{label}: {txt}" if label else txt)
            if pmid and parts:
                out[pmid] = " ".join(parts)
    return out


_SCORE_SYSTEM = """You are a senior prion-disease researcher selecting the KEY advances of the year for your group's \
competitive-surveillance report (published in the institute's Scientific Annual Review). For each paper (title, \
journal, SCImago quartile, abstract) give:
- "s": 0–100 importance for the field this year (landmark structural/therapeutic/diagnostic/clinical advances, \
first-in-human or clinical-trial results, large cohorts, new mechanisms, tools that change practice; also notable \
progress in CWD/animal prions and prion-like mechanisms in other neurodegenerative diseases). Journal quality is a \
signal, not the criterion. Reviews, case reports and incremental work score low. When an AI summary of the full \
text or lab notes/signals are given, use them: they are richer than the abstract and show what the lab found \
important.
- "why": ONE short sentence in Spanish explaining why it matters (or why not).
Answer only JSON: {"scores": [{"i": <number>, "s": <0-100>, "why": "<...>"}]}."""


def _score_shortlist(year: int) -> None:
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text("""
            SELECT id, pmid, title, journal, quartile, abstract, evidence, signals, citations, own_lab,
                   coalesce(screen_score, 0) + CASE WHEN in_library THEN 1 ELSE 0 END
                     + CASE WHEN quartile = 'Q1' THEN 0.5 ELSE 0 END AS pre
              FROM prionvault_vc_item WHERE year = :y
             ORDER BY manual DESC, pre DESC NULLS LAST LIMIT :n"""),
            {"y": year, "n": N_SHORTLIST}).mappings().all()
    missing = [r["pmid"] for r in rows if not r["abstract"] and r["pmid"]]
    if missing:
        _set(phase="Descargando abstracts", done=0, total=len(missing))
        abstracts = _efetch_abstracts(missing)
        with eng.begin() as conn:
            for p, a in abstracts.items():
                conn.execute(sql_text(
                    "UPDATE prionvault_vc_item SET abstract = :a WHERE year = :y AND pmid = :p"),
                    {"a": a, "y": year, "p": p})
        with eng.connect() as conn:
            rows = conn.execute(sql_text(
                "SELECT id, pmid, title, journal, quartile, abstract, evidence, signals, citations, own_lab "
                "FROM prionvault_vc_item WHERE id = ANY(:ids)"), {"ids": [r["id"] for r in rows]}).mappings().all()
    batch = 15
    _set(phase="Valoración con IA (abstracts)", done=0, total=len(rows))
    for k in range(0, len(rows), batch):
        if _stopped():
            return
        chunk = rows[k:k + batch]
        user = "\n\n".join(
            f"{i + 1}. {r['title']}\nJournal: {r['journal']} ({r['quartile'] or 'quartile n/a'})\n"
            f"Abstract: {(r['abstract'] or '(no abstract)')[:1500]}"
            + (f"\n{r['evidence'][:1500]}" if r['evidence'] else "")
            + (f"\nLab signals: {_signals_text(dict(r))}" if _signals_text(dict(r)) else "")
            for i, r in enumerate(chunk))
        try:
            parsed = _call(_SCORE_SYSTEM, user, strong=True, max_tokens=3000)
            res = _parse_scores(parsed)
        except Exception as exc:
            logger.warning("vc score batch failed: %s", exc)
            res = {}
        # Keep the previous score/reason of any paper this call did not score.
        with eng.begin() as conn:
            for i, r in enumerate(chunk, 1):
                if i in res:
                    conn.execute(sql_text(
                        "UPDATE prionvault_vc_item SET score = :s, reason = :w WHERE id = :id"),
                        {"s": res[i]["s"], "w": res[i]["why"], "id": r["id"]})
        _set(done=min(k + batch, len(rows)))


_OWN_LAB = re.compile(r"\b(Castilla J|Era[ñn]a H)\b")


def _build_evidence(year: int, viewer_id=None) -> None:
    """For candidates already in the library, collect what PrionVault knows
    beyond the abstract: AI summary (built from the full text), human
    summary, the viewer's sticky notes, and lab signals (presented in a
    Journal Club this year, star ratings, viewer's milestone/favourite).
    Also flags the group's own papers."""
    eng = _get_engine()
    with eng.connect() as conn:
        # article_ratings belongs to PrionRead; skip the signal if absent.
        has_ratings = conn.execute(sql_text("SELECT to_regclass('article_ratings')")).scalar()
        rating_sql = ("(SELECT round(avg(r.rating)::numeric, 1) FROM article_ratings r "
                      "WHERE r.article_id = a.id)" if has_ratings else "NULL")
        rows = conn.execute(sql_text(f"""
            SELECT i.id, i.article_id, i.authors,
                   a.summary_ai, a.summary_human,
                   (SELECT string_agg(regexp_replace(n.body, '<[^>]+>', ' ', 'g'), ' | ')
                      FROM prionvault_article_note n
                     WHERE n.article_id = a.id AND btrim(n.body) <> ''
                       AND (n.user_id = CAST(:v AS uuid) OR n.share_vc))           AS notes,
                   (SELECT COUNT(*) FROM prionvault_jc_presentation j
                     WHERE j.article_id = a.id
                       AND extract(year FROM j.presented_at) >= :y)               AS jc,
                   {rating_sql}                                                   AS rating,
                   (SELECT bool_or(s.is_milestone) FROM prionvault_user_state s
                     WHERE s.article_id = a.id AND s.user_id = CAST(:v AS uuid))  AS milestone,
                   (SELECT bool_or(s.is_favorite) FROM prionvault_user_state s
                     WHERE s.article_id = a.id AND s.user_id = CAST(:v AS uuid))  AS favorite
              FROM prionvault_vc_item i
              LEFT JOIN articles a ON a.id = i.article_id
             WHERE i.year = :y"""), {"y": year, "v": str(viewer_id) if viewer_id else None}).mappings().all()
    with eng.begin() as conn:
        for r in rows:
            parts = []
            if r["summary_ai"]:
                parts.append("AI summary of the full text: " + r["summary_ai"][:1800])
            if r["summary_human"]:
                parts.append("Lab summary: " + r["summary_human"][:900])
            if r["notes"]:
                parts.append("Lab notes: " + r["notes"][:600])
            signals = {k: v for k, v in {
                "jc": int(r["jc"] or 0) or None,
                "rating": float(r["rating"]) if r["rating"] is not None else None,
                "milestone": bool(r["milestone"]) or None,
                "favorite": bool(r["favorite"]) or None,
                "notes": bool(r["notes"]) or None,
                "summary_ai": bool(r["summary_ai"]) or None,
            }.items() if v}
            conn.execute(sql_text("""
                UPDATE prionvault_vc_item SET evidence = :e, signals = CAST(:s AS jsonb), own_lab = :o
                 WHERE id = :id"""),
                {"e": "\n".join(parts) or None, "s": json.dumps(signals),
                 "o": bool(_OWN_LAB.search(r["authors"] or "")), "id": r["id"]})


def _signals_text(it: dict) -> str:
    sg = it.get("signals") or {}
    bits = []
    if it.get("citations") is not None:
        bits.append(f"{it['citations']} citations so far (OpenAlex)")
    if sg.get("jc"):
        bits.append("presented at the lab's Journal Club")
    if sg.get("rating"):
        bits.append(f"lab rating {sg['rating']}/5")
    if sg.get("milestone"):
        bits.append("marked as milestone by the lab")
    if sg.get("favorite"):
        bits.append("lab favourite")
    if it.get("own_lab"):
        bits.append("published by the lab itself")
    return "; ".join(bits)


def _fetch_citations(year: int) -> None:
    """OpenAlex cited_by_count for the scored shortlist (early impact)."""
    import os
    import requests
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text("""
            SELECT id, doi FROM prionvault_vc_item
             WHERE year = :y AND score IS NOT NULL AND doi IS NOT NULL AND citations IS NULL"""),
            {"y": year}).mappings().all()
    _set(phase="Citas (OpenAlex)", done=0, total=len(rows))
    mail = os.environ.get("UNPAYWALL_EMAIL", "")
    for k, r in enumerate(rows, 1):
        if _stopped():
            return
        try:
            resp = requests.get(f"https://api.openalex.org/works/doi:{r['doi']}",
                                params={"select": "cited_by_count", **({"mailto": mail} if mail else {})},
                                timeout=10)
            n = resp.json().get("cited_by_count") if resp.ok else None
        except Exception:
            n = None
        if n is not None:
            with eng.begin() as conn:
                conn.execute(sql_text("UPDATE prionvault_vc_item SET citations = :n WHERE id = :id"),
                             {"n": int(n), "id": r["id"]})
        _set(done=k)


_HOLISTIC_SYSTEM = """You are the senior author choosing the final set of papers to cite in your prion research group's yearly competitive-surveillance report (~3,500 characters, so every citation must earn its place). From the shortlist (each with an importance score, the reason, its evidence and lab signals), choose EXACTLY the requested number so that the set: (1) contains the true landmark advances of the year; (2) covers the field in a balanced way — therapy/clinical, diagnostics & biomarkers, prion biology/structure/strains/mechanisms, models, genetics/epidemiology, animal prions/CWD, prion-like mechanisms in other neurodegenerative diseases; (3) avoids redundancy — when several papers make the same point keep the strongest, unless they are meant to be cited together; (4) gives weight to lab signals (Journal Club, notes, ratings) and early citations as evidence of importance, without letting them override clear landmarks. Answer only JSON: {"pmids": ["..."], "why": {"<pmid>": "<one sentence in Spanish: why it is in the final set>"}}"""


def _holistic_select(year: int, n: int) -> int:
    eng = _get_engine()
    with eng.connect() as conn:
        rows = [dict(r) for r in conn.execute(sql_text("""
            SELECT id, pmid, title, journal, quartile, score, reason, citations, own_lab, signals,
                   evidence, abstract
              FROM prionvault_vc_item
             WHERE year = :y AND NOT manual AND score IS NOT NULL AND score > 0 AND pmid IS NOT NULL
             ORDER BY score DESC LIMIT :k"""), {"y": year, "k": max(n * 2, 60)}).mappings()]
        manual_sel = conn.execute(sql_text(
            "SELECT COUNT(*) FROM prionvault_vc_item WHERE year = :y AND manual AND selected"),
            {"y": year}).scalar() or 0
    want = max(0, n - manual_sel)
    if not rows or want == 0:
        return _preselect(year, n)
    _set(phase="Selección final de conjunto (IA)", done=0, total=1)
    user = "\n\n".join(
        f"PMID {r['pmid']} — score {round(r['score'])} — {r['title']} ({r['journal']}, {r['quartile'] or 'n/a'})\n"
        f"Why: {r['reason']}\nSignals: {_signals_text(r) or 'none'}\n"
        f"Evidence: {(r['evidence'] or r['abstract'] or '')[:700]}" for r in rows)
    try:
        parsed = _call(_HOLISTIC_SYSTEM, f"Choose exactly {want} papers.\n\nSHORTLIST:\n{user}",
                       strong=True, max_tokens=5000)
        valid = {r["pmid"] for r in rows}
        picked = [str(p) for p in parsed.get("pmids") or [] if str(p) in valid][:want]
        why = parsed.get("why") or {}
    except Exception as exc:
        logger.warning("vc holistic selection failed, using top-N: %s", exc)
        picked, why = [], {}
    if len(picked) < want * 0.7:
        return _preselect(year, n)
    with eng.begin() as conn:
        conn.execute(sql_text(
            "UPDATE prionvault_vc_item SET selected = FALSE WHERE year = :y AND NOT manual"), {"y": year})
        for p in picked:
            conn.execute(sql_text("""
                UPDATE prionvault_vc_item SET selected = TRUE,
                       reason = CASE WHEN :w <> '' THEN :w ELSE reason END
                 WHERE year = :y AND pmid = :p"""),
                {"y": year, "p": p, "w": str(why.get(p) or "")[:400]})
    _set(done=1)
    return len(picked)


def _preselect(year: int, n: int) -> int:
    with _get_engine().begin() as conn:
        conn.execute(sql_text(
            "UPDATE prionvault_vc_item SET selected = FALSE WHERE year = :y AND NOT manual"), {"y": year})
        res = conn.execute(sql_text("""
            UPDATE prionvault_vc_item SET selected = TRUE
             WHERE id IN (SELECT id FROM prionvault_vc_item
                           WHERE year = :y AND NOT manual AND score IS NOT NULL AND score > 0
                           ORDER BY score DESC LIMIT :n)"""), {"y": year, "n": n})
    return res.rowcount or 0


PROPOSED_NOTE = "📌 Propuesto por el laboratorio (colección VC {year})."


def sync_collection(year: int) -> int:
    """Articles the lab puts in the collection "VC <year>" are proposals that
    must be in the report: they enter the generator as hand-selected items
    (any publication year). A proposal the user later unticks in the
    generator stays unticked (manual items are never re-selected here).
    Returns how many were added/selected."""
    from . import vc
    cid = vc.ensure_collection(year)
    eng = _get_engine()
    with eng.connect() as conn:
        arts = [dict(r) for r in conn.execute(sql_text("""
            SELECT a.id, a.pubmed_id, a.doi, a.title, a.authors, a.journal, a.year, a.abstract
              FROM prionvault_collection_article ca JOIN articles a ON a.id = ca.article_id
             WHERE ca.collection_id = CAST(:c AS uuid)"""), {"c": cid}).mappings()]
    if not arts:
        return 0
    note = PROPOSED_NOTE.format(year=year)
    changed = 0
    with eng.begin() as conn:
        for a in arts:
            row = conn.execute(sql_text("""
                SELECT id, manual FROM prionvault_vc_item
                 WHERE year = :y AND (article_id = :aid OR (:p <> '' AND pmid = :p)
                                      OR (:d <> '' AND lower(doi) = :d))
                 LIMIT 1"""),
                {"y": year, "aid": a["id"], "p": a["pubmed_id"] or "",
                 "d": (a["doi"] or "").lower()}).mappings().first()
            if row:
                if not row["manual"]:
                    conn.execute(sql_text("""
                        UPDATE prionvault_vc_item SET selected = TRUE, manual = TRUE, article_id = :aid,
                               in_library = TRUE, reason = :r WHERE id = :id"""),
                        {"aid": a["id"], "r": note, "id": row["id"]})
                    changed += 1
                continue
            conn.execute(sql_text("""
                INSERT INTO prionvault_vc_item (year, pmid, doi, article_id, title, authors, journal, pub_year,
                                                in_library, abstract, selected, manual, reason)
                VALUES (:y, :p, :d, :aid, :t, :au, :j, :py, TRUE, :abs, TRUE, TRUE, :r)
                ON CONFLICT (year, pmid) WHERE pmid IS NOT NULL DO NOTHING"""),
                {"y": year, "p": a["pubmed_id"], "d": (a["doi"] or "").lower() or None, "aid": a["id"],
                 "t": a["title"] or "", "au": (a["authors"] or "")[:2000], "j": a["journal"] or "",
                 "py": a["year"], "abs": a["abstract"], "r": note})
            changed += 1
    return changed


def step_select(year: int, n_final: int = N_FINAL, viewer_id=None) -> dict:
    ensure_draft(year)
    _set(phase="Reuniendo candidatos", done=0, total=0)
    n = _gather_candidates(year)
    sync_collection(year)
    _fill_quartiles(year)
    _build_evidence(year, viewer_id)
    _screen(year)
    if _stopped():
        return {"stopped": True}
    _score_shortlist(year)
    if _stopped():
        return {"stopped": True}
    _fetch_citations(year)
    picked = _holistic_select(year, n_final)
    info = {"candidates": n, "shortlist": N_SHORTLIST, "selected": picked}
    _log(year, "select", info)
    return info


# ── Step 2: themes ───────────────────────────────────────────────────────────

def _past_reports(before_year: int) -> list[dict]:
    with _get_engine().connect() as conn:
        return [dict(r) for r in conn.execute(sql_text("""
            SELECT year, title, body FROM prionvault_vc_report
             WHERE year < :y AND status <> 'draft' ORDER BY year"""), {"y": before_year}).mappings()]


def _selected_items(year: int) -> list[dict]:
    with _get_engine().connect() as conn:
        return [dict(r) for r in conn.execute(sql_text("""
            SELECT id, pmid, doi, title, journal, quartile, abstract, score, reason, theme,
                   evidence, signals, citations, own_lab
              FROM prionvault_vc_item WHERE year = :y AND selected
             ORDER BY score DESC NULLS LAST"""), {"y": year}).mappings()]


_THEMES_SYSTEM = """You are the senior author of a prion research group's yearly competitive-surveillance report. \
Group the selected papers of the year into 4–6 coherent themes for the "advances" paragraph, ordered as the \
narrative should flow (most important first). Use the previous reports as memory: keep continuity with recurring \
themes and explicitly connect to what LAST year's report expected for this year (confirmed, partly, or not yet). \
Every paper must belong to exactly one theme. If the lab suggests themes, use them whenever at least one \
selected paper fits (keep their wording, translated to a short English name), drop a suggestion only when no paper \
fits it, and still create other themes for papers that fit none. Answer only JSON:
{"themes": [{"name": "<short English name>", "summary": "<2-3 sentences in Spanish: what happened this year>", \
"continuity": "<1 sentence in Spanish linking to previous reports/expectations, or empty>", "pmids": ["..."]}]}"""


def set_theme_hints(year: int, hints: str) -> None:
    ensure_draft(year)
    with _get_engine().begin() as conn:
        conn.execute(sql_text(
            "UPDATE prionvault_vc_report SET theme_hints = :h, updated_at = NOW() WHERE year = :y"),
            {"h": (hints or "").strip()[:3000], "y": year})


def step_themes(year: int, hints: Optional[str] = None) -> dict:
    if hints is not None:
        set_theme_hints(year, hints)
    with _get_engine().connect() as conn:
        hints = conn.execute(sql_text(
            "SELECT theme_hints FROM prionvault_vc_report WHERE year = :y"), {"y": year}).scalar() or ""
    if sync_collection(year):
        _build_evidence(year)
    items = _selected_items(year)
    if not items:
        raise ValueError("No hay artículos seleccionados.")
    past = _past_reports(year)
    memory = "\n\n".join(
        f"=== VC {p['year']}: {p['title']}\n" +
        (p["body"] if p["year"] >= year - 2 else p["body"].split("\n\n")[-1])
        for p in past)
    papers = "\n".join(
        f"- PMID {it['pmid'] or it['doi']}: {it['title']} ({it['journal']}). {it['reason']}"
        for it in items)
    _set(phase="Clasificando en temas", done=0, total=1)
    parsed = _call(_THEMES_SYSTEM,
                   f"PREVIOUS REPORTS (most recent in full, older ones only their outlook):\n{memory}\n\n"
                   f"SELECTED PAPERS OF {year}:\n{papers}"
                   + (f"\n\nTHEMES SUGGESTED BY THE LAB (one per line):\n{hints}" if hints.strip() else ""),
                   strong=True, max_tokens=4000)
    themes = parsed.get("themes") or []
    valid = {str(it["pmid"] or it["doi"]) for it in items}
    for t in themes:
        t["pmids"] = [str(p) for p in (t.get("pmids") or []) if str(p) in valid]
    with _get_engine().begin() as conn:
        conn.execute(sql_text(
            "UPDATE prionvault_vc_report SET themes = CAST(:t AS jsonb), updated_at = NOW() WHERE year = :y"),
            {"t": json.dumps(themes, ensure_ascii=False), "y": year})
        conn.execute(sql_text("UPDATE prionvault_vc_item SET theme = NULL WHERE year = :y"), {"y": year})
        for t in themes:
            conn.execute(sql_text("""
                UPDATE prionvault_vc_item SET theme = :n
                 WHERE year = :y AND (pmid = ANY(:p) OR doi = ANY(:p))"""),
                {"n": t.get("name") or "", "y": year, "p": t["pmids"]})
    _set(done=1)
    info = {"themes": len(themes), "papers": len(items)}
    _log(year, "themes", info)
    return info


# ── Step 3: writing ──────────────────────────────────────────────────────────
# Citations: "(PMID: …)" by default (2024–2025 style) or "(doi: …)" (2021–2023
# style), per report (prionvault_vc_report.cite_style). Validation and the
# fact-check accept both, so switching style never breaks a draft.

def _style(year: int) -> str:
    with _get_engine().connect() as conn:
        st = conn.execute(sql_text("SELECT cite_style FROM prionvault_vc_report WHERE year = :y"),
                          {"y": year}).scalar()
    return "doi" if st == "doi" else "pmid"


def _cite_rule(style: str) -> str:
    if style == "doi":
        return ('DOI references in brackets directly within the text, e.g. "(doi: 10.1038/s41586-024-07000-1)" '
                'or several "(doi: 10.1/a; doi: 10.2/b)". If a paper has no DOI, cite "(PMID: …)". No reference list.')
    return ('PMID references in brackets directly within the text, e.g. "(PMID: 30289599)" or several '
            '"(PMID: 39440977, 39396118)". No reference list.')


def _write_system(style: str) -> str:
    return f"""You write the yearly "competitive surveillance" report of a prion research group \
(Joaquín Castilla's Prion Research Laboratory, CIC bioGUNE) for the institute's Scientific Annual Review.

{_GUIDELINES.replace(_GUIDELINES.split(chr(10))[2], "- References: " + _cite_rule(style))}

Style: match the previous reports provided (scientific but accessible English, flowing paragraphs that link the \
papers coherently — each cited paper is woven into the narrative with what it showed and why it matters, grouped \
by theme; no bullet points, no headings inside paragraphs). Cite ONLY the identifiers you are given, each in \
brackets right after the statement it supports. Prefer citing most of the selected papers; group several \
identifiers in one bracket when they support the same point.
Answer only JSON: {{"title": "...", "intro": "<paragraph 1>", "advances": "<paragraph 2>", "outlook": "<paragraph 3>"}}"""


def _ident(it: dict, style: str) -> str:
    if style == "doi" and it.get("doi"):
        return f"doi: {it['doi']}"
    return f"PMID: {it['pmid']}" if it.get("pmid") else f"doi: {it.get('doi')}"


_DOI_RE = re.compile(r"10\.\d{4,9}/[^\s;,)\]]+", re.I)


def _cited_ids(text: str) -> list[str]:
    """Every identifier cited in the text: PMIDs (digits) and DOIs (lower-case)."""
    out = []
    for m in re.finditer(r"PMID:?\s*([\d,;\s]+)", text):
        out += re.findall(r"\d{7,9}", m.group(1))
    out += [d.rstrip(".").lower() for d in _DOI_RE.findall(text)]
    return out


_cited_pmids = _cited_ids   # backwards-compatible name


def _allowed(items: list[dict]) -> set[str]:
    return ({str(it["pmid"]) for it in items if it.get("pmid")}
            | {it["doi"].lower() for it in items if it.get("doi")})


def validate(intro: str, advances: str, outlook: str, allowed: set[str]) -> dict:
    total = len(intro) + len(advances) + len(outlook) + 2   # paragraph separators
    shares = [len(p) / max(1, total) for p in (intro, advances, outlook)]
    cited = _cited_ids(" ".join((intro, advances, outlook)))
    unknown = sorted({p for p in cited if p not in allowed})
    problems = []
    if total > MAX_CHARS:
        problems.append(f"The body has {total} characters; the maximum is {MAX_CHARS}. Shorten it by at least "
                        f"{total - MAX_CHARS + 40} characters.")
    if total < MAX_CHARS - 600:
        problems.append(f"The body has only {total} characters; use the available space (aim 3,300–3,480).")
    if not 0.15 <= shares[0] <= 0.33:
        problems.append(f"Paragraph 1 is {shares[0]:.0%} of the text; it must be about 25%.")
    if not 0.40 <= shares[1] <= 0.62:
        problems.append(f"Paragraph 2 is {shares[1]:.0%} of the text; it must be about 50%.")
    if not 0.15 <= shares[2] <= 0.33:
        problems.append(f"Paragraph 3 is {shares[2]:.0%} of the text; it must be about 25%.")
    if unknown:
        problems.append("These identifiers are not among the selected papers and must be removed: "
                        + ", ".join(unknown))
    if len(set(cited)) < 10:
        problems.append("Cite more of the provided papers (at least 10 distinct papers).")
    return {"chars": total, "shares": [round(x, 3) for x in shares], "cited": len(set(cited)),
            "unknown_pmids": unknown, "problems": problems, "ok": not problems}


def _evidence(it: dict, limit: int) -> str:
    """Best available description of what a paper showed: the AI summary of
    its full text when the lab has it, else the abstract."""
    ev = it.get("evidence") or ""
    return ((ev + " ") if ev else "") [:limit] or (it.get("abstract") or "")[:limit]


_FACTCHECK_SYSTEM = """You are a meticulous scientific fact-checker. You get a report draft that cites papers as \
"(PMID: …)" or "(doi: …)" and, for each cited paper, its evidence (abstract and, when available, an AI summary of \
the full text). Check every statement that carries a citation: is it supported by the evidence of THAT paper (not \
another one), without overstating results (e.g. "demonstrated" vs "suggested", animal vs human, preclinical vs \
clinical)? Report only real problems. Answer only JSON: \
{"issues": [{"pmid": "<the cited identifier>", "quote": "<the problematic words>", "problem": "<what is wrong>", \
"fix": "<how to rephrase>"}]}"""


def _factcheck(draft: dict, items: list[dict]) -> list[dict]:
    text = "\n\n".join(draft.get(k, "") for k in ("intro", "advances", "outlook"))
    cited = set(_cited_ids(text))
    by = {}
    for it in items:
        if it.get("pmid"):
            by[str(it["pmid"])] = it
        if it.get("doi"):
            by[it["doi"].lower()] = it
    ev = "\n\n".join(
        f"{c}: {by[c]['title']}\nAbstract: {(by[c]['abstract'] or '')[:1200]}\n"
        f"{(by[c]['evidence'] or '')[:1200]}" for c in sorted(cited) if c in by)
    parsed = _call(_FACTCHECK_SYSTEM, f"DRAFT:\n{text}\n\nEVIDENCE:\n{ev}", strong=True, max_tokens=3000)
    return [i for i in (parsed.get("issues") or []) if isinstance(i, dict)][:20]


def _paper_lines(items: list[dict], themes: list[dict], style: str) -> list[str]:
    by_id = {str(it["pmid"] or it["doi"]): it for it in items}
    lines, used = [], set()
    for t in themes or [{"name": "Advances", "pmids": list(by_id)}]:
        lines.append(f"## {t.get('name')}: {t.get('summary', '')} {t.get('continuity', '')}")
        for p in t.get("pmids") or []:
            it = by_id.get(str(p))
            if it:
                used.add(str(p))
                lines.append(f"- [{_ident(it, style)}] {it['title']} ({it['journal']}). Why: {it['reason']}"
                             f" Key findings: {_evidence(it, 900)}")
    rest = [it for k, it in by_id.items() if k not in used]
    if rest:   # e.g. papers added after the themes were made
        lines.append("## Other selected papers")
        lines += [f"- [{_ident(it, style)}] {it['title']} ({it['journal']}). Why: {it['reason']}"
                  f" Key findings: {_evidence(it, 900)}" for it in rest]
    return lines


def _comply(draft: dict, user: str, system: str, allowed: set[str], *, max_rounds: int = 3,
            keep: str = "") -> tuple[dict, dict, int]:
    """Re-ask until the draft passes validation (or rounds run out)."""
    check = validate(draft.get("intro", ""), draft.get("advances", ""), draft.get("outlook", ""), allowed)
    rounds = 0
    while not check["ok"] and rounds < max_rounds and not _stopped():
        rounds += 1
        _set(phase=f"Ajustando formato ({'; '.join(check['problems'])[:110]})")
        draft = _call(system,
                      user + "\n\nYOUR PREVIOUS DRAFT:\n" + json.dumps(draft, ensure_ascii=False) +
                      "\n\nRevise it to fix ALL of these problems, keeping its content and style" +
                      (f" — and keeping these requested changes: {keep}" if keep else "") + ":\n- " +
                      "\n- ".join(check["problems"]),
                      strong=True, max_tokens=4000)
        check = validate(draft.get("intro", ""), draft.get("advances", ""), draft.get("outlook", ""), allowed)
    return draft, check, rounds


def _factcheck_and_fix(draft: dict, check: dict, user: str, system: str, items: list[dict],
                       allowed: set[str], keep: str = "") -> tuple[dict, dict, list, list]:
    issues, fixed = [], []
    if _stopped():
        return draft, check, fixed, issues
    _set(phase="Revisión de hechos (cada afirmación contra su artículo)")
    try:
        issues = _factcheck(draft, items)
    except Exception as exc:
        logger.warning("vc factcheck failed: %s", exc)
    if issues and not _stopped():
        fixed = issues
        _set(phase=f"Corrigiendo {len(issues)} afirmaciones")
        fix_text = "\n".join(f"- {i.get('pmid')}: \"{i.get('quote')}\" — {i.get('problem')} → {i.get('fix')}"
                             for i in issues)
        for _ in range(2):
            revised = _call(system,
                            user + "\n\nYOUR PREVIOUS DRAFT:\n" + json.dumps(draft, ensure_ascii=False) +
                            "\n\nA fact-check found these problems; fix them (keep everything else, respect "
                            "all format constraints" + (f", keep these requested changes: {keep}" if keep else "")
                            + "):\n" + fix_text +
                            ("\n\nAlso fix: " + "; ".join(check["problems"]) if check["problems"] else ""),
                            strong=True, max_tokens=4000)
            rcheck = validate(revised.get("intro", ""), revised.get("advances", ""),
                              revised.get("outlook", ""), allowed)
            if rcheck["ok"] or not check["ok"]:
                draft, check = revised, rcheck
                break
        try:
            issues = _factcheck(draft, items)
        except Exception:
            pass
    return draft, check, fixed, issues


def _save_draft(year: int, draft: dict, *, kind: str, request: str = "", summary: str = "",
                info: Optional[dict] = None, by_user=None) -> None:
    body = "\n\n".join(draft.get(k, "").strip() for k in ("intro", "advances", "outlook"))
    with _get_engine().begin() as conn:
        authors = conn.execute(sql_text(
            "SELECT coalesce(nullif(authors, ''), :a) FROM prionvault_vc_report WHERE year = :y"),
            {"y": year, "a": AUTHORS}).scalar() or AUTHORS
        conn.execute(sql_text("""
            UPDATE prionvault_vc_report SET title = :t, body = :b, authors = :a, updated_at = NOW()
             WHERE year = :y"""),
            {"t": (draft.get("title") or "").strip(), "b": body, "a": authors, "y": year})
        _add_version(conn, year, kind, (draft.get("title") or "").strip(), authors, body,
                     request=request, summary=summary, info=info, by_user=by_user)


def _add_version(conn, year, kind, title, authors, body, *, request="", summary="", info=None,
                 by_user=None) -> None:
    conn.execute(sql_text("""
        INSERT INTO prionvault_vc_version (year, kind, request, summary, title, authors, body, info, created_by)
        VALUES (:y, :k, :r, :s, :t, :a, :b, CAST(:i AS jsonb), CAST(:u AS uuid))"""),
        {"y": year, "k": kind, "r": request[:4000], "s": summary[:4000], "t": title, "a": authors,
         "b": body, "i": json.dumps(info or {}, ensure_ascii=False), "u": str(by_user) if by_user else None})


def _context(year: int, items: list[dict], style: str) -> str:
    with _get_engine().connect() as conn:
        rep = conn.execute(sql_text("SELECT themes FROM prionvault_vc_report WHERE year = :y"),
                           {"y": year}).mappings().first()
    themes = (rep or {}).get("themes") or []
    past = _past_reports(year)
    examples = "\n\n".join(f"=== VC {p['year']} (example of style; do NOT copy)\nTitle: {p['title']}\n{p['body']}"
                           for p in past if p["year"] >= year - 3)
    last_outlook = past[-1]["body"].split("\n\n")[-1] if past else ""
    return (f"{examples}\n\nLAST YEAR'S OUTLOOK (what was expected for {year}):\n{last_outlook}\n\n"
            f"SELECTED PAPERS OF {year} BY THEME (cite them with the identifier in brackets):\n"
            + "\n".join(_paper_lines(items, themes, style)))


def step_write(year: int, instructions: str = "", by_user=None) -> dict:
    if sync_collection(year):
        _build_evidence(year, by_user)
    items = _selected_items(year)
    if not items:
        raise ValueError("No hay artículos seleccionados.")
    style = _style(year)
    system = _write_system(style)
    allowed = _allowed(items)
    user = (_context(year, items, style) +
            f"\n\nWrite the {year} report (paragraph 3 looks ahead to {year + 1})."
            + (f"\n\nAdditional instructions from the authors: {instructions}" if instructions else ""))
    _set(phase="Redactando", done=0, total=0)
    draft = _call(system, user, strong=True, max_tokens=4000)
    draft, check, rounds = _comply(draft, user, system, allowed)
    draft, check, fixed, issues = _factcheck_and_fix(draft, check, user, system, items, allowed)
    info = {**check, "attempts": rounds + 1, "instructions": instructions[:500],
            "factcheck_fixed": fixed, "factcheck_remaining": issues}
    _save_draft(year, draft, kind="generated", request=instructions, info=info, by_user=by_user,
                summary="Informe redactado por la IA.")
    _log(year, "write", info)
    return info


# ── Revisions in free text ("pedir cambios a la IA") ─────────────────────────

_PLAN_SYSTEM = """You help the authors edit their yearly competitive-surveillance report. Read their request \
(any language) and decide which PAPERS must be added to or removed from the report. Papers to add may be given \
as PMID, DOI, or described ("the Nature paper on CWD structure by Smith") — in that last case pick it from the \
CANDIDATES list if it is there. Papers to remove are identified among the SELECTED papers (by identifier, author \
or description). Only list papers the request clearly asks to add/remove. Answer only JSON: \
{"add_pmids": ["..."], "add_dois": ["..."], "remove": ["<pmid or doi of a selected paper>"]}"""

_REVISE_SYSTEM_EXTRA = """

You are now REVISING an existing draft at the authors' request. Apply exactly what they ask (add sentences where \
they say, remove what they say, cite or stop citing the papers they mention, change tone or emphasis…) and leave \
everything else as it is — same wording wherever no change was requested. Only if the requested changes push the \
text over the length limit, tighten other sentences slightly. Also return "changes": a short list, in Spanish, \
of what you changed. JSON: {"title": "...", "intro": "...", "advances": "...", "outlook": "...", \
"changes": ["..."]}"""


def _current_draft(year: int) -> dict:
    with _get_engine().connect() as conn:
        rep = conn.execute(sql_text("SELECT title, body FROM prionvault_vc_report WHERE year = :y"),
                           {"y": year}).mappings().first()
    paras = [p for p in ((rep or {}).get("body") or "").split("\n\n") if p.strip()] + ["", "", ""]
    return {"title": (rep or {}).get("title") or "", "intro": paras[0], "advances": paras[1],
            "outlook": paras[2]}


def step_revise(year: int, request: str, by_user=None) -> dict:
    request = (request or "").strip()
    if not request:
        raise ValueError("Escribe qué cambios quieres.")
    draft = _current_draft(year)
    if not (draft["intro"] or draft["advances"]):
        raise ValueError("Todavía no hay borrador: redacta primero el informe.")
    style = _style(year)

    # 1) Papers to add/remove, decided from the free-text request.
    _set(phase="Interpretando la petición", done=0, total=0)
    items = _selected_items(year)
    with _get_engine().connect() as conn:
        cands = [dict(r) for r in conn.execute(sql_text("""
            SELECT pmid, doi, title, journal FROM prionvault_vc_item
             WHERE year = :y AND NOT selected AND pmid IS NOT NULL
             ORDER BY score DESC NULLS LAST, screen_score DESC NULLS LAST LIMIT 150"""), {"y": year}).mappings()]
    plan = _call(_PLAN_SYSTEM,
                 f"REQUEST:\n{request}\n\nSELECTED PAPERS:\n" +
                 "\n".join(f"- {_ident(it, 'pmid')} | doi {it.get('doi') or '-'} | {it['title']}" for it in items) +
                 "\n\nCANDIDATES (not selected):\n" +
                 "\n".join(f"- PMID {c['pmid']} | doi {c.get('doi') or '-'} | {c['title']} ({c['journal']})"
                           for c in cands),
                 strong=True, max_tokens=800, timeout=120)
    added, removed, not_found = [], [], []
    add_pmids = [str(p) for p in plan.get("add_pmids") or [] if str(p).isdigit()]
    add_pmids += re.findall(r"PMID:?\s*(\d{7,9})", request)
    for d in (plan.get("add_dois") or []) + _DOI_RE.findall(request):
        from ..ingestion.metadata_resolver import pubmed_by_doi
        meta = pubmed_by_doi(str(d).rstrip("."))
        if meta and meta.pubmed_id:
            add_pmids.append(str(meta.pubmed_id))
        else:
            not_found.append(str(d))
    selected_ids = _allowed(items)
    for p in dict.fromkeys(add_pmids):
        if p in selected_ids:
            continue
        try:
            add_pmid(year, p)
            added.append(p)
        except LookupError:
            not_found.append(p)
    rm = {str(x).lower() for x in plan.get("remove") or []}
    if rm:
        with _get_engine().begin() as conn:
            for it in items:
                if str(it.get("pmid") or "") in rm or (it.get("doi") or "").lower() in rm:
                    conn.execute(sql_text(
                        "UPDATE prionvault_vc_item SET selected = FALSE, manual = TRUE WHERE id = :id"),
                        {"id": it["id"]})
                    removed.append(it.get("pmid") or it.get("doi"))
    if added:
        _build_evidence(year, by_user)

    # 2) Revise the text applying only the requested changes.
    items = _selected_items(year)
    allowed = _allowed(items)
    system = _write_system(style) + _REVISE_SYSTEM_EXTRA
    paper_note = ""
    if added:
        paper_note += "\nPapers ADDED to the selection (cite them where the request says): " + ", ".join(added)
    if removed:
        paper_note += "\nPapers REMOVED from the selection (must no longer be cited): " + ", ".join(map(str, removed))
    user = (_context(year, items, style) +
            "\n\nCURRENT DRAFT:\n" + json.dumps(draft, ensure_ascii=False) +
            f"\n\nTHE AUTHORS ASK:\n{request}{paper_note}")
    _set(phase="Aplicando los cambios")
    revised = _call(system, user, strong=True, max_tokens=4500)
    changes = [str(c) for c in revised.get("changes") or []][:20]
    revised, check, rounds = _comply(revised, user, system, allowed, max_rounds=2, keep=request[:600])
    revised, check, fixed, issues = _factcheck_and_fix(revised, check, user, system, items, allowed,
                                                       keep=request[:600])
    summary = "; ".join(changes) or "Cambios aplicados."
    if added:
        summary += f" · Artículos añadidos: {', '.join(added)}"
    if removed:
        summary += f" · Artículos quitados: {', '.join(map(str, removed))}"
    if not_found:
        summary += f" · No encontrados: {', '.join(not_found)}"
    info = {**check, "factcheck_fixed": fixed, "factcheck_remaining": issues,
            "added": added, "removed": removed, "not_found": not_found}
    _save_draft(year, revised, kind="revision", request=request, summary=summary, info=info, by_user=by_user)
    _log(year, "write", info)
    return info


# ── Versions, citation style, acceptance ─────────────────────────────────────

def list_versions(year: int) -> list[dict]:
    with _get_engine().connect() as conn:
        rows = conn.execute(sql_text("""
            SELECT id, kind, request, summary, title, length(body) AS chars, created_at
              FROM prionvault_vc_version WHERE year = :y ORDER BY id DESC LIMIT 60"""),
            {"y": year}).mappings().all()
    return [{**dict(r), "created_at": r["created_at"].isoformat()} for r in rows]


def restore_version(year: int, version_id: int, by_user=None) -> None:
    with _get_engine().begin() as conn:
        v = conn.execute(sql_text(
            "SELECT title, authors, body FROM prionvault_vc_version WHERE id = :id AND year = :y"),
            {"id": version_id, "y": year}).mappings().first()
        if not v:
            raise LookupError(version_id)
        conn.execute(sql_text("""
            UPDATE prionvault_vc_report SET title = :t, authors = :a, body = :b, updated_at = NOW()
             WHERE year = :y"""), {"t": v["title"], "a": v["authors"], "b": v["body"], "y": year})
        _add_version(conn, year, "restored", v["title"], v["authors"], v["body"],
                     summary=f"Restaurada la versión #{version_id}.", by_user=by_user)


def set_cite_style(year: int, style: str) -> None:
    if style not in ("pmid", "doi"):
        raise ValueError(style)
    ensure_draft(year)
    with _get_engine().begin() as conn:
        conn.execute(sql_text("UPDATE prionvault_vc_report SET cite_style = :s WHERE year = :y"),
                     {"s": style, "y": year})


def accept_final(year: int, by_user=None) -> dict:
    """Make the current draft the year's official report: status 'final'
    (it then shows like the past years' and becomes memory for the next
    one), its cited papers become references linked to PrionVault articles
    (imported if missing) and join the collection "VC <year>"."""
    from . import vc
    with _get_engine().begin() as conn:
        rep = conn.execute(sql_text(
            "SELECT title, authors, body FROM prionvault_vc_report WHERE year = :y"),
            {"y": year}).mappings().first()
        if not rep or not (rep["body"] or "").strip():
            raise ValueError("No hay informe que aceptar.")
        conn.execute(sql_text(
            "UPDATE prionvault_vc_report SET status = 'final', updated_at = NOW() WHERE year = :y"), {"y": year})
        _add_version(conn, year, "final", rep["title"], rep["authors"], rep["body"],
                     summary="Versión final aceptada.", by_user=by_user)
        conn.execute(sql_text("DELETE FROM prionvault_vc_ref WHERE year = :y"), {"y": year})
        cited = list(dict.fromkeys(_cited_ids(rep["body"])))
        for c in cited:
            is_pmid = c.isdigit()
            conn.execute(sql_text("""
                INSERT INTO prionvault_vc_ref (year, ref_key, cite, doi, pmid)
                VALUES (:y, :k, '', :d, :p) ON CONFLICT (year, ref_key) DO NOTHING"""),
                {"y": year, "k": ("pmid:" if is_pmid else "doi:") + c,
                 "d": None if is_pmid else c, "p": c if is_pmid else None})
        refs = [dict(r) for r in conn.execute(sql_text(
            "SELECT id, year, cite, doi, pmid, context FROM prionvault_vc_ref WHERE year = :y"),
            {"y": year}).mappings()]
    done = 0
    for ref in refs:
        try:
            vc.resolve_ref(ref, by_user=by_user)
            done += 1
        except Exception as exc:
            logger.warning("vc accept: resolving %s failed: %s", ref, exc)
    return {"cited": len(cited), "linked": done}


def reopen(year: int) -> None:
    with _get_engine().begin() as conn:
        conn.execute(sql_text(
            "UPDATE prionvault_vc_report SET status = 'draft', updated_at = NOW() WHERE year = :y"), {"y": year})


# ── Background runner / status ───────────────────────────────────────────────

def get_status() -> dict:
    with _lock:
        snap = dict(_state)
    if not snap.get("running") and _job_lock.running_elsewhere("vc_generate"):
        snap["running"] = True
        snap["phase"] = "En marcha en otro proceso del servidor."
    return snap


def stop() -> dict:
    with _lock:
        if _state["running"]:
            _state["stop_requested"] = True
    _job_lock.request_stop("vc_generate")
    return get_status()


_STEPS = {"select": step_select, "themes": step_themes, "write": step_write, "revise": step_revise}


def start(step: str, year: int, **kwargs) -> Optional[dict]:
    if step not in _STEPS:
        raise ValueError(step)
    with _lock:
        if _state["running"]:
            return None
        _state.update({"running": True, "step": step, "phase": "Empezando", "done": 0, "total": 0,
                       "started_at": datetime.utcnow().isoformat(), "finished_at": None,
                       "last_error": None, "stop_requested": False, "result": None})

    def run():
        try:
            res = _STEPS[step](year, **kwargs)
            _set(result=res)
        except Exception as exc:
            logger.exception("vc generate %s failed", step)
            _set(last_error=str(exc)[:400])
        finally:
            _set(running=False, finished_at=datetime.utcnow().isoformat(), phase=None)

    threading.Thread(target=_job_lock.guarded("vc_generate", run, _state, _lock),
                     name=f"prionvault-vc-{step}", daemon=True).start()
    return get_status()


# ── Read / edit / export ─────────────────────────────────────────────────────

def get_draft(year: int) -> dict:
    ensure_draft(year)
    try:
        # Creates "VC <year>" in the sidebar group and pulls in what the lab
        # has proposed there since the last visit.
        sync_collection(year)
    except Exception as exc:
        logger.warning("vc: collection sync failed: %s", exc)
    with _get_engine().connect() as conn:
        rep = dict(conn.execute(sql_text(
            "SELECT year, title, authors, body, status, themes, theme_hints, pipeline, cite_style "
            "FROM prionvault_vc_report WHERE year = :y"),
            {"y": year}).mappings().first())
        items = [dict(r) for r in conn.execute(sql_text("""
            SELECT id, pmid, doi, article_id, title, journal, pub_year, quartile, in_library,
                   screen_score, score, reason, theme, selected, manual, citations, own_lab, signals
              FROM prionvault_vc_item WHERE year = :y
             ORDER BY selected DESC, score DESC NULLS LAST, screen_score DESC NULLS LAST
             LIMIT 300"""), {"y": year}).mappings()]
        total = conn.execute(sql_text("SELECT COUNT(*) FROM prionvault_vc_item WHERE year = :y"),
                             {"y": year}).scalar()
    paras = [p for p in (rep.pop("body") or "").split("\n\n") if p.strip()]
    allowed = _allowed([i for i in items if i["selected"]])
    rep["paragraphs"] = paras
    rep["versions"] = list_versions(year)
    rep["check"] = validate(*(paras + ["", "", ""])[:3], allowed) if paras else None
    for i in items:
        i["article_id"] = str(i["article_id"]) if i["article_id"] else None
    rep["items"] = items
    rep["candidates_total"] = total
    return rep


def set_selected(item_id: int, selected: bool) -> None:
    with _get_engine().begin() as conn:
        conn.execute(sql_text(
            "UPDATE prionvault_vc_item SET selected = :s, manual = TRUE, updated_at = NOW() WHERE id = :id"),
            {"s": bool(selected), "id": item_id})


def add_pmid(year: int, pmid: str) -> None:
    """Add a paper by PMID (not in the candidates, or older/other year)."""
    from ..ingestion.metadata_resolver import pubmed_by_pmid, pubmed_efetch_abstract
    meta = pubmed_by_pmid(pmid)
    if not meta or not meta.title:
        raise LookupError(f"PMID {pmid} no encontrado en PubMed")
    with _get_engine().begin() as conn:
        aid = conn.execute(sql_text("SELECT id FROM articles WHERE pubmed_id = :p LIMIT 1"),
                           {"p": pmid}).scalar()
        conn.execute(sql_text("""
            INSERT INTO prionvault_vc_item (year, pmid, doi, article_id, title, authors, journal, pub_year,
                                            in_library, abstract, selected, manual, reason)
            VALUES (:y, :p, :d, :aid, :t, :a, :j, :py, :lib, :abs, TRUE, TRUE, 'Añadido manualmente.')
            ON CONFLICT (year, pmid) WHERE pmid IS NOT NULL DO UPDATE SET selected = TRUE, manual = TRUE"""),
            {"y": year, "p": pmid, "d": (meta.doi or "").lower() or None, "aid": aid,
             "t": meta.title, "a": meta.authors or "", "j": meta.journal or "", "py": meta.year,
             "lib": bool(aid), "abs": pubmed_efetch_abstract(pmid)})


def save_text(year: int, title: str, authors: str, paragraphs: list[str], by_user=None) -> None:
    body = "\n\n".join(p.strip() for p in paragraphs if p.strip())
    with _get_engine().begin() as conn:
        conn.execute(sql_text("""
            UPDATE prionvault_vc_report SET title = :t, authors = :a, body = :b, updated_at = NOW()
             WHERE year = :y"""),
            {"t": title.strip(), "a": authors.strip(), "b": body, "y": year})
        _add_version(conn, year, "manual", title.strip(), authors.strip(), body,
                     summary="Edición manual.", by_user=by_user)


def export_docx(year: int) -> bytes:
    """The report as .docx: Times New Roman 11 pt, as the guidelines ask."""
    import io
    from docx import Document
    from docx.shared import Pt
    with _get_engine().connect() as conn:
        rep = conn.execute(sql_text(
            "SELECT title, authors, body FROM prionvault_vc_report WHERE year = :y"),
            {"y": year}).mappings().first()
    if not rep:
        raise LookupError(year)
    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = "Times New Roman"
    style.font.size = Pt(11)
    style.element.rPr.rFonts.set(
        "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}eastAsia", "Times New Roman")
    p = doc.add_paragraph()
    r = p.add_run(rep["title"] or f"Competitive surveillance {year}")
    r.bold = True
    p = doc.add_paragraph()
    p.add_run(f"Authors: {rep['authors']}").italic = True
    for para in (rep["body"] or "").split("\n\n"):
        if para.strip():
            doc.add_paragraph(para.strip())
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
