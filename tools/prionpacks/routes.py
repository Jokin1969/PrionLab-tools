import logging

from flask import render_template

from core.decorators import login_required
from . import prionpacks_bp

logger = logging.getLogger(__name__)


@prionpacks_bp.route("/")
@prionpacks_bp.route("/index")
@login_required
def index():
    return render_template("prionpacks/index.html")
