"""One-shot tool to fix the "⏳ PDF pendiente" stragglers.

Background
──────────
Before the PMID branch landed in deduplicator.find_duplicate (commit
3c30fc6), the following sequence created orphan rows:

    1. The operator imported a PMID from the Inventario PubMed. That
       made an `articles` row with source='pubmed_inventory', a PMID,
       sometimes no DOI, and dropbox_path=NULL.

    2. Later they dropped the matching PDF into "Import PDFs". The
       ingest worker called find_duplicate(doi=..., pdf_md5=...).
       The DOI was either missing on the inventory row or differed
       slightly, and the MD5 obviously didn't match anything yet, so
       the dedup MISSED.

    3. The worker created a SECOND article — fully populated with
       the PDF, the extracted text, the page count, the lot — while
       the original inventory row stayed stuck on `dropbox_path IS
       NULL` and kept showing the "⏳ PDF pendiente" chip forever.

`find_duplicate` now also matches by PMID, so any new "Import PDFs"
upload joins back to the existing inventory row. But the orphans
already created in the wild stay orphaned until someone fixes them
by hand from "Find duplicates" — slow if you have dozens.

What this module does
─────────────────────
Walks every article with source='pubmed_inventory' AND dropbox_path
IS NULL, and for each one looks for ANOTHER article with the same
PMID (or, failing that, the same DOI) that DOES have a PDF. When a
unique donor is found, it MERGES the donor into the orphan:

    • Every PDF-related field on the donor moves onto the orphan
      (dropbox_path, pdf_md5, pdf_pages, extracted_text, …) unless
      the orphan already has a non-null value (we never overwrite).
    • Per-user state rows (prionvault_user_state, article_tag_link,
      article_ratings, …) are repointed donor → orphan with ON
      CONFLICT DO NOTHING so two users having marked the same
      article on both rows doesn't collide.
    • JC presentations, supplementary uploads, collection
      memberships and user_articles links are repointed too.
    • The donor article row is deleted.

Conservative behaviour
──────────────────────
When more than one donor matches (e.g. three duplicate rows for the
same PMID — weird, but legal), the orphan is LEFT untouched and
listed in the response under `ambiguous`. The operator can resolve
those manually from "Find duplicates" without risk of picking the
wrong donor automatically.

dry_run=True returns the planned operations without touching the
DB, so an admin can preview the impact before committing.
"""
from __future__ import annotations

import logging
from typing import List, Optional

from sqlalchemy import text as sql_text

logger = logging.getLogger(__name__)


def _get_engine():
    from ..ingestion.queue import _get_engine as _e
    return _e()


# PDF-bearing columns that move donor → orphan when the orphan's
# value is NULL/empty. Keeping the list explicit (rather than copying
# every column) means a future column addition won't silently mutate
# orphan rows.
_PDF_COLS = [
    "dropbox_path", "dropbox_link",
    "pdf_md5", "pdf_size_bytes", "pdf_pages", "pdf_is_scan",
    "pdf_oa_status",
    "extracted_text", "extraction_status",
    "abstract", "abstract_unavailable",
    "summary_ai", "summary_human",
]
# Note: tsvector / vector / indexing-stamp columns (search_vector,
# indexed_at, index_version) are deliberately excluded — psycopg2 has
# no default adapter for tsvector when rebinding it as a parameter,
# and the per-content state has to be recomputed against the orphan's
# DOI/title anyway. The next batch_index pass picks it up.


def _find_pairs(conn) -> tuple[list[dict], list[dict]]:
    """Return (pairs, ambiguous). `pairs` is a list of {orphan, donor,
    matched_on} we can safely merge; `ambiguous` is a list of orphans
    that have more than one candidate donor and need manual review."""
    pairs: list[dict] = []
    ambiguous: list[dict] = []

    orphans = conn.execute(sql_text(
        """SELECT id::text AS id, pubmed_id, doi, title
             FROM articles
            WHERE source = 'pubmed_inventory'
              AND dropbox_path IS NULL"""
    )).mappings().all()

    for o in orphans:
        pmid = (o.get("pubmed_id") or "").strip() or None
        doi  = (o.get("doi") or "").strip().lower() or None

        # Strongest match first: PMID. Fall back to DOI.
        donors = []
        if pmid:
            donors = conn.execute(sql_text(
                """SELECT id::text AS id, title
                     FROM articles
                    WHERE pubmed_id::text = CAST(:p AS text)
                      AND id <> CAST(:oid AS uuid)
                      AND dropbox_path IS NOT NULL"""
            ), {"p": pmid, "oid": o["id"]}).mappings().all()
            matched_on = "pmid" if donors else None
        if not donors and doi:
            donors = conn.execute(sql_text(
                """SELECT id::text AS id, title
                     FROM articles
                    WHERE lower(doi) = :d
                      AND id <> CAST(:oid AS uuid)
                      AND dropbox_path IS NOT NULL"""
            ), {"d": doi, "oid": o["id"]}).mappings().all()
            matched_on = "doi" if donors else None

        if not donors:
            continue   # genuine orphan: no PDF in the catalogue
        if len(donors) > 1:
            ambiguous.append({
                "orphan_id":    o["id"],
                "orphan_title": o.get("title"),
                "donor_count":  len(donors),
                "donor_ids":    [d["id"] for d in donors],
            })
            continue
        pairs.append({
            "orphan_id":    o["id"],
            "orphan_title": o.get("title"),
            "donor_id":     donors[0]["id"],
            "donor_title":  donors[0].get("title"),
            "matched_on":   matched_on,
        })

    return pairs, ambiguous


def _merge_pair(conn, orphan_id: str, donor_id: str) -> None:
    """Atomic merge: donor data → orphan, then delete donor.

    Single transaction. The caller is responsible for opening
    `conn.begin()` (or being inside an `eng.begin() with` block).
    """
    # Step 1: read which columns of `articles` exist (defensive — the
    # legacy article_chunk migrations occasionally lag on production).
    existing_cols = {r[0] for r in conn.execute(sql_text(
        "SELECT column_name FROM information_schema.columns "
        " WHERE table_name = 'articles'"
    )).all()}

    safe_pdf_cols = [c for c in _PDF_COLS if c in existing_cols]

    # Step 2: pull the donor's values for every PDF column.
    donor_row = conn.execute(sql_text(
        f"SELECT {', '.join(safe_pdf_cols)} "
        f"  FROM articles WHERE id = CAST(:d AS uuid)"
    ), {"d": donor_id}).mappings().first()
    if not donor_row:
        return    # already gone, nothing to do

    # Step 3: move the values onto the orphan WHERE the orphan is
    # NULL/empty. COALESCE(orphan, donor) keeps any value the orphan
    # already had — we never overwrite curated data.
    set_clauses = ", ".join(
        f"{c} = COALESCE({c}, :{c})" for c in safe_pdf_cols
    )
    params = {**{c: donor_row[c] for c in safe_pdf_cols}, "o": orphan_id}
    conn.execute(sql_text(
        f"UPDATE articles SET {set_clauses}, updated_at = NOW() "
        f"WHERE id = CAST(:o AS uuid)"
    ), params)

    # Step 4: repoint per-user / per-collection / per-tag rows.
    # ON CONFLICT DO NOTHING handles users who marked BOTH rows.
    repoint_ops: list[tuple[str, str]] = [
        # (description, sql) — purely for logging.
        ("prionvault_user_state",
         "INSERT INTO prionvault_user_state "
         "  (user_id, article_id, is_favorite, read_at, "
         "   is_flagged, is_milestone, color_label, priority, "
         "   created_at, updated_at) "
         "SELECT user_id, CAST(:o AS uuid), is_favorite, read_at, "
         "       is_flagged, is_milestone, color_label, priority, "
         "       created_at, updated_at "
         "  FROM prionvault_user_state "
         " WHERE article_id = CAST(:d AS uuid) "
         "ON CONFLICT (user_id, article_id) DO NOTHING"),
        ("article_tag_link",
         "INSERT INTO article_tag_link (article_id, tag_id, added_by, added_at) "
         "SELECT CAST(:o AS uuid), tag_id, added_by, added_at "
         "  FROM article_tag_link "
         " WHERE article_id = CAST(:d AS uuid) "
         "ON CONFLICT (article_id, tag_id, added_by) DO NOTHING"),
        ("article_ratings",
         "UPDATE article_ratings SET article_id = CAST(:o AS uuid) "
         " WHERE article_id = CAST(:d AS uuid) "
         "   AND NOT EXISTS ("
         "     SELECT 1 FROM article_ratings r2 "
         "      WHERE r2.article_id = CAST(:o AS uuid) "
         "        AND r2.user_id    = article_ratings.user_id)"),
        ("prionvault_jc_presentation",
         "UPDATE prionvault_jc_presentation "
         "   SET article_id = CAST(:o AS uuid) "
         " WHERE article_id = CAST(:d AS uuid)"),
        ("article_supplementary",
         "UPDATE article_supplementary "
         "   SET article_id = CAST(:o AS uuid) "
         " WHERE article_id = CAST(:d AS uuid)"),
        ("prionvault_collection_article",
         "INSERT INTO prionvault_collection_article (collection_id, article_id) "
         "SELECT collection_id, CAST(:o AS uuid) "
         "  FROM prionvault_collection_article "
         " WHERE article_id = CAST(:d AS uuid) "
         "ON CONFLICT (collection_id, article_id) DO NOTHING"),
        ("user_articles",
         "INSERT INTO user_articles (id, user_id, article_id, status, created_at, updated_at) "
         "SELECT id, user_id, CAST(:o AS uuid), status, created_at, updated_at "
         "  FROM user_articles "
         " WHERE article_id = CAST(:d AS uuid)"),
        ("prionvault_user_selection",
         "INSERT INTO prionvault_user_selection (user_id, article_id, created_at) "
         "SELECT user_id, CAST(:o AS uuid), created_at "
         "  FROM prionvault_user_selection "
         " WHERE article_id = CAST(:d AS uuid) "
         "ON CONFLICT (user_id, article_id) DO NOTHING"),
        ("article_chunk",
         "DELETE FROM article_chunk WHERE article_id = CAST(:d AS uuid)"),
    ]
    for descr, q in repoint_ops:
        try:
            conn.execute(sql_text(q), {"o": orphan_id, "d": donor_id})
        except Exception as exc:
            # Tables may not exist on every deployment (article_chunk
            # in particular needs migration 001). Don't fail the merge
            # — log and continue.
            logger.warning("relink: %s repoint failed (%s)", descr, exc)

    # Step 5: delete the donor. By now everything per-article that
    # was on it has either moved or been intentionally discarded.
    conn.execute(sql_text(
        "DELETE FROM articles WHERE id = CAST(:d AS uuid)"
    ), {"d": donor_id})


def relink_orphans(dry_run: bool = False) -> dict:
    """Walk every PubMed-inventory orphan and merge in their unique
    donor when there is one.

    dry_run=True: returns the plan without touching anything.
    """
    eng = _get_engine()
    summary = {
        "dry_run":   bool(dry_run),
        "pairs":     [],   # successfully-mergeable
        "merged":    0,    # actually merged this run (0 if dry_run)
        "ambiguous": [],   # multi-donor cases left alone
        "errors":    [],
    }
    # Use connect() + per-pair savepoints instead of one big begin()
    # transaction. If one merge crashes, the rest still run — and the
    # crashed one doesn't poison the connection state. Dry-run never
    # writes, so it stays in a single read transaction.
    if dry_run:
        with eng.connect() as conn:
            pairs, ambiguous = _find_pairs(conn)
        summary["pairs"]     = pairs
        summary["ambiguous"] = ambiguous
        return summary

    with eng.connect() as conn:
        pairs, ambiguous = _find_pairs(conn)
        summary["pairs"]     = pairs
        summary["ambiguous"] = ambiguous

        for p in pairs:
            try:
                with conn.begin():    # SAVEPOINT-style per-pair tx
                    _merge_pair(conn, p["orphan_id"], p["donor_id"])
                summary["merged"] += 1
            except Exception as exc:
                logger.exception(
                    "relink: merge failed for %s ← %s",
                    p["orphan_id"], p["donor_id"])
                summary["errors"].append({
                    "orphan_id": p["orphan_id"],
                    "donor_id":  p["donor_id"],
                    "error":     str(exc)[:240],
                })
    return summary
