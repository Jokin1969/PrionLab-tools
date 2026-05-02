import json
import logging
import os
import re
from datetime import datetime, timezone

import config

logger = logging.getLogger(__name__)

PACKAGES_FILE = os.path.join(config.DATA_DIR, 'prionpacks.json')

DEMO_PACKAGES = [
    {
        "id": "PRP-001",
        "title": "Agregación de α-synuclein en modelos transgénicos",
        "description": "Análisis de la formación de agregados proteicos en ratones SNCA triplicados bajo condiciones de estrés oxidativo.",
        "type": "research",
        "priority": "high",
        "active": True,
        "coAuthors": "",
        "affiliations": "",
        "abstract": "",
        "authorSummary": "",
        "introduction": "",
        "discussion": "",
        "acknowledgments": "",
        "funding": "",
        "conflictsOfInterest": "",
        "references": "",
        "findings": [
            {"id": "f1", "title": "Incremento significativo de agregados en SN", "titleEnglish": "Significant increase of aggregates in SN", "description": "Observamos un aumento del 340% en la densidad de agregados de α-synuclein en la sustancia negra a las 12 semanas.", "figures": [{"id": "fig1", "description": "Inmunohistoquímica anti-α-synuclein (×40)"}, {"id": "fig2", "description": "Cuantificación densitométrica de agregados por región cerebral"}]},
            {"id": "f2", "title": "Correlación déficit motor con carga proteica", "titleEnglish": "Correlation between motor deficit and protein load", "description": "El rotarod muestra correlación r=0.87 entre la carga de agregados y la pérdida de coordinación motora.", "figures": [{"id": "fig3", "description": "Test rotarod semanas 4, 8, 12 post-inducción"}]},
        ],
        "gaps": {"missingInfo": [
            {"text": "Análisis estadístico de cohorte mayor (n<12)", "findingId": None, "neededExperiment": ""},
            {"text": "Datos de supervivencia neuronal longitudinal", "findingId": None, "neededExperiment": "Western blot cuantitativo en fracciones solubles/insolubles"},
        ]},
        "scores": {"findings": 75, "figures": 70, "gaps": 40, "total": 74},
        "createdAt": "2025-04-01T10:00:00Z",
        "lastModified": "2025-04-29T14:00:00Z",
    },
    {
        "id": "PRP-002",
        "title": "Mecanismos de transmisión prión-like de tau patológico",
        "description": "Estudio de la propagación transneuronal de tau hiperfosforilado en modelos de tauopatía.",
        "type": "research",
        "priority": "high",
        "active": True,
        "findings": [
            {"id": "f1", "title": "Propagación axonal de tau-p231", "titleEnglish": "Axonal propagation of tau-p231", "description": "Inyección estereotáxica en corteza entorrinal seguida de detección en hipocampo a 3 meses.", "figures": [{"id": "fig1", "description": "Mapa de propagación por IHC seriada sagital"}, {"id": "fig2", "description": "Cuantificación de neuronas positivas tau-p231 por región"}, {"id": "fig3", "description": "Microscopía electrónica de filamentos tau"}]},
        ],
        "gaps": {"missingInfo": [
            {"text": "Modelo in vitro de transmisión célula-a-célula", "findingId": None, "neededExperiment": "FRET entre neuronas para confirmar transferencia directa"},
        ]},
        "scores": {"findings": 60, "figures": 80, "gaps": 30, "total": 65},
        "createdAt": "2025-03-16T10:00:00Z",
        "lastModified": "2025-04-26T09:00:00Z",
    },
    {
        "id": "PRP-003",
        "title": "Biomarcadores de LCR en estadios presintomáticos de EPD",
        "description": "Revisión sistemática de marcadores en líquido cefalorraquídeo para diagnóstico precoz.",
        "type": "review",
        "priority": "medium",
        "active": True,
        "findings": [
            {"id": "f1", "title": "Meta-análisis RT-QuIC 47 estudios", "titleEnglish": "Meta-analysis RT-QuIC 47 studies", "description": "Sensibilidad pooled 92.3% (IC95% 89-95%), especificidad 99.1% en estudios >100 pacientes.", "figures": [{"id": "fig1", "description": "Forest plot sensibilidad/especificidad RT-QuIC"}, {"id": "fig2", "description": "Curva ROC combinación biomarcadores"}]},
        ],
        "gaps": {"missingInfo": [
            {"text": "Estudios longitudinales >5 años de seguimiento", "findingId": None, "neededExperiment": "Validación prospectiva en cohorte multicéntrica española"},
        ]},
        "scores": {"findings": 85, "figures": 75, "gaps": 50, "total": 78},
        "createdAt": "2025-04-11T10:00:00Z",
        "lastModified": "2025-04-30T08:00:00Z",
    },
    {
        "id": "PRP-004",
        "title": "Caso clínico: ECJ variante con presentación psiquiátrica atípica",
        "description": "Descripción de caso index con inicio psiquiátrico prominente y diagnóstico diferido 14 meses.",
        "type": "case",
        "priority": "low",
        "active": True,
        "findings": [
            {"id": "f1", "title": "Evolución clínica y cronología diagnóstica", "titleEnglish": "Clinical evolution and diagnostic timeline", "description": "Mujer 28 años con depresión atípica, alucinaciones visuales 8 meses, mioclonías semana 38, EEG típico semana 52.", "figures": [{"id": "fig1", "description": "Línea temporal síntomas con correlato diagnóstico"}, {"id": "fig2", "description": "Series RM: secuencia DWI meses 6, 10 y 14"}]},
            {"id": "f2", "title": "Análisis neuropatológico post-mortem", "titleEnglish": "Post-mortem neuropathological analysis", "description": "Depósito de PrPsc tipo 2B confirmado, pérdida neuronal severa en caudado y putamen.", "figures": [{"id": "fig3", "description": "IHC PrP Western blot post-mortem"}, {"id": "fig4", "description": "Tinción H&E espongiosis cortical"}]},
        ],
        "gaps": {"missingInfo": [
            {"text": "Consentimiento publicación familia", "findingId": None, "neededExperiment": ""},
        ]},
        "scores": {"findings": 90, "figures": 85, "gaps": 80, "total": 87},
        "createdAt": "2025-02-28T10:00:00Z",
        "lastModified": "2025-04-24T16:00:00Z",
    },
]


def _now() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _load() -> list:
    try:
        if os.path.exists(PACKAGES_FILE):
            with open(PACKAGES_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        return []
    except Exception as e:
        logger.error('PrionPacks load error: %s', e)
        return []


def _save(packages: list) -> None:
    os.makedirs(os.path.dirname(PACKAGES_FILE), exist_ok=True)
    tmp = PACKAGES_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(packages, f, ensure_ascii=False, indent=2)
    os.replace(tmp, PACKAGES_FILE)


def _gen_id(packages: list) -> str:
    nums = []
    for p in packages:
        m = re.match(r'PRP-(\d+)', p.get('id', ''))
        if m:
            nums.append(int(m.group(1)))
    return f'PRP-{(max(nums) + 1 if nums else 1):03d}'


def bootstrap_demo_data() -> None:
    if not _load():
        _save(DEMO_PACKAGES)
        logger.info('PrionPacks: seeded %d demo packages', len(DEMO_PACKAGES))


def list_packages() -> list:
    return _load()


def get_package(pkg_id: str) -> dict | None:
    return next((p for p in _load() if p['id'] == pkg_id), None)


def create_package(data: dict) -> dict:
    packages = _load()
    now = _now()
    pkg = {
        'id': _gen_id(packages),
        'title': (data.get('title') or 'Untitled').strip(),
        'description': (data.get('description') or '').strip(),
        'type': data.get('type', 'research'),
        'priority': data.get('priority', 'none'),
        'active': bool(data.get('active', True)),
        'coAuthors': (data.get('coAuthors') or ''),
        'affiliations': (data.get('affiliations') or ''),
        'abstract': (data.get('abstract') or ''),
        'authorSummary': (data.get('authorSummary') or ''),
        'introduction': (data.get('introduction') or ''),
        'methods': (data.get('methods') or ''),
        'discussion': (data.get('discussion') or ''),
        'acknowledgments': (data.get('acknowledgments') or ''),
        'funding': (data.get('funding') or ''),
        'conflictsOfInterest': (data.get('conflictsOfInterest') or ''),
        'references': (data.get('references') or ''),
        'credit': (data.get('credit') or ''),
        'investigations': data.get('investigations', {'text': '', 'files': []}),
        'findings': data.get('findings', []),
        'gaps': data.get('gaps', {'missingInfo': []}),
        'scores': data.get('scores', {'findings': 0, 'figures': 0, 'gaps': 0, 'total': 0}),
        'createdAt': now,
        'lastModified': now,
    }
    packages.append(pkg)
    _save(packages)
    return pkg


def update_package(pkg_id: str, data: dict) -> dict | None:
    packages = _load()
    idx = next((i for i, p in enumerate(packages) if p['id'] == pkg_id), None)
    if idx is None:
        return None
    existing = packages[idx]
    updated = {**existing, **data, 'id': pkg_id, 'createdAt': existing['createdAt'], 'lastModified': _now()}
    packages[idx] = updated
    _save(packages)
    return updated


def delete_package(pkg_id: str) -> None:
    _save([p for p in _load() if p['id'] != pkg_id])


def increment_docx_version(pkg_id: str) -> int:
    packages = _load()
    pkg = next((p for p in packages if p['id'] == pkg_id), None)
    if pkg is None:
        return 1
    new_ver = pkg.get('docxVersion', 0) + 1
    pkg['docxVersion'] = new_ver
    pkg['lastModified'] = _now()
    _save(packages)
    return new_ver
