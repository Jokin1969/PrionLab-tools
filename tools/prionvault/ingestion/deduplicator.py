"""Detect whether a paper we are about to ingest is already in the DB.

Three checks, in order of strength:
  1. By DOI (case-insensitive). Most reliable when present.
  2. By PMID. Critical for the PubMed-inventory-import flow: those
     rows arrive with a PMID and sometimes no DOI, so a later
     "Import PDFs" upload of the matching PDF must rejoin them by
     PMID — otherwise we create a duplicate article and the
     inventory-imported row stays stranded on "⏳ PDF pendiente".
  3. By MD5 hash of the PDF binary. Catches duplicates of papers
     with no DOI / PMID, identical scans of the same article, etc.
"""
from __future__ import annotations

import hashlib
import logging
from typing import Optional, Tuple
from uuid import UUID

from sqlalchemy import text

from .queue import _get_engine

logger = logging.getLogger(__name__)


def md5_of(content: bytes) -> str:
    return hashlib.md5(content).hexdigest()


def find_duplicate(
    *,
    doi: Optional[str] = None,
    pmid: Optional[str] = None,
    pdf_md5: Optional[str] = None,
) -> Tuple[Optional[UUID], Optional[str]]:
    """Look for an existing article matching DOI, PMID or MD5.

    Returns (article_id, reason) on hit, or (None, None) on miss.
    `reason` is one of: 'doi', 'pmid', 'md5'.
    """
    try:
        eng = _get_engine()
    except Exception:
        return None, None

    with eng.connect() as conn:
        if doi:
            row = conn.execute(
                text("SELECT id FROM articles WHERE lower(doi) = :d LIMIT 1"),
                {"d": doi.lower()},
            ).first()
            if row:
                return row[0], "doi"
        if pmid:
            # PMIDs are stored as strings (NCBI uses 1-8 digits, no
            # leading zeros). Cast both sides to text to dodge
            # accidental int/varchar mismatches on legacy rows.
            try:
                row = conn.execute(
                    text("SELECT id FROM articles "
                         " WHERE pubmed_id::text = CAST(:p AS text) LIMIT 1"),
                    {"p": str(pmid).strip()},
                ).first()
                if row:
                    return row[0], "pmid"
            except Exception as exc:
                logger.warning("PMID dedup query failed: %s", exc)
        if pdf_md5:
            # pdf_md5 column is added by migration 001. Skip the MD5 check
            # gracefully if the column doesn't exist yet.
            try:
                row = conn.execute(
                    text("SELECT id FROM articles WHERE pdf_md5 = :m LIMIT 1"),
                    {"m": pdf_md5},
                ).first()
                if row:
                    return row[0], "md5"
            except Exception as exc:
                if "pdf_md5" in str(exc):
                    logger.warning(
                        "Skipping MD5 dedup — column pdf_md5 missing "
                        "(migration 001 pending?): %s", exc
                    )
                else:
                    logger.warning("MD5 dedup query failed: %s", exc)
    return None, None
