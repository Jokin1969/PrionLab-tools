/* PrionPacks – localStorage persistence */

const PPStorage = (() => {
  const PACKAGES_KEY = 'prionpacks_packages';
  const API_KEY_KEY  = 'prionpacks_api_key';

  function _generateId(packages) {
    if (!packages.length) return 'PRP-001';
    const nums = packages.map(p => {
      const m = p.id.match(/PRP-(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    });
    const next = Math.max(...nums) + 1;
    return 'PRP-' + String(next).padStart(3, '0');
  }

  function loadAll() {
    try {
      const raw = localStorage.getItem(PACKAGES_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.error('PPStorage.loadAll:', e);
      return [];
    }
  }

  function saveAll(packages) {
    try {
      localStorage.setItem(PACKAGES_KEY, JSON.stringify(packages));
      return true;
    } catch (e) {
      console.error('PPStorage.saveAll:', e);
      return false;
    }
  }

  function get(id) {
    return loadAll().find(p => p.id === id) || null;
  }

  function create(data) {
    const packages = loadAll();
    const now = new Date().toISOString();
    const pkg = {
      id: _generateId(packages),
      title: data.title || 'Untitled Package',
      description: data.description || '',
      type: data.type || 'research',
      priority: data.priority || 'none',
      hypothesis: data.hypothesis || '',
      findings: data.findings || [],
      gaps: data.gaps || { missingInfo: [], neededExperiments: [] },
      timeline: data.timeline || { number: null, unit: 'weeks', notes: '' },
      scores: data.scores || { hypothesis: 0, findings: 0, figures: 0, gaps: 0, total: 0 },
      createdAt: now,
      lastModified: now,
    };
    packages.push(pkg);
    saveAll(packages);
    return pkg;
  }

  function update(id, data) {
    const packages = loadAll();
    const idx = packages.findIndex(p => p.id === id);
    if (idx === -1) return null;
    const updated = {
      ...packages[idx],
      ...data,
      id, // id is immutable
      createdAt: packages[idx].createdAt,
      lastModified: new Date().toISOString(),
    };
    packages[idx] = updated;
    saveAll(packages);
    return updated;
  }

  function remove(id) {
    const packages = loadAll().filter(p => p.id !== id);
    saveAll(packages);
  }

  function exportAll() {
    const data = { version: 1, exportedAt: new Date().toISOString(), packages: loadAll() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `prionpacks-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportOne(id) {
    const pkg = get(id);
    if (!pkg) return;
    const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${pkg.id}-${pkg.title.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importFromJSON(jsonText) {
    let parsed;
    try { parsed = JSON.parse(jsonText); } catch { return { ok: false, error: 'Invalid JSON' }; }

    let incoming;
    if (Array.isArray(parsed)) {
      incoming = parsed;
    } else if (parsed.packages && Array.isArray(parsed.packages)) {
      incoming = parsed.packages;
    } else if (parsed.id) {
      incoming = [parsed];
    } else {
      return { ok: false, error: 'Unrecognized format' };
    }

    const existing = loadAll();
    let added = 0, skipped = 0;
    for (const pkg of incoming) {
      if (!pkg.id || !pkg.title) { skipped++; continue; }
      if (existing.find(p => p.id === pkg.id)) { skipped++; continue; }
      existing.push({ ...pkg, lastModified: new Date().toISOString() });
      added++;
    }
    saveAll(existing);
    return { ok: true, added, skipped };
  }

  function getApiKey() {
    return localStorage.getItem(API_KEY_KEY) || '';
  }

  function saveApiKey(key) {
    localStorage.setItem(API_KEY_KEY, key.trim());
  }

  function seedDemoData() {
    if (loadAll().length) return;
    const now = new Date();
    const demos = [
      {
        id: 'PRP-001',
        title: 'Agregación de α-synuclein en modelos transgénicos',
        description: 'Análisis de la formación de agregados proteicos en ratones SNCA triplicados bajo condiciones de estrés oxidativo.',
        type: 'research',
        priority: 'high',
        hypothesis: 'La sobreexpresión de α-synuclein en neuronas dopaminérgicas acelera la formación de cuerpos de Lewy y correlaciona con déficits motores en modelos murinos.',
        findings: [
          { id: 'f1', title: 'Incremento significativo de agregados en SN', titleEnglish: 'Significant increase of aggregates in SN', description: 'Observamos un aumento del 340% en la densidad de agregados de α-synuclein en la sustancia negra a las 12 semanas.', figures: [{ id: 'fig1', description: 'Inmunohistoquímica anti-α-synuclein (×40)' }, { id: 'fig2', description: 'Cuantificación densitométrica de agregados por región cerebral' }] },
          { id: 'f2', title: 'Correlación déficit motor con carga proteica', titleEnglish: 'Correlation between motor deficit and protein load', description: 'El rotarod muestra correlación r=0.87 entre la carga de agregados y la pérdida de coordinación motora.', figures: [{ id: 'fig3', description: 'Test rotarod semanas 4, 8, 12 post-inducción' }] },
        ],
        gaps: { missingInfo: ['Análisis estadístico de cohorte mayor (n<12)', 'Datos de supervivencia neuronal longitudinal'], neededExperiments: ['Western blot cuantitativo en fracciones solubles/insolubles', 'Microscopía confocal co-localización ubiquitina'] },
        timeline: { number: 8, unit: 'weeks', notes: 'Dependiente de disponibilidad de anticuerpos' },
        scores: { hypothesis: 90, findings: 75, figures: 70, gaps: 40, total: 74 },
        createdAt: new Date(now - 30*86400000).toISOString(),
        lastModified: new Date(now - 2*86400000).toISOString(),
      },
      {
        id: 'PRP-002',
        title: 'Mecanismos de transmisión prión-like de tau patológico',
        description: 'Estudio de la propagación transneuronal de tau hiperfosforilado en modelos de tauopatía.',
        type: 'research',
        priority: 'high',
        hypothesis: 'El tau hiperfosforilado se propaga de forma prión-like siguiendo circuitos neuroanatómicos definidos, iniciando en la corteza entorrinal.',
        findings: [
          { id: 'f1', title: 'Propagación axonal de tau-p231', titleEnglish: 'Axonal propagation of tau-p231', description: 'Inyección estereotáxica en corteza entorrinal seguida de detección en hipocampo a 3 meses.', figures: [{ id: 'fig1', description: 'Mapa de propagación por IHC seriada sagital' }, { id: 'fig2', description: 'Cuantificación de neuronas positivas tau-p231 por región' }, { id: 'fig3', description: 'Microscopía electrónica de filamentos tau' }] },
        ],
        gaps: { missingInfo: ['Modelo in vitro de transmisión célula-a-célula'], neededExperiments: ['FRET entre neuronas para confirmar transferencia directa', 'Inhibición con anticuerpos anti-tau extracelular'] },
        timeline: { number: 4, unit: 'months', notes: 'Experimentos FRET requieren setup nuevo' },
        scores: { hypothesis: 85, findings: 60, figures: 80, gaps: 30, total: 65 },
        createdAt: new Date(now - 45*86400000).toISOString(),
        lastModified: new Date(now - 5*86400000).toISOString(),
      },
      {
        id: 'PRP-003',
        title: 'Biomarcadores de LCR en estadios presintomáticos de EPD',
        description: 'Revisión sistemática de marcadores en líquido cefalorraquídeo para diagnóstico precoz de enfermedades priónicas.',
        type: 'review',
        priority: 'medium',
        hypothesis: 'La combinación de RT-QuIC con proteína 14-3-3 y tau total en LCR alcanza sensibilidad >95% en estadio presintomático de EPD.',
        findings: [
          { id: 'f1', title: 'Meta-análisis RT-QuIC 47 estudios', titleEnglish: 'Meta-analysis RT-QuIC 47 studies', description: 'Sensibilidad pooled 92.3% (IC95% 89-95%), especificidad 99.1% en estudios >100 pacientes.', figures: [{ id: 'fig1', description: 'Forest plot sensibilidad/especificidad RT-QuIC' }, { id: 'fig2', description: 'Curva ROC combinación biomarcadores' }] },
          { id: 'f2', title: 'Comparativa técnicas diagnósticas', titleEnglish: 'Comparative diagnostic techniques', description: 'RT-QuIC supera Western blot 14-3-3 en sensibilidad pero no en especificidad para formas atípicas.', figures: [{ id: 'fig3', description: 'Tabla comparativa sensibilidad/especificidad por técnica' }] },
        ],
        gaps: { missingInfo: ['Estudios longitudinales >5 años de seguimiento', 'Datos en variantes genéticas poco frecuentes (FFI, GSS)'], neededExperiments: ['Validación prospectiva en cohorte multicéntrica española'] },
        timeline: { number: 12, unit: 'weeks', notes: 'Pendiente acceso bases de datos Scopus completo' },
        scores: { hypothesis: 80, findings: 85, figures: 75, gaps: 50, total: 78 },
        createdAt: new Date(now - 20*86400000).toISOString(),
        lastModified: new Date(now - 1*86400000).toISOString(),
      },
      {
        id: 'PRP-004',
        title: 'Ensayo fase II: doxiciclina en ECJ esporádica',
        description: 'Protocolo para ensayo clínico aleatorizado de doxiciclina como agente anti-prión en pacientes con ECJ esporádica.',
        type: 'clinical',
        priority: 'high',
        hypothesis: 'La doxiciclina a 100mg/día enlentece la progresión clínica de ECJ esporádica en al menos 2 meses medido por escala CDR.',
        findings: [],
        gaps: { missingInfo: ['Aprobación comité ético CEIC', 'Financiación completa del estudio', 'Protocolo de monitorización de seguridad'], neededExperiments: ['Estudio farmacocinético en pacientes con encefalopatía', 'Análisis de penetración en SNC'] },
        timeline: { number: 18, unit: 'months', notes: 'Reclutamiento en 4 centros nacionales' },
        scores: { hypothesis: 70, findings: 5, figures: 0, gaps: 10, total: 18 },
        createdAt: new Date(now - 10*86400000).toISOString(),
        lastModified: new Date(now - 3*86400000).toISOString(),
      },
      {
        id: 'PRP-005',
        title: 'Caso clínico: ECJ variante con presentación psiquiátrica atípica',
        description: 'Descripción de caso index con inicio psiquiátrico prominente y diagnóstico diferido 14 meses.',
        type: 'case',
        priority: 'low',
        hypothesis: 'Los pacientes con vECJ que debutan con síntomas psiquiátricos prominentes presentan retraso diagnóstico significativo y patrón de resonancia magnética característico con DWI positivo tardío.',
        findings: [
          { id: 'f1', title: 'Evolución clínica y cronología diagnóstica', titleEnglish: 'Clinical evolution and diagnostic timeline', description: 'Mujer 28 años con depresión atípica, alucinaciones visuales 8 meses, mioclonías semana 38, EEG típico semana 52.', figures: [{ id: 'fig1', description: 'Línea temporal síntomas con correlato diagnóstico' }, { id: 'fig2', description: 'Series RM: secuencia DWI meses 6, 10 y 14 post-inicio' }] },
          { id: 'f2', title: 'Análisis neuropatológico post-mortem', titleEnglish: 'Post-mortem neuropathological analysis', description: 'Depósito de PrPsc tipo 2B confirmado, pérdida neuronal severa en caudado y putamen.', figures: [{ id: 'fig3', description: 'IHC PrP Western Western blot post-mortem' }, { id: 'fig4', description: 'Tinción H&E espongiosis cortical y ganglios basales' }] },
        ],
        gaps: { missingInfo: ['Consentimiento publicación familia'], neededExperiments: [] },
        timeline: { number: 3, unit: 'weeks', notes: '' },
        scores: { hypothesis: 85, findings: 90, figures: 85, gaps: 80, total: 87 },
        createdAt: new Date(now - 60*86400000).toISOString(),
        lastModified: new Date(now - 7*86400000).toISOString(),
      },
      {
        id: 'PRP-006',
        title: 'Microglía y neuroinflamación en prionopatías: revisión',
        description: 'Estado del arte sobre el papel de la microglía en la progresión de enfermedades priónicas.',
        type: 'review',
        priority: 'medium',
        hypothesis: 'La activación microglial en enfermedades priónicas tiene un papel dual: neuroprotector en fases iniciales y neurotóxico en fases tardías, mediado por el fenotipo M1/M2.',
        findings: [
          { id: 'f1', title: 'Fenotipo microglial en modelos murinos de scrapie', titleEnglish: 'Microglial phenotype in murine scrapie models', description: 'Revisión de 23 estudios: cambio de M2 a M1 correlaciona con inicio sintomático. Marcadores clave: CD68, Iba1, TREM2.', figures: [{ id: 'fig1', description: 'Tabla resumen cambios fenotípicos por estadio' }] },
        ],
        gaps: { missingInfo: ['Literatura en inglés post-2023', 'Datos en tejido humano post-mortem'], neededExperiments: ['Single-cell RNA-seq en tejido humano de ECJ'] },
        timeline: { number: 6, unit: 'weeks', notes: '' },
        scores: { hypothesis: 75, findings: 45, figures: 30, gaps: 35, total: 48 },
        createdAt: new Date(now - 15*86400000).toISOString(),
        lastModified: new Date(now - 4*86400000).toISOString(),
      },
    ];
    saveAll(demos);
  }

  return { loadAll, saveAll, get, create, update, remove, exportAll, exportOne, importFromJSON, getApiKey, saveApiKey, seedDemoData };
})();
