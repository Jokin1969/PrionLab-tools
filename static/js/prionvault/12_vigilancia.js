
  // ── Vigilancia competitiva (ISO 56001 yearly report) ───────────────────
  // Miscelánea → "🔭 Vigilancia competitiva". Left: one entry per year
  // (historical reports digested from the lab's .docx) plus the current
  // year. Right: the report text with every citation linked to its
  // PrionVault article (click → detail modal), the list of references and
  // how each was resolved, and buttons to filter the listing by that
  // year's collection ("VC <year>") or by the whole VC group. Admins run
  // the reference resolution/import and fix ambiguous references.
  const PVVigilancia = (() => {
    const $ = id => document.getElementById(id);
    const GROUP = 'Vigilancia competitiva';
    const CURRENT_YEAR = new Date().getFullYear();
    let _reports = [];
    let _selected = null;
    let _poll = null;

    const STATUS = {
      linked:    ['#15803d', '✓', 'En PrionVault'],
      created:   ['#15803d', '＋', 'Importado ahora a PrionVault'],
      ambiguous: ['#b45309', '?', 'Ambiguo — elige el artículo correcto'],
      not_found: ['#b91c1c', '✗', 'No encontrado'],
      error:     ['#b91c1c', '!', 'Error al resolver'],
      pending:   ['#9ca3af', '…', 'Pendiente'],
    };

    function close() {
      $('pv-vc-modal').style.display = 'none'; stopPoll();
      if (_genPoll) { clearInterval(_genPoll); _genPoll = null; }
    }

    async function open() {
      $('pv-vc-modal').style.display = 'flex';
      await loadList();
      if (_selected == null) {
        const last = _reports.length ? _reports[_reports.length - 1].year : CURRENT_YEAR;
        select(last);
      } else {
        select(_selected);
      }
    }

    async function loadList() {
      const nav = $('pv-vc-years');
      try {
        const r = await api('/vc/reports');
        _reports = r.reports || [];
        if (r.status && r.status.running) startPoll();
      } catch (e) {
        nav.innerHTML = `<p style="color:#b91c1c;font-size:12px;">Error: ${esc(e.message)}</p>`;
        return;
      }
      renderNav();
    }

    function renderNav() {
      const nav = $('pv-vc-years');
      const item = (year, label, sub, extra = '') => `
        <button type="button" data-year="${year}"
                style="display:block;width:100%;text-align:left;border:none;cursor:pointer;
                       border-radius:8px;padding:8px 10px;margin-bottom:4px;font-size:13px;
                       background:${_selected === year ? '#0F3460' : 'transparent'};
                       color:${_selected === year ? '#fff' : '#111827'};">
          <strong>${esc(label)}</strong>${extra}
          <span style="display:block;font-size:11px;opacity:.75;">${esc(sub)}</span>
        </button>`;
      const hasCurrent = _reports.some(r => r.year === CURRENT_YEAR);
      let html = '';
      if (!hasCurrent) html += item(CURRENT_YEAR, `VC ${CURRENT_YEAR}`, 'Nuevo informe', ' ✨');
      html += _reports.slice().reverse().map(r =>
        item(r.year, `VC ${r.year}`,
             r.status === 'draft' ? 'Borrador (generador)' :
             r.refs ? `${r.resolved}/${r.refs} artículos` : 'sin referencias',
             r.ambiguous || r.missing ? ' <span style="color:#f59e0b;">●</span>' : '')).join('');
      html += `
        <div style="border-top:1px solid #e5e7eb;margin-top:8px;padding-top:8px;">
          <button type="button" id="pv-vc-all"
                  style="width:100%;padding:7px 8px;border-radius:7px;border:1px solid #d1d5db;
                         background:#fff;font-size:12px;cursor:pointer;">
            📚 Ver todas las VC en el listado
          </button>
        </div>`;
      nav.innerHTML = html;
      nav.querySelectorAll('[data-year]').forEach(b =>
        b.addEventListener('click', () => select(Number(b.dataset.year))));
      $('pv-vc-all')?.addEventListener('click', () => filterListing({ group: GROUP }));
    }

    function filterListing({ group = null, collectionId = null }) {
      state.collectionGroup = group;
      state.collectionSubgroup = null;
      state.collectionId = collectionId;
      state.page = 1;
      close();
      try { repaintCollectionSelection(); refreshFilterIndicators(); } catch (_) { /* optional */ }
      loadArticles();
    }

    async function select(year) {
      _selected = year;
      renderNav();
      const body = $('pv-vc-body');
      const meta = _reports.find(r => r.year === year);
      if (!meta || meta.status === 'draft') { renderGenerator(year); return; }
      body.innerHTML = '<p style="color:#9ca3af;">Cargando…</p>';
      let rep;
      try { rep = await api(`/vc/reports/${year}`); }
      catch (e) { body.innerHTML = `<p style="color:#b91c1c;">Error: ${esc(e.message)}</p>`; return; }
      if (_selected !== year) return;
      renderReport(rep, meta);
    }

    // Link every citation in the text to its reference: DOIs, PMIDs and
    // "Author et al. year" strings are swapped for placeholders before
    // escaping, then turned into anchors.
    function linkText(paragraph, refs) {
      const needles = [];
      refs.forEach(r => {
        [r.doi, r.pmid, r.ref_key.startsWith('ay:') ? r.cite : null]
          .filter(Boolean).forEach(n => needles.push([n, r]));
      });
      needles.sort((a, b) => b[0].length - a[0].length);
      const slots = [];
      let txt = paragraph;
      needles.forEach(([n, r]) => {
        if (!txt.includes(n)) return;
        txt = txt.split(n).join(`\u0000${slots.length}\u0000`);
        slots.push([n, r]);
      });
      let html = esc(txt);
      html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => {
        const [n, r] = slots[Number(i)];
        const [color] = STATUS[r.status] || STATUS.pending;
        return `<a href="#" class="pv-vc-cite" data-ref="${r.id}"
                   title="${esc(r.article_title || STATUS[r.status]?.[2] || '')}"
                   style="color:${color};text-decoration:underline dotted;">${esc(n)}</a>`;
      });
      return html;
    }

    function renderReport(rep, meta) {
      const body = $('pv-vc-body');
      const chars = rep.paragraphs.join(' ').length;
      const counts = {};
      rep.refs.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
      const needsWork = (counts.pending || 0) + (counts.ambiguous || 0) + (counts.not_found || 0) + (counts.error || 0);
      body.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start;">
          <div style="min-width:0;flex:1;">
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">
              Vigilancia competitiva ${rep.year}</div>
            <h3 style="margin:2px 0 4px;font-size:18px;color:#0F3460;font-family:'Times New Roman',serif;">
              ${esc(rep.title)}</h3>
            <div style="font-size:13px;color:#374151;font-style:italic;">${esc(rep.authors)}</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            ${meta.collection_id ? `<button type="button" id="pv-vc-filter-year"
                style="padding:6px 12px;border-radius:7px;border:none;background:#0F3460;color:#fff;
                       font-size:12.5px;cursor:pointer;">Ver los ${meta.resolved} artículos en el listado</button>` : ''}
            ${IS_VC_EDITOR && rep.status === 'final' ? `<button type="button" id="pv-vc-reopen"
                style="padding:6px 12px;border-radius:7px;border:1px solid #d1d5db;background:#fff;color:#374151;
                       font-size:12.5px;cursor:pointer;">✏️ Reabrir para editar</button>` : ''}
            <a href="${API}/vc/reports/${rep.year}/docx"
               style="padding:6px 12px;border-radius:7px;border:1px solid #d1d5db;background:#fff;
                      color:#374151;font-size:12.5px;text-decoration:none;">⬇ Word</a>
            ${IS_VC_EDITOR && needsWork ? `<button type="button" id="pv-vc-resolve"
                style="padding:6px 12px;border-radius:7px;border:1px solid #0F3460;background:#fff;
                       color:#0F3460;font-size:12.5px;cursor:pointer;">Resolver referencias pendientes</button>` : ''}
          </div>
        </div>
        <div id="pv-vc-progress"></div>
        <div style="margin:14px 0 4px;font-size:11.5px;color:#6b7280;">
          ${chars.toLocaleString('es-ES')} caracteres · ${rep.refs.length} referencias
          ${Object.entries(counts).map(([k, n]) =>
            `· <span style="color:${(STATUS[k] || STATUS.pending)[0]};">${n} ${esc((STATUS[k] || STATUS.pending)[2].toLowerCase())}</span>`).join(' ')}
        </div>
        <article style="font-family:'Times New Roman',serif;font-size:15px;line-height:1.6;color:#111827;
                        text-align:justify;">
          ${rep.paragraphs.map(p => `<p style="margin:0 0 12px;">${linkText(p, rep.refs)}</p>`).join('')}
        </article>
        <h4 style="margin:18px 0 8px;font-size:14px;color:#111827;">Referencias</h4>
        <div id="pv-vc-refs">${rep.refs.map(refRow).join('')}</div>`;

      body.querySelectorAll('.pv-vc-cite').forEach(a => a.addEventListener('click', ev => {
        ev.preventDefault();
        const r = rep.refs.find(x => String(x.id) === a.dataset.ref);
        if (r && r.article_id) openDetail(r.article_id);
        else document.getElementById(`pv-vc-ref-${a.dataset.ref}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }));
      body.querySelectorAll('[data-open-article]').forEach(b => b.addEventListener('click', () =>
        openDetail(b.dataset.openArticle)));
      $('pv-vc-filter-year')?.addEventListener('click', () => filterListing({ collectionId: meta.collection_id }));
      $('pv-vc-resolve')?.addEventListener('click', startResolve);
      $('pv-vc-reopen')?.addEventListener('click', async () => {
        try { await api(`/vc/draft/${rep.year}/reopen`, { method: 'POST' }); await loadList(); select(rep.year); }
        catch (e) { alert('Error: ' + e.message); }
      });
      body.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () =>
        pick(Number(b.dataset.ref), b.dataset.pick)));
      body.querySelectorAll('[data-pick-input]').forEach(f => f.addEventListener('submit', ev => {
        ev.preventDefault();
        const v = (f.querySelector('input').value || '').trim();
        if (v) pick(Number(f.dataset.pickInput), v);
      }));
    }

    function refRow(r) {
      const [color, icon, label] = STATUS[r.status] || STATUS.pending;
      const ident = r.doi ? `doi:${r.doi}` : r.pmid ? `PMID: ${r.pmid}` : '';
      const art = r.article_id ? `
          <button type="button" data-open-article="${r.article_id}"
                  style="all:unset;cursor:pointer;color:#0F3460;font-weight:600;">
            ${esc(r.article_title || '(sin título)')}</button>
          <span style="color:#6b7280;"> · ${esc(r.article_journal || '')} ${r.article_year || ''}</span>` : '';
      let fix = '';
      if (IS_VC_EDITOR && (r.status === 'linked' || r.status === 'created')) {
        // Already linked, but maybe to the wrong paper: allow re-assigning.
        fix = `
          <details style="margin:4px 0 0 22px;font-size:11.5px;">
            <summary style="cursor:pointer;color:#9ca3af;">¿No es este artículo? Cambiarlo</summary>
            <form data-pick-input="${r.id}" style="display:flex;gap:6px;margin-top:4px;">
              <input placeholder="PMID correcto" style="width:140px;padding:3px 7px;border:1px solid #d1d5db;
                     border-radius:6px;font-size:12px;">
              <button type="submit" style="padding:3px 10px;border-radius:6px;border:none;background:#0F3460;
                      color:#fff;font-size:12px;cursor:pointer;">Asignar</button>
            </form>
          </details>`;
      } else if (IS_VC_EDITOR && (r.status === 'ambiguous' || r.status === 'not_found' || r.status === 'error')) {
        const cands = Array.isArray(r.candidates) ? r.candidates : [];
        fix = `
          <div style="margin:6px 0 0 22px;">
            ${cands.map(c => `
              <div style="display:flex;gap:8px;align-items:baseline;font-size:12px;margin-bottom:3px;">
                <button type="button" data-ref="${r.id}" data-pick="${esc(c.pmid)}"
                        style="padding:2px 8px;border-radius:6px;border:1px solid #d1d5db;background:#fff;
                               cursor:pointer;font-size:11.5px;">Es este</button>
                <span>${esc(c.title || '')} <span style="color:#9ca3af;">· ${esc(c.journal || '')} ${c.year || ''} · PMID ${esc(c.pmid)}</span></span>
              </div>`).join('')}
            <form data-pick-input="${r.id}" style="display:flex;gap:6px;margin-top:4px;">
              <input placeholder="PMID correcto" style="width:140px;padding:3px 7px;border:1px solid #d1d5db;
                     border-radius:6px;font-size:12px;">
              <button type="submit" style="padding:3px 10px;border-radius:6px;border:none;background:#0F3460;
                      color:#fff;font-size:12px;cursor:pointer;">Asignar</button>
            </form>
          </div>`;
      }
      return `
        <div id="pv-vc-ref-${r.id}" style="padding:7px 0;border-bottom:1px solid #f3f4f6;font-size:12.5px;">
          <span title="${esc(label)}" style="display:inline-block;width:18px;color:${color};font-weight:700;">${icon}</span>
          <span style="color:#374151;">${esc(r.cite || '')}</span>
          <span style="color:#9ca3af;"> ${esc(ident)}</span>
          ${art ? `<div style="margin:2px 0 0 22px;">${art}</div>` : ''}
          ${r.note ? `<div style="margin:2px 0 0 22px;color:#9ca3af;font-size:11.5px;">${esc(r.note)}</div>` : ''}
          ${fix}
        </div>`;
    }

    async function pick(refId, pmid) {
      try {
        await api(`/vc/refs/${refId}/pick`, { method: 'POST', body: JSON.stringify({ pmid }) });
        await loadList();
        select(_selected);
      } catch (e) { alert('Error: ' + e.message); }
    }

    async function startResolve() {
      try {
        await api('/vc/resolve', { method: 'POST', body: JSON.stringify({}) });
      } catch (e) {
        if (!/already_running/.test(e.message)) { alert('Error: ' + e.message); return; }
      }
      startPoll();
    }

    function startPoll() {
      if (_poll) return;
      const tick = async () => {
        let s;
        try { s = await api('/vc/resolve/status'); } catch (_) { return; }
        const box = $('pv-vc-progress');
        if (box) {
          box.innerHTML = s.running ? `
            <div style="margin-top:10px;padding:8px 12px;border-radius:8px;background:#eff6ff;
                        color:#1e40af;font-size:12.5px;">
              Resolviendo referencias… ${s.done}/${s.total}
              (✓ ${s.linked + s.created}, ? ${s.ambiguous}, ✗ ${s.not_found + s.errors})
              ${s.current ? `<div style="font-size:11.5px;opacity:.8;">${esc(s.current)}</div>` : ''}
              ${s.note ? `<div style="font-size:11.5px;opacity:.8;">${esc(s.note)}</div>` : ''}
            </div>` : '';
        }
        if (!s.running) {
          stopPoll();
          await loadList();
          if (_selected != null) select(_selected);
        }
      };
      tick();
      _poll = setInterval(tick, 3000);
    }
    function stopPoll() { if (_poll) { clearInterval(_poll); _poll = null; } }

    // ── Generator (current year) ─────────────────────────────────────────
    let _genPoll = null;
    const btnCss = (primary) => `padding:7px 14px;border-radius:8px;font-size:12.5px;cursor:pointer;
      ${primary ? 'border:none;background:#0F3460;color:#fff;' : 'border:1px solid #d1d5db;background:#fff;color:#374151;'}`;

    async function renderGenerator(year) {
      const body = $('pv-vc-body');
      const needsSetup = !_reports.some(r => r.status !== 'draft');
      body.innerHTML = '<p style="color:#9ca3af;">Cargando…</p>';
      let d;
      try { d = await api(`/vc/draft/${year}`); }
      catch (e) { body.innerHTML = `<p style="color:#b91c1c;">Error: ${esc(e.message)}</p>`; return; }
      if (_selected !== year) return;
      const items = d.items || [];
      const sel = items.filter(i => i.selected);
      const themes = Array.isArray(d.themes) ? d.themes : [];
      const job = d.job || {};
      const busy = !!job.running;
      const check = d.check;
      const dis = busy || !IS_VC_EDITOR ? 'disabled' : '';

      body.innerHTML = `
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">
          Vigilancia competitiva ${year} · generador</div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
          <h3 style="margin:2px 0 6px;font-size:18px;color:#0F3460;">Informe ${year}</h3>
          <button type="button" id="pv-vc-howto" style="${btnCss(false)}">❓ ¿Cómo se hace el informe?</button>
        </div>
        ${needsSetup ? `
          <div style="padding:10px 14px;border-radius:10px;background:#fffbeb;border:1px solid #fde68a;
                      font-size:13px;color:#92400e;margin-bottom:12px;">
            Primero carga los informes anteriores: la IA los usa como memoria y modelo de estilo.
            ${IS_VC_EDITOR ? `<div style="margin-top:8px;"><button type="button" id="pv-vc-setup" style="${btnCss(true)}">
              Cargar informes 2018–2025 y crear sus colecciones</button></div><div id="pv-vc-progress"></div>` : ''}
          </div>` : ''}
        <div id="pv-vc-genjob"></div>

        <section style="border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;margin:12px 0;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
            <div><strong>1 · Selección</strong>
              <span style="color:#6b7280;font-size:12.5px;"> — ${d.candidates_total || 0} candidatos de ${year}
              (inventario PubMed + biblioteca) · <strong>${sel.length}</strong> seleccionados</span></div>
            ${IS_VC_EDITOR ? `<span style="display:flex;gap:6px;align-items:center;">
              <label for="pv-vc-n" style="font-size:12.5px;color:#374151;cursor:help;"
                     title="Cuántos artículos dejará preseleccionados la IA (los mejor puntuados) para citar en el informe. Las VC 2024–2025 citaron unos 38 en 3.500 caracteres: más artículos = más citas pero menos espacio para cada una. Entre 5 y 80. Los que marques o desmarques a mano se respetan.">
                Nº de artículos a citar <span style="color:#9ca3af;">ⓘ</span></label>
              <input id="pv-vc-n" type="number" min="5" max="80" value="38"
                     title="Cuántos artículos dejará preseleccionados la IA para citar en el informe (5–80)."
                     style="width:58px;padding:5px 6px;border:1px solid #d1d5db;border-radius:6px;font-size:12.5px;">
              <button type="button" id="pv-vc-run-select" style="${btnCss(true)}" ${dis}>
                ${items.length ? 'Volver a seleccionar' : 'Seleccionar artículos con IA'}</button></span>` : ''}
          </div>
          <p style="font-size:12px;color:#6b7280;margin:6px 0 0;">Cribado por título de todos los candidatos; el modelo
            más potente valora los ~120 mejores con su abstract, el resumen IA del texto completo y tus notas (si están en la
            biblioteca), cuartil SCImago, citas (OpenAlex) y señales del laboratorio (Journal Club, valoraciones, hitos), y
            elige un conjunto equilibrado y sin redundancias. Puedes marcar/desmarcar y añadir por PMID antes de seguir.</p>
          <p style="font-size:12px;color:#3730a3;margin:6px 0 0;">📌 <strong>Proponer artículos:</strong> todo lo que metáis
            en la colección <em>VC ${year}</em> (grupo <em>Vigilancia competitiva</em> del sidebar) entra aquí seleccionado,
            sea del año que sea. Si después lo desmarcas aquí, se respeta.</p>
          ${items.length ? `
            <div style="max-height:340px;overflow-y:auto;margin-top:8px;border-top:1px solid #f3f4f6;">
              ${items.map(itemRow).join('')}
            </div>` : ''}
          ${IS_VC_EDITOR ? `<form id="pv-vc-add" style="display:flex;gap:6px;margin-top:8px;">
              <input placeholder="Añadir por PMID" style="width:150px;padding:5px 8px;border:1px solid #d1d5db;
                     border-radius:6px;font-size:12.5px;">
              <button type="submit" style="${btnCss(false)}">Añadir</button></form>` : ''}
        </section>

        <section style="border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;margin:12px 0;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
            <div><strong>2 · Temas</strong>
              <span style="color:#6b7280;font-size:12.5px;"> — agrupa los seleccionados recordando las VC anteriores</span></div>
            ${IS_VC_EDITOR ? `<button type="button" id="pv-vc-run-themes" style="${btnCss(true)}"
                 ${dis || (!sel.length ? 'disabled' : '')}>${themes.length ? 'Rehacer temas' : 'Agrupar en temas'}</button>` : ''}
          </div>
          ${IS_VC_EDITOR ? `<textarea id="pv-vc-hints" rows="3"
              title="La IA los usará si algún artículo seleccionado encaja; si no encaja ninguno, los omite. Además puede crear otros temas para los artículos que no encajen en ninguno. Se guardan para este año."
              placeholder="Temas sugeridos (opcional, uno por línea), p. ej.:\nTerapias antisentido (ASO)\nDiagnóstico precoz con RT-QuIC\nCWD en Europa"
              style="width:100%;margin-top:8px;padding:6px 8px;border:1px solid #d1d5db;border-radius:8px;
                     font-size:12.5px;box-sizing:border-box;">${esc(d.theme_hints || '')}</textarea>`
            : (d.theme_hints ? `<div style="font-size:12px;color:#6b7280;margin-top:6px;">Temas sugeridos: ${esc(d.theme_hints).replace(/\n/g, ' · ')}</div>` : '')}
          ${themes.map(t => `
            <div style="margin-top:10px;padding:8px 10px;border-radius:8px;background:#f9fafb;">
              <div style="font-weight:600;color:#0F3460;font-size:13px;">${esc(t.name || '')}
                <span style="color:#9ca3af;font-weight:400;">· ${(t.pmids || []).length} artículos</span></div>
              <div style="font-size:12.5px;color:#374151;margin-top:2px;">${esc(t.summary || '')}</div>
              ${t.continuity ? `<div style="font-size:12px;color:#6b7280;margin-top:2px;">↺ ${esc(t.continuity)}</div>` : ''}
            </div>`).join('')}
        </section>

        <section style="border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;margin:12px 0;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
            <div><strong>3 · Redacción</strong>
              <span style="color:#6b7280;font-size:12.5px;"> — formato del email, máx. 3.500 caracteres,
              estilo de las VC anteriores</span></div>
            ${IS_VC_EDITOR ? `<button type="button" id="pv-vc-run-write" style="${btnCss(true)}"
                 ${dis || (!sel.length ? 'disabled' : '')}>${d.paragraphs.length ? 'Volver a redactar' : 'Redactar informe'}</button>` : ''}
          </div>
          ${IS_VC_EDITOR ? `<div style="font-size:12.5px;color:#374151;margin-top:8px;"
                 title="2024 y 2025 citaron con PMID; 2021–2023 con DOI. El email admite ambos.">
              Citas en el texto:
              <label style="margin-left:6px;"><input type="radio" name="pv-vc-style" value="pmid" ${d.cite_style !== 'doi' ? 'checked' : ''}> (PMID: …)</label>
              <label style="margin-left:8px;"><input type="radio" name="pv-vc-style" value="doi" ${d.cite_style === 'doi' ? 'checked' : ''}> (doi: …)</label>
              <span style="color:#9ca3af;"> · se aplica al redactar o al pedir cambios</span></div>` : ''}
          ${IS_VC_EDITOR ? `<textarea id="pv-vc-instr" rows="2" placeholder="Indicaciones opcionales para la IA (p. ej. «da más peso al ensayo clínico», «menos CWD»)…"
              style="width:100%;margin-top:8px;padding:6px 8px;border:1px solid #d1d5db;border-radius:8px;
                     font-size:12.5px;box-sizing:border-box;"></textarea>` : ''}
          ${d.paragraphs.length ? draftEditor(d, check) : ''}
        </section>
        ${d.paragraphs.length ? reviseSection(d, dis) : ''}`;

      $('pv-vc-setup')?.addEventListener('click', startResolve);
      $('pv-vc-howto')?.addEventListener('click', () => openHowto(year));
      $('pv-vc-run-select')?.addEventListener('click', () => run(year, 'select', { n: Number($('pv-vc-n').value) || 38 }));
      $('pv-vc-run-themes')?.addEventListener('click', () => run(year, 'themes', { hints: $('pv-vc-hints')?.value || '' }));
      $('pv-vc-run-write')?.addEventListener('click', () => run(year, 'write', { instructions: $('pv-vc-instr').value }));
      body.querySelectorAll('[data-vc-toggle]').forEach(cb => cb.addEventListener('change', async () => {
        try { await api(`/vc/items/${cb.dataset.vcToggle}`, { method: 'POST', body: JSON.stringify({ selected: cb.checked }) }); }
        catch (e) { alert('Error: ' + e.message); cb.checked = !cb.checked; }
      }));
      body.querySelectorAll('[data-open-article]').forEach(b => b.addEventListener('click', () => openDetail(b.dataset.openArticle)));
      $('pv-vc-add')?.addEventListener('submit', async ev => {
        ev.preventDefault();
        const v = (ev.target.querySelector('input').value || '').trim();
        if (!v) return;
        try { await api(`/vc/draft/${year}/add`, { method: 'POST', body: JSON.stringify({ pmid: v }) }); renderGenerator(year); }
        catch (e) { alert('Error: ' + e.message); }
      });
      body.querySelectorAll('input[name="pv-vc-style"]').forEach(r => r.addEventListener('change', async () => {
        try { await api(`/vc/draft/${year}/cite-style`, { method: 'POST', body: JSON.stringify({ style: r.value }) }); }
        catch (e) { alert('Error: ' + e.message); }
      }));
      $('pv-vc-revise')?.addEventListener('click', () => {
        const req = ($('pv-vc-request').value || '').trim();
        if (!req) { $('pv-vc-request').focus(); return; }
        run(year, 'revise', { request: req });
      });
      body.querySelectorAll('[data-vc-restore]').forEach(b => b.addEventListener('click', async () => {
        if (!await pvConfirm('¿Restaurar esta versión? La actual queda guardada en el historial.')) return;
        try { await api(`/vc/draft/${year}/versions/${b.dataset.vcRestore}/restore`, { method: 'POST' }); renderGenerator(year); }
        catch (e) { alert('Error: ' + e.message); }
      }));
      $('pv-vc-accept')?.addEventListener('click', async () => {
        if (!await pvConfirm(`¿Aceptar esta versión como el informe final de ${year}?\n\nSe enlazarán sus artículos citados ` +
                     `(importando los que falten) en la colección «VC ${year}». Podrás reabrirlo si hace falta.`)) return;
        const b = $('pv-vc-accept'); b.disabled = true; b.textContent = 'Aceptando…';
        try {
          const r = await api(`/vc/draft/${year}/accept`, { method: 'POST' });
          alert(`✓ Informe ${year} aceptado. ${r.linked}/${r.cited} artículos citados enlazados en «VC ${year}».`);
          await loadList(); select(year);
        } catch (e) { alert('Error: ' + e.message); b.disabled = false; b.textContent = '✅ Aceptar versión final'; }
      });
      wireDraftEditor(year);
      if (busy) startGenPoll(year);
    }

    // Free-text revision loop + version history + final acceptance.
    function reviseSection(d, dis) {
      const KIND = { generated: '🤖 Redactado', revision: '💬 Cambios IA', manual: '✍️ Edición manual',
                     restored: '↺ Restaurada', final: '✅ Final' };
      const versions = d.versions || [];
      return `
        <section style="border:1px solid #c7d2fe;background:#f8faff;border-radius:12px;padding:12px 14px;margin:12px 0;">
          <div><strong>4 · Pedir cambios a la IA</strong>
            <span style="color:#6b7280;font-size:12.5px;"> — en lenguaje libre, hasta que estéis conformes</span></div>
          ${IS_VC_EDITOR ? `
            <textarea id="pv-vc-request" rows="4" placeholder="Ejemplos:
· Después de la frase sobre el ensayo con ASO, añade que los primeros datos de seguridad se esperan en 2027.
· Quita la frase sobre los organoides.
· Añade el artículo PMID 41234567 en la parte de diagnóstico; quita el de Smith sobre CWD.
· Da más protagonismo a los biomarcadores y acorta la introducción."
              style="width:100%;margin-top:8px;padding:8px 10px;border:1px solid #c7d2fe;border-radius:8px;
                     font-size:13px;box-sizing:border-box;"></textarea>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">
              <button type="button" id="pv-vc-revise" style="${btnCss(true)}" ${dis}>💬 Aplicar cambios</button>
              <span style="font-size:11.5px;color:#6b7280;align-self:center;">Cambia solo lo que pides; si añades o quitas
                artículos actualiza la selección; vuelve a validar longitud y a revisar los hechos de lo modificado.</span>
            </div>` : ''}
          ${versions.length ? `
            <details style="margin-top:10px;" ${versions.length > 1 ? 'open' : ''}>
              <summary style="cursor:pointer;font-size:12.5px;color:#374151;">Historial de versiones (${versions.length})</summary>
              <div style="margin-top:6px;max-height:260px;overflow-y:auto;">
                ${versions.map((v, k) => `
                  <div style="padding:6px 0;border-bottom:1px solid #e5e7eb;font-size:12px;">
                    <div style="display:flex;justify-content:space-between;gap:8px;">
                      <span><strong>#${v.id}</strong> ${KIND[v.kind] || esc(v.kind)}
                        <span style="color:#9ca3af;"> · ${esc(new Date(v.created_at).toLocaleString('es-ES'))} · ${v.chars} car.</span>
                        ${k === 0 ? '<span style="color:#15803d;"> · actual</span>' : ''}</span>
                      ${IS_VC_EDITOR && k > 0 ? `<button type="button" data-vc-restore="${v.id}"
                         style="padding:1px 8px;border-radius:6px;border:1px solid #d1d5db;background:#fff;cursor:pointer;font-size:11.5px;">Restaurar</button>` : ''}
                    </div>
                    ${v.request ? `<div style="color:#3730a3;margin-top:2px;">Pedido: ${esc(v.request)}</div>` : ''}
                    ${v.summary ? `<div style="color:#6b7280;margin-top:2px;">${esc(v.summary)}</div>` : ''}
                  </div>`).join('')}
              </div>
            </details>` : ''}
          ${IS_VC_EDITOR ? `
            <div style="margin-top:12px;padding-top:10px;border-top:1px solid #c7d2fe;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
              <button type="button" id="pv-vc-accept" style="${btnCss(true)}background:#15803d;" ${dis}>✅ Aceptar versión final</button>
              <span style="font-size:11.5px;color:#6b7280;">Pasa a ser el informe oficial de ${d.year}: sus artículos citados se enlazan
                en la colección «VC ${d.year}» y servirá de memoria para el año siguiente. Se puede reabrir.</span>
            </div>` : ''}
        </section>`;
    }

    // Explains the pipeline and, above all, what the lab can do BEFORE
    // generating so the AI has better material.
    function openHowto(year) {
      const sec = (t, body) => `<h4 style="margin:16px 0 6px;font-size:14px;color:#0F3460;">${t}</h4>${body}`;
      const ul = items => `<ul style="margin:0 0 0 18px;padding:0;font-size:13px;line-height:1.6;color:#374151;">${items.map(x => `<li>${x}</li>`).join('')}</ul>`;
      $('pv-vc-howto-body').innerHTML = `
        <p style="color:#6b7280;font-size:12.5px;margin:0 0 6px;">
          El informe ${year} se genera en tres pasos con IA, usando como memoria y modelo de estilo las VC de años anteriores.
          La calidad depende mucho del material que encuentre en PrionVault: abajo tienes qué podéis preparar antes.</p>

        ${sec('1 · Selección de artículos', ul([
          `<strong>Candidatos:</strong> todo lo publicado en ${year} que hay en el inventario de PubMed de PrionVault y en la biblioteca.`,
          '<strong>Cribado por título</strong> de todos ellos, por lotes, para quedarse con unos 120.',
          '<strong>Valoración profunda</strong> de esos ~120 con el modelo más potente: abstract, cuartil SCImago y, si el artículo está en la biblioteca, su <em>ficha de evidencia</em> (ver abajo).',
          '<strong>Citas recibidas</strong> (OpenAlex) como medida de impacto temprano.',
          '<strong>Selección de conjunto:</strong> la IA elige los N artículos (38 por defecto) para que el grupo sea equilibrado entre áreas y sin redundancias, y explica cada elección.',
        ]))}

        ${sec('2 · Temas', ul([
          'Agrupa los seleccionados en 4–6 temas, ordenados como debe fluir el texto.',
          `Enlaza cada tema con las VC anteriores y con lo que la VC ${year - 1} esperaba para ${year}.`,
        ]))}

        ${sec('3 · Redacción y revisión', ul([
          'Escribe el informe con el formato pedido: título, autores, ¼ contexto, ½ avances con (PMID: …), ¼ perspectivas; máximo 3.500 caracteres.',
          'Comprueba la longitud, las proporciones y que solo cite los artículos seleccionados; si algo no cumple, se corrige sola.',
          '<strong>Revisión de hechos:</strong> contrasta cada afirmación con la evidencia del artículo que cita (exageraciones, animal frente a humano, atribuciones erróneas) y corrige el texto. Te muestra lo corregido y lo que queda por revisar.',
        ]))}

        <div style="margin-top:18px;padding:12px 14px;border-radius:10px;background:#f0fdf4;border:1px solid #bbf7d0;">
          <h4 style="margin:0 0 6px;font-size:14px;color:#15803d;">✅ Qué podéis hacer vosotros para que el informe salga mejor</h4>
          <p style="font-size:12.5px;color:#374151;margin:0 0 6px;">Todo esto lo lee la IA y aparece como etiqueta junto a cada artículo:</p>
          ${ul([
            '<strong>Tener en la biblioteca los artículos importantes del año</strong> (📚). Los que solo están en el inventario de PubMed aportan título y abstract; los de la biblioteca aportan mucho más.',
            '<strong>Subir sus PDFs y lanzar los resúmenes IA</strong> (🧠). El resumen IA sale del texto completo y es la mejor evidencia para elegir y para redactar con precisión.',
            '<strong>Dejar notas adhesivas</strong> (📝) en los artículos clave: por qué importan, qué aportan. Se usan las de quien lanza la selección y las que cualquiera marque con <strong>🔭 Compartir con la VC</strong> en el editor de la nota.',
            '<strong>Presentarlos en el Journal Club</strong> (📖 JC). Es una señal fuerte de que el laboratorio lo consideró relevante.',
            '<strong>Valorarlos con estrellas</strong> (★) y <strong>marcar como hito</strong> (⭐) los que sean un antes y un después.',
            '<strong>Mantener al día el inventario de PubMed</strong> antes de generar, para que no falte nada publicado recientemente.',
            'Las <strong>publicaciones propias del grupo</strong> (🏠) se detectan solas por los autores.',
          ])}
          <p style="font-size:12.5px;color:#374151;margin:8px 0 0;">Estas señales ayudan, pero no sustituyen al criterio científico:
            un avance clave del año entra aunque nadie lo haya anotado, y algo valorado en el laboratorio no entra si es menor.</p>
        </div>

        ${sec('Vuestro control en cada paso', ul([
          'Después de la selección: marcar o desmarcar artículos y añadir otros por PMID (✋). Lo que toquéis a mano se respeta si se vuelve a seleccionar.',
          'Antes de redactar: escribir indicaciones para la IA («más peso al ensayo clínico», «menos CWD»…).',
          'Después: editar el texto a mano, con contador de caracteres, revisar los avisos y descargarlo en Word.',
        ]))}`;
      $('pv-vc-howto-modal').style.display = 'flex';
    }

    function itemRow(i) {
      const link = i.article_id
        ? `<button type="button" data-open-article="${i.article_id}" style="all:unset;cursor:pointer;color:#0F3460;font-weight:600;">${esc(i.title)}</button>`
        : `<a href="https://pubmed.ncbi.nlm.nih.gov/${esc(i.pmid || '')}/" target="_blank" rel="noopener"
              style="color:#0F3460;font-weight:600;text-decoration:none;">${esc(i.title)}</a>`;
      const score = i.score != null ? Math.round(i.score) : (i.screen_score != null ? `t${i.screen_score}` : '–');
      return `
        <label style="display:flex;gap:8px;align-items:flex-start;padding:6px 2px;border-bottom:1px solid #f3f4f6;
                      font-size:12.5px;${i.selected ? '' : 'opacity:.75;'}">
          <input type="checkbox" data-vc-toggle="${i.id}" ${i.selected ? 'checked' : ''} ${IS_VC_EDITOR ? '' : 'disabled'}
                 style="margin-top:2px;">
          <span style="width:34px;flex-shrink:0;text-align:right;color:#0F3460;font-weight:700;">${esc(String(score))}</span>
          <span style="flex:1;min-width:0;">
            ${link}
            <span style="color:#9ca3af;"> · ${esc(i.journal || '')}${i.quartile ? ' · ' + esc(i.quartile) : ''}
              ${i.pmid ? ' · PMID ' + esc(i.pmid) : ''}${i.in_library ? ' · 📚' : ''}${i.manual ? ' · ✋' : ''}</span>
            ${signalChips(i)}
            ${i.reason ? `<div style="color:#6b7280;">${esc(i.reason)}</div>` : ''}
            ${i.theme ? `<div style="color:#7c3aed;font-size:11.5px;">${esc(i.theme)}</div>` : ''}
          </span>
        </label>`;
    }

    // Evidence the AI used beyond title/abstract, shown as small chips.
    function signalChips(i) {
      const sg = i.signals || {};
      const chip = (txt, tip) => `<span title="${esc(tip)}" style="display:inline-block;margin:2px 4px 0 0;
        padding:0 6px;border-radius:9px;background:#eef2ff;color:#3730a3;font-size:10.5px;">${txt}</span>`;
      const out = [];
      if (i.citations != null) out.push(chip(`${i.citations} citas`, 'Citas recibidas hasta hoy (OpenAlex)'));
      if (sg.summary_ai) out.push(chip('🧠 resumen IA', 'La IA leyó el resumen IA del texto completo, no solo el abstract'));
      if (sg.notes) out.push(chip('📝 notas', 'La IA tuvo en cuenta notas adhesivas: las de quien lanzó la selección y las marcadas 🔭 «Compartir con la VC» por cualquiera'));
      if (sg.jc) out.push(chip('📖 JC', 'Presentado en el Journal Club del laboratorio'));
      if (sg.rating) out.push(chip(`★ ${sg.rating}`, 'Valoración media en PrionVault'));
      if (sg.milestone) out.push(chip('⭐ hito', 'Marcado como hito'));
      if (i.own_lab) out.push(chip('🏠 propio', 'Publicación del propio grupo'));
      if ((i.reason || '').startsWith('📌')) out.push(chip('📌 propuesto', 'Lo propusisteis metiéndolo en la colección VC del año'));
      return out.length ? `<div>${out.join('')}</div>` : '';
    }

    function draftEditor(d, check) {
      const ta = (id, val, rows) => `<textarea id="${id}" rows="${rows}" ${IS_VC_EDITOR ? '' : 'readonly'}
          style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box;
                 font-family:'Times New Roman',serif;font-size:14.5px;line-height:1.5;">${esc(val || '')}</textarea>`;
      const p = d.paragraphs.concat(['', '', '']).slice(0, 3);
      return `
        <div style="margin-top:12px;">
          <label style="font-size:11.5px;color:#6b7280;">Título</label>${ta('pv-vc-t', d.title, 1)}
          <label style="font-size:11.5px;color:#6b7280;">Autores</label>${ta('pv-vc-a', d.authors, 1)}
          ${['Contexto (≈¼)', 'Avances del año (≈½)', 'Perspectivas (≈¼)'].map((lab, i) => `
            <label style="font-size:11.5px;color:#6b7280;">${lab} · <span id="pv-vc-c${i}"></span></label>
            ${ta('pv-vc-p' + i, p[i], i === 1 ? 12 : 6)}`).join('')}
          <div id="pv-vc-count" style="font-size:12.5px;margin:6px 0;"></div>
          ${factcheckPanel(d)}
          ${check && check.problems && check.problems.length ? `
            <div style="font-size:12px;color:#b45309;margin-bottom:6px;">Avisos de la validación:
              <ul style="margin:4px 0 0 18px;">${check.problems.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${IS_VC_EDITOR ? `<button type="button" id="pv-vc-save" style="${btnCss(true)}">Guardar cambios</button>` : ''}
            <a href="${API}/vc/reports/${d.year}/docx" style="${btnCss(false)}text-decoration:none;">⬇ Descargar Word</a>
          </div>
        </div>`;
    }

    function factcheckPanel(d) {
      const w = (d.pipeline || {}).write;
      if (!w) return '';
      const fixed = w.factcheck_fixed || [], left = w.factcheck_remaining || [];
      if (!fixed.length && !left.length) {
        return `<div style="font-size:12px;color:#15803d;margin:6px 0;">✓ Revisión de hechos: todas las afirmaciones
          citadas están respaldadas por sus artículos.</div>`;
      }
      const li = x => `<li><strong>${/^\d+$/.test(x.pmid || '') ? 'PMID ' : ''}${esc(x.pmid || '')}</strong>: «${esc(x.quote || '')}» — ${esc(x.problem || '')}</li>`;
      return `
        <details style="font-size:12px;margin:6px 0;" ${left.length ? 'open' : ''}>
          <summary style="cursor:pointer;color:${left.length ? '#b45309' : '#15803d'};">
            Revisión de hechos: ${fixed.length} corregidas automáticamente${left.length ? ` · ${left.length} por revisar` : ''}</summary>
          ${left.length ? `<div style="margin-top:4px;color:#b45309;">Por revisar a mano:</div><ul style="margin:2px 0 0 18px;">${left.map(li).join('')}</ul>` : ''}
          ${fixed.length ? `<div style="margin-top:4px;color:#6b7280;">Detectadas y corregidas:</div><ul style="margin:2px 0 0 18px;color:#6b7280;">${fixed.map(li).join('')}</ul>` : ''}
        </details>`;
    }

    function wireDraftEditor(year) {
      const paras = [0, 1, 2].map(i => $('pv-vc-p' + i)).filter(Boolean);
      if (!paras.length) return;
      const recount = () => {
        const lens = paras.map(t => t.value.trim().length);
        const total = lens.reduce((a, b) => a + b, 0) + 2;
        lens.forEach((n, i) => { const el = $('pv-vc-c' + i); if (el) el.textContent = `${n} car. (${Math.round(100 * n / Math.max(1, total))}%)`; });
        const txt = paras.map(t => t.value).join(' ');
        const ids = new Set([...(txt.match(/\b\d{7,9}\b/g) || []), ...(txt.match(/10\.\d{4,9}\/[^\s;,)\]]+/gi) || []).map(x => x.toLowerCase())]);
        $('pv-vc-count').innerHTML = `<strong style="color:${total > 3500 ? '#b91c1c' : '#15803d'};">
          ${total.toLocaleString('es-ES')} / 3.500 caracteres</strong> · ${ids.size} artículos citados`;
      };
      paras.forEach(t => t.addEventListener('input', recount));
      recount();
      $('pv-vc-save')?.addEventListener('click', async () => {
        try {
          await api(`/vc/draft/${year}/text`, { method: 'PUT', body: JSON.stringify({
            title: $('pv-vc-t').value, authors: $('pv-vc-a').value, paragraphs: paras.map(t => t.value) }) });
          $('pv-vc-save').textContent = '✓ Guardado';
          setTimeout(() => { const b = $('pv-vc-save'); if (b) b.textContent = 'Guardar cambios'; }, 1500);
        } catch (e) { alert('Error: ' + e.message); }
      });
    }

    async function run(year, step, extra = {}) {
      try { await api(`/vc/draft/${year}/run`, { method: 'POST', body: JSON.stringify({ step, ...extra }) }); }
      catch (e) { if (!/already_running/.test(e.message)) { alert('Error: ' + e.message); return; } }
      renderGenerator(year);
    }

    function startGenPoll(year) {
      if (_genPoll) return;
      const tick = async () => {
        let s;
        try { s = await api(`/vc/draft/status?year=${year}`); } catch (_) { return; }
        const box = $('pv-vc-genjob');
        if (box) box.innerHTML = s.running ? `
          <div style="padding:8px 12px;border-radius:8px;background:#eff6ff;color:#1e40af;font-size:12.5px;">
            ⏳ ${esc(s.phase || 'Trabajando…')} ${s.total ? `(${s.done}/${s.total})` : ''}
            ${IS_VC_EDITOR ? `<button type="button" id="pv-vc-stop" style="margin-left:8px;${btnCss(false)}padding:2px 8px;">Parar</button>` : ''}
          </div>` : (s.last_error ? `<div style="padding:8px 12px;border-radius:8px;background:#fef2f2;color:#b91c1c;
            font-size:12.5px;">Error: ${esc(s.last_error)}</div>` : '');
        $('pv-vc-stop')?.addEventListener('click', () => api('/vc/draft/stop', { method: 'POST' }));
        if (!s.running) {
          clearInterval(_genPoll); _genPoll = null;
          await loadList();
          if (_selected === year) renderGenerator(year);
        }
      };
      tick();
      _genPoll = setInterval(tick, 3000);
    }

    function wire() {
      const btn = $('btn-vigilancia');
      if (!btn || btn.dataset.wired) return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', open);
      document.querySelectorAll('#pv-vc-modal [data-vc-close]').forEach(el =>
        el.addEventListener('click', close));
      document.querySelectorAll('#pv-vc-howto-modal [data-vc-howto-close]').forEach(el =>
        el.addEventListener('click', () => { $('pv-vc-howto-modal').style.display = 'none'; }));
    }

    return { open, close, wire };
  })();
