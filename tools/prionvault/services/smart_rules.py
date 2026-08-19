"""Shared rule engine for "smart" features that filter `articles` by a
JSON rule set — smart collections (services/collections.py) and smart
tags (services/smart_tags.py). One engine, one place to add a new
criterion so every "smart X" feature gets it for free.

Rule dicts are flat (no AND/OR/NOT nesting) — every present key is
AND-ed together. Two tiers of keys:

  ARTICLE_LEVEL_KEYS  — plain facts about the article itself (title/
                        author/journal text, year range, has a PDF/DOI/
                        PMID, AI-summary presence, extraction status,
                        ingestion source). Safe to evaluate without
                        knowing who's asking.
  VIEWER_LEVEL_KEYS   — per-user marks (priority, color label, flagged,
                        milestone, favorite, read) stored in
                        prionvault_user_state. Evaluating these
                        requires a viewer_id; without one they're
                        silently omitted rather than blanket-applied.

SMART_RULE_KEYS is the union — the allow-list smart *collections* use,
since collections are evaluated live for the current request's viewer.
Smart *tags* are materialized (see smart_tags.py) and use only
ARTICLE_LEVEL_KEYS, since a persisted tag assignment can't sensibly
depend on which user is looking at it.
"""
from __future__ import annotations

import re

from sqlalchemy import text as sql_text

ARTICLE_LEVEL_KEYS = {
    "q", "authors", "journal", "year_min", "year_max",
    "has_summary", "extraction_status",
    "has_pdf", "has_doi", "has_pmid", "source",
}
VIEWER_LEVEL_KEYS = {
    "priority_eq", "color_label", "is_flagged", "is_milestone",
    "is_favorite", "is_read",
}
SMART_RULE_KEYS = ARTICLE_LEVEL_KEYS | VIEWER_LEVEL_KEYS


def filter_rules(rules: dict, allowed: set[str] | None = None) -> dict:
    """Drop anything not in the allow-list so a malicious / careless
    caller cannot smuggle SQL through the rules payload."""
    if not isinstance(rules, dict):
        return {}
    allowed = allowed if allowed is not None else SMART_RULE_KEYS
    return {k: v for k, v in rules.items() if k in allowed}


def build_where(rules: dict, viewer_id=None) -> tuple[list, dict]:
    """Build a (where_clauses, params) tuple from a rule dict for the
    `articles` table. Shared by smart collections' live count/resolve
    and smart tags' sync — the same rules always mean the same SQL.

    `viewer_id` is the operator whose per-user marks should drive the
    VIEWER_LEVEL_KEYS filters. Omit it (as smart tags do) to evaluate
    ARTICLE_LEVEL_KEYS only — any viewer-level keys present in `rules`
    are then silently skipped.
    """
    where: list = []
    params: dict = {}

    if rules.get("q"):
        raw = str(rules["q"]).strip()

        def _group_clause(group: str, pname: str) -> tuple[str, str]:
            """Builds one (title/abstract/authors) OR-clause for a single
            group of the query — a bare word/phrase, or several quoted
            terms OR-ed together (synonyms/plural forms). Returns
            (sql_fragment, param_value)."""
            quoted_terms = re.findall(r'"([^"]+)"', group)
            remainder = re.sub(r'"[^"]+"', ' ', group)
            remainder_is_clean = not [t for t in remainder.split() if t.upper() != "OR"]
            if quoted_terms and remainder_is_clean:
                # Plain "bat" is a substring match (ILIKE '%bat%'), so it
                # also catches "combat", "debate", "database"... — fine
                # for most searches but wrong for a short word that's
                # also a common substring. Wrapping term(s) in "double
                # quotes" switches to a STRICT whole-word match (regex
                # \y...\y — word boundary at both ends) — "bat" then
                # matches only the standalone word "bat", never "combat",
                # "battle", "batch" or any other word that merely starts/
                # contains those letters. Since a whole-word match
                # doesn't catch the plural for free, quote both forms and
                # OR them: "bat" OR "bats". Multiple quoted terms OR-ed
                # together also works for genuine synonyms — "bat" OR
                # "chiroptera".
                return (f"(title ~* :{pname} OR coalesce(abstract,'') ~* :{pname} OR "
                        f"coalesce(authors,'') ~* :{pname})",
                        r"\y(" + "|".join(re.escape(t) for t in quoted_terms) + r")\y")
            return (f"(title ILIKE :{pname} OR coalesce(abstract,'') ILIKE :{pname} OR "
                    f"coalesce(authors,'') ILIKE :{pname})",
                    f"%{group.strip()}%")

        # Literal " AND " between groups requires EVERY group to match
        # somewhere in the article, independently — e.g. "miRNA" AND
        # "AAV" only matches articles that mention both words (anywhere,
        # not necessarily adjacent), unlike a single group where multiple
        # words are OR-ed (or, unquoted, treated as one literal phrase).
        and_groups = [g for g in re.split(r'\bAND\b', raw) if g.strip()]
        if len(and_groups) > 1:
            for gi, group in enumerate(and_groups):
                pname = f"q_and_{gi}"
                clause, value = _group_clause(group.strip(), pname)
                where.append(clause)
                params[pname] = value
        else:
            clause, value = _group_clause(raw, "q")
            where.append(clause)
            params["q"] = value
    if rules.get("authors"):
        where.append("coalesce(authors,'') ILIKE :authors_q")
        params["authors_q"] = f"%{rules['authors']}%"
    if rules.get("journal"):
        where.append("coalesce(journal,'') ILIKE :journal")
        params["journal"] = f"%{rules['journal']}%"
    if rules.get("year_min") not in (None, ""):
        try:
            params["year_min"] = int(rules["year_min"])
            where.append("year >= :year_min")
        except (TypeError, ValueError): pass
    if rules.get("year_max") not in (None, ""):
        try:
            params["year_max"] = int(rules["year_max"])
            where.append("year <= :year_max")
        except (TypeError, ValueError): pass

    if rules.get("has_summary") == "ai":      where.append("summary_ai IS NOT NULL")
    elif rules.get("has_summary") == "human": where.append("summary_human IS NOT NULL")
    elif rules.get("has_summary") == "none":  where.append("summary_ai IS NULL AND summary_human IS NULL")

    if rules.get("extraction_status"):
        where.append("lower(extraction_status) = :ex")
        params["ex"] = str(rules["extraction_status"]).lower()

    if rules.get("has_pdf") is True:
        where.append("dropbox_path IS NOT NULL")
    elif rules.get("has_pdf") is False:
        where.append("dropbox_path IS NULL")

    if rules.get("has_doi") is True:
        where.append("doi IS NOT NULL AND doi <> ''")
    elif rules.get("has_doi") is False:
        where.append("(doi IS NULL OR doi = '')")

    if rules.get("has_pmid") is True:
        where.append("pubmed_id IS NOT NULL AND pubmed_id <> ''")
    elif rules.get("has_pmid") is False:
        where.append("(pubmed_id IS NULL OR pubmed_id = '')")

    if rules.get("source"):
        where.append("source = :source")
        params["source"] = str(rules["source"])

    # Per-user marks (migration 037): predicate against
    # prionvault_user_state for `viewer_id`. Without a viewer, omit
    # the rule entirely (see module docstring).
    _vuid = str(viewer_id) if viewer_id else None
    if _vuid:
        params["_smart_vuid"] = _vuid
        if rules.get("priority_eq") not in (None, ""):
            try:
                params["priority_eq"] = int(rules["priority_eq"])
                where.append(
                    "EXISTS (SELECT 1 FROM prionvault_user_state ps "
                    "  WHERE ps.article_id = articles.id "
                    "    AND ps.user_id = CAST(:_smart_vuid AS uuid) "
                    "    AND ps.priority = :priority_eq)"
                )
            except (TypeError, ValueError): pass
        cl = (rules.get("color_label") or "").strip().lower() or None
        if cl == "none":
            where.append(
                "NOT EXISTS (SELECT 1 FROM prionvault_user_state ps "
                "  WHERE ps.article_id = articles.id "
                "    AND ps.user_id = CAST(:_smart_vuid AS uuid) "
                "    AND ps.color_label IS NOT NULL)"
            )
        elif cl:
            params["color_label"] = cl
            where.append(
                "EXISTS (SELECT 1 FROM prionvault_user_state ps "
                "  WHERE ps.article_id = articles.id "
                "    AND ps.user_id = CAST(:_smart_vuid AS uuid) "
                "    AND lower(ps.color_label) = :color_label)"
            )
        if rules.get("is_flagged") is True:
            where.append(
                "EXISTS (SELECT 1 FROM prionvault_user_state ps "
                "  WHERE ps.article_id = articles.id "
                "    AND ps.user_id = CAST(:_smart_vuid AS uuid) "
                "    AND ps.is_flagged IS TRUE)"
            )
        if rules.get("is_flagged") is False:
            where.append(
                "NOT EXISTS (SELECT 1 FROM prionvault_user_state ps "
                "  WHERE ps.article_id = articles.id "
                "    AND ps.user_id = CAST(:_smart_vuid AS uuid) "
                "    AND ps.is_flagged IS TRUE)"
            )
        if rules.get("is_milestone") is True:
            where.append(
                "EXISTS (SELECT 1 FROM prionvault_user_state ps "
                "  WHERE ps.article_id = articles.id "
                "    AND ps.user_id = CAST(:_smart_vuid AS uuid) "
                "    AND ps.is_milestone IS TRUE)"
            )
        if rules.get("is_milestone") is False:
            where.append(
                "NOT EXISTS (SELECT 1 FROM prionvault_user_state ps "
                "  WHERE ps.article_id = articles.id "
                "    AND ps.user_id = CAST(:_smart_vuid AS uuid) "
                "    AND ps.is_milestone IS TRUE)"
            )
        if rules.get("is_favorite") is True:
            where.append(
                "EXISTS (SELECT 1 FROM prionvault_user_state ps "
                "  WHERE ps.article_id = articles.id "
                "    AND ps.user_id = CAST(:_smart_vuid AS uuid) "
                "    AND ps.is_favorite IS TRUE)"
            )
        if rules.get("is_favorite") is False:
            where.append(
                "NOT EXISTS (SELECT 1 FROM prionvault_user_state ps "
                "  WHERE ps.article_id = articles.id "
                "    AND ps.user_id = CAST(:_smart_vuid AS uuid) "
                "    AND ps.is_favorite IS TRUE)"
            )
        if rules.get("is_read") is True:
            where.append(
                "EXISTS (SELECT 1 FROM prionvault_user_state ps "
                "  WHERE ps.article_id = articles.id "
                "    AND ps.user_id = CAST(:_smart_vuid AS uuid) "
                "    AND ps.read_at IS NOT NULL)"
            )
        if rules.get("is_read") is False:
            where.append(
                "NOT EXISTS (SELECT 1 FROM prionvault_user_state ps "
                "  WHERE ps.article_id = articles.id "
                "    AND ps.user_id = CAST(:_smart_vuid AS uuid) "
                "    AND ps.read_at IS NOT NULL)"
            )
    # else: viewer-level rule keys are silently ignored without a viewer.

    return where, params


def matching_article_ids(rules: dict, viewer_id=None, limit: int = 10_000) -> list[str]:
    from ..ingestion.queue import _get_engine
    where, params = build_where(rules, viewer_id=viewer_id)
    sql = "SELECT id FROM articles"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id LIMIT :_limit"
    params["_limit"] = int(limit)
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text(sql), params).all()
    return [str(r[0]) for r in rows]


def count_matching(rules: dict, viewer_id=None, conn=None) -> int:
    where, params = build_where(rules, viewer_id=viewer_id)
    sql = "SELECT COUNT(*) FROM articles"
    if where:
        sql += " WHERE " + " AND ".join(where)
    if conn is not None:
        return int(conn.execute(sql_text(sql), params).scalar() or 0)
    from ..ingestion.queue import _get_engine
    eng = _get_engine()
    with eng.connect() as c:
        return int(c.execute(sql_text(sql), params).scalar() or 0)
