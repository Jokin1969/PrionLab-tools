"""
CVN FECYT XML export/import.
Schema version 1.4.3 — simplified subset covering the sections most relevant
to PrionLab researchers (identification + scientific production).
Full CVN schema: https://cvn.fecyt.es/documentacion/schema
"""
import logging
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

_NS = "http://www.fecyt.es/cvn/1.4.3"
_SCHEMA_VERSION = "1.4.3"


# ── Helpers ──────────────────────────────────────────────────────────────────

def _sub(parent: ET.Element, tag: str, text: str = "", **attribs) -> ET.Element:
    el = ET.SubElement(parent, tag, attribs)
    if text:
        el.text = text
    return el


def _item(parent: ET.Element, code: str, value: str, lang: str = "spa") -> None:
    item_el = _sub(parent, "CvnItem")
    _sub(item_el, "Code", code)
    _sub(item_el, "Value", value)
    _sub(item_el, "Lang", lang)


# ── Export ────────────────────────────────────────────────────────────────────

def export_cvn_xml(username: str) -> str:
    """
    Generate a CVN XML string for *username*.
    Returns UTF-8 encoded XML.
    """
    from database.config import db
    from database.models import User, Publication

    with db.get_session() as s:
        user = s.query(User).filter_by(username=username).first()
        if not user:
            raise ValueError(f"User '{username}' not found")

        pubs = (
            s.query(Publication)
            .filter(
                Publication.created_by_id == user.id,
                Publication.is_lab_publication.is_(True),
            )
            .order_by(Publication.year.desc())
            .all()
        )

        root = ET.Element("cvnRootBean")
        root.set("xmlns", _NS)
        root.set("version", _SCHEMA_VERSION)

        # ── Metadata ──────────────────────────────────────────────────────
        meta = _sub(root, "CvnHeader")
        _sub(meta, "GenerationDate", datetime.now(timezone.utc).isoformat())
        _sub(meta, "Version", _SCHEMA_VERSION)

        # ── Section 010 — Personal identification ─────────────────────────
        s010 = _sub(root, "CvnSection", code="010")
        _item(s010, "010.010.000.010", user.first_name)
        _item(s010, "010.010.000.020", user.last_name or "")
        if user.email:
            _item(s010, "010.010.000.230", user.email)
        if user.orcid:
            _item(s010, "010.010.000.100", user.orcid)
        if user.affiliation:
            _item(s010, "010.010.000.200", user.affiliation)
        if user.position:
            _item(s010, "010.020.000.010", user.position)

        # ── Section 060 — Scientific Production ──────────────────────────
        s060 = _sub(root, "CvnSection", code="060")
        for pub in pubs:
            pub_el = _sub(s060, "CvnItem", type="060.010.010.000")
            _item(pub_el, "060.010.010.030", pub.title)
            _item(pub_el, "060.010.010.100", pub.authors)
            _item(pub_el, "060.010.010.210", pub.journal)
            _item(pub_el, "060.010.010.300", str(pub.year))
            if pub.volume:
                _item(pub_el, "060.010.010.310", pub.volume)
            if pub.issue:
                _item(pub_el, "060.010.010.320", pub.issue)
            if pub.pages:
                _item(pub_el, "060.010.010.350", pub.pages)
            if pub.doi:
                _item(pub_el, "060.010.010.400", pub.doi)
            if pub.pmid:
                _item(pub_el, "060.010.010.410", pub.pmid)
            if pub.impact_factor is not None:
                _item(pub_el, "060.010.010.140", str(pub.impact_factor))
            if pub.citation_count:
                _item(pub_el, "060.010.010.190", str(pub.citation_count))

        xml_bytes = ET.tostring(root, encoding="unicode", method="xml")
        return '<?xml version="1.0" encoding="UTF-8"?>\n' + xml_bytes


# ── Import ────────────────────────────────────────────────────────────────────

def _find_item(section: ET.Element, code: str) -> Optional[str]:
    """Return first matching CvnItem value for a given code."""
    ns = {"cvn": _NS}
    for item in section.iter("CvnItem"):
        code_el = item.find("Code")
        val_el = item.find("Value")
        if code_el is not None and code_el.text == code and val_el is not None:
            return val_el.text
    return None


def import_cvn_xml(username: str, xml_string: str) -> Dict:
    """
    Parse a CVN XML string and merge publications into the database.
    Returns a summary dict.
    """
    from database.config import db
    from database.models import User, Publication

    try:
        # Strip namespace for simpler parsing
        xml_string = xml_string.replace(f' xmlns="{_NS}"', "")
        root = ET.fromstring(xml_string)
    except ET.ParseError as exc:
        return {"success": False, "error": f"XML parse error: {exc}"}

    with db.get_session() as s:
        user = s.query(User).filter_by(username=username).first()
        if not user:
            return {"success": False, "error": f"User '{username}' not found"}

        imported = 0
        skipped = 0
        errors: List[str] = []

        for section in root.iter("CvnSection"):
            if section.get("code") != "060":
                continue
            for pub_el in section.findall("CvnItem"):
                try:
                    title = _find_item(pub_el, "060.010.010.030") or ""
                    if not title:
                        skipped += 1
                        continue
                    doi = _find_item(pub_el, "060.010.010.400")
                    # Deduplicate by DOI or title
                    existing = None
                    if doi:
                        existing = s.query(Publication).filter_by(doi=doi).first()
                    if not existing:
                        existing = s.query(Publication).filter_by(title=title).first()
                    if existing:
                        skipped += 1
                        continue

                    year_str = _find_item(pub_el, "060.010.010.300")
                    try:
                        year = int(year_str) if year_str else 2000
                    except ValueError:
                        year = 2000

                    if_str = _find_item(pub_el, "060.010.010.140")
                    try:
                        impact_factor = float(if_str) if if_str else None
                    except ValueError:
                        impact_factor = None

                    cite_str = _find_item(pub_el, "060.010.010.190")
                    try:
                        citations = int(cite_str) if cite_str else 0
                    except ValueError:
                        citations = 0

                    pub = Publication(
                        title=title,
                        authors=_find_item(pub_el, "060.010.010.100") or "",
                        journal=_find_item(pub_el, "060.010.010.210") or "",
                        year=year,
                        volume=_find_item(pub_el, "060.010.010.310"),
                        issue=_find_item(pub_el, "060.010.010.320"),
                        pages=_find_item(pub_el, "060.010.010.350"),
                        doi=doi,
                        pmid=_find_item(pub_el, "060.010.010.410"),
                        impact_factor=impact_factor,
                        citation_count=citations,
                        is_lab_publication=True,
                        created_by_id=user.id,
                    )
                    s.add(pub)
                    imported += 1
                except Exception as exc:
                    errors.append(str(exc))

        return {
            "success": True,
            "imported": imported,
            "skipped": skipped,
            "errors": errors[:10],
        }
