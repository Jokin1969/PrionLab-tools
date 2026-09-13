"""Downloadable PDF of the in-app "Ayuda" (help) content — ReportLab, same
stack as chat_report.py / jc.py (see those modules for why not WeasyPrint).

The Ayuda content itself lives entirely client-side, as HTML template
literals in static/js/prionvault.js (there's no backend copy to render
from). Rather than hand-duplicating that text here — guaranteed to drift
out of sync the next time someone edits a help section — the frontend
sends the already-rendered HTML for each tab and this module converts it
to PDF flowables with a small generic HTML-to-ReportLab walker. The help
content only ever uses a fixed, well-formed subset of tags (h3/h4/p/ul/li/
table/div/span/strong/em/code/i/br), so a full HTML5 parser isn't needed.
"""
from __future__ import annotations

import html as _html
from html.parser import HTMLParser
from typing import Optional

ACCENT_HEX = "0F3460"

_BLOCK_TAGS = {"h3", "h4", "p", "ul", "ol", "li", "table", "thead", "tbody", "tr", "td", "th", "div"}
_VOID_TAGS = {"br", "img", "hr"}


class _Node:
    __slots__ = ("tag", "attrs", "children")

    def __init__(self, tag: str, attrs=None):
        self.tag = tag
        self.attrs = dict(attrs or [])
        self.children: list = []


class _TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _Node("root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = _Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in _VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(_Node(tag, attrs))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        if data:
            self.stack[-1].children.append(data)


def _parse_html(fragment: str) -> _Node:
    builder = _TreeBuilder()
    builder.feed(fragment or "")
    return builder.root


def _esc(s: str) -> str:
    return _html.escape(s or "", quote=False)


def _has_block_children(node: _Node) -> bool:
    return any(isinstance(c, _Node) and c.tag in _BLOCK_TAGS for c in node.children)


def _inline_markup(node) -> str:
    """Renders a node's content as ReportLab's small XML-like Paragraph
    markup (<b>, <i>, <font>, <br/>), skipping nested block-level tags
    (those are rendered separately by the caller) and FontAwesome icon
    <i> tags (which carry no text of their own anyway)."""
    if isinstance(node, str):
        return _esc(node)
    out = []
    for child in node.children:
        if isinstance(child, str):
            out.append(_esc(child))
            continue
        tag = child.tag
        if tag in ("strong", "b"):
            out.append(f"<b>{_inline_markup(child)}</b>")
        elif tag == "em":
            out.append(f"<i>{_inline_markup(child)}</i>")
        elif tag == "code":
            out.append(f'<font face="Courier">{_inline_markup(child)}</font>')
        elif tag == "br":
            out.append("<br/>")
        elif tag in _BLOCK_TAGS:
            continue
        else:  # span, i, a, ... — transparent inline containers
            out.append(_inline_markup(child))
    return "".join(out).strip()


def _render_table(table_node: _Node, story: list, styles: dict):
    from reportlab.lib import colors
    from reportlab.platypus import Table, TableStyle, Spacer, Paragraph

    rows: list = []

    def walk(node: _Node):
        for c in node.children:
            if isinstance(c, _Node):
                if c.tag == "tr":
                    rows.append(c)
                elif c.tag in ("thead", "tbody"):
                    walk(c)

    walk(table_node)
    if not rows:
        return

    data: list = []
    style_cmds = [
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]
    max_cols = 0
    for ri, tr in enumerate(rows):
        cells = [c for c in tr.children if isinstance(c, _Node) and c.tag in ("td", "th")]
        if not cells:
            continue
        is_header = all(c.tag == "th" for c in cells)
        if is_header:
            style_cmds.append(("BACKGROUND", (0, ri), (-1, ri), colors.HexColor("#" + ACCENT_HEX)))
        row_data = []
        col_idx = 0
        for cell in cells:
            colspan = 1
            try:
                colspan = max(1, int(cell.attrs.get("colspan", 1)))
            except (TypeError, ValueError):
                pass
            style = styles["th"] if is_header else styles["td"]
            if cell.attrs.get("style", "").find("font-weight:700") != -1 and not is_header:
                style = styles["td_strong"]
            row_data.append(Paragraph(_inline_markup(cell) or " ", style))
            if colspan > 1:
                style_cmds.append(("SPAN", (col_idx, ri), (col_idx + colspan - 1, ri)))
                row_data.extend([""] * (colspan - 1))
            col_idx += colspan
        max_cols = max(max_cols, col_idx)
        data.append(row_data)

    for row in data:
        while len(row) < max_cols:
            row.append("")

    t = Table(data, style=TableStyle(style_cmds), repeatRows=1 if data else 0)
    story.append(t)
    story.append(Spacer(1, 8))


def _render_node(node: _Node, story: list, styles: dict):
    from reportlab.platypus import Paragraph

    for child in node.children:
        if isinstance(child, str):
            txt = child.strip()
            if txt:
                story.append(Paragraph(_esc(txt), styles["p"]))
            continue

        tag = child.tag
        if tag == "h3":
            txt = _inline_markup(child)
            if txt:
                story.append(Paragraph(txt, styles["h3"]))
        elif tag == "h4":
            txt = _inline_markup(child)
            if txt:
                story.append(Paragraph(txt, styles["h4"]))
        elif tag in ("ul", "ol"):
            for li in child.children:
                if isinstance(li, _Node) and li.tag == "li":
                    txt = _inline_markup(li)
                    if txt:
                        story.append(Paragraph("&#8226;&nbsp; " + txt, styles["li"]))
        elif tag == "table":
            _render_table(child, story, styles)
        elif tag in ("p", "div", "span"):
            if _has_block_children(child):
                _render_node(child, story, styles)
            else:
                txt = _inline_markup(child)
                if txt:
                    story.append(Paragraph(txt, styles["p"]))
        else:
            _render_node(child, story, styles)


def _styles() -> dict:
    from reportlab.lib import colors
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

    base = getSampleStyleSheet()
    accent = colors.HexColor("#" + ACCENT_HEX)
    return {
        "title": ParagraphStyle("hr_title", parent=base["Title"], fontSize=20,
                                 textColor=accent, spaceAfter=2),
        "subtitle": ParagraphStyle("hr_subtitle", parent=base["Normal"], fontSize=9.5,
                                    textColor=colors.HexColor("#6b7280"), spaceAfter=6),
        "tabtitle": ParagraphStyle("hr_tabtitle", parent=base["Heading1"], fontSize=16,
                                    textColor=accent, spaceBefore=4, spaceAfter=6),
        "h3": ParagraphStyle("hr_h3", parent=base["Heading2"], fontSize=13,
                              textColor=colors.HexColor("#111827"), spaceBefore=10, spaceAfter=6),
        "h4": ParagraphStyle("hr_h4", parent=base["Heading3"], fontSize=11,
                              textColor=accent, spaceBefore=10, spaceAfter=4),
        "p": ParagraphStyle("hr_p", parent=base["Normal"], fontSize=9.5, leading=13.5,
                             textColor=colors.HexColor("#1f2937"), spaceAfter=5),
        "li": ParagraphStyle("hr_li", parent=base["Normal"], fontSize=9.5, leading=13.5,
                              leftIndent=12, textColor=colors.HexColor("#1f2937"), spaceAfter=3),
        "th": ParagraphStyle("hr_th", parent=base["Normal"], fontSize=8,
                              textColor=colors.white, fontName="Helvetica-Bold"),
        "td": ParagraphStyle("hr_td", parent=base["Normal"], fontSize=8,
                              textColor=colors.HexColor("#1f2937")),
        "td_strong": ParagraphStyle("hr_td_strong", parent=base["Normal"], fontSize=8,
                                     fontName="Helvetica-Bold", textColor=colors.HexColor("#6b7280")),
    }


def render_pdf(sections: list[dict]) -> bytes:
    """`sections` is [{"label": <tab display name>, "html": <rendered
    innerHTML for that tab>}, ...] as sent by the "Descargar PDF" button
    in the Ayuda modal."""
    from io import BytesIO
    from datetime import datetime
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import cm
    from reportlab.platypus import SimpleDocTemplate, Paragraph, HRFlowable, PageBreak

    styles = _styles()
    story = [
        Paragraph("Guía de PrionVault", styles["title"]),
        Paragraph(f"Ayuda completa &middot; generado el {datetime.now().strftime('%d/%m/%Y %H:%M')}",
                   styles["subtitle"]),
    ]
    for i, sec in enumerate(sections or []):
        if i > 0:
            story.append(PageBreak())
        label = (sec.get("label") or sec.get("tab") or "").strip()
        if label:
            story.append(Paragraph(_esc(label), styles["tabtitle"]))
            story.append(HRFlowable(width="100%", thickness=1,
                                     color=colors.HexColor("#" + ACCENT_HEX), spaceAfter=10))
        root = _parse_html(sec.get("html") or "")
        _render_node(root, story, styles)

    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4,
                             topMargin=2 * cm, bottomMargin=2 * cm,
                             leftMargin=2.2 * cm, rightMargin=2.2 * cm)
    doc.build(story)
    return buf.getvalue()
