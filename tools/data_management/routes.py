import logging
from flask import jsonify, render_template, request

from core.decorators import login_required, admin_required
from tools.data_management import data_mgmt_bp

logger = logging.getLogger(__name__)


# ── Dashboard page ────────────────────────────────────────────────────────────

@data_mgmt_bp.route('/')
@admin_required
def dashboard():
    return render_template('data_management/dashboard.html', page_context='data_management')


# ── API: Storage status ───────────────────────────────────────────────────────

@data_mgmt_bp.route('/api/status')
@login_required
def api_status():
    try:
        from database.data_management import get_storage_status
        return jsonify(get_storage_status())
    except Exception as e:
        logger.error("Storage status error: %s", e)
        return jsonify({'error': str(e)}), 500


# ── API: Backup ───────────────────────────────────────────────────────────────

@data_mgmt_bp.route('/api/backup', methods=['POST'])
@admin_required
def api_backup():
    data = request.get_json(silent=True) or {}
    backup_type = data.get('backup_type', 'auto')
    try:
        from database.data_management import trigger_backup
        result = trigger_backup(backup_type)
        return jsonify(result)
    except Exception as e:
        logger.error("Backup error: %s", e)
        return jsonify({'error': str(e)}), 500


@data_mgmt_bp.route('/api/backups')
@admin_required
def api_list_backups():
    try:
        from database.data_management import list_backups
        return jsonify(list_backups())
    except Exception as e:
        logger.error("List backups error: %s", e)
        return jsonify({'error': str(e)}), 500


# ── API: Integrity check ──────────────────────────────────────────────────────

@data_mgmt_bp.route('/api/integrity-check', methods=['POST'])
@admin_required
def api_integrity_check():
    try:
        from database.data_management import perform_integrity_check
        return jsonify(perform_integrity_check())
    except Exception as e:
        logger.error("Integrity check error: %s", e)
        return jsonify({'error': str(e)}), 500


# ── API: Optimize storage ─────────────────────────────────────────────────────

@data_mgmt_bp.route('/api/optimize', methods=['POST'])
@admin_required
def api_optimize():
    try:
        from database.data_management import optimize_storage
        return jsonify(optimize_storage())
    except Exception as e:
        logger.error("Optimize error: %s", e)
        return jsonify({'error': str(e)}), 500


# ── API: Dropbox sync ─────────────────────────────────────────────────────────

@data_mgmt_bp.route('/api/sync/push', methods=['POST'])
@admin_required
def api_sync_push():
    data = request.get_json(silent=True) or {}
    filenames = data.get('filenames')  # None = all CSVs
    try:
        from database.data_management import sync_csv_to_dropbox
        return jsonify(sync_csv_to_dropbox(filenames))
    except Exception as e:
        logger.error("Sync push error: %s", e)
        return jsonify({'error': str(e)}), 500


@data_mgmt_bp.route('/api/sync/pull', methods=['POST'])
@admin_required
def api_sync_pull():
    try:
        from database.data_management import pull_csv_from_dropbox
        return jsonify(pull_csv_from_dropbox())
    except Exception as e:
        logger.error("Sync pull error: %s", e)
        return jsonify({'error': str(e)}), 500


# ── API: Export table ─────────────────────────────────────────────────────────

@data_mgmt_bp.route('/api/export/<table_name>')
@admin_required
def api_export_table(table_name):
    upload = request.args.get('dropbox', 'false').lower() == 'true'
    try:
        from database.data_management import export_table_to_csv
        return jsonify(export_table_to_csv(table_name, upload_dropbox=upload))
    except Exception as e:
        logger.error("Export error: %s", e)
        return jsonify({'error': str(e)}), 500
