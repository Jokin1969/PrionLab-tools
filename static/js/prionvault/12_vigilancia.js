
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

    function close() { $('pv-vc-modal').style.display = 'none'; stopPoll(); }

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
      if (!meta) { renderCurrentYear(year); return; }
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
            ${IS_ADMIN && needsWork ? `<button type="button" id="pv-vc-resolve"
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
      if (IS_ADMIN && (r.status === 'ambiguous' || r.status === 'not_found' || r.status === 'error')) {
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

    function renderCurrentYear(year) {
      const needsSetup = !_reports.length;
      $('pv-vc-body').innerHTML = `
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">
          Vigilancia competitiva ${year}</div>
        <h3 style="margin:2px 0 10px;font-size:18px;color:#0F3460;">Nuevo informe ${year}</h3>
        ${needsSetup ? `
          <div style="padding:12px 14px;border-radius:10px;background:#fffbeb;border:1px solid #fde68a;
                      font-size:13px;color:#92400e;margin-bottom:14px;">
            Todavía no se han cargado los informes de años anteriores.
            ${IS_ADMIN ? `<div style="margin-top:8px;"><button type="button" id="pv-vc-setup"
                style="padding:6px 12px;border-radius:7px;border:none;background:#0F3460;color:#fff;
                       font-size:12.5px;cursor:pointer;">Cargar informes 2018–2025 y crear sus colecciones</button></div>
              <div id="pv-vc-progress"></div>` : ''}
          </div>` : ''}
        <p style="font-size:13.5px;color:#374151;line-height:1.6;">
          Aquí se generará con IA el informe de ${year} a partir de los artículos de la biblioteca,
          usando como referencia el estilo y los temas de los informes anteriores:
        </p>
        <ol style="font-size:13.5px;color:#374151;line-height:1.7;">
          <li><strong>Selección</strong> de los artículos más relevantes publicados en ${year}.</li>
          <li><strong>Clasificación</strong> en temas, teniendo en cuenta los de años anteriores.</li>
          <li><strong>Redacción</strong> del informe con el formato requerido (máx. 3.500 caracteres,
              ¼ contexto, ½ avances con PMID/DOI, ¼ perspectivas para ${year + 1}).</li>
        </ol>
        <p style="font-size:12.5px;color:#9ca3af;">Próximamente.</p>`;
      $('pv-vc-setup')?.addEventListener('click', startResolve);
    }

    function wire() {
      const btn = $('btn-vigilancia');
      if (!btn || btn.dataset.wired) return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', open);
      document.querySelectorAll('#pv-vc-modal [data-vc-close]').forEach(el =>
        el.addEventListener('click', close));
    }

    return { open, close, wire };
  })();
