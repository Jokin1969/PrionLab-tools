import logging
import os
import re
import unicodedata

import pandas as pd
import requests as http_requests
from flask import flash, jsonify, redirect, render_template, request, send_file, session, url_for
from flask_babel import gettext as _

import config
from core.decorators import admin_required, editor_required, login_required
from . import manuscriptforge_bp
from .models import (
    add_member_affiliation, count_affiliation_members, create_affiliation,
    create_member, delete_affiliation, delete_member, get_affiliation,
    get_affiliation_members, get_member, get_member_affiliations,
    load_affiliations, load_members, move_member_affiliation,
    remove_member_affiliation, update_affiliation, update_member,
    # Grants
    add_grant_member, create_grant, delete_grant, get_grant,
    get_grant_members, get_member_grants, load_grants,
    remove_grant_member, update_grant,
    # Publications
    create_publication, delete_publication, get_publication,
    load_publications, update_publication,
    # Ack blocks
    create_ack_block, delete_ack_block, get_ack_block,
    load_ack_blocks, toggle_ack_block, update_ack_block,
    # Generation
    generate_author_order,
)
from .validators import (
    validate_affiliation, validate_ack_block, validate_grant,
    validate_member, validate_publication,
)

logger = logging.getLogger(__name__)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _member_form_data(form) -> dict:
    return {
        "first_name":               form.get("first_name", "").strip(),
        "last_name":                form.get("last_name", "").strip(),
        "display_name":             form.get("display_name", "").strip(),
        "email":                    form.get("email", "").strip(),
        "orcid":                    form.get("orcid", "").strip(),
        "dni":                      form.get("dni", "").strip(),
        "is_corresponding_default": "true" if form.get("is_corresponding_default") else "false",
        "status":                   form.get("status", "active"),
        "current_position":         form.get("current_position", "").strip(),
        "joined_date":              form.get("joined_date", "").strip(),
        "left_date":                form.get("left_date", "").strip(),
        "short_bio":                form.get("short_bio", "").strip(),
        "long_bio":                 form.get("long_bio", "").strip(),
        "expertise_areas":          form.get("expertise_areas", "").strip(),
        "has_competing_interests":  "true" if form.get("has_competing_interests") else "false",
        "competing_interests_text": form.get("competing_interests_text", "").strip(),
        "linked_username":          form.get("linked_username", "").strip(),
        "notes":                    form.get("notes", "").strip(),
    }


def _affiliation_form_data(form) -> dict:
    return {
        "short_name":   form.get("short_name", "").strip(),
        "full_name":    form.get("full_name", "").strip(),
        "department":   form.get("department", "").strip(),
        "address_line": form.get("address_line", "").strip(),
        "postal_code":  form.get("postal_code", "").strip(),
        "city":         form.get("city", "").strip(),
        "region":       form.get("region", "").strip(),
        "country":      form.get("country", "").strip(),
        "country_code": form.get("country_code", "").strip().upper(),
        "notes":        form.get("notes", "").strip(),
    }


def _is_editor_or_admin() -> bool:
    return session.get("role") in ("admin", "editor")


def _is_admin() -> bool:
    return session.get("role") == "admin"


def _strip_sensitive(member: dict) -> dict:
    """Remove fields readers must not see."""
    for field in ("dni", "notes"):
        member.pop(field, None)
    return member


# ── Home ──────────────────────────────────────────────────────────────────────

@manuscriptforge_bp.route("/")
@login_required
def home():
    return render_template(
        "manuscriptforge/home.html",
        member_count=len(load_members()),
        affiliation_count=len(load_affiliations()),
        grant_count=len(load_grants()),
        publication_count=len(load_publications()),
        ack_count=int((load_ack_blocks()["is_active"] == "true").sum()),
    )


# ── Members — list ────────────────────────────────────────────────────────────

@manuscriptforge_bp.route("/members")
@login_required
def members_list():
    df = load_members()
    status_filter = request.args.get("status", "active")
    search = request.args.get("q", "").strip().lower()

    if status_filter and status_filter != "all":
        df = df[df["status"] == status_filter]

    if search:
        mask = (
            df["first_name"].str.lower().str.contains(search, na=False)
            | df["last_name"].str.lower().str.contains(search, na=False)
            | df["display_name"].str.lower().str.contains(search, na=False)
            | df["email"].str.lower().str.contains(search, na=False)
        )
        df = df[mask]

    members = df.to_dict("records")
    if not _is_editor_or_admin():
        for m in members:
            _strip_sensitive(m)

    return render_template(
        "manuscriptforge/members_list.html",
        members=members,
        status_filter=status_filter,
        search=search,
    )


# ── Members — detail ──────────────────────────────────────────────────────────

@manuscriptforge_bp.route("/members/<member_id>")
@login_required
def member_detail(member_id):
    member = get_member(member_id)
    if not member:
        flash(_("Member not found."), "error")
        return redirect(url_for("manuscriptforge.members_list"))

    if not _is_editor_or_admin():
        _strip_sensitive(member)

    affiliations = get_member_affiliations(member_id)

    available_affs = []
    if _is_editor_or_admin():
        assigned = {a["affiliation_id"] for a in affiliations}
        available_affs = [
            a for a in load_affiliations().to_dict("records")
            if a["affiliation_id"] not in assigned
        ]

    grants = get_member_grants(member_id)
    available_grants = []
    if _is_editor_or_admin():
        linked_gids = {g["grant_id"] for g in grants}
        available_grants = [
            g for g in load_grants().to_dict("records")
            if g["grant_id"] not in linked_gids
        ]

    return render_template(
        "manuscriptforge/member_detail.html",
        member=member,
        affiliations=affiliations,
        available_affs=available_affs,
        grants=grants,
        available_grants=available_grants,
    )


# ── Members — create ──────────────────────────────────────────────────────────

@manuscriptforge_bp.route("/members/new", methods=["GET", "POST"])
@editor_required
def new_member():
    if request.method == "POST":
        data = _member_form_data(request.form)
        from core.users import load_users
        usernames = [u["username"] for u in load_users()]
        errors = validate_member(data, usernames)
        if errors:
            for e in errors:
                flash(e, "error")
            return render_template("manuscriptforge/member_form.html", mode="add", form=request.form)
        create_member(data)
        flash(_("Member created successfully."), "success")
        return redirect(url_for("manuscriptforge.members_list"))
    return render_template("manuscriptforge/member_form.html", mode="add", form={})


# ── Members — edit ────────────────────────────────────────────────────────────

@manuscriptforge_bp.route("/members/<member_id>/edit", methods=["GET", "POST"])
@editor_required
def edit_member(member_id):
    member = get_member(member_id)
    if not member:
        flash(_("Member not found."), "error")
        return redirect(url_for("manuscriptforge.members_list"))

    if request.method == "POST":
        data = _member_form_data(request.form)
        from core.users import load_users
        usernames = [u["username"] for u in load_users()]
        errors = validate_member(data, usernames)
        if errors:
            for e in errors:
                flash(e, "error")
            return render_template(
                "manuscriptforge/member_form.html", mode="edit", member=member, form=request.form
            )
        update_member(member_id, data)
        flash(_("Member updated successfully."), "success")
        return redirect(url_for("manuscriptforge.member_detail", member_id=member_id))

    return render_template("manuscriptforge/member_form.html", mode="edit", member=member, form=member)


# ── Members — delete ──────────────────────────────────────────────────────────

@manuscriptforge_bp.route("/members/<member_id>/delete", methods=["POST"])
@admin_required
def delete_member_route(member_id):
    if delete_member(member_id):
        flash(_("Member deleted successfully."), "success")
    else:
        flash(_("Member not found."), "error")
    return redirect(url_for("manuscriptforge.members_list"))


# ── Members — affiliation management ─────────────────────────────────────────

@manuscriptforge_bp.route("/members/<member_id>/affiliations/add", methods=["POST"])
@editor_required
def add_affiliation_to_member(member_id):
    aff_id = request.form.get("affiliation_id", "")
    if not aff_id:
        flash(_("Please select an affiliation."), "error")
    else:
        ok, msg = add_member_affiliation(member_id, aff_id)
        flash(_("Affiliation added.") if ok else msg, "success" if ok else "error")
    return redirect(url_for("manuscriptforge.member_detail", member_id=member_id))


@manuscriptforge_bp.route("/members/<member_id>/affiliations/<affiliation_id>/remove", methods=["POST"])
@editor_required
def remove_affiliation_from_member(member_id, affiliation_id):
    remove_member_affiliation(member_id, affiliation_id)
    flash(_("Affiliation removed."), "success")
    return redirect(url_for("manuscriptforge.member_detail", member_id=member_id))


@manuscriptforge_bp.route("/members/<member_id>/affiliations/<affiliation_id>/up", methods=["POST"])
@editor_required
def affiliation_priority_up(member_id, affiliation_id):
    move_member_affiliation(member_id, affiliation_id, "up")
    return redirect(url_for("manuscriptforge.member_detail", member_id=member_id))


@manuscriptforge_bp.route("/members/<member_id>/affiliations/<affiliation_id>/down", methods=["POST"])
@editor_required
def affiliation_priority_down(member_id, affiliation_id):
    move_member_affiliation(member_id, affiliation_id, "down")
    return redirect(url_for("manuscriptforge.member_detail", member_id=member_id))


# ── Affiliations — list ───────────────────────────────────────────────────────

@manuscriptforge_bp.route("/affiliations")
@login_required
def affiliations_list():
    df = load_affiliations()
    search = request.args.get("q", "").strip().lower()
    if search:
        mask = (
            df["short_name"].str.lower().str.contains(search, na=False)
            | df["full_name"].str.lower().str.contains(search, na=False)
            | df["city"].str.lower().str.contains(search, na=False)
        )
        df = df[mask]
    affiliations = df.to_dict("records")
    for a in affiliations:
        a["member_count"] = count_affiliation_members(a["affiliation_id"])
    return render_template("manuscriptforge/affiliations_list.html", affiliations=affiliations, search=search)


# ── Affiliations — detail ─────────────────────────────────────────────────────

@manuscriptforge_bp.route("/affiliations/<affiliation_id>")
@login_required
def affiliation_detail(affiliation_id):
    aff = get_affiliation(affiliation_id)
    if not aff:
        flash(_("Affiliation not found."), "error")
        return redirect(url_for("manuscriptforge.affiliations_list"))
    members = get_affiliation_members(affiliation_id)
    if not _is_editor_or_admin():
        for m in members:
            _strip_sensitive(m)
    return render_template("manuscriptforge/affiliation_detail.html", affiliation=aff, members=members)


# ── Affiliations — create ─────────────────────────────────────────────────────

@manuscriptforge_bp.route("/affiliations/new", methods=["GET", "POST"])
@editor_required
def new_affiliation():
    if request.method == "POST":
        data = _affiliation_form_data(request.form)
        errors = validate_affiliation(data)
        if errors:
            for e in errors:
                flash(e, "error")
            return render_template("manuscriptforge/affiliation_form.html", mode="add", form=request.form)
        create_affiliation(data)
        flash(_("Affiliation created successfully."), "success")
        return redirect(url_for("manuscriptforge.affiliations_list"))
    return render_template("manuscriptforge/affiliation_form.html", mode="add", form={})


# ── Affiliations — edit ───────────────────────────────────────────────────────

@manuscriptforge_bp.route("/affiliations/<affiliation_id>/edit", methods=["GET", "POST"])
@editor_required
def edit_affiliation(affiliation_id):
    aff = get_affiliation(affiliation_id)
    if not aff:
        flash(_("Affiliation not found."), "error")
        return redirect(url_for("manuscriptforge.affiliations_list"))

    if request.method == "POST":
        data = _affiliation_form_data(request.form)
        errors = validate_affiliation(data)
        if errors:
            for e in errors:
                flash(e, "error")
            return render_template(
                "manuscriptforge/affiliation_form.html", mode="edit", affiliation=aff, form=request.form
            )
        update_affiliation(affiliation_id, data)
        flash(_("Affiliation updated successfully."), "success")
        return redirect(url_for("manuscriptforge.affiliation_detail", affiliation_id=affiliation_id))

    return render_template(
        "manuscriptforge/affiliation_form.html", mode="edit", affiliation=aff, form=aff
    )


# ── Affiliations — delete ─────────────────────────────────────────────────────

@manuscriptforge_bp.route("/affiliations/<affiliation_id>/delete", methods=["POST"])
@admin_required
def delete_affiliation_route(affiliation_id):
    ok, msg = delete_affiliation(affiliation_id)
    if ok:
        flash(_("Affiliation deleted successfully."), "success")
        return redirect(url_for("manuscriptforge.affiliations_list"))
    flash(msg, "error")
    return redirect(url_for("manuscriptforge.affiliation_detail", affiliation_id=affiliation_id))


# ── Grants — helpers ──────────────────────────────────────────────────────────

def _grant_form_data(form) -> dict:
    return {
        "code":                   form.get("code", "").strip(),
        "title":                  form.get("title", "").strip(),
        "funding_agency":         form.get("funding_agency", "").strip(),
        "funding_program":        form.get("funding_program", "").strip(),
        "principal_investigator": form.get("principal_investigator", "").strip(),
        "start_date":             form.get("start_date", "").strip(),
        "end_date":               form.get("end_date", "").strip(),
        "amount_eur":             form.get("amount_eur", "").strip(),
        "status":                 form.get("status", "active"),
        "acknowledgment_text":    form.get("acknowledgment_text", "").strip(),
        "notes":                  form.get("notes", "").strip(),
    }


# ── Grants — list ─────────────────────────────────────────────────────────────

@manuscriptforge_bp.route("/grants")
@login_required
def grants_list():
    df = load_grants()
    status_filter = request.args.get("status", "active")
    search = request.args.get("q", "").strip().lower()

    if status_filter and status_filter != "all":
        df = df[df["status"] == status_filter]
    if search:
        mask = (
            df["code"].str.lower().str.contains(search, na=False)
            | df["title"].str.lower().str.contains(search, na=False)
            | df["funding_agency"].str.lower().str.contains(search, na=False)
            | df["principal_investigator"].str.lower().str.contains(search, na=False)
        )
        df = df[mask]

    return render_template(
        "manuscriptforge/grants_list.html",
        grants=df.to_dict("records"),
        status_filter=status_filter,
        search=search,
    )


# ── Grants — detail ───────────────────────────────────────────────────────────

@manuscriptforge_bp.route("/grants/<grant_id>")
@login_required
def grant_detail(grant_id):
    grant = get_grant(grant_id)
    if not grant:
        flash(_("Grant not found."), "error")
        return redirect(url_for("manuscriptforge.grants_list"))
    members = get_grant_members(grant_id)
    available_members = []
    if _is_editor_or_admin():
        linked_ids = {m["member_id"] for m in members}
        available_members = [
            m for m in load_members().to_dict("records")
            if m["member_id"] not in linked_ids
        ]
    return render_template(
        "manuscriptforge/grant_detail.html",
        grant=grant,
        members=members,
        available_members=available_members,
    )


# ── Grants — create ───────────────────────────────────────────────────────────

@manuscriptforge_bp.route("/grants/new", methods=["GET", "POST"])
@editor_required
def new_grant():
    if request.method == "POST":
        data = _grant_form_data(request.form)
        errors = validate_grant(data)
        if errors:
            for e in errors:
                flash(e, "error")
            return render_template("manuscriptforge/grant_form.html", mode="add", form=request.form)
        create_grant(data)
        flash(_("Grant created successfully."), "success")
        return redirect(url_for("manuscriptforge.grants_list"))
    return render_template("manuscriptforge/grant_form.html", mode="add", form={})


# ── Grants — edit ─────────────────────────────────────────────────────────────

@manuscriptforge_bp.route("/grants/<grant_id>/edit", methods=["GET", "POST"])
@editor_required
def edit_grant(grant_id):
    grant = get_grant(grant_id)
    if not grant:
        flash(_("Grant not found."), "error")
        return redirect(url_for("manuscriptforge.grants_list"))
    if request.method == "POST":
        data = _grant_form_data(request.form)
        errors = validate_grant(data)
        if errors:
            for e in errors:
                flash(e, "error")
            return render_template(
                "manuscriptforge/grant_form.html", mode="edit", grant=grant, form=request.form
            )
        update_grant(grant_id, data)
        flash(_("Grant updated successfully."), "success")
        return redirect(url_for("manuscriptforge.grant_detail", grant_id=grant_id))
    return render_template("manuscriptforge/grant_form.html", mode="edit", grant=grant, form=grant)


# ── Grants — delete ───────────────────────────────────────────────────────────

@manuscriptforge_bp.route("/grants/<grant_id>/delete", methods=["POST"])
@admin_required
def delete_grant_route(grant_id):
    if delete_grant(grant_id):
        flash(_("Grant deleted successfully."), "success")
    else:
        flash(_("Grant not found."), "error")
    return redirect(url_for("manuscriptforge.grants_list"))


# ── Grants — member management ────────────────────────────────────────────────

@manuscriptforge_bp.route("/grants/<grant_id>/members/add", methods=["POST"])
@editor_required
def add_member_to_grant(grant_id):
    member_id = request.form.get("member_id", "")
    role = request.form.get("role", "").strip()
    if not member_id:
        flash(_("Please select a member."), "error")
    else:
        ok, msg = add_grant_member(grant_id, member_id, role)
        flash(_("Member added to grant.") if ok else msg, "success" if ok else "error")
    return redirect(url_for("manuscriptforge.grant_detail", grant_id=grant_id))


@manuscriptforge_bp.route("/grants/<grant_id>/members/<member_id>/remove", methods=["POST"])
@editor_required
def remove_member_from_grant(grant_id, member_id):
    remove_grant_member(grant_id, member_id)
    flash(_("Member removed from grant."), "success")
    return redirect(url_for("manuscriptforge.grant_detail", grant_id=grant_id))


# ── Publications — helpers ────────────────────────────────────────────────────

def _pub_form_data(form) -> dict:
    return {
        "doi":          form.get("doi", "").strip(),
        "title":        form.get("title", "").strip(),
        "authors_raw":  form.get("authors_raw", "").strip(),
        "journal":      form.get("journal", "").strip(),
        "year":         form.get("year", "").strip(),
        "volume":       form.get("volume", "").strip(),
        "issue":        form.get("issue", "").strip(),
        "pages":        form.get("pages", "").strip(),
        "pmid":         form.get("pmid", "").strip(),
        "pub_type":     form.get("pub_type", "article"),
        "is_group_pub": "true" if form.get("is_group_pub") else "false",
        "notes":        form.get("notes", "").strip(),
    }


def _pdf_slug(text: str, max_chars: int = 50) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "_", text)
    return text.strip("_")[:max_chars].rstrip("_")


def _handle_pdf_upload(pub_id: str, old_pdf_path: str = "") -> str:
    """Process uploaded PDF. Returns new pdf_path or empty string."""
    f = request.files.get("pdf_file")
    if not f or not f.filename:
        return old_pdf_path

    if not f.filename.lower().endswith(".pdf"):
        flash(_("Only PDF files are accepted."), "error")
        return old_pdf_path

    data = f.read()
    if not data[:4] == b"%PDF":
        flash(_("File does not appear to be a valid PDF."), "error")
        return old_pdf_path

    max_bytes = config.MAX_PDF_SIZE_MB * 1024 * 1024
    if len(data) > max_bytes:
        flash(_("PDF exceeds maximum size (%(mb)d MB).", mb=config.MAX_PDF_SIZE_MB), "error")
        return old_pdf_path

    # Delete old PDF if replacing
    if old_pdf_path:
        _delete_pdf(old_pdf_path)

    # Build filename
    from .models import get_publication
    pub = get_publication(pub_id)
    title_slug = _pdf_slug(pub.get("title", pub_id) if pub else pub_id)
    filename = f"{pub_id}_{title_slug}.pdf"
    relative_path = f"papers/{filename}"

    # Save locally
    local_path = os.path.join(config.PAPERS_DIR, filename)
    os.makedirs(config.PAPERS_DIR, exist_ok=True)
    with open(local_path, "wb") as fp:
        fp.write(data)

    # Push to Dropbox
    try:
        from core.dropbox_client import get_client
        from config import DROPBOX_PAPERS_FOLDER
        client = get_client()
        if client:
            import dropbox as dbx_module
            client.files_upload(
                data,
                f"{DROPBOX_PAPERS_FOLDER}/{filename}",
                mode=dbx_module.files.WriteMode("overwrite"),
            )
    except Exception as e:
        logger.warning("PDF Dropbox push failed: %s", e)

    return relative_path


def _delete_pdf(pdf_path: str) -> None:
    if not pdf_path:
        return
    filename = os.path.basename(pdf_path)
    local_path = os.path.join(config.PAPERS_DIR, filename)
    if os.path.exists(local_path):
        try:
            os.remove(local_path)
        except Exception as e:
            logger.warning("Could not delete local PDF %s: %s", local_path, e)
    try:
        from core.dropbox_client import get_client
        from config import DROPBOX_PAPERS_FOLDER
        client = get_client()
        if client:
            client.files_delete_v2(f"{DROPBOX_PAPERS_FOLDER}/{filename}")
    except Exception as e:
        logger.debug("Could not delete Dropbox PDF %s: %s", filename, e)


# ── Publications — DOI lookup ─────────────────────────────────────────────────

@manuscriptforge_bp.route("/publications/doi-lookup")
@editor_required
def doi_lookup():
    doi = request.args.get("doi", "").strip()
    if not doi:
        return jsonify({"status": "error", "message": "No DOI provided"}), 400
    try:
        contact = config.CONTACT_EMAIL or "info@example.com"
        resp = http_requests.get(
            f"https://api.crossref.org/works/{doi}",
            headers={"User-Agent": f"PrionLab-tools/1.0 (mailto:{contact})"},
            timeout=10,
        )
        if resp.status_code == 404:
            return jsonify({"status": "not_found"}), 404
        resp.raise_for_status()
        msg = resp.json()["message"]

        type_map = {
            "journal-article":    "article",
            "book-chapter":       "book_chapter",
            "proceedings-article":"conference",
        }
        pub_type = type_map.get(msg.get("type", ""), "other")

        year = None
        for dk in ["published", "published-print", "published-online"]:
            parts = msg.get(dk, {}).get("date-parts", [[]])
            if parts and parts[0]:
                year = parts[0][0]
                break

        authors = []
        for a in msg.get("author", []):
            name = f"{a.get('given', '')} {a.get('family', '')}".strip()
            if name:
                authors.append(name)

        return jsonify({
            "status":      "ok",
            "title":       (msg.get("title") or [""])[0],
            "authors_raw": ", ".join(authors),
            "journal":     (msg.get("container-title") or [""])[0],
            "year":        str(year) if year else "",
            "volume":      msg.get("volume", ""),
            "issue":       msg.get("issue", ""),
            "pages":       msg.get("page", ""),
            "pub_type":    pub_type,
        })
    except http_requests.exceptions.Timeout:
        return jsonify({"status": "timeout"}), 504
    except http_requests.exceptions.ConnectionError:
        return jsonify({"status": "network_error"}), 503
    except Exception as e:
        logger.error("CrossRef lookup error for DOI %s: %s", doi, e)
        return jsonify({"status": "error"}), 500


# ── Publications — list ───────────────────────────────────────────────────────

@manuscriptforge_bp.route("/publications")
@login_required
def publications_list():
    df = load_publications()
    group_filter = request.args.get("group", "true")
    pub_type_filter = request.args.get("pub_type", "")
    year_min = request.args.get("year_min", "").strip()
    year_max = request.args.get("year_max", "").strip()
    search = request.args.get("q", "").strip().lower()

    if group_filter == "true":
        df = df[df["is_group_pub"] == "true"]
    if pub_type_filter:
        df = df[df["pub_type"] == pub_type_filter]
    if year_min:
        try:
            df = df[pd.to_numeric(df["year"], errors="coerce") >= int(year_min)]
        except ValueError:
            pass
    if year_max:
        try:
            df = df[pd.to_numeric(df["year"], errors="coerce") <= int(year_max)]
        except ValueError:
            pass
    if search:
        mask = (
            df["title"].str.lower().str.contains(search, na=False)
            | df["authors_raw"].str.lower().str.contains(search, na=False)
            | df["journal"].str.lower().str.contains(search, na=False)
        )
        df = df[mask]

    df = df.copy()
    df["year_num"] = pd.to_numeric(df["year"], errors="coerce").fillna(0).astype(int)
    df = df.sort_values("year_num", ascending=False)

    return render_template(
        "manuscriptforge/publications_list.html",
        publications=df.to_dict("records"),
        group_filter=group_filter,
        pub_type_filter=pub_type_filter,
        year_min=year_min,
        year_max=year_max,
        search=search,
    )


# ── Publications — detail ─────────────────────────────────────────────────────

@manuscriptforge_bp.route("/publications/<pub_id>")
@login_required
def publication_detail(pub_id):
    pub = get_publication(pub_id)
    if not pub:
        flash(_("Publication not found."), "error")
        return redirect(url_for("manuscriptforge.publications_list"))
    return render_template("manuscriptforge/publication_detail.html", pub=pub)


# ── Publications — create ─────────────────────────────────────────────────────

@manuscriptforge_bp.route("/publications/new", methods=["GET", "POST"])
@editor_required
def new_publication():
    if request.method == "POST":
        data = _pub_form_data(request.form)
        errors = validate_publication(data)
        if errors:
            for e in errors:
                flash(e, "error")
            return render_template("manuscriptforge/publication_form.html", mode="add", form=request.form)
        pub = create_publication(data)
        # Handle PDF after pub_id is assigned
        pdf_path = _handle_pdf_upload(pub["pub_id"])
        if pdf_path != data.get("pdf_path", ""):
            update_publication(pub["pub_id"], {"pdf_path": pdf_path})
        flash(_("Publication created successfully."), "success")
        return redirect(url_for("manuscriptforge.publications_list"))
    return render_template("manuscriptforge/publication_form.html", mode="add", form={})


# ── Publications — edit ───────────────────────────────────────────────────────

@manuscriptforge_bp.route("/publications/<pub_id>/edit", methods=["GET", "POST"])
@editor_required
def edit_publication(pub_id):
    pub = get_publication(pub_id)
    if not pub:
        flash(_("Publication not found."), "error")
        return redirect(url_for("manuscriptforge.publications_list"))
    if request.method == "POST":
        data = _pub_form_data(request.form)
        errors = validate_publication(data)
        if errors:
            for e in errors:
                flash(e, "error")
            return render_template(
                "manuscriptforge/publication_form.html", mode="edit", pub=pub, form=request.form
            )
        pdf_path = _handle_pdf_upload(pub_id, pub.get("pdf_path", ""))
        data["pdf_path"] = pdf_path
        update_publication(pub_id, data)
        flash(_("Publication updated successfully."), "success")
        return redirect(url_for("manuscriptforge.publication_detail", pub_id=pub_id))
    return render_template("manuscriptforge/publication_form.html", mode="edit", pub=pub, form=pub)


# ── Publications — delete ─────────────────────────────────────────────────────

@manuscriptforge_bp.route("/publications/<pub_id>/delete", methods=["POST"])
@admin_required
def delete_publication_route(pub_id):
    ok, pdf_path = delete_publication(pub_id)
    if ok:
        if pdf_path:
            _delete_pdf(pdf_path)
        flash(_("Publication deleted successfully."), "success")
    else:
        flash(_("Publication not found."), "error")
    return redirect(url_for("manuscriptforge.publications_list"))


# ── Publications — PDF download ───────────────────────────────────────────────

@manuscriptforge_bp.route("/publications/<pub_id>/pdf")
@login_required
def download_pdf(pub_id):
    pub = get_publication(pub_id)
    if not pub or not pub.get("pdf_path"):
        flash(_("No PDF available for this publication."), "error")
        return redirect(url_for("manuscriptforge.publication_detail", pub_id=pub_id))

    filename = os.path.basename(pub["pdf_path"])
    local_path = os.path.join(config.PAPERS_DIR, filename)
    if os.path.exists(local_path):
        return send_file(local_path, as_attachment=True, download_name=filename)

    # Fallback: Dropbox temporary link
    try:
        from core.dropbox_client import get_client
        from config import DROPBOX_PAPERS_FOLDER
        client = get_client()
        if client:
            link = client.files_get_temporary_link(f"{DROPBOX_PAPERS_FOLDER}/{filename}")
            return redirect(link.link)
    except Exception as e:
        logger.warning("Could not get Dropbox temporary link for %s: %s", filename, e)

    flash(_("PDF file not found."), "error")
    return redirect(url_for("manuscriptforge.publication_detail", pub_id=pub_id))


# ── Acknowledgment Blocks — list ──────────────────────────────────────────────

@manuscriptforge_bp.route("/acks")
@login_required
def acks_list():
    df = load_ack_blocks()
    cat_filter = request.args.get("category", "")
    if cat_filter:
        df = df[df["category"] == cat_filter]
    blocks = df.to_dict("records")

    # Group by category preserving order
    from collections import OrderedDict
    grouped: dict[str, list] = OrderedDict()
    for b in blocks:
        cat = b["category"]
        grouped.setdefault(cat, []).append(b)

    return render_template(
        "manuscriptforge/acks_list.html",
        grouped=grouped,
        cat_filter=cat_filter,
    )


# ── Acknowledgment Blocks — detail ────────────────────────────────────────────

@manuscriptforge_bp.route("/acks/<block_id>")
@login_required
def ack_detail(block_id):
    block = get_ack_block(block_id)
    if not block:
        flash(_("Block not found."), "error")
        return redirect(url_for("manuscriptforge.acks_list"))
    return render_template("manuscriptforge/ack_detail.html", block=block)


# ── Acknowledgment Blocks — create ───────────────────────────────────────────

@manuscriptforge_bp.route("/acks/new", methods=["GET", "POST"])
@editor_required
def new_ack_block():
    if request.method == "POST":
        data = {
            "category":    request.form.get("category", "").strip(),
            "short_label": request.form.get("short_label", "").strip(),
            "text":        request.form.get("text", "").strip(),
            "is_active":   "true" if request.form.get("is_active") else "false",
            "notes":       request.form.get("notes", "").strip(),
        }
        errors = validate_ack_block(data)
        if errors:
            for e in errors:
                flash(e, "error")
            return render_template("manuscriptforge/ack_form.html", mode="add", form=request.form)
        create_ack_block(data)
        flash(_("Block created successfully."), "success")
        return redirect(url_for("manuscriptforge.acks_list"))
    return render_template("manuscriptforge/ack_form.html", mode="add", form={})


# ── Acknowledgment Blocks — edit ──────────────────────────────────────────────

@manuscriptforge_bp.route("/acks/<block_id>/edit", methods=["GET", "POST"])
@editor_required
def edit_ack_block(block_id):
    block = get_ack_block(block_id)
    if not block:
        flash(_("Block not found."), "error")
        return redirect(url_for("manuscriptforge.acks_list"))
    if request.method == "POST":
        data = {
            "category":    request.form.get("category", "").strip(),
            "short_label": request.form.get("short_label", "").strip(),
            "text":        request.form.get("text", "").strip(),
            "is_active":   "true" if request.form.get("is_active") else "false",
            "notes":       request.form.get("notes", "").strip(),
        }
        errors = validate_ack_block(data)
        if errors:
            for e in errors:
                flash(e, "error")
            return render_template(
                "manuscriptforge/ack_form.html", mode="edit", block=block, form=request.form
            )
        update_ack_block(block_id, data)
        flash(_("Block updated successfully."), "success")
        return redirect(url_for("manuscriptforge.ack_detail", block_id=block_id))
    return render_template("manuscriptforge/ack_form.html", mode="edit", block=block, form=block)


# ── Acknowledgment Blocks — delete ────────────────────────────────────────────

@manuscriptforge_bp.route("/acks/<block_id>/delete", methods=["POST"])
@admin_required
def delete_ack_block_route(block_id):
    if delete_ack_block(block_id):
        flash(_("Block deleted successfully."), "success")
    else:
        flash(_("Block not found."), "error")
    return redirect(url_for("manuscriptforge.acks_list"))


# ── Acknowledgment Blocks — toggle ───────────────────────────────────────────

@manuscriptforge_bp.route("/acks/<block_id>/toggle", methods=["POST"])
@editor_required
def toggle_ack_block_route(block_id):
    toggle_ack_block(block_id)
    return redirect(url_for("manuscriptforge.acks_list"))


# ── Section generation ────────────────────────────────────────────────────────

@manuscriptforge_bp.route("/generate")
@login_required
def generate_section():
    members = load_members()
    members = members[members["status"].isin(["active", "collaborator_external"])]
    members = members.sort_values(["status", "last_name", "first_name"])

    active = members[members["status"] == "active"].to_dict("records")
    external = members[members["status"] == "collaborator_external"].to_dict("records")

    return render_template(
        "manuscriptforge/generate.html",
        active_members=active,
        external_members=external,
    )


@manuscriptforge_bp.route("/generate/author-order", methods=["POST"])
@editor_required
def generate_author_order_route():
    raw_ids = request.form.getlist("member_ids")
    member_ids = [mid.strip() for mid in raw_ids if mid and mid.strip()]

    if not member_ids:
        return jsonify({"error": _("Please select at least one author.")}), 400

    try:
        result = generate_author_order(member_ids)
    except ValueError as e:
        msg = str(e)
        if "Unknown member" in msg:
            return jsonify({"error": _("One or more selected members were not found.")}), 400
        if "no affiliations" in msg.lower() or "None of the selected" in msg:
            return jsonify({
                "error": _("None of the selected authors have affiliations. "
                           "Assign affiliations before generating.")
            }), 400
        return jsonify({"error": msg}), 400

    return jsonify(result)
