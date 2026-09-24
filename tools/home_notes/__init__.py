from flask import Blueprint

home_notes_bp = Blueprint('home_notes', __name__, url_prefix='/api')

from . import routes  # noqa: F401, E402
