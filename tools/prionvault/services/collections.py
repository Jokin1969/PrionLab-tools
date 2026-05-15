"""PrionVault Collections — CRUD + membership management.

Manual collections store membership in `prionvault_collection_article`.
Smart collections (kind='smart') carry a `rules` JSON object and are
evaluated live by the list endpoint (see routes._apply_collection_rules).

All functions return plain dicts or ints. They never raise on missing
optional fields; SQL / validation errors propagate so the route layer
can map them to HTTP status codes.
"""
from __future__ import annotations

import logging
import uuid
from typing import List, Optional

from sqlalchemy import text as sql_text

from ..ingestion.queue import _get_engine

logger = logging.getLogger(__name__)


_VALID_KINDS = {"manual", "smart"}
# Subset of the article-list query params that smart collections may
# carry as their `rules` payload. Anything outside this set is dropped.
_SMART_RULE_KEYS = {
    "q", "authors", "journal", "year_min", "year_max",
    "tag", "has_summary", "priority_eq",
    "color_label", "is_flagged", "is_milestone",
    "extraction_status",
    "in_prionread", "is_favorite", "is_read",
}


def list_all(viewer_id=None) -> List[dict]:
    """Return all collections with their article count.

    For smart collections the count is computed live by running the
    same WHERE expression the article-list endpoint would produce
    against the rules JSON. Cheap as long as the rule set is small;
    if smart collections grow into the hundreds we'd want to cache it.
    """
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text(
            """SELECT c.id, c.name, c.description, c.kind, c.rules,
                      c.color, c.created_at, c.updated_at, c.created_by,
                      (SELECT COUNT(*) FROM prionvault_collection_article
                       WHERE collection_id = c.id) AS article_count
               FROM prionvault_collection c
               ORDER BY lower(c.name) ASC"""
        )).mappings().all()
        items = [_shape(r) for r in rows]
        for c in items:
            if c["kind"] == "smart":
                try:
                    c["article_count"] = _count_smart(conn, c["rules"] or {})
                except Exception as exc:
                    logger.warning("collections: smart count failed for "
                                   "%s: %s", c["id"], exc)
                    c["article_count"] = 0
    return items


def get(cid) -> Optional[dict]:
    eng = _get_engine()
    with eng.connect() as conn:
        row = conn.execute(sql_text(
            """SELECT c.id, c.name, c.description, c.kind, c.rules,
                      c.color, c.created_at, c.updated_at, c.created_by,
                      (SELECT COUNT(*) FROM prionvault_collection_article
                       WHERE collection_id = c.id) AS article_count
               FROM prionvault_collection c
               WHERE c.id = :id"""
        ), {"id": str(cid)}).mappings().first()
    return _shape(row) if row else None


def create(*, name: str, description: Optional[str] = None,
           kind: str = "manual", rules: Optional[dict] = None,
           color: Optional[str] = None,
           created_by=None) -> dict:
    name = (name or "").strip()
    if not name:
        raise ValueError("name required")
    if kind not in _VALID_KINDS:
        raise ValueError(f"invalid kind: {kind!r}")
    if kind == "smart":
        rules = _filter_rules(rules or {})
    else:
        rules = {}

    cid = str(uuid.uuid4())
    eng = _get_engine()
    with eng.begin() as conn:
        conn.execute(sql_text(
            """INSERT INTO prionvault_collection
               (id, name, description, kind, rules, color, created_by,
                created_at, updated_at)
               VALUES (:id, :name, :description, :kind,
                       :rules::jsonb, :color, :created_by, NOW(), NOW())"""
        ), {
            "id":          cid,
            "name":        name,
            "description": description,
            "kind":        kind,
            "rules":       _json_dumps(rules),
            "color":       color,
            "created_by":  str(created_by) if created_by else None,
        })
    out = get(cid)
    if not out:
        raise RuntimeError("collection vanished after INSERT")
    return out


def update(cid, *, name=None, description=None,
           rules=None, color=None) -> Optional[dict]:
    """Patch a collection. None means "leave unchanged"."""
    sets = []
    params: dict = {"id": str(cid)}
    if name is not None:
        sets.append("name = :name")
        params["name"] = name.strip()
        if not params["name"]:
            raise ValueError("name cannot be empty")
    if description is not None:
        sets.append("description = :description")
        params["description"] = description
    if rules is not None:
        sets.append("rules = :rules::jsonb")
        params["rules"] = _json_dumps(_filter_rules(rules))
    if color is not None:
        sets.append("color = :color")
        params["color"] = color or None
    if not sets:
        return get(cid)
    sets.append("updated_at = NOW()")

    eng = _get_engine()
    with eng.begin() as conn:
        res = conn.execute(sql_text(
            f"UPDATE prionvault_collection SET {', '.join(sets)} WHERE id = :id"
        ), params)
        if (res.rowcount or 0) == 0:
            return None
    return get(cid)


def delete(cid) -> bool:
    eng = _get_engine()
    with eng.begin() as conn:
        res = conn.execute(sql_text(
            "DELETE FROM prionvault_collection WHERE id = :id"
        ), {"id": str(cid)})
        return (res.rowcount or 0) > 0


def add_articles(cid, article_ids: List, added_by=None) -> dict:
    """Add `article_ids` to a MANUAL collection. Returns counts.
    Smart collections cannot be modified this way and raise ValueError."""
    c = get(cid)
    if not c:
        raise LookupError("collection not found")
    if c["kind"] != "manual":
        raise ValueError("only manual collections accept add_articles")
    ids = [str(x) for x in (article_ids or []) if x]
    if not ids:
        return {"added": 0, "skipped": 0}
    eng = _get_engine()
    with eng.begin() as conn:
        # Existing rows would normally raise on PK conflict; the
        # ON CONFLICT clause makes the call idempotent and returns
        # the actual number of fresh insertions.
        res = conn.execute(sql_text(
            """INSERT INTO prionvault_collection_article
               (collection_id, article_id, added_at, added_by)
               SELECT :cid, x.id, NOW(), :added_by
               FROM (SELECT unnest(CAST(:ids AS uuid[])) AS id) x
               WHERE EXISTS (SELECT 1 FROM articles a WHERE a.id = x.id)
               ON CONFLICT DO NOTHING"""
        ), {
            "cid":      str(cid),
            "ids":      ids,
            "added_by": str(added_by) if added_by else None,
        })
        added = res.rowcount or 0
    return {"added": added, "skipped": len(ids) - added}


def remove_articles(cid, article_ids: List) -> int:
    ids = [str(x) for x in (article_ids or []) if x]
    if not ids:
        return 0
    eng = _get_engine()
    with eng.begin() as conn:
        res = conn.execute(sql_text(
            """DELETE FROM prionvault_collection_article
               WHERE collection_id = :cid
                 AND article_id = ANY(CAST(:ids AS uuid[]))"""
        ), {"cid": str(cid), "ids": ids})
    return res.rowcount or 0


def article_ids_in(cid) -> List[str]:
    """Return every article_id in a MANUAL collection."""
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text(
            """SELECT article_id FROM prionvault_collection_article
               WHERE collection_id = :cid"""
        ), {"cid": str(cid)}).all()
    return [str(r[0]) for r in rows]


# ── Helpers ──────────────────────────────────────────────────────────────────

def _shape(row) -> Optional[dict]:
    if row is None:
        return None
    return {
        "id":            str(row["id"]),
        "name":          row["name"],
        "description":   row["description"] or "",
        "kind":          row["kind"],
        "rules":         dict(row["rules"]) if isinstance(row["rules"], dict)
                         else (row["rules"] or {}),
        "color":         row["color"],
        "article_count": int(row["article_count"] or 0),
        "created_at":    row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at":    row["updated_at"].isoformat() if row["updated_at"] else None,
        "created_by":    str(row["created_by"]) if row["created_by"] else None,
    }


def _filter_rules(rules: dict) -> dict:
    """Drop anything not in the allow-list so a malicious / careless
    caller cannot smuggle SQL through the smart-rules payload."""
    if not isinstance(rules, dict):
        return {}
    return {k: v for k, v in rules.items() if k in _SMART_RULE_KEYS}


def _json_dumps(obj) -> str:
    import json
    return json.dumps(obj, default=str)


def merge_rules_into_filters(rules: dict, current: dict) -> dict:
    """Return a new dict of filter values where each rule fills in only
    the keys that `current` has not already set. The URL-driven filter
    therefore *narrows* the smart collection further when the user
    combines them.
    """
    out = dict(current)
    rules = _filter_rules(rules or {})

    def _take_str(k):
        if not out.get(k) and rules.get(k):
            out[k] = str(rules[k]).strip() or None

    def _take_int(k):
        if out.get(k) is None and rules.get(k) not in (None, ""):
            try: out[k] = int(rules[k])
            except (TypeError, ValueError): pass

    def _take_bool(k):
        if out.get(k) is None and k in rules:
            v = rules[k]
            if v is True  or v == "1" or v == 1 or str(v).lower() == "true":
                out[k] = True
            elif v is False or v == "0" or v == 0 or str(v).lower() == "false":
                out[k] = False

    for k in ("q", "authors", "journal", "color_label",
              "has_summary", "extraction_status"):
        _take_str(k)
    for k in ("year_min", "year_max", "tag", "priority_eq"):
        _take_int(k)
    for k in ("is_flagged", "is_milestone",
              "in_prionread", "is_favorite", "is_read"):
        _take_bool(k)
    return out


def _count_smart(conn, rules: dict) -> int:
    """Live count of articles that match this smart collection's rules.

    Builds a minimal WHERE that mirrors the article-list endpoint;
    intentionally narrower than the real query (no tag JOIN, no
    in_prionread EXISTS) to keep the count cheap. Those extra
    constraints are still applied at view-time when the user opens
    the collection in the list."""
    where = []
    params: dict = {}

    if rules.get("q"):
        where.append("(title ILIKE :q OR coalesce(abstract,'') ILIKE :q OR "
                     "coalesce(authors,'') ILIKE :q)")
        params["q"] = f"%{rules['q']}%"
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
    if rules.get("priority_eq") not in (None, ""):
        try:
            params["priority_eq"] = int(rules["priority_eq"])
            where.append("priority = :priority_eq")
        except (TypeError, ValueError): pass
    cl = (rules.get("color_label") or "").strip().lower() or None
    if cl == "none":
        where.append("color_label IS NULL")
    elif cl:
        where.append("lower(color_label) = :color_label")
        params["color_label"] = cl
    if rules.get("is_flagged") is True:    where.append("is_flagged IS TRUE")
    if rules.get("is_flagged") is False:   where.append("(is_flagged IS FALSE OR is_flagged IS NULL)")
    if rules.get("is_milestone") is True:  where.append("is_milestone IS TRUE")
    if rules.get("is_milestone") is False: where.append("(is_milestone IS FALSE OR is_milestone IS NULL)")
    if rules.get("has_summary") == "ai":      where.append("summary_ai IS NOT NULL")
    elif rules.get("has_summary") == "human": where.append("summary_human IS NOT NULL")
    elif rules.get("has_summary") == "none":  where.append("summary_ai IS NULL AND summary_human IS NULL")
    if rules.get("extraction_status"):
        where.append("lower(extraction_status) = :ex")
        params["ex"] = str(rules["extraction_status"]).lower()

    sql = "SELECT COUNT(*) FROM articles"
    if where:
        sql += " WHERE " + " AND ".join(where)
    return int(conn.execute(sql_text(sql), params).scalar() or 0)
