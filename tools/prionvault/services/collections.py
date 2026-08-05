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
from . import smart_rules

logger = logging.getLogger(__name__)


_VALID_KINDS = {"manual", "smart"}
# Subset of the article-list query params that smart collections may
# carry as their `rules` payload. Anything outside this set is dropped.
# `tag`/`in_prionread`/`is_favorite`/`is_read` are accepted here (kept
# for merge_rules_into_filters' URL-narrowing path) even though
# smart_rules.build_where doesn't implement a `tag` WHERE clause.
_SMART_RULE_KEYS = smart_rules.SMART_RULE_KEYS | {"tag", "in_prionread"}


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
                      c.color, c.group_name, c.subgroup_name,
                      c.created_at, c.updated_at, c.created_by,
                      (SELECT COUNT(*) FROM prionvault_collection_article
                       WHERE collection_id = c.id) AS article_count
               FROM prionvault_collection c
               ORDER BY lower(c.name) ASC"""
        )).mappings().all()
        items = [_shape(r) for r in rows]
        for c in items:
            if c["kind"] == "smart":
                try:
                    c["article_count"] = _count_smart(conn, c["id"], c["rules"] or {})
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
                      c.color, c.group_name, c.subgroup_name,
                      c.created_at, c.updated_at, c.created_by,
                      (SELECT COUNT(*) FROM prionvault_collection_article
                       WHERE collection_id = c.id) AS article_count
               FROM prionvault_collection c
               WHERE c.id = :id"""
        ), {"id": str(cid)}).mappings().first()
    return _shape(row) if row else None


def create(*, name: str, description: Optional[str] = None,
           kind: str = "manual", rules: Optional[dict] = None,
           color: Optional[str] = None,
           group_name: Optional[str] = None,
           subgroup_name: Optional[str] = None,
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

    group_name    = (group_name or "").strip() or None
    subgroup_name = (subgroup_name or "").strip() or None
    if subgroup_name and not group_name:
        raise ValueError("subgroup_name requires a group_name")

    cid = str(uuid.uuid4())
    eng = _get_engine()
    with eng.begin() as conn:
        conn.execute(sql_text(
            """INSERT INTO prionvault_collection
               (id, name, description, kind, rules, color,
                group_name, subgroup_name, created_by,
                created_at, updated_at)
               VALUES (:id, :name, :description, :kind,
                       CAST(:rules AS jsonb), :color,
                       :gname, :sgname, :created_by, NOW(), NOW())"""
        ), {
            "id":          cid,
            "name":        name,
            "description": description,
            "kind":        kind,
            "rules":       _json_dumps(rules),
            "color":       color,
            "gname":       group_name,
            "sgname":      subgroup_name,
            "created_by":  str(created_by) if created_by else None,
        })
    out = get(cid)
    if not out:
        raise RuntimeError("collection vanished after INSERT")
    return out


def update(cid, *, name=None, description=None,
           rules=None, color=None, kind=None,
           group_name=None, subgroup_name=None) -> Optional[dict]:
    """Patch a collection. None means "leave unchanged".
    Pass an empty string to clear group_name / subgroup_name."""
    sets = []
    params: dict = {"id": str(cid)}
    if group_name is not None:
        v = group_name.strip() if group_name else ""
        sets.append("group_name = :gname")
        params["gname"] = v or None
    if subgroup_name is not None:
        v = subgroup_name.strip() if subgroup_name else ""
        sets.append("subgroup_name = :sgname")
        params["sgname"] = v or None
    if name is not None:
        sets.append("name = :name")
        params["name"] = name.strip()
        if not params["name"]:
            raise ValueError("name cannot be empty")
    if description is not None:
        sets.append("description = :description")
        params["description"] = description
    if kind is not None:
        kind = kind.strip().lower()
        if kind not in ("manual", "smart"):
            raise ValueError("kind must be 'manual' or 'smart'")
        sets.append("kind = :kind")
        params["kind"] = kind
    if rules is not None:
        sets.append("rules = CAST(:rules AS jsonb)")
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
    """Add `article_ids` to a collection — manual or smart.

    Smart collections' membership is normally computed live from their
    rules, but an operator can still pin extra articles onto one by
    hand (e.g. one that doesn't quite match the rules but belongs
    there anyway) — those rows just sit in prionvault_collection_article
    same as a manual collection's, and resolve_article_ids() unions
    them with the rule matches."""
    c = get(cid)
    if not c:
        raise LookupError("collection not found")
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


def find_in_group(group_name: str,
                  subgroup_name: Optional[str] = None) -> List[str]:
    """Return collection ids whose group (and optionally subgroup)
    matches. Case-insensitive."""
    if not group_name:
        return []
    eng = _get_engine()
    with eng.connect() as conn:
        if subgroup_name:
            rows = conn.execute(sql_text(
                "SELECT id FROM prionvault_collection "
                "WHERE lower(group_name) = lower(:g) "
                "  AND lower(coalesce(subgroup_name,'')) = lower(:sg)"
            ), {"g": group_name, "sg": subgroup_name}).all()
        else:
            rows = conn.execute(sql_text(
                "SELECT id FROM prionvault_collection "
                "WHERE lower(group_name) = lower(:g)"
            ), {"g": group_name}).all()
    return [str(r[0]) for r in rows]


def rename_group(group_name: str, new_name: str,
                 subgroup_name: Optional[str] = None) -> int:
    """Rename a group (or one subgroup within it) across every collection
    that carries it in one UPDATE — there's no dedicated group/subgroup
    row, "the group" only exists as the shared string on each leaf
    collection, so renaming it means renaming that string everywhere it
    appears. Returns the number of collections updated.

    subgroup_name=None renames the GROUP for every collection under it
    (leaving each collection's own subgroup untouched). subgroup_name set
    renames only that one subgroup's name, within that group.
    """
    if not group_name or not new_name or not new_name.strip():
        raise ValueError("group_name and new_name are required")
    new_name = new_name.strip()
    eng = _get_engine()
    with eng.begin() as conn:
        if subgroup_name:
            res = conn.execute(sql_text(
                "UPDATE prionvault_collection SET subgroup_name = :new, updated_at = NOW() "
                "WHERE lower(group_name) = lower(:g) "
                "  AND lower(coalesce(subgroup_name,'')) = lower(:sg)"
            ), {"new": new_name, "g": group_name, "sg": subgroup_name})
        else:
            res = conn.execute(sql_text(
                "UPDATE prionvault_collection SET group_name = :new, updated_at = NOW() "
                "WHERE lower(group_name) = lower(:g)"
            ), {"new": new_name, "g": group_name})
        return res.rowcount or 0


def aggregate_article_ids(collection_ids: List[str], viewer_id=None) -> List[str]:
    """Union the article-id sets of many collections (manual or smart).
    Returns a deduplicated list. Cap is per-collection inside
    resolve_article_ids. Pass viewer_id so smart collections that
    filter by per-user marks evaluate against the right operator."""
    out: set = set()
    for cid in collection_ids:
        try:
            for aid in resolve_article_ids(cid, viewer_id=viewer_id):
                out.add(aid)
        except Exception as exc:
            logger.warning("aggregate: collection %s failed: %s", cid, exc)
    return list(out)


def rollup_unique_counts() -> dict:
    """Per-group / per-subgroup deduplicated article counts.

    The sidebar used to roll up by adding article_count across child
    collections, which double-counts every paper present in more than
    one collection under the same parent. This function deduplicates
    via aggregate_article_ids(), so:

      * group_count       = number of distinct groups
      * groups[g].subgroup_count
                          = number of distinct subgroups under group g
      * groups[g].subgroups[sg].unique_articles
                          = distinct articles across every collection
                            that lives in (g, sg)
      * groups[g].unique_articles
                          = distinct articles across every collection
                            anywhere under group g

    Collections without a group_name are skipped — the sidebar
    renders them as "Sin grupo" and the user didn't ask for that
    bucket to be rolled up.
    """
    all_colls = list_all()

    # Collect collection ids by their (group, subgroup) keys.
    by_subgroup: dict[tuple[str, str], List[str]] = {}
    by_group:    dict[str, List[str]]              = {}
    distinct_subs_per_group: dict[str, set[str]]    = {}

    for c in all_colls:
        g  = (c.get("group_name")    or "").strip()
        sg = (c.get("subgroup_name") or "").strip()
        if not g:
            continue
        cid = c["id"]
        by_subgroup.setdefault((g, sg), []).append(cid)
        by_group.setdefault(g, []).append(cid)
        if sg:
            distinct_subs_per_group.setdefault(g, set()).add(sg)

    out: dict = {"group_count": len(by_group), "groups": {}}
    for g, cids in by_group.items():
        # Subgroups under this group: walk the keys with matching g.
        subs_out: dict = {}
        for (gg, sg), sub_cids in by_subgroup.items():
            if gg != g or not sg:
                continue
            subs_out[sg] = {
                "unique_articles": len(aggregate_article_ids(sub_cids)),
                "collections":     len(sub_cids),
            }
        out["groups"][g] = {
            "subgroup_count":  len(distinct_subs_per_group.get(g, set())),
            "collection_count": len(cids),
            "unique_articles": len(aggregate_article_ids(cids)),
            "subgroups":       subs_out,
        }
    return out


def article_ids_in(cid) -> List[str]:
    """Return every article_id in a MANUAL collection."""
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text(
            """SELECT article_id FROM prionvault_collection_article
               WHERE collection_id = :cid"""
        ), {"cid": str(cid)}).all()
    return [str(r[0]) for r in rows]


def resolve_article_ids(cid, limit: int = 10_000, viewer_id=None) -> List[str]:
    """Return every article_id this collection currently contains —
    works for both manual and smart collections.

      manual → just SELECT from prionvault_collection_article.
      smart  → the rule matches UNION the manually-pinned rows in
               prionvault_collection_article (see add_articles) — a
               smart collection's membership isn't purely rule-driven,
               an operator can still hand-add an article that doesn't
               match the rules.
    """
    c = get(cid)
    if not c:
        raise LookupError("collection not found")
    if c["kind"] != "smart":
        return article_ids_in(cid)

    rules = c.get("rules") or {}
    eng = _get_engine()
    with eng.connect() as conn:
        where, params = smart_rules.build_where(rules, viewer_id=viewer_id)
        rule_sql = "SELECT id FROM articles"
        if where:
            rule_sql += " WHERE " + " AND ".join(where)
        sql = (f"SELECT id FROM ({rule_sql} "
               f"UNION SELECT article_id FROM prionvault_collection_article "
               f"WHERE collection_id = :cid) t LIMIT {int(limit)}")
        params = {**params, "cid": str(cid)}
        rows = conn.execute(sql_text(sql), params).all()
    return [str(r[0]) for r in rows]


def _count_smart(conn, cid, rules: dict) -> int:
    """Count of articles in a smart collection: rule matches UNION the
    manually-pinned rows (see add_articles / resolve_article_ids) — kept
    in lockstep with resolve_article_ids so the sidebar count and the
    listing you get by clicking it never disagree."""
    where, params = smart_rules.build_where(rules, viewer_id=None)
    rule_sql = "SELECT id FROM articles"
    if where:
        rule_sql += " WHERE " + " AND ".join(where)
    sql = (f"SELECT COUNT(*) FROM ({rule_sql} "
           f"UNION SELECT article_id FROM prionvault_collection_article "
           f"WHERE collection_id = :cid) t")
    params = {**params, "cid": str(cid)}
    return conn.execute(sql_text(sql), params).scalar() or 0


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
        "group_name":    row["group_name"]    if "group_name"    in row.keys() else None,
        "subgroup_name": row["subgroup_name"] if "subgroup_name" in row.keys() else None,
        "article_count": int(row["article_count"] or 0),
        "created_at":    row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at":    row["updated_at"].isoformat() if row["updated_at"] else None,
        "created_by":    str(row["created_by"]) if row["created_by"] else None,
    }


def _filter_rules(rules: dict) -> dict:
    """Drop anything not in the allow-list so a malicious / careless
    caller cannot smuggle SQL through the smart-rules payload."""
    return smart_rules.filter_rules(rules, _SMART_RULE_KEYS)


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
              "has_summary", "extraction_status", "source"):
        _take_str(k)
    for k in ("year_min", "year_max", "tag", "priority_eq"):
        _take_int(k)
    for k in ("is_flagged", "is_milestone",
              "in_prionread", "is_favorite", "is_read",
              "has_pdf", "has_doi", "has_pmid"):
        _take_bool(k)
    return out

