"""Detect whether a paper we are about to ingest is already in the DB.

Two checks, in order of strength:
  1. By DOI (case-insensitive). Most reliable.
  2. By MD5 hash of the PDF binary. Catches duplicates of papers with
     no DOI, identical scans of the same article, etc.
"""
from __future__ import annotations

import hashlib
import logging
from typing import Optional, Tuple
from uuid import UUID

from sqlalchemy import text

from database.config import db

logger = logging.getLogger(__name__)


def md5_of(content: bytes) -> str:
    return hashlib.md5(content).hexdigest()


def find_duplicate(
    *,
    doi: Optional[str] = None,
    pdf_md5: Optional[str] = None,
) -> Tuple[Optional[UUID], Optional[str]]:
    """Look for an existing article matching DOI or MD5.

    Returns (article_id, reason) on hit, or (None, None) on miss.
    `reason` is one of: 'doi', 'md5'.
    """
    if not getattr(db, "engine", None):
        return None, None

    with db.engine.connect() as conn:
        if doi:
            row = conn.execute(
                text("SELECT id FROM articles WHERE lower(doi) = :d LIMIT 1"),
                {"d": doi.lower()},
            ).first()
            if row:
                return row[0], "doi"
        if pdf_md5:
            row = conn.execute(
                text("SELECT id FROM articles WHERE pdf_md5 = :m LIMIT 1"),
                {"m": pdf_md5},
            ).first()
            if row:
                return row[0], "md5"
    return None, None
