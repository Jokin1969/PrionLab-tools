"""One-shot migration: relocate PrionRead's existing PDFs in Dropbox
from their current PrionRead-managed paths to the canonical
`/PrionVault/<year>/<doi-slug>.pdf` layout.

Why a Python script and not SQL:
  - The data is in Dropbox (a remote object store), not in PostgreSQL.
  - We need to call Dropbox's `files_move_v2` for each row, which only
    the application can do (with the existing OAuth token).
  - We also UPDATE `articles.dropbox_path` after each successful move.

Safety:
  - Reads `articles.dropbox_path` for every row that has one.
  - Computes the canonical PrionVault path.
  - If the source already lives at the canonical path, skips it (idempotent).
  - If the destination already exists in Dropbox (e.g. another job placed
    it there earlier), skips and logs a warning instead of overwriting.
  - Any failure on a single row is logged; the rest keep going.

Run from the repo root, with DATABASE_URL and Dropbox credentials in env:
    python -m migrations.002_relocate_prionread_pdfs --dry-run
    python -m migrations.002_relocate_prionread_pdfs            # for real
    python -m migrations.002_relocate_prionread_pdfs --limit 5  # sample run

Or via the admin endpoint POST /prionvault/api/admin/migrate-prionread-pdfs
which calls into the same `relocate_all()` function.
"""
from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class RelocateResult:
    moved:     int = 0
    skipped:   int = 0  # already in place
    missing:   int = 0  # source path not found in Dropbox
    failed:    int = 0
    details:   list = None  # per-row outcomes for the admin UI

    def to_dict(self):
        return {"moved": self.moved, "skipped": self.skipped,
                "missing": self.missing, "failed": self.failed,
                "details": self.details or []}


def relocate_all(*, dry_run: bool = False, limit: Optional[int] = None) -> RelocateResult:
    """Move every PrionRead-uploaded PDF to the canonical PrionVault layout.

    Returns a RelocateResult with per-row outcomes.
    """
    from sqlalchemy import text
    from database.config import db
    from tools.prionvault.ingestion.dropbox_uploader import build_path, move_path

    if not getattr(db, "engine", None):
        return RelocateResult(failed=1, details=[
            {"id": None, "outcome": "no_database_engine"}])

    # Pull every article that has a PDF path AND isn't already canonical.
    sql = (
        "SELECT id, doi, year, dropbox_path, pdf_md5, title "
        "FROM articles "
        "WHERE dropbox_path IS NOT NULL "
        "  AND dropbox_path <> '' "
        "  AND dropbox_path NOT LIKE '/PrionVault/%' "
        "ORDER BY created_at "
    )
    if limit:
        sql += "LIMIT :limit"

    out = RelocateResult(details=[])
    with db.engine.connect() as conn:
        rows = conn.execute(text(sql), {"limit": limit} if limit else {}).all()

    for r in rows:
        try:
            target = build_path(doi=r.doi, year=r.year, md5=r.pdf_md5,
                                filename_hint=(r.title or "")[:80])
            if r.dropbox_path == target:
                out.skipped += 1
                out.details.append({"id": str(r.id), "outcome": "already_canonical",
                                    "from": r.dropbox_path, "to": target})
                continue

            if dry_run:
                out.details.append({"id": str(r.id), "outcome": "would_move",
                                    "from": r.dropbox_path, "to": target})
                continue

            new_path = move_path(r.dropbox_path, target, overwrite=False)
            if new_path is None:
                # move_path returns None on any Dropbox error; the most
                # common failure is "source path not found" (the file
                # was removed manually) or "destination exists".
                out.missing += 1
                out.details.append({"id": str(r.id), "outcome": "missing_or_conflict",
                                    "from": r.dropbox_path, "to": target})
                continue

            with db.engine.begin() as wconn:
                wconn.execute(
                    text("UPDATE articles SET dropbox_path = :p, updated_at = NOW() WHERE id = :id"),
                    {"p": new_path, "id": r.id},
                )
            out.moved += 1
            out.details.append({"id": str(r.id), "outcome": "moved",
                                "from": r.dropbox_path, "to": new_path})

        except Exception as exc:
            logger.warning("relocate row %s failed: %s", r.id, exc)
            out.failed += 1
            out.details.append({"id": str(r.id), "outcome": "failed",
                                "from": r.dropbox_path, "error": str(exc)[:200]})

    return out


# CLI entrypoint
def _main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--dry-run", action="store_true",
                        help="Don't actually move anything; just report.")
    parser.add_argument("--limit", type=int, default=None,
                        help="Process only the first N rows.")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    result = relocate_all(dry_run=args.dry_run, limit=args.limit)
    print(f"\nMoved:    {result.moved}")
    print(f"Skipped:  {result.skipped}")
    print(f"Missing:  {result.missing}")
    print(f"Failed:   {result.failed}\n")
    if args.verbose:
        for d in result.details:
            print(f"  {d}")


if __name__ == "__main__":
    _main(sys.argv[1:])
