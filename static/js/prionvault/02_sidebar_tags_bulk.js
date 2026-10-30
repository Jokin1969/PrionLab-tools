  // ── Chunks inspector ────────────────────────────────────────────────
  // Modal opened from the green "indexed" chip in the listing. Fetches
  // /api/articles/<id>/chunks and renders one collapsible card per
  // chunk so the admin can verify chunking + indexation status.
  function _chunksWireOnce() {
    const modal = document.getElementById('pv-chunks-modal');
    if (!modal || modal.dataset.wired) return;
    modal.dataset.wired = '1';
    const close = () => { modal.style.display = 'none'; };
    document.getElementById('pv-chunks-close')?.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop')?.addEventListener('click', close);
  }

  // The currently inspected article id — stashed at module scope so
  // the reindex button (rendered inside the summary grid) can fire
  // without threading the value through every closure.
  let _chunksCurrentArticleId   = null;
  let _chunksCurrentArticleName = '';

  async function openChunksInspector(articleId, articleTitle) {
    const modal = document.getElementById('pv-chunks-modal');
    if (!modal) return alert('UI: pv-chunks-modal no está montado.');
    _chunksWireOnce();

    _chunksCurrentArticleId   = articleId;
    _chunksCurrentArticleName = articleTitle || '';

    document.getElementById('pv-chunks-article-title').textContent =
      articleTitle ? `· ${articleTitle.slice(0, 80)}${articleTitle.length > 80 ? '…' : ''}` : '';
    const summary = document.getElementById('pv-chunks-summary');
    const list    = document.getElementById('pv-chunks-list');
    summary.innerHTML = '<span style="grid-column:1/-1;color:#6b7280;">Cargando…</span>';
    list.innerHTML    = '';
    modal.style.display = 'flex';
    await _chunksLoad();
  }

  async function _chunksLoad() {
    const summary = document.getElementById('pv-chunks-summary');
    const list    = document.getElementById('pv-chunks-list');
    let data;
    try {
      data = await api(`/articles/${_chunksCurrentArticleId}/chunks`);
    } catch (e) {
      summary.innerHTML = `<span style="grid-column:1/-1;color:#b91c1c;">Error: ${esc(e.message)}</span>`;
      return;
    }

    const fmtNum = (n) => (n || 0).toLocaleString('es-ES');
    summary.innerHTML = `
      <span style="color:#6b7280;">Modelo</span>
      <span style="font-weight:600;">${esc(data.model || '?')}</span>
      <span style="color:#6b7280;">Dimensiones</span>
      <span style="font-weight:600;">${data.embedding_dim} <span style="color:#9ca3af;font-weight:normal;">por vector</span></span>

      <span style="color:#6b7280;">Total chunks</span>
      <span style="font-weight:600;">${fmtNum(data.total_chunks)}</span>
      <span style="color:#6b7280;">Indexados</span>
      <span style="font-weight:600;color:${data.missing === 0 ? '#15803d' : '#b45309'};">
        ${fmtNum(data.indexed)} / ${fmtNum(data.total_chunks)}
        ${data.missing > 0 ? `<span style="font-weight:normal;font-size:11.5px;"> · ${data.missing} sin vector</span>` : ''}
      </span>

      <span style="color:#6b7280;">Tokens (suma)</span>
      <span style="font-weight:600;">${fmtNum(data.total_tokens)}</span>
      <span style="color:#6b7280;">Caracteres</span>
      <span style="font-weight:600;">${fmtNum(data.total_chars)}</span>

      <span style="grid-column:1/-1;display:flex;justify-content:flex-end;border-top:1px solid #e5e7eb;padding-top:8px;margin-top:4px;">
        <button id="pv-chunks-reindex"
                title="Vuelve a partir el texto extraído y re-embebe cada chunk con Voyage. Útil si has cambiado el chunker o si hay chunks 'sin vector'."
                style="padding:5px 12px;border-radius:6px;border:1px solid #d1d5db;background:white;color:#0F3460;
                       font-size:12px;font-weight:600;cursor:pointer;">
          ↻ Reindexar este artículo
        </button>
      </span>
    `;
    document.getElementById('pv-chunks-reindex')?.addEventListener('click', _chunksReindex);

    if (!data.chunks.length) {
      list.innerHTML = `<div style="text-align:center;color:#9ca3af;padding:24px 12px;font-size:13px;">
        Este artículo no tiene chunks. Probablemente no se ha pasado por el indexador todavía
        (sidebar → <strong>Index for AI search</strong>).
      </div>`;
      return;
    }

    list.innerHTML = data.chunks.map(c => _chunksRowHtml(c)).join('');
    list.querySelectorAll('.pv-chunk-similar-btn').forEach(btn => {
      btn.addEventListener('click', () => _chunksLoadSimilar(btn));
    });
  }

  async function _chunksReindex() {
    const btn = document.getElementById('pv-chunks-reindex');
    if (!btn || !_chunksCurrentArticleId) return;
    if (!confirm('Reindexar este artículo:\n\n' +
                 '• Borra los chunks actuales y los recrea desde el texto extraído.\n' +
                 '• Vuelve a llamar a Voyage para cada chunk (≈ 0,0001-0,001 USD).\n\n' +
                 '¿Continuar?')) return;
    const orig = btn.textContent;
    btn.disabled    = true;
    btn.textContent = '⏳ Reindexando…';
    try {
      const r = await api(`/articles/${_chunksCurrentArticleId}/reindex`, { method: 'POST' });
      if (r && r.error) {
        alert('No se pudo reindexar: ' + (r.detail || r.error));
      } else {
        await _chunksLoad();   // refresh in place
      }
    } catch (e) {
      alert('Error: ' + e.message);
    } finally {
      // Either _chunksLoad re-rendered the summary (and this btn is
      // a stale node) or it didn't (still on the page); both cases
      // are safe to restore.
      const fresh = document.getElementById('pv-chunks-reindex');
      if (fresh) { fresh.disabled = false; fresh.textContent = orig; }
    }
  }

  // "🔍 Buscar similares" — fetch the 5 closest chunks across the
  // whole catalogue (excluding the source article) and render them
  // inline below the source chunk. Toggles open/closed on click.
  async function _chunksLoadSimilar(btn) {
    const cid     = btn.dataset.chunkId;
    const target  = btn.parentElement.parentElement.querySelector('.pv-chunk-similar-panel');
    if (!cid || !target) return;
    if (target.dataset.open === '1') {
      target.style.display = 'none';
      target.dataset.open  = '0';
      btn.textContent      = '🔍 Buscar similares';
      return;
    }
    target.style.display = 'block';
    target.dataset.open  = '1';
    target.innerHTML     = '<div style="color:#6b7280;font-size:11.5px;padding:6px 8px;">Buscando vecinos en el espacio vectorial…</div>';
    btn.textContent = '⏳ Buscando…';
    try {
      const r = await api(`/chunks/${cid}/similar?limit=5`);
      const results = r.results || [];
      if (!results.length) {
        target.innerHTML = '<div style="color:#9ca3af;font-size:11.5px;padding:8px;">Sin chunks similares en otros artículos.</div>';
      } else {
        target.innerHTML = results.map((it, i) => {
          const pct = Math.max(0, Math.round(it.similarity * 100));
          const colorBand = pct >= 85 ? '#15803d'
                          : pct >= 70 ? '#0f766e'
                          : pct >= 55 ? '#b45309'
                          :             '#6b7280';
          const pages = (it.page_from != null && it.page_to != null)
            ? (it.page_from === it.page_to ? `p. ${it.page_from}` : `pp. ${it.page_from}–${it.page_to}`)
            : '';
          const ids = [
            it.pubmed_id ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${esc(String(it.pubmed_id))}/" target="_blank" rel="noopener" style="color:#0f766e;text-decoration:none;font-weight:600;">PMID ${esc(String(it.pubmed_id))}</a>` : '',
            it.doi       ? `<a href="https://doi.org/${esc(it.doi)}" target="_blank" rel="noopener" style="color:#3730a3;text-decoration:none;font-weight:600;">DOI</a>` : '',
          ].filter(Boolean).join(' · ');
          return `
            <div style="border-top:1px solid #e5e7eb;padding:8px 10px;background:white;">
              <div style="display:flex;align-items:center;gap:8px;font-size:11.5px;color:#6b7280;margin-bottom:3px;flex-wrap:wrap;">
                <span style="font-weight:700;color:${colorBand};">#${i+1} · ${pct}% similar</span>
                <a href="#" class="pv-chunk-open-article" data-aid="${esc(it.article_id)}" data-title="${esc(it.title || '')}" style="color:#111827;font-weight:600;text-decoration:none;">${esc(it.title || '(sin título)')}</a>
                ${it.year ? `<span>· ${it.year}</span>` : ''}
                ${pages ? `<span>· 📄 ${esc(pages)}</span>` : ''}
                ${ids ? `<span style="margin-left:auto;">${ids}</span>` : ''}
              </div>
              <div style="font-size:12px;color:#374151;line-height:1.5;font-family:ui-serif,Georgia,serif;">
                ${esc(it.preview)}${it.preview.length >= 240 ? '…' : ''}
              </div>
            </div>
          `;
        }).join('');
        target.querySelectorAll('.pv-chunk-open-article').forEach(a => {
          a.addEventListener('click', (ev) => {
            ev.preventDefault();
            openChunksInspector(a.dataset.aid, a.dataset.title);
          });
        });
      }
      btn.textContent = '✕ Ocultar similares';
    } catch (e) {
      target.innerHTML = `<div style="color:#b91c1c;font-size:11.5px;padding:8px;">Error: ${esc(e.message)}</div>`;
      btn.textContent = '🔍 Buscar similares';
      target.dataset.open = '0';
    }
  }

  function _chunksRowHtml(c) {
    const pages = (c.page_from != null && c.page_to != null)
      ? (c.page_from === c.page_to ? `p. ${c.page_from}` : `pp. ${c.page_from}–${c.page_to}`)
      : '—';
    const dims = c.embedding_preview && c.embedding_preview.length
      ? `[${c.embedding_preview.map(v => v.toFixed(4)).join(', ')}, …]`
      : '—';
    const status = c.has_embedding
      ? `<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#dcfce7;color:#15803d;">● vectorizado</span>`
      : `<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#fef3c7;color:#92400e;">○ sin vector</span>`;
    const similarBtn = c.has_embedding
      ? `<button type="button" class="pv-chunk-similar-btn" data-chunk-id="${c.id}"
                  title="Busca los 5 chunks más cercanos en el espacio vectorial (otros artículos que toquen el mismo tema)"
                  style="background:none;border:none;color:#0F3460;font-size:11.5px;cursor:pointer;padding:0;text-decoration:underline;">
           🔍 Buscar similares
         </button>`
      : '';

    return `
      <div style="border-bottom:1px solid #e5e7eb;padding:10px 12px;">
        <div style="display:flex;align-items:center;gap:10px;font-size:12px;color:#6b7280;margin-bottom:4px;flex-wrap:wrap;">
          <span style="font-weight:700;color:#111827;font-size:13px;">#${c.chunk_index}</span>
          <span title="Páginas del PDF cubiertas por este chunk">📄 ${esc(pages)}</span>
          <span title="Tokens estimados (lo que cobra Voyage)">${c.tokens != null ? c.tokens.toLocaleString('es-ES') + ' tokens' : '— tokens'}</span>
          <span title="Caracteres del texto">${c.chars.toLocaleString('es-ES')} chars</span>
          <span title="Campo de origen — normalmente extracted_text del PDF; abstract si el chunker partió desde ahí">campo: ${esc(c.source_field || '')}</span>
          <span style="margin-left:auto;">${status}</span>
        </div>
        <div style="font-size:12.5px;color:#374151;line-height:1.55;background:white;padding:6px 8px;border-radius:5px;border:1px solid #e5e7eb;font-family:ui-serif,Georgia,serif;">
          ${esc(c.preview)}${c.chars > c.preview.length ? '…' : ''}
        </div>
        <div style="margin-top:6px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;">
          ${similarBtn}
          <details style="font-size:11.5px;color:#6b7280;margin:0;">
            <summary style="cursor:pointer;color:#0F3460;">Ver chunk completo + primeras 8 dimensiones del vector</summary>
            <div style="margin-top:6px;background:white;border:1px solid #e5e7eb;border-radius:5px;padding:6px 8px;">
              <div style="font-size:11.5px;color:#374151;line-height:1.5;white-space:pre-wrap;font-family:ui-monospace,monospace;max-height:240px;overflow-y:auto;">
                ${esc(c.chunk_text || '')}
              </div>
              <div style="margin-top:6px;font-family:ui-monospace,monospace;font-size:11px;color:#6b7280;">
                <strong style="color:#111827;">Embedding (primeras 8 / 1024 dim):</strong> ${esc(dims)}
              </div>
            </div>
          </details>
        </div>
        <div class="pv-chunk-similar-panel" data-open="0"
             style="display:none;margin-top:6px;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;background:#fafafa;">
        </div>
      </div>
    `;
  }

  // ── Bulk add-to-collection picker (modal) ───────────────────────────
  // Replaces the old prompt() flow. Shows the same group → subgroup →
  // collection tree the sidebar uses, with checkboxes so multiple
  // destinations can be picked in one pass. Smart collections are
  // hidden — the backend rejects POST to them.
  const _BULK_COLL_STATE = { articleIds: [], picked: new Set(), items: [] };

  async function openAddToCollectionPicker(articleIds) {
    if (!articleIds || !articleIds.length) {
      alert('Selecciona al menos un artículo primero.');
      return;
    }
    const modal = document.getElementById('pv-bulk-collection-modal');
    if (!modal) return alert('UI: pv-bulk-collection-modal no está montado.');

    _BULK_COLL_STATE.articleIds = articleIds.slice();
    _BULK_COLL_STATE.picked.clear();
    _BULK_COLL_STATE.items     = [];

    // Reset transient UI on every open.
    document.getElementById('pv-bulk-coll-summary').textContent =
      `Marca las colecciones donde quieres meter ${articleIds.length} artículo${articleIds.length === 1 ? '' : 's'}. Puedes elegir varias.`;
    document.getElementById('pv-bulk-coll-search').value  = '';
    document.getElementById('pv-bulk-coll-result').textContent = '';
    _bulkCollSyncSubmit();
    document.getElementById('pv-bulk-coll-tree').innerHTML =
      '<div style="text-align:center;color:#9ca3af;padding:24px 12px;font-size:13px;">Cargando colecciones…</div>';
    modal.style.display = 'flex';

    try {
      const r = await api('/collections');
      _BULK_COLL_STATE.items = (r.items || []).filter(c => c.kind === 'manual');
    } catch (e) {
      document.getElementById('pv-bulk-coll-tree').innerHTML =
        `<div style="color:#b91c1c;padding:14px;font-size:13px;">No se pudieron cargar las colecciones: ${esc(e.message)}</div>`;
      return;
    }

    if (!_BULK_COLL_STATE.items.length) {
      document.getElementById('pv-bulk-coll-tree').innerHTML =
        `<div style="text-align:center;color:#9ca3af;padding:24px 12px;font-size:13px;">
           No tienes ninguna colección manual.<br>
           <span style="font-size:11.5px;">Pulsa <strong>+ Nueva colección</strong> arriba.</span>
         </div>`;
      return;
    }

    _renderBulkCollTree('');
  }

  function _renderBulkCollTree(filterText) {
    const container = document.getElementById('pv-bulk-coll-tree');
    if (!container) return;
    const needle = (filterText || '').trim().toLowerCase();
    const match  = (c) =>
      !needle ||
      (c.name          || '').toLowerCase().includes(needle) ||
      (c.group_name    || '').toLowerCase().includes(needle) ||
      (c.subgroup_name || '').toLowerCase().includes(needle);

    // Same (group → subgroup → collections) tree the sidebar uses, so
    // the picker reads in the same order as the rest of the UI.
    const tree = {};
    _BULK_COLL_STATE.items.forEach(c => {
      if (!match(c)) return;
      const g  = (c.group_name    || '').trim();
      const sg = (c.subgroup_name || '').trim();
      if (!tree[g])     tree[g] = {};
      if (!tree[g][sg]) tree[g][sg] = [];
      tree[g][sg].push(c);
    });

    const groupKeys = Object.keys(tree)
      .filter(k => k !== '')
      .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
    if ('' in tree) groupKeys.push('');

    if (groupKeys.length === 0) {
      container.innerHTML =
        `<div style="text-align:center;color:#9ca3af;padding:24px 12px;font-size:13px;">Sin coincidencias para «${esc(filterText)}».</div>`;
      return;
    }

    const html = [];
    groupKeys.forEach(g => {
      const subBranch = tree[g];
      const groupLabel = g || '(sin grupo)';
      html.push(
        `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;` +
          `color:${g ? '#0F3460' : '#9ca3af'};padding:8px 6px 4px;border-top:1px solid #e5e7eb;margin-top:4px;">` +
          esc(groupLabel) +
        `</div>`
      );
      const subKeys = Object.keys(subBranch)
        .filter(k => k !== '')
        .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
      if ('' in subBranch) subKeys.push('');

      subKeys.forEach(sg => {
        if (sg) {
          html.push(
            `<div style="font-size:11.5px;font-weight:600;color:#6b7280;` +
              `padding:4px 6px 2px 14px;">› ${esc(sg)}</div>`
          );
        }
        subBranch[sg]
          .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }))
          .forEach(c => {
            const checked = _BULK_COLL_STATE.picked.has(c.id) ? 'checked' : '';
            const dot = c.color
              ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${esc(c.color)};flex-shrink:0;"></span>`
              : '';
            html.push(
              `<label class="pv-bulk-coll-row" style="display:flex;align-items:center;gap:8px;` +
                `padding:5px 10px 5px ${sg ? 26 : 14}px;border-radius:5px;cursor:pointer;font-size:13px;` +
                `transition:background 0.1s;"` +
                `onmouseover="this.style.background='#eef2ff';"` +
                `onmouseout="this.style.background='transparent';">` +
                `<input type="checkbox" class="pv-bulk-coll-cb" data-cid="${esc(c.id)}" ${checked} ` +
                  `style="margin:0;cursor:pointer;">` +
                dot +
                `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#111827;">` +
                  esc(c.name) +
                `</span>` +
                `<span style="color:#9ca3af;font-size:11.5px;flex-shrink:0;">${c.article_count || 0}</span>` +
              `</label>`
            );
          });
      });
    });

    container.innerHTML = html.join('');
    // Wire the freshly-rendered checkboxes.
    container.querySelectorAll('.pv-bulk-coll-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const cid = cb.dataset.cid;
        if (cb.checked) _BULK_COLL_STATE.picked.add(cid);
        else            _BULK_COLL_STATE.picked.delete(cid);
        _bulkCollSyncSubmit();
      });
    });
  }

  function _bulkCollSyncSubmit() {
    const n = _BULK_COLL_STATE.picked.size;
    const btn   = document.getElementById('pv-bulk-coll-submit');
    const count = document.getElementById('pv-bulk-coll-count');
    if (count) {
      count.textContent = n === 0 ? '0 colecciones seleccionadas'
                         : n === 1 ? '1 colección seleccionada'
                         :          `${n} colecciones seleccionadas`;
    }
    if (btn) {
      btn.disabled        = n === 0;
      btn.style.opacity   = n === 0 ? '0.5' : '1';
      btn.style.cursor    = n === 0 ? 'not-allowed' : 'pointer';
      btn.textContent     = n === 0
        ? 'Añadir'
        : `Añadir a ${n} colección${n === 1 ? '' : 'es'}`;
    }
  }

  function wireBulkCollectionPicker() {
    const modal    = document.getElementById('pv-bulk-collection-modal');
    if (!modal || modal.dataset.wired) return;
    modal.dataset.wired = '1';

    const close = () => { modal.style.display = 'none'; };
    document.getElementById('pv-bulk-coll-close') ?.addEventListener('click', close);
    document.getElementById('pv-bulk-coll-cancel')?.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop')     ?.addEventListener('click', close);

    document.getElementById('pv-bulk-coll-search')?.addEventListener('input', (e) => {
      _renderBulkCollTree(e.target.value);
    });
    document.getElementById('pv-bulk-coll-newbtn')?.addEventListener('click', () => {
      close();
      document.getElementById('btn-new-collection')?.click();
    });

    document.getElementById('pv-bulk-coll-submit')?.addEventListener('click', async () => {
      const ids = _BULK_COLL_STATE.articleIds.slice();
      const targets = Array.from(_BULK_COLL_STATE.picked);
      if (!targets.length || !ids.length) return;

      const submit = document.getElementById('pv-bulk-coll-submit');
      const orig   = submit.textContent;
      submit.disabled = true;
      submit.textContent = 'Añadiendo…';
      const result = document.getElementById('pv-bulk-coll-result');

      // Resolve each collection sequentially — POSTs are cheap and
      // doing them one-by-one keeps the per-collection result clean
      // for the summary line below.
      const lines = [];
      let totalAdded = 0;
      for (const cid of targets) {
        const meta = _BULK_COLL_STATE.items.find(c => c.id === cid);
        const name = meta ? meta.name : cid;
        try {
          const r = await api(`/collections/${cid}/articles`, {
            method: 'POST',
            body: JSON.stringify({ ids }),
          });
          totalAdded += r.added || 0;
          lines.push(`✓ ${name}: +${r.added || 0}` +
                     (r.skipped ? ` (${r.skipped} ya estaban)` : ''));
        } catch (e) {
          lines.push(`✗ ${name}: ${e.message}`);
        }
      }
      result.innerHTML = lines.map(l =>
        `<div style="padding:2px 0;${l.startsWith('✓') ? 'color:#15803d;' : 'color:#b91c1c;'}">${esc(l)}</div>`
      ).join('');

      submit.disabled = false;
      submit.textContent = orig;
      refreshCollections();
      loadArticles?.();
      // Close automatically after a beat if everything succeeded so
      // the user doesn't have to click anywhere.
      if (lines.every(l => l.startsWith('✓'))) {
        setTimeout(() => { if (modal.style.display !== 'none') close(); }, 1200);
      }
    });
  }

  // ── PrionPacks ↔ PrionVault sync panel ──────────────────────────────
  // Replaces the DevTools-console diagnostic flow. Opens from the
  // "Sync PrionPacks" sidebar button. Two actions: a full reconcile
  // and a per-pack debug dump rendered as readable cards.
  function wirePrionpackSync() {
    const sidebarBtn = document.getElementById('btn-prionpack-sync');
    const modal      = document.getElementById('pv-prionpack-sync-modal');
    if (!sidebarBtn || !modal) return;

    const closeBtn = document.getElementById('pv-pp-sync-close');
    const runBtn   = document.getElementById('pv-pp-sync-run');
    const debugBtn = document.getElementById('pv-pp-sync-debug');
    const select   = document.getElementById('pv-pp-sync-pack');
    const result   = document.getElementById('pv-pp-sync-result');

    const close = () => { modal.style.display = 'none'; };

    sidebarBtn.addEventListener('click', async () => {
      modal.style.display = 'flex';
      result.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:18px;">El resultado aparecerá aquí.</div>';
      // Populate the pack <select> on every open so newly-created
      // packs show up without a hard refresh.
      try {
        const r = await api('/prionpacks');
        const items = r.items || [];
        select.innerHTML = items.length
          ? '<option value="">— Elige un pack —</option>' +
            items.map(it => `<option value="${esc(it.id)}">${esc(it.id)} — ${esc(it.title || '(sin título)')}</option>`).join('')
          : '<option value="">No hay packs activos</option>';
      } catch (e) {
        select.innerHTML = `<option value="">Error: ${esc(e.message)}</option>`;
      }
    });
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    runBtn.addEventListener('click', async () => {
      const origLabel = runBtn.textContent;
      runBtn.disabled = true;
      runBtn.textContent = '⏳ Sincronizando…';
      result.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:18px;">Sincronizando todos los packs…</div>';
      try {
        const r = await api('/admin/prionpacks/sync', { method: 'POST' });
        _renderSyncAll(result, r);
        refreshCollections?.();   // sidebar counts may have changed
      } catch (e) {
        result.innerHTML =
          `<div style="color:#b91c1c;padding:10px;">Error: ${esc(e.message)}</div>`;
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = origLabel;
      }
    });

    debugBtn.addEventListener('click', async () => {
      const pid = select.value;
      if (!pid) {
        result.innerHTML =
          '<div style="color:#b45309;padding:10px;">Elige un pack en el desplegable primero.</div>';
        return;
      }
      const orig = debugBtn.textContent;
      debugBtn.disabled = true;
      debugBtn.textContent = '⏳ Analizando…';
      result.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:18px;">Leyendo configuración del pack…</div>';
      try {
        const r = await api(`/admin/prionpacks/sync-debug/${encodeURIComponent(pid)}`);
        _renderSyncDebug(result, r);
      } catch (e) {
        result.innerHTML =
          `<div style="color:#b91c1c;padding:10px;">Error: ${esc(e.message)}</div>`;
      } finally {
        debugBtn.disabled = false;
        debugBtn.textContent = orig;
      }
    });
  }

  function _renderSyncAll(target, r) {
    const totals = (r && r.totals) || {};
    const perPack = Array.isArray(r && r.per_pack) ? r.per_pack : [];
    const totalsHtml = `
      <div style="background:#dcfce7;border:1px solid #bbf7d0;border-radius:6px;padding:10px;margin-bottom:10px;">
        <div style="font-weight:700;color:#15803d;margin-bottom:4px;">✓ Sync terminada</div>
        <div style="font-size:12.5px;color:#166534;line-height:1.7;">
          Packs procesados: <b>${totals.packs ?? '—'}</b><br>
          Artículos casados: <b>${totals.matched ?? '—'}</b><br>
          Añadidos a "Introducción": <b>${totals.intro_added ?? 0}</b>
          <span style="color:#15803d;opacity:0.7;">
            (${totals.intro_skipped ?? 0} ya estaban)
          </span><br>
          Añadidos a "Referencias generales": <b>${totals.general_added ?? 0}</b>
          <span style="color:#15803d;opacity:0.7;">
            (${totals.general_skipped ?? 0} ya estaban)
          </span>
        </div>
      </div>
    `;
    const rows = perPack.map(p => {
      if (p.skipped) {
        return `<div style="padding:5px 8px;color:#9ca3af;font-size:12px;">
                  <code>${esc(p.pack_id)}</code> — saltado (${esc(p.skipped)})
                </div>`;
      }
      const intro = p.intro || {};
      const gen   = p.general || {};
      return `
        <div style="padding:6px 8px;border-bottom:1px solid #f3f4f6;font-size:12px;">
          <code style="color:#374151;font-weight:600;">${esc(p.pack_id)}</code>
          <span style="color:#6b7280;margin-left:6px;">
            intro <b style="color:${intro.added ? '#15803d' : '#9ca3af'};">+${intro.added ?? 0}</b>
            <span style="opacity:0.6;">(${intro.matched ?? 0}/${intro.total_dois ?? 0} casan)</span>
            · gen <b style="color:${gen.added ? '#15803d' : '#9ca3af'};">+${gen.added ?? 0}</b>
            <span style="opacity:0.6;">(${gen.matched ?? 0}/${gen.total_dois ?? 0} casan)</span>
          </span>
        </div>
      `;
    }).join('');
    target.innerHTML = totalsHtml +
      (rows ? `<div style="border:1px solid #e5e7eb;border-radius:6px;background:white;">${rows}</div>` : '');
  }

  function _renderSyncDebug(target, r) {
    const pack = r.pack || {};
    const exp  = r.expected || {};
    const existing = r.existing_pack_collections || [];

    // Find which existing collections match the expected subgroup + name
    // exactly (case-insensitive). Highlight mismatches in amber so the
    // operator sees at a glance what's blocking the sync.
    const norm = (s) => (s || '').trim().toLowerCase();
    const expSub = norm(exp.subgroup);
    const expIntro = norm(exp.intro_collection_name);
    const expGen   = norm(exp.general_collection_name);

    const existingHtml = existing.length
      ? existing.map(c => {
          const sg = norm(c.subgroup_name);
          const n  = norm(c.name);
          const subMatch  = sg === expSub;
          const nameMatch = (n === expIntro || n === expGen);
          const ok = subMatch && nameMatch;
          const color = ok ? '#15803d' : '#b45309';
          const flag  = ok ? '✓ casa con la sync'
                          : !subMatch && nameMatch ? '⚠ nombre OK pero subgrupo NO casa'
                          : subMatch && !nameMatch ? '⚠ subgrupo OK pero nombre NO casa'
                          : '⚠ ninguno coincide';
          return `
            <div style="padding:5px 8px;border-bottom:1px solid #f3f4f6;font-size:12px;">
              <span style="color:${color};font-weight:600;">${flag}</span>
              <div style="margin-top:2px;color:#6b7280;">
                Subgrupo: <code>${esc(c.subgroup_name || '(vacío)')}</code><br>
                Nombre: <code>${esc(c.name || '')}</code>
                · artículos: ${c.article_count ?? 0}
              </div>
            </div>
          `;
        }).join('')
      : '<div style="padding:8px;color:#9ca3af;font-size:12px;">Aún no hay colecciones bajo el grupo "PrionPacks".</div>';

    const renderDoiList = (label, dois, matched) => {
      const total = dois.length;
      if (!total) {
        return `
          <div style="margin-bottom:10px;">
            <div style="font-weight:600;color:#374151;">${esc(label)}</div>
            <div style="color:#9ca3af;font-size:12px;padding:4px 0;">Sin DOIs en esta sección.</div>
          </div>`;
      }
      const rows = dois.map(d => {
        const found = !!d.article_id;
        const color = found ? '#15803d' : '#b45309';
        const icon  = found ? '✓' : '✗';
        return `
          <div style="padding:3px 8px;border-bottom:1px solid #f9fafb;display:flex;gap:8px;align-items:center;">
            <span style="color:${color};font-weight:700;">${icon}</span>
            <code style="font-size:11.5px;color:#374151;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(d.doi)}</code>
            <span style="font-size:11px;color:#9ca3af;flex-shrink:0;">
              ${found ? 'en PrionVault' : 'no está'}
            </span>
          </div>
        `;
      }).join('');
      return `
        <div style="margin-bottom:10px;">
          <div style="font-weight:600;color:#374151;">
            ${esc(label)}
            <span style="font-weight:normal;color:#6b7280;">
              · ${matched}/${total} casan en PrionVault
            </span>
          </div>
          <div style="margin-top:4px;border:1px solid #e5e7eb;border-radius:5px;background:white;max-height:200px;overflow-y:auto;">
            ${rows}
          </div>
        </div>
      `;
    };

    target.innerHTML = `
      <div style="margin-bottom:10px;font-size:13px;">
        <span style="font-weight:700;color:#111827;">${esc(pack.id || '')}</span>
        <span style="color:#6b7280;"> — ${esc(pack.title || '(sin título)')}</span>
        ${pack.active === false ? '<span style="margin-left:8px;color:#b91c1c;font-weight:600;">⚠ pack inactivo (la sync lo salta)</span>' : ''}
      </div>

      <div style="background:#f3f4f6;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:12px;color:#374151;line-height:1.6;">
        <div><strong>Lo que la sync espera:</strong></div>
        <div>Grupo: <code>${esc(exp.group || '')}</code></div>
        <div>Subgrupo: <code>${esc(exp.subgroup || '')}</code></div>
        <div>Colecciones: <code>${esc(exp.intro_collection_name || '')}</code> +
                         <code>${esc(exp.general_collection_name || '')}</code></div>
      </div>

      <div style="margin-bottom:10px;">
        <div style="font-weight:600;color:#374151;margin-bottom:4px;">
          Colecciones ya existentes bajo grupo "${esc(exp.group || 'PrionPacks')}"
        </div>
        <div style="border:1px solid #e5e7eb;border-radius:5px;background:white;">
          ${existingHtml}
        </div>
      </div>

      ${renderDoiList('Introducción — DOIs', r.intro_dois || [], r.intro_matched_count || 0)}
      ${renderDoiList('Referencias generales — DOIs', r.general_dois || [], r.general_matched_count || 0)}
    `;
  }

  // ── Sidebar header indicators ─────────────────────────────────────────
  // When a Colecciones / Tags filter is active the section header
  // highlights in white + bold so the user still notices the filter
  // even with that section collapsed.
  function refreshFilterIndicators() {
    const cHasFilter = !!(state.collectionId
                          || state.collectionGroup
                          || state.collectionSubgroup);
    const tHasFilter = !!state.tagId;
    paintToggle('btn-toggle-collections', cHasFilter);
    paintToggle('btn-toggle-tags', tHasFilter);
  }
  function paintToggle(buttonId, active) {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    if (active) {
      btn.style.color = 'white';
      // Drop a tiny dot next to the label to mark the active filter.
      if (!btn.querySelector('.pv-active-dot')) {
        const dot = document.createElement('span');
        dot.className = 'pv-active-dot';
        dot.title = 'Hay un filtro activo en esta sección';
        dot.style.cssText =
          'display:inline-block;width:6px;height:6px;border-radius:50%;' +
          'background:#fbbf24;margin-left:4px;flex-shrink:0;';
        btn.appendChild(dot);
      }
    } else {
      btn.style.color = 'rgba(255,255,255,0.32)';
      const dot = btn.querySelector('.pv-active-dot');
      if (dot) dot.remove();
    }
  }

  // ── Collapsible sidebar sections ──────────────────────────────────────
  function wireSidebarToggles() {
    const pairs = [
      { btn: 'btn-toggle-collections', list: 'collection-list',
        key: 'pv-side-collections' },
      { btn: 'btn-toggle-tags',        list: 'tag-list',
        key: 'pv-side-tags' },
    ];
    pairs.forEach(p => {
      const btn  = document.getElementById(p.btn);
      const list = document.getElementById(p.list);
      if (!btn || !list) return;
      const caret = btn.querySelector('.pv-toggle-caret');
      // Default = expanded; localStorage stores '0' when collapsed.
      const collapsed = localStorage.getItem(p.key) === '0';
      apply(collapsed);

      btn.addEventListener('click', () => {
        const next = !(localStorage.getItem(p.key) === '0');
        localStorage.setItem(p.key, next ? '0' : '1');
        apply(next);
      });

      function apply(isCollapsed) {
        list.style.display = isCollapsed ? 'none' : '';
        btn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
        if (caret) caret.style.transform =
          isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
      }
    });
  }

  // ── New tag button ────────────────────────────────────────────────────
  function wireNewTagButton() {
    const btn = document.getElementById('btn-new-tag');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const name = prompt('Nombre del tag:');
      if (!name || !name.trim()) return;
      // Quick colour palette — typing the colour name is allowed too.
      const palette = {
        rojo: '#ef4444', naranja: '#fb923c', amarillo: '#f59e0b',
        verde: '#22c55e', azul: '#3b82f6', morado: '#a855f7',
        rosa: '#ec4899', gris: '#6b7280', cian: '#06b6d4',
      };
      const colorInput = prompt(
        'Color (hex #rrggbb o nombre: rojo / naranja / amarillo / ' +
        'verde / azul / morado / rosa / gris / cian). Vacío = sin color.'
      );
      let color = null;
      if (colorInput && colorInput.trim()) {
        const v = colorInput.trim().toLowerCase();
        color = palette[v] || (v.startsWith('#') ? v : null);
      }
      try {
        await api('/tags', {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), color }),
        });
        refreshTags();
      } catch (e) {
        alert('No se pudo crear el tag: ' + e.message);
      }
    });
  }

  let _allTags = [];

  async function refreshTags() {
    try {
      const tags = await api('/tags');
      _allTags = tags;
      const container = document.getElementById('tag-list');
      const countSpan = document.getElementById('tag-count');
      container.innerHTML = '';
      if (countSpan) countSpan.textContent = tags.length > 0 ? `(${tags.length})` : '';
      tags.forEach(t => {
        const isSmart = t.kind === 'smart';
        const canManage = IS_ADMIN || t.is_mine;
        const btn = document.createElement('button');
        btn.className = 'pv-nav-btn pv-tag-row';
        btn.dataset.tagId = t.id;
        const titleLines = ['• Click: filtrar la lista'];
        if (isSmart) titleLines.push('• Se asigna sola según reglas' + (t.last_synced_at ? ` (última sync: ${new Date(t.last_synced_at).toLocaleString('es-ES')})` : ''));
        if (canManage) titleLines.push(isSmart ? '• Botón ⚡ a la derecha: editar reglas / resincronizar' : '• Botón ✏ a la derecha: renombrar');
        if (IS_ADMIN) titleLines.push('• Click derecho: borrar este tag');
        btn.title = titleLines.join('\n');

        let editBtn = '';
        if (canManage && isSmart) {
          editBtn = `
            <span class="pv-tag-edit" data-tag-id="${esc(t.id)}" title="Editar reglas de esta tag inteligente"
                  style="display:inline-flex;align-items:center;justify-content:center;
                         padding:2px 5px;border-radius:5px;cursor:pointer;
                         background:rgba(245,158,11,0.18);color:#fbbf24;
                         margin-left:4px;flex-shrink:0;line-height:1;"
                  onmouseover="this.style.background='rgba(245,158,11,0.32)';"
                  onmouseout="this.style.background='rgba(245,158,11,0.18)';"
            ><i class="fas fa-bolt" style="font-size:10px;"></i></span>`;
        } else if (IS_ADMIN) {
          editBtn = `
            <span class="pv-tag-edit" data-tag-id="${esc(t.id)}" title="Renombrar este tag"
                  style="display:inline-flex;align-items:center;justify-content:center;
                         padding:2px 5px;border-radius:5px;cursor:pointer;
                         background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.7);
                         margin-left:4px;flex-shrink:0;line-height:1;"
                  onmouseover="this.style.background='rgba(255,255,255,0.22)';this.style.color='white';"
                  onmouseout="this.style.background='rgba(255,255,255,0.08)';this.style.color='rgba(255,255,255,0.7)';"
            ><i class="fas fa-pen" style="font-size:10px;"></i></span>`;
        }
        const dot = isSmart
          ? '<i class="fas fa-bolt" style="font-size:8px;flex-shrink:0;color:' + esc(t.color || '#fbbf24') + '"></i>'
          : `<span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${esc(t.color || '#9ca3af')}"></span>`;
        btn.innerHTML = `
          <span style="display:inline-flex;align-items:center;gap:7px;min-width:0;overflow:hidden;">
            ${dot}
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(t.name)}</span>
          </span>
          <span style="display:inline-flex;align-items:center;flex-shrink:0;">
            <span style="font-size:10px;background:rgba(255,255,255,0.14);padding:1px 7px;border-radius:20px;">${t.count}</span>
            ${editBtn}
          </span>
        `;
        btn.addEventListener('click', (ev) => {
          if (ev.target.closest('.pv-tag-edit')) return;
          state.tagId = state.tagId === t.id ? null : t.id;
          clearMarkFilters();
          state.page = 1;
          loadArticles();
          highlightActiveTag();
          refreshFilterIndicators();
        });
        const editEl = btn.querySelector('.pv-tag-edit');
        if (editEl) {
          editEl.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (isSmart) { openTagModal(t); return; }
            const newName = (prompt('Nuevo nombre para el tag:', t.name) || '').trim();
            if (!newName || newName === t.name) return;
            api(`/tags/${t.id}`, { method: 'PUT', body: JSON.stringify({ name: newName, color: t.color }) })
              .then(() => refreshTags())
              .catch(e => alert('Error al renombrar: ' + (e.message || e)));
          });
        }
        btn.addEventListener('contextmenu', ev => {
          if (!IS_ADMIN) return;
          ev.preventDefault();
          if (!confirm(`¿Borrar el tag "${t.name}"? Los artículos que lo lleven dejan de tenerlo asignado (no se borran).`)) return;
          api(`/tags/${t.id}`, { method: 'DELETE' })
            .then(() => { if (state.tagId === t.id) state.tagId = null;
                          refreshTags(); loadArticles(); refreshFilterIndicators(); })
            .catch(e => alert('Error: ' + e.message));
        });
        container.appendChild(btn);
      });
      highlightActiveTag();
      refreshFilterIndicators();
    } catch (e) { console.error(e); }
  }

  // ── Smart tag editor modal ─────────────────────────────────────────────
  let _tagEditing = null;

  function wireTagModal() {
    const modal = document.getElementById('pv-tag-modal');
    if (!modal || modal.dataset.wired) return;
    modal.dataset.wired = '1';

    const closeBtn  = document.getElementById('pv-tag-close');
    const cancelBtn = document.getElementById('pv-tag-cancel');
    const saveBtn   = document.getElementById('pv-tag-save');
    const errBox    = document.getElementById('pv-tag-error');
    const syncBox   = document.getElementById('pv-tag-sync-status');

    function close() { modal.style.display = 'none'; _tagEditing = null; }
    closeBtn.addEventListener('click', close);
    cancelBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    saveBtn.addEventListener('click', async () => {
      errBox.style.display = 'none';
      syncBox.style.display = 'none';
      const name = document.getElementById('pv-tag-name').value.trim();
      if (!name) {
        errBox.style.display = 'block';
        errBox.textContent = 'El nombre es obligatorio.';
        return;
      }
      const color = document.getElementById('pv-tag-color').value || null;

      const rules = {};
      const g = id => document.getElementById(id);
      const grab = (id, key, parser = v => v) => {
        const v = (g(id)?.value || '').trim();
        if (v !== '') rules[key] = parser(v);
      };
      grab('pv-tr-q',           'q');
      grab('pv-tr-authors',     'authors');
      grab('pv-tr-journal',     'journal');
      grab('pv-tr-year-min',    'year_min', v => parseInt(v, 10));
      grab('pv-tr-year-max',    'year_max', v => parseInt(v, 10));
      grab('pv-tr-has-summary', 'has_summary');
      grab('pv-tr-source',      'source');
      const hp = g('pv-tr-has-pdf').value;
      if (hp !== '')  rules.has_pdf  = hp === '1';
      const hd = g('pv-tr-has-doi').value;
      if (hd !== '')  rules.has_doi  = hd === '1';
      const hpm = g('pv-tr-has-pmid').value;
      if (hpm !== '') rules.has_pmid = hpm === '1';

      saveBtn.disabled = true;
      const original = saveBtn.textContent;
      saveBtn.textContent = 'Guardando…';
      try {
        let sync;
        if (_tagEditing) {
          // Rename/recolor (if changed) then rules — two calls, but the
          // rename endpoint is admin-only while rules can be edited by
          // the tag's own creator, so they stay genuinely separate.
          if (IS_ADMIN && (name !== _tagEditing.name || color !== _tagEditing.color)) {
            await api(`/tags/${_tagEditing.id}`, { method: 'PUT', body: JSON.stringify({ name, color }) });
          }
          const r = await api(`/tags/${_tagEditing.id}/rules`, { method: 'PUT', body: JSON.stringify({ rules }) });
          sync = r.sync;
        } else {
          const r = await api('/tags', { method: 'POST', body: JSON.stringify({ name, color, kind: 'smart', rules }) });
          sync = r.sync;
        }
        if (sync) {
          syncBox.style.display = 'block';
          syncBox.textContent = `✓ Sincronizada: ${sync.matched} artículo${sync.matched === 1 ? '' : 's'} coinciden ahora mismo.`;
        }
        refreshTags();
        setTimeout(close, sync ? 900 : 0);
      } catch (e) {
        errBox.style.display = 'block';
        errBox.textContent = 'Error: ' + (e.message || e);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = original;
      }
    });
  }

  function openTagModal(existing) {
    wireTagModal();
    const modal = document.getElementById('pv-tag-modal');
    if (!modal) return;
    _tagEditing = existing || null;

    document.getElementById('pv-tag-name').value  = existing?.name  || '';
    document.getElementById('pv-tag-color').value = existing?.color || '';

    const rules = existing?.rules || {};
    document.getElementById('pv-tr-q').value = rules.q || '';
    document.getElementById('pv-tr-authors').value = rules.authors || '';
    document.getElementById('pv-tr-journal').value = rules.journal || '';
    document.getElementById('pv-tr-year-min').value = rules.year_min ?? '';
    document.getElementById('pv-tr-year-max').value = rules.year_max ?? '';
    document.getElementById('pv-tr-has-summary').value = rules.has_summary || '';
    document.getElementById('pv-tr-source').value = rules.source || '';
    document.getElementById('pv-tr-has-pdf').value =
      rules.has_pdf === true ? '1' : (rules.has_pdf === false ? '0' : '');
    document.getElementById('pv-tr-has-doi').value =
      rules.has_doi === true ? '1' : (rules.has_doi === false ? '0' : '');
    document.getElementById('pv-tr-has-pmid').value =
      rules.has_pmid === true ? '1' : (rules.has_pmid === false ? '0' : '');

    document.getElementById('pv-tag-error').style.display = 'none';
    document.getElementById('pv-tag-sync-status').style.display = 'none';
    document.getElementById('pv-tag-title').innerHTML =
      `<i class="fas fa-bolt" style="color:#d97706;margin-right:8px;"></i>` +
      (existing ? `Editar “${esc(existing.name)}”` : 'Nueva tag inteligente');
    const sb = document.getElementById('pv-tag-save');
    sb.disabled = false;
    sb.textContent = existing ? 'Guardar cambios' : 'Crear tag';

    modal.style.display = 'flex';
    setTimeout(() => document.getElementById('pv-tag-name').focus(), 30);
  }

  function wireNewSmartTagButton() {
    const btn = document.getElementById('btn-new-smart-tag');
    if (!btn) return;
    btn.addEventListener('click', () => openTagModal(null));
  }

  function highlightActiveTag() {
    document.querySelectorAll('#tag-list .pv-nav-btn').forEach(b => {
      const isActive = String(b.dataset.tagId) === String(state.tagId);
      b.style.background = isActive ? 'rgba(255,255,255,0.18)' : '';
      b.style.color      = isActive ? 'white' : '';
      b.style.fontWeight = isActive ? '600' : '';
    });
  }

  // ── render: article list ───────────────────────────────────────────────
  let _listIds = [];   // IDs in current page order — used for detail modal nav

  // Only the response to the LATEST request may paint the list — a slow
  // earlier search (e.g. one fired mid-typing) used to land after a fast
  // later one and overwrite it with stale results.
  let _loadSeq = 0;
  async function loadArticles() {
    const mySeq = ++_loadSeq;
    const params = buildListParams();

    const tbody = document.getElementById('pv-results-tbody');
    const table = document.getElementById('pv-results-table');
    const empty = document.getElementById('pv-results-empty');
    const showEmpty = (msg) => {
      table.style.display = 'none';
      empty.style.display = 'block';
      empty.innerHTML = `<div style="text-align:center;padding:52px 24px;color:#9ca3af;font-size:14px;">${esc(msg)}</div>`;
    };
    const showTable = () => {
      table.style.display = '';
      empty.style.display = 'none';
    };

    showEmpty('Cargando…');

    try {
      let r;
      if (state.filterSelectedOnly && state.selectedIds.size > 50) {
        // Send IDs in the POST body to avoid Railway/nginx URI length limits.
        const body = Object.fromEntries(params.entries());
        body.ids = Array.from(state.selectedIds);
        r = await api('/articles', { method: 'POST', body: JSON.stringify(body) });
      } else {
        r = await api('/articles?' + params.toString());
      }
      if (mySeq !== _loadSeq) return;
      document.getElementById('pv-result-count').textContent =
        r.total + ' result' + (r.total === 1 ? '' : 's');
      document.getElementById('pv-result-page').textContent =
        'page ' + r.page + ' / ' + Math.max(1, Math.ceil(r.total / r.size));

      if (r.items.length === 0 && r.total > 0 && state.page > 1) {
        // Past the last page (filter narrowed while on a later page):
        // jump to the last page that has results.
        state.page = Math.max(1, Math.ceil(r.total / r.size));
        return loadArticles();
      }
      if (r.items.length === 0) {
        showEmpty('No articles match these filters.');
        renderPagination(r);
        return;
      }
      _listIds = r.items.map(a => a.id);
      // Build every row in a detached fragment and insert it in ONE DOM
      // operation, so the browser reflows once instead of per-row (a big
      // win on large pages of hundreds/thousands of rows).
      const _frag = document.createDocumentFragment();
      r.items.forEach(a => _frag.appendChild(renderRow(a)));
      tbody.innerHTML = '';
      tbody.appendChild(_frag);
      showTable();
      state.lastTotal = r.total || 0;
      refreshSortHeaders();
      renderPagination(r);
      updateBulkBar();
      syncSelectAllHeader();
    } catch (e) {
      if (mySeq !== _loadSeq) return;
      showEmpty('Error: ' + e.message);  // showEmpty escapes
    }
  }

  // ── Bulk selection / actions ──────────────────────────────────────────
  function visibleRowIds() {
    return Array.from(document.querySelectorAll('.pv-row-select'))
      .map(cb => cb.dataset.aid);
  }

  function syncSelectAllHeader() {
    const hdr = document.getElementById('pv-select-all');
    if (!hdr) return;
    const visible = visibleRowIds();
    if (!visible.length) {
      hdr.checked = false;
      hdr.indeterminate = false;
      return;
    }
    const selectedVisible = visible.filter(id => state.selectedIds.has(id));
    hdr.checked = selectedVisible.length === visible.length;
    hdr.indeterminate = selectedVisible.length > 0 &&
                        selectedVisible.length < visible.length;
  }

  function _paintOnlySelectedBtn() {
    ['', '-top'].forEach(s => {
      const btn = document.getElementById('pv-bulk-only-selected' + s);
      const lbl = document.getElementById('pv-bulk-only-selected-label' + s);
      if (!btn || !lbl) return;
      if (state.filterSelectedOnly) {
        btn.style.background    = 'white';
        btn.style.color         = '#0F3460';
        btn.style.borderColor   = 'white';
        lbl.textContent = '✓ Mostrando solo seleccionados — clic para ver todos';
      } else {
        btn.style.background    = 'rgba(255,255,255,0.14)';
        btn.style.color         = 'white';
        btn.style.borderColor   = 'rgba(255,255,255,0.25)';
        lbl.textContent = '🔍 Ver solo seleccionados';
      }
    });
  }

  function updateBulkBar() {
    const bars = ['pv-bulk-bar', 'pv-bulk-bar-top']
      .map(id => document.getElementById(id))
      .filter(Boolean);
    if (!bars.length) return;
    const count = state.selectedIds.size;
    const total = state.lastTotal || 0;
    const showFiltered = count > 0 && total > count;
    // If the operator was viewing only-selected and the selection drops
    // to zero (cleared, all deleted, etc.), drop the filter too so they
    // don't see an empty page with no obvious way out.
    if (state.filterSelectedOnly && count === 0) {
      state.filterSelectedOnly = false;
      loadArticles();
    }
    _paintOnlySelectedBtn();
    bars.forEach((bar, idx) => {
      if (!count) { bar.style.display = 'none'; return; }
      bar.style.display = 'flex';
      const s = idx === 0 ? '' : '-top';
      const countEl = document.getElementById('pv-bulk-count' + s);
      if (countEl) countEl.textContent =
        count === 1 ? '1 seleccionado' : `${count} seleccionados`;
      const fBtn = document.getElementById('pv-bulk-select-filtered' + s);
      const fCnt = document.getElementById('pv-bulk-filtered-count' + s);
      if (fBtn && fCnt) {
        if (showFiltered) {
          fBtn.style.display = 'inline-block';
          fCnt.textContent = total;
        } else {
          fBtn.style.display = 'none';
        }
      }
    });
  }

  async function fetchAllFilteredIds() {
    // Reuse the existing filter params, then ask for size=lastTotal in
    // one shot. Caps at the backend's 50_000 ceiling.
    const params = buildListParams();
    params.set('size', String(Math.min(50_000, state.lastTotal || 50_000)));
    params.set('page', '1');
    let r;
    if (state.filterSelectedOnly && state.selectedIds.size > 50) {
      const body = Object.fromEntries(params.entries());
      body.ids = Array.from(state.selectedIds);
      r = await api('/articles', { method: 'POST', body: JSON.stringify(body) });
    } else {
      r = await api('/articles?' + params.toString());
    }
    return (r.items || []).map(a => a.id);
  }

  // Fetches every article id with no PDF, independent of whatever
  // filters are currently applied — for the 📄✕ quick-select button.
  async function fetchAllNoPdfIds() {
    const first = await api('/articles?has_pdf=false&size=1&page=1');
    const total = Math.min(50_000, first.total || 0);
    if (!total) return [];
    const r = await api('/articles?has_pdf=false&size=' + total + '&page=1');
    return (r.items || []).map(a => a.id);
  }

  async function bulkPatch(updates, opts = {}) {
    const ids = Array.from(state.selectedIds);
    if (!ids.length) return;
    const r = await api('/articles/bulk', {
      method: 'PATCH',
      body: JSON.stringify({ ids, updates }),
    });
    if (opts.keepSelection !== true) {
      // After a successful bulk, keep the selection by default so the
      // user can chain another action without re-checking everything.
      // The data underneath has changed, so reload the list.
    }
    return r;
  }

  // ── Bulk bar HTML — rendered into BOTH #pv-bulk-bar (sticky bottom)
  // and #pv-bulk-bar-top (above the article list) so the actions are
  // never out of sight on long pages. The `suffix` param keeps inner
  // element ids unique across the two copies.
  function bulkBarHtml(suffix) {
    const s = suffix || '';
    return `
      <span id="pv-bulk-count${s}" style="font-weight:600;white-space:nowrap;">0 seleccionados</span>
      <button id="pv-bulk-select-filtered${s}" type="button"
              style="display:none;padding:4px 10px;border-radius:6px;
                     background:rgba(255,255,255,0.14);color:white;border:1px solid rgba(255,255,255,0.25);
                     font-size:12px;cursor:pointer;white-space:nowrap;">
        Seleccionar los <span id="pv-bulk-filtered-count${s}">—</span> que cumplen el filtro
      </button>
      <button id="pv-bulk-only-selected${s}" type="button"
              title="Filtrar el listado para ver SOLO los artículos que has marcado. Pulsa de nuevo para volver a ver todos."
              style="padding:4px 10px;border-radius:6px;
                     background:rgba(255,255,255,0.14);color:white;border:1px solid rgba(255,255,255,0.25);
                     font-size:12px;cursor:pointer;white-space:nowrap;">
        <span id="pv-bulk-only-selected-label${s}">🔍 Ver solo seleccionados</span>
      </button>
      <span style="flex:1;"></span>

      <div style="display:flex;align-items:center;gap:6px;">
        <span style="font-size:11.5px;opacity:0.7;text-transform:uppercase;letter-spacing:0.05em;">Prioridad</span>
        <div id="pv-bulk-priority${s}" style="display:flex;gap:3px;"></div>
      </div>

      <div style="display:flex;align-items:center;gap:6px;">
        <span style="font-size:11.5px;opacity:0.7;text-transform:uppercase;letter-spacing:0.05em;">Color</span>
        <div id="pv-bulk-color${s}" style="display:flex;gap:3px;align-items:center;"></div>
      </div>

      <div style="display:flex;align-items:center;gap:6px;">
        <button id="pv-bulk-flag-on${s}"  type="button" title="Poner bandera"
                style="padding:4px 8px;border-radius:6px;background:#e11d48;color:white;border:none;cursor:pointer;font-size:12px;">🚩 +</button>
        <button id="pv-bulk-flag-off${s}" type="button" title="Quitar bandera"
                style="padding:4px 8px;border-radius:6px;background:rgba(255,255,255,0.14);color:white;border:1px solid rgba(255,255,255,0.25);cursor:pointer;font-size:12px;">🚩 −</button>
        <button id="pv-bulk-star-on${s}"  type="button" title="Marcar como hito"
                style="padding:4px 8px;border-radius:6px;background:#f59e0b;color:white;border:none;cursor:pointer;font-size:12px;">★ +</button>
        <button id="pv-bulk-star-off${s}" type="button" title="Quitar hito"
                style="padding:4px 8px;border-radius:6px;background:rgba(255,255,255,0.14);color:white;border:1px solid rgba(255,255,255,0.25);cursor:pointer;font-size:12px;">★ −</button>
        <button id="pv-bulk-fav-on${s}"   type="button" title="Añadir a mis favoritos"
                style="padding:4px 8px;border-radius:6px;background:#e11d48;color:white;border:none;cursor:pointer;font-size:12px;">♥ +</button>
        <button id="pv-bulk-fav-off${s}"  type="button" title="Quitar de mis favoritos"
                style="padding:4px 8px;border-radius:6px;background:rgba(255,255,255,0.14);color:white;border:1px solid rgba(255,255,255,0.25);cursor:pointer;font-size:12px;">♥ −</button>
        <button id="pv-bulk-read-on${s}"  type="button" title="Marcar como leídos por mí"
                style="padding:4px 8px;border-radius:6px;background:#15803d;color:white;border:none;cursor:pointer;font-size:12px;font-weight:700;">✓ +</button>
        <button id="pv-bulk-read-off${s}" type="button" title="Marcar como no leídos"
                style="padding:4px 8px;border-radius:6px;background:rgba(255,255,255,0.14);color:white;border:1px solid rgba(255,255,255,0.25);cursor:pointer;font-size:12px;font-weight:700;">✓ −</button>
        ${IS_ADMIN ? `
        <button id="pv-bulk-jc-on${s}"   type="button" title="Marcar para Journal Club (visible para todos)"
                style="padding:4px 8px;border-radius:6px;background:#7c3aed;color:white;border:none;cursor:pointer;font-size:12px;"><i class="fas fa-book-open"></i> +</button>
        <button id="pv-bulk-jc-off${s}"  type="button" title="Quitar de Journal Club (visible para todos)"
                style="padding:4px 8px;border-radius:6px;background:rgba(255,255,255,0.14);color:white;border:1px solid rgba(255,255,255,0.25);cursor:pointer;font-size:12px;"><i class="fas fa-book-open"></i> −</button>` : ''}
      </div>

      ${IS_ADMIN ? `
      <button id="pv-bulk-tags${s}" type="button"
              title="Añadir o quitar tags a los artículos seleccionados"
              style="padding:4px 10px;border-radius:6px;background:rgba(255,255,255,0.14);color:white;
                     border:1px solid rgba(255,255,255,0.25);cursor:pointer;font-size:12px;
                     font-weight:600;display:inline-flex;align-items:center;gap:4px;">
        <i class="fas fa-tags"></i> Tags
      </button>

      <button id="pv-bulk-summarize${s}" type="button"
              title="Generar (o regenerar) resúmenes IA solo de los artículos seleccionados"
              style="padding:4px 10px;border-radius:6px;background:rgba(255,255,255,0.14);color:white;
                     border:1px solid rgba(255,255,255,0.25);cursor:pointer;font-size:12px;
                     font-weight:600;display:inline-flex;align-items:center;gap:4px;">
        <i class="fas fa-wand-magic-sparkles"></i> Resúmenes IA
      </button>

      <button id="pv-bulk-addpack${s}" type="button"
              title="Añadir los artículos seleccionados a un PrionPack"
              style="padding:4px 10px;border-radius:6px;background:rgba(255,255,255,0.14);color:white;
                     border:1px solid rgba(255,255,255,0.25);cursor:pointer;font-size:12px;
                     font-weight:600;display:inline-flex;align-items:center;gap:4px;">
        <i class="fas fa-cubes-stacked"></i> A PrionPack
      </button>

      <button id="pv-bulk-addcollection${s}" type="button"
              title="Añadir los artículos seleccionados a una colección"
              style="padding:4px 10px;border-radius:6px;background:rgba(255,255,255,0.14);color:white;
                     border:1px solid rgba(255,255,255,0.25);cursor:pointer;font-size:12px;
                     font-weight:600;display:inline-flex;align-items:center;gap:4px;">
        <i class="fas fa-folder-plus"></i> A colección
      </button>

      <button id="pv-bulk-delete${s}" type="button"
              title="Eliminar los artículos seleccionados (y sus PDFs en Dropbox)"
              style="padding:4px 10px;border-radius:6px;background:#b91c1c;color:white;
                     border:1px solid #fecaca;cursor:pointer;font-size:12px;font-weight:600;
                     display:inline-flex;align-items:center;gap:4px;">
        <i class="fas fa-trash"></i> Eliminar
      </button>` : ''}

      <button id="pv-bulk-clear${s}" type="button"
              style="padding:4px 10px;border-radius:6px;background:transparent;color:white;
                     border:1px solid rgba(255,255,255,0.4);cursor:pointer;font-size:12px;">
        Limpiar
      </button>`;
  }

  const _BULK_SUFFIXES = ['', '-top'];

  function wireBulkBar() {
    // Inject the same markup into both bars so the actions are in reach
    // from the top AND the bottom of long article lists.
    const bottom = document.getElementById('pv-bulk-bar');
    const top    = document.getElementById('pv-bulk-bar-top');
    if (bottom) bottom.innerHTML = bulkBarHtml('');
    if (top)    top.innerHTML    = bulkBarHtml('-top');

    // Header select-all toggle (lives in the table thead, not the bar
    // itself — wire only once.)
    const hdr = document.getElementById('pv-select-all');
    if (hdr) {
      hdr.addEventListener('change', () => {
        const visible = visibleRowIds();
        if (hdr.checked) visible.forEach(id => state.selectedIds.add(id));
        else             visible.forEach(id => state.selectedIds.delete(id));
        document.querySelectorAll('.pv-row-select').forEach(cb => {
          cb.checked = state.selectedIds.has(cb.dataset.aid);
        });
        hdr.indeterminate = false;
        updateBulkBar();
      });
    }

    _BULK_SUFFIXES.forEach(wireOneBulkBar);
  }

  function wireOneBulkBar(suffix) {
    const s = suffix || '';
    const $id = id => document.getElementById(id + s);
    if (!$id('pv-bulk-count')) return;

    // "Ver sólo seleccionados" toggle
    const onlyBtn = $id('pv-bulk-only-selected');
    if (onlyBtn) {
      onlyBtn.addEventListener('click', () => {
        state.filterSelectedOnly = !state.filterSelectedOnly;
        state.page = 1;
        _paintOnlySelectedBtn();
        if (state.filterSelectedOnly) {
          // Clear all search/filter state so the view shows exactly the
          // selected articles without any search filter interfering.
          state.q = ''; state.yearMin = null; state.yearMax = null;
          state.journal = ''; state.authors = ''; state.tagId = null;
          const si = document.getElementById('pv-search-input');
          if (si) { si.value = ''; const cb = document.getElementById('pv-search-clear'); if (cb) cb.style.display = 'none'; }
          const fy1 = document.getElementById('filter-year-min'); if (fy1) fy1.value = '';
          const fy2 = document.getElementById('filter-year-max'); if (fy2) fy2.value = '';
          const fa = document.getElementById('filter-authors'); if (fa) fa.value = '';
          const fj = document.getElementById('filter-journal'); if (fj) fj.value = '';
        }
        loadArticles();
      });
    }

    // "Select all matching the filter" expansion
    const filteredBtn = $id('pv-bulk-select-filtered');
    if (filteredBtn) {
      filteredBtn.addEventListener('click', async () => {
        filteredBtn.disabled = true;
        const original = filteredBtn.innerHTML;
        filteredBtn.innerHTML = 'Cargando ids…';
        try {
          const ids = await fetchAllFilteredIds();
          ids.forEach(id => state.selectedIds.add(id));
          document.querySelectorAll('.pv-row-select').forEach(cb => {
            cb.checked = state.selectedIds.has(cb.dataset.aid);
          });
          updateBulkBar();
          syncSelectAllHeader();
        } catch (e) {
          alert('No se pudo expandir la selección: ' + e.message);
        } finally {
          filteredBtn.disabled = false;
          filteredBtn.innerHTML = original;
        }
      });
    }

    // Clear-selection button
    const clearBtn = $id('pv-bulk-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        state.selectedIds.clear();
        document.querySelectorAll('.pv-row-select').forEach(cb => { cb.checked = false; });
        updateBulkBar();
        syncSelectAllHeader();
      });
    }

    // Priority chips
    const prioBox = $id('pv-bulk-priority');
    if (prioBox) {
      prioBox.innerHTML = [1, 2, 3, 4, 5].map(p => {
        const style = p >= 5 ? 'background:#fee2e2;color:#b91c1c;'
                    : p === 4 ? 'background:#fef3c7;color:#92400e;'
                    : p === 3 ? 'background:#e0f2fe;color:#075985;'
                    : p === 2 ? 'background:#f3f4f6;color:#4b5563;'
                              : 'background:#e5e7eb;color:#6b7280;';
        return `<button type="button" class="pv-bulk-prio" data-prio="${p}"
                        style="${style}border:none;border-radius:5px;
                               padding:3px 9px;font-size:11.5px;font-weight:700;
                               cursor:pointer;font-variant-numeric:tabular-nums;">P${p}</button>`;
      }).join('');
      prioBox.querySelectorAll('.pv-bulk-prio').forEach(b =>
        b.addEventListener('click', () => doBulk({priority: parseInt(b.dataset.prio, 10)},
                                                 `prioridad P${b.dataset.prio}`)));
    }

    // Color dots
    const colorBox = $id('pv-bulk-color');
    if (colorBox) {
      const dots = COLOR_LABELS.map(c =>
        `<button type="button" class="pv-bulk-color" data-color="${c.value}"
                 title="${c.value}"
                 style="width:18px;height:18px;border-radius:50%;border:2px solid white;
                        background:${c.css};cursor:pointer;padding:0;"></button>`
      ).join('');
      colorBox.innerHTML = dots +
        `<button type="button" class="pv-bulk-color" data-color=""
                 title="Sin color"
                 style="width:18px;height:18px;border-radius:50%;border:2px dashed rgba(255,255,255,0.5);
                        background:transparent;cursor:pointer;padding:0;"></button>`;
      colorBox.querySelectorAll('.pv-bulk-color').forEach(b =>
        b.addEventListener('click', () => {
          const v = b.dataset.color || null;
          doBulk({color_label: v}, v ? `color ${v}` : 'sin color');
        }));
    }

    // Flag / milestone toggles (article-level)
    $id('pv-bulk-flag-on') ?.addEventListener('click',
      () => doBulk({is_flagged: true},   'bandera'));
    $id('pv-bulk-flag-off')?.addEventListener('click',
      () => doBulk({is_flagged: false},  'sin bandera'));
    $id('pv-bulk-star-on') ?.addEventListener('click',
      () => doBulk({is_milestone: true}, 'hito'));
    $id('pv-bulk-star-off')?.addEventListener('click',
      () => doBulk({is_milestone: false},'sin hito'));

    // Favorite / read toggles (per-viewer state)
    $id('pv-bulk-fav-on') ?.addEventListener('click',
      () => doBulkUserState({is_favorite: true},  'favorito'));
    $id('pv-bulk-fav-off')?.addEventListener('click',
      () => doBulkUserState({is_favorite: false}, 'no favorito'));
    $id('pv-bulk-read-on') ?.addEventListener('click',
      () => doBulkUserState({is_read: true},      'leído'));
    $id('pv-bulk-read-off')?.addEventListener('click',
      () => doBulkUserState({is_read: false},     'no leído'));
    $id('pv-bulk-jc-on') ?.addEventListener('click',
      () => doBulkJc(true,  'Journal Club'));
    $id('pv-bulk-jc-off')?.addEventListener('click',
      () => doBulkJc(false, 'sin Journal Club'));

    // Tags picker
    $id('pv-bulk-tags')?.addEventListener('click',
      () => openBulkTagPicker(Array.from(state.selectedIds)));

    // Bulk AI summary on the current selection — opens the existing
    // modal in "selection" mode so the user picks a provider, then
    // Start sends the chosen ids to the backend.
    $id('pv-bulk-summarize')?.addEventListener('click',
      () => {
        const count = state.selectedIds.size;
        if (!count) return;
        window.PV_SUMMARY_SELECTION = Array.from(state.selectedIds);
        const btn = document.getElementById('btn-batch-summary');
        if (btn) btn.click();   // re-uses the modal's open() flow
      });

    // Bulk add to PrionPack — opens the same pack picker modal as the
    // single-article flow, but POSTs to /import-articles with the
    // whole selection.
    $id('pv-bulk-addpack')?.addEventListener('click',
      () => openBulkPackPicker(Array.from(state.selectedIds)));

    // Bulk add to a manual Collection.
    $id('pv-bulk-addcollection')?.addEventListener('click',
      () => openAddToCollectionPicker(Array.from(state.selectedIds)));

    // Bulk DELETE — destructive, double-confirm.
    $id('pv-bulk-delete')?.addEventListener('click',
      async () => {
        const count = state.selectedIds.size;
        if (!count) return;
        const phrase = String(count);
        const typed = prompt(
          `Vas a eliminar ${count} artículo${count === 1 ? '' : 's'} y ` +
          `su${count === 1 ? '' : 's'} PDF${count === 1 ? '' : 's'} de Dropbox.\n\n` +
          `Esta acción NO se puede deshacer desde la app (Dropbox guarda 30 días ` +
          `de historial de versiones de los PDFs).\n\n` +
          `Para confirmar, escribe el número de artículos a borrar (${count}):`
        );
        if (typed === null) return;
        if (typed.trim() !== phrase) {
          alert('Cancelado: el número no coincide.');
          return;
        }
        try {
          const ids = Array.from(state.selectedIds);
          const r = await api('/articles/bulk-delete', {
            method: 'POST',
            body: JSON.stringify({ ids }),
          });
          state.selectedIds.clear();
          updateBulkBar();
          loadArticles();
          refreshStats();
          const lostPdf = r.dropbox_failed
            ? ` (${r.dropbox_failed} PDFs no se pudieron borrar de Dropbox; revisa los logs)`
            : '';
          alert(`Borrados ${r.deleted} artículos. ` +
                `${r.dropbox_deleted} PDFs eliminados de Dropbox${lostPdf}.`);
        } catch (e) {
          alert('Error en el borrado masivo: ' + e.message);
        }
      });
  }

  async function doBulkUserState(payload, descr) {
    const ids = Array.from(state.selectedIds);
    if (!ids.length) return;
    if (ids.length > 5 && !confirm(`Marcar como "${descr}" ${ids.length} artículos. ¿Continuar?`)) return;
    try {
      await api('/articles/bulk-user-state', {
        method: 'POST',
        body: JSON.stringify({ ids, ...payload }),
      });
      loadArticles();
    } catch (e) {
      alert('Error en la operación masiva: ' + e.message);
    }
  }

  // Journal Club is a SHARED, admin-only mark (article-level) — its own route.
  async function doBulkJc(value, descr) {
    const ids = Array.from(state.selectedIds);
    if (!ids.length) return;
    if (ids.length > 5 && !confirm(`Marcar como "${descr}" ${ids.length} artículos. ¿Continuar?`)) return;
    try {
      await api('/articles/bulk-jc', {
        method: 'POST',
        body: JSON.stringify({ ids, value }),
      });
      loadArticles();
    } catch (e) {
      alert('Error en la operación masiva: ' + e.message);
    }
  }

  // ── Bulk tag picker ──────────────────────────────────────────────────
  // Each tag is a tri-state chip: idle (no change), add (+), remove (−).
  // On Apply we POST a single /articles/bulk-tags call with the chosen
  // add / remove lists.
  let _bulkTagState = new Map();   // tagId -> 'add' | 'remove' | undefined

  async function openBulkTagPicker(ids) {
    if (!ids || !ids.length) return;
    const modal = document.getElementById('pv-bulk-tag-modal');
    if (!modal) return;

    _bulkTagState = new Map();
    document.getElementById('pv-bulk-tag-summary').textContent =
      `Selección: ${ids.length} artículo${ids.length === 1 ? '' : 's'}.`;
    document.getElementById('pv-bulk-tag-error').style.display = 'none';

    const list = document.getElementById('pv-bulk-tag-list');
    list.innerHTML = '<span style="color:#9ca3af;font-size:12px;">Cargando…</span>';

    let tags = [];
    try { tags = await api('/tags'); }
    catch (e) {
      list.innerHTML = `<span style="color:#b91c1c;">Error: ${esc(e.message)}</span>`;
      modal.style.display = 'flex';
      return;
    }
    if (!tags.length) {
      list.innerHTML = '<span style="color:#9ca3af;font-style:italic;">No hay tags creados. Crea uno desde el menú lateral.</span>';
      modal.style.display = 'flex';
      return;
    }

    function renderChips() {
      list.innerHTML = tags.map(t => {
        const st = _bulkTagState.get(t.id);
        const baseColor = t.color || '#6b7280';
        const bg     = st === 'add'    ? '#16a34a' : st === 'remove' ? '#dc2626' : 'white';
        const fg     = st ? 'white' : esc(baseColor);
        const border = st === 'add'    ? '#16a34a' : st === 'remove' ? '#dc2626' : esc(baseColor);
        const prefix = st === 'add' ? '+ ' : st === 'remove' ? '− ' : '';
        return `
          <button type="button" class="pv-bulk-tag-chip" data-tag-id="${t.id}"
                  title="Clic para alternar: añadir → quitar → sin cambios"
                  style="padding:4px 10px;border-radius:14px;font-size:12px;font-weight:600;
                         cursor:pointer;border:1.5px solid ${border};
                         background:${bg};color:${fg};
                         display:inline-flex;align-items:center;gap:5px;">
            ${prefix}${esc(t.name)}
          </button>`;
      }).join('');
      list.querySelectorAll('.pv-bulk-tag-chip').forEach(b =>
        b.addEventListener('click', () => {
          const tid = parseInt(b.dataset.tagId, 10);
          const cur = _bulkTagState.get(tid);
          if      (cur === undefined) _bulkTagState.set(tid, 'add');
          else if (cur === 'add')     _bulkTagState.set(tid, 'remove');
          else                        _bulkTagState.delete(tid);
          renderChips();
        }));
    }
    renderChips();

    document.getElementById('pv-bulk-tag-apply').onclick = async () => {
      const add_tag_ids    = Array.from(_bulkTagState.entries())
        .filter(([, v]) => v === 'add').map(([k]) => k);
      const remove_tag_ids = Array.from(_bulkTagState.entries())
        .filter(([, v]) => v === 'remove').map(([k]) => k);
      const err = document.getElementById('pv-bulk-tag-error');
      err.style.display = 'none';
      if (!add_tag_ids.length && !remove_tag_ids.length) {
        err.textContent = 'No has marcado ningún tag.';
        err.style.display = 'block';
        return;
      }
      const apply = document.getElementById('pv-bulk-tag-apply');
      apply.disabled = true;
      const original = apply.textContent;
      apply.textContent = 'Aplicando…';
      try {
        await api('/articles/bulk-tags', {
          method: 'POST',
          body: JSON.stringify({ ids, add_tag_ids, remove_tag_ids }),
        });
        modal.style.display = 'none';
        loadArticles();
        refreshTags();
      } catch (e) {
        err.textContent = 'Error: ' + e.message;
        err.style.display = 'block';
        apply.disabled = false;
        apply.textContent = original;
      }
    };

    modal.style.display = 'flex';
  }

  function wireBulkTagModal() {
    const modal = document.getElementById('pv-bulk-tag-modal');
    if (!modal || modal.dataset.wired) return;
    modal.dataset.wired = '1';
    const close = () => { modal.style.display = 'none'; };
    document.getElementById('pv-bulk-tag-close')?.addEventListener('click', close);
    document.getElementById('pv-bulk-tag-cancel')?.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop')?.addEventListener('click', close);
  }

  async function doBulk(updates, descr) {
    const count = state.selectedIds.size;
    if (!count) return;
    if (count > 5 && !confirm(`Aplicar "${descr}" a ${count} artículos. ¿Continuar?`)) return;
    try {
      const r = await bulkPatch(updates);
      // Reload the list so the visual state matches the DB.
      loadArticles();
    } catch (e) {
      alert('Error en la operación masiva: ' + e.message);
    }
  }

