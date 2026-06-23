"""AI-driven "what else fits in this pack?" recommendations.

Two flavours, both fed from the same pack profile:

  suggest_internal(pack, ...)
      Embed the profile with Voyage, run a top-K pgvector search
      against article_chunk, exclude papers already in the pack,
      optionally rerank with Voyage rerank-2, optionally have an
      LLM (Anthropic / OpenAI / Gemini) write a one-paragraph
      rationale + 1-5 note for each top candidate.

  suggest_pubmed(pack, ...)
      Ask the LLM to extract 4-6 PubMed E-Search queries from the
      profile. Aggregate hits across queries (a PMID returned by
      more queries scores higher). Filter out PMIDs already in
      PrionVault. Fetch metadata for the top candidates and
      optionally rationale.

The profile builder is shared: pack title + introduction +
discussion + (summary_ai or abstract) of every article whose DOI
appears in the pack's reference lists. Capped at ~30 kB so the
context fits comfortably in any of the three providers.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Iterable, Optional

from sqlalchemy import text as sql_text

from ..ingestion.queue import _get_engine
from ..ingestion.metadata_resolver import (
    _PUBMED_ESEARCH, _PUBMED_ESUMMARY, _HDRS, _TIMEOUT,
)
from .llm_pool import call_llm_json, call_llm_json_with_fallback, NotConfigured

# Default fallback order — caller-provided provider always goes first.
_DEFAULT_PROVIDERS = ("anthropic", "openai", "gemini")


def _provider_chain(provider: str) -> list[str]:
    """Caller's choice first, then the remaining providers in a fixed
    order. Keeps the chain deterministic and lets the operator pick
    which model gets the cheap path while still falling back."""
    p = (provider or "").strip().lower()
    chain = [p] if p else []
    for q in _DEFAULT_PROVIDERS:
        if q not in chain:
            chain.append(q)
    return chain

logger = logging.getLogger(__name__)


# Same regex the listing's PrionPack badge + prionpack_sync use, so
# all three paths agree on what counts as a DOI inside a free-text
# reference string.
_DOI_RE = re.compile(r"10\.\d{4,}/[^\s'\";,)>\]]+", re.IGNORECASE)

# Max characters of the pack profile we ship to the LLM / embed.
# Voyage handles up to 32k; the LLMs we use have huge context
# windows; this is a safety cap to keep cost predictable.
_PROFILE_MAX_CHARS    = 30_000
# Per-article slice of summary or abstract included in the profile.
# Keeps the profile tight even if the pack has 30 papers with long
# AI summaries.
_PER_ARTICLE_SUMMARY  = 1_400
# Per-candidate context passed to the rationale LLM. Smaller because
# we pass MANY at once.
_PER_CANDIDATE_CHARS  = 600

# ─── Profile builder ──────────────────────────────────────────────────────────

def _extract_dois(value) -> list[str]:
    if not isinstance(value, str):
        return []
    return [m.group(0).rstrip(".,;").lower() for m in _DOI_RE.finditer(value)]


def _pack_doi_set(pack: dict, scope: str = "all") -> set[str]:
    """DOIs that should be treated as "already in the pack" for the
    given scope. `intro` → only intro refs, `discussion` → only general
    refs, anything else (or 'all') → both. The exclude list is built
    from this so a suggestion never re-proposes a paper already cited
    in the same section the operator is asking about."""
    dois: set[str] = set()
    if scope in ("all", "intro", "title"):
        for ref in (pack.get("introReferences") or []):
            dois.update(_extract_dois(ref))
    if scope in ("all", "discussion", "title"):
        for ref in (pack.get("references") or []):
            dois.update(_extract_dois(ref))
    return dois


def _load_member_articles(dois: Iterable[str]) -> list[dict]:
    """Resolve a set of DOIs to the PrionVault articles that carry
    them. Returns a list with the fields we'll feed into the profile."""
    dois = sorted({d.strip().lower() for d in dois if d and isinstance(d, str)})
    if not dois:
        return []
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text("""
            SELECT id, title, authors, year, journal, doi, pubmed_id,
                   summary_ai, abstract
              FROM articles
             WHERE lower(doi) = ANY(:dois)
             ORDER BY year DESC NULLS LAST
        """), {"dois": dois}).mappings().all()
    return [dict(r) for r in rows]


def build_profile(pack: dict, scope: str = "all") -> dict:
    """Compose the thematic profile of `pack`. Title and description
    are always included because both anchor the topic; `scope` picks
    which section drives the rest:

      - 'intro'      : pack title + description + introduction body +
                       per-member summary of the articles cited in
                       `introReferences`.
      - 'discussion' : pack title + description + discussion body +
                       per-member summary of articles cited in
                       `references`.
      - 'all' (or anything else): both sections + every cited article
                       (legacy behaviour — used by tooling that doesn't
                       set the field explicitly).

    Returns {profile_text, member_article_ids, total_chars, scope}.
    member_article_ids drives the exclusion in suggest_internal so a
    suggestion never re-proposes an article already cited within the
    same scope.
    """
    scope = (scope or "all").lower().strip()
    if scope not in {"all", "intro", "discussion", "title"}:
        scope = "all"

    parts = []
    title = (pack.get("title") or "").strip()
    if title:
        parts.append(f"# Pack: {title}\n")

    # The description usually carries the *objective* of the manuscript
    # — short but high signal, so we keep it on every scope.
    desc = (pack.get("description") or "").strip()
    if desc:
        parts.append("## Descripción del pack\n" + desc[:4000] + "\n")

    if scope == "title":
        # Title scope: only pack title + alt titles — no section text, no article body
        alt_titles = [t for t in (pack.get("altTitles") or []) if t and isinstance(t, str)]
        if alt_titles:
            parts.append("## Títulos alternativos\n" + "\n".join(f"- {t}" for t in alt_titles) + "\n")
    if scope in ("all", "intro"):
        intro = (pack.get("introduction") or "").strip()
        if intro:
            parts.append("## Introducción\n" + intro[:6000] + "\n")
    if scope in ("all", "discussion"):
        disc = (pack.get("discussion") or "").strip()
        if disc:
            parts.append("## Discusión\n" + disc[:6000] + "\n")

    members = _load_member_articles(_pack_doi_set(pack, scope=scope))
    member_ids: list[str] = []
    if members and scope != "title":
        section_label = {
            "intro":      "Artículos citados en la introducción",
            "discussion": "Artículos citados en la discusión",
        }.get(scope, "Artículos en el pack")
        parts.append(f"## {section_label}\n")
        for m in members:
            member_ids.append(str(m["id"]))
            authors = (m.get("authors") or "").split(";")[0].strip()
            year    = m.get("year") or "?"
            journal = m.get("journal") or "?"
            header  = f"- **{authors} {year}** ({journal}): {m.get('title') or ''}"
            body    = (m.get("summary_ai") or m.get("abstract") or "").strip()
            if body:
                body = body[:_PER_ARTICLE_SUMMARY]
                parts.append(header + "\n  " + body.replace("\n", "\n  ") + "\n")
            else:
                parts.append(header + "\n")

    profile_text = "\n".join(parts)
    if len(profile_text) > _PROFILE_MAX_CHARS:
        profile_text = profile_text[:_PROFILE_MAX_CHARS] + "\n…(truncado)"
    return {
        "profile_text":       profile_text,
        "member_article_ids": member_ids,
        "member_count":       len(members),
        "total_chars":        len(profile_text),
        "scope":              scope,
    }


# ─── Internal: PrionVault catalog ─────────────────────────────────────────────

_RATIONALE_SYSTEM = (
    "Eres un científico experto en biología de priones, "
    "neurodegeneración y neurociencia traslacional. Te paso el perfil "
    "temático de un journal-club pack y una lista de artículos candidatos "
    "de la biblioteca personal del investigador.\n\n"
    "Tu tarea: para cada candidato, decide si encajaría temáticamente con "
    "el pack y por qué. Responde JSON estricto, sin texto adicional:\n\n"
    "{\"items\":[{\"id\":\"<id>\",\"note\":1-5,\"why\":\"explicación breve\"}]}\n\n"
    "Escala note: 5 = encaja perfectamente, complementa el pack | "
    "4 = relevante, claramente del mismo tema | "
    "3 = relacionado, podría aportar contexto | "
    "2 = tangencialmente relacionado, dudoso | "
    "1 = no encaja con este pack.\n\n"
    "Responde SIEMPRE en español. Sé conciso (1-2 frases por 'why'). "
    "No inventes datos del artículo, sólo usa lo que se te da."
)


def _annotate_with_rationale(profile_text: str, candidates: list[dict],
                             provider: str) -> dict:
    """Run the LLM rationale pass. Mutates `candidates` in place with
    note + why where the model provided them. Tries the caller's
    provider first and falls back to the other configured ones so a
    single empty-response from Claude doesn't leave the user with
    blank "Por qué" cards. Returns {provider, attempts, [error]}."""
    if not candidates:
        return {}
    payload = []
    for c in candidates:
        snippet = (c.get("summary_ai") or c.get("abstract") or "").strip()
        snippet = snippet[:_PER_CANDIDATE_CHARS]
        payload.append({
            "id":      c["id"],
            "title":   c.get("title") or "",
            "authors": (c.get("authors") or "").split(";")[0].strip(),
            "year":    c.get("year"),
            "journal": c.get("journal"),
            "snippet": snippet,
        })
    user = (
        f"## Perfil del pack\n{profile_text}\n\n"
        f"## Candidatos a evaluar ({len(payload)})\n"
        f"{json.dumps(payload, ensure_ascii=False)}"
    )
    try:
        parsed, info = call_llm_json_with_fallback(
            providers=_provider_chain(provider),
            system=_RATIONALE_SYSTEM, user=user, max_tokens=2400,
        )
    except RuntimeError as exc:
        logger.warning("pack_suggest: rationale call failed (%s)", exc)
        return {"error": str(exc)[:240]}
    by_id = {it.get("id"): it for it in (parsed.get("items") or []) if isinstance(it, dict)}
    for c in candidates:
        m = by_id.get(c["id"])
        if not m:
            continue
        try:
            note = int(m.get("note") or 0)
            if 1 <= note <= 5:
                c["note"] = note
        except (TypeError, ValueError):
            pass
        why = (m.get("why") or "").strip()
        if why:
            c["why"] = why[:400]
    return info


def suggest_internal(pack: dict, *, top_k: int = 10,
                     rerank: bool = True, rationale: bool = True,
                     provider: str = "anthropic",
                     scope: str = "all") -> dict:
    """Search PrionVault for articles that fit this pack thematically.
    `scope` is forwarded to the profile builder so the operator can
    target the introduction or the discussion separately."""
    profile = build_profile(pack, scope=scope)
    if not profile["profile_text"].strip():
        return {"items": [], "profile": profile, "skipped": "empty_profile"}

    # 1) Embed the profile.
    from ..embeddings.embedder import embed_query, NotConfigured as VoyageNotConfigured
    try:
        query_vec = embed_query(profile["profile_text"])
    except VoyageNotConfigured:
        return {"items": [], "profile": profile,
                "error": "voyage_not_configured"}
    if not query_vec:
        return {"items": [], "profile": profile, "error": "empty_embedding"}

    # 2) Top-K via pgvector, grouping by article (one chunk per paper),
    #    excluding the pack's own members.
    exclude_ids = profile["member_article_ids"] or [
        "00000000-0000-0000-0000-000000000000"]
    # We fetch a wider pool so the rerank pass has material to work
    # with; if rerank is off, still over-fetch slightly so the LLM
    # rationale can drop weak ones without leaving a stubby list.
    pool_k = max(top_k * 5, 40) if rerank else max(top_k * 2, 20)
    vec_literal = "[" + ",".join(f"{v:.6f}" for v in query_vec) + "]"

    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text(f"""
            WITH q AS (SELECT CAST('{vec_literal}' AS vector) AS v)
            SELECT a.id, a.title, a.authors, a.year, a.journal,
                   a.doi, a.pubmed_id, a.summary_ai, a.abstract,
                   sub.distance
              FROM (
                SELECT c.article_id, MIN(c.embedding <=> q.v) AS distance
                  FROM article_chunk c, q
                 WHERE c.embedding IS NOT NULL
                   AND c.article_id <> ALL(CAST(:exclude AS uuid[]))
                 GROUP BY c.article_id
                 ORDER BY distance ASC
                 LIMIT :pool
              ) AS sub
              JOIN articles a ON a.id = sub.article_id
             ORDER BY sub.distance ASC
        """), {"exclude": exclude_ids, "pool": pool_k}).mappings().all()

    candidates = []
    for r in rows:
        d = float(r["distance"])
        candidates.append({
            "id":          str(r["id"]),
            "title":       r["title"],
            "authors":     r["authors"],
            "year":        r["year"],
            "journal":     r["journal"],
            "doi":         r["doi"],
            "pubmed_id":   r["pubmed_id"],
            "summary_ai":  r["summary_ai"],
            "abstract":    r["abstract"],
            "distance":    d,
            "similarity":  round(1.0 - d, 4),
            "source":      "vector",
        })

    rerank_info: dict = {}
    # 3) Voyage rerank-2 over the top candidates so the final order
    #    reflects content match, not just chunk-level cosine.
    if rerank and candidates:
        try:
            rerank_info = _voyage_rerank(profile["profile_text"], candidates)
        except Exception as exc:
            logger.warning("pack_suggest: rerank skipped (%s)", exc)
            rerank_info = {"error": str(exc)[:200]}

    candidates = candidates[:top_k]

    # 4) LLM rationale + 1-5 note for each survivor.
    rationale_info: dict = {}
    if rationale and candidates:
        try:
            rationale_info = _annotate_with_rationale(
                profile["profile_text"], candidates, provider,
            )
        except Exception as exc:
            logger.warning("pack_suggest: rationale skipped (%s)", exc)
            rationale_info = {"error": str(exc)[:200]}

    return {
        "items":     candidates,
        "profile":   profile,
        "rerank":    rerank_info,
        "rationale": rationale_info,
    }


def _voyage_rerank(profile_text: str, candidates: list[dict]) -> dict:
    """Re-score `candidates` in place via Voyage rerank-2, then sort."""
    import os
    api_key = os.environ.get("VOYAGE_API_KEY", "").strip()
    if not api_key:
        return {"skipped": "no_voyage_key"}
    import voyageai
    client = voyageai.Client(api_key=api_key)
    docs = []
    for c in candidates:
        # Title + author + summary_ai (or abstract) is what describes a
        # paper most concisely.
        body = (c.get("summary_ai") or c.get("abstract") or "")[:1500]
        author = (c.get("authors") or "").split(";")[0].strip()
        docs.append(
            f"{c.get('title') or ''}\n{author} ({c.get('year') or '?'})\n{body}"
        )
    response = client.rerank(profile_text, docs, model="rerank-2",
                             top_k=len(candidates))
    by_idx = {r.index: r for r in response.results}
    for i, c in enumerate(candidates):
        r = by_idx.get(i)
        if r is None:
            c["rerank_score"] = 0.0
            continue
        c["rerank_score"] = float(r.relevance_score)
    candidates.sort(key=lambda c: c.get("rerank_score", 0.0), reverse=True)
    return {
        "model":      "rerank-2",
        "tokens":     getattr(response, "total_tokens", None),
    }


# ─── External: PubMed ─────────────────────────────────────────────────────────

_QUERIES_SYSTEM = (
    "Eres bibliotecario experto en PubMed. Dado el perfil temático de un "
    "journal-club pack, extrae 4-6 consultas E-Search de PubMed que "
    "capturen el núcleo del pack.\n\n"
    "Reglas:\n"
    " - Puedes usar AND / OR / NOT.\n"
    " - Frases entre comillas dobles para conceptos multi-palabra.\n"
    " - Field tags admitidos: [Title/Abstract], [Title], [MeSH Major Topic], "
    "[MeSH Terms], [Author].\n"
    " - Las consultas deben ser variadas (no todas iguales). Una de ellas debe "
    "ser amplia, otras más específicas.\n"
    " - Devuelve JSON estricto, sin texto adicional:\n"
    "   {\"queries\":[\"…\", \"…\", \"…\"]}\n"
    " - 4-6 elementos en la lista. No expliques."
)

_PUBMED_RATIONALE_SYSTEM = (
    "Eres un científico experto en biología de priones. Te paso el perfil "
    "temático de un journal-club pack y una lista de artículos de PubMed "
    "que NO están en la biblioteca del investigador. Para cada uno decide "
    "si encajaría con el pack y por qué.\n\n"
    "Responde JSON estricto:\n"
    "{\"items\":[{\"pmid\":\"…\",\"note\":1-5,\"why\":\"…\"}]}\n\n"
    "Escala note: 5 = encaja perfectamente | 4 = relevante | 3 = relacionado | "
    "2 = tangencial | 1 = no encaja. Responde en español, 1-2 frases por why."
)


def _extract_queries(profile_text: str, provider: str) -> tuple[list[str], dict]:
    """Returns (queries, info). info carries the winning provider and
    the per-attempt errors so the UI can show "Claude returned empty —
    falled back to OpenAI" instead of a cryptic blank."""
    user = "## Perfil del pack\n" + profile_text
    parsed, info = call_llm_json_with_fallback(
        providers=_provider_chain(provider),
        system=_QUERIES_SYSTEM, user=user, max_tokens=800,
    )
    qs = parsed.get("queries") if isinstance(parsed, dict) else None
    if not isinstance(qs, list):
        return [], info
    cleaned = [str(q).strip() for q in qs if isinstance(q, str) and q.strip()][:6]
    return cleaned, info


def _esearch(query: str, retmax: int = 20) -> list[str]:
    import requests
    try:
        r = requests.get(_PUBMED_ESEARCH, params={
            "db": "pubmed", "term": query, "retmax": str(retmax),
            "retmode": "json", "sort": "relevance",
        }, headers=_HDRS, timeout=_TIMEOUT)
        r.raise_for_status()
    except Exception as exc:
        logger.debug("esearch failed (%s): %s", query, exc)
        return []
    data = r.json()
    ids = ((data.get("esearchresult") or {}).get("idlist")) or []
    return [str(p) for p in ids if str(p).isdigit()]


def _esummary_batch(pmids: list[str]) -> dict[str, dict]:
    """One call returns metadata for all PMIDs in `pmids`."""
    if not pmids:
        return {}
    import requests
    out: dict[str, dict] = {}
    try:
        r = requests.get(_PUBMED_ESUMMARY, params={
            "db": "pubmed", "id": ",".join(pmids[:50]),
            "retmode": "json",
        }, headers=_HDRS, timeout=_TIMEOUT)
        r.raise_for_status()
    except Exception as exc:
        logger.debug("esummary batch failed: %s", exc)
        return {}
    res = (r.json().get("result") or {})
    for pid in pmids[:50]:
        s = res.get(pid)
        if not isinstance(s, dict):
            continue
        authors = "; ".join(
            (a.get("name") or "").strip()
            for a in (s.get("authors") or []) if a.get("name")
        ) or None
        year = None
        m = re.match(r"(\d{4})", s.get("pubdate") or "")
        if m:
            year = int(m.group(1))
        # DOI sometimes lives inside articleids.
        doi = None
        for aid in s.get("articleids") or []:
            if (aid.get("idtype") or "").lower() == "doi":
                doi = (aid.get("value") or "").strip().lower() or None
                if doi:
                    break
        out[pid] = {
            "pmid":     pid,
            "title":    (s.get("title") or "").rstrip(".").strip(),
            "authors":  authors,
            "year":     year,
            "journal":  s.get("fulljournalname") or s.get("source"),
            "doi":      doi,
        }
    return out


def _already_in_prionvault(pmids: list[str]) -> set[str]:
    if not pmids:
        return set()
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text(
            "SELECT pubmed_id FROM articles WHERE pubmed_id = ANY(:p)"
        ), {"p": pmids}).all()
    return {str(r[0]) for r in rows if r[0]}


def suggest_pubmed(pack: dict, *, top_k: int = 15,
                   rationale: bool = True,
                   provider: str = "anthropic",
                   scope: str = "all") -> dict:
    """Search PubMed for articles relevant to this pack but NOT in
    PrionVault yet. `scope` is forwarded to the profile builder."""
    profile = build_profile(pack, scope=scope)
    if not profile["profile_text"].strip():
        return {"items": [], "profile": profile, "skipped": "empty_profile"}

    # 1) Extract 4-6 E-Search queries from the profile.
    try:
        queries, extract_info = _extract_queries(profile["profile_text"], provider)
    except (NotConfigured, RuntimeError) as exc:
        return {"items": [], "profile": profile,
                "error": f"query_extraction: {exc}"[:300]}
    if not queries:
        return {"items": [], "profile": profile, "skipped": "no_queries",
                "extract": extract_info}

    # 2) Aggregate PMIDs across queries. The score is "in how many
    #    queries did this PMID appear" (rough but works as a tiebreaker
    #    on top of PubMed's per-query relevance order).
    pmid_score: dict[str, int] = {}
    pmid_queries: dict[str, list[str]] = {}
    for q in queries:
        for rank, pmid in enumerate(_esearch(q, retmax=20)):
            pmid_score[pmid] = pmid_score.get(pmid, 0) + max(1, 20 - rank)
            pmid_queries.setdefault(pmid, []).append(q)

    if not pmid_score:
        return {"items": [], "profile": profile,
                "queries": queries, "skipped": "no_hits"}

    # 3) Drop PMIDs we already have in the library.
    already = _already_in_prionvault(list(pmid_score.keys()))
    fresh = [pmid for pmid in pmid_score.keys() if pmid not in already]
    fresh.sort(key=lambda p: pmid_score[p], reverse=True)
    candidates_top = fresh[:max(top_k * 2, top_k + 5)]

    # 4) Fetch metadata for the top-N (single esummary batch).
    meta = _esummary_batch(candidates_top)

    items: list[dict] = []
    for pmid in candidates_top:
        m = meta.get(pmid)
        if not m or not m.get("title"):
            continue
        items.append({
            **m,
            "score":          pmid_score[pmid],
            "matched_queries": pmid_queries[pmid][:3],
            "source":         "pubmed",
        })
    items = items[:top_k]

    # 5) Rationale pass.
    rationale_info: dict = {}
    if rationale and items:
        try:
            rationale_info = _annotate_pubmed_with_rationale(
                profile["profile_text"], items, provider,
            )
        except Exception as exc:
            logger.warning("pack_suggest: pubmed rationale skipped (%s)", exc)
            rationale_info = {"error": str(exc)[:200]}

    return {
        "items":          items,
        "profile":        profile,
        "queries":        queries,
        "already_in_pv":  len(already),
        "candidates_pre": len(candidates_top),
        "rationale":      rationale_info,
        "extract":        extract_info,
    }


def _annotate_pubmed_with_rationale(profile_text: str,
                                    items: list[dict],
                                    provider: str) -> dict:
    payload = [
        {"pmid": it["pmid"], "title": it.get("title"),
         "authors": it.get("authors"), "year": it.get("year"),
         "journal": it.get("journal")}
        for it in items
    ]
    user = (
        f"## Perfil del pack\n{profile_text}\n\n"
        f"## Candidatos de PubMed ({len(payload)})\n"
        f"{json.dumps(payload, ensure_ascii=False)}"
    )
    try:
        parsed, info = call_llm_json_with_fallback(
            providers=_provider_chain(provider),
            system=_PUBMED_RATIONALE_SYSTEM, user=user, max_tokens=2400,
        )
    except RuntimeError as exc:
        logger.warning("pack_suggest: pubmed rationale failed (%s)", exc)
        return {"error": str(exc)[:240]}
    by_pmid = {it.get("pmid"): it for it in (parsed.get("items") or []) if isinstance(it, dict)}
    for it in items:
        m = by_pmid.get(it["pmid"])
        if not m:
            continue
        try:
            note = int(m.get("note") or 0)
            if 1 <= note <= 5:
                it["note"] = note
        except (TypeError, ValueError):
            pass
        why = (m.get("why") or "").strip()
        if why:
            it["why"] = why[:400]
    return info
