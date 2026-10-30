  // ── Batch AI summary modal ───────────────────────────────────────────
  // ── Bulk DOI / PMID lookup ──────────────────────────────────────────
  function wireBulkLookup() {
    const inlineInput = document.getElementById('pv-bulk-lookup-input');
    const inlineBtn   = document.getElementById('pv-bulk-lookup-btn');
    const modal       = document.getElementById('pv-bulk-lookup-modal');
    const closeBtn    = document.getElementById('pv-bulk-lookup-close');
    const textarea    = document.getElementById('pv-bulk-lookup-text');
    const runBtn      = document.getElementById('pv-bulk-lookup-run');
    const statusEl    = document.getElementById('pv-bulk-lookup-status');
    const resultsEl   = document.getElementById('pv-bulk-lookup-results');
    if (!modal || !inlineInput) return;

    function openModal(seed) {
      modal.style.display = 'flex';
      if (seed !== undefined && seed !== null) textarea.value = seed;
      textarea.focus();
      statusEl.textContent = '';
      resultsEl.innerHTML  = '';
      if (textarea.value.trim()) runLookup();
    }
    function closeModal() { modal.style.display = 'none'; }
    closeBtn.addEventListener('click', closeModal);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', closeModal);

    inlineBtn.addEventListener('click', () => openModal(inlineInput.value.trim()));
    inlineInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        openModal(inlineInput.value.trim());
      }
    });
    runBtn.addEventListener('click', runLookup);

    async function runLookup() {
      const raw = (textarea.value || '').trim();
      if (!raw) {
        statusEl.style.color = '#b91c1c';
        statusEl.textContent = 'Pega al menos un identificador.';
        return;
      }
      runBtn.disabled = true;
      const orig = runBtn.textContent;
      runBtn.textContent = 'Buscando…';
      statusEl.style.color = '#6b7280';
      statusEl.textContent = '';
      resultsEl.innerHTML  = '';
      let r;
      try {
        r = await api('/articles/lookup-bulk', {
          method: 'POST',
          body: JSON.stringify({ identifiers: raw }),
        });
      } catch (e) {
        statusEl.style.color = '#b91c1c';
        statusEl.textContent = 'Error: ' + e.message;
        runBtn.disabled = false;
        runBtn.textContent = orig;
        return;
      }
      runBtn.disabled = false;
      runBtn.textContent = orig;
      renderLookupResults(r);
    }

    function renderLookupResults(r) {
      const total = r.total || 0;
      const found = r.found || 0;
      const notFound = r.not_found || 0;
      const bad = r.unparseable || 0;

      const summary = `
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;font-size:12.5px;">
          <span style="padding:4px 10px;border-radius:20px;background:#f3f4f6;color:#374151;font-weight:600;">
            Total: ${total}
          </span>
          <span style="padding:4px 10px;border-radius:20px;background:#dcfce7;color:#15803d;font-weight:600;">
            ✓ En biblioteca: ${found}
          </span>
          <span style="padding:4px 10px;border-radius:20px;background:#fef3c7;color:#92400e;font-weight:600;">
            ✗ No están: ${notFound}
          </span>
          ${bad ? `<span style="padding:4px 10px;border-radius:20px;background:#fee2e2;color:#b91c1c;font-weight:600;">
            ? Formato no reconocido: ${bad}
          </span>` : ''}
        </div>`;

      const rows = (r.items || []).map((it, i) => {
        const inp = esc(it.input);
        if (it.match) {
          const m = it.match;
          const meta = [m.authors ? esc((m.authors || '').slice(0, 80)) : '',
                        m.year || '', m.journal ? esc(m.journal) : '']
                       .filter(Boolean).join(' · ');
          const badges = [
            m.has_summary ? '<span style="padding:1px 5px;border-radius:4px;font-size:10px;font-weight:600;background:#dbeafe;color:#1d4ed8;">AI</span>' : '',
            m.has_pdf     ? '<span style="padding:1px 5px;border-radius:4px;font-size:10px;font-weight:600;background:#fee2e2;color:#b91c1c;">PDF</span>' : '',
            m.priority    ? `<span style="padding:1px 5px;border-radius:4px;font-size:10px;font-weight:600;background:#f3f4f6;color:#4b5563;">P${m.priority}</span>` : '',
          ].filter(Boolean).join(' ');
          return `
            <tr style="border-bottom:1px solid #f3f4f6;cursor:pointer;"
                onmouseover="this.style.background='#f9fafb'"
                onmouseout="this.style.background=''"
                data-aid="${esc(m.id)}">
              <td style="padding:6px 8px;text-align:center;width:32px;" class="pv-bl-chk-cell">
                <input type="checkbox" class="pv-bl-chk" data-aid="${esc(m.id)}"
                       style="width:15px;height:15px;accent-color:#0F3460;cursor:pointer;">
              </td>
              <td style="padding:6px 8px;font-size:11.5px;color:#9ca3af;font-variant-numeric:tabular-nums;">${i+1}</td>
              <td style="padding:6px 8px;font-size:11px;color:#15803d;font-weight:700;">✓</td>
              <td style="padding:6px 8px;font-size:11.5px;font-family:ui-monospace,monospace;color:#374151;
                         word-break:break-all;max-width:200px;">${inp}</td>
              <td style="padding:6px 8px;">
                <div style="font-size:13px;font-weight:600;color:#111827;">${supHtml(m.title || '(sin título)')}</div>
                <div style="font-size:11.5px;color:#6b7280;margin-top:1px;">${meta} ${badges}</div>
              </td>
            </tr>`;
        }
        const reason = it.kind === 'unknown'
          ? '<span style="color:#b91c1c;">Formato no reconocido</span>'
          : '<span style="color:#92400e;">No está en la biblioteca</span>';
        // Clickable → search the web for it (Google Scholar), so a
        // not-found DOI/PMID can be tracked down and downloaded
        // straight from here instead of copy-pasting it elsewhere.
        const webHref = 'https://scholar.google.com/scholar?q=' + encodeURIComponent(it.input || '');
        return `
          <tr style="border-bottom:1px solid #f3f4f6;">
            <td style="padding:6px 8px;width:32px;"></td>
            <td style="padding:6px 8px;font-size:11.5px;color:#9ca3af;font-variant-numeric:tabular-nums;">${i+1}</td>
            <td style="padding:6px 8px;font-size:11px;color:#b91c1c;font-weight:700;">✗</td>
            <td style="padding:6px 8px;font-size:11.5px;font-family:ui-monospace,monospace;">
              <a href="${webHref}" target="_blank" rel="noopener" title="Buscar en Google Scholar"
                 style="color:#0F3460;word-break:break-all;">${inp} <i class="fas fa-up-right-from-square" style="font-size:9px;"></i></a>
            </td>
            <td style="padding:6px 8px;font-size:12px;">${reason}</td>
          </tr>`;
      }).join('');

      const notFoundItems = (r.items || []).filter(it => !it.match).map(it => it.input);
      const notFoundList  = notFoundItems.join('\n');

      const copyBtn = notFoundList
        ? `<button id="pv-bulk-lookup-copy" type="button"
                   style="padding:5px 11px;border-radius:6px;border:1px solid #d1d5db;background:white;
                          font-size:11.5px;color:#374151;cursor:pointer;">
            <i class="fas fa-clipboard"></i> Copiar los que no están (${notFound + bad})
          </button>`
        : '';

      const addBtn = notFoundList
        ? `<button id="pv-bulk-lookup-add" type="button"
                   style="padding:5px 11px;border-radius:6px;border:1px solid #0F3460;background:#0F3460;
                          font-size:11.5px;color:#fff;font-weight:600;cursor:pointer;">
            <i class="fas fa-search-plus"></i> Buscar y añadir (${notFound + bad})
          </button>`
        : '';

      // Action bar shown when ≥1 found article is checked. Each mark mirrors
      // the same operations available elsewhere: article-level flag/hito via
      // /articles/bulk, per-viewer favorito/leído/Journal-Club via
      // /articles/bulk-user-state.
      const BL_MARKS = [
        { id:'flag', icon:'⚑', label:'Banderita',    kind:'article', body:{is_flagged:true},   bd:'#f59e0b', bg:'#fffbeb', fg:'#92400e' },
        { id:'jc',   icon:'📖', label:'Journal Club', kind:'jc',      value:true,               bd:'#7c3aed', bg:'#f5f3ff', fg:'#6d28d9' },
        { id:'star', icon:'★', label:'Hito',         kind:'article', body:{is_milestone:true}, bd:'#f59e0b', bg:'#fffbeb', fg:'#92400e' },
        { id:'fav',  icon:'♥', label:'Favorito',     kind:'user',    body:{is_favorite:true},  bd:'#e11d48', bg:'#fff1f2', fg:'#be123c' },
        { id:'read', icon:'✓', label:'Leído',        kind:'user',    body:{is_read:true},      bd:'#15803d', bg:'#f0fdf4', fg:'#15803d' },
      ];
      const markBtns = BL_MARKS.map(m => `
          <button class="pv-bl-mark-btn" data-mark="${m.id}" type="button"
                  title="Marcar los seleccionados: ${m.label}"
                  style="padding:4px 10px;border-radius:6px;border:1px solid ${m.bd};background:${m.bg};
                         font-size:12px;color:${m.fg};cursor:pointer;font-weight:600;white-space:nowrap;">
            ${m.icon} ${m.label}
          </button>`).join('');
      const actionBar = `
        <div id="pv-bl-action-bar" style="display:none;align-items:center;gap:8px;flex-wrap:wrap;
             padding:8px 12px;border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb;margin-bottom:8px;">
          <span id="pv-bl-sel-count" style="font-size:12px;color:#374151;font-weight:600;"></span>
          ${markBtns}
          <span id="pv-bl-action-status" style="font-size:11.5px;color:#6b7280;"></span>
        </div>`;

      resultsEl.innerHTML = summary + actionBar +
        `<div style="max-height:380px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:8px;">
           <table style="width:100%;border-collapse:collapse;font-size:13px;">
             <thead style="background:#f9fafb;position:sticky;top:0;">
               <tr style="text-align:left;color:#6b7280;font-size:10.5px;
                          text-transform:uppercase;letter-spacing:0.04em;">
                 <th style="padding:8px;border-bottom:1px solid #e5e7eb;width:32px;text-align:center;">
                   <input type="checkbox" id="pv-bl-select-all" title="Seleccionar todos"
                          style="width:15px;height:15px;accent-color:#0F3460;cursor:pointer;">
                 </th>
                 <th style="padding:8px;border-bottom:1px solid #e5e7eb;width:36px;">#</th>
                 <th style="padding:8px;border-bottom:1px solid #e5e7eb;width:26px;"></th>
                 <th style="padding:8px;border-bottom:1px solid #e5e7eb;width:200px;">Input</th>
                 <th style="padding:8px;border-bottom:1px solid #e5e7eb;">Artículo</th>
               </tr>
             </thead>
             <tbody>${rows}</tbody>
           </table>
         </div>
         <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px;flex-wrap:wrap;">
           ${copyBtn}${addBtn}
         </div>`;

      // ── Checkbox selection + action bar ────────────────────────────────
      const actionBarEl  = document.getElementById('pv-bl-action-bar');
      const selCountEl   = document.getElementById('pv-bl-sel-count');
      const actionStatus = document.getElementById('pv-bl-action-status');
      const selectAll    = document.getElementById('pv-bl-select-all');

      function getChecked() {
        return Array.from(resultsEl.querySelectorAll('.pv-bl-chk:checked'));
      }
      function updateActionBar() {
        const chks = getChecked();
        if (chks.length > 0) {
          selCountEl.textContent = `${chks.length} seleccionado${chks.length > 1 ? 's' : ''}`;
          actionBarEl.style.display = 'flex';
        } else {
          actionBarEl.style.display = 'none';
        }
        actionStatus.textContent = '';
      }

      resultsEl.querySelectorAll('.pv-bl-chk').forEach(cb => {
        cb.addEventListener('change', updateActionBar);
      });

      selectAll?.addEventListener('change', () => {
        resultsEl.querySelectorAll('.pv-bl-chk').forEach(cb => {
          cb.checked = selectAll.checked;
        });
        updateActionBar();
      });

      // Mark selected — one handler for every mark button.
      resultsEl.querySelectorAll('.pv-bl-mark-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const m = BL_MARKS.find(x => x.id === btn.dataset.mark);
          if (!m) return;
          const ids = getChecked().map(cb => cb.dataset.aid);
          if (!ids.length) return;
          actionStatus.style.color = '#6b7280';
          actionStatus.textContent = 'Marcando…';
          try {
            if (m.kind === 'user') {
              await api('/articles/bulk-user-state', {
                method: 'POST',
                body: JSON.stringify({ ids, ...m.body }),
              });
            } else if (m.kind === 'jc') {
              await api('/articles/bulk-jc', {
                method: 'POST',
                body: JSON.stringify({ ids, value: m.value }),
              });
            } else {
              await api('/articles/bulk', {
                method: 'PATCH',
                body: JSON.stringify({ ids, updates: m.body }),
              });
            }
            actionStatus.textContent = `✓ ${ids.length} marcado${ids.length > 1 ? 's' : ''} · ${m.label}`;
            actionStatus.style.color = '#15803d';
          } catch (e) {
            actionStatus.textContent = 'Error: ' + e.message;
            actionStatus.style.color = '#b91c1c';
          }
        });
      });

      // Click row → open detail (but skip if clicking the checkbox).
      resultsEl.querySelectorAll('tr[data-aid]').forEach(tr => {
        tr.addEventListener('click', e => {
          if (e.target.closest('.pv-bl-chk-cell')) return;
          modal.style.display = 'none';
          openDetail(tr.dataset.aid);
        });
      });

      // Copy not-found list.
      const copyBtnEl = document.getElementById('pv-bulk-lookup-copy');
      if (copyBtnEl) copyBtnEl.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(notFoundList);
          copyBtnEl.innerHTML = '<i class="fas fa-check"></i> Copiado';
          setTimeout(() => {
            copyBtnEl.innerHTML = '<i class="fas fa-clipboard"></i> Copiar los que no están (' +
                           (notFound + bad) + ')';
          }, 1800);
        } catch (e) { alert('No se pudo copiar: ' + e.message); }
      });

      // Sequential "Buscar y añadir" for not-found items — with Anterior/
      // Siguiente navigation, so an item CrossRef/PubMed also can't
      // resolve doesn't strand the operator on it with no way onward
      // (or back to double-check an earlier one).
      const addBtnEl = document.getElementById('pv-bulk-lookup-add');
      if (addBtnEl) addBtnEl.addEventListener('click', () => {
        if (!notFoundItems.length) return;
        const queue = [...notFoundItems];
        let idx = 0;
        function openAt(i) {
          if (i < 0 || i >= queue.length) {
            // Ran off either end — done, re-open the lookup modal.
            modal.style.display = 'flex';
            return;
          }
          idx = i;
          modal.style.display = 'none';
          window._pvOpenAddByDoi(queue[idx], {
            queueLabel: `Artículo ${idx + 1} de ${queue.length} no encontrados`,
            onSaved: () => openAt(idx + 1),
            nav: {
              index: idx, total: queue.length,
              onPrev: () => openAt(idx - 1),
              onNext: () => openAt(idx + 1),
            },
          });
        }
        openAt(0);
      });
    }
  }

  function wireBatchSummary() {
    const btn   = document.getElementById('btn-batch-summary');
    const modal = document.getElementById('pv-batch-summary-modal');
    if (!btn || !modal) return;
    const closeBtn   = document.getElementById('pv-batch-summary-close');
    const limitBtnsEl = document.getElementById('pv-bs-limit-btns');
    const startLabelEl = document.getElementById('pv-bs-start-label');
    const stopBtn    = document.getElementById('pv-bs-stop');
    const statsEl    = document.getElementById('pv-bs-stats');
    const progWrap   = document.getElementById('pv-bs-progress-wrap');
    const progLabel  = document.getElementById('pv-bs-progress-label');
    const progBar    = document.getElementById('pv-bs-progress-bar');
    const progPct    = document.getElementById('pv-bs-progress-percent');
    const currentEl  = document.getElementById('pv-bs-current');
    const errorEl    = document.getElementById('pv-bs-error');
    const costEl     = document.getElementById('pv-bs-cost');

    let pollHandle = null;
    function stopPolling() {
      if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
    }
    function startPolling() {
      stopPolling();
      pollHandle = setInterval(refresh, 1800);
    }

    const providersEl = document.getElementById('pv-bs-providers');
    let selectedProvider =
        localStorage.getItem('pv-summary-provider') || 'anthropic';
    let providerMeta = {};  // populated by refreshProviders()

    function renderProviderPicker() {
      if (!providersEl) return;
      const cards = Object.entries(providerMeta).map(([key, p]) => {
        const active = key === selectedProvider;
        const off    = !p.configured;
        const border = active && !off ? '#0F3460'
                                       : (off ? '#e5e7eb' : '#d1d5db');
        const bg     = active && !off ? '#eef2ff' : 'white';
        const colorLabel = off ? '#9ca3af' : '#111827';
        return `
          <button type="button" class="pv-bs-provider-btn" data-provider="${esc(key)}"
                  ${off ? 'disabled' : ''}
                  style="background:${bg};border:2px solid ${border};border-radius:8px;
                         padding:8px 10px;text-align:left;cursor:${off ? 'not-allowed' : 'pointer'};
                         transition:border-color 0.15s, background 0.15s;
                         opacity:${off ? '0.5' : '1'};">
            <div style="font-size:12.5px;font-weight:600;color:${colorLabel};">
              ${esc(p.label)}
            </div>
            <div style="font-size:10.5px;color:#9ca3af;margin-top:2px;font-variant-numeric:tabular-nums;">
              ${esc(p.model)}<br>
              $${p.price_in.toFixed(2)}/M in · $${p.price_out.toFixed(2)}/M out
              ${off ? `<br><span style="color:#b91c1c;">${esc(p.env)} no configurada</span>` : ''}
            </div>
          </button>`;
      }).join('');
      providersEl.innerHTML = cards;
      providersEl.querySelectorAll('.pv-bs-provider-btn').forEach(b =>
        b.addEventListener('click', () => {
          if (b.disabled) return;
          selectedProvider = b.dataset.provider;
          localStorage.setItem('pv-summary-provider', selectedProvider);
          renderProviderPicker();
          refresh();         // recompute Start button label / state
        }));
    }

    async function refreshProviders() {
      try {
        const r = await api('/admin/ai-providers');
        providerMeta = r.providers || {};
        // If the persisted provider is no longer configured, fall back
        // to the first configured one (or just keep the bad value so
        // the user sees the disabled state and picks another).
        if (providerMeta[selectedProvider] &&
            !providerMeta[selectedProvider].configured) {
          const firstOk = Object.keys(providerMeta)
            .find(k => providerMeta[k].configured);
          if (firstOk) selectedProvider = firstOk;
        }
        renderProviderPicker();
      } catch (e) {
        if (providersEl) providersEl.innerHTML =
          `<div style="grid-column:1/-1;color:#b91c1c;font-size:12px;">
             No se pudo cargar la lista de proveedores: ${esc(e.message)}
           </div>`;
      }
    }

    function open() {
      modal.style.display = 'flex';
      refreshProviders();
      refresh();
      startPolling();
    }
    function close() {
      modal.style.display = 'none';
      stopPolling();
      // Drop any in-progress selection so a later open() defaults
      // back to "all pending" behaviour.
      window.PV_SUMMARY_SELECTION = null;
    }
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    function statCard(label, value, color, onclick) {
      const clickStyle = onclick ? 'cursor:pointer;' : '';
      const hoverAttr  = onclick ? `onmouseenter="this.style.boxShadow='0 0 0 2px #0F3460'" onmouseleave="this.style.boxShadow=''"` : '';
      const clickAttr  = onclick ? `onclick="${onclick}"` : '';
      return `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;${clickStyle}" ${hoverAttr} ${clickAttr}>
                <div style="font-size:10.5px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${esc(label)}</div>
                <div style="font-size:18px;font-weight:700;color:${color || '#111827'};font-variant-numeric:tabular-nums;">${esc(value)}</div>
              </div>`;
    }
    window._pvBatchSummaryFilter = function(hasSummaryVal) {
      modal.style.display = 'none';
      Object.assign(state, {
        q: '', yearMin: null, yearMax: null, journal: '', authors: '',
        tagId: null, hasSummary: null, inPrionread: null, isFlagged: null,
        isMilestone: null, colorLabel: null, priorityEq: null, extraction: null,
        isFavorite: null, isRead: null, isJc: null, collectionId: null, collectionGroup: null,
        collectionSubgroup: null, hasJc: null, jcPresenter: '', jcYear: null,
        hasPp: null, ppId: '', abstractStatus: '', indexedStatus: '', hasPdf: null, hasDoi: null, page: 1,
        _healthExtra: { has_summary_ai: hasSummaryVal },
      });
      syncMarkFilterButtons();
      loadArticles();
    };
    function statCardFilter(label, value, color, hasSummaryVal) {
      return statCard(label, value, color,
        `window._pvBatchSummaryFilter('${hasSummaryVal}')`
      );
    }

    async function refresh() {
      let s;
      try {
        s = await api('/admin/batch-summary/status');
      } catch (e) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Error consultando estado: ' + e.message;
        return;
      }
      const lib = s.library_stats || {};
      statsEl.innerHTML =
        statCard('Total',          lib.total ?? 0) +
        statCard('Con texto',      lib.with_text ?? 0) +
        statCardFilter('Con resumen', lib.with_summary ?? 0, '#15803d', 'true') +
        statCardFilter('Pendientes',  lib.eligible ?? 0, '#b45309', 'false');

      // Selection-mode banner: only visible when caller seeded ids
      // and the batch isn't running yet.
      const banner = document.getElementById('pv-bs-selection-banner');
      const selN   = (window.PV_SUMMARY_SELECTION || []).length;
      if (banner) {
        if (selN > 0 && !s.running) {
          banner.style.display = 'block';
          banner.innerHTML =
            `<strong>Selección activa:</strong> ${selN} artículo${selN === 1 ? '' : 's'} ` +
            `elegido${selN === 1 ? '' : 's'} desde la lista. Start procesará SOLO esos ` +
            `(regenerando si ya tenían resumen). Cierra el modal para volver al modo ` +
            `"todos los pendientes".`;
        } else {
          banner.style.display = 'none';
        }
      }

      if (s.running) {
        progWrap.style.display = 'block';
        const total = s.eligible_total || 0;
        const done  = (s.processed || 0) + (s.failed || 0);
        const pct   = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        progBar.style.width = pct + '%';
        progPct.textContent = pct + '%';
        const runMeta = providerMeta[s.provider];
        const runLabel = runMeta ? runMeta.label : (s.provider || '');
        const phaseHint = s.phase === 'calling_ai' ? '— esperando IA…'
                        : s.phase === 'starting'   ? '— iniciando…'
                        : s.phase === 'querying'   ? '— consultando BD…'
                        : s.stop_requested         ? '— deteniendo…'
                        : '— corriendo…';
        progLabel.textContent =
          (runLabel ? `[${runLabel}] ` : '') +
          `${done} / ${total} procesados ` +
          (s.failed ? `(${s.failed} con error) ` : '') +
          phaseHint;
        if (s.current_article) {
          currentEl.style.display = 'block';
          let elapsed = '';
          if (s.current_article.started_at) {
            const secs = Math.round((Date.now() - new Date(s.current_article.started_at + 'Z').getTime()) / 1000);
            if (secs >= 5) elapsed = ` <span style="color:#9ca3af">(${secs}s)</span>`;
          }
          currentEl.innerHTML = `<strong>Actual:</strong> ${esc(s.current_article.title)}${elapsed}`;
        } else {
          currentEl.style.display = 'none';
        }
        if (limitBtnsEl) limitBtnsEl.style.display = 'none';
        stopBtn.style.display = 'inline-flex';
        stopBtn.disabled = !!s.stop_requested;
      } else {
        if (limitBtnsEl) limitBtnsEl.style.display = 'flex';
        stopBtn.style.display = 'none';
        currentEl.style.display = 'none';
        const eligible    = lib.eligible || 0;
        const selectionN  = (window.PV_SUMMARY_SELECTION || []).length;
        const provMeta    = providerMeta[selectedProvider];
        const provReady   = !!(provMeta && provMeta.configured);
        const effective   = selectionN > 0 ? selectionN : eligible;
        const btnsDisabled = effective === 0 || !provReady;
        if (limitBtnsEl) {
          if (selectionN > 0) {
            // Replace limit buttons with a single "N seleccionados" button
            if (!limitBtnsEl.querySelector('.pv-bs-sel-btn')) {
              limitBtnsEl.querySelectorAll('.pv-bs-limit-btn').forEach(b => b.style.display = 'none');
              const selBtn = document.createElement('button');
              selBtn.className = 'pv-bs-limit-btn pv-bs-sel-btn';
              selBtn.dataset.limit = '';
              selBtn.textContent = `${selectionN} seleccionado${selectionN === 1 ? '' : 's'}`;
              selBtn.style.cssText = 'padding:8px 16px;border-radius:8px;border:none;background:#0F3460;' +
                'color:white;font-size:13px;font-weight:700;cursor:pointer;';
              selBtn.addEventListener('click', () => startBatch(null));
              limitBtnsEl.appendChild(selBtn);
              selBtn.disabled = btnsDisabled;
            }
          } else {
            // Restore normal buttons and remove selection button if present
            limitBtnsEl.querySelectorAll('.pv-bs-sel-btn').forEach(b => b.remove());
            limitBtnsEl.querySelectorAll('.pv-bs-limit-btn').forEach(b => {
              b.style.display = '';
              b.disabled = btnsDisabled;
              b.style.opacity = btnsDisabled ? '0.5' : '1';
            });
          }
        }
        if (startLabelEl) {
          if (!provReady) {
            startLabelEl.textContent = 'Elige un proveedor de IA';
          } else if (selectionN > 0) {
            startLabelEl.textContent = `Resumir ${selectionN} seleccionado${selectionN === 1 ? '' : 's'} con ${provMeta.label}`;
          } else {
            startLabelEl.textContent = eligible > 0
              ? `${provMeta.label} · ${eligible} pendiente${eligible === 1 ? '' : 's'}`
              : provMeta.label;
          }
        }
        if (s.finished_at && (s.processed || s.failed)) {
          progWrap.style.display = 'block';
          const total = s.eligible_total || 0;
          const done  = (s.processed || 0) + (s.failed || 0);
          const pct   = total > 0 ? Math.round((done / total) * 100) : 100;
          progBar.style.width = pct + '%';
          progPct.textContent = pct + '%';
          progLabel.textContent = `Terminado: ${s.processed} OK, ${s.failed} con error`;
        }
      }

      if (s.last_error) {
        // Don't overwrite if we've injected reset-button HTML
        if (!errorEl.querySelector('button')) {
          errorEl.style.display = 'block';
          errorEl.textContent = 'Último error: ' + s.last_error;
        }
      } else if (!errorEl.querySelector('button')) {
        errorEl.style.display = 'none';
      }

      const cost = (s.total_cost_usd || 0).toFixed(3);
      const tin  = s.total_tokens_in  || 0;
      const tout = s.total_tokens_out || 0;
      costEl.textContent = (s.processed || 0) > 0
        ? `Coste esta sesión: $${cost} · ${tin} in / ${tout} out tokens`
        : '';
    }

    async function startBatch(limitVal) {
      if (!selectedProvider) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Elige un proveedor de IA antes de empezar.';
        return;
      }
      modal.querySelectorAll('.pv-bs-limit-btn').forEach(b => { b.disabled = true; });
      const selectionIds = window.PV_SUMMARY_SELECTION || null;
      try {
        const body = { provider: selectedProvider };
        if (limitVal) body.limit = limitVal;
        if (selectionIds && selectionIds.length) body.ids = selectionIds;
        await api('/admin/batch-summary/start', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        window.PV_SUMMARY_SELECTION = null;
        refresh();
        startPolling();
      } catch (e) {
        modal.querySelectorAll('.pv-bs-limit-btn').forEach(b => { b.disabled = false; });
        if (e.status === 409) {
          // Show a reset button so the user can unblock a stuck run
          errorEl.style.display = 'block';
          errorEl.innerHTML = '';
          const msg = document.createElement('span');
          msg.textContent = 'Ya hay un proceso corriendo (o quedó bloqueado). ';
          const resetBtn = document.createElement('button');
          resetBtn.textContent = 'Forzar reset';
          resetBtn.style.cssText = 'margin-left:8px;padding:2px 10px;cursor:pointer;';
          resetBtn.addEventListener('click', async () => {
            resetBtn.disabled = true;
            try {
              await api('/admin/batch-summary/reset', { method: 'POST' });
              errorEl.style.display = 'none';
              errorEl.innerHTML = '';
              refresh();
            } catch (re) {
              msg.textContent = 'No se pudo resetear: ' + re.message;
            }
          });
          errorEl.appendChild(msg);
          errorEl.appendChild(resetBtn);
          refresh();
        } else {
          errorEl.style.display = 'block';
          errorEl.textContent = 'No se pudo iniciar: ' + e.message;
        }
      }
    }

    modal.querySelectorAll('.pv-bs-limit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const limitVal = btn.dataset.limit ? parseInt(btn.dataset.limit, 10) : null;
        startBatch(limitVal);
      });
    });

    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      try {
        await api('/admin/batch-summary/stop', { method: 'POST' });
        refresh();
      } catch (e) {
        stopBtn.disabled = false;
        errorEl.style.display = 'block';
        errorEl.textContent = 'No se pudo detener: ' + e.message;
      }
    });
  }

  // ── RAG (Ask the library) — Phase 5 ──────────────────────────────────
  function annotateCitations(answer, citations) {
    // Wrap inline [N] markers with a clickable span that scrolls to /
    // opens the matching citation card below. Runs after markdownLite
    // so headings / bold inside the answer are rendered too.
    const byNum = new Map(citations.map(c => [c.n, c]));
    return markdownLite(answer).replace(/\[(\d{1,3})\]/g, (m, nStr) => {
      const n = parseInt(nStr, 10);
      const c = byNum.get(n);
      if (!c) return m;
      return `<a href="#" data-rag-cite="${n}" data-aid="${esc(c.article_id)}" ` +
             `style="text-decoration:none;font-weight:700;color:#0F3460;">[${n}]</a>`;
    });
  }

  function renderRagCitations(citations, citedNumbers) {
    // Local helper — `escAttr` is defined elsewhere in the file as a
    // closure-local inside other render functions, so it's not in
    // scope here. Re-declaring it locally is cheaper than threading
    // it through and matches the pattern used by the other renderers.
    const escAttr = (v) => esc(String(v || ''));
    const container = document.getElementById('pv-rag-citations');
    const title = document.getElementById('pv-rag-citations-title');
    if (!citations.length) {
      title.style.display = 'none';
      container.innerHTML = '';
      return;
    }
    title.style.display = 'block';
    const baseLabel = citedNumbers.length
      ? `Referencias citadas (${citedNumbers.length}/${citations.length} recuperadas)`
      : `Referencias recuperadas (${citations.length})`;
    title.textContent = baseLabel;

    const citedSet = new Set(citedNumbers);
    container.innerHTML = citations.map(c => {
      const isUsed = citedSet.has(c.n);
      const simPct = Math.round((c.similarity || 0) * 100);
      const rrChip = (c.rerank_score != null)
        ? `<span title="Voyage rerank-2 relevance score (0–1)"
                 style="font-size:10.5px;color:#7c3aed;background:#f5f3ff;border:1px solid #ddd6fe;
                        padding:1px 6px;border-radius:5px;font-variant-numeric:tabular-nums;font-weight:600;">
             RR ${c.rerank_score.toFixed(2)}
           </span>`
        : '';
      const headerBits = [
        c.authors ? esc(c.authors).slice(0, 110) : '',
        c.year || '',
        c.journal ? esc(c.journal) : '',
      ].filter(Boolean).join(' · ');

      // Direct external / internal links. The user asked for clickable
      // PDF / DOI / PMID chips so they can jump to the source from the
      // citation card without first opening the article modal.
      //   • PDF  → in-app viewer (auth-aware, no Dropbox link leakage).
      //   • DOI  → doi.org (resolves to publisher landing page).
      //   • PMID → pubmed.ncbi.nlm.nih.gov.
      const linkChips = [];
      if (c.has_pdf) {
        linkChips.push(
          `<a href="/prionvault/api/articles/${escAttr(c.article_id)}/pdf-view"
              target="_blank" rel="noopener"
              title="Abrir el PDF en una pestaña nueva"
              style="font-size:10.5px;background:#ecfdf5;color:#047857;
                     border:1px solid #a7f3d0;padding:2px 8px;border-radius:5px;
                     font-weight:600;text-decoration:none;">
             📄 PDF ↗
           </a>`
        );
      }
      if (c.doi) {
        linkChips.push(
          `<a href="https://doi.org/${escAttr(c.doi)}"
              target="_blank" rel="noopener"
              title="Abrir el artículo en doi.org"
              style="font-size:10.5px;background:#eef2ff;color:#3730a3;
                     border:1px solid #c7d2fe;padding:2px 8px;border-radius:5px;
                     font-weight:600;text-decoration:none;">
             DOI ↗
           </a>`
        );
      }
      if (c.pubmed_id) {
        linkChips.push(
          `<a href="https://pubmed.ncbi.nlm.nih.gov/${escAttr(c.pubmed_id)}/"
              target="_blank" rel="noopener"
              title="Abrir en PubMed"
              style="font-size:10.5px;background:#dbeafe;color:#1d4ed8;
                     border:1px solid #93c5fd;padding:2px 8px;border-radius:5px;
                     font-weight:600;text-decoration:none;">
             PMID ${escAttr(c.pubmed_id)} ↗
           </a>`
        );
      }
      linkChips.push(
        `<button type="button" class="pv-rag-isolate-btn" data-aid="${escAttr(c.article_id)}"
                 title="Mostrar solo este artículo en el listado de PrionVault"
                 style="font-size:10.5px;background:#fef3c7;color:#92400e;
                        border:1px solid #fde68a;padding:2px 8px;border-radius:5px;
                        font-weight:600;cursor:pointer;">
           📍 Aislar
         </button>`
      );

      const inCart = window.PPCart?.has(c.article_id);
      const cartChip = `<button type="button"
          class="pv-rag-cart-btn ${inCart ? 'pv-rag-cart-btn--in' : ''}"
          data-aid="${escAttr(c.article_id)}"
          data-title="${escAttr(c.title || '')}"
          data-authors="${escAttr(c.authors || '')}"
          data-year="${escAttr(c.year || '')}"
          data-journal="${escAttr(c.journal || '')}"
          data-doi="${escAttr(c.doi || '')}"
          data-pmid="${escAttr(c.pubmed_id || '')}"
          data-haspdf="${c.has_pdf ? '1' : '0'}"
          title="${inCart ? 'En el carrito' : 'Añadir al carrito de PrionPacks'}"
          style="font-size:10.5px;padding:2px 8px;border-radius:5px;border:1px solid;
                 font-weight:600;cursor:pointer;
                 ${inCart
                   ? 'background:#d1fae5;color:#065f46;border-color:#6ee7b7;'
                   : 'background:#f9fafb;color:#374151;border-color:#d1d5db;'}">
        ${inCart ? '🛒 ✓' : '🛒'}
      </button>`;
      linkChips.push(cartChip);

      const linkRow = linkChips.length
        ? `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">${linkChips.join('')}</div>`
        : '';

      // Extract — the literal chunk text the model saw. Collapsed by
      // default because the user found it indistinguishable from
      // model reasoning and rarely needed to verify it inline. Still
      // recoverable with one click for the cases where the operator
      // wants to confirm where a claim came from.
      const extractBlock = c.extract
        ? `<details class="pv-rag-extract" style="margin-top:6px;">
             <summary style="cursor:pointer;font-size:11px;color:#6b7280;
                             padding:2px 0;list-style:none;display:inline-flex;
                             align-items:center;gap:4px;user-select:none;">
               <span class="pv-rag-extract-caret" style="display:inline-block;
                       transition:transform 0.15s;font-size:9px;">▶</span>
               Ver fragmento usado por la IA
             </summary>
             <div style="font-size:12px;color:#4b5563;background:#f9fafb;border-radius:6px;
                         padding:6px 8px;margin-top:4px;line-height:1.55;
                         max-height:200px;overflow-y:auto;">${esc(c.extract)}</div>
           </details>`
        : '';

      return `
        <div id="pv-rag-cite-${c.n}" data-rag-cite-card="${c.n}"
             style="display:flex;gap:10px;align-items:flex-start;
                    background:${isUsed ? '#fff' : '#fafafa'};
                    border:1px solid ${isUsed ? '#cbd5e1' : '#e5e7eb'};
                    border-left:3px solid ${isUsed ? '#0F3460' : '#cbd5e1'};
                    border-radius:8px;padding:10px 12px;">
          <div style="font-size:12px;font-weight:700;color:#0F3460;flex-shrink:0;
                      min-width:24px;">[${c.n}]</div>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
              <a href="#" data-aid="${esc(c.article_id)}" class="pv-rag-open"
                 style="font-size:13.5px;font-weight:600;color:#111827;text-decoration:none;">
                ${supHtml(c.title || '(no title)')}
              </a>
              <span style="font-size:11px;color:#15803d;font-variant-numeric:tabular-nums;font-weight:600;">
                ${simPct}% match
              </span>
              ${rrChip}
            </div>
            ${headerBits ? `<div style="font-size:11.5px;color:#6b7280;margin-top:1px;">${headerBits}</div>` : ''}
            ${linkRow}
            ${extractBlock}
          </div>
        </div>`;
    }).join('');

    // Rotate the caret when the user expands the fragment, so the
    // affordance matches the open/close state. Native <details> open
    // state changes are observable via the toggle event.
    container.querySelectorAll('.pv-rag-extract').forEach(d => {
      d.addEventListener('toggle', () => {
        const caret = d.querySelector('.pv-rag-extract-caret');
        if (caret) caret.style.transform = d.open ? 'rotate(90deg)' : '';
      });
    });

    container.querySelectorAll('.pv-rag-open').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        openDetail(a.dataset.aid);
      });
    });

    container.querySelectorAll('.pv-rag-isolate-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        _setIsolatedArticleId(btn.dataset.aid);
        loadArticles();
      });
    });

    container.querySelectorAll('.pv-rag-cart-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (!window.PPCart) return;
        const d = btn.dataset;
        window.PPCart.add({
          id: d.aid, title: d.title, authors: d.authors,
          year: d.year || null, journal: d.journal,
          doi: d.doi, pubmed_id: d.pmid, has_pdf: d.haspdf === '1',
        });
        btn.classList.add('pv-rag-cart-btn--in');
        btn.style.background = '#d1fae5';
        btn.style.color = '#065f46';
        btn.style.borderColor = '#6ee7b7';
        btn.title = 'En el carrito';
        btn.innerHTML = '🛒 ✓';
      });
    });
  }

  // Banner that explains which terms the biomedical query expander
  // Friendly explainer that surfaces ABOVE the answer whenever the
  // backend's fallback chain kicked in (the operator's chosen
  // provider couldn't respond, so we retried with the next one).
  // Self-removes on every re-render so consecutive queries don't
  // stack banners.
  function renderRagFallbackBanner(r) {
    const ansEl = document.getElementById('pv-rag-answer');
    if (!ansEl || !ansEl.parentElement) return;
    ansEl.parentElement
       .querySelectorAll('.pv-rag-fallback-banner')
       .forEach(b => b.remove());
    const attempts = r.fallback_attempts || [];
    if (!attempts.length) return;
    const requested = r.requested_provider || '';
    const actual    = r.actual_provider    || '';
    // No fallback needed → only one attempt and that's also `actual`.
    // Render iff the actual provider differs from the requested OR
    // if the first attempt failed (i.e. attempts has > 1 entry, OR a
    // single entry whose provider != actual, which means the chain
    // exhausted).
    if (actual === requested && attempts.length <= 1
        && attempts[0].provider === actual && actual !== '') return;

    const labelMap = {
      anthropic: 'Claude Sonnet 4.6',
      openai:    'GPT-4.1',
      gemini:    'Gemini 2.5 Pro',
    };
    const human = (p) => labelMap[p] || p || 'el proveedor';
    const banner = document.createElement('div');
    banner.className = 'pv-rag-fallback-banner';
    banner.style.cssText =
      'margin:0 0 10px;padding:10px 12px;border-radius:8px;' +
      'background:#fffbeb;border:1px solid #fde68a;color:#92400e;' +
      'font-size:12.5px;line-height:1.55;';
    const lines = [];
    // Per-attempt explanation, in the order they were tried.
    attempts.forEach((a, idx) => {
      const isLast = idx === attempts.length - 1;
      // The last attempt is the one that succeeded IFF actual matches
      // it. If it doesn't, all attempts failed.
      if (isLast && a.provider === actual) {
        // Skip "we tried this and it worked" — covered by the closing
        // sentence below. Showing it just adds noise.
        return;
      }
      lines.push(
        `<div><strong>${esc(human(a.provider))}</strong> no pudo responder: ` +
        `${esc(a.reason || a.kind)}.</div>`
      );
    });
    if (actual && actual !== requested) {
      lines.push(
        `<div style="margin-top:4px;">` +
        `↳ Te respondí con <strong>${esc(human(actual))}</strong> en su lugar.` +
        `</div>`
      );
    } else if (!actual) {
      // Edge case: backend exhausted the chain. Should already be a
      // 502 in this path, but guard anyway.
      lines.push(
        `<div style="margin-top:4px;color:#b91c1c;">` +
        `Ningún proveedor pudo responder. Revisa créditos / cuotas en ` +
        `<em>Estado IA</em>.</div>`
      );
    }
    banner.innerHTML =
      `<i class="fas fa-circle-info" style="margin-right:6px;"></i>` +
      lines.join('');
    ansEl.parentElement.insertBefore(banner, ansEl);
  }

  // broadened — printed ABOVE the citations so the user understands
  // why a paper that doesn't literally contain their typed term may
  // still surface. Removes itself when re-renders happen, so back-to-
  // back queries don't stack.
  function renderRagExpansionBanner(r) {
    const citEl = document.getElementById('pv-rag-citations');
    if (!citEl) return;
    citEl.parentElement
       ?.querySelectorAll('.pv-rag-expansion-banner')
        .forEach(b => b.remove());
    const matches = r.expansion_matches || [];
    if (!matches.length) return;
    const banner = document.createElement('div');
    banner.className = 'pv-rag-expansion-banner';
    banner.style.cssText =
      'margin:8px 0 6px;padding:8px 12px;border-radius:7px;' +
      'background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;' +
      'font-size:12px;line-height:1.5;';
    const pills = matches.map(m =>
      `<span style="display:inline-block;background:white;border:1px solid #bfdbfe;
                    padding:1px 6px;border-radius:5px;font-weight:600;
                    margin:0 4px 2px 0;">
         <strong>${esc(m.term)}</strong> → ${esc(m.expansions)}
       </span>`
    ).join('');
    banner.innerHTML =
      `<i class="fas fa-magnifying-glass-arrow-right" style="margin-right:5px;"></i>` +
      `Para ampliar la búsqueda, he interpretado: ${pills}`;
    citEl.parentElement.insertBefore(banner, citEl);
  }

  // Banner shown UNDER the citations list when the retriever found
  // more relevant articles than the current top_k surfaced. Tells
  // the user how many were left out and offers a one-tap prompt to
  // raise top_k and re-run the same query. The prompt accepts a
  // custom count, capped at 200 (the server-side hard ceiling).
  function renderRagMoreBanner(r, query, provider) {
    const container = document.getElementById('pv-rag-citations');
    if (!container) return;
    // Always remove any previous banner before deciding to render
    // a new one — otherwise consecutive "ver más" runs stack.
    container.querySelectorAll('.pv-rag-more-banner').forEach(b => b.remove());

    const used  = r.top_k_used || (r.citations || []).length;
    const total = r.total_candidates || 0;
    const shown = (r.citations || []).length;
    const hardCap = 200;

    // Two distinct "the answer might be incomplete" conditions:
    //   1. The retriever truncated (total > shown).
    //   2. The current top_k already hit the hard cap and there
    //      could still be more beyond the candidate pool. Less
    //      common, but worth surfacing.
    const truncated  = r.has_more && total > shown;
    const atHardCap  = used >= hardCap;

    if (!truncated && !atHardCap) return;

    const remaining = Math.max(0, total - shown);
    const banner = document.createElement('div');
    banner.className = 'pv-rag-more-banner';
    banner.style.cssText =
      'margin-top:10px;padding:10px 12px;border-radius:8px;' +
      'background:#fffbeb;border:1px solid #fde68a;color:#92400e;' +
      'font-size:12.5px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;';

    if (truncated) {
      banner.innerHTML =
        `<span><strong>Hay ${remaining} artículo${remaining === 1 ? '' : 's'} más</strong> ` +
        `que coinciden con tu pregunta (mostrando ${shown} de ${total}).</span>` +
        `<button type="button" class="pv-rag-more-btn"
                 style="padding:5px 12px;border-radius:5px;border:none;
                        background:#b45309;color:white;font-size:12px;
                        font-weight:600;cursor:pointer;">
           Ver más…
         </button>`;
    } else {
      // atHardCap branch: we don't know exactly how many beyond 200,
      // so we frame it as "showing the cap" instead of a number.
      banner.innerHTML =
        `<span>Mostrando el máximo permitido por consulta (${hardCap} artículos). ` +
        `Refina la pregunta para acotar resultados.</span>`;
    }

    container.appendChild(banner);

    const btn = banner.querySelector('.pv-rag-more-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      // Suggested next batch = either everything remaining (if it
      // fits in one more page) or another 50. The user can override.
      const suggested = Math.min(remaining, 50);
      const raw = prompt(
        `¿Cuántos artículos más quieres ver?\n\n` +
        `• Quedan ${remaining} más en la biblioteca.\n` +
        `• Máximo por consulta: ${hardCap} en total.\n` +
        `• Ya tienes ${shown} en la respuesta actual.`,
        String(suggested)
      );
      if (raw == null) return;
      const extra = parseInt(raw, 10);
      if (!Number.isFinite(extra) || extra <= 0) {
        alert('Número no válido. Inténtalo de nuevo.');
        return;
      }
      // Re-run with a higher top_k. We don't actually fetch only the
      // "extra" delta — the server always returns the top K at once,
      // so we ask for shown + extra (capped at hardCap).
      const newTopK = Math.min(hardCap, shown + extra);
      runRagSearch(query, { topK: newTopK });
    });
  }

  // Pulled out of runRagSearch so the rendering path is shared and not
  // duplicated inline.
  function _renderRagResult(query, provider, topK, r) {
    const qEl    = document.getElementById('pv-rag-query');
    const stEl   = document.getElementById('pv-rag-status');
    const ansEl  = document.getElementById('pv-rag-answer');
    const metaEl = document.getElementById('pv-rag-meta');
    if (qEl) qEl.textContent = query;
    if (!ansEl || !stEl || !metaEl) return;

    ansEl.style.color = '#1f2937';
    ansEl.innerHTML = annotateCitations(r.answer || '', r.citations || []);

    const confLabel = r.confidence ? `Confianza: <strong>${esc(r.confidence)}</strong>` : '';
    const hybridBadge = r.hybrid_used
      ? `<span title="Vector ${r.hybrid_vector_hits} + BM25 ${r.hybrid_bm25_hits} → ${r.hybrid_fused} fusionados"
               style="display:inline-block;margin-left:6px;font-size:10.5px;color:#0369a1;
                      background:#f0f9ff;border:1px solid #bae6fd;padding:1px 6px;
                      border-radius:5px;font-weight:600;letter-spacing:0.02em;">
          🔀 hybrid · ${r.hybrid_vector_hits}v + ${r.hybrid_bm25_hits}b → ${r.hybrid_fused}
         </span>`
      : '';
    const rrBadge = r.rerank_used
      ? `<span style="display:inline-block;margin-left:6px;font-size:10.5px;color:#7c3aed;
                      background:#f5f3ff;border:1px solid #ddd6fe;padding:1px 6px;
                      border-radius:5px;font-weight:600;letter-spacing:0.02em;">
          ⚡ reranked${r.rerank_candidates ? ' · ' + r.rerank_candidates + ' cand.' : ''}
         </span>`
      : '';
    const timing = `${(r.elapsed_ms/1000).toFixed(1)} s (retrieval ${r.retrieval_ms} ms)`;
    const totalCost = (r.cost_usd || 0) + (r.rerank_cost_usd || 0);
    const cost = totalCost > 0 ? ` · $${totalCost.toFixed(4)}` : '';
    const tok = (r.tokens_in != null && r.tokens_out != null)
      ? ` · ${r.tokens_in} in / ${r.tokens_out} out tokens` : '';
    stEl.style.color = r.no_results ? '#b45309' : '#15803d';
    stEl.innerHTML = r.no_results
      ? '⚠️ Retrieval no encontró fragmentos relevantes para esta pregunta.'
      : `✓ Generado en ${timing}${cost}${tok}`;
    metaEl.innerHTML = confLabel + hybridBadge + rrBadge;

    renderRagFallbackBanner(r);
    renderRagExpansionBanner(r);
    renderRagCitations(r.citations || [], r.cited_numbers || []);
    renderRagMoreBanner(r, query, provider);

    // Wire inline [N] citation links to scroll to the corresponding card
    ansEl.querySelectorAll('a[data-rag-cite]').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        const card = document.getElementById('pv-rag-cite-' + a.dataset.ragCite);
        if (card) {
          card.scrollIntoView({behavior: 'smooth', block: 'center'});
          card.style.transition = 'background 0.3s ease';
          card.style.background = '#fef3c7';
          setTimeout(() => { card.style.background = ''; }, 1200);
        }
      });
    });
  }

  // Module-level memo so the "ver más" button can re-issue the same
  // query with a larger top_k without having to keep the input string
  // alive in the UI. Updated on every successful runRagSearch.
  let _lastRagQuery   = '';
  let _lastRagTopK    = 50;

  async function runRagSearch(query, opts) {
    opts = opts || {};
    const topK = Number.isFinite(opts.topK) ? opts.topK : 50;
    _lastRagQuery = query;
    _lastRagTopK  = topK;
    const panel  = document.getElementById('pv-rag-panel');
    const qEl    = document.getElementById('pv-rag-query');
    const stEl   = document.getElementById('pv-rag-status');
    const ansEl  = document.getElementById('pv-rag-answer');
    const metaEl = document.getElementById('pv-rag-meta');
    const citEl  = document.getElementById('pv-rag-citations');
    const titEl  = document.getElementById('pv-rag-citations-title');
    const resultsMeta = document.getElementById('pv-results-meta');
    const resultsGrid = document.getElementById('pv-results-grid');
    const pagination  = document.getElementById('pv-pagination');

    if (!query) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'block';
    if (resultsMeta) resultsMeta.style.display = 'none';
    if (resultsGrid) resultsGrid.style.display = 'none';
    if (pagination)  pagination.style.display  = 'none';

    qEl.textContent = query;
    const provEl = document.getElementById('pv-rag-provider');
    const provider = (provEl && provEl.value) ||
                     localStorage.getItem('pv-summary-provider') ||
                     'anthropic';
    if (provEl && provEl.value !== provider) provEl.value = provider;
    const provLabel = ({anthropic:'Claude Sonnet 4.6',
                       openai:'GPT-4.1',
                       gemini:'Gemini 2.5 Pro'})[provider] || provider;
    stEl.style.color = '#6b7280';
    stEl.textContent =
      `Recuperando fragmentos y consultando a ${provLabel}…`;
    ansEl.style.color = '#9ca3af';
    ansEl.textContent = '…';
    metaEl.textContent = '';
    citEl.innerHTML = '';
    titEl.style.display = 'none';

    try {
      const r = await api('/search/semantic', {
        method: 'POST',
        body: JSON.stringify({ query, provider, top_k: topK }),
      });
      _renderRagResult(query, provider, topK, r);
    } catch (e) {
      ansEl.style.color = '#b91c1c';
      if (e.status === 503) {
        ansEl.textContent = 'Búsqueda IA no disponible — falta configurar API key (VOYAGE_API_KEY o ANTHROPIC_API_KEY) en el servidor.';
      } else {
        ansEl.textContent = 'Error: ' + e.message;
      }
      stEl.textContent = '';
    }
  }

  function closeRagPanel() {
    const panel       = document.getElementById('pv-rag-panel');
    const resultsMeta = document.getElementById('pv-results-meta');
    const resultsGrid = document.getElementById('pv-results-grid');
    const pagination  = document.getElementById('pv-pagination');
    if (panel) panel.style.display = 'none';
    if (resultsMeta) resultsMeta.style.display = '';
    if (resultsGrid) resultsGrid.style.display = '';
    if (pagination)  pagination.style.display  = '';
  }

  // ── Batch indexing modal (Phase 4) ───────────────────────────────────
  function wireBatchIndex() {
    const btn   = document.getElementById('btn-batch-index');
    const modal = document.getElementById('pv-batch-index-modal');
    if (!btn || !modal) return;
    const closeBtn   = document.getElementById('pv-batch-index-close');
    const startBtn   = document.getElementById('pv-bi-start');
    const stopBtn    = document.getElementById('pv-bi-stop');
    const resetBtn   = document.getElementById('pv-bi-reset');
    const statsEl    = document.getElementById('pv-bi-stats');
    const progWrap   = document.getElementById('pv-bi-progress-wrap');
    const progLabel  = document.getElementById('pv-bi-progress-label');
    const progBar    = document.getElementById('pv-bi-progress-bar');
    const progPct    = document.getElementById('pv-bi-progress-percent');
    const currentEl  = document.getElementById('pv-bi-current');
    const errorEl    = document.getElementById('pv-bi-error');
    const costEl     = document.getElementById('pv-bi-cost');
    const modelEl    = document.getElementById('pv-bi-model');
    const coverageRows = document.getElementById('pv-bi-coverage-rows');
    const coverageRefresh = document.getElementById('pv-bi-coverage-refresh');

    function pct(n, total) {
      if (!total) return 0;
      return Math.round(n / total * 100);
    }
    function coverageBar(indexed, available, color) {
      const p = pct(indexed, available);
      return `<div style="width:90px;min-width:90px;height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden;">
                <div style="height:100%;width:${p}%;background:${color};border-radius:3px;transition:width .4s;"></div>
              </div>`;
    }
    function coverageRow(icon, label, color, indexed, available, pending, btnId) {
      const p = pct(indexed, available);
      const pendingBadge = pending > 0
        ? `<span style="background:#fef3c7;color:#92400e;font-size:10.5px;font-weight:700;
                        padding:1px 8px;border-radius:10px;white-space:nowrap;flex-shrink:0;">+${pending.toLocaleString('es-ES')} pendientes</span>`
        : `<span style="background:#dcfce7;color:#15803d;font-size:10.5px;font-weight:700;
                        padding:1px 8px;border-radius:10px;white-space:nowrap;flex-shrink:0;">✓ al día</span>`;
      return `
        <div style="display:flex;align-items:center;gap:8px;font-size:12.5px;flex-wrap:nowrap;">
          <span style="width:18px;min-width:18px;text-align:center;font-size:14px;flex-shrink:0;">${icon}</span>
          <span style="width:105px;min-width:105px;color:#374151;font-weight:600;flex-shrink:0;">${esc(label)}</span>
          ${coverageBar(indexed, available, color)}
          <span style="width:90px;min-width:90px;text-align:right;font-variant-numeric:tabular-nums;color:#6b7280;white-space:nowrap;flex-shrink:0;font-size:11.5px;">
            ${indexed.toLocaleString('es-ES')} / ${available.toLocaleString('es-ES')}
            <span style="color:#9ca3af;font-size:10.5px;"> (${p}%)</span>
          </span>
          <span style="margin-left:auto;flex-shrink:0;">${pendingBadge}</span>
        </div>`;
    }
    async function loadCoverage() {
      if (!coverageRows) return;
      coverageRows.innerHTML = '<div style="color:#9ca3af;font-size:12px;text-align:center;padding:8px 0;">Cargando…</div>';
      try {
        const c = await api('/admin/embeddings/coverage');
        coverageRows.innerHTML = [
          coverageRow('📄', 'PDF completo', '#0F3460', c.pdf.indexed,      c.pdf.available,      c.pdf.available - c.pdf.indexed,           'pv-bi-add-pdf'),
          coverageRow('📝', 'Abstract',     '#1d4ed8', c.abstract.indexed,  c.abstract.available, c.abstract.available - c.abstract.indexed,  'pv-bi-add-abstracts'),
          coverageRow('🤖', 'Resumen IA',   '#15803d', c.summary.indexed,   c.summary.available,  c.summary.available - c.summary.indexed,    'pv-bi-add-summaries'),
          coverageRow('🗒️', 'Notas',        '#7c3aed', c.notes.indexed,     c.notes.available,    c.notes.available - c.notes.indexed,        'pv-bi-add-notes'),
        ].join('');
        // Update button labels to show pending counts
        const pdfPending = c.pdf.available - c.pdf.indexed;
        const absPending = c.abstract.available - c.abstract.indexed;
        const sumPending = c.summary.available - c.summary.indexed;
        const notesPending = c.notes.available - c.notes.indexed;
        const pdfBtn = document.getElementById('pv-bi-add-pdf');
        if (pdfBtn && !pdfBtn.disabled) {
          pdfBtn.textContent = pdfPending > 0
            ? `+ Añadir PDF (${pdfPending.toLocaleString('es-ES')} pendientes)`
            : '✓ PDF al día';
        }
        const absBtn = document.getElementById('pv-bi-add-abstracts');
        if (absBtn && !absBtn.disabled) {
          absBtn.textContent = absPending > 0
            ? `+ Añadir abstracts (${absPending.toLocaleString('es-ES')} pendientes)`
            : '✓ Abstracts al día';
        }
        const sumBtn = document.getElementById('pv-bi-add-summaries');
        if (sumBtn && !sumBtn.disabled) {
          sumBtn.textContent = sumPending > 0
            ? `+ Añadir resúmenes IA (${sumPending.toLocaleString('es-ES')} pendientes)`
            : '✓ Resúmenes IA al día';
        }
        const notesBtn = document.getElementById('pv-bi-add-notes');
        if (notesBtn && !notesBtn.disabled) {
          notesBtn.textContent = notesPending > 0
            ? `+ Añadir notas (${notesPending.toLocaleString('es-ES')} pendientes)`
            : '✓ Notas al día';
        }
      } catch (e) {
        coverageRows.innerHTML = `<div style="color:#b91c1c;font-size:12px;">Error: ${esc(e.message)}</div>`;
      }
    }
    if (coverageRefresh) coverageRefresh.addEventListener('click', loadCoverage);

    let pollHandle = null;
    function stopPolling() { if (pollHandle) { clearInterval(pollHandle); pollHandle = null; } }
    function startPolling() { stopPolling(); pollHandle = setInterval(refresh, 1800); }
    function open()  { modal.style.display = 'flex'; refresh(); loadCoverage(); startPolling(); }
    function close() { modal.style.display = 'none'; stopPolling(); }
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    function statCard(label, value, color, tooltip) {
      const titleAttr = tooltip ? ` title="${esc(tooltip)}"` : '';
      const cursor = tooltip ? 'cursor:help;' : '';
      return `<div${titleAttr} style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;${cursor}">
                <div style="font-size:10.5px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${esc(label)}</div>
                <div style="font-size:18px;font-weight:700;color:${color || '#111827'};font-variant-numeric:tabular-nums;">${esc(value)}</div>
              </div>`;
    }

    async function refresh() {
      let s;
      try {
        s = await api('/admin/batch-index/status');
      } catch (e) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Error consultando estado: ' + e.message;
        return;
      }
      if (modelEl && s.embed_model) modelEl.textContent = s.embed_model;
      const lib = s.library_stats || {};
      statsEl.innerHTML =
        statCard('Total',            lib.total ?? 0) +
        statCard('Indexables',       lib.indexable ?? 0) +
        statCard('Indexados',        lib.indexed ?? 0, '#15803d') +
        statCard('Sin modelo actual', lib.eligible ?? 0, (lib.eligible ?? 0) > 0 ? '#b45309' : '#15803d',
                 'Artículos con texto que NO tienen ningún chunk indexado con el modelo actual (voyage-4-large). ' +
                 'Un artículo puede estar aquí en 0 y aun así tener fuentes pendientes en el panel de arriba: ' +
                 'eso significa que ya tiene chunks con el modelo actual pero le falta alguna fuente (PDF, abstract o resumen IA). ' +
                 'Start procesa los artículos sin ningún chunk; los botones de cobertura añaden fuentes a los ya indexados.');

      if (s.running) {
        progWrap.style.display = 'block';
        const total = s.eligible_total || 0;
        const done  = (s.processed || 0) + (s.failed || 0) + (s.skipped || 0);
        const pct   = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        progBar.style.width = pct + '%';
        progPct.textContent = pct + '%';
        progLabel.textContent = `${done} / ${total} procesados ` +
          (s.failed ? `(${s.failed} con error) ` : '') +
          (s.skipped ? `(${s.skipped} sin texto) ` : '') +
          (s.stop_requested ? '— deteniendo…' : '— corriendo…');
        if (s.current_article) {
          currentEl.style.display = 'block';
          currentEl.innerHTML = `<strong>Actual:</strong> ${esc(s.current_article.title)}`;
        } else {
          currentEl.style.display = 'none';
        }
        startBtn.style.display = 'none';
        stopBtn.style.display = 'inline-flex';
        stopBtn.disabled = !!s.stop_requested;
      } else {
        startBtn.style.display = 'inline-flex';
        stopBtn.style.display = 'none';
        currentEl.style.display = 'none';
        const eligible = lib.eligible || 0;
        startBtn.disabled = eligible === 0;
        startBtn.style.opacity = eligible === 0 ? '0.5' : '1';
        startBtn.textContent = eligible > 0
          ? `Start (${eligible} pendiente${eligible === 1 ? '' : 's'})`
          : 'Start';
        if (s.finished_at && (s.processed || s.failed || s.skipped)) {
          progWrap.style.display = 'block';
          const total = s.eligible_total || 0;
          const done  = (s.processed || 0) + (s.failed || 0) + (s.skipped || 0);
          const pct   = total > 0 ? Math.round((done / total) * 100) : 100;
          progBar.style.width = pct + '%';
          progPct.textContent = pct + '%';
          progLabel.textContent = `Terminado: ${s.processed} OK, ${s.failed} con error, ${s.skipped} sin texto`;
        }
      }

      if (s.last_error) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Último error: ' + s.last_error;
      } else {
        errorEl.style.display = 'none';
      }

      const cost   = (s.total_cost_usd || 0).toFixed(4);
      const tok    = s.total_tokens    || 0;
      const chunks = s.total_chunks    || 0;
      costEl.textContent = (s.processed || 0) > 0
        ? `Sesión: $${cost} · ${tok} tokens · ${chunks} chunks generados`
        : (lib.chunks_in_index ? `${lib.chunks_in_index} chunks en el índice` : '');
    }

    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        await api('/admin/batch-index/start', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        refresh();
        startPolling();
      } catch (e) {
        startBtn.disabled = false;
        if (e.status === 409) {
          refresh();
        } else {
          errorEl.style.display = 'block';
          errorEl.textContent = 'No se pudo iniciar: ' + e.message;
        }
      }
    });

    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      try {
        await api('/admin/batch-index/stop', { method: 'POST' });
        refresh();
      } catch (e) {
        stopBtn.disabled = false;
        errorEl.style.display = 'block';
        errorEl.textContent = 'No se pudo detener: ' + e.message;
      }
    });

    // Add summary_ai chunks for articles that have a summary but no summary_ai chunk.
    const addSummariesBtn = document.getElementById('pv-bi-add-summaries');
    if (addSummariesBtn) {
      addSummariesBtn.addEventListener('click', async () => {
        addSummariesBtn.disabled = true;
        const orig = addSummariesBtn.textContent;
        addSummariesBtn.textContent = '⏳ Consultando…';
        let stats;
        try {
          stats = await api('/admin/embeddings/add-summaries');
        } catch (e) {
          alert('Error consultando estadísticas: ' + e.message);
          addSummariesBtn.disabled = false;
          addSummariesBtn.textContent = orig;
          return;
        } finally {
          addSummariesBtn.textContent = orig;
        }
        if (!confirm(
          `Estadísticas de resúmenes IA:\n` +
          `• Total con resumen: ${stats.total_with_summary}\n` +
          `• Ya indexados: ${stats.already_indexed}\n` +
          `• Pendientes de indexar: ${stats.pending}\n\n` +
          `Se indexarán ${stats.pending} resúmenes en background.\n` +
          `No se tocan los chunks existentes (PDF, abstract).\n\n` +
          `¿Continuar?`
        )) {
          addSummariesBtn.disabled = false;
          return;
        }
        addSummariesBtn.textContent = '⏳ Enviando…';
        try {
          const r = await api('/admin/embeddings/add-summaries', { method: 'POST' });
          alert(`OK — ${r.detail}`);
          loadCoverage();
        } catch (e) {
          alert('Error: ' + e.message);
        } finally {
          addSummariesBtn.disabled = false;
          addSummariesBtn.textContent = orig;
        }
      });
    }

    // Add abstract chunks to articles that have chunks but no abstract chunk.
    const addAbstractsBtn = document.getElementById('pv-bi-add-abstracts');
    if (addAbstractsBtn) {
      addAbstractsBtn.addEventListener('click', async () => {
        if (!confirm(
          'Añadir vectorización del abstract a todos los artículos que ya tienen\n' +
          'chunks pero no tienen chunk de tipo "abstract".\n\n' +
          '• Omite artículos marcados como "abstract no disponible".\n' +
          '• No toca los chunks existentes (PDF, summary_ai).\n' +
          '• Corre en background — la búsqueda sigue funcionando mientras tanto.\n' +
          '• Coste estimado: ~$0.25 para 4 000 artículos.\n\n' +
          '¿Continuar?'
        )) return;
        addAbstractsBtn.disabled = true;
        const orig = addAbstractsBtn.textContent;
        addAbstractsBtn.textContent = '⏳ Enviando…';
        try {
          const r = await api('/admin/embeddings/add-abstracts', { method: 'POST' });
          alert(`OK — ${r.detail}`);
          loadCoverage();
        } catch (e) {
          alert('Error: ' + e.message);
        } finally {
          addAbstractsBtn.disabled = false;
          addAbstractsBtn.textContent = orig;
        }
      });
    }

    // Add extracted_text chunks to articles that have PDF text but no extracted_text chunk.
    const addPdfBtn = document.getElementById('pv-bi-add-pdf');
    if (addPdfBtn) {
      addPdfBtn.addEventListener('click', async () => {
        if (!confirm(
          'Añadir vectorización del PDF completo a los artículos que ya tienen\n' +
          'chunks (abstract/resumen) pero les falta el texto del PDF.\n\n' +
          '• No toca los chunks existentes (abstract, summary_ai).\n' +
          '• Corre en background — la búsqueda sigue funcionando.\n\n' +
          '¿Continuar?'
        )) return;
        addPdfBtn.disabled = true;
        const orig = addPdfBtn.textContent;
        addPdfBtn.textContent = '⏳ Enviando…';
        try {
          const r = await api('/admin/embeddings/add-pdf', { method: 'POST' });
          alert(`OK — ${r.detail}`);
          loadCoverage();
        } catch (e) {
          alert('Error: ' + e.message);
        } finally {
          addPdfBtn.disabled = false;
          addPdfBtn.textContent = orig;
        }
      });
    }

    // Backfill note chunks for (article, user) pairs that had notes
    // before this feature existed — new notes reindex themselves on save.
    const addNotesBtn = document.getElementById('pv-bi-add-notes');
    if (addNotesBtn) {
      addNotesBtn.addEventListener('click', async () => {
        if (!confirm(
          'Vectorizar las notas flotantes existentes para que la búsqueda IA\n' +
          'las tenga en cuenta.\n\n' +
          '• Cada nota solo aparece en los resultados de su propio autor —\n' +
          '  nunca se mezclan las notas de un usuario con las de otro.\n' +
          '• Las notas nuevas se indexan solas al guardarlas; esto es solo\n' +
          '  para las que ya existían antes de esta función.\n' +
          '• Corre en background.\n\n' +
          '¿Continuar?'
        )) return;
        addNotesBtn.disabled = true;
        const orig = addNotesBtn.textContent;
        addNotesBtn.textContent = '⏳ Enviando…';
        try {
          const r = await api('/admin/embeddings/add-notes', { method: 'POST' });
          alert(`OK — ${r.detail}`);
          loadCoverage();
        } catch (e) {
          alert('Error: ' + e.message);
        } finally {
          addNotesBtn.disabled = false;
          addNotesBtn.textContent = orig;
        }
      });
    }

    // Full wipe + reindex. Two confirmation prompts because the
    // operation is destructive — we'd rather make the operator
    // explicitly type-through twice than recover from a misclick on
    // a 4-hour-old embedding investment.
    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        const confirm1 = confirm(
          'BORRAR todos los embeddings existentes y regenerarlos ' +
          'desde cero con el modelo actual (voyage-4-large)?\n\n' +
          '• Vacía la tabla article_chunk completa (PDF, abstract, resumen IA Y notas).\n' +
          '• Re-indexa TODAS las fuentes disponibles por artículo, pero las notas ' +
            'flotantes NO se reindexan automáticamente — usa "+ Añadir notas" después.\n' +
          '• Usa esto al cambiar de modelo (ej. Voyage-4 → Voyage-5).\n' +
          '• Durante el reindex la búsqueda IA devuelve "sin ' +
            'resultados" para los artículos aún no procesados.\n' +
          '• Tarda ~30-60 min para 4 k artículos. Coste estimado: ' +
            '$3-6 (Voyage).'
        );
        if (!confirm1) return;
        const confirm2 = prompt(
          'Para confirmar, escribe exactamente: RESET'
        );
        if (confirm2 !== 'RESET') {
          alert('Cancelado — no se ha tocado nada.');
          return;
        }
        resetBtn.disabled = true;
        const orig = resetBtn.textContent;
        resetBtn.textContent = '⏳ Vaciando…';
        try {
          await api('/admin/embeddings/reset-and-reindex', {
            method: 'POST',
            body: JSON.stringify({confirm: true}),
          });
          refresh();
          startPolling();
        } catch (e) {
          alert('Error: ' + e.message);
        } finally {
          resetBtn.disabled = false;
          resetBtn.textContent = orig;
        }
      });
    }
  }

  // ── Batch text extraction modal (pdfplumber) ─────────────────────────
  function wireBatchExtract() {
    const btn   = document.getElementById('btn-batch-extract');
    const modal = document.getElementById('pv-batch-extract-modal');
    if (!btn || !modal) return;
    const closeBtn   = document.getElementById('pv-batch-extract-close');
    const startBtn   = document.getElementById('pv-be-start');
    const stopBtn    = document.getElementById('pv-be-stop');
    const statsEl    = document.getElementById('pv-be-stats');
    const progWrap   = document.getElementById('pv-be-progress-wrap');
    const progLabel  = document.getElementById('pv-be-progress-label');
    const progBar    = document.getElementById('pv-be-progress-bar');
    const progPct    = document.getElementById('pv-be-progress-percent');
    const currentEl  = document.getElementById('pv-be-current');
    const errorEl    = document.getElementById('pv-be-error');
    const countersEl = document.getElementById('pv-be-counters');

    let pollHandle = null;
    function stopPolling() { if (pollHandle) { clearInterval(pollHandle); pollHandle = null; } }
    function startPolling() { stopPolling(); pollHandle = setInterval(refresh, 2000); }
    function open()  { modal.style.display = 'flex'; refresh(); startPolling(); }
    function close() { modal.style.display = 'none'; stopPolling(); }
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    function statCard(label, value, color) {
      return `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;">
                <div style="font-size:10.5px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${esc(label)}</div>
                <div style="font-size:18px;font-weight:700;color:${color || '#111827'};font-variant-numeric:tabular-nums;">${esc(value)}</div>
              </div>`;
    }

    async function refresh() {
      let s;
      try {
        s = await api('/admin/batch-extract/status');
      } catch (e) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Error consultando estado: ' + e.message;
        return;
      }
      const lib = s.library_stats || {};
      statsEl.innerHTML =
        statCard('Total',      lib.total ?? 0) +
        statCard('Con PDF',    lib.with_pdf ?? 0) +
        statCard('Con texto',  lib.with_text ?? 0, '#15803d') +
        statCard('Pendientes', lib.eligible ?? 0, '#b45309');

      if (s.running) {
        progWrap.style.display = 'block';
        const total = s.eligible_total || 0;
        const done  = (s.processed || 0) + (s.failed || 0) + (s.skipped || 0);
        const pct   = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        progBar.style.width = pct + '%';
        progPct.textContent = pct + '%';
        progLabel.textContent = `${done} / ${total} procesados ` +
          (s.failed ? `(${s.failed} con error) ` : '') +
          (s.skipped ? `(${s.skipped} sin capa de texto → para OCR) ` : '') +
          (s.stop_requested ? '— deteniendo…' : '— corriendo…');
        if (s.current_article) {
          currentEl.style.display = 'block';
          currentEl.innerHTML = `<strong>Actual:</strong> ${esc(s.current_article.title)}`;
        } else {
          currentEl.style.display = 'none';
        }
        startBtn.style.display = 'none';
        stopBtn.style.display = 'inline-flex';
        stopBtn.disabled = !!s.stop_requested;
      } else {
        startBtn.style.display = 'inline-flex';
        stopBtn.style.display = 'none';
        currentEl.style.display = 'none';
        const eligible = lib.eligible || 0;
        startBtn.disabled = eligible === 0;
        startBtn.style.opacity = eligible === 0 ? '0.5' : '1';
        startBtn.textContent = eligible > 0
          ? `Start (${eligible} pendiente${eligible === 1 ? '' : 's'})`
          : 'Start';
        if (s.finished_at && (s.processed || s.failed || s.skipped)) {
          progWrap.style.display = 'block';
          const total = s.eligible_total || 0;
          const done  = (s.processed || 0) + (s.failed || 0) + (s.skipped || 0);
          const pct   = total > 0 ? Math.round((done / total) * 100) : 100;
          progBar.style.width = pct + '%';
          progPct.textContent = pct + '%';
          progLabel.textContent =
            `Terminado: ${s.processed} OK, ${s.failed} con error, ` +
            `${s.skipped} sin capa de texto (pasa a OCR)`;
        }
      }

      if (s.last_error) {
        // Real error (download / pdfplumber crash / DB write fail).
        errorEl.style.display = 'block';
        errorEl.style.background = '#fef2f2';
        errorEl.style.borderColor = '#fecaca';
        errorEl.style.color = '#b91c1c';
        errorEl.textContent = 'Último error: ' + s.last_error;
      } else if (s.last_skipped) {
        // Not an error — this PDF is a scan and will be picked up by
        // the OCR batch. Show it as info so the user can stop reading
        // it as a failure.
        errorEl.style.display = 'block';
        errorEl.style.background = '#fef3c7';
        errorEl.style.borderColor = '#fde68a';
        errorEl.style.color = '#92400e';
        errorEl.textContent =
          'Sin capa de texto (lo recogerá el OCR): ' + s.last_skipped;
      } else {
        errorEl.style.display = 'none';
      }

      countersEl.textContent = (s.processed || 0) > 0
        ? `Sesión: ${(s.total_chars || 0).toLocaleString()} caracteres · ${s.total_pages || 0} páginas`
        : '';
    }

    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        await api('/admin/batch-extract/start', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        refresh();
        startPolling();
      } catch (e) {
        startBtn.disabled = false;
        if (e.status === 409) {
          refresh();
        } else {
          errorEl.style.display = 'block';
          errorEl.textContent = 'No se pudo iniciar: ' + e.message;
        }
      }
    });

    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      try {
        await api('/admin/batch-extract/stop', { method: 'POST' });
        refresh();
      } catch (e) {
        stopBtn.disabled = false;
        errorEl.style.display = 'block';
        errorEl.textContent = 'No se pudo detener: ' + e.message;
      }
    });
  }

  // ── Batch OCR modal (Phase 6) ────────────────────────────────────────
  function wireBatchOcr() {
    const btn   = document.getElementById('btn-batch-ocr');
    const modal = document.getElementById('pv-batch-ocr-modal');
    if (!btn || !modal) return;
    const closeBtn   = document.getElementById('pv-batch-ocr-close');
    const startBtn   = document.getElementById('pv-bo-start');
    const stopBtn    = document.getElementById('pv-bo-stop');
    const statsEl    = document.getElementById('pv-bo-stats');
    const progWrap   = document.getElementById('pv-bo-progress-wrap');
    const progLabel  = document.getElementById('pv-bo-progress-label');
    const progBar    = document.getElementById('pv-bo-progress-bar');
    const progPct    = document.getElementById('pv-bo-progress-percent');
    const currentEl  = document.getElementById('pv-bo-current');
    const errorEl    = document.getElementById('pv-bo-error');
    const countersEl = document.getElementById('pv-bo-counters');

    let pollHandle = null;
    function stopPolling() { if (pollHandle) { clearInterval(pollHandle); pollHandle = null; } }
    function startPolling() { stopPolling(); pollHandle = setInterval(refresh, 2500); }
    function open()  { modal.style.display = 'flex'; refresh(); startPolling(); }
    function close() { modal.style.display = 'none'; stopPolling(); }
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    function statCard(label, value, color) {
      return `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;">
                <div style="font-size:10.5px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${esc(label)}</div>
                <div style="font-size:18px;font-weight:700;color:${color || '#111827'};font-variant-numeric:tabular-nums;">${esc(value)}</div>
              </div>`;
    }

    async function refresh() {
      let s;
      try {
        s = await api('/admin/batch-ocr/status');
      } catch (e) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Error consultando estado: ' + e.message;
        return;
      }
      const lib = s.library_stats || {};
      statsEl.innerHTML =
        statCard('Total',      lib.total ?? 0) +
        statCard('Con PDF',    lib.with_pdf ?? 0) +
        statCard('Con texto',  lib.with_text ?? 0, '#15803d') +
        statCard('Pendientes', lib.eligible ?? 0, '#b45309');

      if (s.running) {
        progWrap.style.display = 'block';
        const total = s.eligible_total || 0;
        const done  = (s.processed || 0) + (s.failed || 0) + (s.skipped || 0);
        const pct   = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        progBar.style.width = pct + '%';
        progPct.textContent = pct + '%';
        progLabel.textContent = `${done} / ${total} procesados ` +
          (s.failed ? `(${s.failed} con error) ` : '') +
          (s.skipped ? `(${s.skipped} sin texto recuperable) ` : '') +
          (s.stop_requested ? '— deteniendo…' : '— corriendo (OCR lento)…');
        if (s.current_article) {
          currentEl.style.display = 'block';
          currentEl.innerHTML = `<strong>Actual:</strong> ${esc(s.current_article.title)}`;
        } else {
          currentEl.style.display = 'none';
        }
        startBtn.style.display = 'none';
        stopBtn.style.display = 'inline-flex';
        stopBtn.disabled = !!s.stop_requested;
      } else {
        startBtn.style.display = 'inline-flex';
        stopBtn.style.display = 'none';
        currentEl.style.display = 'none';
        const eligible = lib.eligible || 0;
        startBtn.disabled = eligible === 0;
        startBtn.style.opacity = eligible === 0 ? '0.5' : '1';
        startBtn.textContent = eligible > 0
          ? `Start (${eligible} pendiente${eligible === 1 ? '' : 's'})`
          : 'Start';
        if (s.finished_at && (s.processed || s.failed || s.skipped)) {
          progWrap.style.display = 'block';
          const total = s.eligible_total || 0;
          const done  = (s.processed || 0) + (s.failed || 0) + (s.skipped || 0);
          const pct   = total > 0 ? Math.round((done / total) * 100) : 100;
          progBar.style.width = pct + '%';
          progPct.textContent = pct + '%';
          progLabel.textContent = `Terminado: ${s.processed} OK, ${s.failed} con error, ${s.skipped} sin texto`;
        }
      }

      if (s.last_error) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Último error: ' + s.last_error;
      } else {
        errorEl.style.display = 'none';
      }

      countersEl.textContent = (s.processed || 0) > 0
        ? `Sesión: ${s.total_chars || 0} caracteres recuperados · ${s.total_pages || 0} páginas OCRd`
        : '';
    }

    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        await api('/admin/batch-ocr/start', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        refresh();
        startPolling();
      } catch (e) {
        startBtn.disabled = false;
        if (e.status === 409) {
          refresh();
        } else {
          errorEl.style.display = 'block';
          errorEl.textContent = 'No se pudo iniciar: ' + e.message;
        }
      }
    });

    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      try {
        await api('/admin/batch-ocr/stop', { method: 'POST' });
        refresh();
      } catch (e) {
        stopBtn.disabled = false;
        errorEl.style.display = 'block';
        errorEl.textContent = 'No se pudo detener: ' + e.message;
      }
    });
  }

  // ── Make PDFs searchable (ocrmypdf — embed text layer) ───────────────
  function wireBatchSearchable() {
    const btn   = document.getElementById('btn-batch-searchable');
    const modal = document.getElementById('pv-batch-searchable-modal');
    if (!btn || !modal) return;
    const closeBtn   = document.getElementById('pv-batch-searchable-close');
    const startBtn   = document.getElementById('pv-bsp-start');
    const stopBtn    = document.getElementById('pv-bsp-stop');
    const statsEl    = document.getElementById('pv-bsp-stats');
    const progWrap   = document.getElementById('pv-bsp-progress-wrap');
    const progLabel  = document.getElementById('pv-bsp-progress-label');
    const progBar    = document.getElementById('pv-bsp-progress-bar');
    const progPct    = document.getElementById('pv-bsp-progress-percent');
    const currentEl  = document.getElementById('pv-bsp-current');
    const errorEl    = document.getElementById('pv-bsp-error');
    const countersEl = document.getElementById('pv-bsp-counters');

    let pollHandle = null;
    function stopPolling() { if (pollHandle) { clearInterval(pollHandle); pollHandle = null; } }
    function startPolling() { stopPolling(); pollHandle = setInterval(refresh, 2500); }
    function open()  { modal.style.display = 'flex'; refresh(); startPolling(); }
    function close() { modal.style.display = 'none'; stopPolling(); }
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    function statCard(label, value, color) {
      return `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;">
                <div style="font-size:10.5px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${esc(label)}</div>
                <div style="font-size:18px;font-weight:700;color:${color || '#111827'};font-variant-numeric:tabular-nums;">${esc(value)}</div>
              </div>`;
    }

    function fmtMB(b) {
      if (!b) return '0';
      return (b / (1024 * 1024)).toFixed(1);
    }

    async function refresh() {
      let s;
      try {
        s = await api('/admin/batch-searchable/status');
      } catch (e) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Error consultando estado: ' + e.message;
        return;
      }
      const lib = s.library_stats || {};
      statsEl.innerHTML =
        statCard('Total',       lib.total ?? 0) +
        statCard('Con PDF',     lib.with_pdf ?? 0) +
        statCard('Searchables', lib.searchable ?? 0, '#15803d') +
        statCard('Pendientes',  lib.eligible ?? 0, '#b45309');

      if (s.running) {
        progWrap.style.display = 'block';
        const total = s.eligible_total || 0;
        const done  = (s.processed || 0) + (s.failed || 0) + (s.skipped || 0);
        const pct   = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        progBar.style.width = pct + '%';
        progPct.textContent = pct + '%';
        progLabel.textContent = `${done} / ${total} procesados ` +
          (s.failed ? `(${s.failed} con error) ` : '') +
          (s.skipped ? `(${s.skipped} ya searchables, marcados) ` : '') +
          (s.stop_requested ? '— deteniendo…' : '— corriendo (ocrmypdf lento)…');
        if (s.current_article) {
          currentEl.style.display = 'block';
          currentEl.innerHTML = `<strong>Actual:</strong> ${esc(s.current_article.title)}`;
        } else {
          currentEl.style.display = 'none';
        }
        startBtn.style.display = 'none';
        stopBtn.style.display = 'inline-flex';
        stopBtn.disabled = !!s.stop_requested;
      } else {
        startBtn.style.display = 'inline-flex';
        stopBtn.style.display = 'none';
        currentEl.style.display = 'none';
        const eligible = lib.eligible || 0;
        startBtn.disabled = eligible === 0;
        startBtn.style.opacity = eligible === 0 ? '0.5' : '1';
        startBtn.textContent = eligible > 0
          ? `Start (${eligible} pendiente${eligible === 1 ? '' : 's'})`
          : 'Start';
        if (s.finished_at && (s.processed || s.failed || s.skipped)) {
          progWrap.style.display = 'block';
          const total = s.eligible_total || 0;
          const done  = (s.processed || 0) + (s.failed || 0) + (s.skipped || 0);
          const pct   = total > 0 ? Math.round((done / total) * 100) : 100;
          progBar.style.width = pct + '%';
          progPct.textContent = pct + '%';
          progLabel.textContent =
            `Terminado: ${s.processed} embebidos, ${s.failed} con error, ` +
            `${s.skipped} ya searchables`;
        }
      }

      if (s.last_error) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Último error: ' + s.last_error;
      } else {
        errorEl.style.display = 'none';
      }

      _renderBspEventLog(s.events || []);

      countersEl.textContent = (s.processed || 0) > 0
        ? `Sesión: ${fmtMB(s.bytes_uploaded)} MB subidos a Dropbox`
        : '';

      // Notify the problematic-PDFs panel that we just refreshed status
      // so it can pull a fresh list without piggy-backing on poll timers.
      document.dispatchEvent(new CustomEvent('pv-bsp-refreshed'));
    }

    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        await api('/admin/batch-searchable/start', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        refresh();
        startPolling();
      } catch (e) {
        startBtn.disabled = false;
        if (e.status === 409) {
          refresh();
        } else {
          errorEl.style.display = 'block';
          errorEl.textContent = 'No se pudo iniciar: ' + e.message;
        }
      }
    });

    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      try {
        await api('/admin/batch-searchable/stop', { method: 'POST' });
        refresh();
      } catch (e) {
        stopBtn.disabled = false;
        errorEl.style.display = 'block';
        errorEl.textContent = 'No se pudo detener: ' + e.message;
      }
    });

    // Per-paper log controls
    const clearLogBtn = document.getElementById('pv-bsp-log-clear');
    if (clearLogBtn) clearLogBtn.addEventListener('click', async () => {
      if (!confirm('Vaciar el log de esta sesión? (los contadores procesados/fallidos no se tocan)')) return;
      try {
        await api('/admin/batch-searchable/clear-events', { method: 'POST' });
        refresh();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    });

    // Stronger reset: clears the log + the session counters + the
    // "Último error" banner all at once, AND reloads the
    // problematic-PDFs panel so resolved items disappear from the
    // dedicated section. Doesn't touch the worker — if a batch is
    // running it keeps running, just starts counting from zero again.
    const resetSessionBtn = document.getElementById('pv-bsp-log-reset');
    if (resetSessionBtn) resetSessionBtn.addEventListener('click', async () => {
      if (!confirm(
        'Limpiar a fondo? Se borran:\n\n' +
        '  • El log de eventos\n' +
        '  • El banner de "Último error"\n' +
        '  • Los contadores de esta sesión (procesados / con error / ya searchables / MB)\n\n' +
        'El batch en marcha (si lo hay) NO se detiene; solo se reinician los contadores visibles.'
      )) return;
      try {
        await api('/admin/batch-searchable/reset-session', { method: 'POST' });
        await refresh();
        await loadProblematic();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    });

    const dlLogBtn = document.getElementById('pv-bsp-log-download');
    if (dlLogBtn) dlLogBtn.addEventListener('click', async () => {
      try {
        const s = await api('/admin/batch-searchable/status');
        const events = s.events || [];
        const onlyErrors = !!document.getElementById('pv-bsp-log-errors-only')?.checked;
        _downloadBspLogCsv(onlyErrors ? events.filter(e => e.outcome === 'failed') : events);
      } catch (e) {
        alert('Error: ' + e.message);
      }
    });

    const errorsToggle = document.getElementById('pv-bsp-log-errors-only');
    // Re-render from the cache so the user sees the filter applied
    // immediately instead of waiting for the next 2.5 s status poll.
    if (errorsToggle) errorsToggle.addEventListener('change', () => {
      _renderBspEventLog(_bspEventsCache);
    });

    // ── Problematic-PDFs panel ──────────────────────────────────────
    // Independent of the in-memory event log so it survives a server
    // restart (re-queries the DB on every refresh). Loaded once at
    // modal open + on every status poll (cheap — two indexed counts
    // plus at most ~500 rows).
    const probRefreshBtn = document.getElementById('pv-bsp-prob-refresh');
    if (probRefreshBtn) probRefreshBtn.addEventListener('click', loadProblematic);

    async function loadProblematic() {
      const wrap = document.getElementById('pv-bsp-problematic-wrap');
      const list = document.getElementById('pv-bsp-prob-list');
      const cnt  = document.getElementById('pv-bsp-prob-count');
      if (!wrap || !list) return;
      let data;
      try {
        data = await api('/admin/batch-searchable/problematic');
      } catch (e) {
        wrap.style.display = 'block';
        list.innerHTML = `<div style="color:#b91c1c;padding:14px;font-size:12.5px;">
                            Error cargando: ${esc(e.message)}
                          </div>`;
        return;
      }
      const failed  = data.failed  || [];
      const skipped = data.skipped || [];
      if (!failed.length && !skipped.length) {
        wrap.style.display = 'none';
        return;
      }
      wrap.style.display = 'block';
      cnt.textContent = `· ${failed.length} con error · ${skipped.length} excluidos`;

      const sections = [];

      if (failed.length) {
        // Master + per-row picks for the failed bucket. Selection feeds
        // state.selectedIds so the operator can close the modal and
        // hit "🔍 Ver sólo seleccionados" in the main listing — same
        // pattern as the PMID manual panel.
        sections.push(`
          <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;
                      background:#fef2f2;border-bottom:1px solid #fecaca;
                      font-size:11.5px;color:#7f1d1d;font-weight:600;
                      position:sticky;top:0;z-index:1;">
            <input type="checkbox" id="pv-bsp-prob-master"
                   title="Marcar / desmarcar todos los visibles"
                   style="margin:0;cursor:pointer;width:14px;height:14px;">
            <label for="pv-bsp-prob-master" style="cursor:pointer;flex:1;">
              ⚠ Errores en esta sesión (${failed.length})
              <span style="font-weight:normal;color:#9b1c1c;">
                — la selección queda en el bulk-bar del listado principal
              </span>
            </label>
          </div>`);
        sections.push(failed.map(_bspProblemRowHtml).join(''));
      }

      if (skipped.length) {
        sections.push(`
          <div style="padding:6px 10px;background:#f3f4f6;border-top:1px solid #e5e7eb;
                      border-bottom:1px solid #e5e7eb;font-size:11.5px;
                      color:#374151;font-weight:600;">
            🚫 Excluidos permanentemente (${skipped.length})
            <span style="font-weight:normal;color:#6b7280;">
              — el batch los ignora; puedes reactivarlos uno a uno
            </span>
          </div>`);
        sections.push(skipped.map(_bspSkippedRowHtml).join(''));
      }

      list.innerHTML = sections.join('');

      // Wire per-row pick checkboxes (failed bucket only)
      const syncMaster = () => {
        const checks  = Array.from(list.querySelectorAll('.pv-bsp-prob-pick'));
        const master  = document.getElementById('pv-bsp-prob-master');
        if (!master) return;
        const total   = checks.length;
        const checked = checks.filter(c => c.checked).length;
        master.checked = total > 0 && checked === total;
        master.indeterminate = checked > 0 && checked < total;
      };
      list.querySelectorAll('.pv-bsp-prob-pick').forEach(cb => {
        cb.addEventListener('change', () => {
          if (cb.checked) state.selectedIds.add(cb.dataset.aid);
          else            state.selectedIds.delete(cb.dataset.aid);
          updateBulkBar();
          syncSelectAllHeader?.();
          syncMaster();
        });
      });
      const master = document.getElementById('pv-bsp-prob-master');
      if (master) {
        master.addEventListener('change', () => {
          list.querySelectorAll('.pv-bsp-prob-pick').forEach(cb => {
            cb.checked = master.checked;
            if (cb.checked) state.selectedIds.add(cb.dataset.aid);
            else            state.selectedIds.delete(cb.dataset.aid);
          });
          updateBulkBar();
          syncSelectAllHeader?.();
        });
        syncMaster();
      }

      // "🚫 No procesar más" → mark pdf_ocr_unavailable = TRUE
      list.querySelectorAll('.pv-bsp-prob-skip').forEach(b => {
        b.addEventListener('click', () => markOcrUnavailable(b.dataset.aid));
      });
      // "↻ Volver a intentar" (on the skipped bucket) → unset the flag
      list.querySelectorAll('.pv-bsp-prob-reenable').forEach(b => {
        b.addEventListener('click', () => unmarkOcrUnavailable(b.dataset.aid));
      });
      // "🗑 Borrar" → DELETE /api/articles/<id> (same flow as listing)
      list.querySelectorAll('.pv-bsp-prob-del').forEach(b => {
        b.addEventListener('click', () => deleteProblemRow(b.dataset.aid));
      });
    }

    async function markOcrUnavailable(aid) {
      const row = document.querySelector(`[data-prob-aid="${CSS.escape(aid)}"]`);
      if (!row) return;
      const btn = row.querySelector('.pv-bsp-prob-skip');
      if (!confirm(
        'Marcar este PDF como "no insistas más"?\n\n' +
        '• El batch Make-searchable lo dejará en paz.\n' +
        '• Puedes revertirlo desde la sección "Excluidos permanentemente".\n'
      )) return;
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳';
      try {
        await api(`/admin/articles/${aid}/ocr-unavailable`, { method: 'POST' });
        await loadProblematic();
        refresh();   // pendientes count drops by one
      } catch (e) {
        btn.disabled = false;
        btn.textContent = orig;
        alert('Error: ' + e.message);
      }
    }

    async function unmarkOcrUnavailable(aid) {
      const row = document.querySelector(`[data-prob-aid="${CSS.escape(aid)}"]`);
      if (!row) return;
      const btn = row.querySelector('.pv-bsp-prob-reenable');
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳';
      try {
        await api(`/admin/articles/${aid}/ocr-unavailable`, { method: 'DELETE' });
        await loadProblematic();
        refresh();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = orig;
        alert('Error: ' + e.message);
      }
    }

    async function deleteProblemRow(aid) {
      const row = document.querySelector(`[data-prob-aid="${CSS.escape(aid)}"]`);
      if (!row) return;
      const btn = row.querySelector('.pv-bsp-prob-del');
      if (!confirm(
        'Borrar este artículo de PrionVault?\n\n' +
        '• La fila se borra de la base de datos.\n' +
        '• El PDF de Dropbox también (queda en el historial ~30 días).\n' +
        '• Desaparece de PrionRead, PrionPacks, colecciones y ratings.\n\n' +
        'No se puede deshacer. ¿Continuar?'
      )) return;
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳';
      try {
        await api(`/articles/${aid}`, { method: 'DELETE' });
        state.selectedIds.delete(aid);
        updateBulkBar();
        await loadProblematic();
        refresh();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = orig;
        alert('Error: ' + e.message);
      }
    }

    // Refresh the problematic panel on every status poll AND on open.
    // open() already calls refresh(); the originally-defined refresh()
    // ends by calling _renderBspEventLog() — we chain loadProblematic
    // off the same poll using the modal's MutationObserver on display.
    btn.addEventListener('click', loadProblematic);
    // After every status refresh, also pull the problematic list so
    // the panel reflects the very last failure / flag change without
    // the operator hitting "Refrescar".
    document.addEventListener('pv-bsp-refreshed', loadProblematic);
  }

  // Cache the most recent events list so the "Solo errores" checkbox
  // can re-render without waiting for the next 2.5 s status poll.
  let _bspEventsCache = [];

  // ── Render helpers for the batch-searchable per-paper log ─────────────
  function _renderBspEventLog(events) {
    _bspEventsCache = events || [];
    const wrap   = document.getElementById('pv-bsp-log-wrap');
    const list   = document.getElementById('pv-bsp-log');
    const counter = document.getElementById('pv-bsp-log-count');
    if (!wrap || !list) return;
    if (!events.length) {
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = 'block';

    const onlyErrors = !!document.getElementById('pv-bsp-log-errors-only')?.checked;
    const shown = onlyErrors
      ? events.filter(e => e.outcome === 'failed')
      : events;
    const errorCount = events.filter(e => e.outcome === 'failed').length;
    counter.textContent =
      onlyErrors
        ? `(${shown.length}/${events.length} — solo errores)`
        : (errorCount
            ? `(${events.length} · ${errorCount} con error)`
            : `(${events.length})`);

    if (!shown.length) {
      list.innerHTML =
        '<div style="color:#15803d;padding:18px;text-align:center;font-size:11.5px;">' +
        '✓ Ningún error en esta sesión.</div>';
      return;
    }
    events = shown;

    list.innerHTML = events.map(e => {
      // Outcome → colour + glyph + Spanish label
      const map = {
        done:    { glyph: '✓', color: '#15803d', bg: '#f0fdf4', label: 'OK' },
        skipped: { glyph: '⟳', color: '#0f766e', bg: '#f0fdfa', label: 'ya legible' },
        failed:  { glyph: '✗', color: '#b91c1c', bg: '#fef2f2', label: 'error' },
      };
      const m = map[e.outcome] || { glyph: '·', color: '#6b7280', bg: '#f9fafb', label: e.outcome };
      const stage = e.stage ? ` (${e.stage})` : '';
      const reason = e.reason ? ` — ${e.reason}` : '';
      const t = (e.at || '').slice(11, 19);   // HH:MM:SS
      return `
        <div style="display:flex;gap:8px;padding:3px 8px;border-bottom:1px solid #f3f4f6;
                    background:${m.bg};align-items:baseline;">
          <span style="color:${m.color};font-weight:700;flex-shrink:0;width:14px;">${m.glyph}</span>
          <span style="color:#9ca3af;flex-shrink:0;width:62px;">${esc(t)}</span>
          <span style="color:${m.color};font-weight:600;flex-shrink:0;width:80px;">${esc(m.label)}${esc(stage)}</span>
          <span style="color:#374151;flex:1;min-width:0;overflow:hidden;
                       text-overflow:ellipsis;white-space:nowrap;"
                title="${esc((e.title || '') + reason)}">${esc(e.title || '(sin título)')}${esc(reason)}</span>
        </div>`;
    }).join('');
  }

  // Row template for the "errors in this session" bucket. Includes the
  // failure stage + truncated reason on a second line, a pick checkbox
  // for the bulk-bar, and three actions (PubMed lookup, skip-forever,
  // hard delete). Matches the look of the PMID manual-panel rows.
  function _bspProblemRowHtml(it) {
    const esc     = (s) => String(s ?? '').replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const escAttr = (v) => esc(String(v || ''));
    const title   = it.title || '(sin título)';
    const yearTxt = it.year ? ` · ${it.year}` : '';
    const journal = it.journal ? ` · ${esc(it.journal)}` : '';
    const authors = (it.authors || '').slice(0, 80) +
                    ((it.authors || '').length > 80 ? '…' : '');
    const checked = state.selectedIds.has(it.id) ? 'checked' : '';
    const stage   = it.stage  ? `<span style="background:#fee2e2;color:#991b1b;padding:1px 6px;border-radius:3px;font-size:10.5px;font-weight:600;">${esc(it.stage)}</span>` : '';
    const reason  = it.reason ? `<span style="color:#7f1d1d;">${esc(it.reason)}</span>` : '';
    return `
      <div data-prob-aid="${escAttr(it.id)}"
           style="border-bottom:1px solid #e5e7eb;padding:8px 10px;background:white;">
        <div style="display:flex;gap:10px;align-items:flex-start;">
          <input type="checkbox" class="pv-bsp-prob-pick" data-aid="${escAttr(it.id)}" ${checked}
                 title="Seleccionar para encontrarlo después en el listado principal"
                 style="margin-top:4px;flex-shrink:0;cursor:pointer;width:14px;height:14px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:12.5px;font-weight:600;color:#111827;line-height:1.35;
                        overflow:hidden;text-overflow:ellipsis;display:-webkit-box;
                        -webkit-line-clamp:2;-webkit-box-orient:vertical;"
                 title="${escAttr(title)}">${esc(title)}</div>
            <div style="font-size:11.5px;color:#6b7280;margin-top:2px;">
              ${esc(authors)}${yearTxt}${journal}
            </div>
            <div style="margin-top:4px;font-size:11px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
              ${stage} ${reason}
            </div>
          </div>
          <div style="flex-shrink:0;display:flex;flex-direction:column;gap:4px;align-items:flex-end;">
            <button type="button" class="pv-bsp-prob-skip" data-aid="${escAttr(it.id)}"
                    title="Marca el PDF como 'no insistas más' — el batch lo saltará. Reversible."
                    style="padding:3px 10px;border-radius:4px;border:1px solid #fde68a;background:white;color:#92400e;font-size:11px;font-weight:600;cursor:pointer;">
              🚫 No procesar más
            </button>
            <button type="button" class="pv-bsp-prob-del" data-aid="${escAttr(it.id)}"
                    title="Borra el artículo de PrionVault (también el PDF de Dropbox)."
                    style="padding:3px 10px;border-radius:4px;border:1px solid #fca5a5;background:white;color:#b91c1c;font-size:11px;font-weight:600;cursor:pointer;">
              🗑 Borrar
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // Row template for the "permanently excluded" bucket. Same layout
  // minus the stage/reason line (no error to show) and with a
  // "↻ Volver a intentar" button instead of "🚫 No procesar más".
  function _bspSkippedRowHtml(it) {
    const esc     = (s) => String(s ?? '').replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const escAttr = (v) => esc(String(v || ''));
    const title   = it.title || '(sin título)';
    const yearTxt = it.year ? ` · ${it.year}` : '';
    const journal = it.journal ? ` · ${esc(it.journal)}` : '';
    const authors = (it.authors || '').slice(0, 80) +
                    ((it.authors || '').length > 80 ? '…' : '');
    return `
      <div data-prob-aid="${escAttr(it.id)}"
           style="border-bottom:1px solid #f3f4f6;padding:8px 10px;background:#fafafa;">
        <div style="display:flex;gap:10px;align-items:flex-start;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:12.5px;font-weight:600;color:#374151;line-height:1.35;
                        overflow:hidden;text-overflow:ellipsis;display:-webkit-box;
                        -webkit-line-clamp:2;-webkit-box-orient:vertical;"
                 title="${escAttr(title)}">${esc(title)}</div>
            <div style="font-size:11.5px;color:#9ca3af;margin-top:2px;">
              ${esc(authors)}${yearTxt}${journal}
            </div>
          </div>
          <div style="flex-shrink:0;display:flex;flex-direction:column;gap:4px;align-items:flex-end;">
            <button type="button" class="pv-bsp-prob-reenable" data-aid="${escAttr(it.id)}"
                    title="Quita el flag 'no insistas más' — el PDF vuelve a la cola."
                    style="padding:3px 10px;border-radius:4px;border:1px solid #a7f3d0;background:white;color:#047857;font-size:11px;font-weight:600;cursor:pointer;">
              ↻ Volver a intentar
            </button>
            <button type="button" class="pv-bsp-prob-del" data-aid="${escAttr(it.id)}"
                    title="Borra el artículo de PrionVault (también el PDF de Dropbox)."
                    style="padding:3px 10px;border-radius:4px;border:1px solid #fca5a5;background:white;color:#b91c1c;font-size:11px;font-weight:600;cursor:pointer;">
              🗑 Borrar
            </button>
          </div>
        </div>
      </div>
    `;
  }

  function _downloadBspLogCsv(events) {
    if (!events.length) { alert('Log vacío.'); return; }
    const rows = [['at_utc', 'article_id', 'title', 'outcome', 'stage', 'reason']];
    const csvEsc = (v) => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    events.forEach(e => rows.push([e.at, e.article_id, e.title, e.outcome, e.stage, e.reason]));
    const csv = rows.map(r => r.map(csvEsc).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = url;
    a.download = `prionvault-searchable-log-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

