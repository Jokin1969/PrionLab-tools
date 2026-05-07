import io
import logging
import re
from base64 import b64decode
from datetime import datetime

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

from . import members as members_module

logger = logging.getLogger(__name__)

_TEAL      = RGBColor(0x1a, 0x73, 0x73)
_DARK      = RGBColor(0x1e, 0x2d, 0x3d)
_DIM       = RGBColor(0x64, 0x74, 0x8b)
_LIGHT_BG  = RGBColor(0xf0, 0xf7, 0xf7)
_WHITE     = RGBColor(0xff, 0xff, 0xff)

# Markdown-style superscript: PrP^Sc^ -> PrP + superscript("Sc")
_SUP_RE = re.compile(r'\^([^\^\s][^\^]*?)\^')

# Header line that introduces the abstract block inside a reference string
_REF_SUMMARY_HEADERS = re.compile(
    r'^\s*(Resumen|Resumen del artículo|Abstract)\s*:?\s*$',
    re.IGNORECASE | re.MULTILINE,
)

# DOI pattern: matches "DOI: 10.xxxx/..." (case-insensitive)
_DOI_RE = re.compile(r'(DOI:\s*)(10\.\d{4,}[./][^\s,;]+)', re.IGNORECASE)


def _apply_font(run, *, size=None, bold=None, italic=None, color=None):
    if size is not None:   run.font.size = size
    if bold is not None:   run.font.bold = bold
    if italic is not None: run.font.italic = italic
    if color is not None:  run.font.color.rgb = color


def add_runs(paragraph, text, *, size=None, bold=None, italic=None, color=None):
    """add_run() replacement that turns ^xxx^ markers into superscript runs.

    All runs share the supplied font attributes; only `superscript` differs
    on the bracketed segments.
    """
    if not text:
        return
    pos = 0
    for m in _SUP_RE.finditer(text):
        if m.start() > pos:
            r = paragraph.add_run(text[pos:m.start()])
            _apply_font(r, size=size, bold=bold, italic=italic, color=color)
        rs = paragraph.add_run(m.group(1))
        rs.font.superscript = True
        _apply_font(rs, size=size, bold=bold, italic=italic, color=color)
        pos = m.end()
    if pos < len(text):
        r = paragraph.add_run(text[pos:])
        _apply_font(r, size=size, bold=bold, italic=italic, color=color)

def _hyperlink_url(para, display: str, url: str, *, pt: int = 10):
    """Add an external URL hyperlink run to `para` (blue underlined)."""
    r_id = para.part.relate_to(url, RT.HYPERLINK, is_external=True)
    hl = OxmlElement('w:hyperlink')
    hl.set(qn('r:id'), r_id)
    r = OxmlElement('w:r')
    rpr = OxmlElement('w:rPr')
    c = OxmlElement('w:color'); c.set(qn('w:val'), '0563C1')
    u = OxmlElement('w:u');     u.set(qn('w:val'), 'single')
    sz = OxmlElement('w:sz');   sz.set(qn('w:val'), str(pt * 2))
    rpr.append(c); rpr.append(u); rpr.append(sz)
    t = OxmlElement('w:t'); t.text = display
    r.append(rpr); r.append(t)
    hl.append(r)
    para._p.append(hl)


def add_runs_with_doi(paragraph, text, *, size=None, bold=None, italic=None, color=None):
    """Like add_runs() but turns DOI values into clickable doi.org hyperlinks."""
    if not text:
        return
    pt = int(size.pt) if size else 10
    last = 0
    for m in _DOI_RE.finditer(text):
        if m.start() > last:
            add_runs(paragraph, text[last:m.start()], size=size, bold=bold, italic=italic, color=color)
        label_run = paragraph.add_run(m.group(1))
        _apply_font(label_run, size=size, bold=bold, italic=italic, color=color)
        doi_val = m.group(2).rstrip('.,;)')
        _hyperlink_url(paragraph, doi_val, f'https://doi.org/{doi_val}', pt=pt)
        last = m.end()
    if last < len(text):
        add_runs(paragraph, text[last:], size=size, bold=bold, italic=italic, color=color)


PRIORITY_ES = {'high': 'Alta', 'medium': 'Media', 'low': 'Baja', 'none': '—'}
TYPE_ES = {
    'research': 'Investigación', 'review': 'Revisión',
    'clinical': 'Ensayo clínico', 'case': 'Caso clínico', 'meta': 'Meta-análisis',
}


def _split_reference(ref: str) -> tuple:
    """Return (header, abstract) by splitting at a 'Resumen:'/'Abstract:' line.

    If no such marker exists the full text is returned as header with an
    empty abstract string.
    """
    if not ref:
        return '', ''
    m = _REF_SUMMARY_HEADERS.search(ref)
    if not m:
        return ref.rstrip(), ''
    return ref[:m.start()].rstrip(), ref[m.end():].strip()


def generate_package_docx(pkg: dict, version: int, send_date: datetime) -> bytes:
    doc = Document()

    # ── Page margins ────────────────────────────────────────────────────────────────────────────
    sec = doc.sections[0]
    sec.top_margin    = Cm(2.0)
    sec.bottom_margin = Cm(2.2)
    sec.left_margin   = Cm(2.5)
    sec.right_margin  = Cm(2.5)

    # ── Resolve responsible (needed by header and subtitle) ─────────────────────────────────
    resp_id = pkg.get('responsible') or ''
    resp_name = ''
    if resp_id:
        m = members_module.get_member(resp_id)
        if m:
            resp_name = f"{m['name']} {m['surname']}"

    # ── Page header: PRP-### · Responsable · date ───────────────────────────────────────────
    hdr = sec.header
    hp = hdr.paragraphs[0] if hdr.paragraphs else hdr.add_paragraph()
    hp.clear()
    hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    r_id = hp.add_run(pkg.get('id', 'PRP'))
    r_id.font.bold = True; r_id.font.size = Pt(8); r_id.font.color.rgb = _TEAL
    if resp_name:
        r_resp = hp.add_run(f'  ·  {resp_name}')
        r_resp.font.size = Pt(8); r_resp.font.color.rgb = _DIM
    r_sep = hp.add_run('  ·  ' + send_date.strftime('%d/%m/%Y'))
    r_sep.font.size = Pt(8); r_sep.font.color.rgb = _DIM

    # ── Title ────────────────────────────────────────────────────────────────────────────────
    t = doc.add_paragraph()
    t.alignment = WD_ALIGN_PARAGRAPH.LEFT
    add_runs(t, pkg.get('title', 'Sin título'), size=Pt(22), bold=True, color=_TEAL)

    # Alternative titles, one per line, italic dim grey beneath the main title
    alt_titles = pkg.get('altTitles') or []
    for at in alt_titles:
        at_clean = (at or '').strip()
        if not at_clean:
            continue
        ap = doc.add_paragraph()
        ap.alignment = WD_ALIGN_PARAGRAPH.LEFT
        add_runs(ap, at_clean, size=Pt(14), italic=True, color=_TEAL)

    resp_part = f"  ·  Responsable: {resp_name}" if resp_name else ''
    sub = doc.add_paragraph()
    run2 = sub.add_run(
        f"PrionPack {pkg.get('id', '')}  ·  "
        f"Versión {version}{resp_part}  ·  "
        f"Generado el {send_date.strftime('%d/%m/%Y %H:%M')}"
    )
    run2.font.size  = Pt(9)
    run2.font.color.rgb = _DIM

    doc.add_paragraph()

    # ── Description ──────────────────────────────────────────────────────────────────────────
    desc = (pkg.get('description') or '').strip()
    if desc:
        _section_heading(doc, 'DESCRIPCIÓN BREVE')
        p = doc.add_paragraph()
        add_runs(p, desc, italic=True, size=Pt(10), color=_DIM)
        doc.add_paragraph()

    # ── Co-authors ──────────────────────────────────────────────────────────────────────────
    coauthors = (pkg.get('coAuthors') or '').strip()
    if coauthors:
        _section_heading(doc, 'CO-AUTORES')
        p = doc.add_paragraph()
        add_runs(p, coauthors, size=Pt(10), color=_DARK)
        doc.add_paragraph()

    # ── Affiliations ─────────────────────────────────────────────────────────────────────────
    affiliations = (pkg.get('affiliations') or '').strip()
    if affiliations:
        _section_heading(doc, 'AFILIACIONES')
        p = doc.add_paragraph()
        add_runs(p, affiliations, size=Pt(10), color=_DARK)
        doc.add_paragraph()

    # ── Abstract ──────────────────────────────────────────────────────────────────────────────
    abstract = (pkg.get('abstract') or '').strip()
    if abstract:
        _section_heading(doc, 'ABSTRACT', collapsed=True)
        p = doc.add_paragraph()
        add_runs(p, abstract, size=Pt(10), color=_DARK)
        doc.add_paragraph()

    # ── Author Summary ─────────────────────────────────────────────────────────────────────────
    author_summary = (pkg.get('authorSummary') or '').strip()
    if author_summary:
        _section_heading(doc, 'RESUMEN PARA AUTORES', collapsed=True)
        p = doc.add_paragraph()
        add_runs(p, author_summary, size=Pt(10), color=_DARK)
        doc.add_paragraph()

    # ── Introduction ─────────────────────────────────────────────────────────────────────────
    intro = (pkg.get('introduction') or '').strip()
    if intro:
        _section_heading(doc, 'INTRODUCCIÓN')
        p = doc.add_paragraph()
        add_runs(p, intro, size=Pt(10), color=_DARK)
        doc.add_paragraph()

    # ── Introduction References (Ri-XX) ───────────────────────────────────────────────────────
    intro_refs_raw = pkg.get('introReferences')
    if isinstance(intro_refs_raw, list):
        intro_refs_list = [str(r).strip() for r in intro_refs_raw if isinstance(r, str) and r.strip()]
    elif isinstance(intro_refs_raw, str) and intro_refs_raw.strip():
        intro_refs_list = [intro_refs_raw.strip()]
    else:
        intro_refs_list = []
    if intro_refs_list:
        _section_heading(doc, 'REFERENCIAS DE INTRODUCCIÓN', collapsed=True)
        for i, ref in enumerate(intro_refs_list, 1):
            header, abstract = _split_reference(ref)
            p = doc.add_paragraph(style='Heading 3')
            pPr = p._p.get_or_add_pPr()
            collapsed_el = OxmlElement('w:collapsed')
            collapsed_el.set(qn('w:val'), '1')
            pPr.append(collapsed_el)
            r_num = p.add_run(f'[Ri-{i:02d}] ')
            r_num.font.size = Pt(10); r_num.font.bold = True; r_num.font.color.rgb = _TEAL
            add_runs_with_doi(p, header, size=Pt(10), color=_DARK)
            if abstract:
                p_abs = doc.add_paragraph()
                add_runs(p_abs, abstract, size=Pt(9), italic=True, color=_DIM)
            sep = doc.add_paragraph()
            sep.paragraph_format.space_after = Pt(8)

    # ── Methods (multi-field: list of {title, body}) ──────────────────────────────────────────
    methods_raw = pkg.get('methods')
    if isinstance(methods_raw, list):
        methods_list = []
        for m in methods_raw:
            if isinstance(m, dict):
                t = (m.get('title') or '').strip()
                b = (m.get('body') or '').strip()
                if t or b:
                    methods_list.append({'title': t, 'body': b})
            elif isinstance(m, str) and m.strip():
                methods_list.append({'title': '', 'body': m.strip()})
    elif isinstance(methods_raw, str) and methods_raw.strip():
        methods_list = [{'title': '', 'body': methods_raw.strip()}]
    else:
        methods_list = []
    if methods_list:
        _section_heading(doc, 'MÉTODOS')
        for mi, m in enumerate(methods_list, 1):
            if m['title']:
                p_t = doc.add_paragraph()
                r_n = p_t.add_run(f'M-{mi:02d} — ')
                r_n.font.bold = True; r_n.font.size = Pt(11); r_n.font.color.rgb = _TEAL
                add_runs(p_t, m['title'], size=Pt(11), bold=True, color=_TEAL)
            else:
                p_t = doc.add_paragraph()
                r_n = p_t.add_run(f'M-{mi:02d}')
                r_n.font.bold = True; r_n.font.size = Pt(11); r_n.font.color.rgb = _TEAL
            if m['body']:
                p_b = doc.add_paragraph()
                add_runs(p_b, m['body'], size=Pt(10), color=_DARK)
            doc.add_paragraph()

    # ── Investigations ──────────────────────────────────────────────────────────────────────────
    inv = pkg.get('investigations') or {}
    inv_text  = (inv.get('text') or '').strip()
    inv_files = inv.get('files') or []
    if inv_text or inv_files:
        _section_heading(doc, 'INVESTIGACIONES')
        if inv_text:
            p = doc.add_paragraph()
            add_runs(p, inv_text, size=Pt(10), color=_DARK)
        if inv_files:
            p = doc.add_paragraph()
            r = p.add_run('Documentos adjuntos:')
            r.font.bold = True; r.font.size = Pt(10); r.font.color.rgb = _DARK
            for f in inv_files:
                p2 = doc.add_paragraph(style='List Bullet')
                add_runs(p2, f.get('name', 'documento'), size=Pt(10), color=_DARK)
        doc.add_paragraph()

    # ── Pre-process gaps for linking ────────────────────────────────────────────────
    raw_missing = pkg.get('gaps', {}).get('missingInfo', [])
    gap_items = []
    for i, g in enumerate(raw_missing):
        if isinstance(g, str):
            gap_items.append({'text': g, 'fid': None, 'bm': f'ppgap_{i}', 'neededExperiment': ''})
        else:
            gap_items.append({
                'text': g.get('text', ''),
                'fid': g.get('findingId'),
                'bm': f'ppgap_{i}',
                'neededExperiment': g.get('neededExperiment') or '',
            })

    gaps_for_finding: dict = {}
    for gi in gap_items:
        if gi['fid']:
            gaps_for_finding.setdefault(gi['fid'], []).append(gi)

    # ── Findings ─────────────────────────────────────────────────────────────────────────────
    findings = pkg.get('findings', [])
    if findings:
        _section_heading(doc, 'HALLAZGOS PRINCIPALES')
        for fi, finding in enumerate(findings, 1):
            fid = finding.get('id', '')
            # Finding header with bookmark
            p = doc.add_paragraph()
            bm_name = f'ppfinding_{fid}' if fid else f'ppfinding_{fi}'
            _bookmark_add(p, bm_name, fi * 100)
            r_prefix = p.add_run(f'▶  F-{fi:02d} — ')
            r_prefix.font.bold = True; r_prefix.font.size = Pt(11); r_prefix.font.color.rgb = _TEAL
            add_runs(p, finding.get("title", ""), size=Pt(11), bold=True, color=_TEAL)

            en_title = (finding.get('titleEnglish') or '').strip()
            if en_title:
                p2 = doc.add_paragraph()
                add_runs(p2, en_title, italic=True, size=Pt(9), color=_DIM)

            fdesc = (finding.get('description') or '').strip()
            if fdesc:
                p3 = doc.add_paragraph()
                add_runs(p3, fdesc, size=Pt(10), color=_DARK)

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
                    r_sep = p.add_run('  —  ')
                    r_sep.font.size = Pt(9); r_sep.font.color.rgb = _DIM
                    add_runs(p, desc_t, size=Pt(9), color=_DIM)

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

    # ── Gaps & Next Steps ─────────────────────────────────────────────────────────────────
    _section_heading(doc, 'GAPS & NEXT STEPS')

    if gap_items:
        p_h = doc.add_paragraph()
        r_h = p_h.add_run('Información faltante')
        r_h.font.bold = True; r_h.font.size = Pt(10); r_h.font.color.rgb = _DARK

        for gi in gap_items:
            # Bold "Missing: " + item text
            p = doc.add_paragraph()
            _bookmark_add(p, gi['bm'], abs(hash(gi['bm'])) % 90000 + 1000)
            r_miss = p.add_run('Missing: ')
            r_miss.font.bold = True; r_miss.font.size = Pt(10); r_miss.font.color.rgb = _DARK
            add_runs(p, gi['text'], size=Pt(10), color=_DARK)

            # Needed experiment (indented italic)
            needed_exp = (gi.get('neededExperiment') or '').strip()
            if needed_exp:
                p_ne = doc.add_paragraph()
                r_ne = p_ne.add_run('     → Needed: ')
                r_ne.font.size = Pt(9); r_ne.font.italic = True; r_ne.font.color.rgb = _DIM
                add_runs(p_ne, needed_exp, size=Pt(9), italic=True, color=_DIM)

            if gi['fid']:
                linked_f = next((f for f in findings if f.get('id') == gi['fid']), None)
                if linked_f:
                    fi_num = findings.index(linked_f) + 1
                    ann = doc.add_paragraph()
                    r_ann = ann.add_run(f'     → Vinculado a F-{fi_num:02d}: ')
                    r_ann.font.size = Pt(8); r_ann.font.italic = True; r_ann.font.color.rgb = _TEAL
                    add_runs(ann, linked_f.get("title", ""), size=Pt(8), italic=True, color=_TEAL)

    doc.add_paragraph()

    # ── Discussion ──────────────────────────────────────────────────────────────────────────
    disc = (pkg.get('discussion') or '').strip()
    if disc:
        _section_heading(doc, 'DISCUSIÓN')
        p = doc.add_paragraph()
        add_runs(p, disc, size=Pt(10), color=_DARK)
        doc.add_paragraph()

    # ── Acknowledgments ───────────────────────────────────────────────────────────────────────
    acknowledgments = (pkg.get('acknowledgments') or '').strip()
    if acknowledgments:
        _section_heading(doc, 'AGRADECIMIENTOS')
        p = doc.add_paragraph()
        add_runs(p, acknowledgments, size=Pt(10), color=_DARK)
        doc.add_paragraph()

    # ── Funding ────────────────────────────────────────────────────────────────────────────
    funding = (pkg.get('funding') or '').strip()
    if funding:
        _section_heading(doc, 'FINANCIACIÓN')
        p = doc.add_paragraph()
        add_runs(p, funding, size=Pt(10), color=_DARK)
        doc.add_paragraph()

    # ── Conflicts of Interest ───────────────────────────────────────────────────────────────
    conflicts = (pkg.get('conflictsOfInterest') or '').strip()
    if conflicts:
        _section_heading(doc, 'CONFLICTOS DE INTERÉS')
        p = doc.add_paragraph()
        add_runs(p, conflicts, size=Pt(10), color=_DARK)
        doc.add_paragraph()

    # ── References ───────────────────────────────────────────────────────────────────────────
    refs_raw = pkg.get('references')
    if isinstance(refs_raw, list):
        refs_list = [str(r).strip() for r in refs_raw if isinstance(r, str) and r.strip()]
    elif isinstance(refs_raw, str) and refs_raw.strip():
        refs_list = [refs_raw.strip()]
    else:
        refs_list = []
    if refs_list:
        _section_heading(doc, 'REFERENCIAS', collapsed=True)
        for i, ref in enumerate(refs_list, 1):
            header, abstract = _split_reference(ref)
            # Heading 3 gives collapse triangle in Word 2013+; w:collapsed hides body by default
            p = doc.add_paragraph(style='Heading 3')
            pPr = p._p.get_or_add_pPr()
            collapsed_el = OxmlElement('w:collapsed')
            collapsed_el.set(qn('w:val'), '1')
            pPr.append(collapsed_el)
            r_num = p.add_run(f'[{i}] ')
            r_num.font.size = Pt(10); r_num.font.bold = True; r_num.font.color.rgb = _TEAL
            # Render header with DOI as a clickable hyperlink
            add_runs_with_doi(p, header, size=Pt(10), color=_DARK)
            # Abstract as normal paragraph — hidden when heading is collapsed
            if abstract:
                p_abs = doc.add_paragraph()
                add_runs(p_abs, abstract, size=Pt(9), italic=True, color=_DIM)
            # Explicit spacer between references
            sep = doc.add_paragraph()
            sep.paragraph_format.space_after = Pt(8)

    # ── CReDiT ────────────────────────────────────────────────────────────────────────────────
    credit = (pkg.get('credit') or '').strip()
    if credit:
        _section_heading(doc, 'CONTRIBUCIÓN DE AUTORÍA (CReDiT)')
        p = doc.add_paragraph()
        add_runs(p, credit, size=Pt(10), color=_DARK)
        doc.add_paragraph()

    # ── Footer ──────────────────────────────────────────────────────────────────────────────
    p_ft = doc.add_paragraph()
    r_ft = p_ft.add_run(
        f'Documento generado automáticamente por PrionLab Tools · '
        f'v{version} · {send_date.strftime("%d %b %Y")}'
    )
    r_ft.font.size = Pt(8); r_ft.font.color.rgb = _DIM

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def generate_packages_list_docx(packages: list, gen_date: datetime) -> bytes:
    """Generate a compact Word catalogue listing all PrionPacks (id + title)."""
    doc = Document()
    sec = doc.sections[0]
    sec.top_margin = Cm(2.0); sec.bottom_margin = Cm(2.2)
    sec.left_margin = Cm(2.5); sec.right_margin = Cm(2.5)

    # Header
    hdr = sec.header
    hp = hdr.paragraphs[0] if hdr.paragraphs else hdr.add_paragraph()
    hp.clear(); hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    r_h = hp.add_run('PrionPacks · Lista general')
    r_h.font.bold = True; r_h.font.size = Pt(8); r_h.font.color.rgb = _TEAL
    r_hd = hp.add_run('  ·  ' + gen_date.strftime('%d/%m/%Y'))
    r_hd.font.size = Pt(8); r_hd.font.color.rgb = _DIM

    # Document title
    t = doc.add_paragraph()
    add_runs(t, 'Lista de PrionPacks', size=Pt(18), bold=True, color=_TEAL)
    sub = doc.add_paragraph()
    r_sub = sub.add_run(f'Generado el {gen_date.strftime("%d/%m/%Y %H:%M")}  ·  {len(packages)} paquetes')
    r_sub.font.size = Pt(9); r_sub.font.color.rgb = _DIM
    doc.add_paragraph()

    _section_heading(doc, 'PAQUETES DE INFORMACIÓN')

    for pkg in sorted(packages, key=lambda p: p.get('id', '')):
        p = doc.add_paragraph()
        r_id = p.add_run(pkg.get('id', '—') + '  ')
        r_id.font.bold = True; r_id.font.size = Pt(10); r_id.font.color.rgb = _TEAL
        add_runs(p, pkg.get('title', 'Sin título'), size=Pt(10), color=_DARK)
        # Optional: one-line description in dim italic
        desc = (pkg.get('description') or '').strip()
        if desc:
            short_desc = desc[:120] + ('…' if len(desc) > 120 else '')
            p_d = doc.add_paragraph()
            add_runs(p_d, short_desc, size=Pt(9), italic=True, color=_DIM)
            p_d.paragraph_format.left_indent = Cm(0.8)
        doc.add_paragraph().paragraph_format.space_after = Pt(2)

    # Footer
    p_ft = doc.add_paragraph()
    r_ft = p_ft.add_run(
        f'Lista generada automáticamente por PrionLab Tools · {gen_date.strftime("%d %b %Y")}'
    )
    r_ft.font.size = Pt(8); r_ft.font.color.rgb = _DIM

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _section_heading(doc: Document, text: str, collapsed: bool = False):
    # Use Heading 2 so Word knows where each section boundary is.
    # Font properties are overridden to preserve the teal/10 pt look.
    p = doc.add_paragraph(style='Heading 2')
    pPr = p._p.get_or_add_pPr()
    if collapsed:
        collapsed_el = OxmlElement('w:collapsed')
        collapsed_el.set(qn('w:val'), '1')
        pPr.append(collapsed_el)
    run = p.add_run(text)
    run.font.bold      = True
    run.font.size      = Pt(10)
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
        r_sep = p_cap.add_run('  ')
        r_sep.font.size = Pt(9); r_sep.font.color.rgb = _DIM
        add_runs(p_cap, caption, size=Pt(9), color=_DIM)


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
