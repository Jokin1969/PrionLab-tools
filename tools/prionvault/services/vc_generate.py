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
            scores = {int(s["i"]): float(s["s"]) for s in parsed.get("scores", [])
                      if str(s.get("i", "")).isdigit()}
        except Exception as exc:
            logger.warning("vc screen batch failed: %s", exc)
            scores = {}
        with eng.begin() as conn:
            for i, r in enumerate(chunk, 1):
                conn.execute(sql_text(
                    "UPDATE prionvault_vc_item SET screen_score = :s WHERE id = :id"),
                    {"s": scores.get(i, 0.0), "id": r["id"]})
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
signal, not the criterion. Reviews, case reports and incremental work score low.
- "why": ONE short sentence in Spanish explaining why it matters (or why not).
Answer only JSON: {"scores": [{"i": <number>, "s": <0-100>, "why": "<...>"}]}."""


def _score_shortlist(year: int) -> None:
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text("""
            SELECT id, pmid, title, journal, quartile, abstract,
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
                "SELECT id, pmid, title, journal, quartile, abstract FROM prionvault_vc_item "
                "WHERE id = ANY(:ids)"), {"ids": [r["id"] for r in rows]}).mappings().all()
    batch = 15
    _set(phase="Valoración con IA (abstracts)", done=0, total=len(rows))
    for k in range(0, len(rows), batch):
        if _stopped():
            return
        chunk = rows[k:k + batch]
        user = "\n\n".join(
            f"{i + 1}. {r['title']}\nJournal: {r['journal']} ({r['quartile'] or 'quartile n/a'})\n"
            f"Abstract: {(r['abstract'] or '(no abstract)')[:1500]}" for i, r in enumerate(chunk))
        try:
            parsed = _call(_SCORE_SYSTEM, user, strong=True, max_tokens=3000)
            res = {int(s["i"]): s for s in parsed.get("scores", []) if str(s.get("i", "")).isdigit()}
        except Exception as exc:
            logger.warning("vc score batch failed: %s", exc)
            res = {}
        with eng.begin() as conn:
            for i, r in enumerate(chunk, 1):
                s = res.get(i) or {}
                conn.execute(sql_text(
                    "UPDATE prionvault_vc_item SET score = :s, reason = :w WHERE id = :id"),
                    {"s": float(s.get("s") or 0), "w": str(s.get("why") or "")[:400], "id": r["id"]})
        _set(done=min(k + batch, len(rows)))


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


def step_select(year: int, n_final: int = N_FINAL) -> dict:
    ensure_draft(year)
    _set(phase="Reuniendo candidatos", done=0, total=0)
    n = _gather_candidates(year)
    _fill_quartiles(year)
    _screen(year)
    if _stopped():
        return {"stopped": True}
    _score_shortlist(year)
    if _stopped():
        return {"stopped": True}
    picked = _preselect(year, n_final)
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
            SELECT id, pmid, doi, title, journal, quartile, abstract, score, reason, theme
              FROM prionvault_vc_item WHERE year = :y AND selected
             ORDER BY score DESC NULLS LAST"""), {"y": year}).mappings()]


_THEMES_SYSTEM = """You are the senior author of a prion research group's yearly competitive-surveillance report. \
Group the selected papers of the year into 4–6 coherent themes for the "advances" paragraph, ordered as the \
narrative should flow (most important first). Use the previous reports as memory: keep continuity with recurring \
themes and explicitly connect to what LAST year's report expected for this year (confirmed, partly, or not yet). \
Every paper must belong to exactly one theme. Answer only JSON:
{"themes": [{"name": "<short English name>", "summary": "<2-3 sentences in Spanish: what happened this year>", \
"continuity": "<1 sentence in Spanish linking to previous reports/expectations, or empty>", "pmids": ["..."]}]}"""


def step_themes(year: int) -> dict:
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
                   f"SELECTED PAPERS OF {year}:\n{papers}",
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

_WRITE_SYSTEM = f"""You write the yearly "competitive surveillance" report of a prion research group \
(Joaquín Castilla's Prion Research Laboratory, CIC bioGUNE) for the institute's Scientific Annual Review.

{_GUIDELINES}

Style: match the previous reports provided (scientific but accessible English, flowing paragraphs that link the \
papers coherently — each cited paper is woven into the narrative with what it showed and why it matters, grouped \
by theme; no bullet points, no headings inside paragraphs). Cite ONLY the PMIDs you are given, each in brackets \
right after the statement it supports. Prefer citing most of the selected papers; group several PMIDs in one \
bracket when they support the same point.
Answer only JSON: {{"title": "...", "intro": "<paragraph 1>", "advances": "<paragraph 2>", "outlook": "<paragraph 3>"}}"""


def _cited_pmids(text: str) -> list[str]:
    out = []
    for m in re.finditer(r"PMID:?\s*([\d,;\s]+)", text):
        out += re.findall(r"\d{7,9}", m.group(1))
    return out


def validate(intro: str, advances: str, outlook: str, allowed: set[str]) -> dict:
    total = len(intro) + len(advances) + len(outlook) + 2   # paragraph separators
    shares = [len(p) / max(1, total) for p in (intro, advances, outlook)]
    cited = _cited_pmids(" ".join((intro, advances, outlook)))
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
        problems.append("These PMIDs are not in the provided list and must be removed: " + ", ".join(unknown))
    if len(set(cited)) < 10:
        problems.append("Cite more of the provided papers (at least 10 distinct PMIDs).")
    return {"chars": total, "shares": [round(x, 3) for x in shares], "cited": len(set(cited)),
            "unknown_pmids": unknown, "problems": problems, "ok": not problems}


def step_write(year: int, instructions: str = "") -> dict:
    items = _selected_items(year)
    if not items:
        raise ValueError("No hay artículos seleccionados.")
    with _get_engine().connect() as conn:
        rep = conn.execute(sql_text("SELECT themes, authors FROM prionvault_vc_report WHERE year = :y"),
                           {"y": year}).mappings().first()
    themes = (rep or {}).get("themes") or []
    past = _past_reports(year)
    examples = "\n\n".join(f"=== VC {p['year']} (example of style; do NOT copy)\nTitle: {p['title']}\n{p['body']}"
                           for p in past if p["year"] >= year - 3)
    by_id = {str(it["pmid"] or it["doi"]): it for it in items}
    lines = []
    for t in themes or [{"name": "Advances", "pmids": list(by_id)}]:
        lines.append(f"## {t.get('name')}: {t.get('summary', '')} {t.get('continuity', '')}")
        for p in t.get("pmids") or []:
            it = by_id.get(str(p))
            if it:
                lines.append(f"- PMID {it['pmid']}: {it['title']} ({it['journal']}). Why: {it['reason']}"
                             f" Key findings: {(it['abstract'] or '')[:450]}")
    allowed = {str(it["pmid"]) for it in items if it["pmid"]}
    last_outlook = past[-1]["body"].split("\n\n")[-1] if past else ""
    user = (f"{examples}\n\nLAST YEAR'S OUTLOOK (what was expected for {year}):\n{last_outlook}\n\n"
            f"SELECTED PAPERS OF {year} BY THEME:\n" + "\n".join(lines) +
            f"\n\nWrite the {year} report (paragraph 3 looks ahead to {year + 1})."
            + (f"\n\nAdditional instructions from the authors: {instructions}" if instructions else ""))
    _set(phase="Redactando", done=0, total=4)
    draft = _call(_WRITE_SYSTEM, user, strong=True, max_tokens=4000)
    check = validate(draft.get("intro", ""), draft.get("advances", ""), draft.get("outlook", ""), allowed)
    attempt = 1
    while not check["ok"] and attempt < 4 and not _stopped():
        _set(phase=f"Revisando ({'; '.join(check['problems'])[:120]})", done=attempt)
        draft = _call(_WRITE_SYSTEM,
                      user + "\n\nYOUR PREVIOUS DRAFT:\n" + json.dumps(draft, ensure_ascii=False) +
                      "\n\nRevise it to fix ALL of these problems, keeping its content and style:\n- " +
                      "\n- ".join(check["problems"]),
                      strong=True, max_tokens=4000)
        check = validate(draft.get("intro", ""), draft.get("advances", ""), draft.get("outlook", ""), allowed)
        attempt += 1
    body = "\n\n".join(draft.get(k, "").strip() for k in ("intro", "advances", "outlook"))
    with _get_engine().begin() as conn:
        conn.execute(sql_text("""
            UPDATE prionvault_vc_report SET title = :t, body = :b, authors = coalesce(nullif(authors, ''), :a),
                   updated_at = NOW() WHERE year = :y"""),
            {"t": (draft.get("title") or "").strip(), "b": body, "a": AUTHORS, "y": year})
    _set(done=4)
    info = {**check, "attempts": attempt, "instructions": instructions[:500]}
    _log(year, "write", info)
    return info


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


_STEPS = {"select": step_select, "themes": step_themes, "write": step_write}


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
    with _get_engine().connect() as conn:
        rep = dict(conn.execute(sql_text(
            "SELECT year, title, authors, body, status, themes, pipeline FROM prionvault_vc_report WHERE year = :y"),
            {"y": year}).mappings().first())
        items = [dict(r) for r in conn.execute(sql_text("""
            SELECT id, pmid, doi, article_id, title, journal, pub_year, quartile, in_library,
                   screen_score, score, reason, theme, selected, manual
              FROM prionvault_vc_item WHERE year = :y
             ORDER BY selected DESC, score DESC NULLS LAST, screen_score DESC NULLS LAST
             LIMIT 300"""), {"y": year}).mappings()]
        total = conn.execute(sql_text("SELECT COUNT(*) FROM prionvault_vc_item WHERE year = :y"),
                             {"y": year}).scalar()
    paras = [p for p in (rep.pop("body") or "").split("\n\n") if p.strip()]
    allowed = {str(i["pmid"]) for i in items if i["selected"] and i["pmid"]}
    rep["paragraphs"] = paras
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


def save_text(year: int, title: str, authors: str, paragraphs: list[str]) -> None:
    with _get_engine().begin() as conn:
        conn.execute(sql_text("""
            UPDATE prionvault_vc_report SET title = :t, authors = :a, body = :b, updated_at = NOW()
             WHERE year = :y"""),
            {"t": title.strip(), "a": authors.strip(),
             "b": "\n\n".join(p.strip() for p in paragraphs if p.strip()), "y": year})


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
