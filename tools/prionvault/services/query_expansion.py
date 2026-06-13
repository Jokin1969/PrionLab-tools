"""Query expansion for the biomedical RAG retriever.

Maps domain acronyms, conceptual hyper/hyponyms and a curated MeSH
subset onto extra terms that get appended to the user's query
before it's embedded by Voyage. The goal is to recover the recall
gap that comes from authors using terminology the user's question
doesn't share — the canonical example is a query for "GAGs" not
matching papers that exclusively use "heparan sulfate".

Design:
  - A single SQL table (prionvault_query_expansion) holds every
    mapping. `kind` separates acronyms from synonyms from MeSH.
  - On first use the table is bootstrapped from `_SEED_DICTIONARY`
    below — a hand-curated set tuned for the user's prion /
    neurodegeneration corpus. The seed is idempotent (INSERT ... ON
    CONFLICT DO NOTHING) so re-running ensure_seeded() never
    duplicates or overwrites admin edits.
  - The matcher walks the query token-by-token, lowercases each
    token, and looks the term up against the table. Hits are appended
    as a parenthesised hint at the end of the expanded query so the
    embedder sees both the original phrasing AND the broader
    vocabulary in a single forward pass.

Why not embed per-expansion and average:
  Cheaper (one Voyage call instead of N), and Voyage handles the
  extra context inside a single embedding without losing the
  original query's intent — the system prompt of the downstream
  LLM still anchors on the original question.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import List, Optional, Tuple

from sqlalchemy import text as sql_text

logger = logging.getLogger(__name__)


# ── Seed dictionary ──────────────────────────────────────────────────────────
# Hand-curated, tuned for the prion / neurodegeneration corpus.
# Add entries here for things that show up across many papers;
# admin-supplied entries (via the API) get marked source='admin'
# so we can tell the two apart later if we want to regenerate the
# seed from MeSH or a newer dictionary.
#
# Format: term, expansions (comma-separated lowercase), kind.
_SEED_DICTIONARY: list[tuple[str, str, str]] = [
    # ── Prion-specific acronyms ──────────────────────────────────────────
    ("prp",        "prion protein, cellular prion protein, prp-c",     "acronym"),
    ("prp-c",      "cellular prion protein, prion protein",            "acronym"),
    ("prpc",       "cellular prion protein, prion protein",            "acronym"),
    ("prpsc",      "scrapie prion protein, misfolded prion protein, infectious prion", "acronym"),
    ("prp-sc",     "scrapie prion protein, misfolded prion protein, infectious prion", "acronym"),
    ("prp-res",    "protease-resistant prion protein",                 "acronym"),
    ("bse",        "bovine spongiform encephalopathy, mad cow disease", "acronym"),
    ("cjd",        "creutzfeldt-jakob disease",                        "acronym"),
    ("vcjd",       "variant creutzfeldt-jakob disease",                "acronym"),
    ("scjd",       "sporadic creutzfeldt-jakob disease",               "acronym"),
    ("fcjd",       "familial creutzfeldt-jakob disease",               "acronym"),
    ("icjd",       "iatrogenic creutzfeldt-jakob disease",             "acronym"),
    ("tse",        "transmissible spongiform encephalopathy, prion disease", "acronym"),
    ("cwd",        "chronic wasting disease",                          "acronym"),
    ("ffi",        "fatal familial insomnia",                          "acronym"),
    ("gss",        "gerstmann-straussler-scheinker syndrome",          "acronym"),
    ("pmca",       "protein misfolding cyclic amplification",          "acronym"),
    ("rt-quic",    "real-time quaking-induced conversion",             "acronym"),
    ("rtquic",     "real-time quaking-induced conversion",             "acronym"),
    ("quic",       "quaking-induced conversion",                       "acronym"),

    # ── Glycosaminoglycans / proteoglycans ───────────────────────────────
    # The motivating example from the user. dextran sulfate / sulphate
    # added per user request — same conceptual family (sulfated
    # polysaccharide), often used in prion / amyloid binding studies.
    ("gag",        "glycosaminoglycan, heparan sulfate, chondroitin sulfate, dermatan sulfate, keratan sulfate, dextran sulfate, dextran sulphate", "synonym"),
    ("gags",       "glycosaminoglycans, heparan sulfate, chondroitin sulfate, dermatan sulfate, keratan sulfate, dextran sulfate, dextran sulphate", "synonym"),
    ("hs",         "heparan sulfate, heparin",                         "acronym"),
    ("hspg",       "heparan sulfate proteoglycan",                     "acronym"),
    ("cs",         "chondroitin sulfate",                              "acronym"),
    ("ds",         "dermatan sulfate, dextran sulfate, dextran sulphate", "acronym"),
    ("ks",         "keratan sulfate",                                  "acronym"),
    ("ha",         "hyaluronic acid, hyaluronan",                      "acronym"),

    # ── Other neurodegeneration proteins ─────────────────────────────────
    ("aβ",         "amyloid beta, abeta, amyloid-beta peptide",        "synonym"),
    ("abeta",      "amyloid beta, amyloid-beta peptide",               "synonym"),
    ("app",        "amyloid precursor protein",                        "acronym"),
    ("tau",        "microtubule-associated protein tau, mapt",         "synonym"),
    ("mapt",       "microtubule-associated protein tau, tau",          "acronym"),
    ("α-syn",      "alpha-synuclein, snca",                            "synonym"),
    ("a-syn",      "alpha-synuclein, snca",                            "synonym"),
    ("asyn",       "alpha-synuclein, snca",                            "synonym"),
    ("snca",       "alpha-synuclein",                                  "acronym"),
    ("tdp-43",     "tar dna-binding protein 43, tardbp",               "acronym"),
    ("tdp43",      "tar dna-binding protein 43, tardbp",               "acronym"),
    ("fus",        "fused in sarcoma",                                 "acronym"),
    ("sod1",       "superoxide dismutase 1",                           "acronym"),

    # ── Diseases ────────────────────────────────────────────────────────
    ("ad",         "alzheimer's disease, alzheimer disease",           "acronym"),
    ("pd",         "parkinson's disease, parkinson disease",           "acronym"),
    ("hd",         "huntington's disease, huntington disease",         "acronym"),
    ("als",        "amyotrophic lateral sclerosis, lou gehrig disease, motor neuron disease", "acronym"),
    ("ftd",        "frontotemporal dementia",                          "acronym"),
    ("dlb",        "dementia with lewy bodies",                        "acronym"),
    ("msa",        "multiple system atrophy",                          "acronym"),

    # ── Cell biology / molecular ────────────────────────────────────────
    ("er",         "endoplasmic reticulum",                            "acronym"),
    ("ros",        "reactive oxygen species, oxidative stress",        "acronym"),
    ("ips",        "induced pluripotent stem cells, ipsc",             "acronym"),
    ("ipsc",       "induced pluripotent stem cells",                   "acronym"),
    ("ko",         "knock-out, knockout, gene knockout",               "acronym"),
    ("ki",         "knock-in, knockin",                                "acronym"),
    ("wt",         "wild-type, wildtype",                              "acronym"),
    ("ngs",        "next-generation sequencing",                       "acronym"),

    # ── Anatomy / fluids ────────────────────────────────────────────────
    ("bbb",        "blood-brain barrier",                              "acronym"),
    ("csf",        "cerebrospinal fluid",                              "acronym"),
    ("cns",        "central nervous system",                           "acronym"),
    ("pns",        "peripheral nervous system",                        "acronym"),

    # ── Techniques ──────────────────────────────────────────────────────
    ("wb",         "western blot, immunoblot",                         "acronym"),
    ("ip",         "immunoprecipitation",                              "acronym"),
    ("co-ip",      "co-immunoprecipitation",                           "acronym"),
    ("coip",       "co-immunoprecipitation",                           "acronym"),
    ("ihc",        "immunohistochemistry",                             "acronym"),
    ("icc",        "immunocytochemistry",                              "acronym"),
    ("elisa",      "enzyme-linked immunosorbent assay",                "acronym"),
    ("em",         "electron microscopy",                              "acronym"),
    ("cryo-em",    "cryogenic electron microscopy, cryoelectron microscopy", "acronym"),
    ("nmr",        "nuclear magnetic resonance",                       "acronym"),
    ("sds-page",   "sodium dodecyl sulfate polyacrylamide gel electrophoresis", "acronym"),
    ("pcr",        "polymerase chain reaction",                        "acronym"),
    ("qpcr",       "quantitative polymerase chain reaction",           "acronym"),
    ("rt-pcr",     "reverse transcription polymerase chain reaction",  "acronym"),

    # ── MeSH-style controlled vocabulary (subset, expand as needed) ─────
    ("prion",      "prion protein, prpsc, prpc, scrapie, tse",         "mesh"),
    ("scrapie",    "ovine prion disease, prion, sheep tse",            "mesh"),
    ("neurodegeneration", "neurodegenerative disease, protein aggregation, prion disease", "mesh"),
    ("amyloid",    "amyloid fibril, beta-amyloid, amyloidosis",        "mesh"),
    ("misfolding", "protein misfolding, conformational disease, aggregation", "mesh"),
    ("autophagy",  "macroautophagy, mitophagy, lysosomal degradation", "mesh"),
    ("ubiquitin",  "ubiquitin-proteasome system, ups, proteasome",     "mesh"),
    ("microglia",  "microglial cells, neuroinflammation",              "mesh"),
    ("astrocyte",  "astroglia, glial cells, reactive astrocytes",      "mesh"),
]


@dataclass
class ExpandedQuery:
    """Return value from expand().

    `text` is the narrative-style broadened string the embedder
    should encode: "<original> (also known as: a, b, c)". Voyage
    handles this fine inside a single forward pass and the original
    query stays the dominant signal.

    `bm25_query` is a flat space-separated bag of the original tokens
    plus the expansion tokens. It's meant for plainto_tsquery /
    websearch_to_tsquery, which would otherwise index the connector
    words ("also", "known") as if they were search terms.

    `matched` lists the (term, expansions) tuples that fired so the
    UI can surface what got broadened and an operator can debug a
    surprising retrieval result.
    """
    text:        str
    bm25_query:  str
    matched:     list[tuple[str, str]]


# Word-character + hyphen + Greek alpha (α). Conservative — matches
# the kinds of tokens biomedical authors actually use, ignores
# punctuation and operators.
_TOKEN_RE = re.compile(r"[A-Za-zαβ0-9][A-Za-zαβ0-9_\-]*", re.UNICODE)


def _get_engine():
    from ..ingestion.queue import _get_engine as _e
    return _e()


def expand(query: str) -> ExpandedQuery:
    """Broaden `query` using the dictionary, return the augmented text.

    Lookup is exact-match (lowercased), word-aligned. We don't do
    fuzzy matching here because false expansions degrade recall more
    than missed expansions do — the seed dictionary covers the
    common shapes (PrP / PrPc / PrPsc all listed separately).
    """
    if not query or not query.strip():
        return ExpandedQuery(text=query, bm25_query=query, matched=[])

    tokens = list({m.group(0).lower() for m in _TOKEN_RE.finditer(query)})
    if not tokens:
        return ExpandedQuery(text=query, bm25_query=query, matched=[])

    try:
        eng = _get_engine()
        with eng.connect() as conn:
            rows = conn.execute(sql_text(
                "SELECT term, expansions FROM prionvault_query_expansion "
                " WHERE term = ANY(:tokens)"
            ), {"tokens": tokens}).all()
    except Exception as exc:
        # If the dictionary table isn't there yet (migration pending),
        # be invisible — the worst case is the un-expanded query, which
        # is the existing behaviour.
        logger.debug("query_expansion lookup skipped: %s", exc)
        return ExpandedQuery(text=query, bm25_query=query, matched=[])

    if not rows:
        return ExpandedQuery(text=query, bm25_query=query, matched=[])

    # Order by term length descending so longer-token expansions
    # appear first — purely cosmetic for the UI hint, the embedder
    # doesn't care.
    rows = sorted(rows, key=lambda r: -len(r[0]))

    # The expansion text is appended in parentheses at the end of the
    # query so the original phrasing remains the dominant signal —
    # Voyage encodes the whole string, but the bulk of the meaning is
    # carried by what comes first.
    expansion_str = ", ".join(r[1] for r in rows)
    expanded_text = f"{query.strip()} (also known as: {expansion_str})"

    # BM25-friendly version: original query + every expansion token,
    # joined by spaces. No connector words ("also", "known") so a
    # plainto_tsquery doesn't waste matches on filler.
    bm25_terms = [query.strip()]
    for r in rows:
        bm25_terms.append(r[1])
    bm25_query = " ".join(bm25_terms)

    matched = [(r[0], r[1]) for r in rows]
    return ExpandedQuery(text=expanded_text, bm25_query=bm25_query,
                         matched=matched)


# ── CRUD for the admin UI ───────────────────────────────────────────────────

def list_all() -> list[dict]:
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text(
            "SELECT id, term, expansions, kind, source, created_at "
            "  FROM prionvault_query_expansion "
            " ORDER BY kind, term"
        )).mappings().all()
    out = [dict(r) for r in rows]
    for r in out:
        v = r.get("created_at")
        if hasattr(v, "isoformat"):
            r["created_at"] = v.isoformat()
    return out


def add(*, term: str, expansions: str, kind: str = "synonym",
        source: str = "admin",
        created_by: Optional[str] = None) -> dict:
    """Upsert. Same (term, kind) collisions overwrite the previous
    expansion — useful when refining an entry without having to
    delete first."""
    t = (term or "").strip().lower()
    e = (expansions or "").strip().lower()
    k = (kind or "synonym").strip().lower()
    if not t:
        raise ValueError("term cannot be empty")
    if not e:
        raise ValueError("expansions cannot be empty")
    if k not in ("acronym", "synonym", "mesh"):
        raise ValueError(f"unknown kind {k!r}")
    eng = _get_engine()
    with eng.begin() as conn:
        row = conn.execute(sql_text(
            """
            INSERT INTO prionvault_query_expansion
              (term, expansions, kind, source, created_by)
            VALUES (:t, :e, :k, :s, :u)
            ON CONFLICT (term, kind) DO UPDATE
              SET expansions = EXCLUDED.expansions,
                  source     = EXCLUDED.source
            RETURNING id, term, expansions, kind, source, created_at
            """
        ), {"t": t, "e": e, "k": k, "s": source,
            "u": created_by}).mappings().first()
    return dict(row) if row else {}


def delete(term: str, kind: str = "synonym") -> int:
    eng = _get_engine()
    with eng.begin() as conn:
        r = conn.execute(sql_text(
            "DELETE FROM prionvault_query_expansion "
            " WHERE term = :t AND kind = :k"
        ), {"t": term.strip().lower(), "k": kind.strip().lower()})
    return r.rowcount or 0


def ensure_seeded() -> tuple[int, int]:
    """Populate / refresh the table from _SEED_DICTIONARY.

    Returns (inserted, refreshed):
      * inserted  — new (term, kind) rows added on this pass.
      * refreshed — existing source='seed' rows whose expansions
                    changed in the code and were therefore updated.

    Admin-edited rows (source='admin') are NEVER touched, even when
    their (term, kind) collides with a seed entry — the operator's
    edit always wins. That way pushing a new code release with a
    refined seed updates every default but preserves the operator's
    additions / overrides.
    """
    eng = _get_engine()
    inserted = 0
    refreshed = 0
    try:
        with eng.begin() as conn:
            for term, expansions, kind in _SEED_DICTIONARY:
                # First try INSERT; the ON CONFLICT clause refreshes
                # the row IFF it's still a 'seed' row AND its
                # expansions actually differ. Untouched 'seed' rows
                # produce zero rowcount, admin-overridden rows are
                # skipped entirely thanks to the WHERE clause.
                r = conn.execute(sql_text(
                    """
                    INSERT INTO prionvault_query_expansion
                      (term, expansions, kind, source)
                    VALUES (:t, :e, :k, 'seed')
                    ON CONFLICT (term, kind) DO UPDATE
                       SET expansions = EXCLUDED.expansions
                     WHERE prionvault_query_expansion.source = 'seed'
                       AND prionvault_query_expansion.expansions <> EXCLUDED.expansions
                    RETURNING (xmax = 0) AS inserted
                    """
                ), {"t": term.lower(), "e": expansions.lower(), "k": kind})
                row = r.first()
                if row is not None:
                    if row[0]:
                        inserted += 1
                    else:
                        refreshed += 1
    except Exception as exc:
        logger.warning("query_expansion seed failed: %s", exc)
    return inserted, refreshed
