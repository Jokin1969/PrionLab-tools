from flask import Blueprint

help_bp = Blueprint('help', __name__, url_prefix='/help')

from . import routes  # noqa: F401, E402
