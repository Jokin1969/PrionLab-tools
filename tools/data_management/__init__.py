from flask import Blueprint

data_mgmt_bp = Blueprint('data_management', __name__, url_prefix='/data-management')

from . import routes  # noqa: F401, E402
