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
from typing import Optional

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


class QuerySyntaxError(ValueError):
    """Raised for a malformed `q` boolean query — unbalanced
    parentheses, an operator with nothing on one side, an unknown
    [Field] tag, etc. Message is meant to be shown to the user as-is."""


# PubMed-style field tags. Each maps to the article column(s) it
# searches; a term with no tag searches all three (the old default).
_FIELD_COLUMNS = {
    "TI": ["title"],
    "AB": ["abstract"],
    "AU": ["authors"],
    "JA": ["journal"], "JO": ["journal"], "TA": ["journal"],
}
_DEFAULT_COLUMNS = ["title", "abstract", "authors"]

# One token = a quoted phrase, a parenthesis, a [Field] tag, or a run
# of anything else up to the next space/paren/bracket (covers bare
# words and the AND/OR/NOT keywords — matched case-insensitively later).
_Q_TOKEN_RE = re.compile(r'"[^"]*"|[()]|\[[A-Za-z]{2,4}\]|[^\s()\[\]]+')
_Q_FIELD_RE = re.compile(r'\[([A-Za-z]{2,4})\]')
_Q_KEYWORDS = {"AND", "OR", "NOT"}


def _q_tokenize(raw: str) -> list[str]:
    """Tokenize, then fold consecutive bare (unquoted, non-keyword,
    non-paren, non-tag) word tokens into one literal-phrase token —
    preserves the old behaviour for a plain multi-word query typed
    without any operators (e.g. `signal peptide` still means the
    literal substring "signal peptide", not a syntax error for two
    atoms with nothing between them)."""
    raw_tokens = _Q_TOKEN_RE.findall(raw)
    folded: list[str] = []
    run: list[str] = []

    def _flush():
        if run:
            folded.append(" ".join(run))
            run.clear()

    for t in raw_tokens:
        is_bare_word = (
            t not in ("(", ")")
            and not t.startswith('"')
            and not _Q_FIELD_RE.fullmatch(t)
            and t.upper() not in _Q_KEYWORDS
        )
        if is_bare_word:
            run.append(t)
            continue
        _flush()
        folded.append(t)
    _flush()
    return folded


def parse_boolean_query(raw: str) -> tuple[Optional[str], dict]:
    """Parse a PubMed-style boolean query into a SQL fragment + params.

    Grammar (left-to-right, no AND/OR precedence — exactly like PubMed:
    parentheses are the only way to override evaluation order):

        expr  := term (("AND" | "OR") term)*
        term  := "NOT" term | "(" expr ")" | atom
        atom  := (WORD | "phrase") ["[" Field "]"]

    Field is one of Ti (title), Ab (abstract), Au (authors), Ja/Jo/Ta
    (journal) — case-insensitive. An atom with no field tag searches
    title + abstract + authors, same as a plain search always has.
    A "quoted" atom matches the whole word/phrase only (word-boundary
    regex); a bare atom is a substring match (ILIKE).

    Raises QuerySyntaxError with a message safe to show the user.
    """
    raw = (raw or "").strip()
    if not raw:
        return None, {}

    tokens = _q_tokenize(raw)
    pos = 0
    params: dict = {}
    counter = [0]

    def peek() -> Optional[str]:
        return tokens[pos] if pos < len(tokens) else None

    def advance() -> str:
        nonlocal pos
        t = tokens[pos]
        pos += 1
        return t

    def is_operator(t: Optional[str]) -> bool:
        return t is not None and t.upper() in ("AND", "OR")

    def parse_expr() -> str:
        left = parse_term()
        while is_operator(peek()):
            op = advance().upper()
            right = parse_term()
            left = f"({left} {op} {right})"
        return left

    def parse_term() -> str:
        t = peek()
        if t is None:
            raise QuerySyntaxError(
                "Falta un término después de un operador (AND/OR/NOT).")
        if t.upper() == "NOT":
            advance()
            return f"(NOT {parse_term()})"
        if t == "(":
            advance()
            inner = parse_expr()
            if peek() != ")":
                raise QuerySyntaxError("Falta cerrar un paréntesis: ( sin ).")
            advance()
            return f"({inner})"
        if t == ")":
            raise QuerySyntaxError("Sobra un paréntesis de cierre: ) sin (.")
        return parse_atom()

    def parse_atom() -> str:
        t = advance()
        if t.upper() in _Q_KEYWORDS:
            raise QuerySyntaxError(
                f'"{t}" no puede ir ahí — falta un término antes o después.')
        if t.startswith('"') and t.endswith('"') and len(t) >= 2:
            value, strict = t[1:-1], True
        else:
            value, strict = t, False
        if not value.strip():
            raise QuerySyntaxError("Término vacío (comillas sin texto dentro).")

        field = None
        m = peek()
        if m and _Q_FIELD_RE.fullmatch(m):
            advance()
            field = _Q_FIELD_RE.fullmatch(m).group(1).upper()
            if field not in _FIELD_COLUMNS:
                raise QuerySyntaxError(
                    f'Campo desconocido [{field}] — usa [Ti], [Ab], [Au] o [Ja].')

        counter[0] += 1
        pname = f"sq_{counter[0]}"
        cols = _FIELD_COLUMNS.get(field, _DEFAULT_COLUMNS)
        if strict:
            op = "~*"
            params[pname] = r"\y(" + re.escape(value) + r")\y"
        else:
            op = "ILIKE"
            params[pname] = f"%{value}%"
        return "(" + " OR ".join(f"coalesce({c},'') {op} :{pname}" for c in cols) + ")"

    expr = parse_expr()
    if pos != len(tokens):
        raise QuerySyntaxError(
            f'Token inesperado cerca de "{tokens[pos]}" — ¿falta un AND/OR?')
    return expr, params


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
        clause, q_params = parse_boolean_query(str(rules["q"]))
        if clause:
            where.append(clause)
            params.update(q_params)
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
