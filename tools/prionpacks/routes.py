import logging
from datetime import datetime

from flask import Response, jsonify, render_template, request

from core.decorators import login_required
from . import prionpacks_bp
from . import models
from . import members as members_module

logger = logging.getLogger(__name__)


def _post_save_sync(pkg):
    """Fire-and-forget: reconcile this pack with its two auto-managed
    PrionVault collections after every save. Failures are logged and
    swallowed so a PrionVault hiccup never blocks a PrionPack save."""
    if not pkg:
        return
    try:
        from tools.prionvault.services.prionpack_sync import sync_pack
        sync_pack(pkg)
    except Exception as exc:
        logger.warning("prionpacks: post-save PrionVault sync failed for %s: %s",
                       pkg.get("id"), exc)


def _colleagues():
    """Build the COLLEAGUES dict dynamically from the members store."""
    result = {}
    for m in members_module.list_members():
        result[m['id']] = {'name': f"{m['name']} {m['surname']}", 'email': m['email']}
    return result


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


def _fetch_prionvault_article(article_id: str):
    """Pull one row from the shared `articles` table.

    Uses raw SQL so PrionPacks doesn't depend on PrionVault's SQLAlchemy
    models. Returns a dict or None if not found / DB unavailable.
    """
    try:
        from database.config import db
        from sqlalchemy import text as sql_text
        with db.engine.connect() as conn:
            row = conn.execute(sql_text(
                """SELECT id, title, authors, year, journal, doi, pubmed_id,
                          abstract, summary_ai
                   FROM articles WHERE id = :aid"""
            ), {"aid": article_id}).first()
        if not row:
            return None
        return dict(zip(row._fields, row))
    except Exception as exc:
        logger.warning("import_article: cannot fetch article %s (%s)", article_id, exc)
        return None


def _format_article_reference(article: dict) -> str:
    """Build the reference text inserted into a pack's reference list.

    Citation line (title · authors · year · journal · DOI/PMID), then a
    blank line, then the AI summary if present.
    """
    title   = (article.get('title') or '').strip() or '(sin título)'
    authors = (article.get('authors') or '').strip()
    year    = article.get('year')
    journal = (article.get('journal') or '').strip()
    doi     = (article.get('doi') or '').strip()
    pmid    = (article.get('pubmed_id') or '').strip()
    summary = (article.get('summary_ai') or '').strip()

    bits = [title]
    if authors: bits.append(authors)
    if year:    bits.append(str(year))
    if journal: bits.append(journal)
    cite = '. '.join(bits)
    if not cite.endswith('.'):
        cite += '.'

    ids = []
    if doi:  ids.append(f"DOI: {doi}")
    if pmid: ids.append(f"PMID: {pmid}")
    if ids:
        cite += ' ' + ' · '.join(ids)

    block = cite
    if summary:
        block += "\n\n[Resumen IA]\n" + summary
    return block


def _resolve_ref(ref) -> str:
    """Return a displayable reference string for either format.

    - Linked dict  → fetch article from DB, format with current summary_ai.
                     Falls back to a stub if the article has been deleted.
    - Plain string → returned as-is.
    """
    if not models._is_linked_ref(ref):
        return str(ref) if ref else ''
    article = _fetch_prionvault_article(ref['article_id'])
    if not article:
        return f'[Artículo vinculado no encontrado — id: {ref["article_id"]}]'
    return _format_article_reference(article)


def _resolve_refs_for_pack(pkg: dict) -> dict:
    """Return a copy of the pack with all linked refs resolved to strings.

    Used before DOCX generation and when serving the pack to the frontend,
    so consumers always see plain text regardless of storage format.
    """
    import copy
    out = copy.deepcopy(pkg)
    for field in ('references', 'introReferences'):
        raw = out.get(field) or []
        out[field] = [_resolve_ref(r) for r in raw]
    return out


@prionpacks_bp.route('/api/packages/<pkg_id>/import-article', methods=['POST'])
@login_required
def api_import_article(pkg_id):
    """Append a PrionVault article as a formatted reference to one or
    both reference lists of a pack.

    Body: {"article_id": "<uuid>", "targets": ["intro" | "general"]}.

    Duplicate guard: if the target list already contains an entry whose
    text mentions the article's DOI, that target is silently skipped.
    """
    data = request.get_json(force=True, silent=True) or {}
    article_id = (data.get('article_id') or '').strip()
    raw_targets = data.get('targets') or []
    if not article_id:
        return jsonify({'error': 'article_id required'}), 400
    if not isinstance(raw_targets, list) or not raw_targets:
        return jsonify({'error': 'targets must be a non-empty list'}), 400
    valid = {'intro', 'general'}
    targets = [t for t in raw_targets if t in valid]
    if not targets:
        return jsonify({'error': f'targets must include at least one of {sorted(valid)}'}), 400

    pkg = models.get_package(pkg_id)
    if not pkg:
        return jsonify({'error': 'package not found'}), 404

    article = _fetch_prionvault_article(article_id)
    if not article:
        return jsonify({'error': 'article not found'}), 404

    # New imports are stored as linked references (dict), not embedded text.
    new_ref = {
        "type":       "linked",
        "article_id": str(article['id']),
        "added_at":   datetime.utcnow().isoformat(),
    }
    doi = (article.get('doi') or '').strip().lower()

    update_data = {}
    added_to = []
    skipped = []

    for tgt in targets:
        field = 'introReferences' if tgt == 'intro' else 'references'
        existing_list = list(pkg.get(field) or [])
        is_dup = False
        for existing in existing_list:
            if models._is_linked_ref(existing):
                if str(existing['article_id']) == str(article['id']):
                    is_dup = True
                    break
            elif doi and doi in (existing or '').lower():
                is_dup = True
                break
        if is_dup:
            skipped.append(tgt)
            continue
        existing_list.append(new_ref)
        update_data[field] = existing_list
        added_to.append(tgt)

    if not update_data:
        return jsonify({
            'ok': False,
            'reason': 'already_in_pack',
            'added_to': [],
            'skipped': skipped,
        })

    updated_pkg = models.update_package(pkg_id, update_data)
    _post_save_sync(updated_pkg)
    return jsonify({
        'ok': True,
        'added_to': added_to,
        'skipped': skipped,
        'article_id': str(article['id']),
        'package': _resolve_refs_for_pack(updated_pkg),
    })


@prionpacks_bp.route('/api/packages/<pkg_id>/import-articles', methods=['POST'])
@login_required
def api_import_articles(pkg_id):
    """Bulk version of import-article: append many references to one
    pack in a single update.

    Body: {"article_ids": ["<uuid>", …], "targets": ["intro" | "general"]}

    Duplicate guard runs per target by scanning existing reference
    strings for the article DOI before each append, then dedups the
    new ones too. Returns per-target counts of additions / skips and
    a not_found count for articles that couldn't be resolved.
    """
    import re as _re
    data = request.get_json(force=True, silent=True) or {}
    article_ids = data.get('article_ids') or []
    raw_targets = data.get('targets') or []
    if not isinstance(article_ids, list) or not article_ids:
        return jsonify({'error': 'article_ids required'}), 400
    if len(article_ids) > 500:
        return jsonify({'error': 'too many article_ids (max 500)'}), 400
    valid = {'intro', 'general'}
    targets = [t for t in raw_targets if t in valid]
    if not targets:
        return jsonify({'error': f'targets must include at least one of {sorted(valid)}'}), 400

    pkg = models.get_package(pkg_id)
    if not pkg:
        return jsonify({'error': 'package not found'}), 404

    intro_list = list(pkg.get('introReferences') or [])
    gen_list   = list(pkg.get('references') or [])

    _doi_re = _re.compile(r'10\.\d{4,}/\S+', _re.IGNORECASE)
    def _dois_in_list(lst):
        out = set()
        for ref in lst:
            for m in _doi_re.findall(ref or ''):
                out.add(m.strip().lower().rstrip('.,;:)'))
        return out
    intro_dois = _dois_in_list(intro_list) if 'intro' in targets else set()
    gen_dois   = _dois_in_list(gen_list)   if 'general' in targets else set()

    added   = {'intro': 0, 'general': 0}
    skipped = {'intro': 0, 'general': 0}
    not_found = 0

    for aid in article_ids:
        article = _fetch_prionvault_article(str(aid))
        if not article:
            not_found += 1
            continue
        ref_text = _format_article_reference(article)
        doi = (article.get('doi') or '').strip().lower()
        for tgt in targets:
            if tgt == 'intro':
                if doi and doi in intro_dois:
                    skipped['intro'] += 1
                    continue
                intro_list.append(ref_text)
                if doi:
                    intro_dois.add(doi)
                added['intro'] += 1
            else:
                if doi and doi in gen_dois:
                    skipped['general'] += 1
                    continue
                gen_list.append(ref_text)
                if doi:
                    gen_dois.add(doi)
                added['general'] += 1

    update_data = {}
    if 'intro' in targets and added['intro']:
        update_data['introReferences'] = intro_list
    if 'general' in targets and added['general']:
        update_data['references'] = gen_list

    if update_data:
        pkg = models.update_package(pkg_id, update_data)
        _post_save_sync(pkg)

    return jsonify({
        'ok':        True,
        'requested': len(article_ids),
        'not_found': not_found,
        'added':     added,
        'skipped':   skipped,
        'package':   _resolve_refs_for_pack(pkg),
    })


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
        pkg = models.update_package(pkg_id, update)
        _post_save_sync(pkg)
        return jsonify({'ok': True, 'updated': list(update.keys())})

    field_key = SECTION_MAP.get(section)
    if not field_key:
        return jsonify({'error': f'Sección no válida: {section}'}), 400

    text = (data.get('text') or '').strip()
    if not text:
        return jsonify({'error': 'No hay contenido para importar.'}), 400

    pkg = models.update_package(pkg_id, {field_key: text})
    _post_save_sync(pkg)
    return jsonify({'ok': True, 'updated': [field_key]})


@prionpacks_bp.route('/api/packages', methods=['POST'])
@login_required
def api_create():
    data = request.get_json(force=True, silent=True) or {}
    if not data.get('title', '').strip():
        return jsonify({'error': 'title is required'}), 400
    pkg = models.create_package(data)
    _post_save_sync(pkg)
    return jsonify(pkg), 201


@prionpacks_bp.route('/api/packages/<pkg_id>', methods=['GET'])
@login_required
def api_get(pkg_id):
    """Return a single pack with all linked refs resolved to display strings."""
    pkg = models.get_package(pkg_id)
    if not pkg:
        return jsonify({'error': 'not found'}), 404
    return jsonify(_resolve_refs_for_pack(pkg))


@prionpacks_bp.route('/api/packages/<pkg_id>', methods=['PUT'])
@login_required
def api_update(pkg_id):
    data = request.get_json(force=True, silent=True) or {}
    pkg = models.update_package(pkg_id, data)
    if pkg is None:
        return jsonify({'error': 'not found'}), 404
    _post_save_sync(pkg)
    return jsonify(_resolve_refs_for_pack(pkg))


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
        docx_bytes = generate_package_docx(_resolve_refs_for_pack(pkg), version, datetime.now())
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


# ── Package list DOCX ─────────────────────────────────────────────────────────

@prionpacks_bp.route('/api/packages/list-docx', methods=['GET'])
@login_required
def api_list_docx():
    from .docx_generator import generate_packages_list_docx

    pkgs = models.list_packages()
    try:
        docx_bytes = generate_packages_list_docx(pkgs, datetime.now())
    except Exception as exc:
        logger.exception('List DOCX generation error')
        return jsonify({'error': str(exc)}), 500

    filename = f'PrionPacks_Lista_{datetime.now().strftime("%Y%m%d")}.docx'
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
        c = _colleagues().get(k)
        if not c:
            return jsonify({'error': f'Destinatario no válido: {k}'}), 400
        colleagues.append(c)

    pkg = models.get_package(pkg_id)
    if not pkg:
        return jsonify({'error': 'Paquete no encontrado.'}), 404

    version = models.increment_docx_version(pkg_id)
    pkg = models.get_package(pkg_id)

    try:
        docx_bytes = generate_package_docx(_resolve_refs_for_pack(pkg), version, datetime.now())
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


# ── AI-assisted "what else fits in this pack?" ───────────────────────────────

@prionpacks_bp.route('/api/packages/<pkg_id>/suggest-internal', methods=['POST'])
@login_required
def api_suggest_internal(pkg_id):
    """Voyage + pgvector + LLM rationale: recommend PrionVault articles
    that fit this pack thematically. The pack's own member articles
    are excluded from the result set."""
    from tools.prionvault.services import pack_suggest
    from tools.prionvault.services.llm_pool import NotConfigured

    pkg = models.get_package(pkg_id)
    if not pkg:
        return jsonify({'error': 'not found'}), 404

    data = request.get_json(silent=True) or {}
    provider = (data.get('provider') or 'anthropic').strip().lower()
    scope    = (data.get('scope') or 'all').strip().lower()
    try:
        top_k = max(1, min(40, int(data.get('top_k') or 10)))
    except (TypeError, ValueError):
        top_k = 10
    rerank   = bool(data.get('rerank', True))
    rationale = bool(data.get('rationale', True))

    try:
        result = pack_suggest.suggest_internal(
            pkg, top_k=top_k, rerank=rerank, rationale=rationale,
            provider=provider, scope=scope,
        )
    except NotConfigured as exc:
        return jsonify({'error': 'provider_not_configured', 'detail': str(exc)}), 503
    except Exception as exc:
        logger.exception('suggest-internal failed for %s', pkg_id)
        return jsonify({'error': 'internal_error', 'detail': str(exc)[:300]}), 500
    return jsonify(result)


@prionpacks_bp.route('/api/packages/<pkg_id>/suggest-pubmed', methods=['POST'])
@login_required
def api_suggest_pubmed(pkg_id):
    """LLM-extracted PubMed E-Search queries + dedup + rationale. The
    result excludes PMIDs already present in PrionVault — that subset
    is what suggest-internal covers."""
    from tools.prionvault.services import pack_suggest
    from tools.prionvault.services.llm_pool import NotConfigured

    pkg = models.get_package(pkg_id)
    if not pkg:
        return jsonify({'error': 'not found'}), 404

    data = request.get_json(silent=True) or {}
    provider = (data.get('provider') or 'anthropic').strip().lower()
    scope    = (data.get('scope') or 'all').strip().lower()
    try:
        top_k = max(1, min(40, int(data.get('top_k') or 15)))
    except (TypeError, ValueError):
        top_k = 15
    rationale = bool(data.get('rationale', True))

    try:
        result = pack_suggest.suggest_pubmed(
            pkg, top_k=top_k, rationale=rationale, provider=provider,
            scope=scope,
        )
    except NotConfigured as exc:
        return jsonify({'error': 'provider_not_configured', 'detail': str(exc)}), 503
    except Exception as exc:
        logger.exception('suggest-pubmed failed for %s', pkg_id)
        return jsonify({'error': 'internal_error', 'detail': str(exc)[:300]}), 500
    return jsonify(result)


# ── Dropbox Backup ────────────────────────────────────────────────────────────

@prionpacks_bp.route('/api/backup', methods=['POST'])
@login_required
def api_backup():
    from . import backup
    force = request.get_json(force=True, silent=True) or {}
    result = backup.run_backup(force=bool(force.get('force')))
    return jsonify(result)


@prionpacks_bp.route('/api/backup/list', methods=['GET'])
@login_required
def api_backup_list():
    from . import backup
    return jsonify(backup.list_backups())


@prionpacks_bp.route('/api/backup/restore', methods=['POST'])
@login_required
def api_backup_restore():
    from . import backup
    data = request.get_json(force=True, silent=True) or {}
    path = (data.get('path') or '').strip()
    if not path:
        return jsonify({'error': 'path requerido'}), 400
    result = backup.restore_backup(path)
    if result['status'] == 'error':
        return jsonify(result), 500
    return jsonify(result)


# ── Members ───────────────────────────────────────────────────────────────────

@prionpacks_bp.route('/api/members', methods=['GET'])
@login_required
def api_members_list():
    return jsonify(members_module.list_members())


@prionpacks_bp.route('/api/members', methods=['POST'])
@login_required
def api_members_create():
    data = request.get_json(force=True, silent=True) or {}
    if not (data.get('name') or '').strip() or not (data.get('surname') or '').strip():
        return jsonify({'error': 'name y surname son obligatorios'}), 400
    m = members_module.create_member(data)
    return jsonify(m), 201


@prionpacks_bp.route('/api/members/<member_id>', methods=['PUT'])
@login_required
def api_members_update(member_id):
    data = request.get_json(force=True, silent=True) or {}
    m = members_module.update_member(member_id, data)
    if m is None:
        return jsonify({'error': 'not found'}), 404
    return jsonify(m)


@prionpacks_bp.route('/api/members/<member_id>', methods=['DELETE'])
@login_required
def api_members_delete(member_id):
    members_module.delete_member(member_id)
    return jsonify({'ok': True})


@prionpacks_bp.route('/api/admin/migrate-refs', methods=['POST'])
@login_required
def api_migrate_refs():
    """Scan free-text references in all packs (or one pack) and convert
    those that match a PrionVault article by DOI/PMID to linked refs.

    Body (optional): {"pkg_id": "PRP-001"}  — limit to one pack.
    """
    from core.decorators import admin_required as _ar
    data = request.get_json(force=True, silent=True) or {}
    pkg_id = (data.get('pkg_id') or '').strip() or None
    result = models.migrate_free_refs_to_linked(pkg_id)
    return jsonify({'ok': True, **result})
