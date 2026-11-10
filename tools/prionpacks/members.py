import json
import logging
import os
import re
from datetime import datetime, timezone

from werkzeug.security import generate_password_hash

import config

from tools.prionpacks import _store
logger = logging.getLogger(__name__)

MEMBERS_FILE = os.path.join(config.DATA_DIR, 'prionpacks_members.json')

DEMO_MEMBERS = [
    {
        'id': 'joaquin',
        'name': 'Joaquín',
        'surname': 'Castilla',
        'initials': 'JC',
        'color': '#3b82f6',
        'email': 'jcastilla@cicbiogune.es',
        'password': '',
        'active': True,
        'createdAt': '2025-01-01T00:00:00Z',
    },
    {
        'id': 'hasier',
        'name': 'Hasier',
        'surname': 'Eraña',
        'initials': 'HE',
        'color': '#22c55e',
        'email': 'herana@cicbiogune.es',
        'password': '',
        'active': True,
        'createdAt': '2025-01-01T00:00:00Z',
    },
    {
        'id': 'jorge',
        'name': 'Jorge',
        'surname': 'Moreno',
        'initials': 'JM',
        'color': '#f97316',
        'email': 'jmoreno@cicbiogune.es',
        'password': '',
        'active': True,
        'createdAt': '2025-01-01T00:00:00Z',
    },
    {
        'id': 'carlos',
        'name': 'Carlos',
        'surname': 'Díaz',
        'initials': 'CD',
        'color': '#a855f7',
        'email': 'cdiza@cicbiogune.es',
        'password': '',
        'active': True,
        'createdAt': '2025-01-01T00:00:00Z',
    },
]


def _now():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _load():
    return _store.load_json(MEMBERS_FILE)


def _save(items) -> None:
    _store.save_json(MEMBERS_FILE, items)


def _slug(name, surname, existing_ids):
    base = re.sub(r'[^a-z0-9]', '', (name + surname).lower())[:20] or 'member'
    slug = base
    n = 2
    while slug in existing_ids:
        slug = f'{base}{n}'
        n += 1
    return slug


def _safe(m):
    return {k: v for k, v in m.items() if k != 'password'}


@_store.locked(lambda: MEMBERS_FILE)
def bootstrap_demo_data():
    # Only on a brand-new install: an existing file is never overwritten.
    if not os.path.exists(MEMBERS_FILE):
        _save(DEMO_MEMBERS)
        logger.info('PrionPacks members: seeded %d demo members', len(DEMO_MEMBERS))


def list_members():
    return [_safe(m) for m in _load()]


def get_member(member_id):
    return next((m for m in _load() if m['id'] == member_id), None)


@_store.locked(lambda: MEMBERS_FILE)
def create_member(data):
    members = _load()
    existing_ids = {m['id'] for m in members}
    name    = (data.get('name')    or '').strip()
    surname = (data.get('surname') or '').strip()
    raw_ini = (data.get('initials') or '').strip()
    initials = raw_ini[:3].upper() if raw_ini else (name[:1] + surname[:1]).upper()
    member = {
        'id':        _slug(name, surname, existing_ids),
        'name':      name,
        'surname':   surname,
        'initials':  initials,
        'color':     (data.get('color') or '#3b82f6').strip(),
        'email':     (data.get('email') or '').strip().lower(),
        'password':  generate_password_hash(data['password']) if data.get('password') else '',
        'active':    bool(data.get('active', True)),
        'createdAt': _now(),
    }
    members.append(member)
    _save(members)
    return _safe(member)


@_store.locked(lambda: MEMBERS_FILE)
def update_member(member_id, data):
    members = _load()
    idx = next((i for i, m in enumerate(members) if m['id'] == member_id), None)
    if idx is None:
        return None
    m = dict(members[idx])
    for field in ('name', 'surname', 'color', 'email'):
        if field in data and data[field] is not None:
            m[field] = str(data[field]).strip()
    if data.get('email'):
        m['email'] = m['email'].lower()
    if data.get('initials'):
        m['initials'] = str(data['initials']).strip()[:3].upper()
    if 'active' in data:
        m['active'] = bool(data['active'])
    if data.get('password'):
        m['password'] = generate_password_hash(data['password'])
    members[idx] = m
    _save(members)
    return _safe(m)


@_store.locked(lambda: MEMBERS_FILE)
def delete_member(member_id):
    _save([m for m in _load() if m['id'] != member_id])
