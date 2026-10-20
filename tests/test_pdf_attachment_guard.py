"""Tests for _collect_pdf_attachments in email_digest.py.

Exercises the size-cap and graceful-failure logic without real Dropbox
calls — we stub the client with simple fakes.
"""
import sys
import os
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import pytest

pytest.importorskip("sqlalchemy")

from tools.prionvault.services.email_digest import (
    _collect_pdf_attachments,
    _picks_article_card,
    _PDF_ATTACH_MAX_BYTES,
)


# ── Fakes ────────────────────────────────────────────────────────────────────

class _FakeMeta:
    def __init__(self, size):
        self.size = size
        self.name = "article.pdf"


class _FakeResponse:
    def __init__(self, data: bytes):
        self.content = data


class _FakeDbx:
    """Minimal Dropbox stub: always returns the given bytes."""
    def __init__(self, data: bytes, declared_size: int | None = None):
        self._data = data
        self._declared_size = declared_size if declared_size is not None else len(data)

    def files_download(self, path, timeout=None):
        meta = _FakeMeta(self._declared_size)
        return meta, _FakeResponse(self._data)


class _ErrorDbx:
    """Stub that always raises on download."""
    def files_download(self, path, timeout=None):
        raise RuntimeError("network error")


# Patch get_client so _collect_pdf_attachments uses our fake.
def _patch_client(monkeypatch, dbx):
    # Import the real module first so it is in sys.modules and has get_client.
    import core.dropbox_client as _dbx_mod
    monkeypatch.setattr(_dbx_mod, "get_client", lambda: dbx)


# ── Tests ────────────────────────────────────────────────────────────────────

def test_no_articles_returns_empty(monkeypatch):
    _patch_client(monkeypatch, _FakeDbx(b"data"))
    assert _collect_pdf_attachments([])[0] == []


def test_article_without_dropbox_path_skipped(monkeypatch):
    _patch_client(monkeypatch, _FakeDbx(b"data"))
    result, _ids = _collect_pdf_attachments([{"dropbox_path": None}])
    assert result == []


def test_small_pdf_included(monkeypatch):
    data = b"%PDF small content"
    _patch_client(monkeypatch, _FakeDbx(data))
    result, _ids = _collect_pdf_attachments([{"dropbox_path": "/papers/art.pdf"}])
    assert len(result) == 1
    fname, content, mime = result[0]
    assert content == data
    assert mime == "application/pdf"
    assert fname.endswith(".pdf")


def test_pdf_above_size_cap_skipped_via_metadata(monkeypatch):
    """Declared size above cap → skip before even reading body."""
    oversized = _PDF_ATTACH_MAX_BYTES + 1
    _patch_client(monkeypatch, _FakeDbx(b"x" * 100, declared_size=oversized))
    result, _ids = _collect_pdf_attachments([{"dropbox_path": "/papers/big.pdf"}])
    assert result == []


def test_pdf_above_size_cap_skipped_via_content(monkeypatch):
    """Body larger than cap but metadata absent (size=0) → skip after download."""
    oversized_bytes = b"x" * (_PDF_ATTACH_MAX_BYTES + 1)
    _patch_client(monkeypatch, _FakeDbx(oversized_bytes, declared_size=0))
    result, _ids = _collect_pdf_attachments([{"dropbox_path": "/papers/big2.pdf"}])
    assert result == []


def test_download_error_skipped_gracefully(monkeypatch):
    """A Dropbox error on one article must not prevent processing others."""
    _patch_client(monkeypatch, _ErrorDbx())
    # No exception should propagate
    result, _ids = _collect_pdf_attachments([{"dropbox_path": "/papers/err.pdf"}])
    assert result == []


def test_no_dropbox_client_returns_empty(monkeypatch):
    """When get_client() returns None, return empty list without crashing."""
    import core.dropbox_client as _dbx_mod
    monkeypatch.setattr(_dbx_mod, "get_client", lambda: None)
    result, _ids = _collect_pdf_attachments([{"dropbox_path": "/papers/x.pdf"}])
    assert result == []


def test_multiple_articles_partial_failure(monkeypatch):
    """Error on one article doesn't prevent successful others."""
    call_count = {"n": 0}

    class _MixedDbx:
        def files_download(self, path, timeout=None):
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise RuntimeError("first fails")
            return _FakeMeta(100), _FakeResponse(b"ok content")

    _patch_client(monkeypatch, _MixedDbx())
    articles = [
        {"dropbox_path": "/papers/fail.pdf"},
        {"dropbox_path": "/papers/ok.pdf"},
    ]
    result, _ids = _collect_pdf_attachments(articles)
    assert len(result) == 1
    assert result[0][1] == b"ok content"


def test_filename_sanitised(monkeypatch):
    """Filenames with special characters are made safe."""
    _patch_client(monkeypatch, _FakeDbx(b"data"))
    result, _ids = _collect_pdf_attachments([{"dropbox_path": "/papers/my article (2024).pdf"}])
    assert len(result) == 1
    fname = result[0][0]
    assert " " not in fname
    assert "(" not in fname


def test_attached_ids_tracks_article(monkeypatch):
    """attached_ids reports which articles were actually attached."""
    _patch_client(monkeypatch, _FakeDbx(b"%PDF ok"))
    articles = [
        {"article_id": "aaa", "dropbox_path": "/papers/a.pdf"},
        {"article_id": "bbb", "dropbox_path": None},   # no PDF
    ]
    result, ids = _collect_pdf_attachments(articles)
    assert len(result) == 1
    assert ids == {"aaa"}


def test_card_shows_view_pdf_with_only_dropbox_path():
    """An article with a Dropbox PDF but no md5 must NOT read 'Sin PDF'."""
    card = _picks_article_card(
        {"article_id": "xyz", "title": "T", "dropbox_path": "/p/a.pdf"},
        server_base_url="https://x", has_pdf=False,
    )
    assert "Ver PDF en PrionVault" in card
    assert "Sin PDF" not in card


def test_card_shows_attached_note():
    card = _picks_article_card(
        {"article_id": "xyz", "title": "T", "pdf_md5": "abc"},
        server_base_url="https://x", has_pdf=True,
    )
    assert "PDF adjunto" in card
