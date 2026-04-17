from flask import flash, redirect, render_template, request, session, url_for
from flask_babel import gettext as _

from core.decorators import admin_required, editor_required, login_required
from . import manuscriptforge_bp
from .models import (
    add_member_affiliation, count_affiliation_members, create_affiliation,
    create_member, delete_affiliation, delete_member, get_affiliation,
    get_affiliation_members, get_member, get_member_affiliations,
    load_affiliations, load_members, move_member_affiliation,
    remove_member_affiliation, update_affiliation, update_member,
)
from .validators import validate_affiliation, validate_member


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

    return render_template(
        "manuscriptforge/member_detail.html",
        member=member,
        affiliations=affiliations,
        available_affs=available_affs,
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
