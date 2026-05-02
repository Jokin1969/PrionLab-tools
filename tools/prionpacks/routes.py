import logging
from datetime import datetime

from flask import Response, jsonify, render_template, request

from core.decorators import login_required
from . import prionpacks_bp
from . import models

logger = logging.getLogger(__name__)

COLLEAGUES: dict[str, dict] = {
    'herana':  {'name': 'Hasier Eraña',  'email': 'herana@cicbiogune.es'},
    'cdiza':   {'name': 'Carlos Díaz',   'email': 'cdiza@cicbiogune.es'},
    'jmoreno': {'name': 'Jorge Moreno',  'email': 'jmoreno@cicbiogune.es'},
}


@prionpacks_bp.route('/')
@prionpacks_bp.route('/index')
@login_required
def index():
    return render_template('prionpacks/index.html')


# ── REST API ──────────────────────────────────────────────────────────────────

@prionpacks_bp.route('/api/packages', methods=['GET'])
@login_required
def api_list():
    active_param = request.args.get('active')
    pkgs = models.list_packages()
    if active_param is not None:
        want = active_param.lower() in ('1', 'true', 'yes')
        pkgs = [p for p in pkgs if bool(p.get('active', True)) == want]
    return jsonify(pkgs)


@prionpacks_bp.route('/api/packages/<pkg_id>/import-section', methods=['POST'])
@login_required
def api_import_section(pkg_id):
    data = request.get_json(force=True, silent=True) or {}
    section = (data.get('section') or '').strip()
    pkg = models.get_package(pkg_id)
    if not pkg:
        return jsonify({'error': 'Paquete no encontrado.'}), 404

    SECTION_MAP = {
        'funding':              'funding',
        'acknowledgments':      'acknowledgments',
        'competing_interests':  'conflictsOfInterest',
        'credit':               'credit',
        'introduction':         'introduction',
        'methods':              'methods',
    }

    if section == 'author_order':
        authors = (data.get('authors') or '').strip()
        affiliations = (data.get('affiliations') or '').strip()
        update = {}
        if authors:
            update['coAuthors'] = authors
        if affiliations:
            update['affiliations'] = affiliations
        if not update:
            return jsonify({'error': 'No hay contenido para importar.'}), 400
        models.update_package(pkg_id, update)
        return jsonify({'ok': True, 'updated': list(update.keys())})

    field_key = SECTION_MAP.get(section)
    if not field_key:
        return jsonify({'error': f'Sección no válida: {section}'}), 400

    text = (data.get('text') or '').strip()
    if not text:
        return jsonify({'error': 'No hay contenido para importar.'}), 400

    models.update_package(pkg_id, {field_key: text})
    return jsonify({'ok': True, 'updated': [field_key]})


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


# ── DOCX download ─────────────────────────────────────────────────────────────

@prionpacks_bp.route('/api/packages/<pkg_id>/docx', methods=['GET'])
@login_required
def api_download_docx(pkg_id):
    from .docx_generator import generate_package_docx

    pkg = models.get_package(pkg_id)
    if not pkg:
        return jsonify({'error': 'not found'}), 404

    version = max(1, pkg.get('docxVersion', 0))
    try:
        docx_bytes = generate_package_docx(pkg, version, datetime.now())
    except Exception as exc:
        logger.exception('DOCX generation error for %s', pkg_id)
        return jsonify({'error': str(exc)}), 500

    safe = ''.join(c if c.isalnum() or c in ' _-' else '_' for c in pkg.get('title', 'Package'))[:50]
    filename = f'PrionPack_{safe}_v{version}.docx'
    return Response(
        docx_bytes,
        mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'},
    )


# ── Send for review ───────────────────────────────────────────────────────────

@prionpacks_bp.route('/api/packages/<pkg_id>/send-review', methods=['POST'])
@login_required
def api_send_review(pkg_id):
    from .docx_generator import generate_package_docx
    from .email_sender import is_configured, send_review_email

    data = request.get_json(force=True, silent=True) or {}
    keys = data.get('recipients')
    if not keys:
        single = data.get('recipient')
        keys = [single] if single else []
    keys = [k for k in keys if k]
    if not keys:
        return jsonify({'error': 'No se ha seleccionado ningún destinatario.'}), 400

    colleagues = []
    for k in keys:
        c = COLLEAGUES.get(k)
        if not c:
            return jsonify({'error': f'Destinatario no válido: {k}'}), 400
        colleagues.append(c)

    pkg = models.get_package(pkg_id)
    if not pkg:
        return jsonify({'error': 'Paquete no encontrado.'}), 404

    version = models.increment_docx_version(pkg_id)
    pkg = models.get_package(pkg_id)

    try:
        docx_bytes = generate_package_docx(pkg, version, datetime.now())
    except Exception as exc:
        logger.exception('DOCX generation error for %s', pkg_id)
        return jsonify({'error': f'Error generando el documento: {exc}', 'version': version}), 500

    if not is_configured():
        safe = ''.join(
            c if c.isalnum() or c in ' _-' else '_' for c in pkg.get('title', 'Package')
        )[:50]
        filename = f'PrionPack_{safe}_v{version}.docx'
        return Response(
            docx_bytes,
            mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            headers={
                'Content-Disposition':  f'attachment; filename="{filename}"',
                'X-PP-SMTP-Missing':    '1',
                'X-PP-Version':         str(version),
                'Access-Control-Expose-Headers': 'X-PP-SMTP-Missing, X-PP-Version, Content-Disposition',
            },
        )

    sent, failed = [], []
    for colleague in colleagues:
        try:
            send_review_email(
                recipient_email=colleague['email'],
                recipient_name=colleague['name'],
                pkg_title=pkg.get('title', 'Paquete sin título'),
                docx_bytes=docx_bytes,
                version=version,
            )
            sent.append({'name': colleague['name'], 'email': colleague['email']})
        except Exception as exc:
            logger.error('Email send error to %s: %s', colleague['email'], exc)
            failed.append({'name': colleague['name'], 'email': colleague['email'], 'error': str(exc)})

    if not sent:
        return jsonify({
            'ok': False,
            'version': version,
            'failed': failed,
            'error': 'No se pudo enviar a ningún destinatario.',
        }), 500

    return jsonify({
        'ok':      True,
        'version': version,
        'sent':    sent,
        'failed':  failed,
    })
