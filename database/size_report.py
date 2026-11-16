"""Where the database's disk (and therefore memory) goes.

Read-only report for the admin Database page: total size, the biggest
tables split into rows / long values (TOAST) / indexes with their dead
space, every sizeable index with how often it is used, what the big columns
of `articles` weigh, and the server's memory settings. Plain catalog
queries — nothing here locks or scans user tables, except the per-column
sizes, which read `articles` once.
"""
from __future__ import annotations

import logging

from sqlalchemy import text

logger = logging.getLogger(__name__)

_BIG_ARTICLE_COLUMNS = ("extracted_text", "search_vector", "search_vector2", "rank_vector",
                        "abstract", "summary_ai", "summary_human")


def _mb(n) -> float:
    return round((n or 0) / 1024 / 1024, 1)


def build_report(engine) -> dict:
    out: dict = {"tables": [], "indexes": [], "article_columns": [], "settings": {}, "notes": []}
    with engine.connect() as conn:
        out["database_mb"] = _mb(conn.execute(text(
            "SELECT pg_database_size(current_database())")).scalar())

        for r in conn.execute(text("""
            SELECT c.relname AS name,
                   pg_total_relation_size(c.oid) AS total,
                   pg_relation_size(c.oid)       AS heap,
                   COALESCE(pg_total_relation_size(c.reltoastrelid), 0) AS toast,
                   pg_indexes_size(c.oid)        AS indexes,
                   s.n_live_tup AS live, s.n_dead_tup AS dead,
                   GREATEST(s.last_vacuum, s.last_autovacuum) AS last_vacuum
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
             WHERE c.relkind = 'r' AND n.nspname = 'public'
             ORDER BY pg_total_relation_size(c.oid) DESC
             LIMIT 15""")).mappings():
            out["tables"].append({
                "name": r["name"], "total_mb": _mb(r["total"]), "rows_mb": _mb(r["heap"]),
                "toast_mb": _mb(r["toast"]), "indexes_mb": _mb(r["indexes"]),
                "live_rows": int(r["live"] or 0), "dead_rows": int(r["dead"] or 0),
                "last_vacuum": r["last_vacuum"].isoformat(timespec="minutes") if r["last_vacuum"] else None,
            })

        for r in conn.execute(text("""
            SELECT s.relname AS tbl, s.indexrelname AS name,
                   pg_relation_size(s.indexrelid) AS size, s.idx_scan AS scans,
                   i.indisunique OR i.indisprimary AS is_unique
              FROM pg_stat_user_indexes s
              JOIN pg_index i ON i.indexrelid = s.indexrelid
             WHERE pg_relation_size(s.indexrelid) > 1024 * 1024
             ORDER BY pg_relation_size(s.indexrelid) DESC
             LIMIT 40""")).mappings():
            out["indexes"].append({"table": r["tbl"], "name": r["name"], "size_mb": _mb(r["size"]),
                                   "scans": int(r["scans"] or 0), "unique": bool(r["is_unique"])})

        try:
            cols = {r[0] for r in conn.execute(text(
                "SELECT column_name FROM information_schema.columns WHERE table_name = 'articles'"))}
            present = [c for c in _BIG_ARTICLE_COLUMNS if c in cols]
            if present:
                sums = ", ".join(f"COALESCE(SUM(pg_column_size({c})), 0) AS {c}" for c in present)
                row = conn.execute(text(f"SELECT COUNT(*) AS n, {sums} FROM articles")).mappings().first()
                out["articles"] = int(row["n"])
                for c in present:
                    out["article_columns"].append({"column": c, "stored_mb": _mb(row[c])})
                out["article_columns"].sort(key=lambda x: -x["stored_mb"])
        except Exception as exc:
            conn.rollback()
            out["notes"].append(f"article column sizes unavailable: {str(exc)[:120]}")

        for name in ("shared_buffers", "effective_cache_size", "work_mem", "maintenance_work_mem",
                     "max_connections", "server_version"):
            try:
                out["settings"][name] = conn.execute(text(f"SHOW {name}")).scalar()
            except Exception:
                conn.rollback()
        try:
            out["settings"]["connections_now"] = conn.execute(text(
                "SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database()")).scalar()
        except Exception:
            conn.rollback()
    return out


def as_text(rep: dict) -> str:
    """The same report as plain text, easy to copy and paste."""
    L = [f"Base de datos: {rep.get('database_mb')} MB · artículos: {rep.get('articles', '?')}", "",
         "TABLAS (MB)  total = filas + valores largos (TOAST) + índices"]
    for t in rep["tables"]:
        dead = (f" · {t['dead_rows']} filas muertas" if t["dead_rows"] else "")
        L.append(f"  {t['name']:<38} total {t['total_mb']:>8}  filas {t['rows_mb']:>7}  "
                 f"toast {t['toast_mb']:>7}  índices {t['indexes_mb']:>7}  "
                 f"({t['live_rows']} filas{dead}; vacuum {t['last_vacuum'] or 'nunca'})")
    L += ["", "ÍNDICES > 1 MB (usos = veces consultado desde el último reinicio de estadísticas)"]
    for i in rep["indexes"]:
        L.append(f"  {i['name']:<46} {i['size_mb']:>8} MB  usos {i['scans']:>8}  [{i['table']}]"
                 + ("  único" if i["unique"] else ""))
    L += ["", "COLUMNAS GRANDES DE articles (MB almacenados)"]
    for c in rep["article_columns"]:
        L.append(f"  {c['column']:<20} {c['stored_mb']:>8}")
    L += ["", "AJUSTES DEL SERVIDOR"]
    for k, v in rep["settings"].items():
        L.append(f"  {k}: {v}")
    for n in rep.get("notes", []):
        L.append(f"  nota: {n}")
    return "\n".join(L)
