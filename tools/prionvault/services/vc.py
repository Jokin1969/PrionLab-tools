"""Vigilancia competitiva (VC) — the lab's yearly competitive-surveillance
report (ISO 56001).

Phase 1 (this module): the historical reports (2018–2025, digested from the
lab's .docx into data/vc_history.json) live in `prionvault_vc_report`, and
every reference they cite is resolved to a PrionVault article — found by
DOI/PMID, imported from PubMed/CrossRef when missing, or, for the
"Author et al. year" citations of 2019/2020, searched on PubMed and picked
with AI from the sentence that cites it. Resolved articles go into the
collection "VC <year>" (group "Vigilancia competitiva"), so the sidebar can
show all VC articles or one year's.

The resolution runs in a background thread (≈280 references, several
network calls each) with progress exposed through get_status().
"""
from __future__ import annotations

import json
import logging
import re
import threading
import uuid as _uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from sqlalchemy import text as sql_text

from ..ingestion.queue import _get_engine
from . import job_lock as _job_lock

logger = logging.getLogger(__name__)

GROUP = "Vigilancia competitiva"
DATA_FILE = Path(__file__).resolve().parents[1] / "data" / "vc_history.json"
_TOPIC = ("(prion OR prions OR PrP OR scrapie OR Creutzfeldt OR spongiform OR "
          "\"chronic wasting\" OR amyloid OR synuclein OR tau OR neurodegenerat*)")

_lock = threading.Lock()
_state: dict = {"running": False, "started_at": None, "finished_at": None,
                "total": 0, "done": 0, "linked": 0, "created": 0,
                "ambiguous": 0, "not_found": 0, "errors": 0,
                "current": None, "last_error": None, "stop_requested": False}


def collection_name(year: int) -> str:
    return f"VC {year}"


# ── Seeding the historical reports ───────────────────────────────────────────

def _ref_key(r: dict) -> str:
    if r.get("key"):                      # 2018 numbered list
        return f"n:{r['key']}"
    if r.get("doi"):
        return "doi:" + r["doi"].lower()
    if r.get("pmid"):
        return "pmid:" + r["pmid"]
    return "ay:" + r.get("cite", "") + ("#%d" % r["occurrence"] if r.get("occurrence") else "")


def seed_history() -> dict:
    """Load data/vc_history.json into the tables. Idempotent: report texts
    are refreshed only while still 'historical'; references are inserted
    once (resolution results are never reset)."""
    data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    eng = _get_engine()
    n_refs = 0
    with eng.begin() as conn:
        for rep in data:
            conn.execute(sql_text("""
                INSERT INTO prionvault_vc_report (year, title, authors, body, status)
                VALUES (:y, :t, :a, :b, 'historical')
                ON CONFLICT (year) DO UPDATE
                   SET title = EXCLUDED.title, authors = EXCLUDED.authors,
                       body = EXCLUDED.body, updated_at = NOW()
                 WHERE prionvault_vc_report.status = 'historical'
            """), {"y": rep["year"], "t": rep["title"], "a": rep["authors"],
                   "b": "\n\n".join(rep["paragraphs"])})
            for r in rep["refs"]:
                res = conn.execute(sql_text("""
                    INSERT INTO prionvault_vc_ref (year, ref_key, cite, doi, pmid, context)
                    VALUES (:y, :k, :c, :d, :p, :ctx)
                    ON CONFLICT (year, ref_key) DO NOTHING
                """), {"y": rep["year"], "k": _ref_key(r), "c": (r.get("cite") or "")[:500],
                       "d": r.get("doi"), "p": r.get("pmid"), "ctx": r.get("context") or ""})
                n_refs += res.rowcount or 0
    return {"reports": len(data), "new_refs": n_refs}


# ── Collections ──────────────────────────────────────────────────────────────

def ensure_collection(year: int, created_by=None) -> str:
    eng = _get_engine()
    with eng.connect() as conn:
        row = conn.execute(sql_text(
            "SELECT id FROM prionvault_collection WHERE lower(name) = lower(:n)"),
            {"n": collection_name(year)}).first()
    if row:
        return str(row[0])
    from . import collections as _coll
    c = _coll.create(name=collection_name(year),
                     description=f"Artículos citados en la Vigilancia competitiva {year}.",
                     group_name=GROUP, created_by=created_by)
    return str(c["id"])


# ── Resolution helpers ───────────────────────────────────────────────────────

def _find_article(doi: Optional[str], pmid: Optional[str]) -> Optional[str]:
    eng = _get_engine()
    with eng.connect() as conn:
        if pmid:
            r = conn.execute(sql_text(
                "SELECT id FROM articles WHERE pubmed_id = :p LIMIT 1"), {"p": str(pmid)}).first()
            if r:
                return str(r[0])
        if doi:
            r = conn.execute(sql_text(
                "SELECT id FROM articles WHERE lower(doi) = lower(:d) LIMIT 1"), {"d": doi}).first()
            if r:
                return str(r[0])
    return None


def _fetch_meta(doi: Optional[str], pmid: Optional[str]):
    from ..ingestion import metadata_resolver as mr
    meta = None
    if pmid:
        meta = mr.pubmed_by_pmid(str(pmid))
    if not meta and doi:
        meta = mr.pubmed_by_doi(doi) or mr.crossref_by_doi(doi)
    return meta


def _create_article(meta, by_user=None) -> str:
    """Insert a PubMed/CrossRef record as a (PDF-less) article. The usual
    batch tools (OA PDF fetch, abstracts, summaries) can complete it later."""
    eng = _get_engine()
    new_id = str(_uuid.uuid4())
    with eng.begin() as conn:
        conn.execute(sql_text("""
            INSERT INTO articles (id, title, authors, year, journal, doi, pubmed_id,
                                  abstract, source, added_by_id, created_at, updated_at)
            VALUES (:id, :title, :authors, :year, :journal, :doi, :pmid,
                    :abstract, 'vigilancia_competitiva', :by, NOW(), NOW())
        """), {"id": new_id, "title": meta.title or "(sin título)", "authors": meta.authors,
               "year": meta.year, "journal": (meta.journal or "")[:500] or None,
               "doi": (meta.doi or "").lower() or None, "pmid": meta.pubmed_id,
               "abstract": meta.abstract, "by": str(by_user) if by_user else None})
    return new_id


def _parse_author_year(cite: str):
    """'Mays CE. Et al. 2019' -> ('Mays', 'CE', 2019); 'Haley et al. 2020' -> ('Haley', '', 2020)."""
    m = re.match(r"\s*([^\s.]+(?:[ -][A-Z][a-zà-ÿ][^\s.]*)?)\s*([A-Z]{1,3})?\.?", cite)
    y = re.search(r"(19|20)\d{2}", cite)
    if not m:
        return None, None, int(y.group(0)) if y else None
    return m.group(1), (m.group(2) or ""), (int(y.group(0)) if y else None)


def _pubmed_candidates(surname: str, initials: str, year: int) -> list[dict]:
    from .pack_suggest import _esearch, _esummary_batch
    au = f"{surname} {initials}".strip()
    seen, ids = set(), []
    for q in (f"{au}[au] AND {year}[dp] AND {_TOPIC}",
              f"{surname}[au] AND {year}[dp] AND {_TOPIC}",
              f"{au}[au] AND {year}[dp]"):
        for p in _esearch(q, retmax=15):
            if p not in seen:
                seen.add(p)
                ids.append(p)
        if ids:
            break
    summ = _esummary_batch(ids[:15])
    return [summ[p] for p in ids[:15] if p in summ]


_PICK_SYSTEM = (
    "You identify which PubMed record a citation in a scientific report refers to. "
    "You get the citation as written (first author + year), the sentence of the report "
    "that cites it, and candidate PubMed records. Pick the candidate whose title matches "
    "what the sentence says about that citation. If none clearly fits, return null. "
    'Answer only JSON: {"pmid": "<pmid or null>", "confidence": <0..1>, "reason": "<short>"}'
)


def _ai_pick(cite: str, context: str, cands: list[dict]) -> tuple[Optional[str], float, str]:
    from .llm_pool import call_llm_json_with_fallback
    lines = "\n".join(f"- PMID {c['pmid']} | {c.get('year')} | {c.get('authors') or ''} | {c.get('title')}"
                      for c in cands)
    user = (f"Citation: {cite}\nCiting sentence: {context}\n\nCandidates:\n{lines}")
    parsed, _info = call_llm_json_with_fallback(
        providers=["anthropic", "openai", "gemini"], system=_PICK_SYSTEM, user=user,
        max_tokens=300, timeout=60, max_attempts=1)
    pmid = parsed.get("pmid")
    pmid = str(pmid) if pmid and str(pmid).isdigit() else None
    if pmid and pmid not in {c["pmid"] for c in cands}:
        pmid = None
    try:
        conf = float(parsed.get("confidence") or 0)
    except (TypeError, ValueError):
        conf = 0.0
    return pmid, conf, str(parsed.get("reason") or "")[:300]


def _set_ref(ref_id, **f) -> None:
    sets = ", ".join(f"{k} = :{k}" for k in f)
    params = {**f, "id": ref_id}
    if "candidates" in params:
        sets = sets.replace("candidates = :candidates", "candidates = CAST(:candidates AS jsonb)")
        params["candidates"] = json.dumps(params["candidates"], ensure_ascii=False)
    with _get_engine().begin() as conn:
        conn.execute(sql_text(f"UPDATE prionvault_vc_ref SET {sets}, updated_at = NOW() WHERE id = :id"),
                     params)


def link_ref(ref_id: int, article_id: str, status: str = "linked", note: str = "") -> None:
    """Point a reference at an article and put that article in its year's collection."""
    with _get_engine().connect() as conn:
        year = conn.execute(sql_text("SELECT year FROM prionvault_vc_ref WHERE id = :id"),
                            {"id": ref_id}).scalar()
    _set_ref(ref_id, article_id=article_id, status=status, note=note)
    from . import collections as _coll
    _coll.add_articles(ensure_collection(int(year)), [article_id])


def resolve_ref(ref: dict, by_user=None) -> str:
    """Resolve one reference. Returns its new status."""
    doi, pmid = ref.get("doi"), ref.get("pmid")
    if doi or pmid:
        aid = _find_article(doi, pmid)
        if aid:
            link_ref(ref["id"], aid, "linked")
            return "linked"
        meta = _fetch_meta(doi, pmid)
        if not meta or not meta.title:
            _set_ref(ref["id"], status="not_found",
                     note="No encontrado en PubMed ni CrossRef.")
            return "not_found"
        aid = _find_article(meta.doi, meta.pubmed_id) or _create_article(meta, by_user)
        link_ref(ref["id"], aid, "created", note=f"Importado de {meta.source or 'PubMed'}.")
        return "created"

    cite = ref.get("cite") or ""
    if len(cite) > 60 and " et al" not in cite[:40]:
        # A full bibliographic entry without ids (e.g. 2018's "in press"
        # paper): search PubMed by its title.
        from ..ingestion.metadata_resolver import pubmed_search_pmid_by_title
        title = cite.split(". ")[0]
        surname = re.split(r"[ ,.]", cite.split(". ")[1].strip())[0] if ". " in cite else None
        found = pubmed_search_pmid_by_title(title, author=surname)
        if found:
            return pick_pmid(ref["id"], found, by_user=by_user,
                             note="Encontrado en PubMed por el título.")
        _set_ref(ref["id"], status="not_found", note="Título no encontrado en PubMed.")
        return "not_found"

    # "Author et al. year" (2019/2020 reports): PubMed search + AI pick.
    surname, initials, year = _parse_author_year(cite)
    year = year or ref.get("year")
    if not surname or not year:
        _set_ref(ref["id"], status="not_found", note="Cita sin autor/año reconocible.")
        return "not_found"
    cands = _pubmed_candidates(surname, initials, year)
    # A second citation with the same author-year (e.g. two "Llorens F 2020")
    # must not land on the paper the first one already took.
    with _get_engine().connect() as conn:
        taken = {str(r[0]) for r in conn.execute(sql_text("""
            SELECT a.pubmed_id FROM prionvault_vc_ref v JOIN articles a ON a.id = v.article_id
             WHERE v.year = :y AND v.id <> :id AND v.cite = :c"""),
            {"y": ref["year"], "id": ref["id"], "c": ref["cite"]}) if r[0]}
    cands = [c for c in cands if c["pmid"] not in taken]
    if not cands:
        _set_ref(ref["id"], status="not_found", candidates=[],
                 note=f"Sin resultados en PubMed para {surname} {initials} {year}.")
        return "not_found"
    pmid, conf, reason = _ai_pick(ref["cite"], ref.get("context") or "", cands)
    slim = [{k: c.get(k) for k in ("pmid", "title", "authors", "year", "journal", "doi")}
            for c in cands]
    if not pmid or conf < 0.6:
        _set_ref(ref["id"], status="ambiguous", candidates=slim,
                 note=f"Revisar: la IA no está segura ({conf:.2f}). {reason}")
        return "ambiguous"
    _set_ref(ref["id"], candidates=slim)
    st = pick_pmid(ref["id"], pmid, by_user=by_user,
                   note=f"Elegido por IA entre {len(cands)} candidatos ({conf:.2f}): {reason}")
    return st


def pick_pmid(ref_id: int, pmid: str, by_user=None, note: str = "Elegido manualmente.") -> str:
    aid = _find_article(None, pmid)
    status = "linked"
    if not aid:
        meta = _fetch_meta(None, pmid)
        if not meta or not meta.title:
            raise LookupError(f"PMID {pmid} no encontrado en PubMed")
        aid = _create_article(meta, by_user)
        status = "created"
    link_ref(ref_id, aid, status, note=note)
    return status


# ── Background job ───────────────────────────────────────────────────────────

def get_status() -> dict:
    with _lock:
        snap = dict(_state)
    if not snap.get("running") and _job_lock.running_elsewhere("vc_resolve"):
        snap["running"] = True
        snap["note"] = "En marcha en otro proceso del servidor."
    return snap


def stop() -> dict:
    with _lock:
        if _state["running"]:
            _state["stop_requested"] = True
    _job_lock.request_stop("vc_resolve")
    return get_status()


def start_resolve(*, by_user=None, retry_ambiguous: bool = False) -> Optional[dict]:
    with _lock:
        if _state["running"]:
            return None
        _state.update({"running": True, "started_at": datetime.utcnow().isoformat(),
                       "finished_at": None, "total": 0, "done": 0, "linked": 0,
                       "created": 0, "ambiguous": 0, "not_found": 0, "errors": 0,
                       "current": None, "last_error": None, "stop_requested": False})
    th = threading.Thread(
        target=_job_lock.guarded("vc_resolve", _run, _state, _lock),
        kwargs={"by_user": by_user, "retry_ambiguous": retry_ambiguous},
        name="prionvault-vc-resolve", daemon=True)
    th.start()
    return get_status()


def _run(*, by_user=None, retry_ambiguous=False) -> None:
    try:
        seed_history()
        statuses = ["pending", "error", "not_found"] + (["ambiguous"] if retry_ambiguous else [])
        with _get_engine().connect() as conn:
            refs = [dict(r) for r in conn.execute(sql_text("""
                SELECT id, year, cite, doi, pmid, context FROM prionvault_vc_ref
                 WHERE status = ANY(:s) ORDER BY year, id"""), {"s": statuses}).mappings()]
        with _lock:
            _state["total"] = len(refs)
        for ref in refs:
            with _lock:
                if _state["stop_requested"]:
                    break
                _state["current"] = f"{ref['year']} · {ref['cite'] or ref['doi'] or ref['pmid']}"
            try:
                st = resolve_ref(ref, by_user=by_user)
                key = {"linked": "linked", "created": "created", "ambiguous": "ambiguous"}.get(st, "not_found")
            except Exception as exc:
                logger.warning("vc: resolving ref %s failed: %s", ref["id"], exc)
                _set_ref(ref["id"], status="error", note=str(exc)[:300])
                key = "errors"
                with _lock:
                    _state["last_error"] = str(exc)[:300]
            with _lock:
                _state[key] += 1
                _state["done"] += 1
    except Exception as exc:
        logger.exception("vc: resolve job crashed")
        with _lock:
            _state["last_error"] = f"crash: {exc}"[:300]
    finally:
        with _lock:
            _state["running"] = False
            _state["current"] = None
            _state["finished_at"] = datetime.utcnow().isoformat()


# ── Read API helpers ─────────────────────────────────────────────────────────

def list_reports() -> list[dict]:
    with _get_engine().connect() as conn:
        rows = conn.execute(sql_text("""
            SELECT r.year, r.title, r.authors, r.status,
                   COUNT(v.id)                                         AS refs,
                   COUNT(v.id) FILTER (WHERE v.article_id IS NOT NULL) AS resolved,
                   COUNT(v.id) FILTER (WHERE v.status = 'ambiguous')   AS ambiguous,
                   COUNT(v.id) FILTER (WHERE v.status IN ('not_found','error')) AS missing
              FROM prionvault_vc_report r
              LEFT JOIN prionvault_vc_ref v ON v.year = r.year
             GROUP BY r.year ORDER BY r.year""")).mappings().all()
        colls = {r[0]: str(r[1]) for r in conn.execute(sql_text(
            "SELECT name, id FROM prionvault_collection WHERE lower(group_name) = lower(:g)"),
            {"g": GROUP})}
    out = []
    for r in rows:
        d = dict(r)
        d["collection_id"] = colls.get(collection_name(d["year"]))
        out.append(d)
    return out


def get_report(year: int) -> Optional[dict]:
    with _get_engine().connect() as conn:
        rep = conn.execute(sql_text(
            "SELECT year, title, authors, body, status FROM prionvault_vc_report WHERE year = :y"),
            {"y": year}).mappings().first()
        if not rep:
            return None
        refs = conn.execute(sql_text("""
            SELECT v.id, v.ref_key, v.cite, v.doi, v.pmid, v.status, v.note, v.candidates,
                   v.article_id, a.title AS article_title, a.year AS article_year,
                   a.journal AS article_journal, a.authors AS article_authors
              FROM prionvault_vc_ref v LEFT JOIN articles a ON a.id = v.article_id
             WHERE v.year = :y ORDER BY v.id"""), {"y": year}).mappings().all()
    d = dict(rep)
    d["paragraphs"] = [p for p in (d.pop("body") or "").split("\n\n") if p.strip()]
    d["refs"] = [{**dict(r), "article_id": str(r["article_id"]) if r["article_id"] else None}
                 for r in refs]
    return d
