"""Tesseract-backed OCR fallback for scanned PDFs.

`pdfplumber` extracts text from PDFs that have a real text layer. For
scanned PDFs (essentially images wrapped in PDF containers) it returns
nothing. This module renders each page to an image with PyMuPDF and runs
Tesseract on it to recover the text.

Performance: ~3-8 seconds per page at 200 DPI on Tesseract default,
depending on page complexity. A typical 12-page paper costs ~1 minute.
No external API cost — pure CPU on the Railway container.

System prerequisites: the `tesseract` binary must be on PATH (added in
nixpacks.toml). PyMuPDF bundles its own MuPDF renderer, so no
additional system packages are required for the PDF → image step.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)

# Render DPI for the PDF → image step. Lower = faster + smaller memory;
# higher = better OCR accuracy. 200 is a robust middle ground for
# typical journal scans; 300 only helps for very dense / small text.
DEFAULT_DPI = 200

# Hard ceiling so a runaway 500-page conference proceedings doesn't
# stall the worker. If you hit this in practice, raise it deliberately.
MAX_PAGES = 60


@dataclass
class OCRResult:
    text:       str           # concatenated text from all OCRd pages
    pages:      int           # total pages in the PDF
    pages_ocrd: int           # how many of those produced any text
    elapsed_ms: int
    truncated:  bool          # True if MAX_PAGES capped the rendering
    error:      Optional[str] = None


def ocr_pdf_bytes(content: bytes, *, dpi: int = DEFAULT_DPI,
                  lang: str = "eng") -> OCRResult:
    """Render every page of a PDF (up to MAX_PAGES) and OCR it.

    Soft-fails: any rendering or OCR error is captured in `.error` and
    whatever text was already collected is still returned. The caller
    decides what to do with a partial result.
    """
    start = time.monotonic()
    try:
        import fitz  # type: ignore
        import pytesseract  # type: ignore
        from PIL import Image  # type: ignore
    except ImportError as exc:
        return OCRResult(text="", pages=0, pages_ocrd=0,
                         elapsed_ms=int((time.monotonic() - start) * 1000),
                         truncated=False, error=f"deps missing: {exc}")

    try:
        doc = fitz.open(stream=content, filetype="pdf")
    except Exception as exc:
        return OCRResult(text="", pages=0, pages_ocrd=0,
                         elapsed_ms=int((time.monotonic() - start) * 1000),
                         truncated=False, error=f"pdf open failed: {exc}")

    total_pages = doc.page_count
    pages_to_render = min(total_pages, MAX_PAGES)
    truncated = total_pages > MAX_PAGES
    chunks = []
    pages_ocrd = 0
    err: Optional[str] = None

    try:
        for i in range(pages_to_render):
            page = doc.load_page(i)
            try:
                pix = page.get_pixmap(dpi=dpi)
                # MuPDF returns RGB by default (alpha optional).
                mode = "RGB" if pix.alpha == 0 else "RGBA"
                img = Image.frombytes(mode, (pix.width, pix.height), pix.samples)
                if mode == "RGBA":
                    img = img.convert("RGB")
                text = pytesseract.image_to_string(img, lang=lang) or ""
                text = text.strip()
            except Exception as exc:
                logger.warning("OCR page %d failed: %s", i + 1, exc)
                err = err or f"page {i + 1}: {exc}"
                continue
            if text:
                pages_ocrd += 1
                chunks.append(text)
    finally:
        try:
            doc.close()
        except Exception:
            pass

    return OCRResult(
        text="\n\n".join(chunks).strip(),
        pages=total_pages,
        pages_ocrd=pages_ocrd,
        elapsed_ms=int((time.monotonic() - start) * 1000),
        truncated=truncated,
        error=err,
    )
