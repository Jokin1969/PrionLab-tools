from flask import Blueprint, render_template, request, session, redirect, url_for, flash
from config import ADMIN_PASSWORD

auth_bp = Blueprint("auth", __name__)

@auth_bp.route("/login", methods=["GET", "POST"])
def login():
    if session.get("logged_in"):
        return redirect(url_for("home"))

    error = None
    if request.method == "POST":
        password = request.form.get("password", "")
        if ADMIN_PASSWORD and password == ADMIN_PASSWORD:
            session["logged_in"] = True
            session.permanent = True
            next_url = request.args.get("next") or url_for("home")
            return redirect(next_url)
        else:
            error = "Incorrect password."

    return render_template("login.html", error=error)

@auth_bp.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("auth.login"))
