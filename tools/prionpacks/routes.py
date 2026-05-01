import logging

from flask import jsonify, render_template, request

from core.decorators import login_required
from . import prionpacks_bp
from . import models

logger = logging.getLogger(__name__)


@prionpacks_bp.route('/')
@prionpacks_bp.route('/index')
@login_required
def index():
    return render_template('prionpacks/index.html')


# ── REST API ──────────────────────────────────────────────────────────────────

@prionpacks_bp.route('/api/packages', methods=['GET'])
@login_required
def api_list():
    return jsonify(models.list_packages())


@prionpacks_bp.route('/api/packages', methods=['POST'])
@login_required
def api_create():
    data = request.get_json(force=True, silent=True) or {}
    if not data.get('title', '').strip():
        return jsonify({'error': 'title is required'}), 400
    pkg = models.create_package(data)
    return jsonify(pkg), 201


@prionpacks_bp.route('/api/packages/<pkg_id>', methods=['PUT'])
@login_required
def api_update(pkg_id):
    data = request.get_json(force=True, silent=True) or {}
    pkg = models.update_package(pkg_id, data)
    if pkg is None:
        return jsonify({'error': 'not found'}), 404
    return jsonify(pkg)


@prionpacks_bp.route('/api/packages/<pkg_id>', methods=['DELETE'])
@login_required
def api_delete(pkg_id):
    models.delete_package(pkg_id)
    return jsonify({'ok': True})
