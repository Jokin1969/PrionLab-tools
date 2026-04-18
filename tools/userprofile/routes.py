from flask import flash, redirect, render_template, request, session, url_for, jsonify
from flask_babel import gettext as _

from core.decorators import login_required
from tools.userprofile import userprofile_bp
from tools.userprofile.models import (
    create_lab, get_all_labs, get_lab, get_lab_members,
    get_recent_activity, join_lab, update_lab,
)


@userprofile_bp.route("/")
@login_required
def lab_dashboard():
    from core.users import get_user
    username = session["username"]
    user = get_user(username) or {}
    lab = None
    members = []
    if user.get("lab_id"):
        lab = get_lab(user["lab_id"])
        if lab:
            members = get_lab_members(lab["lab_id"])
    activity = get_recent_activity(username, limit=10)
    all_labs = get_all_labs()
    return render_template(
        "userprofile/lab.html",
        user=user,
        lab=lab,
        members=members,
        activity=activity,
        all_labs=all_labs,
    )


@userprofile_bp.route("/create", methods=["POST"])
@login_required
def create_lab_route():
    username = session["username"]
    data = {
        "lab_name": request.form.get("lab_name", "").strip(),
        "institution": request.form.get("institution", "").strip(),
        "department": request.form.get("department", "").strip(),
        "description": request.form.get("description", "").strip(),
        "website": request.form.get("website", "").strip(),
        "location": request.form.get("location", "").strip(),
    }
    if not data["lab_name"]:
        flash(_("Lab name is required."), "danger")
        return redirect(url_for("userprofile.lab_dashboard"))
    result = create_lab(data, username)
    if result.get("success"):
        flash(
            _("Lab created! Your lab code is: %(code)s", code=result["lab_code"]),
            "success",
        )
    else:
        flash(result.get("error", _("Failed to create lab.")), "danger")
    return redirect(url_for("userprofile.lab_dashboard"))


@userprofile_bp.route("/join", methods=["POST"])
@login_required
def join_lab_route():
    username = session["username"]
    code = request.form.get("lab_code", "").strip().upper()
    if not code:
        flash(_("Please enter a lab code."), "danger")
        return redirect(url_for("userprofile.lab_dashboard"))
    result = join_lab(code, username)
    if result.get("success"):
        flash(_("Joined %(name)s!", name=result["lab_name"]), "success")
    else:
        flash(result.get("error", _("Could not join lab.")), "danger")
    return redirect(url_for("userprofile.lab_dashboard"))


@userprofile_bp.route("/<lab_id>")
@login_required
def lab_detail(lab_id):
    lab = get_lab(lab_id)
    if not lab:
        flash(_("Lab not found."), "danger")
        return redirect(url_for("userprofile.lab_dashboard"))
    members = get_lab_members(lab_id)
    return render_template("userprofile/lab.html",
                           lab=lab, members=members,
                           user={}, activity=[], all_labs=[])


@userprofile_bp.route("/<lab_id>/update", methods=["POST"])
@login_required
def update_lab_route(lab_id):
    username = session["username"]
    role = session.get("role", "reader")
    lab = get_lab(lab_id)
    if not lab:
        flash(_("Lab not found."), "danger")
        return redirect(url_for("userprofile.lab_dashboard"))
    if lab.get("pi_username") != username and role != "admin":
        flash(_("Only the lab PI can edit lab details."), "danger")
        return redirect(url_for("userprofile.lab_dashboard"))
    data = {
        "lab_name": request.form.get("lab_name", "").strip(),
        "institution": request.form.get("institution", "").strip(),
        "department": request.form.get("department", "").strip(),
        "description": request.form.get("description", "").strip(),
        "website": request.form.get("website", "").strip(),
        "location": request.form.get("location", "").strip(),
    }
    update_lab(lab_id, data, username)
    flash(_("Lab updated."), "success")
    return redirect(url_for("userprofile.lab_dashboard"))


@userprofile_bp.route("/leave", methods=["POST"])
@login_required
def leave_lab():
    from core.users import get_user, update_user
    username = session["username"]
    user = get_user(username) or {}
    if not user.get("lab_id"):
        flash(_("You are not in a lab."), "danger")
        return redirect(url_for("userprofile.lab_dashboard"))
    lab = get_lab(user["lab_id"])
    if lab and lab.get("pi_username") == username:
        flash(_("The lab PI cannot leave. Transfer PI role first."), "danger")
        return redirect(url_for("userprofile.lab_dashboard"))
    update_user(username, {"lab_id": ""}, sync=False)
    flash(_("You have left the lab."), "success")
    return redirect(url_for("userprofile.lab_dashboard"))
