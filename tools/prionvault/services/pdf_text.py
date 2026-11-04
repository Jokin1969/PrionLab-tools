"""Make sure an article that HAS a PDF also has its extracted text.

The AI summary (and the chat, RAG, VC generator…) read `articles.extracted_text`.
Some ways of attaching a PDF — manual upload in the Edit modal, "🔓 Buscar PDF"
(OA fetch for one article) — stored the file without extracting its text, so
the summary silently fell back to the abstract. Every attach path now calls
`store_text_from_bytes`, and every summary path calls `ensure_text` first as a
safety net (downloads the PDF from Dropbox and extracts it; OCR for scans).
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import text as sql_text

from ..ingestion.queue import _get_engine

logger = logging.getLogger(__name__)

MIN_USEFUL_CHARS = 200


def _extract(content: bytes) -> tuple[Optional[str], Optional[int], bool]:
    """(text, pages, is_scan). pdfplumber first, OCR when there's no text layer."""
    from ..ingestion.pdf_extractor import extract_pdf
    text, pages = None, None
    try:
        res = extract_pdf(content)
        text, pages = res.text, res.pages
    except Exception as exc:
        logger.warning("pdf_text: pdfplumber failed (%s)", exc)
    if text and len(text) >= MIN_USEFUL_CHARS:
        return text, pages, False
    try:
        from ..ingestion.ocr import ocr_pdf_bytes
        ocr = ocr_pdf_bytes(content)
        if ocr.text and len(ocr.text) >= MIN_USEFUL_CHARS:
            return ocr.text, pages, True
    except Exception as exc:
        logger.warning("pdf_text: OCR failed (%s)", exc)
    return None, pages, True


def store_text_from_bytes(article_id, content: bytes) -> bool:
    """Extract the text of a just-attached PDF and save it. Returns True when
    usable text was stored. Never raises (attaching the PDF must not fail
    because extraction did)."""
    try:
        text, pages, is_scan = _extract(content)
        with _get_engine().begin() as conn:
            if text:
                conn.execute(sql_text("""
                    UPDATE articles SET extracted_text = :t, extraction_status = 'extracted',
                           extraction_error = NULL, pdf_pages = COALESCE(:p, pdf_pages),
                           pdf_is_scan = :scan, updated_at = NOW()
                     WHERE id = CAST(:id AS uuid)"""),
                    {"t": text, "p": pages, "scan": is_scan, "id": str(article_id)})
            else:
                conn.execute(sql_text("""
                    UPDATE articles SET extraction_status = 'failed',
                           extraction_error = 'Sin texto utilizable (ni capa de texto ni OCR).',
                           pdf_is_scan = TRUE, updated_at = NOW()
                     WHERE id = CAST(:id AS uuid)"""), {"id": str(article_id)})
        return bool(text)
    except Exception as exc:
        logger.warning("pdf_text: storing text for %s failed: %s", article_id, exc)
        return False


def ensure_text(article_id) -> Optional[str]:
    """The article's extracted text, extracting it now from its PDF in Dropbox
    if it has a PDF but no (usable) text yet. None when there is no PDF or no
    text could be obtained."""
    with _get_engine().connect() as conn:
        row = conn.execute(sql_text(
            "SELECT extracted_text, dropbox_path FROM articles WHERE id = CAST(:id AS uuid)"),
            {"id": str(article_id)}).first()
    if not row:
        return None
    text, path = row
    if text and len(text) >= MIN_USEFUL_CHARS:
        return text
    if not path:
        return text or None
    try:
        from core.dropbox_client import get_client
        client = get_client()
        if client is None:
            return text or None
        _meta, resp = client.files_download(path)
        content = resp.content
    except Exception as exc:
        logger.warning("pdf_text: download of %s failed: %s", path, exc)
        return text or None
    if store_text_from_bytes(article_id, content):
        with _get_engine().connect() as conn:
            return conn.execute(sql_text(
                "SELECT extracted_text FROM articles WHERE id = CAST(:id AS uuid)"),
                {"id": str(article_id)}).scalar()
    return text or None
