import io
import logging
from base64 import b64decode
from datetime import datetime

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

logger = logging.getLogger(__name__)

_TEAL      = RGBColor(0x1a, 0x73, 0x73)
_DARK      = RGBColor(0x1e, 0x2d, 0x3d)
_DIM       = RGBColor(0x64, 0x74, 0x8b)
_LIGHT_BG  = RGBColor(0xf0, 0xf7, 0xf7)
_WHITE     = RGBColor(0xff, 0xff, 0xff)

PRIORITY_ES = {'high': 'Alta', 'medium': 'Media', 'low': 'Baja', 'none': '—'}
TYPE_ES = {
    'research': 'Investigación', 'review': 'Revisión',
    'clinical': 'Ensayo clínico', 'case': 'Caso clínico', 'meta': 'Meta-análisis',
}


def generate_package_docx(pkg: dict, version: int, send_date: datetime) -> bytes:
    doc = Document()

    # ── Page margins ──────────────────────────────────────────────────────────
    sec = doc.sections[0]
    sec.top_margin    = Cm(2.0)
    sec.bottom_margin = Cm(2.2)
    sec.left_margin   = Cm(2.5)
    sec.right_margin  = Cm(2.5)

    # ── Title ─────────────────────────────────────────────────────────────────
    t = doc.add_paragraph()
    t.alignment = WD_ALIGN_PARAGRAPH.LEFT
    run = t.add_run(pkg.get('title', 'Sin título'))
    run.font.size  = Pt(22)
    run.font.bold  = True
    run.font.color.rgb = _TEAL

    sub = doc.add_paragraph()
    run2 = sub.add_run(
        f"PrionPack {pkg.get('id', '')}  ·  "
        f"Versión {version}  ·  "
        f"Generado el {send_date.strftime('%d/%m/%Y %H:%M')}"
    )
    run2.font.size  = Pt(9)
    run2.font.color.rgb = _DIM

    doc.add_paragraph()

    # ── Metadata table ────────────────────────────────────────────────────────
    tbl = doc.add_table(rows=2, cols=3)
    tbl.style = 'Table Grid'
    headers = ['Tipo', 'Prioridad', 'Última modificación']
    values  = [
        TYPE_ES.get(pkg.get('type', ''), pkg.get('type', '—')),
        PRIORITY_ES.get(pkg.get('priority', 'none'), '—'),
        _fmt_date(pkg.get('lastModified')),
    ]
    for i, h in enumerate(headers):
        cell = tbl.rows[0].cells[i]
        _cell_bg(cell, '1a7373')
        p = cell.paragraphs[0]
        run = p.add_run(h)
        run.font.bold = True; run.font.size = Pt(9); run.font.color.rgb = _WHITE
    for i, v in enumerate(values):
        cell = tbl.rows[1].cells[i]
        _cell_bg(cell, 'f0f7f7')
        p = cell.paragraphs[0]
        run = p.add_run(v)
        run.font.size = Pt(9); run.font.color.rgb = _DARK

    doc.add_paragraph()

    # ── Description ───────────────────────────────────────────────────────────
    desc = (pkg.get('description') or '').strip()
    if desc:
        p = doc.add_paragraph()
        run = p.add_run(desc)
        run.font.italic = True; run.font.size = Pt(10); run.font.color.rgb = _DIM
        doc.add_paragraph()

    # ── Hypothesis ────────────────────────────────────────────────────────────
    _section_heading(doc, 'HIPÓTESIS PRINCIPAL')
    hyp = (pkg.get('hypothesis') or '').strip()
    if hyp:
        p = doc.add_paragraph()
        run = p.add_run(hyp)
        run.font.size = Pt(10); run.font.color.rgb = _DARK
    else:
        _dim_para(doc, '(sin hipótesis registrada)')
    doc.add_paragraph()

    # ── Introduction ─────────────────────────────────────────────────────────
    intro = (pkg.get('introduction') or '').strip()
    if intro:
        _section_heading(doc, 'INTRODUCCIÓN')
        p = doc.add_paragraph()
        r = p.add_run(intro)
        r.font.size = Pt(10); r.font.color.rgb = _DARK
        doc.add_paragraph()

    # ── Pre-process gaps for linking ──────────────────────────────────────────
    raw_missing = pkg.get('gaps', {}).get('missingInfo', [])
    gap_items = []
    for i, g in enumerate(raw_missing):
        if isinstance(g, str):
            gap_items.append({'text': g, 'fid': None, 'bm': f'ppgap_{i}'})
        else:
            gap_items.append({'text': g.get('text', ''), 'fid': g.get('findingId'), 'bm': f'ppgap_{i}'})

    gaps_for_finding: dict[str, list] = {}
    for gi in gap_items:
        if gi['fid']:
            gaps_for_finding.setdefault(gi['fid'], []).append(gi)

    # ── Findings ──────────────────────────────────────────────────────────────
    findings = pkg.get('findings', [])
    if findings:
        _section_heading(doc, 'HALLAZGOS PRINCIPALES')
        for fi, finding in enumerate(findings, 1):
            fid = finding.get('id', '')
            # Finding header with bookmark
            p = doc.add_paragraph()
            bm_name = f'ppfinding_{fid}' if fid else f'ppfinding_{fi}'
            _bookmark_add(p, bm_name, fi * 100)
            run = p.add_run(f'▶  F-{fi:02d} — {finding.get("title", "")}')
            run.font.bold = True; run.font.size = Pt(11); run.font.color.rgb = _TEAL

            en_title = (finding.get('titleEnglish') or '').strip()
            if en_title:
                p2 = doc.add_paragraph()
                r2 = p2.add_run(en_title)
                r2.font.italic = True; r2.font.size = Pt(9); r2.font.color.rgb = _DIM

            fdesc = (finding.get('description') or '').strip()
            if fdesc:
                p3 = doc.add_paragraph()
                r3 = p3.add_run(fdesc)
                r3.font.size = Pt(10); r3.font.color.rgb = _DARK

            # Figures
            for figi, fig in enumerate(finding.get('figures', []), 1):
                _render_figure(doc, fig, fi, figi)

            # Tables
            for tabi, tbl_item in enumerate(finding.get('tables', []), 1):
                p = doc.add_paragraph()
                r = p.add_run(f'Tabla {fi}.{tabi}')
                r.font.bold = True; r.font.size = Pt(9); r.font.color.rgb = _TEAL
                desc_t = (tbl_item.get('description') or '').strip()
                if desc_t:
                    r2 = p.add_run(f'  —  {desc_t}')
                    r2.font.size = Pt(9); r2.font.color.rgb = _DIM

            # Gap hyperlinks associated with this finding
            linked = gaps_for_finding.get(fid, [])
            if linked:
                p_gaps = doc.add_paragraph()
                r_label = p_gaps.add_run('Gaps asociados: ')
                r_label.font.size = Pt(9); r_label.font.bold = True; r_label.font.color.rgb = _DIM
                for k, gi in enumerate(linked):
                    if k: p_gaps.add_run(', ').font.size = Pt(9)
                    _hyperlink_anchor(p_gaps, gi['text'], gi['bm'], pt=9)

            doc.add_paragraph()

    # ── Gaps & Next Steps ─────────────────────────────────────────────────────
    _section_heading(doc, 'GAPS & NEXT STEPS')

    if gap_items:
        p_h = doc.add_paragraph()
        r_h = p_h.add_run('Información faltante')
        r_h.font.bold = True; r_h.font.size = Pt(10); r_h.font.color.rgb = _DARK

        for gi in gap_items:
            p = doc.add_paragraph(style='List Bullet')
            _bookmark_add(p, gi['bm'], abs(hash(gi['bm'])) % 90000 + 1000)
            run = p.add_run(gi['text'])
            run.font.size = Pt(10); run.font.color.rgb = _DARK

            if gi['fid']:
                linked_f = next((f for f in findings if f.get('id') == gi['fid']), None)
                if linked_f:
                    fi_num = findings.index(linked_f) + 1
                    ann = doc.add_paragraph()
                    r_ann = ann.add_run(f'     → Vinculado a F-{fi_num:02d}: {linked_f.get("title", "")}')
                    r_ann.font.size = Pt(8); r_ann.font.italic = True; r_ann.font.color.rgb = _TEAL

    needed = pkg.get('gaps', {}).get('neededExperiments', [])
    if needed:
        doc.add_paragraph()
        p_h2 = doc.add_paragraph()
        r_h2 = p_h2.add_run('Experimentos necesarios')
        r_h2.font.bold = True; r_h2.font.size = Pt(10); r_h2.font.color.rgb = _DARK
        for exp in needed:
            p = doc.add_paragraph(style='List Bullet')
            r = p.add_run(exp if isinstance(exp, str) else str(exp))
            r.font.size = Pt(10); r.font.color.rgb = _DARK

    doc.add_paragraph()

    # ── Discussion ────────────────────────────────────────────────────────────
    disc = (pkg.get('discussion') or '').strip()
    if disc:
        _section_heading(doc, 'DISCUSIÓN')
        p = doc.add_paragraph()
        r = p.add_run(disc)
        r.font.size = Pt(10); r.font.color.rgb = _DARK
        doc.add_paragraph()

    # ── Score ─────────────────────────────────────────────────────────────────
    scores = pkg.get('scores', {})
    total  = scores.get('total', 0)
    _section_heading(doc, f'PUNTUACIÓN TOTAL: {total}%')

    breakdown = [
        ('Hipótesis', scores.get('hypothesis', 0)),
        ('Hallazgos', scores.get('findings', 0)),
        ('Figuras',   scores.get('figures', 0)),
        ('Gaps',      scores.get('gaps', 0)),
    ]
    for label, val in breakdown:
        p = doc.add_paragraph()
        r = p.add_run(f'{label}: {val}%')
        r.font.size = Pt(10); r.font.color.rgb = _DARK

    doc.add_paragraph()

    # ── Footer ────────────────────────────────────────────────────────────────
    p_ft = doc.add_paragraph()
    r_ft = p_ft.add_run(
        f'Documento generado automáticamente por PrionLab Tools · '
        f'v{version} · {send_date.strftime("%d %b %Y")}'
    )
    r_ft.font.size = Pt(8); r_ft.font.color.rgb = _DIM

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _section_heading(doc: Document, text: str):
    p = doc.add_paragraph()
    run = p.add_run(text)
    run.font.bold  = True
    run.font.size  = Pt(10)
    run.font.color.rgb = _TEAL
    _para_border_bottom(p)


def _dim_para(doc: Document, text: str):
    p = doc.add_paragraph()
    r = p.add_run(text)
    r.font.size = Pt(10); r.font.italic = True; r.font.color.rgb = _DIM


def _render_figure(doc: Document, fig: dict, fi: int, figi: int):
    img_url = fig.get('imageUrl') or fig.get('image') or ''
    caption = (fig.get('caption') or fig.get('description') or '').strip()
    label   = f'Figura {fi}.{figi}'

    if img_url and img_url.startswith('data:'):
        try:
            header, b64data = img_url.split(',', 1)
            mime = header.split(';')[0].split(':')[1]
            if 'svg' not in mime:
                img_bytes = b64decode(b64data)
                p = doc.add_paragraph()
                run = p.add_run()
                run.add_picture(io.BytesIO(img_bytes), width=Cm(12))
        except Exception:
            pass

    p_cap = doc.add_paragraph()
    r_label = p_cap.add_run(label)
    r_label.font.bold = True; r_label.font.size = Pt(9); r_label.font.color.rgb = _TEAL
    if caption:
        r_cap = p_cap.add_run(f'  {caption}')
        r_cap.font.size = Pt(9); r_cap.font.color.rgb = _DIM


def _bookmark_add(para, bm_name: str, bm_id: int):
    start = OxmlElement('w:bookmarkStart')
    start.set(qn('w:id'),   str(bm_id))
    start.set(qn('w:name'), bm_name)
    end = OxmlElement('w:bookmarkEnd')
    end.set(qn('w:id'), str(bm_id))
    para._p.append(start)
    para._p.append(end)


def _hyperlink_anchor(para, text: str, anchor: str, pt: int = 10):
    hl = OxmlElement('w:hyperlink')
    hl.set(qn('w:anchor'), anchor)
    r = OxmlElement('w:r')
    rpr = OxmlElement('w:rPr')
    color = OxmlElement('w:color'); color.set(qn('w:val'), '1a7373')
    u = OxmlElement('w:u');         u.set(qn('w:val'), 'single')
    sz = OxmlElement('w:sz');       sz.set(qn('w:val'), str(pt * 2))
    rpr.append(color); rpr.append(u); rpr.append(sz)
    t = OxmlElement('w:t'); t.text = text
    r.append(rpr); r.append(t)
    hl.append(r)
    para._p.append(hl)


def _cell_bg(cell, hex_color: str):
    tc = cell._tc
    tcp = tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'),   'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'),  hex_color)
    tcp.append(shd)


def _para_border_bottom(para):
    ppr = para._p.get_or_add_pPr()
    pbdr = OxmlElement('w:pBdr')
    bottom = OxmlElement('w:bottom')
    bottom.set(qn('w:val'),   'single')
    bottom.set(qn('w:sz'),    '4')
    bottom.set(qn('w:space'), '1')
    bottom.set(qn('w:color'), '1a7373')
    pbdr.append(bottom)
    ppr.append(pbdr)


def _fmt_date(iso: str) -> str:
    if not iso:
        return '—'
    try:
        return datetime.fromisoformat(iso.replace('Z', '+00:00')).strftime('%d/%m/%Y')
    except Exception:
        return iso
