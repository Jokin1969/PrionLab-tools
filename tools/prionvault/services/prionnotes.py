"""PrionNotes — generic floating post-it board.

Ported from the PrionAAV Atlas blueprint. Notes are private per user and
attached to any entity via a generic (entity_type, entity_id) pair. This is
deliberately separate from the existing per-article sticky notes system
(prionvault_article_note / services/article_notes.py, capped at 5 notes per
article per user) — do not conflate the two.

Hardening applied relative to the blueprint:
  * The HTML whitelist drops `img` and `style` support entirely (the
    blueprint flags these as an inconsistent legacy risk on the server
    side while the client had already hardened its own whitelist —
    here both sides start hardened).
  * update_note / delete_note filter by user_id directly in the SQL
    WHERE clause, so a note owned by someone else always looks like a
    404 (never a 403 that would leak the note's existence).
"""
import html as _html
import logging
import re as _re
import time as _time
from html.parser import HTMLParser as _HTMLParser
from typing import Dict, List, Optional

from sqlalchemy import text as sql_text

from database.config import db

logger = logging.getLogger(__name__)

_NOTE_COLORS = frozenset({
    '#fef9c3', '#dcfce7', '#dbeafe', '#fce7f3', '#fff7ed', '#f3e8ff',
})
_DEFAULT_COLOR = '#fef9c3'

# For PrionVault: 'article' (per-article boards, wired from the detail
# modal) and 'workspace' (a fixed global scratchpad, entity_id='global',
# wired from the sidebar icon). Keep this minimal; extend only when a
# real use case shows up.
_ALLOWED_ENTITY_TYPES = frozenset({'article', 'workspace'})

_NOTE_MAX_BYTES = 500_000

# Hardened whitelist: no img, no style — matches the client-side sanitizer.
_TAGS = frozenset({
    'b', 'i', 'u', 'strong', 'em', 'br', 'p', 'ul', 'ol', 'li', 'span', 'div', 'a',
})
_ATTRS: Dict[str, frozenset] = {
    'a': frozenset({'href', 'title'}),
}
_HREF_RE = _re.compile(r'^(https?:|mailto:)', _re.I)


class _NoteSanitizer(_HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.buf: List[str] = []

    def handle_starttag(self, tag, attrs):
        if tag not in _TAGS:
            return
        ok = _ATTRS.get(tag, frozenset())
        safe = ''
        for name, val in attrs:
            if name not in ok or val is None:
                continue
            if name == 'href' and not _HREF_RE.match(val.strip()):
                continue
            safe += f' {name}="{_html.escape(val, quote=True)}"'
        self.buf.append(f'<{tag}{safe}>')

    def handle_endtag(self, tag):
        if tag in _TAGS:
            self.buf.append(f'</{tag}>')

    def handle_data(self, data):
        self.buf.append(_html.escape(data, quote=False))

    def handle_entityref(self, name):
        self.buf.append(f'&{name};')

    def handle_charref(self, name):
        self.buf.append(f'&#{name};')


def _sanitize_note_html(raw: str) -> str:
    """Whitelist-based HTML sanitizer (no external deps). No img/style."""
    s = _NoteSanitizer()
    s.feed(raw or '')
    return ''.join(s.buf)


def _note_text_content(html_text: str) -> str:
    """Strip tags to check whether a note is non-empty."""
    return _re.sub(r'<[^>]+>', '', html_text or '').strip()


def _new_note_id() -> str:
    return f"n{int(_time.time() * 1000)}"


def _row_to_dict(row) -> dict:
    return {
        'id': row.id,
        'text': row.text,
        'color': row.color,
        'created_at': row.created_at.isoformat() if row.created_at else None,
        'updated_at': row.updated_at.isoformat() if row.updated_at else None,
    }


def list_notes(user_id: str, entity_type: str, entity_id: str) -> List[dict]:
    if entity_type not in _ALLOWED_ENTITY_TYPES:
        raise ValueError('invalid entity_type')
    s = db.Session()
    try:
        rows = s.execute(sql_text(
            """SELECT id, text, color, created_at, updated_at
               FROM prionnotes_entity_notes
               WHERE user_id = :uid AND entity_type = :etype AND entity_id = :eid
               ORDER BY created_at"""
        ), {"uid": user_id, "etype": entity_type, "eid": str(entity_id)}).all()
        return [_row_to_dict(r) for r in rows]
    finally:
        s.close()


def create_note(user_id: str, entity_type: str, entity_id: str,
                 text: str, color: Optional[str]) -> dict:
    if entity_type not in _ALLOWED_ENTITY_TYPES:
        raise ValueError('invalid entity_type')
    if not isinstance(text, str) or len(text.encode()) > _NOTE_MAX_BYTES:
        raise ValueError('text_too_long')
    clean = _sanitize_note_html(text)
    if not _note_text_content(clean):
        raise ValueError('empty_note')
    if color not in _NOTE_COLORS:
        color = _DEFAULT_COLOR
    note_id = _new_note_id()
    s = db.Session()
    try:
        row = s.execute(sql_text(
            """INSERT INTO prionnotes_entity_notes
                   (id, user_id, entity_type, entity_id, text, color)
               VALUES (:id, :uid, :etype, :eid, :text, :color)
               RETURNING id, text, color, created_at, updated_at"""
        ), {
            "id": note_id, "uid": user_id, "etype": entity_type,
            "eid": str(entity_id), "text": clean, "color": color,
        }).first()
        s.commit()
        return _row_to_dict(row)
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


def update_note(user_id: str, entity_type: str, entity_id: str, note_id: str,
                 text: Optional[str], color: Optional[str]) -> Optional[dict]:
    if entity_type not in _ALLOWED_ENTITY_TYPES:
        raise ValueError('invalid entity_type')
    s = db.Session()
    try:
        existing = s.execute(sql_text(
            """SELECT id, text, color FROM prionnotes_entity_notes
               WHERE id = :id AND user_id = :uid
                     AND entity_type = :etype AND entity_id = :eid"""
        ), {"id": note_id, "uid": user_id, "etype": entity_type, "eid": str(entity_id)}).first()
        if not existing:
            return None

        new_text = existing.text
        if text is not None:
            if not isinstance(text, str) or len(text.encode()) > _NOTE_MAX_BYTES:
                raise ValueError('text_too_long')
            clean = _sanitize_note_html(text)
            if not _note_text_content(clean):
                raise ValueError('empty_note')
            new_text = clean

        new_color = color if color in _NOTE_COLORS else existing.color

        row = s.execute(sql_text(
            """UPDATE prionnotes_entity_notes
               SET text = :text, color = :color, updated_at = NOW()
               WHERE id = :id AND user_id = :uid
                     AND entity_type = :etype AND entity_id = :eid
               RETURNING id, text, color, created_at, updated_at"""
        ), {
            "id": note_id, "uid": user_id, "etype": entity_type, "eid": str(entity_id),
            "text": new_text, "color": new_color,
        }).first()
        s.commit()
        return _row_to_dict(row) if row else None
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


def delete_note(user_id: str, entity_type: str, entity_id: str, note_id: str) -> bool:
    if entity_type not in _ALLOWED_ENTITY_TYPES:
        raise ValueError('invalid entity_type')
    s = db.Session()
    try:
        result = s.execute(sql_text(
            """DELETE FROM prionnotes_entity_notes
               WHERE id = :id AND user_id = :uid
                     AND entity_type = :etype AND entity_id = :eid"""
        ), {"id": note_id, "uid": user_id, "etype": entity_type, "eid": str(entity_id)})
        s.commit()
        return result.rowcount > 0
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


def get_counts(user_id: str, entity_type: str, ids: List[str]) -> Dict[str, int]:
    if entity_type not in _ALLOWED_ENTITY_TYPES:
        raise ValueError('invalid entity_type')
    ids = [str(i) for i in ids if str(i).strip()]
    if not ids:
        return {}
    s = db.Session()
    try:
        rows = s.execute(sql_text(
            """SELECT entity_id, COUNT(*) AS n
               FROM prionnotes_entity_notes
               WHERE user_id = :uid AND entity_type = :etype
                     AND entity_id = ANY(:ids)
               GROUP BY entity_id"""
        ), {"uid": user_id, "etype": entity_type, "ids": ids}).all()
        counts = {r.entity_id: r.n for r in rows}
        return {i: counts.get(i, 0) for i in ids}
    finally:
        s.close()
