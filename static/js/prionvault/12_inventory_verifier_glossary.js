  // ── PubMed inventory modal ──────────────────────────────────────
  function wirePubmedInventory() {
    const btn   = document.getElementById('btn-pubmed-inventory');
    const modal = document.getElementById('pv-pubmed-inv-modal');
    if (!btn || !modal) return;
    const closeBtn = document.getElementById('pv-pubmed-inv-close');
    const statsEl  = document.getElementById('pv-pinv-stats');
    const progEl   = document.getElementById('pv-pinv-progress');
    const list     = document.getElementById('pv-pinv-list');
    const pager    = document.getElementById('pv-pinv-pager');
    const qInp     = document.getElementById('pv-pinv-q');
    const ymin     = document.getElementById('pv-pinv-ymin');
    const ymax     = document.getElementById('pv-pinv-ymax');
    const oaCb        = document.getElementById('pv-pinv-only-oa');
    const daysSelect  = document.getElementById('pv-pinv-days');
    const refrBtn  = document.getElementById('pv-pinv-refresh-pubmed');
    const stopBtn  = document.getElementById('pv-pinv-stop-harvest');
    const bulkBar  = document.getElementById('pv-pinv-bulk-bar');
    const bulkCnt  = document.getElementById('pv-pinv-bulk-count');
    const bulkImp  = document.getElementById('pv-pinv-bulk-import');
    const bulkDis  = document.getElementById('pv-pinv-bulk-dismiss');
    const bulkRec  = document.getElementById('pv-pinv-bulk-recover');
    const bulkKeep = document.getElementById('pv-pinv-bulk-keep');
    const bulkUnkp = document.getElementById('pv-pinv-bulk-unkeep');
    const bulkClr  = document.getElementById('pv-pinv-bulk-clear');
    const tabPend  = document.getElementById('pv-pinv-tab-pending');
    const tabKept  = document.getElementById('pv-pinv-tab-kept');
    const tabDism  = document.getElementById('pv-pinv-tab-dismissed');
    const tabPCnt  = document.getElementById('pv-pinv-tab-pending-count');
    const tabKCnt  = document.getElementById('pv-pinv-tab-kept-count');
    const tabDCnt  = document.getElementById('pv-pinv-tab-dismissed-count');

    // Persistent selection lives in a local Set, not state.selectedIds,
    // because these are PubMed IDs (not PrionVault UUIDs) — the bulk-bar
    // of the main listing wouldn't know what to do with them.
    const selected = new Set();
    let page = 1;
    const PAGE_SIZE = 100;
    let pollHandle = null;
    // Tracks whether the last poll saw the harvest as running, so the
    // running → idle transition can auto-reload the candidate list
    // (otherwise the user keeps seeing the cached "no hay pendientes").
    let _pinvWasRunning = false;
    // 'pending' (default) | 'kept' | 'dismissed' — toggled by the chip
    // group above the listing. Selection is cleared when the user
    // switches tabs so they can't accidentally bulk-Import what they
    // just un-dismissed (or vice versa).
    let _pinvStatus = 'pending';

    function statCard(label, value, color, clickId) {
      const clickStyle = clickId
        ? 'cursor:pointer;transition:box-shadow 0.15s;'
        : '';
      const clickAttr = clickId ? ` id="${clickId}" title="Filtrar por este criterio"` : '';
      return `<div${clickAttr} style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;${clickStyle}">
                <div style="font-size:10.5px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${esc(label)}</div>
                <div style="font-size:18px;font-weight:700;color:${color || '#111827'};font-variant-numeric:tabular-nums;">${esc(value)}</div>
              </div>`;
    }

    function open()  { modal.style.display = 'flex'; reloadStats(); reloadList(); startPoll(); }
    function close() { modal.style.display = 'none'; stopPoll(); }
    function startPoll() {
      stopPoll();
      pollHandle = setInterval(reloadStats, 4000);
    }
    function stopPoll() { if (pollHandle) clearInterval(pollHandle); pollHandle = null; }
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    async function reloadStats() {
      let s;
      try {
        s = await api('/admin/pubmed-inventory/stats');
      } catch (e) {
        statsEl.innerHTML =
          `<div style="grid-column:1/-1;color:#b91c1c;font-size:12px;padding:10px;">
             Error: ${esc(e.message)}
           </div>`;
        return;
      }
      statsEl.innerHTML =
        statCard('Catalogados (PubMed)', s.total ?? 0) +
        statCard('Ya en PrionVault',     s.imported ?? 0, '#15803d') +
        statCard('Pendientes',           s.pending ?? 0, '#b45309') +
        statCard('⭐ Marcados',           s.kept ?? 0, '#b45309') +
        statCard('Con PDF OA',           s.pending_with_oa ?? 0, '#0F3460', 'pv-pinv-stat-oa') +
        statCard('Importados sin PDF',   s.inv_no_pdf ?? 0, '#b45309');

      // Make the OA card act as a filter shortcut.
      const oaStatCard = document.getElementById('pv-pinv-stat-oa');
      if (oaStatCard) {
        oaStatCard.style.border = oaCb.checked ? '2px solid #0F3460' : '1px solid #e5e7eb';
        oaStatCard.addEventListener('click', () => {
          oaCb.checked = !oaCb.checked;
          if (daysSelect) daysSelect.value = '';
          oaStatCard.style.border = oaCb.checked ? '2px solid #0F3460' : '1px solid #e5e7eb';
          page = 1;
          reloadList();
        });
      }

      // Tab counters mirror the stat cards.
      if (tabPCnt) tabPCnt.textContent = `(${(s.pending ?? 0).toLocaleString()})`;
      if (tabKCnt) tabKCnt.textContent = `(${(s.kept ?? 0).toLocaleString()})`;
      if (tabDCnt) tabDCnt.textContent = `(${(s.dismissed ?? 0).toLocaleString()})`;

      // Per-preset pending counts.
      const perPreset = s.per_preset || [];
      const perPresetEl = document.getElementById('pv-pinv-per-preset');
      if (perPresetEl) {
        const labels = { prion: 'Prion', prion_like: 'Prion-like', aav: 'AAV gene therapy', custom: 'Personalizada' };
        perPresetEl.innerHTML = perPreset.map(p =>
          `<span style="background:#f3f4f6;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:500;">` +
          `${esc(labels[p.query_name] || p.query_name)}: <strong>${p.count}</strong> pendientes` +
          `</span>`
        ).join('');
      }

      // OA-fetcher live status under the cards. Compact one-liner so
      // it stays out of the way when the queue is drained.
      const oa = s.oa_fetcher || {};
      const oaLine = document.getElementById('pv-pinv-oa-line');
      if (oaLine) {
        if (oa.running && oa.current) {
          oaLine.style.display = 'block';
          oaLine.style.background = '#fff7ed';
          oaLine.style.borderColor = '#fed7aa';
          oaLine.style.color = '#9a3412';
          oaLine.innerHTML =
            `<i class="fas fa-cloud-arrow-down"></i> Bajando OA: <em>${esc(oa.current.title || '')}</em>` +
            ` · ${oa.fetched ?? 0} ok · ${oa.marked_unavail ?? 0} sin OA · ${oa.failed ?? 0} fallos`;
        } else if ((oa.pending ?? 0) > 0) {
          oaLine.style.display = 'block';
          oaLine.style.background = '#f9fafb';
          oaLine.style.borderColor = '#e5e7eb';
          oaLine.style.color = '#6b7280';
          oaLine.innerHTML =
            `<i class="fas fa-cloud-arrow-down"></i> ${oa.pending} pendientes de fetch OA · ` +
            `el auto-fetcher los procesa cada 60 s o al pulsar "Refrescar PubMed".`;
        } else {
          oaLine.style.display = 'none';
        }
      }

      // Harvest progress strip (while a daemon run is in flight).
      const p = s.progress || {};
      if (p.running) {
        progEl.style.display = 'block';
        progEl.style.background = '#fff7ed';
        progEl.style.borderColor = '#fed7aa';
        progEl.style.color = '#9a3412';
        const stage = ({
          esearch:   `Consultando PubMed (esearch) — ${p.pmids_seen ?? 0} PMIDs recogidos hasta ahora`,
          esummary:  `Descargando metadatos — ${p.pmids_seen ?? 0} PMIDs / ${(p.pmids_inserted ?? 0) + (p.pmids_updated ?? 0)} procesados`,
          reconcile: 'Reconciliando contra el catálogo…',
        }[p.stage] || `Trabajando (${p.stage || '…'})`);
        progEl.textContent = '⏳ ' + stage;
      } else {
        progEl.style.display = 'none';
      }
      if (stopBtn) stopBtn.style.display = p.running ? '' : 'none';

      // Detect harvest completion (running → idle) so we reload the
      // candidate list. Without this the user still sees "No quedan
      // pendientes" from the empty initial state after harvesting.
      if (_pinvWasRunning && !p.running) {
        page = 1;     // jump to first page so they land on the newest
        reloadList();
      }
      _pinvWasRunning = !!p.running;

      if (s.last_run_at && !p.running) {
        const when = new Date(s.last_run_at).toLocaleString();
        const isErr = s.last_status === 'error';
        let extra = `Último escaneo: ${when}`;
        if (isErr) extra += ' (error)';
        const summary = s.last_summary || {};
        if (summary.pmids_inserted != null) {
          extra += ` · ${summary.pmids_inserted} nuevos, ${summary.pmids_updated} actualizados`;
        }
        progEl.style.display = 'block';
        progEl.style.background = isErr ? '#fef2f2' : '#f9fafb';
        progEl.style.borderColor = isErr ? '#fecaca' : '#e5e7eb';
        progEl.style.color = isErr ? '#991b1b' : '#6b7280';
        // Show the actual error text instead of just "(error)" so the
        // operator (and the maintainer reading Sentry) can tell at a
        // glance whether PubMed rate-limited us, a parser blew up, or
        // the row simply isn't valid.
        progEl.innerHTML = isErr && s.last_error
          ? `${esc(extra)}<div style="margin-top:4px;font-family:ui-monospace,monospace;font-size:11px;color:#7f1d1d;white-space:pre-wrap;word-break:break-word;">${esc(s.last_error)}</div>`
          : esc(extra);
      }
    }

    async function reloadList() {
      list.innerHTML =
        '<div style="text-align:center;color:#9ca3af;padding:30px;font-size:13px;">Cargando…</div>';
      const params = new URLSearchParams({
        page:   String(page),
        size:   String(PAGE_SIZE),
        status: _pinvStatus,
      });
      if (qInp.value.trim())   params.set('q', qInp.value.trim());
      if (ymin.value.trim())   params.set('year_min', ymin.value.trim());
      if (ymax.value.trim())   params.set('year_max', ymax.value.trim());
      if (oaCb.checked)                  params.set('only_oa', '1');
      if (daysSelect && daysSelect.value)       params.set('days', daysSelect.value);

      let data;
      try {
        data = await api('/admin/pubmed-inventory/list?' + params.toString());
      } catch (e) {
        list.innerHTML =
          `<div style="color:#b91c1c;padding:14px;font-size:13px;">Error: ${esc(e.message)}</div>`;
        return;
      }
      if (!data.items.length) {
        const emptyMsg = _pinvStatus === 'dismissed'
          ? '— No has descartado todavía ningún PMID.'
          : _pinvStatus === 'kept'
          ? '— No has marcado ningún PMID con "Esta sí" todavía.'
          : '✓ No quedan pendientes con esos filtros.';
        list.innerHTML =
          `<div style="text-align:center;color:#15803d;padding:30px;font-size:13px;">${esc(emptyMsg)}</div>`;
        pager.innerHTML = '';
        refreshBulkBar();
        return;
      }

      // Header row with "marcar todos los visibles".
      const head = `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;
                    background:#f3f4f6;border-bottom:1px solid #e5e7eb;
                    font-size:11.5px;color:#374151;font-weight:600;
                    position:sticky;top:0;z-index:1;">
          <input type="checkbox" id="pv-pinv-master"
                 title="Marcar / desmarcar todos los visibles"
                 style="margin:0;cursor:pointer;width:14px;height:14px;">
          <label for="pv-pinv-master" style="cursor:pointer;">
            Marcar los ${data.items.length} visibles
          </label>
        </div>`;
      list.innerHTML = head + data.items.map(it => _pinvRowHtml(it, _pinvStatus)).join('');

      // Wire row interactions
      list.querySelectorAll('.pv-pinv-pick').forEach(cb => {
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(cb.dataset.pmid);
          else            selected.delete(cb.dataset.pmid);
          syncMaster();
          refreshBulkBar();
        });
      });
      list.querySelectorAll('.pv-pinv-import-one').forEach(b => {
        b.addEventListener('click', () => doImport([b.dataset.pmid], b));
      });
      list.querySelectorAll('.pv-pinv-dismiss-one').forEach(b => {
        b.addEventListener('click', () => doDismiss([b.dataset.pmid], b));
      });
      list.querySelectorAll('.pv-pinv-recover-one').forEach(b => {
        b.addEventListener('click', () => doRecover([b.dataset.pmid], b));
      });
      list.querySelectorAll('.pv-pinv-keep-one').forEach(b => {
        b.addEventListener('click', () => doKeep([b.dataset.pmid], b));
      });
      list.querySelectorAll('.pv-pinv-unkeep-one').forEach(b => {
        b.addEventListener('click', () => doUnkeep([b.dataset.pmid], b));
      });
      const master = document.getElementById('pv-pinv-master');
      if (master) {
        master.addEventListener('change', () => {
          list.querySelectorAll('.pv-pinv-pick').forEach(cb => {
            cb.checked = master.checked;
            if (cb.checked) selected.add(cb.dataset.pmid);
            else            selected.delete(cb.dataset.pmid);
          });
          refreshBulkBar();
        });
        syncMaster();
      }

      // Pager
      const total = data.total || 0;
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      pager.innerHTML = `
        <span>${total.toLocaleString()} pendientes · página ${page} / ${pages}</span>
        <span style="display:flex;gap:6px;">
          <button id="pv-pinv-prev" type="button" ${page <= 1 ? 'disabled' : ''}
                  style="padding:4px 10px;border-radius:5px;border:1px solid #d1d5db;background:white;color:#374151;font-size:12px;cursor:pointer;">← Anterior</button>
          <button id="pv-pinv-next" type="button" ${page >= pages ? 'disabled' : ''}
                  style="padding:4px 10px;border-radius:5px;border:1px solid #d1d5db;background:white;color:#374151;font-size:12px;cursor:pointer;">Siguiente →</button>
        </span>`;
      document.getElementById('pv-pinv-prev')?.addEventListener('click', () => { page--; reloadList(); });
      document.getElementById('pv-pinv-next')?.addEventListener('click', () => { page++; reloadList(); });

      refreshBulkBar();
    }

    function syncMaster() {
      const checks = Array.from(list.querySelectorAll('.pv-pinv-pick'));
      const master = document.getElementById('pv-pinv-master');
      if (!master) return;
      const checked = checks.filter(c => c.checked).length;
      master.checked = checks.length > 0 && checked === checks.length;
      master.indeterminate = checked > 0 && checked < checks.length;
    }

    function refreshBulkBar() {
      const n = selected.size;
      if (n === 0) {
        bulkBar.style.display = 'none';
        return;
      }
      bulkBar.style.display = 'flex';
      bulkCnt.textContent = `${n} seleccionado${n === 1 ? '' : 's'}`;
    }

    bulkImp.addEventListener('click', () => {
      if (!selected.size) return;
      if (!confirm(`Importar ${selected.size} PMIDs a PrionVault?\n\n` +
                   '• Crea una fila por cada uno (los duplicados se marcan sin recrear).\n' +
                   '• Los abstracts se rellenan después con el batch "Reintentar abstracts".'))
        return;
      doImport(Array.from(selected), bulkImp);
    });
    bulkDis.addEventListener('click', () => {
      if (!selected.size) return;
      if (!confirm(`Descartar ${selected.size} PMIDs? (reversible — quedan ocultos pero no se borran).`)) return;
      doDismiss(Array.from(selected), bulkDis);
    });
    bulkRec.addEventListener('click', () => {
      if (!selected.size) return;
      if (!confirm(`Devolver a pendientes ${selected.size} PMIDs?`)) return;
      doRecover(Array.from(selected), bulkRec);
    });
    bulkKeep.addEventListener('click', () => {
      if (!selected.size) return;
      doKeep(Array.from(selected), bulkKeep);
    });
    bulkUnkp.addEventListener('click', () => {
      if (!selected.size) return;
      if (!confirm(`Quitar la marca "Esta sí" de ${selected.size} PMIDs?\n\n` +
                   'Volverán a aparecer como pendientes sin marca.')) return;
      doUnkeep(Array.from(selected), bulkUnkp);
    });
    bulkClr.addEventListener('click', () => {
      selected.clear();
      list.querySelectorAll('.pv-pinv-pick').forEach(cb => { cb.checked = false; });
      syncMaster();
      refreshBulkBar();
    });

    // Tabs: switch the listing between pending, kept ("Esta sí") and
    // dismissed ("Esta no"). The bulk-bar's per-state buttons are
    // swapped so the user only ever sees the actions that make sense
    // for the current tab.
    function setTab(s) {
      if (s === _pinvStatus) return;
      _pinvStatus = s;
      const on  = { background: '#0F3460', color: 'white', borderColor: '#0F3460' };
      const off = { background: 'white', color: '#374151', borderColor: '#d1d5db' };
      Object.assign(tabPend.style, s === 'pending'   ? on : off);
      Object.assign(tabKept.style, s === 'kept'      ? on : off);
      Object.assign(tabDism.style, s === 'dismissed' ? on : off);
      // Bulk button visibility per tab:
      // - pending:   Importar + Marcar (Esta sí) + Descartar (Esta no)
      // - kept:      Importar + Quitar marca + Descartar
      // - dismissed: Recuperar (+ keep makes sense too, since "Esta sí"
      //                          un-dismisses the row by design)
      bulkDis.style.display  = s === 'dismissed' ? 'none' : '';
      bulkRec.style.display  = s === 'dismissed' ? ''     : 'none';
      bulkKeep.style.display = s === 'kept'      ? 'none' : '';
      bulkUnkp.style.display = s === 'kept'      ? ''     : 'none';
      // Selection doesn't translate cleanly between tabs, so we clear
      // it on switch to avoid surprises.
      selected.clear();
      page = 1;
      refreshBulkBar();
      reloadList();
    }
    tabPend.addEventListener('click', () => setTab('pending'));
    tabKept.addEventListener('click', () => setTab('kept'));
    tabDism.addEventListener('click', () => setTab('dismissed'));

    async function doImport(pmids, btn) {
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳…';
      try {
        const r = await api('/admin/pubmed-inventory/import', {
          method: 'POST',
          body: JSON.stringify({ pmids }),
        });
        const msg = `Importados: ${r.created} · Ya estaban: ${r.duplicates}` +
                    (r.failed ? ` · Fallos: ${r.failed}` : '');
        // `toast?.(msg)` would *still* ReferenceError when `toast` is
        // undeclared (the ?. only guards null/undefined values of an
        // EXISTING binding). Guard with typeof so the import path
        // succeeds even when there's no toast helper in scope —
        // the user already sees the updated counters when the modal
        // re-renders below.
        if (typeof toast === 'function') toast(msg);
        pmids.forEach(p => selected.delete(p));
        await reloadStats();
        await reloadList();
        if (typeof refreshStats === 'function') refreshStats();
      } catch (e) {
        alert('Error importando: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    }

    async function doDismiss(pmids, btn) {
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳…';
      try {
        await api('/admin/pubmed-inventory/dismiss', {
          method: 'POST',
          body: JSON.stringify({ pmids }),
        });
        pmids.forEach(p => {
          selected.delete(p);
          const row = list.querySelector(`[data-pinv-pmid="${CSS.escape(p)}"]`);
          if (row) row.remove();
        });
        btn.disabled = false;
        btn.textContent = orig;
        reloadStats();
        refreshBulkBar();
        syncMaster();
      } catch (e) {
        alert('Error descartando: ' + e.message);
        btn.disabled = false;
        btn.textContent = orig;
      }
    }

    // Reverse of doDismiss. Only reachable from the "Descartados" tab.
    async function doRecover(pmids, btn) {
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳…';
      try {
        await api('/admin/pubmed-inventory/undismiss', {
          method: 'POST',
          body: JSON.stringify({ pmids }),
        });
        pmids.forEach(p => selected.delete(p));
        await reloadStats();
        await reloadList();
      } catch (e) {
        alert('Error recuperando: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    }

    // "Esta sí" — persistent mark that survives forever until the row
    // is imported or explicitly unkept. The backend also auto-undismisses
    // any selection that was previously dismissed (a yes overrides a no).
    async function doKeep(pmids, btn) {
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳…';
      try {
        await api('/admin/pubmed-inventory/keep', {
          method: 'POST',
          body: JSON.stringify({ pmids }),
        });
        pmids.forEach(p => {
          selected.delete(p);
          const row = list.querySelector(`[data-pinv-pmid="${CSS.escape(p)}"]`);
          if (row) {
            // Visually mark as kept and move to end of list
            row.style.opacity = '0.55';
            row.style.borderLeft = '3px solid #f59e0b';
            list.appendChild(row);
            setTimeout(() => { row.style.opacity = ''; }, 600);
          }
        });
        btn.disabled = false;
        btn.textContent = orig;
        reloadStats();
        refreshBulkBar();
        syncMaster();
      } catch (e) {
        alert('Error marcando: ' + e.message);
        btn.disabled = false;
        btn.textContent = orig;
      }
    }

    // Reverse of doKeep. Doesn't dismiss — the row just goes back to
    // plain pending.
    async function doUnkeep(pmids, btn) {
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳…';
      try {
        await api('/admin/pubmed-inventory/unkeep', {
          method: 'POST',
          body: JSON.stringify({ pmids }),
        });
        pmids.forEach(p => selected.delete(p));
        await reloadStats();
        await reloadList();
      } catch (e) {
        alert('Error quitando marca: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    }

    // Show/hide custom query textarea when "Personalizada" radio is selected.
    document.querySelectorAll('input[name="pv-pinv-preset"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const ta = document.getElementById('pv-pinv-custom-query');
        if (ta) ta.style.display = radio.value === 'custom' ? '' : 'none';
      });
    });

    refrBtn.addEventListener('click', async () => {
      refrBtn.disabled = true;
      const orig = refrBtn.innerHTML;
      refrBtn.innerHTML = '⏳ Lanzando…';
      const preset = document.querySelector('input[name="pv-pinv-preset"]:checked')?.value || 'all';
      const customQuery = document.getElementById('pv-pinv-custom-query')?.value?.trim() || '';
      const minYearVal = document.getElementById('pv-pinv-harvest-year')?.value?.trim();
      const maxYearVal = document.getElementById('pv-pinv-harvest-year-max')?.value?.trim();
      const minYear = minYearVal && /^\d{4}$/.test(minYearVal) ? parseInt(minYearVal) : null;
      const maxYear = maxYearVal && /^\d{4}$/.test(maxYearVal) ? parseInt(maxYearVal) : null;
      if (minYear && maxYear && minYear > maxYear) {
        alert('El año "Desde" no puede ser posterior al año "Hasta".');
        refrBtn.disabled = false;
        refrBtn.innerHTML = orig;
        return;
      }
      try {
        await api('/admin/pubmed-inventory/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            preset, custom_query: customQuery,
            ...(minYear ? { min_year: minYear } : {}),
            ...(maxYear ? { max_year: maxYear } : {}),
          }),
        });
        // The daemon polls hourly; we asked it to wake now. Stats poll
        // (every 4 s) will surface the progress strip within seconds.
        await reloadStats();
      } catch (e) {
        alert('Error: ' + e.message);
      } finally {
        refrBtn.disabled = false;
        refrBtn.innerHTML = orig;
      }
    });

    if (stopBtn) {
      stopBtn.addEventListener('click', async () => {
        stopBtn.disabled = true;
        try {
          await api('/admin/pubmed-inventory/stop', { method: 'POST' });
          await reloadStats();
        } catch(e) { alert('Error: ' + e.message); }
        finally { stopBtn.disabled = false; }
      });
    }

    // OA-PDF fetcher: force-drain + diagnostic panel.
    // The force-drain button wakes the daemon so it processes the
    // pending queue immediately. The collapsible panel below it
    // pulls the rolling event log on demand so the operator can see
    // WHY specific articles couldn't be fetched (pmc_html /
    // pmc_http_404 / unpaywall_no_oa / …).
    const clearSearchBtn = document.getElementById('pv-pinv-clear-search');
    if (clearSearchBtn) {
      clearSearchBtn.addEventListener('click', () => {
        qInp.value = '';
        ymin.value = '';
        ymax.value = '';
        oaCb.checked = false;
        if (daysSelect) daysSelect.value = '';
        page = 1;
        reloadList();
      });
    }

    const purgePendingBtn = document.getElementById('pv-pinv-purge-pending');
    if (purgePendingBtn) {
      purgePendingBtn.addEventListener('click', async () => {
        if (!confirm(
          '¿Borrar todos los pendientes?\n\n' +
          'Se eliminarán del inventario como si nunca se hubieran buscado.\n' +
          'Los artículos marcados con ★ y los descartados no se tocan.\n\n' +
          'Las próximas búsquedas en PubMed volverán a encontrarlos si siguen publicados.'
        )) return;
        purgePendingBtn.disabled = true;
        purgePendingBtn.textContent = '⏳ Borrando…';
        try {
          const r = await api('/admin/pubmed-inventory/purge-pending', { method: 'DELETE' });
          purgePendingBtn.textContent = `✓ ${(r.deleted || 0).toLocaleString()} borrados`;
          setTimeout(() => {
            purgePendingBtn.disabled = false;
            purgePendingBtn.textContent = '🗑 Vaciar pendientes';
          }, 3000);
          page = 1;
          reloadList();
          reloadStats();
        } catch (e) {
          purgePendingBtn.disabled = false;
          purgePendingBtn.textContent = '🗑 Vaciar pendientes';
          alert('Error: ' + e.message);
        }
      });
    }

    const oaForceBtn = document.getElementById('pv-pinv-force-oa');
    if (oaForceBtn) {
      oaForceBtn.addEventListener('click', async () => {
        oaForceBtn.disabled = true;
        const oaOrig = oaForceBtn.textContent;
        oaForceBtn.textContent = '⏳ Lanzando…';
        try {
          await api('/admin/oa-fetcher/run', { method: 'POST' });
          await reloadStats();
          // If the detail panel is open, refresh it too so the
          // operator sees the immediate change.
          const det = document.getElementById('pv-pinv-oa-detail');
          if (det && det.open) await reloadOaDetail();
        } catch (e) {
          alert('Error: ' + e.message);
        } finally {
          oaForceBtn.disabled = false;
          oaForceBtn.textContent = oaOrig;
        }
      });
    }

    // Lazy-load the OA detail panel only when the operator opens it,
    // and again on every subsequent open so the data doesn't go stale.
    const oaDetailEl = document.getElementById('pv-pinv-oa-detail');
    if (oaDetailEl) {
      oaDetailEl.addEventListener('toggle', () => {
        if (oaDetailEl.open) reloadOaDetail();
      });
    }

    async function reloadOaDetail() {
      const body = document.getElementById('pv-pinv-oa-detail-body');
      if (!body) return;
      body.innerHTML =
        '<div style="color:#9ca3af;">Cargando…</div>';
      let s;
      try {
        s = await api('/admin/oa-fetcher/status');
      } catch (e) {
        body.innerHTML =
          `<div style="color:#b91c1c;">Error: ${esc(e.message)}</div>`;
        return;
      }
      // Headline state.
      const running = s.running
        ? '<span style="color:#15803d;font-weight:600;">⚙ corriendo</span>'
        : '<span style="color:#6b7280;">idle</span>';
      const current = s.current
        ? `, procesando <em>${esc(s.current.title || '(sin título)')}</em>`
        : '';
      const counters =
        `<span style="margin-right:10px;">✓ ${s.fetched ?? 0} OK</span>` +
        `<span style="margin-right:10px;">⊘ ${s.marked_unavail ?? 0} sin OA</span>` +
        `<span>✗ ${s.failed ?? 0} fallos</span>`;
      const pending = (s.pending != null)
        ? `<div>Cola pendiente: <strong>${s.pending.toLocaleString()}</strong> artículos.</div>`
        : '';
      const lastErr = s.last_error
        ? `<div style="color:#b91c1c;margin-top:4px;">Último error: ${esc(s.last_error)}</div>`
        : '';

      // Event log: most-recent-first, render up to 30.
      const events = (s.events || []).slice(0, 30);
      const reasonLabels = {
        pmc_html:                'PMC devolvió HTML (no OA todavía)',
        pmc_not_pdf:             'PMC: respuesta no es un PDF',
        pmc_too_large:           'PMC: PDF mayor que 60 MB',
        pmc_timeout:             'PMC: timeout',
        pmc_no_id:               'PMC: sin identificador',
        pmc_fetch_failed:        'PMC: fallo de red',
        unpaywall_not_configured:'Unpaywall: falta UNPAYWALL_EMAIL',
        unpaywall_lookup_failed: 'Unpaywall: error de API',
        unpaywall_no_oa:         'Unpaywall: no hay copia OA',
        unpaywall_no_pdf_url:    'Unpaywall: marcado OA pero sin URL',
        unpaywall_download_failed:'Unpaywall: fallo de descarga',
        unknown:                 'Causa desconocida',
      };
      const explainOne = (raw) => {
        if (!raw) return '';
        // pmc_http_<code> → "PMC HTTP <code>"
        const m = String(raw).match(/^pmc_http_(\d+|err)$/);
        if (m) return `PMC HTTP ${m[1]}`;
        return reasonLabels[raw] || raw;
      };
      // The backend joins multiple reasons with " · " when both legs
      // (Unpaywall + PMC) failed, so the operator sees the full
      // diagnosis. Split, translate each side, rejoin.
      const explain = (reasonRaw) => {
        if (!reasonRaw) return '';
        return String(reasonRaw).split(' · ')
                                .map(s => explainOne(s.trim()))
                                .join(' · ');
      };
      const eventsHtml = events.length
        ? events.map(e => {
            const at = e.at
              ? new Date(e.at).toLocaleString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
              : '';
            let badge = '';
            if (e.outcome === 'fetched') {
              badge = `<span style="color:#15803d;font-weight:600;">✓ descargado</span>`;
            } else if (e.outcome === 'not_available') {
              badge = `<span style="color:#b45309;font-weight:600;">⊘ sin OA</span>`;
            } else {
              badge = `<span style="color:#b91c1c;font-weight:600;">✗ ${esc(e.outcome || 'fallo')}</span>`;
            }
            const via = e.via ? ` <span style="color:#6b7280;">via ${esc(e.via)}</span>` : '';
            const reason = e.reason
              ? ` <span style="color:#6b7280;">— ${esc(explain(e.reason))}</span>`
              : '';
            return `
              <div style="padding:3px 0;border-bottom:1px solid #f3f4f6;">
                <span style="color:#9ca3af;font-family:'JetBrains Mono',monospace;font-size:10.5px;">${esc(at)}</span>
                · ${badge}${via}${reason}
                <div style="color:#374151;margin-left:8px;font-size:11px;">${esc(e.title || '')}</div>
              </div>`;
          }).join('')
        : '<div style="color:#9ca3af;">Sin eventos todavía.</div>';

      body.innerHTML =
        `<div style="margin-bottom:6px;">${running}${current} · ${counters}</div>` +
        pending + lastErr +
        `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #e5e7eb;">` +
        `<div style="font-weight:600;color:#374151;margin-bottom:4px;">Últimos eventos</div>` +
        eventsHtml +
        `</div>`;
    }

    // Debounce-ish search box
    let qTimer = null;
    qInp.addEventListener('input', () => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => { page = 1; reloadList(); }, 350);
    });
    [ymin, ymax].forEach(inp => inp.addEventListener('change', () => { page = 1; reloadList(); }));
    oaCb.addEventListener('change', () => { page = 1; reloadList(); });
    if (daysSelect)  daysSelect.addEventListener('change',  () => { page = 1; reloadList(); });
  }

  // `status` is passed explicitly because this helper lives at module
  // scope while _pinvStatus is a closure-local inside wirePubmedInventory
  // — without the argument, the row tries to read it from the global
  // scope and throws ReferenceError (Sentry 81eab721…).
  function _pinvRowHtml(it, status) {
    const escAttr = (v) => esc(String(v || ''));
    const title   = it.title || '(sin título)';
    const yearTxt = it.year ? ` · ${it.year}` : '';
    const journal = it.journal ? ` · ${esc(it.journal)}` : '';
    const authors = (it.authors || '').slice(0, 100) +
                    ((it.authors || '').length > 100 ? '…' : '');
    const pubmedUrl = `https://pubmed.ncbi.nlm.nih.gov/${escAttr(it.pmid)}/`;
    const doiLink = it.doi
      ? `<a href="https://doi.org/${escAttr(it.doi)}" target="_blank" rel="noopener" style="color:#3730a3;text-decoration:none;font-weight:600;">DOI ↗</a>`
      : '';
    const oaBadge = it.has_oa
      ? `<a href="https://www.ncbi.nlm.nih.gov/pmc/articles/${escAttr(it.pmcid)}/" target="_blank" rel="noopener"
           title="Fulltext gratuito en PMC"
           style="font-size:10.5px;padding:2px 7px;border-radius:4px;background:#d1fae5;color:#065f46;font-weight:700;text-decoration:none;">
           ✓ PDF OA (${escAttr(it.pmcid)})
         </a>`
      : `<span title="No hay copia gratuita conocida (PMC)"
                style="font-size:10.5px;padding:2px 7px;border-radius:4px;background:#fef3c7;color:#92400e;font-weight:600;">
           Sin OA
         </span>`;
    // "Esta sí" / "Esta no" toggle buttons.
    // The keep button always appears (idempotent on the backend, so
    // pressing it on a row that's already kept is harmless and the
    // UI will redraw as "Quitar marca" on the next refresh).
    const keepBtn = it.kept
      ? `<button type="button" class="pv-pinv-unkeep-one" data-pmid="${escAttr(it.pmid)}"
                  title="Quitar la marca 'Esta sí'."
                  style="padding:4px 12px;border-radius:5px;border:1px solid #fde68a;background:#fffbeb;color:#92400e;font-size:11.5px;font-weight:600;cursor:pointer;">
           ⭐ Quitar marca
         </button>`
      : `<button type="button" class="pv-pinv-keep-one" data-pmid="${escAttr(it.pmid)}"
                  title="Esta sí — la marco para importar más tarde. Persiste hasta que la meta en PrionVault."
                  style="padding:4px 12px;border-radius:5px;border:1px solid #fde68a;background:white;color:#b45309;font-size:11.5px;font-weight:600;cursor:pointer;">
           ⭐ Esta sí
         </button>`;
    const noBtn = status === 'dismissed'
      ? `<button type="button" class="pv-pinv-recover-one" data-pmid="${escAttr(it.pmid)}"
                  title="Devolver a pendientes."
                  style="padding:4px 12px;border-radius:5px;border:1px solid #a7f3d0;background:white;color:#047857;font-size:11.5px;font-weight:600;cursor:pointer;">
           ↻ Recuperar
         </button>`
      : `<button type="button" class="pv-pinv-dismiss-one" data-pmid="${escAttr(it.pmid)}"
                  title="Esta no — descarta el PMID. Se queda en la tabla pero deja de salir en búsquedas."
                  style="padding:4px 12px;border-radius:5px;border:1px solid #fecaca;background:white;color:#b91c1c;font-size:11.5px;font-weight:600;cursor:pointer;">
           ✗ Esta no
         </button>`;
    const keptBadge = it.kept
      ? `<span title="Marcado con 'Esta sí'"
              style="font-size:10.5px;padding:2px 7px;border-radius:4px;background:#fef3c7;color:#92400e;font-weight:700;">
           ⭐ Marcado
         </span>`
      : '';
    const qLabel = { prion: '🔬 Prion', prion_like: '🧬 Prion-like', aav: '🧫 AAV', custom: '🔍 Custom' };
    const qBadge = it.query_name
      ? `<span style="font-size:10px;background:#e0e7ff;color:#3730a3;padding:1px 5px;border-radius:4px;">${esc(qLabel[it.query_name] || it.query_name)}</span>`
      : '';
    const rowBg = it.kept ? '#fffbeb' : 'white';
    const leftBorder = it.kept ? 'border-left:3px solid #f59e0b;' : '';
    return `
      <div data-pinv-pmid="${escAttr(it.pmid)}"
           style="border-bottom:1px solid #e5e7eb;${leftBorder}padding:8px 10px;background:${rowBg};">
        <div style="display:flex;gap:10px;align-items:flex-start;">
          <input type="checkbox" class="pv-pinv-pick" data-pmid="${escAttr(it.pmid)}"
                 style="margin-top:4px;flex-shrink:0;cursor:pointer;width:14px;height:14px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:12.5px;font-weight:600;color:#111827;line-height:1.35;
                        overflow:hidden;text-overflow:ellipsis;display:-webkit-box;
                        -webkit-line-clamp:2;-webkit-box-orient:vertical;"
                 title="${escAttr(title)}">${esc(title)}</div>
            <div style="font-size:11.5px;color:#6b7280;margin-top:2px;">
              ${esc(authors)}${yearTxt}${journal}
            </div>
            <div style="margin-top:5px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:11.5px;">
              <a href="${escAttr(pubmedUrl)}" target="_blank" rel="noopener"
                 style="padding:2px 7px;border-radius:4px;background:#dbeafe;color:#1d4ed8;font-weight:600;text-decoration:none;">
                PMID ${escAttr(it.pmid)} ↗
              </a>
              ${doiLink ? `<span>${doiLink}</span>` : ''}
              ${oaBadge}
              ${keptBadge}
              ${qBadge}
            </div>
          </div>
          <div style="flex-shrink:0;display:flex;flex-direction:column;gap:4px;align-items:flex-end;">
            <button type="button" class="pv-pinv-import-one" data-pmid="${escAttr(it.pmid)}"
                    title="Crea la fila en PrionVault con estos metadatos. El abstract lo rellena el batch Reintentar."
                    style="padding:4px 12px;border-radius:5px;border:none;background:#15803d;color:white;font-size:11.5px;font-weight:600;cursor:pointer;">
              ➕ Importar
            </button>
            ${keepBtn}
            ${noBtn}
          </div>
        </div>
      </div>
    `;
  }

  // ── PDF ↔ metadata verifier modal ──────────────────────────────
  function wireVerifyMetadata() {
    const btn   = document.getElementById('btn-verify-metadata');
    const modal = document.getElementById('pv-verify-meta-modal');
    if (!btn || !modal) return;
    const closeBtn  = document.getElementById('pv-vm-close');
    const statsEl   = document.getElementById('pv-vm-stats');
    const progEl    = document.getElementById('pv-vm-progress');
    const startBtn  = document.getElementById('pv-vm-start');
    const stopBtn   = document.getElementById('pv-vm-stop');
    const providerS = document.getElementById('pv-vm-provider');
    const recheckCb = document.getElementById('pv-vm-recheck');
    const list      = document.getElementById('pv-vm-list');
    const pager     = document.getElementById('pv-vm-pager');
    const bulkBar   = document.getElementById('pv-vm-bulk-bar');
    const bulkCnt   = document.getElementById('pv-vm-bulk-count');
    const bulkOk    = document.getElementById('pv-vm-bulk-ok');
    const bulkRec   = document.getElementById('pv-vm-bulk-recheck');
    const bulkClr   = document.getElementById('pv-vm-bulk-clear');
    const bulkView  = document.getElementById('pv-vm-bulk-view');
    const tabViewAll = document.getElementById('pv-vm-tab-view-all');
    const tabMis    = document.getElementById('pv-vm-tab-mismatch');
    const tabSus    = document.getElementById('pv-vm-tab-suspect');
    const tabOk     = document.getElementById('pv-vm-tab-ok');
    const tabNoPdf  = document.getElementById('pv-vm-tab-no-pdf');
    const cntMis    = document.getElementById('pv-vm-tab-mismatch-count');
    const cntSus    = document.getElementById('pv-vm-tab-suspect-count');
    const cntOk     = document.getElementById('pv-vm-tab-ok-count');
    const cntNoPdf  = document.getElementById('pv-vm-tab-no-pdf-count');

    const selected = new Set();
    let _vmStatus = 'mismatch';   // default tab — riskiest stuff first
    let page = 1;
    const PAGE_SIZE = 50;
    let pollHandle = null;

    function open()  { modal.style.display = 'flex'; reloadStats(); reloadList(); startPoll(); }
    function close() { modal.style.display = 'none'; stopPoll(); }
    function startPoll() { stopPoll(); pollHandle = setInterval(reloadStats, 2500); }
    function stopPoll()  { if (pollHandle) clearInterval(pollHandle); pollHandle = null; }
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    function statCard(label, value, color) {
      return `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;">
                <div style="font-size:10.5px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${esc(label)}</div>
                <div style="font-size:18px;font-weight:700;color:${color || '#111827'};font-variant-numeric:tabular-nums;">${esc(value)}</div>
              </div>`;
    }

    async function reloadStats() {
      let s;
      try { s = await api('/admin/verify-metadata/status'); }
      catch (e) {
        statsEl.innerHTML = `<div style="grid-column:1/-1;color:#b91c1c;">Error: ${esc(e.message)}</div>`;
        return;
      }
      const t = s.totals || {};
      statsEl.innerHTML =
        statCard('Elegibles',     t.eligible ?? 0) +
        statCard('Pendientes',    t.pending ?? 0, '#b45309') +
        statCard('OK',            t.ok ?? 0, '#15803d') +
        statCard('Sospechosos',   t.suspect ?? 0, '#b45309') +
        statCard('Mismatches',    t.mismatch ?? 0, '#b91c1c');

      if (cntMis)   cntMis.textContent   = `(${(t.mismatch ?? 0).toLocaleString()})`;
      if (cntSus)   cntSus.textContent   = `(${(t.suspect ?? 0).toLocaleString()})`;
      if (cntOk)    cntOk.textContent    = `(${(t.ok ?? 0).toLocaleString()})`;
      if (cntNoPdf) cntNoPdf.textContent = `(${(t.no_pdf_text ?? 0).toLocaleString()})`;

      // Progress + buttons
      if (s.running) {
        startBtn.style.display = 'none';
        stopBtn.style.display  = 'inline-flex';
        stopBtn.disabled = !!s.stop_requested;
        progEl.style.display = 'block';
        const cur = s.current ? ` · actual: ${esc(s.current.title)}` : '';
        progEl.textContent =
          `⏳ ${s.processed}/${s.eligible_total} procesados · ` +
          `${s.ok} ok · ${s.suspect} sospechosos · ${s.mismatch} mismatches · ` +
          `${s.llm_calls} llamadas LLM${cur}`;
      } else {
        startBtn.style.display = 'inline-flex';
        stopBtn.style.display  = 'none';
        if (s.finished_at && s.processed > 0) {
          progEl.style.display = 'block';
          progEl.style.background = '#f9fafb';
          progEl.style.borderColor = '#e5e7eb';
          progEl.style.color = '#6b7280';
          progEl.textContent =
            `Terminado: ${s.processed} procesados — ` +
            `${s.ok} ok, ${s.suspect} sospechosos, ${s.mismatch} mismatches ` +
            `(${s.llm_calls} llamadas LLM)`;
        } else if (s.last_error) {
          progEl.style.display = 'block';
          progEl.style.background = '#fef2f2';
          progEl.style.borderColor = '#fecaca';
          progEl.style.color = '#991b1b';
          progEl.textContent = `Error: ${s.last_error}`;
        } else {
          progEl.style.display = 'none';
        }
      }
    }

    async function reloadList() {
      list.innerHTML =
        '<div style="text-align:center;color:#9ca3af;padding:24px;font-size:13px;">Cargando…</div>';
      const params = new URLSearchParams({
        status: _vmStatus,
        page:   String(page),
        size:   String(PAGE_SIZE),
      });
      let data;
      try { data = await api('/admin/verify-metadata/list?' + params.toString()); }
      catch (e) {
        list.innerHTML = `<div style="color:#b91c1c;padding:14px;font-size:13px;">Error: ${esc(e.message)}</div>`;
        return;
      }
      if (!data.items.length) {
        const msg = {
          mismatch:    '✓ No hay mismatches detectados.',
          suspect:     '✓ No hay artículos sospechosos.',
          ok:          'Aún no has verificado ningún artículo como OK.',
          no_pdf_text: 'No hay artículos sin texto PDF.',
        }[_vmStatus] || '— vacío';
        list.innerHTML =
          `<div style="text-align:center;color:#15803d;padding:24px;font-size:13px;">${esc(msg)}</div>`;
        pager.innerHTML = '';
        refreshBulkBar();
        return;
      }
      const head = `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;
                    background:#f3f4f6;border-bottom:1px solid #e5e7eb;
                    font-size:11.5px;color:#374151;font-weight:600;
                    position:sticky;top:0;z-index:1;">
          <input type="checkbox" id="pv-vm-master" style="margin:0;cursor:pointer;width:14px;height:14px;">
          <label for="pv-vm-master" style="cursor:pointer;">Marcar los ${data.items.length} visibles</label>
        </div>`;
      list.innerHTML = head + data.items.map(_vmRowHtml).join('');

      list.querySelectorAll('.pv-vm-pick').forEach(cb => {
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(cb.dataset.aid);
          else            selected.delete(cb.dataset.aid);
          syncMaster();
          refreshBulkBar();
        });
      });
      const master = document.getElementById('pv-vm-master');
      if (master) {
        master.addEventListener('change', () => {
          list.querySelectorAll('.pv-vm-pick').forEach(cb => {
            cb.checked = master.checked;
            if (cb.checked) selected.add(cb.dataset.aid);
            else            selected.delete(cb.dataset.aid);
          });
          refreshBulkBar();
        });
        syncMaster();
      }
      list.querySelectorAll('.pv-vm-edit-row').forEach(b => {
        b.addEventListener('click', () => openEdit(b.dataset.aid));
      });
      list.querySelectorAll('.pv-vm-mark-ok').forEach(b => {
        b.addEventListener('click', () => doMark([b.dataset.aid], 'manual_ok', b));
      });
      list.querySelectorAll('.pv-vm-recheck-one').forEach(b => {
        b.addEventListener('click', () => doRecheck([b.dataset.aid], b));
      });

      const total = data.total || 0;
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      pager.innerHTML = `
        <span>${total.toLocaleString()} resultados · página ${page} / ${pages}</span>
        <span style="display:flex;gap:6px;">
          <button id="pv-vm-prev" type="button" ${page <= 1 ? 'disabled' : ''}
                  style="padding:4px 10px;border-radius:5px;border:1px solid #d1d5db;background:white;color:#374151;font-size:12px;cursor:pointer;">← Anterior</button>
          <button id="pv-vm-next" type="button" ${page >= pages ? 'disabled' : ''}
                  style="padding:4px 10px;border-radius:5px;border:1px solid #d1d5db;background:white;color:#374151;font-size:12px;cursor:pointer;">Siguiente →</button>
        </span>`;
      document.getElementById('pv-vm-prev')?.addEventListener('click', () => { page--; reloadList(); });
      document.getElementById('pv-vm-next')?.addEventListener('click', () => { page++; reloadList(); });
      refreshBulkBar();
    }

    function syncMaster() {
      const checks = Array.from(list.querySelectorAll('.pv-vm-pick'));
      const master = document.getElementById('pv-vm-master');
      if (!master) return;
      const checked = checks.filter(c => c.checked).length;
      master.checked = checks.length > 0 && checked === checks.length;
      master.indeterminate = checked > 0 && checked < checks.length;
    }

    function refreshBulkBar() {
      const n = selected.size;
      if (n === 0) { bulkBar.style.display = 'none'; return; }
      bulkBar.style.display = 'flex';
      bulkCnt.textContent = `${n} seleccionado${n === 1 ? '' : 's'}`;
      if (bulkView) bulkView.textContent = `↗ Ver selección en listado (${n})`;
    }

    function setTab(s) {
      if (s === _vmStatus) return;
      _vmStatus = s;
      [[tabMis, 'mismatch', '#b91c1c', '#fee2e2', '#7f1d1d'],
       [tabSus, 'suspect',  '#b45309', '#fef3c7', '#7c2d12'],
       [tabOk,  'ok',       '#047857', '#d1fae5', '#065f46'],
       [tabNoPdf, 'no_pdf_text', '#6b7280', '#f3f4f6', '#374151']].forEach(([el, key, hot, bgOn, fgOn]) => {
        if (!el) return;
        if (s === key) {
          el.style.border = `1px solid ${hot}`;
          el.style.background = bgOn;
          el.style.color = fgOn;
          el.style.fontWeight = '700';
        } else {
          el.style.border = '1px solid #d1d5db';
          el.style.background = 'white';
          el.style.color = '#374151';
          el.style.fontWeight = '600';
        }
      });
      selected.clear();
      page = 1;
      _updateTabViewAllLabel();
      refreshBulkBar();
      reloadList();
    }
    tabMis.addEventListener('click',   () => setTab('mismatch'));
    tabSus.addEventListener('click',   () => setTab('suspect'));
    tabOk.addEventListener('click',    () => setTab('ok'));
    tabNoPdf.addEventListener('click', () => setTab('no_pdf_text'));

    bulkOk.addEventListener('click', () => {
      if (!selected.size) return;
      if (!confirm(`Marcar ${selected.size} como OK manual? (queda registrado que tú los revisaste)`)) return;
      doMark(Array.from(selected), 'manual_ok', bulkOk);
    });
    bulkRec.addEventListener('click', () => {
      if (!selected.size) return;
      if (!confirm(`Reverificar ${selected.size}? Se borra el veredicto y entran en la cola.`)) return;
      doRecheck(Array.from(selected), bulkRec);
    });
    bulkClr.addEventListener('click', () => {
      selected.clear();
      list.querySelectorAll('.pv-vm-pick').forEach(cb => { cb.checked = false; });
      syncMaster();
      refreshBulkBar();
    });

    function openInMainList(ids) {
      if (!ids || !ids.length) { alert('No hay artículos que mostrar.'); return; }
      close();
      // Use the global ids filter: close modal, reset filters, apply ids
      if (typeof window._pvApplyIdsFilter === 'function') {
        window._pvApplyIdsFilter(ids);
      } else {
        // fallback: reload with ?ids= param (triggers a page load keeps state)
        const url = new URL(location.href);
        url.searchParams.set('ids', ids.join(','));
        location.href = url.toString();
      }
    }

    if (bulkView) {
      bulkView.addEventListener('click', () => {
        if (!selected.size) return;
        openInMainList(Array.from(selected));
      });
    }

    const _tabViewAllLabels = {
      mismatch:    '↗ Ver todos los Mismatches en listado',
      suspect:     '↗ Ver todos los Sospechosos en listado',
      ok:          '↗ Ver todos los OK en listado',
      no_pdf_text: '↗ Ver todos "Sin texto PDF" en listado',
    };
    function _updateTabViewAllLabel() {
      if (tabViewAll) tabViewAll.textContent = _tabViewAllLabels[_vmStatus] || '↗ Ver todos en listado';
    }
    _updateTabViewAllLabel();

    if (tabViewAll) {
      tabViewAll.addEventListener('click', async () => {
        tabViewAll.disabled = true;
        tabViewAll.textContent = '⏳ Cargando…';
        try {
          const data = await api(`/admin/verify-metadata/ids?status=${encodeURIComponent(_vmStatus)}`);
          openInMainList(data.ids || []);
        } catch (e) {
          alert('Error: ' + e.message);
        } finally {
          tabViewAll.disabled = false;
          tabViewAll.textContent = '↗ Ver todos en listado';
        }
      });
    }

    async function doMark(ids, status, b) {
      const orig = b.textContent;
      b.disabled = true; b.textContent = '⏳';
      try {
        await api('/admin/verify-metadata/mark', {
          method: 'POST',
          body: JSON.stringify({ ids, status }),
        });
        ids.forEach(i => selected.delete(i));
        await reloadStats();
        await reloadList();
      } catch (e) { alert('Error: ' + e.message); }
      finally { b.disabled = false; b.textContent = orig; }
    }

    async function doRecheck(ids, b) {
      const orig = b.textContent;
      b.disabled = true; b.textContent = '⏳';
      try {
        await api('/admin/verify-metadata/recheck', {
          method: 'POST',
          body: JSON.stringify({ ids }),
        });
        ids.forEach(i => selected.delete(i));
        await reloadStats();
        await reloadList();
      } catch (e) { alert('Error: ' + e.message); }
      finally { b.disabled = false; b.textContent = orig; }
    }

    async function openEdit(aid) {
      // Fetch the article fresh and open the real Edit modal directly —
      // this used to look for a `.pv-edit-row-btn` for this id in the
      // main listing and, if the row wasn't currently on-screen (the
      // common case, since verify-metadata mismatches are rarely on the
      // visible page), fall back to a `/prionvault/articles/<id>` page
      // that was never a real route, landing on a 404.
      try {
        const fresh = await api(`/articles/${aid}`);
        openEditModal(fresh);
      } catch (err) {
        alert('No se pudo abrir el editor: ' + err.message);
      }
    }

    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        await api('/admin/verify-metadata/start', {
          method: 'POST',
          body: JSON.stringify({
            provider: providerS.value,
            recheck:  recheckCb.checked,
          }),
        });
        reloadStats();
      } catch (e) {
        alert('No se pudo iniciar: ' + e.message);
      } finally {
        startBtn.disabled = false;
      }
    });
    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      try { await api('/admin/verify-metadata/stop', { method: 'POST' }); }
      catch (e) { alert(e.message); }
      finally { stopBtn.disabled = false; reloadStats(); }
    });
  }

  function _vmRowHtml(it) {
    const escAttr = (v) => esc(String(v || ''));
    const title   = it.title || '(sin título)';
    const yearTxt = it.year ? ` · ${it.year}` : '';
    const journal = it.journal ? ` · ${esc(it.journal)}` : '';
    const authors = (it.authors || '').slice(0, 100) + ((it.authors || '').length > 100 ? '…' : '');
    const score   = it.score ?? '–';
    const scoreColor = score === '–' ? '#9ca3af'
                      : score < 40 ? '#b91c1c'
                      : score < 80 ? '#b45309'
                      : '#15803d';
    const pdfHead = (it.pdf_head || '').replace(/\s+/g, ' ').slice(0, 220) + ((it.pdf_head || '').length > 220 ? '…' : '');
    return `
      <div data-vm-aid="${escAttr(it.id)}"
           style="border-bottom:1px solid #e5e7eb;padding:8px 10px;background:white;">
        <div style="display:flex;gap:10px;align-items:flex-start;">
          <input type="checkbox" class="pv-vm-pick" data-aid="${escAttr(it.id)}"
                 style="margin-top:4px;flex-shrink:0;cursor:pointer;width:14px;height:14px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:12.5px;font-weight:600;color:#111827;line-height:1.35;
                        overflow:hidden;text-overflow:ellipsis;display:-webkit-box;
                        -webkit-line-clamp:2;-webkit-box-orient:vertical;"
                 title="${escAttr(title)}">${esc(title)}</div>
            <div style="font-size:11.5px;color:#6b7280;margin-top:2px;">
              ${esc(authors)}${yearTxt}${journal}
            </div>
            <div style="font-size:11px;color:#374151;margin-top:5px;background:#f9fafb;border:1px solid #e5e7eb;padding:5px 7px;border-radius:4px;line-height:1.45;font-family:ui-monospace,monospace;">
              <strong style="color:#6b7280;">PDF dice:</strong> ${esc(pdfHead) || '<em style="color:#9ca3af;">(sin texto)</em>'}
            </div>
            ${it.detail ? `<div style="font-size:10.5px;color:#9ca3af;margin-top:4px;font-family:ui-monospace,monospace;">${esc(it.detail)}</div>` : ''}
          </div>
          <div style="flex-shrink:0;display:flex;flex-direction:column;gap:4px;align-items:flex-end;">
            <span style="font-size:18px;font-weight:700;color:${scoreColor};font-variant-numeric:tabular-nums;">${score}</span>
            <button type="button" class="pv-vm-edit-row" data-aid="${escAttr(it.id)}"
                    title="Abre el editor del artículo para corregir metadatos."
                    style="padding:3px 10px;border-radius:4px;border:1px solid #ddd6fe;background:white;color:#6d28d9;font-size:11px;font-weight:600;cursor:pointer;">
              ✏ Editar
            </button>
            <button type="button" class="pv-vm-mark-ok" data-aid="${escAttr(it.id)}"
                    title="Lo he revisado y está bien."
                    style="padding:3px 10px;border-radius:4px;border:1px solid #a7f3d0;background:white;color:#047857;font-size:11px;font-weight:600;cursor:pointer;">
              ✓ OK manual
            </button>
            <button type="button" class="pv-vm-recheck-one" data-aid="${escAttr(it.id)}"
                    title="Re-evaluar este artículo en la próxima pasada."
                    style="padding:3px 10px;border-radius:4px;border:1px solid #d1d5db;background:white;color:#374151;font-size:11px;font-weight:600;cursor:pointer;">
              🔁 Reverificar
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // ── Collapsible sidebar groups ─────────────────────────────────────
  // Each <details class="pv-sidebar-group"> with an id persists its
  // open/closed state in localStorage so the operator's preference
  // survives reloads. Defaults to open the first time.
  function wireSidebarGroups() {
    document.querySelectorAll('details.pv-sidebar-group').forEach((d) => {
      if (!d.id) return;
      const key = 'pv-group-open:' + d.id;
      try {
        const saved = localStorage.getItem(key);
        if (saved === '0') d.removeAttribute('open');
        else if (saved === '1') d.setAttribute('open', '');
      } catch (_) { /* localStorage unavailable */ }
      d.addEventListener('toggle', () => {
        try { localStorage.setItem(key, d.open ? '1' : '0'); } catch (_) {}
      });
    });
  }

  // ── Resizable sidebar ──────────────────────────────────────────────
  // The aside on the left carries a tall stack of admin actions; users
  // with longer button labels (or on smaller monitors) want a way to
  // widen it. We expose a 6 px vertical drag-strip on the right edge,
  // clamp the resulting width between 200-420 px (the brand block and
  // the nav buttons start to look bad outside that range), and persist
  // the choice in localStorage so reload doesn't lose it.
  function wireSidebarResize() {
    const aside  = document.getElementById('pv-sidebar');
    const handle = document.getElementById('pv-sidebar-resize');
    if (!aside || !handle) return;
    const MIN = 200, MAX = 420;
    const KEY = 'pv-sidebar-width';

    // Restore saved width on boot.
    try {
      const saved = parseInt(localStorage.getItem(KEY) || '', 10);
      if (saved && saved >= MIN && saved <= MAX) {
        aside.style.width = saved + 'px';
      }
    } catch (_) { /* localStorage unavailable — ignore */ }

    // Subtle hover affordance so the operator notices the strip is grabbable.
    handle.addEventListener('mouseenter', () => {
      handle.style.background = 'rgba(255,255,255,0.18)';
    });
    handle.addEventListener('mouseleave', () => {
      if (!dragging) handle.style.background = 'transparent';
    });

    let dragging = false;
    let startX = 0, startW = 0;

    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      startX = e.clientX;
      startW = aside.offsetWidth;
      handle.setPointerCapture(e.pointerId);
      handle.style.background = 'rgba(255,255,255,0.28)';
      document.body.style.userSelect = 'none';   // avoid text selection
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const w = Math.max(MIN, Math.min(MAX, startW + (e.clientX - startX)));
      aside.style.width = w + 'px';
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      handle.style.background = 'transparent';
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      try { localStorage.setItem(KEY, String(aside.offsetWidth)); } catch (_) {}
    };
    handle.addEventListener('pointerup',     endDrag);
    handle.addEventListener('pointercancel', endDrag);

    // Double-click to reset to the default width — quick escape hatch
    // if the user dragged too far and can't find the strip.
    handle.addEventListener('dblclick', () => {
      aside.style.width = '230px';
      try { localStorage.removeItem(KEY); } catch (_) {}
    });
  }

  // ── Reference-list screener ────────────────────────────────────────
  // Sidebar button → modal with a textarea where the operator pastes a
  // bibliography. The backend (services/reference_screener.py) parses
  // PMID/PMCID/DOI per entry, queries CrossRef + PubMed for metadata
  // and reports which are in PrionVault, which would import with PDF
  // OA available and which would only land as metadata. The "Importar"
  // buttons just create an articles row via the existing POST /api/
  // articles endpoint; the OA fetcher daemon picks the PDF later.
  function wireScreenRefs() {
    const btn      = document.getElementById('btn-screen-refs');
    const modal    = document.getElementById('pv-screen-refs-modal');
    const closeBtn = document.getElementById('pv-screen-refs-close');
    const runBtn   = document.getElementById('pv-screen-refs-run');
    const txt      = document.getElementById('pv-screen-refs-text');
    const upayCb   = document.getElementById('pv-screen-refs-unpaywall');
    const list     = document.getElementById('pv-screen-refs-list');
    const stats    = document.getElementById('pv-screen-refs-stats');
    const actions  = document.getElementById('pv-screen-refs-actions');
    const importAllBtn = document.getElementById('pv-screen-refs-import-all');
    const copyDoisBtn  = document.getElementById('pv-screen-refs-copy-dois');
    const selectAllRow = document.getElementById('pv-screen-refs-selectall-row');
    const selectAllCb  = document.getElementById('pv-screen-refs-select-all');
    const selectCountEl = document.getElementById('pv-screen-refs-select-count');
    if (!btn || !modal) return;

    let _lastResult = null;
    let _selected = new Set(); // indices (into _lastResult.items) the user has ticked

    btn.addEventListener('click', () => {
      modal.style.display = 'flex';
      setTimeout(() => txt.focus(), 50);
    });
    closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.querySelector('.pv-modal-backdrop').addEventListener('click',
      () => { modal.style.display = 'none'; });

    runBtn.addEventListener('click', async () => {
      const text = (txt.value || '').trim();
      if (!text) { alert('Pega primero un listado de referencias.'); return; }
      const orig = runBtn.textContent;
      runBtn.disabled = true;
      runBtn.textContent = '⏳ Analizando…';
      list.innerHTML =
        '<div style="text-align:center;color:#9ca3af;padding:30px;font-size:13px;">' +
        'Analizando ' + (upayCb.checked
          ? '(con Unpaywall — esto puede tardar varios minutos para listas largas)…'
          : '(solo PMC — rápido). Marca "Consultar Unpaywall" para detectar OA fuera de PMC.') +
        '</div>';
      stats.style.display = 'none';
      actions.style.display = 'none';
      try {
        const r = await api('/admin/screen-references', {
          method: 'POST',
          body: JSON.stringify({ text, check_unpaywall: upayCb.checked }),
        });
        _lastResult = r;
        renderResult(r);
      } catch (e) {
        list.innerHTML =
          `<div style="color:#b91c1c;padding:14px;font-size:13px;">Error: ${esc(e.message)}</div>`;
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = orig;
      }
    });

    importAllBtn.addEventListener('click', async () => {
      if (!_lastResult) return;
      const candidates = (_lastResult.items || []).filter(it =>
        !it.in_vault && (it.pmid || it.doi || it.pmcid) && it.title
      );
      if (!candidates.length) return;
      if (!confirm(
        `Importar ${candidates.length} artículos a PrionVault?\n\n` +
        '• Crea una fila por cada uno con los metadatos encontrados.\n' +
        '• Los que tengan PMC ID arrancan la descarga de PDF OA en segundo plano.\n' +
        '• Los que solo tengan metadatos quedan a la espera de PDF.\n\n' +
        '¿Continuar?'
      )) return;
      importAllBtn.disabled = true;
      importAllBtn.textContent = '⏳ Importando…';
      let ok = 0, dup = 0, fail = 0;
      for (const it of candidates) {
        try {
          const result = await _importOneRef(it);
          if (result === 'created') ok++;
          else if (result === 'duplicate') dup++;
          else fail++;
        } catch (_) { fail++; }
      }
      importAllBtn.disabled = false;
      importAllBtn.textContent = '➕ Importar todos los que faltan';
      alert(`Importados: ${ok}\nDuplicados (ya estaban): ${dup}\nFallos: ${fail}`);
      // Re-run the analysis so already-imported rows flip to "Ya en PrionVault".
      runBtn.click();
    });

    function _missingIdxs(items) {
      return items.map((it, idx) => ({ it, idx }))
        .filter(({ it }) => !it.in_vault && it.oa_hint !== 'unparseable')
        .map(({ idx }) => idx);
    }

    function _updateSelectionUi(items) {
      const missingIdxs = _missingIdxs(items);
      const n = _selected.size;
      copyDoisBtn.disabled = n === 0;
      copyDoisBtn.textContent = n ? `📋 Copiar DOIs seleccionados (${n})` : '📋 Copiar DOIs seleccionados';
      selectCountEl.textContent = n ? `${n} seleccionado${n === 1 ? '' : 's'}` : '';
      selectAllCb.checked = missingIdxs.length > 0 && missingIdxs.every(i => _selected.has(i));
      selectAllCb.indeterminate = n > 0 && !selectAllCb.checked;
    }

    function renderResult(r) {
      const items = r.items || [];
      _selected = new Set();
      // Stat cards
      stats.style.display = 'grid';
      stats.innerHTML =
        statCard('Entradas', r.stats.total ?? 0) +
        statCard('Ya en PrionVault', r.stats.in_vault ?? 0, '#15803d') +
        statCard('Faltan', r.stats.missing ?? 0, '#b45309') +
        statCard('Con PDF OA', r.stats.with_oa ?? 0, '#0F3460') +
        statCard('No reconocidas', r.stats.unparseable ?? 0, '#b91c1c');

      if (!items.length) {
        list.innerHTML =
          '<div style="text-align:center;color:#9ca3af;padding:30px;font-size:13px;">' +
          'No se extrajo ninguna entrada de ese texto.</div>';
        actions.style.display = 'none';
        selectAllRow.style.display = 'none';
        return;
      }
      list.innerHTML = items.map(_refCardHtml).join('');

      // Wire per-row import buttons.
      list.querySelectorAll('.pv-screen-import-one').forEach(b => {
        b.addEventListener('click', async () => {
          const idx = parseInt(b.dataset.idx, 10);
          const it = items[idx];
          if (!it) return;
          const orig = b.textContent;
          b.disabled = true; b.textContent = '⏳';
          try {
            const result = await _importOneRef(it);
            if (result === 'created' || result === 'duplicate') {
              b.textContent = result === 'created' ? '✓ Importado' : '✓ Ya estaba';
              b.style.background = '#15803d';
              b.style.color = 'white';
              b.style.borderColor = '#15803d';
            } else {
              b.disabled = false;
              b.textContent = orig;
              alert('No se pudo importar.');
            }
          } catch (e) {
            b.disabled = false;
            b.textContent = orig;
            alert('Error: ' + e.message);
          }
        });
      });

      // Wire per-row selection checkboxes (missing entries only).
      list.querySelectorAll('.pv-screen-select-one').forEach(cb => {
        cb.addEventListener('change', () => {
          const idx = parseInt(cb.dataset.idx, 10);
          if (cb.checked) _selected.add(idx); else _selected.delete(idx);
          _updateSelectionUi(items);
        });
      });

      const missingIdxs = _missingIdxs(items);
      const missing = items.some(it =>
        !it.in_vault && (it.pmid || it.doi || it.pmcid) && it.title);
      actions.style.display = missing ? 'flex' : 'none';
      selectAllRow.style.display = missingIdxs.length ? 'flex' : 'none';
      _updateSelectionUi(items);
    }

    selectAllCb.addEventListener('change', () => {
      const items = (_lastResult && _lastResult.items) || [];
      const missingIdxs = _missingIdxs(items);
      if (selectAllCb.checked) {
        missingIdxs.forEach(i => _selected.add(i));
      } else {
        missingIdxs.forEach(i => _selected.delete(i));
      }
      list.querySelectorAll('.pv-screen-select-one').forEach(cb => {
        cb.checked = _selected.has(parseInt(cb.dataset.idx, 10));
      });
      _updateSelectionUi(items);
    });

    copyDoisBtn.addEventListener('click', () => {
      const items = (_lastResult && _lastResult.items) || [];
      const withDoi = [..._selected].filter(idx => items[idx] && items[idx].doi);
      const withoutDoi = _selected.size - withDoi.length;
      const dois = withDoi.map(idx => items[idx].doi);
      if (!dois.length) {
        alert('Ninguno de los artículos seleccionados tiene DOI.');
        return;
      }
      navigator.clipboard.writeText(dois.join('\n')).then(() => {
        const orig = copyDoisBtn.textContent;
        copyDoisBtn.textContent = `✓ Copiados (${dois.length})`;
        setTimeout(() => { copyDoisBtn.textContent = orig; }, 1500);
        if (withoutDoi > 0) {
          alert(`${withoutDoi} de los seleccionados no tienen DOI y se han omitido de la copia.`);
        }
      }).catch(() => alert('No se pudo copiar al portapapeles.'));
    });

    function statCard(label, value, color) {
      return `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;">
                <div style="font-size:10.5px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${esc(label)}</div>
                <div style="font-size:18px;font-weight:700;color:${color || '#111827'};font-variant-numeric:tabular-nums;">${esc(value)}</div>
              </div>`;
    }
  }

  function _refCardHtml(it, idx) {
    const escAttr = (v) => esc(String(v || ''));
    const title = it.title || '(sin metadatos)';
    const meta = [
      it.authors ? esc(it.authors.split(';')[0]) + (it.authors.includes(';') ? ' et al.' : '') : '',
      it.year    ? esc(it.year)    : '',
      it.journal ? esc(it.journal) : '',
    ].filter(Boolean).join(' · ');

    const ids = [];
    if (it.pmid)  ids.push(`<a href="https://pubmed.ncbi.nlm.nih.gov/${escAttr(it.pmid)}/" target="_blank" rel="noopener" style="color:#0f766e;text-decoration:none;font-weight:600;">PMID ${escAttr(it.pmid)} ↗</a>`);
    if (it.doi)   ids.push(`<a href="https://doi.org/${escAttr(it.doi)}" target="_blank" rel="noopener" style="color:#3730a3;text-decoration:none;font-weight:600;">DOI ↗</a>`);
    if (it.pmcid) ids.push(`<a href="https://www.ncbi.nlm.nih.gov/pmc/articles/${escAttr(it.pmcid)}/" target="_blank" rel="noopener" style="color:#15803d;text-decoration:none;font-weight:600;">${escAttr(it.pmcid)} ↗</a>`);
    const idsLine = ids.length
      ? `<div style="font-size:11.5px;margin-top:4px;display:flex;gap:10px;flex-wrap:wrap;">${ids.join('')}</div>`
      : '';

    // Status badges
    let statusBadge, actionBtn;
    if (it.in_vault) {
      statusBadge = `<span style="background:#d1fae5;color:#047857;padding:3px 10px;border-radius:14px;font-size:11px;font-weight:700;">✓ Ya en PrionVault</span>`;
      actionBtn = '';
    } else if (it.oa_hint === 'unparseable') {
      statusBadge = `<span style="background:#fee2e2;color:#7f1d1d;padding:3px 10px;border-radius:14px;font-size:11px;font-weight:700;">✗ Sin identificadores</span>`;
      actionBtn = '';
    } else if (it.oa_hint === 'pmc' || it.oa_hint === 'unpaywall') {
      statusBadge = `<span style="background:#dcfce7;color:#166534;padding:3px 10px;border-radius:14px;font-size:11px;font-weight:700;">⊕ PDF OA · ${esc(it.oa_detail || '')}</span>`;
      actionBtn = `<button type="button" class="pv-screen-import-one" data-idx="${idx}"
                            style="padding:5px 11px;border-radius:5px;border:1px solid #d1d5db;background:white;color:#15803d;font-size:12px;font-weight:600;cursor:pointer;">➕ Importar</button>`;
    } else if (it.oa_hint === 'unknown') {
      statusBadge = `<span style="background:#fef3c7;color:#92400e;padding:3px 10px;border-radius:14px;font-size:11px;font-weight:700;" title="${esc(it.oa_detail || '')}">? OA por confirmar</span>`;
      actionBtn = `<button type="button" class="pv-screen-import-one" data-idx="${idx}"
                            style="padding:5px 11px;border-radius:5px;border:1px solid #d1d5db;background:white;color:#374151;font-size:12px;font-weight:600;cursor:pointer;">➕ Importar (metadatos)</button>`;
    } else {
      statusBadge = `<span style="background:#fef3c7;color:#92400e;padding:3px 10px;border-radius:14px;font-size:11px;font-weight:700;" title="${esc(it.oa_detail || '')}">◐ Solo metadatos</span>`;
      actionBtn = `<button type="button" class="pv-screen-import-one" data-idx="${idx}"
                            style="padding:5px 11px;border-radius:5px;border:1px solid #d1d5db;background:white;color:#374151;font-size:12px;font-weight:600;cursor:pointer;">➕ Importar (sin PDF)</button>`;
    }

    // Selection checkbox: only for entries that are actually missing
    // (in_vault false, identifiers parsed) — lets the operator build a
    // manual "go chase these DOIs down one by one" list instead of the
    // all-or-nothing "Importar todos los que faltan" import.
    const selectCb = (!it.in_vault && it.oa_hint !== 'unparseable')
      ? `<input type="checkbox" class="pv-screen-select-one" data-idx="${idx}"
                title="Seleccionar para copiar su DOI"
                style="margin-top:2px;flex-shrink:0;accent-color:#0F3460;cursor:pointer;">`
      : `<span style="width:13px;flex-shrink:0;"></span>`;

    return `
      <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin-bottom:8px;">
        <div style="display:flex;align-items:flex-start;gap:10px;">
          ${selectCb}
          <div style="font-size:11px;color:#9ca3af;font-weight:700;min-width:28px;text-align:right;">${it.entry_no}.</div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:#111827;line-height:1.4;">
              ${esc(title)}
            </div>
            <div style="font-size:11.5px;color:#6b7280;margin-top:2px;">${meta}</div>
            ${idsLine}
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;flex-shrink:0;min-width:170px;">
            ${statusBadge}
            ${actionBtn}
          </div>
        </div>
      </div>`;
  }

  async function _importOneRef(it) {
    // Use POST /api/articles with the metadata fetched by the
    // screener. Duplicates are recognised by DOI/PMID and return 409
    // with duplicate_of — treat as success ("ya estaba"). The OA
    // PDF auto-fetcher daemon will then pick up the row and try to
    // download the PDF for those with DOI/PMC ID.
    const body = {
      title:     it.title,
      authors:   it.authors,
      year:      it.year,
      journal:   it.journal,
      doi:       it.doi,
      pubmed_id: it.pmid,
      source:    'manual',
    };
    try {
      const r = await fetch('/prionvault/api/articles', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status === 201) return 'created';
      if (r.status === 409) return 'duplicate';
      return 'failed';
    } catch (_) {
      return 'failed';
    }
  }

  // ── AI providers status modal + sticky banner ──────────────────────
  // Polls /api/admin/ai-providers-status every 60 s globally; if any
  // provider is in a definite-failure state (quota_exhausted /
  // invalid_key) the sticky banner appears at the top of PrionVault
  // and stays visible until the next successful call clears it.
  // ── Query expansion admin modal ─────────────────────────────────────
  // Lets the operator inspect and edit the (term → expansions, kind)
  // dictionary the biomedical retriever uses to broaden queries.
  // Admin-added entries persist across deploys; seed entries refresh
  // automatically when the code's _SEED_DICTIONARY changes.
  // ── Glossary modal ───────────────────────────────────────────────────
  // Same UI/backend as the standalone /prionvault/admin/glossary page
  // (kept, for other tools that link to it directly), reimplemented here
  // as a native PrionVault modal so managing terms never leaves PrionVault.
  function wireGlossaryModal() {
    const btn      = document.getElementById('btn-glossary');
    const modal    = document.getElementById('pv-glossary-modal');
    const closeBtn = document.getElementById('pv-glossary-close');
    if (!btn || !modal) return;

    let currentTerms = [];
    let currentCategories = [];
    let activeCategory = '';
    let editingEn = null;

    const versionEl  = document.getElementById('pvgl-version');
    const chipBar     = document.getElementById('pvgl-chips');
    const searchEl    = document.getElementById('pvgl-search');
    const catOptionsEl = document.getElementById('pvgl-cat-options');
    const body        = document.getElementById('pvgl-terms-body');
    const countEl     = document.getElementById('pvgl-browse-count');
    const exportLink  = document.getElementById('pvgl-link-export');

    btn.addEventListener('click', () => { modal.style.display = 'flex'; loadGlossary(); });
    closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.querySelector('.pv-modal-backdrop').addEventListener('click',
      () => { modal.style.display = 'none'; });

    async function loadGlossary() {
      try {
        const [termsData, catData, verData] = await Promise.all([
          api('/glossary/terms'),
          api('/glossary/categories'),
          api('/glossary/version'),
        ]);
        currentTerms = termsData.terms || [];
        currentCategories = catData.categories || [];
        versionEl.textContent = verData.version ?? '—';

        chipBar.innerHTML = `<button class="pvgl-chip${activeCategory === '' ? ' active' : ''}" data-cat="" type="button">Todas</button>` +
          currentCategories.map(c => `<button class="pvgl-chip${activeCategory === c ? ' active' : ''}" data-cat="${esc(c)}" type="button">${esc(c)}</button>`).join('');
        chipBar.querySelectorAll('.pvgl-chip').forEach(chip => {
          chip.addEventListener('click', () => { activeCategory = chip.dataset.cat; renderTerms(); });
        });

        catOptionsEl.innerHTML = currentCategories.map(c => `<option value="${esc(c)}"></option>`).join('');
        renderTerms();
      } catch (e) {
        body.innerHTML = `<div style="padding:40px 16px;text-align:center;color:#8b93a1;font-size:13px;">Error al cargar el glosario: ${esc(e.message)}</div>`;
      }
    }

    function rowActions(en, disabled) {
      return `<div class="pvgl-row-actions">
        <button class="pvgl-icon-btn pvgl-edit-btn" data-en="${esc(en)}" title="Editar" ${disabled ? 'disabled' : ''}><i class="fas fa-pen"></i></button>
        <button class="pvgl-icon-btn danger pvgl-del-btn" data-en="${esc(en)}" title="Eliminar" ${disabled ? 'disabled' : ''}><i class="fas fa-trash"></i></button>
      </div>`;
    }

    function readRowHtml(t) {
      const avoid = t.term_es_avoid
        ? `<div class="pvgl-term-avoid"><i class="fas fa-exclamation-circle"></i><span class="val">${esc(t.term_es_avoid)}</span></div>`
        : '';
      return `
        <div>
          <div class="pvgl-term-en">${esc(t.term_en)}</div>
          ${t.category ? `<span class="pvgl-term-cat">${esc(t.category)}</span>` : ''}
        </div>
        <div class="pvgl-term-es">${esc(t.term_es_recommended)}${avoid}</div>
        <div class="pvgl-term-notes">${esc(t.notes || '')}</div>
        ${rowActions(t.term_en, false)}
      `;
    }

    function editRowHtml(t) {
      const en = esc(t.term_en);
      return `
        <div class="pvgl-edit-grid">
          <div><label>Español (recomendado)</label><input type="text" class="pvgl-ef-es" value="${esc(t.term_es_recommended)}"></div>
          <div><label>Evitar</label><input type="text" class="pvgl-ef-avoid" value="${esc(t.term_es_avoid || '')}"></div>
          <div><label>Categoría</label><input type="text" class="pvgl-ef-cat" value="${esc(t.category || '')}" list="pvgl-cat-options"></div>
          <div><label>Nota</label><input type="text" class="pvgl-ef-notes" value="${esc(t.notes || '')}"></div>
        </div>
        <div class="pvgl-row-actions" style="opacity:1;">
          <button class="pvgl-icon-btn pvgl-save-edit-btn" data-en="${en}" title="Guardar"><i class="fas fa-check"></i></button>
          <button class="pvgl-icon-btn pvgl-cancel-edit-btn" title="Cancelar"><i class="fas fa-times"></i></button>
        </div>
      `;
    }

    function renderTerms() {
      const q = (searchEl.value || '').trim().toLowerCase();
      let rows = currentTerms;
      if (activeCategory) rows = rows.filter(t => (t.category || '') === activeCategory);
      if (q) {
        rows = rows.filter(t =>
          (t.term_en || '').toLowerCase().includes(q) ||
          (t.term_es_recommended || '').toLowerCase().includes(q) ||
          (t.term_es_avoid || '').toLowerCase().includes(q) ||
          (t.notes || '').toLowerCase().includes(q)
        );
      }
      countEl.textContent = `${rows.length} de ${currentTerms.length} términos`;

      if (!rows.length) {
        body.innerHTML = `<div style="padding:40px 16px;text-align:center;color:#8b93a1;font-size:13px;">No se encontraron términos</div>`;
        return;
      }
      body.innerHTML = rows.map(t => {
        const editing = editingEn === t.term_en;
        return `<div class="pvgl-row${editing ? ' editing' : ''}" data-term-en="${esc(t.term_en)}">${editing ? editRowHtml(t) : readRowHtml(t)}</div>`;
      }).join('');

      body.querySelectorAll('.pvgl-edit-btn').forEach(b => b.addEventListener('click', () => { editingEn = b.dataset.en; renderTerms(); }));
      body.querySelectorAll('.pvgl-cancel-edit-btn').forEach(b => b.addEventListener('click', () => { editingEn = null; renderTerms(); }));
      body.querySelectorAll('.pvgl-del-btn').forEach(b => b.addEventListener('click', () => deleteTerm(b.dataset.en)));
      body.querySelectorAll('.pvgl-save-edit-btn').forEach(b => b.addEventListener('click', () => saveTerm(b.dataset.en)));
    }

    async function saveTerm(term_en) {
      const row = body.querySelector(`.pvgl-row[data-term-en="${CSS.escape(term_en)}"]`);
      if (!row) return;
      const payload = {
        term_en,
        term_es_recommended: row.querySelector('.pvgl-ef-es').value.trim(),
        term_es_avoid: row.querySelector('.pvgl-ef-avoid').value.trim(),
        category: row.querySelector('.pvgl-ef-cat').value.trim(),
        notes: row.querySelector('.pvgl-ef-notes').value.trim(),
      };
      if (!payload.term_es_recommended) { alert('El español (recomendado) es obligatorio'); return; }
      try {
        await api('/glossary/term', { method: 'PUT', body: JSON.stringify(payload) });
        editingEn = null;
        await loadGlossary();
      } catch (e) {
        alert('Error al guardar el término: ' + e.message);
      }
    }

    async function deleteTerm(term_en) {
      if (!confirm(`¿Eliminar "${term_en}"?`)) return;
      try {
        await api('/glossary/term?term_en=' + encodeURIComponent(term_en), { method: 'DELETE' });
        await loadGlossary();
      } catch (e) {
        alert('Error al eliminar el término: ' + e.message);
      }
    }

    // ── Add term panel ────────────────────────────────────────────────
    const addPanel = document.getElementById('pvgl-add-panel');
    document.getElementById('pvgl-add-head').addEventListener('click', () => {
      const open = addPanel.getAttribute('data-open') === 'true';
      addPanel.setAttribute('data-open', open ? 'false' : 'true');
      if (!open) document.getElementById('pvgl-f-en').focus();
    });
    document.getElementById('pvgl-btn-cancel-add').addEventListener('click', () => {
      addPanel.setAttribute('data-open', 'false');
      ['pvgl-f-en', 'pvgl-f-es', 'pvgl-f-cat', 'pvgl-f-avoid', 'pvgl-f-notes'].forEach(id => document.getElementById(id).value = '');
      document.getElementById('pvgl-add-status').textContent = '';
    });
    document.getElementById('pvgl-btn-save-add').addEventListener('click', async () => {
      const term_en = document.getElementById('pvgl-f-en').value.trim();
      const term_es_recommended = document.getElementById('pvgl-f-es').value.trim();
      const term_es_avoid = document.getElementById('pvgl-f-avoid').value.trim();
      const category = document.getElementById('pvgl-f-cat').value.trim();
      const notes = document.getElementById('pvgl-f-notes').value.trim();
      const status = document.getElementById('pvgl-add-status');
      status.style.color = '#5b6472';

      if (!term_en || !term_es_recommended) {
        status.style.color = '#c0392b';
        status.textContent = 'El término en inglés y la recomendación en español son obligatorios';
        return;
      }
      status.textContent = 'Añadiendo…';
      try {
        const data = await api('/admin/glossary/term/add', {
          method: 'POST',
          body: JSON.stringify({ term_en, term_es_recommended, term_es_avoid, category, notes }),
        });
        if (!data.ok) throw new Error(data.error || 'error desconocido');
        ['pvgl-f-en', 'pvgl-f-es', 'pvgl-f-cat', 'pvgl-f-avoid', 'pvgl-f-notes'].forEach(id => document.getElementById(id).value = '');
        status.style.color = '#1a7a4c';
        status.textContent = `✓ Añadido "${term_en}"`;
        await loadGlossary();
      } catch (e) {
        status.style.color = '#c0392b';
        status.textContent = '✗ ' + e.message;
      }
    });

    // ── Import drawer ────────────────────────────────────────────────
    const drawer = document.getElementById('pvgl-import-drawer');
    const importBackdrop = document.getElementById('pvgl-import-backdrop');
    function openDrawer() { drawer.setAttribute('data-open', 'true'); importBackdrop.setAttribute('data-open', 'true'); }
    function closeDrawer() {
      drawer.setAttribute('data-open', 'false'); importBackdrop.setAttribute('data-open', 'false');
      const st = document.getElementById('pvgl-drawer-status');
      st.style.display = 'none'; st.textContent = '';
      document.getElementById('pvgl-import-file').value = '';
    }
    document.getElementById('pvgl-btn-import').addEventListener('click', openDrawer);
    document.getElementById('pvgl-drawer-close').addEventListener('click', closeDrawer);
    importBackdrop.addEventListener('click', closeDrawer);

    const dropzone = document.getElementById('pvgl-dropzone');
    const fileInput = document.getElementById('pvgl-import-file');
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
    dropzone.addEventListener('drop', e => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      if (e.dataTransfer.files.length) { fileInput.files = e.dataTransfer.files; handleImport(); }
    });
    fileInput.addEventListener('change', handleImport);

    function parseCSV(text, isTSV) {
      const delimiter = isTSV ? '\t' : ',';
      const lines = text.trim().split('\n');
      const headers = lines[0].split(delimiter).map(h => h.trim().toLowerCase());
      const terms = [];
      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(delimiter).map(v => v.trim());
        if (values.length < 2) continue;
        const term = {};
        headers.forEach((h, idx) => { if (values[idx]) term[h] = values[idx]; });
        terms.push(term);
      }
      return terms;
    }

    async function handleImport() {
      const file = fileInput.files[0];
      if (!file) return;
      const status = document.getElementById('pvgl-drawer-status');
      const label = document.getElementById('pvgl-dropzone-label');
      label.textContent = 'Leyendo archivo…';
      status.style.display = 'none';

      try {
        const text = await file.text();
        let terms = [];
        if (file.name.endsWith('.json')) {
          terms = JSON.parse(text);
          if (!Array.isArray(terms)) terms = [terms];
        } else if (file.name.endsWith('.csv') || file.name.endsWith('.tsv')) {
          terms = parseCSV(text, file.name.endsWith('.tsv'));
        } else {
          throw new Error('Formato de archivo no soportado');
        }

        label.textContent = `Subiendo ${terms.length} términos…`;
        const data = await api('/glossary/import', { method: 'POST', body: JSON.stringify({ terms }) });

        status.style.display = 'block';
        if (data.errors && data.errors.length > 0) {
          status.style.background = '#fdf0ee'; status.style.color = '#c0392b'; status.style.border = '1px solid #f0c4bd';
          status.textContent = `⚠️ Importados ${data.imported}, con ${data.errors.length} errores — ${data.errors.slice(0, 3).join('; ')}`;
        } else {
          status.style.background = '#e9f6ef'; status.style.color = '#1a7a4c'; status.style.border = '1px solid #c7e9d4';
          status.textContent = `✓ Importados ${data.imported} términos correctamente — ahora versión ${data.new_version}`;
        }
        label.textContent = 'Arrastra un archivo aquí, o haz clic para elegir uno';
        fileInput.value = '';
        await loadGlossary();
      } catch (e) {
        status.style.display = 'block';
        status.style.background = '#fdf0ee'; status.style.color = '#c0392b'; status.style.border = '1px solid #f0c4bd';
        status.textContent = '✗ Error: ' + e.message;
        label.textContent = 'Arrastra un archivo aquí, o haz clic para elegir uno';
      }
    }

    // ── Search + export ──────────────────────────────────────────────
    searchEl.addEventListener('input', renderTerms);
    exportLink.addEventListener('click', () => {
      const header = 'English\tCastellano recomendado\tEvitar\tComentario\tCategoría';
      const lines = currentTerms.map(t => [t.term_en, t.term_es_recommended, t.term_es_avoid || '', t.notes || '', t.category || ''].join('\t'));
      const blob = new Blob([header + '\n' + lines.join('\n')], { type: 'text/tab-separated-values' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'glosario.tsv';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    });
  }

  // ── SCImago (SJR) admin modal ────────────────────────────────────────
  function wireScimago() {
    const btn   = document.getElementById('btn-scimago');
    const modal = document.getElementById('pv-scimago-modal');
    if (!btn || !modal) return;
    const closeBtn = document.getElementById('pv-scimago-close');
    const gridEl   = document.getElementById('pv-scimago-year-grid');
    const yearEl   = document.getElementById('pv-scimago-year');
    const fileEl   = document.getElementById('pv-scimago-file');
    const upBtn    = document.getElementById('pv-scimago-upload');
    const statusEl = document.getElementById('pv-scimago-status');
    const yearsEl  = document.getElementById('pv-scimago-years');
    let pollHandle = null;
    let havYears = new Set();

    // Offer every completed year from last year back to 1999 — SCImago's
    // SJR ranking starts in 1999, and asking for an earlier year makes
    // SCImago silently serve the latest year instead.
    const NOW_Y = new Date().getFullYear();
    const YEARS = [];
    for (let y = NOW_Y - 1; y >= 1999; y--) YEARS.push(y);

    function open()  { modal.style.display = 'flex'; renderGrid(); refresh(); refreshManual(); }
    function close() { modal.style.display = 'none'; if (pollHandle) { clearInterval(pollHandle); pollHandle = null; } }
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    function renderGrid() {
      // Each button opens the SCImago CSV in a new tab so the browser
      // (with the user's own IP) downloads it, then prefills the year in
      // the uploader. Server-side download is blocked by SCImago's WAF.
      gridEl.innerHTML = YEARS.map(y => {
        const has = havYears.has(y);
        return `<button class="pv-scimago-dl" data-year="${y}"
                  title="${has ? 'Ya cargado — vuelve a descargar si quieres actualizarlo' : 'Descargar ' + y + ' desde SCImago'}"
                  style="padding:6px 12px;border-radius:7px;font-size:12.5px;font-weight:600;cursor:pointer;
                         border:1px solid ${has ? '#6ee7b7' : '#d1d5db'};
                         background:${has ? '#d1fae5' : '#fff'};color:${has ? '#065f46' : '#374151'};">
                  ${has ? '✓ ' : '⬇ '}${y}</button>`;
      }).join('');
      gridEl.querySelectorAll('.pv-scimago-dl').forEach(b =>
        b.addEventListener('click', () => {
          const y = b.dataset.year;
          window.open(`https://www.scimagojr.com/journalrank.php?out=xls&year=${y}`, '_blank', 'noopener');
          yearEl.value = y;
          statusEl.style.color = '#6b7280';
          statusEl.textContent = `Descargando ${y} en tu navegador… cuando termine, súbelo aquí abajo (paso 2).`;
          fileEl.focus();
        }));
    }

    async function refresh() {
      let r;
      try { r = await api('/admin/scimago/stats'); }
      catch (e) { yearsEl.innerHTML = `<div style="color:#b91c1c;font-size:12.5px;">Error: ${esc(e.message)}</div>`; return; }
      const imp = r.import || {};
      // Lock the Import button while one is running so a burst of uploads
      // can't overlap (the server also rejects overlaps with a 409).
      upBtn.disabled = !!imp.running;
      upBtn.style.opacity = imp.running ? '0.5' : '1';
      upBtn.style.cursor  = imp.running ? 'not-allowed' : 'pointer';
      if (imp.running) {
        statusEl.style.color = '#374151';
        const ph = ({ starting: 'Iniciando', downloading: 'Descargando', parsing: 'Analizando CSV', saving: 'Guardando en la base de datos', backing_up: 'Copiando a Dropbox' })[imp.phase] || 'Trabajando';
        if (imp.total) {
          const pct = Math.max(1, Math.round(imp.processed / imp.total * 100));
          statusEl.innerHTML =
            `${esc(ph)} ${imp.year || ''} — ${Number(imp.processed).toLocaleString()} / ${Number(imp.total).toLocaleString()} (${pct}%)` +
            `<div style="height:7px;background:#e5e7eb;border-radius:5px;margin-top:6px;overflow:hidden;">` +
            `<div style="height:100%;width:${pct}%;background:#0F3460;transition:width 0.3s;"></div></div>`;
        } else {
          statusEl.textContent = `${ph} ${imp.year || ''}…`;
        }
        if (!pollHandle) pollHandle = setInterval(refresh, 1200);
      } else {
        if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
        if (imp.error) { statusEl.style.color = '#b91c1c'; statusEl.textContent = 'Error: ' + imp.error; }
        else if (imp.rows) { statusEl.style.color = '#15803d'; statusEl.textContent = `✓ ${Number(imp.rows).toLocaleString()} revistas procesadas${imp.year ? ' (' + imp.year + ')' : ''}.`; }
      }
      const years = (r.stats || {}).years || [];
      havYears = new Set(years.map(y => Number(y.year)));
      renderGrid();
      yearsEl.innerHTML = years.length
        ? years.map(y => `
            <div style="display:flex;align-items:center;gap:10px;padding:7px 10px;border:1px solid #f3f4f6;
                        border-radius:8px;margin-bottom:6px;background:#fff;">
              <span style="font-weight:700;color:#111827;font-size:13px;">${esc(y.year)}</span>
              <span style="flex:1;font-size:12px;color:#6b7280;">${Number(y.total).toLocaleString()} revistas · ${Number(y.quartiled).toLocaleString()} con cuartil</span>
              <button class="pv-scimago-del" data-year="${esc(y.year)}" title="Eliminar este año"
                      style="background:none;border:none;color:#b91c1c;cursor:pointer;font-size:13px;">🗑</button>
            </div>`).join('')
        : '<div style="color:#9ca3af;font-size:12.5px;padding:4px;">Aún no has descargado ningún año.</div>';
      yearsEl.querySelectorAll('.pv-scimago-del').forEach(b => b.addEventListener('click', async () => {
        if (!confirm(`¿Eliminar los rankings de ${b.dataset.year}?`)) return;
        try { await api('/admin/scimago/clear', { method: 'POST', body: JSON.stringify({ year: Number(b.dataset.year) }) }); refresh(); }
        catch (e) { alert('No se pudo eliminar: ' + e.message); }
      }));
    }

    // Client-side queue: you can queue several years in a row and they
    // upload one at a time, waiting for each to finish — no "otra en
    // curso" errors, no manual waiting.
    const uploadQueue = [];
    let pumping = false;
    let processingYear = null;   // year currently being uploaded/processed

    function queueLabel() {
      return uploadQueue.length
        ? ` · ${uploadQueue.length} en cola (${uploadQueue.map(q => q.year).join(', ')})`
        : '';
    }

    async function serverBusy() {
      try { const r = await api('/admin/scimago/stats'); return !!(r.import || {}).running; }
      catch { return false; }
    }

    async function pump() {
      if (pumping) return;
      pumping = true;
      try {
        while (uploadQueue.length) {
          while (await serverBusy()) await new Promise(r => setTimeout(r, 1500));
          const item = uploadQueue[0];
          processingYear = item.year;
          const fd = new FormData();
          fd.append('year', item.year);
          fd.append('file', item.file);
          statusEl.style.color = '#9ca3af';
          statusEl.textContent = `Subiendo ${item.year}…${queueLabel()}`;
          try {
            const res = await fetch('/prionvault/api/admin/scimago/import', { method: 'POST', body: fd, credentials: 'same-origin' });
            if (res.status === 409) { await new Promise(r => setTimeout(r, 1500)); continue; }
            if (!res.ok && res.status !== 202) {
              const err = await res.json().catch(() => ({}));
              throw new Error(err.detail || err.error || res.statusText);
            }
            uploadQueue.shift();               // accepted — drop from queue
            // Poll until the server finishes this one, refreshing the
            // grid each tick so the year turns green as soon as it lands.
            await new Promise(r => setTimeout(r, 800));
            let wasBusy = false;
            while (await serverBusy()) { wasBusy = true; await refresh(); await new Promise(r => setTimeout(r, 1200)); }
            // Small settle for the commit to be visible, then a couple of
            // guaranteed refreshes (covers a fast import the poll missed).
            await refresh();
            if (!wasBusy) { await new Promise(r => setTimeout(r, 600)); await refresh(); }
          } catch (e) {
            uploadQueue.shift();
            statusEl.style.color = '#b91c1c';
            statusEl.textContent = `Error con ${item.year}: ${e.message}${queueLabel()}`;
          } finally {
            processingYear = null;
          }
        }
      } finally {
        pumping = false;
        await refresh();                       // final state once queue drains
      }
    }

    upBtn.addEventListener('click', () => {
      const year = (yearEl.value || '').trim();
      const file = fileEl.files && fileEl.files[0];
      if (!year) { statusEl.style.color = '#b91c1c'; statusEl.textContent = 'Indica el año del CSV.'; return; }
      if (!file) { statusEl.style.color = '#b91c1c'; statusEl.textContent = 'Selecciona el fichero CSV.'; return; }
      // Don't allow importing a year that's already processing or queued.
      if (processingYear === year) {
        statusEl.style.color = '#92400e';
        statusEl.textContent = `El año ${year} se está importando ahora mismo — espera a que termine.`;
        return;
      }
      if (uploadQueue.some(q => q.year === year)) {
        statusEl.style.color = '#92400e';
        statusEl.textContent = `El año ${year} ya está en la cola.`;
        return;
      }
      uploadQueue.push({ year, file });
      fileEl.value = '';               // ready for the next file
      statusEl.style.color = '#6b7280';
      statusEl.textContent = `En cola: ${year}.${queueLabel()}`;
      pump();
    });

    // ── Manual journals ───────────────────────────────────────────────
    const mjJournal = document.getElementById('pv-mj-journal');
    const mjYear    = document.getElementById('pv-mj-year');
    const mjIssn    = document.getElementById('pv-mj-issn');
    const mjCountry = document.getElementById('pv-mj-country');
    const mjQuart   = document.getElementById('pv-mj-quartile');
    const mjDecile  = document.getElementById('pv-mj-decile');
    const mjPct     = document.getElementById('pv-mj-percentile');
    const mjCat     = document.getElementById('pv-mj-category');
    const mjSave    = document.getElementById('pv-mj-save');
    const mjStatus  = document.getElementById('pv-mj-status');
    const mjList    = document.getElementById('pv-mj-list');
    const scanBtn   = document.getElementById('pv-scimago-scan');
    const missingEl = document.getElementById('pv-scimago-missing');

    async function refreshManual() {
      if (!mjList) return;
      try {
        const r = await api('/admin/scimago/manual');
        const js = r.journals || [];
        mjList.innerHTML = js.length
          ? js.map(j => {
              const bits = [];
              if (j.best_quartile) bits.push(esc(j.best_quartile));
              if (j.best_decile)   bits.push(esc(j.best_decile));
              if (j.best_percentile != null) bits.push('P' + j.best_percentile);
              const q = bits.join(' · ');
              const yrLabel = j.year ? String(j.year) : 'Todos los años';
              return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid #f3f4f6;border-radius:8px;margin-bottom:5px;background:#fff;">
                <div style="flex:1;min-width:0;">
                  <div style="font-size:12.5px;font-weight:600;color:#111827;">${esc(j.title)} <span style="font-weight:500;color:#6d28d9;font-size:11px;">· ${esc(yrLabel)}</span></div>
                  <div style="font-size:11px;color:#9ca3af;">${esc(j.primary_issn || 'ISSN: Unknown')} · ${esc(j.country || 'Unknown')}${q ? ' · ' + q : ''}${j.best_category ? ' · ' + esc(j.best_category) : ''}</div>
                </div>
                <button class="pv-mj-edit" data-j="${esc(j.title)}" data-year="${j.year != null ? j.year : ''}" title="Editar" style="background:none;border:none;color:#6d28d9;cursor:pointer;font-size:13px;">✏</button>
                <button class="pv-mj-del" data-j="${esc(j.title)}" data-year="${j.year != null ? j.year : ''}" title="Eliminar" style="background:none;border:none;color:#b91c1c;cursor:pointer;font-size:13px;">🗑</button>
              </div>`;
            }).join('')
          : '<div style="color:#9ca3af;font-size:12px;padding:4px;">Aún no has añadido revistas manuales.</div>';
        mjList.querySelectorAll('.pv-mj-del').forEach(b => b.addEventListener('click', async () => {
          const yr = b.dataset.year || '';
          const yrTxt = (yr && yr !== '0') ? ` (${yr})` : ' (todos los años)';
          if (!confirm(`¿Eliminar «${b.dataset.j}»${yrTxt}?`)) return;
          try { await api('/admin/scimago/manual/delete', { method: 'POST', body: JSON.stringify({ journal: b.dataset.j, year: yr }) }); refreshManual(); }
          catch (e) { alert('No se pudo eliminar: ' + e.message); }
        }));
        mjList.querySelectorAll('.pv-mj-edit').forEach(b => b.addEventListener('click', () => {
          const j = js.find(x => x.title === b.dataset.j &&
                                  String(x.year != null ? x.year : '') === (b.dataset.year || ''));
          if (!j) return;
          mjJournal.value = j.title || '';
          if (mjYear) mjYear.value = j.year || '';
          mjIssn.value    = j.primary_issn || '';
          mjCountry.value = j.country || '';
          mjQuart.value   = j.best_quartile || '';
          mjDecile.value  = j.best_decile || '';
          mjPct.value     = j.best_percentile != null ? j.best_percentile : '';
          mjCat.value     = j.best_category || '';
          mjJournal.focus();
        }));
      } catch (e) {
        mjList.innerHTML = `<div style="color:#b91c1c;font-size:12px;">Error: ${esc(e.message)}</div>`;
      }
    }

    if (mjSave) mjSave.addEventListener('click', async () => {
      const journal = (mjJournal.value || '').trim();
      if (!journal) { mjStatus.style.color = '#b91c1c'; mjStatus.textContent = 'El nombre de la revista es obligatorio.'; return; }
      mjSave.disabled = true;
      mjStatus.style.color = '#9ca3af'; mjStatus.textContent = 'Guardando…';
      try {
        await api('/admin/scimago/manual', { method: 'POST', body: JSON.stringify({
          journal, year: mjYear ? mjYear.value.trim() : '',
          issn: mjIssn.value.trim(), country: mjCountry.value.trim(),
          quartile: mjQuart.value, decile: mjDecile.value,
          percentile: mjPct.value.trim(), category: mjCat.value.trim(),
        }) });
        mjStatus.style.color = '#15803d'; mjStatus.textContent = '✓ Guardada';
        mjJournal.value = mjIssn.value = mjCountry.value = mjPct.value = mjCat.value = '';
        mjQuart.value = mjDecile.value = '';
        if (mjYear) mjYear.value = '';
        refreshManual();
        if (scanBtn && missingEl.dataset.loaded) scanBtn.click();  // refresh missing list
        setTimeout(() => { mjStatus.textContent = ''; }, 2500);
      } catch (e) {
        mjStatus.style.color = '#b91c1c'; mjStatus.textContent = 'Error: ' + e.message;
      } finally { mjSave.disabled = false; }
    });

    if (scanBtn) scanBtn.addEventListener('click', async () => {
      scanBtn.disabled = true;
      missingEl.innerHTML = '<span style="color:#9ca3af;font-size:12px;">Escaneando la biblioteca…</span>';
      try {
        const r = await api('/admin/scimago/missing');
        const js = r.journals || [];
        missingEl.dataset.loaded = '1';
        missingEl.innerHTML = js.length
          ? `<div style="font-size:12px;color:#374151;margin-bottom:5px;">${js.length} revista(s) sin datos — clic para rellenar:</div>` +
            js.map(j => `<button class="pv-miss-j" data-j="${esc(j)}" style="display:inline-block;margin:0 5px 5px 0;padding:3px 9px;border-radius:14px;border:1px solid #fcd34d;background:#fffbeb;color:#92400e;font-size:11.5px;cursor:pointer;">${esc(j)}</button>`).join('')
          : '<div style="color:#15803d;font-size:12px;">✓ Todas las revistas de la biblioteca tienen datos.</div>';
        missingEl.querySelectorAll('.pv-miss-j').forEach(b => b.addEventListener('click', () => {
          mjJournal.value = b.dataset.j;
          mjIssn.focus();
          mjJournal.scrollIntoView({ block: 'nearest' });
        }));
      } catch (e) {
        missingEl.innerHTML = `<div style="color:#b91c1c;font-size:12px;">Error: ${esc(e.message)}</div>`;
      } finally { scanBtn.disabled = false; }
    });

  }

