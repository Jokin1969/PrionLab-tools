/* PrionVault — frontend (Phase 1)
 *
 * Reads:
 *   GET /prionvault/api/articles      (list + filters + full-text q)
 *   GET /prionvault/api/articles/:id  (detail)
 *   GET /prionvault/api/articles/stats
 *   GET /prionvault/api/tags
 *
 * Writes (admin only — UI hides controls; backend enforces):
 *   POST   /prionvault/api/tags
 *   PUT    /prionvault/api/articles/:aid/tags/:tag_id
 *   DELETE /prionvault/api/articles/:aid/tags/:tag_id
 *   PATCH  /prionvault/api/articles/:aid
 *   DELETE /prionvault/api/articles/:aid
 *   POST   /prionvault/api/articles/:aid/annotations
 *   DELETE /prionvault/api/annotations/:id
 */
(() => {
  const API = '/prionvault/api';

  const ROLE     = (document.querySelector('meta[name="pv-user-role"]')?.content || '').trim();
  const USER_ID  = (document.querySelector('meta[name="pv-user-id"]')?.content || '').trim();
  const IS_ADMIN = ROLE === 'admin';
  document.body.classList.toggle('pv-role-admin',  IS_ADMIN);
  document.body.classList.toggle('pv-role-reader', !IS_ADMIN);

  const state = {
    q: '',
    sort: 'added_desc',
    yearMin: null,
    yearMax: null,
    journal: '',
    authors: '',
    tagId: null,
    hasSummary: null,
    inPrionread: null,   // null = all, true = in PrionRead, false = not in PrionRead
    isFlagged: null,     // null = all, true = flagged, false = not flagged
    isMilestone: null,   // null = all, true = milestone, false = not
    colorLabel: null,    // null = all, 'red'..'purple', or 'none' for no label
    priorityEq: null,    // null = all, else integer 1-5 (exact match)
    extraction: null,    // null = all, 'extracted' | 'pending' | 'failed'
    isFavorite: null,    // null = all, true = only favorites, false = non-favorites
    isRead: null,        // null = all, true = personally read, false = unread
    collectionId: null,        // null = no collection filter, else UUID
    collectionGroup: null,     // string when filtering by group
    collectionSubgroup: null,  // string when also restricted to subgroup
    hasJc: null,         // null = all, true = JC sí, false = sin JC
    jcPresenter: '',     // substring filter on JC presenter name
    jcYear: null,        // year of JC presentation
    hasPp: null,         // null = all, true = en algún PrionPack, false = sin pack
    ppId: '',            // specific PrionPack id (e.g. "PRP-001") or ''
    abstractStatus: '',  // '' | 'has' | 'pending' | 'unavailable'
    indexedStatus:  '',  // '' | 'yes' | 'no'
    page: 1,
    size: parseInt(localStorage.getItem('pv-page-size') || '100', 10) || 100,
    selectedIds: new Set(),  // UUIDs selected for bulk operations
    lastTotal:   0,          // last seen total count of the current filter
  };

  const COLOR_LABELS = [
    { value: 'red',    css: '#ef4444' },
    { value: 'orange', css: '#fb923c' },
    { value: 'yellow', css: '#facc15' },
    { value: 'green',  css: '#22c55e' },
    { value: 'blue',   css: '#3b82f6' },
    { value: 'purple', css: '#a855f7' },
  ];
  const COLOR_CSS = Object.fromEntries(COLOR_LABELS.map(c => [c.value, c.css]));

  // ── helpers ────────────────────────────────────────────────────────────
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                                  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const supHtml = s => esc(s).replace(/\^(\S[^\^\n]*?)\^/g, '<sup>$1</sup>');

  // Lightweight Markdown rendering for AI summaries.
  // Handles the three constructs the model actually produces:
  //   ## Heading       → coloured uppercase block
  //   ### Heading      → smaller subheading
  //   **bold**         → <strong>bold</strong>
  // Input is escaped first so we never inject untrusted HTML.
  function markdownLite(text) {
    let html = supHtml(text);
    html = html.replace(/^##\s+(.+)$/gm,
      '<div style="font-size:12.5px;font-weight:700;color:#0F3460;' +
      'text-transform:uppercase;letter-spacing:0.04em;' +
      'margin:14px 0 4px;">$1</div>');
    html = html.replace(/^###\s+(.+)$/gm,
      '<div style="font-size:12px;font-weight:700;color:#374151;' +
      'margin:10px 0 3px;">$1</div>');
    html = html.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    return html;
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Modal focus trap ─────────────────────────────────────────────────
  // Trap Tab navigation inside the open modal and restore focus to the
  // element that opened it on close. Call wireModalFocusTrap(modalEl)
  // once per modal element; safe to call repeatedly (idempotent).
  const _focusTrapMemo = new WeakMap();
  function wireModalFocusTrap(modal) {
    if (!modal || _focusTrapMemo.has(modal)) return;
    _focusTrapMemo.set(modal, true);

    const SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]),' +
                     ' input:not([disabled]):not([type="hidden"]), select:not([disabled]),' +
                     ' [tabindex]:not([tabindex="-1"])';

    function focusables() {
      return Array.from(modal.querySelectorAll(SELECTOR))
        .filter(el => el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    }
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const close = modal.querySelector('.pv-modal-close, [data-close]');
        if (close) close.click();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });

    // Observe display:flex toggling. When the modal becomes visible,
    // remember the opener and move focus into the modal. On hide,
    // restore focus to the opener.
    const obs = new MutationObserver(() => {
      const visible = modal.style.display && modal.style.display !== 'none';
      if (visible && !modal._opener) {
        modal._opener = document.activeElement;
        const f = focusables();
        if (f.length) setTimeout(() => f[0].focus(), 30);
      } else if (!visible && modal._opener) {
        try { modal._opener.focus(); } catch (_) { /* ignore */ }
        modal._opener = null;
      }
    });
    obs.observe(modal, { attributes: true, attributeFilter: ['style'] });
  }

  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(API + path, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        ...opts,
      });
    } catch (netErr) {
      // Browser-level fetch failure (no response received). Safari /
      // iOS surface this as "Load failed", Chrome / FF as
      // "Failed to fetch" — translate to something the user can act on.
      const raw = (netErr && netErr.message) || 'red sin respuesta';
      const e = new Error(
        `Red caída o servidor reiniciándose (${raw}). ` +
        `Espera unos segundos y reintenta.`
      );
      e.status = 0;
      e.network = true;
      throw e;
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const base = err.error || ('HTTP ' + res.status);
      const msg  = err.detail ? `${base}: ${err.detail}` : base;
      const e = new Error(msg);
      e.status = res.status;
      e.detail = err.detail;
      e.body   = err;
      throw e;
    }
    return res.json();
  }

  // ── render: stats ──────────────────────────────────────────────────────
  async function refreshStats() {
    try {
      const s = await api('/articles/stats');
      const set = (id, n) => {
        const el = document.getElementById(id);
        if (el) el.textContent = String(n);
      };
      set('count-total',      s.total);
      set('count-no-summary', s.total - s.with_summary_ai);
      set('count-indexed',    s.indexed);
    } catch (e) { console.error(e); }
  }

  // ── render: tags ───────────────────────────────────────────────────────
  // ── Collections (manual groupings) ────────────────────────────────────
  // Cache the full set of collections so the editor's "group"/"subgroup"
  // datalists can suggest existing labels without a second fetch.
  let _allCollections = [];

  async function refreshPrionPacksDropdown() {
    const sel = document.getElementById('filter-pp-id');
    if (!sel) return;
    try {
      const r = await api('/prionpacks');
      const items = r.items || [];
      const current = sel.value;
      sel.innerHTML = '<option value="">todos</option>' +
        items.map(p =>
          `<option value="${esc(p.id)}">${esc(p.id)} — ${esc((p.title || '').slice(0, 60))}</option>`
        ).join('');
      if (current) sel.value = current;
    } catch (e) {
      // Non-fatal — the dropdown stays with just "todos".
      console.warn('refreshPrionPacksDropdown:', e.message);
    }
  }

  // ── Collapse state for the collection sidebar (groups + subgroups) ───
  const _COLL_GROUPS_KEY    = 'pv-coll-collapsed-groups';
  const _COLL_SUBGROUPS_KEY = 'pv-coll-collapsed-subgroups';

  function _loadCollapsedSet(key) {
    try {
      const arr = JSON.parse(localStorage.getItem(key) || '[]');
      return new Set(Array.isArray(arr) ? arr : []);
    } catch { return new Set(); }
  }
  function _saveCollapsedSet(key, set) {
    try { localStorage.setItem(key, JSON.stringify(Array.from(set))); }
    catch { /* localStorage full or disabled — silently drop */ }
  }
  function _toggleCollapsed(key, value) {
    const set = _loadCollapsedSet(key);
    if (set.has(value)) set.delete(value); else set.add(value);
    _saveCollapsedSet(key, set);
  }

  async function refreshCollections() {
    const container = document.getElementById('collection-list');
    if (!container) return;
    let items = [];
    try {
      const r = await api('/collections');
      items = r.items || [];
    } catch (e) {
      container.innerHTML = `<div style="padding:6px 10px;font-size:11px;color:#fca5a5;">
        Error: ${esc(e.message)}</div>`;
      return;
    }
    _allCollections = items;
    refreshCollectionsCount();
    refreshFilterIndicators();
    if (!items.length) {
      container.innerHTML = `<div style="padding:6px 10px;font-size:11px;color:rgba(255,255,255,0.35);">
        Crea una con el botón +</div>`;
      return;
    }

    // ── Build the (group → subgroup → [collection]) tree.
    const tree = {};
    items.forEach(c => {
      const g  = (c.group_name    || '').trim();
      const sg = (c.subgroup_name || '').trim();
      if (!tree[g]) tree[g] = {};
      if (!tree[g][sg]) tree[g][sg] = [];
      tree[g][sg].push(c);
    });

    container.innerHTML = '';
    const collapsedG  = _loadCollapsedSet(_COLL_GROUPS_KEY);
    const collapsedSG = _loadCollapsedSet(_COLL_SUBGROUPS_KEY);

    // Render groups in alphabetical order, then "no group" last
    // ("Sin grupo" sentinel = empty key).
    const groupKeys = Object.keys(tree)
      .filter(k => k !== '')
      .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
    if ('' in tree) groupKeys.push('');

    groupKeys.forEach(g => {
      const subBranch = tree[g];
      const groupCollapsed = !!g && collapsedG.has(g);
      if (g) container.appendChild(buildGroupHeader(g, subBranch, groupCollapsed));
      if (groupCollapsed) return;   // skip subgroups + rows under collapsed group

      const subKeys = Object.keys(subBranch)
        .filter(k => k !== '')
        .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
      if ('' in subBranch) subKeys.push('');
      subKeys.forEach(sg => {
        const colls = subBranch[sg];
        const sgKey = `${g}::${sg}`;
        const sgCollapsed = !!sg && collapsedSG.has(sgKey);
        if (sg) container.appendChild(buildSubgroupHeader(g, sg, colls, sgCollapsed));
        if (sgCollapsed) return;
        colls
          .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }))
          .forEach(c => container.appendChild(buildCollectionRow(c, !!g)));
      });
    });
    repaintCollectionSelection();
  }

  function refreshCollectionsCount() {
    const span = document.getElementById('collection-count');
    if (!span) return;
    span.textContent = _allCollections.length > 0
      ? `(${_allCollections.length})` : '';
  }

  function buildGroupHeader(group, subBranch, collapsed) {
    const collCount = Object.values(subBranch)
      .reduce((acc, list) => acc + list.length, 0);
    const btn = document.createElement('button');
    btn.className = 'pv-nav-btn';
    btn.dataset.collectionGroup = group;
    btn.title = `Filtrar por grupo "${group}" (${collCount} colección${collCount === 1 ? '' : 'es'}).\n` +
                `Pulsa la flecha de la izquierda para plegar / desplegar.`;
    btn.style.padding = '5px 10px';
    const chev = collapsed ? 'fa-chevron-right' : 'fa-chevron-down';
    btn.innerHTML = `
      <span class="pv-coll-chevron"
            title="${collapsed ? 'Desplegar' : 'Plegar'}"
            style="display:inline-flex;align-items:center;justify-content:center;
                   width:18px;height:18px;border-radius:4px;flex-shrink:0;
                   color:rgba(255,255,255,0.6);cursor:pointer;"
            onmouseover="this.style.background='rgba(255,255,255,0.14)';this.style.color='white';"
            onmouseout="this.style.background='transparent';this.style.color='rgba(255,255,255,0.6)';"
      ><i class="fas ${chev}" style="font-size:9px;"></i></span>
      <span style="display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;flex:1;">
        <i class="fas fa-folder-open" style="font-size:11px;opacity:0.7;"></i>
        <span style="font-weight:700;text-transform:uppercase;letter-spacing:0.04em;font-size:11px;
                     overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(group)}</span>
      </span>
      <span style="font-size:10px;background:rgba(255,255,255,0.14);padding:1px 7px;border-radius:20px;flex-shrink:0;">${collCount}</span>
    `;
    btn.addEventListener('click', (ev) => {
      // Chevron toggles collapse state without changing the filter.
      if (ev.target.closest('.pv-coll-chevron')) {
        ev.preventDefault();
        _toggleCollapsed(_COLL_GROUPS_KEY, group);
        refreshCollections();
        return;
      }
      const sameGroup = state.collectionGroup === group && !state.collectionSubgroup;
      state.collectionGroup    = sameGroup ? null : group;
      state.collectionSubgroup = null;
      state.collectionId       = null;
      state.page = 1;
      repaintCollectionSelection();
      refreshFilterIndicators();
      loadArticles();
    });
    return btn;
  }

  function buildSubgroupHeader(group, subgroup, colls, collapsed) {
    const btn = document.createElement('button');
    btn.className = 'pv-nav-btn';
    btn.dataset.collectionGroup    = group;
    btn.dataset.collectionSubgroup = subgroup;
    btn.title = `Filtrar por "${group} · ${subgroup}".\n` +
                `Pulsa la flecha de la izquierda para plegar / desplegar.`;
    btn.style.padding = '4px 10px 4px 22px';
    const chev = collapsed ? 'fa-chevron-right' : 'fa-chevron-down';
    btn.innerHTML = `
      <span class="pv-coll-chevron"
            title="${collapsed ? 'Desplegar' : 'Plegar'}"
            style="display:inline-flex;align-items:center;justify-content:center;
                   width:16px;height:16px;border-radius:4px;flex-shrink:0;
                   color:rgba(255,255,255,0.55);cursor:pointer;"
            onmouseover="this.style.background='rgba(255,255,255,0.14)';this.style.color='white';"
            onmouseout="this.style.background='transparent';this.style.color='rgba(255,255,255,0.55)';"
      ><i class="fas ${chev}" style="font-size:8.5px;"></i></span>
      <span style="display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;flex:1;">
        <i class="fas fa-folder" style="font-size:10px;opacity:0.55;"></i>
        <span style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(subgroup)}</span>
      </span>
      <span style="font-size:10px;background:rgba(255,255,255,0.14);padding:1px 7px;border-radius:20px;flex-shrink:0;">${colls.length}</span>
    `;
    btn.addEventListener('click', (ev) => {
      if (ev.target.closest('.pv-coll-chevron')) {
        ev.preventDefault();
        _toggleCollapsed(_COLL_SUBGROUPS_KEY, `${group}::${subgroup}`);
        refreshCollections();
        return;
      }
      const same = state.collectionGroup === group
                && state.collectionSubgroup === subgroup;
      state.collectionGroup    = same ? null : group;
      state.collectionSubgroup = same ? null : subgroup;
      state.collectionId       = null;
      state.page = 1;
      repaintCollectionSelection();
      refreshFilterIndicators();
      loadArticles();
    });
    return btn;
  }

  function buildCollectionRow(c, indented) {
    const btn = document.createElement('button');
    btn.className = 'pv-nav-btn';
    btn.dataset.collectionId = c.id;
    if (indented) btn.style.paddingLeft = '34px';
    const kindIcon = c.kind === 'smart'
      ? '<i class="fas fa-bolt" style="font-size:10px;opacity:0.5;"></i>'
      : '<i class="fas fa-folder" style="font-size:10px;opacity:0.5;"></i>';
    btn.title = (c.description ? c.description + '\n\n' : '') +
                (IS_ADMIN
                  ? '• Click: filtrar la lista\n' +
                    '• Botón ✏ a la derecha: editar\n' +
                    '• Botón 📦 a la derecha: mandar a un PrionPack\n' +
                    '• Click derecho: eliminar'
                  : 'Click para filtrar la lista');
    const miniBtn = (cls, icon, title) => `
      <span class="${cls}" data-collection-id="${esc(c.id)}"
            title="${title}"
            style="display:inline-flex;align-items:center;justify-content:center;
                   padding:2px 5px;border-radius:5px;cursor:pointer;
                   background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.7);
                   margin-left:4px;flex-shrink:0;line-height:1;"
            onmouseover="this.style.background='rgba(255,255,255,0.22)';this.style.color='white';"
            onmouseout="this.style.background='rgba(255,255,255,0.08)';this.style.color='rgba(255,255,255,0.7)';"
      ><i class="fas ${icon}" style="font-size:10px;"></i></span>`;
    const adminBtns = IS_ADMIN
      ? miniBtn('pv-coll-edit',      'fa-pen',
                'Editar esta colección') +
        miniBtn('pv-coll-send-pack', 'fa-cubes-stacked',
                'Enviar todos los artículos de esta colección a un PrionPack')
      : '';
    btn.innerHTML = `
      <span style="display:inline-flex;align-items:center;gap:7px;min-width:0;overflow:hidden;flex:1;">
        <span style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${esc(c.color || '#9ca3af')}"></span>
        ${kindIcon}
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(c.name)}</span>
      </span>
      <span style="display:inline-flex;align-items:center;flex-shrink:0;">
        <span style="font-size:10px;background:rgba(255,255,255,0.14);padding:1px 7px;border-radius:20px;">${c.article_count}</span>
        ${adminBtns}
      </span>
    `;
    btn.addEventListener('click', (ev) => {
      if (ev.shiftKey && IS_ADMIN) {
        ev.preventDefault();
        openCollectionEditor(c);
        return;
      }
      const same = state.collectionId === c.id;
      state.collectionId       = same ? null : c.id;
      state.collectionGroup    = null;
      state.collectionSubgroup = null;
      state.page = 1;
      repaintCollectionSelection();
      refreshFilterIndicators();
      loadArticles();
    });
    btn.addEventListener('contextmenu', ev => {
      if (!IS_ADMIN) return;
      ev.preventDefault();
      if (!confirm(`Borrar la colección "${c.name}"? (los artículos NO se borran)`)) return;
      api(`/collections/${c.id}`, { method: 'DELETE' })
        .then(() => { if (state.collectionId === c.id) state.collectionId = null;
                      refreshCollections(); loadArticles(); })
        .catch(e => alert('Error: ' + e.message));
    });
    // Wire the inline admin badges (✏ edit, 📦 send-to-pack). They live
    // inside the row button so we must stopPropagation to keep the
    // row-level filter click from also firing.
    setTimeout(() => {
      const editBadge = btn.querySelector('.pv-coll-edit');
      if (editBadge) editBadge.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        openCollectionEditor(c);
      });

      const packBadge = btn.querySelector('.pv-coll-send-pack');
      if (packBadge) packBadge.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          const r = await api(`/collections/${c.id}/article-ids`);
          const ids = r.ids || [];
          if (!ids.length) { alert('Esta colección no tiene artículos.'); return; }
          openBulkPackPicker(ids);
        } catch (e) { alert('No se pudo cargar la colección: ' + e.message); }
      });
    }, 0);
    return btn;
  }

  function repaintCollectionSelection() {
    document.querySelectorAll('#collection-list .pv-nav-btn').forEach(b => {
      let active = false;
      if (b.dataset.collectionId && b.dataset.collectionId === state.collectionId) active = true;
      if (b.dataset.collectionGroup    && !b.dataset.collectionSubgroup
          && b.dataset.collectionGroup === state.collectionGroup
          && !state.collectionSubgroup
          && !state.collectionId) active = true;
      if (b.dataset.collectionGroup    && b.dataset.collectionSubgroup
          && b.dataset.collectionGroup    === state.collectionGroup
          && b.dataset.collectionSubgroup === state.collectionSubgroup
          && !state.collectionId) active = true;
      b.style.background = active ? 'rgba(255,255,255,0.18)' : '';
    });
  }

  function wireNewCollectionButton() {
    const btn = document.getElementById('btn-new-collection');
    if (btn) btn.addEventListener('click', () => openCollectionEditor(null));
    wireCollectionEditor();
  }

  // ── Collection editor modal (create + edit, manual + smart) ────────
  let _collectionEditing = null;   // existing collection id when editing
  let _activePrionPacks = null;    // cached: [{id, title}] of active packs

  async function _ensureActivePrionPacks() {
    if (_activePrionPacks) return _activePrionPacks;
    try {
      const r = await api('/prionpacks');
      _activePrionPacks = (r.items || []);
    } catch {
      _activePrionPacks = [];
    }
    return _activePrionPacks;
  }

  function _isPrionPacksGroup(value) {
    return (value || '').trim().toLowerCase() === 'prionpacks';
  }

  // Repopulate the subgroup datalist. When the group field equals
  // "PrionPacks" we suggest each active PrionPack (so the user can pick
  // a pack as the subgroup); otherwise we fall back to existing
  // subgroups from the user's other collections.
  async function _refreshSubgroupSuggestions() {
    const dl = document.getElementById('pv-coll-subgroup-list');
    if (!dl) return;
    const groupVal = document.getElementById('pv-coll-group')?.value || '';
    if (_isPrionPacksGroup(groupVal)) {
      const packs = await _ensureActivePrionPacks();
      dl.innerHTML = packs
        .map(p => {
          const label = `${p.id} — ${(p.title || '').slice(0, 80)}`;
          return `<option value="${esc(label)}"></option>`;
        })
        .join('');
      return;
    }
    const subgroupSet = new Set();
    _allCollections.forEach(c => {
      if (c.subgroup_name) subgroupSet.add(c.subgroup_name);
    });
    dl.innerHTML = Array.from(subgroupSet)
      .sort((a, b) => a.localeCompare(b, 'es'))
      .map(v => `<option value="${esc(v)}"></option>`)
      .join('');
  }

  function wireCollectionEditor() {
    const modal = document.getElementById('pv-collection-modal');
    if (!modal || modal.dataset.wired) return;
    modal.dataset.wired = '1';

    const closeBtn  = document.getElementById('pv-coll-close');
    const cancelBtn = document.getElementById('pv-coll-cancel');
    const saveBtn   = document.getElementById('pv-coll-save');
    const rulesBox  = document.getElementById('pv-coll-rules');
    const errBox    = document.getElementById('pv-coll-error');

    function close() { modal.style.display = 'none'; _collectionEditing = null; }
    closeBtn.addEventListener('click', close);
    cancelBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    // When the Group field is set to "PrionPacks", swap the Subgroup
    // datalist for the list of active packs so the user can pick one
    // (e.g. "PRP-001 — …") as the subgroup.
    document.getElementById('pv-coll-group')?.addEventListener('input',
      _refreshSubgroupSuggestions);

    // Toggle rules visibility when kind changes.
    modal.querySelectorAll('input[name="pv-coll-kind"]').forEach(radio => {
      radio.addEventListener('change', () => {
        rulesBox.style.display = radio.value === 'smart' && radio.checked
                                 ? 'block' : (rulesBox.style.display);
        const isSmart = modal.querySelector('input[name="pv-coll-kind"]:checked').value === 'smart';
        rulesBox.style.display = isSmart ? 'block' : 'none';
      });
    });

    saveBtn.addEventListener('click', async () => {
      errBox.style.display = 'none';
      const name = document.getElementById('pv-coll-name').value.trim();
      if (!name) {
        errBox.style.display = 'block';
        errBox.textContent = 'El nombre es obligatorio.';
        return;
      }
      const description = document.getElementById('pv-coll-description').value.trim() || null;
      const color       = document.getElementById('pv-coll-color').value || null;
      const kind = modal.querySelector('input[name="pv-coll-kind"]:checked').value;

      let rules = {};
      if (kind === 'smart') {
        const g = id => document.getElementById(id);
        const grab = (id, key, parser = v => v) => {
          const v = (g(id)?.value || '').trim();
          if (v !== '') rules[key] = parser(v);
        };
        grab('pv-r-q',            'q');
        grab('pv-r-authors',      'authors');
        grab('pv-r-journal',      'journal');
        grab('pv-r-year-min',     'year_min',    v => parseInt(v, 10));
        grab('pv-r-year-max',     'year_max',    v => parseInt(v, 10));
        grab('pv-r-priority',     'priority_eq', v => parseInt(v, 10));
        grab('pv-r-color',        'color_label');
        grab('pv-r-has-summary',  'has_summary');
        const fl = g('pv-r-is-flagged').value;
        if (fl !== '')   rules.is_flagged   = fl === '1';
        const mi = g('pv-r-is-milestone').value;
        if (mi !== '')   rules.is_milestone = mi === '1';
      }

      const group_name    = document.getElementById('pv-coll-group').value.trim() || null;
      const subgroup_name = document.getElementById('pv-coll-subgroup').value.trim() || null;
      if (subgroup_name && !group_name) {
        errBox.style.display = 'block';
        errBox.textContent   = 'Si pones subgrupo, también necesitas un grupo.';
        return;
      }

      saveBtn.disabled = true;
      const original = saveBtn.textContent;
      saveBtn.textContent = 'Guardando…';
      try {
        const body = JSON.stringify({
          name, description, color, kind, rules,
          group_name, subgroup_name,
        });
        if (_collectionEditing) {
          await api(`/collections/${_collectionEditing}`, { method: 'PATCH', body });
        } else {
          await api('/collections', { method: 'POST', body });
        }
        close();
        refreshCollections();
      } catch (e) {
        errBox.style.display = 'block';
        errBox.textContent = 'Error: ' + e.message;
        saveBtn.disabled = false;
        saveBtn.textContent = original;
      }
    });
  }

  function openCollectionEditor(existing) {
    const modal = document.getElementById('pv-collection-modal');
    if (!modal) return;
    _collectionEditing = existing ? existing.id : null;

    // Reset all fields.
    document.getElementById('pv-coll-name').value = existing?.name || '';
    document.getElementById('pv-coll-description').value = existing?.description || '';
    document.getElementById('pv-coll-color').value = existing?.color || '';
    document.getElementById('pv-coll-group').value    = existing?.group_name    || '';
    document.getElementById('pv-coll-subgroup').value = existing?.subgroup_name || '';
    // Populate the Group datalist from existing collections so the user
    // gets autocomplete without typos. The Subgroup datalist is computed
    // dynamically by _refreshSubgroupSuggestions (it swaps in the list
    // of active PrionPacks when Group is "PrionPacks").
    const groupSet = new Set();
    _allCollections.forEach(c => { if (c.group_name) groupSet.add(c.group_name); });
    const groupList = document.getElementById('pv-coll-group-list');
    if (groupList) {
      groupList.innerHTML = Array.from(groupSet)
        .sort((a, b) => a.localeCompare(b, 'es'))
        .map(v => `<option value="${esc(v)}"></option>`)
        .join('');
    }
    _refreshSubgroupSuggestions();

    const kindVal = existing?.kind || 'manual';
    modal.querySelectorAll('input[name="pv-coll-kind"]').forEach(r => {
      r.checked = r.value === kindVal;
    });
    document.getElementById('pv-coll-rules').style.display =
      kindVal === 'smart' ? 'block' : 'none';

    const rules = existing?.rules || {};
    document.getElementById('pv-r-q').value = rules.q || '';
    document.getElementById('pv-r-authors').value = rules.authors || '';
    document.getElementById('pv-r-journal').value = rules.journal || '';
    document.getElementById('pv-r-year-min').value = rules.year_min ?? '';
    document.getElementById('pv-r-year-max').value = rules.year_max ?? '';
    document.getElementById('pv-r-priority').value = rules.priority_eq ?? '';
    document.getElementById('pv-r-color').value = rules.color_label || '';
    document.getElementById('pv-r-has-summary').value = rules.has_summary || '';
    document.getElementById('pv-r-is-flagged').value =
      rules.is_flagged === true ? '1' : (rules.is_flagged === false ? '0' : '');
    document.getElementById('pv-r-is-milestone').value =
      rules.is_milestone === true ? '1' : (rules.is_milestone === false ? '0' : '');

    document.getElementById('pv-coll-error').style.display = 'none';
    document.getElementById('pv-coll-title').innerHTML =
      `<i class="fas fa-folder-plus" style="color:#0F3460;margin-right:8px;"></i>` +
      (existing ? `Editar “${esc(existing.name)}”` : 'Nueva colección');
    const sb = document.getElementById('pv-coll-save');
    sb.disabled = false;
    sb.textContent = existing ? 'Guardar cambios' : 'Crear colección';

    modal.style.display = 'flex';
    setTimeout(() => document.getElementById('pv-coll-name').focus(), 30);
  }

  async function openAddToCollectionPicker(articleIds) {
    if (!articleIds || !articleIds.length) {
      alert('Selecciona al menos un artículo primero.');
      return;
    }
    let items = [];
    try {
      const r = await api('/collections');
      items = (r.items || []).filter(c => c.kind === 'manual');
    } catch (e) {
      alert('No se pudieron cargar las colecciones: ' + e.message);
      return;
    }
    if (!items.length) {
      if (!confirm('No tienes ninguna colección manual. ¿Crear una nueva ahora?')) return;
      document.getElementById('btn-new-collection')?.click();
      return;
    }
    const lines = items.map((c, i) => `  ${i+1}. ${c.name} (${c.article_count})`);
    const pick = prompt(
      `Elige una colección para añadir ${articleIds.length} artículo(s):\n\n` +
      lines.join('\n') + '\n\nEscribe el número:'
    );
    if (pick === null) return;
    const idx = parseInt(pick.trim(), 10) - 1;
    if (!Number.isFinite(idx) || idx < 0 || idx >= items.length) {
      alert('Selección inválida.');
      return;
    }
    const target = items[idx];
    try {
      const r = await api(`/collections/${target.id}/articles`, {
        method: 'POST',
        body: JSON.stringify({ ids: articleIds }),
      });
      refreshCollections();
      alert(`Añadidos ${r.added} a "${target.name}". ` +
            `${r.skipped} ya estaban dentro.`);
    } catch (e) {
      alert('Error: ' + e.message);
    }
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

  async function refreshTags() {
    try {
      const tags = await api('/tags');
      const container = document.getElementById('tag-list');
      const countSpan = document.getElementById('tag-count');
      container.innerHTML = '';
      if (countSpan) countSpan.textContent = tags.length > 0 ? `(${tags.length})` : '';
      tags.forEach(t => {
        const btn = document.createElement('button');
        btn.className = 'pv-nav-btn';
        btn.dataset.tagId = t.id;
        btn.title = IS_ADMIN
          ? '• Click: filtrar la lista\n• Click derecho: borrar este tag'
          : 'Click para filtrar la lista';
        btn.innerHTML = `
          <span style="display:inline-flex;align-items:center;gap:7px;min-width:0;overflow:hidden;">
            <span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${esc(t.color || '#9ca3af')}"></span>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(t.name)}</span>
          </span>
          <span style="font-size:10px;background:rgba(255,255,255,0.14);padding:1px 7px;border-radius:20px;flex-shrink:0;">${t.count}</span>
        `;
        btn.addEventListener('click', () => {
          state.tagId = state.tagId === t.id ? null : t.id;
          state.page = 1;
          loadArticles();
          highlightActiveTag();
          refreshFilterIndicators();
        });
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

  function highlightActiveTag() {
    document.querySelectorAll('#tag-list .pv-nav-btn').forEach(b => {
      const isActive = String(b.dataset.tagId) === String(state.tagId);
      b.style.background = isActive ? 'rgba(255,255,255,0.18)' : '';
      b.style.color      = isActive ? 'white' : '';
      b.style.fontWeight = isActive ? '600' : '';
    });
  }

  // ── render: article list ───────────────────────────────────────────────
  async function loadArticles() {
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
      const r = await api('/articles?' + params.toString());
      document.getElementById('pv-result-count').textContent =
        r.total + ' result' + (r.total === 1 ? '' : 's');
      document.getElementById('pv-result-page').textContent =
        'page ' + r.page + ' / ' + Math.max(1, Math.ceil(r.total / r.size));

      if (r.items.length === 0) {
        showEmpty('No articles match these filters.');
        renderPagination(r);
        return;
      }
      showTable();
      tbody.innerHTML = '';
      r.items.forEach(a => tbody.appendChild(renderRow(a)));
      state.lastTotal = r.total || 0;
      refreshSortHeaders();
      renderPagination(r);
      updateBulkBar();
      syncSelectAllHeader();
    } catch (e) {
      showEmpty('Error: ' + esc(e.message));
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

  function updateBulkBar() {
    const bars = ['pv-bulk-bar', 'pv-bulk-bar-top']
      .map(id => document.getElementById(id))
      .filter(Boolean);
    if (!bars.length) return;
    const count = state.selectedIds.size;
    const total = state.lastTotal || 0;
    const showFiltered = count > 0 && total > count;
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
    const r = await api('/articles?' + params.toString());
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
      </div>

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
      </button>

      <button id="pv-bulk-clear${s}" type="button"
              style="padding:4px 10px;border-radius:6px;background:transparent;color:white;
                     border:1px solid rgba(255,255,255,0.4);cursor:pointer;font-size:12px;">
        Limpiar
      </button>`;
  }

  const _BULK_SUFFIXES = ['', '-top'];

  function wireBulkBar() {
    if (!IS_ADMIN) return;
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

  // ── Build the list query params (shared by loadArticles + fetchAllFilteredIds) ──
  function buildListParams() {
    const params = new URLSearchParams();
    if (state.q)                   params.set('q', state.q);
    if (state.yearMin)             params.set('year_min', state.yearMin);
    if (state.yearMax)             params.set('year_max', state.yearMax);
    if (state.journal)             params.set('journal', state.journal);
    if (state.authors)             params.set('authors', state.authors);
    if (state.tagId)               params.set('tag', state.tagId);
    if (state.hasSummary)          params.set('has_summary', state.hasSummary);
    if (state.inPrionread !== null) params.set('in_prionread', state.inPrionread ? '1' : '0');
    if (state.isFlagged    !== null) params.set('is_flagged',   state.isFlagged    ? '1' : '0');
    if (state.isMilestone  !== null) params.set('is_milestone', state.isMilestone  ? '1' : '0');
    if (state.colorLabel)          params.set('color_label', state.colorLabel);
    if (state.priorityEq)          params.set('priority_eq', state.priorityEq);
    if (state.extraction)          params.set('extraction_status', state.extraction);
    if (state.isFavorite !== null) params.set('is_favorite', state.isFavorite ? '1' : '0');
    if (state.isRead     !== null) params.set('is_read',     state.isRead     ? '1' : '0');
    if (state.collectionId)        params.set('collection', state.collectionId);
    if (state.collectionGroup)     params.set('collection_group', state.collectionGroup);
    if (state.collectionSubgroup)  params.set('collection_subgroup', state.collectionSubgroup);
    if (state.hasJc !== null)      params.set('has_jc', state.hasJc ? '1' : '0');
    if (state.jcPresenter)         params.set('jc_presenter', state.jcPresenter);
    if (state.jcYear)              params.set('jc_year', state.jcYear);
    if (state.hasPp !== null)      params.set('has_pp', state.hasPp ? '1' : '0');
    if (state.ppId)                params.set('pp_id', state.ppId);
    if (state.abstractStatus)      params.set('abstract_status', state.abstractStatus);
    if (state.indexedStatus)       params.set('indexed_status', state.indexedStatus);
    if (state.sort)                params.set('sort', state.sort);
    params.set('page', state.page);
    params.set('size', state.size);
    return params;
  }

  // Inline SVG flag icon mirroring PrionRead's FlagIcon (small staff + triangle).
  const FLAG_SVG = (active) => `
    <svg viewBox="0 0 10 13" width="13" height="13" style="display:block;"
         fill="${active ? 'currentColor' : 'none'}"
         stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <line x1="1.5" y1="0.5" x2="1.5" y2="12.5"></line>
      <path d="M1.5 1 L9 3.5 L1.5 7 Z"></path>
    </svg>`;

  function renderRow(a) {
    const row = document.createElement('tr');
    row.className = 'pv-article-row';
    // Cursor lives on the two clickable cells (Article + Year), not on
    // the whole row — clicking the left-side mark buttons or the
    // right-side action chips used to fire openDetail by accident.
    row.style.cssText = 'border-bottom:1px solid #f3f4f6;transition:background 0.1s;';
    row.addEventListener('mouseenter', () => { row.style.background = '#fafafa'; });
    row.addEventListener('mouseleave', () => { row.style.background = ''; });

    // ── tags + badges (rendered inside the Article cell) ─────────────────
    const tags = (a.tags || []).slice(0, 4).map(t =>
      `<span style="display:inline-flex;padding:1px 8px;border-radius:20px;font-size:11px;font-weight:500;
                    ${t.color ? `background:${esc(t.color)}18;color:${esc(t.color)};` : 'background:#eef2ff;color:#4f46e5;'}"
            >${esc(t.name)}</span>`
    ).join('');

    const ratingChip = (a.avg_rating != null && a.rating_count > 0)
      ? `<span title="Rating medio ${a.avg_rating.toFixed(1)}/5 · ${a.rating_count} valoración${a.rating_count === 1 ? '' : 'es'}${a.my_rating ? ' · tu rating: ' + a.my_rating + '/5' : ''}"
              style="display:inline-flex;align-items:center;gap:2px;padding:1px 6px;border-radius:4px;
                     font-size:10.5px;font-weight:600;background:#fef3c7;color:#92400e;">
           <span style="color:#f59e0b;">★</span>${a.avg_rating.toFixed(1)}
           <span style="color:#b45309;opacity:0.75;font-weight:500;">(${a.rating_count})</span>
         </span>`
      : '';

    const badges = [
      IS_ADMIN
        ? `<button type="button" class="pv-edit-row-btn" data-aid="${esc(a.id)}"
                    title="Editar artículo"
                    style="display:inline-flex;align-items:center;gap:2px;padding:1px 6px;border-radius:4px;
                           font-size:10.5px;font-weight:600;background:#ede9fe;color:#6d28d9;
                           border:none;cursor:pointer;line-height:1.2;">✏ Editar</button>`
        : '',
      a.has_summary_ai
        ? '<span style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#dbeafe;color:#1d4ed8;">AI ✓</span>'
        : '',
      a.indexed_at
        ? '<span style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#dcfce7;color:#15803d;">indexed</span>'
        : '',
      a.pubmed_id
        ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${esc(a.pubmed_id)}/"
              target="_blank" rel="noopener"
              onclick="event.stopPropagation();"
              title="Abrir en PubMed (PMID ${esc(a.pubmed_id)})"
              style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#dbeafe;color:#1d4ed8;text-decoration:none;">PMID ↗</a>`
        : '',
      a.pdf_is_scan
        ? '<span title="El PDF era una imagen escaneada; el texto se ha recuperado con OCR." style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#fef3c7;color:#92400e;">📸 OCR</span>'
        : '',
      (!a.has_abstract && a.abstract_unavailable)
        ? '<span title="Buscado en CrossRef / PubMed: no hay abstract disponible para este artículo." style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#e5e7eb;color:#6b7280;">📕 sin abstract (confirmado)</span>'
        : (!a.has_abstract && (a.doi || a.pubmed_id))
          ? `<button type="button" class="pv-fetch-abstract-btn" data-aid="${esc(a.id)}"
                     title="Buscar abstract en CrossRef / PubMed"
                     style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#fef3c7;color:#92400e;border:none;cursor:pointer;">⬇ Abstract</button>`
          : '',
      a.has_jc
        ? `<span title="${a.jc_count > 1
              ? esc(a.jc_count + ' presentaciones en Journal Club')
              : 'Presentado en Journal Club'}"
                style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#fce7f3;color:#be185d;">JC${a.jc_count > 1 ? ' ' + a.jc_count : ''}</span>`
        : '',
      (a.prionpacks && a.prionpacks.length)
        ? `<a href="/prionpacks/index?open=${esc(a.prionpacks[0].id)}"
              target="_blank" rel="noopener"
              onclick="event.stopPropagation();"
              title="${esc('En PrionPack:\n' + a.prionpacks.map(p => `${p.id} — ${p.title}`).join('\n') + (a.prionpacks.length > 1 ? '\n\n(Abre el primero; pulsa cada uno en el tooltip si quieres otro)' : ''))}"
              style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#ede9fe;color:#6d28d9;text-decoration:none;">📦 ${esc(a.prionpacks[0].id)}${a.prionpacks.length > 1 ? ' +' + (a.prionpacks.length - 1) : ''}</a>`
        : '',
      ratingChip,
    ].filter(Boolean).join('');

    const authors = a.authors ? esc(a.authors) : '—';
    const journal = a.journal ? ` · ${esc(a.journal)}` : '';

    // ── Select cell: bulk-selection checkbox (admin only) ────────────────
    const selectCell = IS_ADMIN
      ? `<td style="padding:8px 6px 8px 12px;vertical-align:middle;text-align:center;width:32px;">
           <input type="checkbox" class="pv-row-select" data-aid="${esc(a.id)}"
                  ${state.selectedIds.has(a.id) ? 'checked' : ''}
                  onclick="event.stopPropagation();"
                  style="cursor:pointer;width:14px;height:14px;">
         </td>`
      : '';

    // ── Marks cell: flag + color dot + milestone (vertical stack) ────────
    const colorCss = a.color_label ? (COLOR_CSS[a.color_label] || '#9ca3af') : null;
    const flagColor = a.is_flagged ? '#e11d48' : '#e5e7eb';
    const flagTitle = a.is_flagged ? 'Marcada 🚩 — clic para quitar' : 'Marcar bandera';
    const milestoneColor = a.is_milestone ? '#f59e0b' : '#d1d5db';
    const colorTitle = a.color_label ? `Etiqueta: ${esc(a.color_label)}` : 'Sin etiqueta de color';

    const favColor  = a.is_favorite ? '#e11d48' : '#d1d5db';
    const readColor = a.is_read     ? '#15803d' : '#d1d5db';

    const marksCell = `
      <td style="padding:8px 8px;vertical-align:middle;text-align:center;">
        <div style="display:flex;align-items:center;justify-content:center;gap:6px;">
          <button class="pv-flag-btn"
                  data-active="${a.is_flagged ? '1' : '0'}"
                  title="${flagTitle}"
                  style="background:none;border:none;padding:0;line-height:0;
                         cursor:${IS_ADMIN ? 'pointer' : 'default'};color:${flagColor};">${FLAG_SVG(a.is_flagged)}</button>
          <span class="pv-color-dot"
                title="${colorTitle}"
                style="width:11px;height:11px;border-radius:50%;flex-shrink:0;cursor:${IS_ADMIN ? 'pointer' : 'default'};
                       ${colorCss ? `background:${colorCss};` : 'background:transparent;border:1.5px dashed #d1d5db;'}"></span>
          <button class="pv-milestone-btn"
                  data-active="${a.is_milestone ? '1' : '0'}"
                  title="${a.is_milestone ? 'Hito ★ — clic para quitar' : 'Marcar como hito'}"
                  style="background:none;border:none;padding:0;font-size:15px;line-height:1;
                         cursor:${IS_ADMIN ? 'pointer' : 'default'};color:${milestoneColor};">${a.is_milestone ? '★' : '☆'}</button>
          <span style="width:1px;height:14px;background:#e5e7eb;"></span>
          <button class="pv-favorite-btn"
                  data-active="${a.is_favorite ? '1' : '0'}"
                  title="${a.is_favorite ? 'Quitar de mis favoritos' : 'Añadir a mis favoritos'}"
                  style="background:none;border:none;padding:0;font-size:14px;line-height:1;cursor:pointer;
                         color:${favColor};">${a.is_favorite ? '♥' : '♡'}</button>
          <button class="pv-read-btn"
                  data-active="${a.is_read ? '1' : '0'}"
                  title="${a.is_read ? 'Marcar como no leído' : 'Marcar como leído por mí'}"
                  style="background:none;border:none;padding:0;font-size:13px;line-height:1;cursor:pointer;
                         color:${readColor};font-weight:700;">✓</button>
        </div>
      </td>`;

    // ── Article cell: title, authors+journal, tags+badges ────────────────
    const titleTooltip = [
      a.title,
      a.authors,
      a.journal && `${a.journal}${a.year ? ' · ' + a.year : ''}`,
    ].filter(Boolean).join('\n');

    const articleCell = `
      <td class="pv-row-open" style="padding:8px 12px;vertical-align:middle;max-width:520px;cursor:pointer;">
        <div style="font-size:14px;font-weight:600;color:#111827;line-height:1.35;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
             title="${esc(titleTooltip)}">${supHtml(a.title || '(no title)')}</div>
        <div style="margin-top:2px;font-size:12px;color:#6b7280;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${authors}${journal}</div>
        ${(tags || badges) ? `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:4px;">${badges}${tags}</div>` : ''}
      </td>`;

    // ── Year cell ────────────────────────────────────────────────────────
    const yearCell = `
      <td class="pv-row-open" style="padding:8px 8px;vertical-align:middle;font-size:13px;color:#374151;
                 font-variant-numeric:tabular-nums;cursor:pointer;">${a.year ? a.year : '—'}</td>`;

    // ── Pages cell ───────────────────────────────────────────────────────
    const pagesCell = a.pdf_pages
      ? `<td style="padding:8px 8px;vertical-align:middle;text-align:center;font-size:12px;color:#374151;">
           <span style="display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:5px;
                        background:#f3f4f6;font-variant-numeric:tabular-nums;">📄 ${a.pdf_pages}</span>
         </td>`
      : `<td style="padding:8px 8px;vertical-align:middle;text-align:center;color:#d1d5db;font-size:12px;">—</td>`;

    // ── Priority cell ────────────────────────────────────────────────────
    const prio = a.priority || 3;
    const prioStyle = prio >= 5 ? 'background:#fee2e2;color:#b91c1c;'
                    : prio === 4 ? 'background:#fef3c7;color:#92400e;'
                    : prio === 3 ? 'background:#e0f2fe;color:#075985;'
                    : prio === 2 ? 'background:#f3f4f6;color:#4b5563;'
                                 : 'background:#e5e7eb;color:#6b7280;';
    const priorityCell = `
      <td style="padding:8px 8px;vertical-align:middle;text-align:center;">
        <span class="pv-priority-chip"
              title="Prioridad ${prio}/5${IS_ADMIN ? ' — clic para cambiar' : ''}"
              style="display:inline-flex;align-items:center;justify-content:center;
                     min-width:24px;height:20px;padding:0 6px;border-radius:5px;
                     font-size:11px;font-weight:700;cursor:${IS_ADMIN ? 'pointer' : 'default'};
                     ${prioStyle}">P${prio}</span>
      </td>`;

    // ── Links cell: PDF (Dropbox), DOI, PMID ─────────────────────────────
    const pillLink = (href, label, bg, fg, title) => href
      ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"
             title="${esc(title)}" onclick="event.stopPropagation();"
             style="display:inline-flex;align-items:center;padding:1px 6px;border-radius:5px;
                    font-size:10.5px;font-weight:600;text-decoration:none;background:${bg};color:${fg};">${label}</a>`
      : '';

    const hasPdf = !!(a.has_pdf || a.pdf_dropbox_path);
    const pdfLink = hasPdf
      ? `<button type="button" class="pv-pdf-pill"
                 title="PDF disponible — clic para abrir el visor"
                 style="display:inline-flex;align-items:center;padding:1px 6px;border-radius:5px;
                        font-size:10.5px;font-weight:600;background:#fee2e2;color:#b91c1c;
                        border:none;cursor:pointer;">PDF</button>`
      : '<span title="Sin PDF" style="display:inline-flex;align-items:center;padding:1px 6px;border-radius:5px;font-size:10.5px;font-weight:600;background:#f3f4f6;color:#9ca3af;">PDF</span>';

    const doiLink = pillLink(a.doi ? `https://doi.org/${a.doi}` : null, 'DOI', '#e0e7ff', '#3730a3', 'Abrir DOI');
    const pmidLink = pillLink(a.pubmed_id ? `https://pubmed.ncbi.nlm.nih.gov/${a.pubmed_id}/` : null,
                              'PMID', '#ccfbf1', '#0f766e', 'Abrir PubMed');

    const linksCell = `
      <td style="padding:8px 8px;vertical-align:middle;">
        <div style="display:flex;flex-wrap:wrap;gap:3px;">${pdfLink}${doiLink}${pmidLink}</div>
      </td>`;

    // ── Asignado cell: read-only count + open-in-PrionRead button ───────
    const assignedCount = a.prionread_count || 0;
    const assignedStatus = a.in_prionread
      ? `<span title="${assignedCount} estudiante${assignedCount === 1 ? '' : 's'} con este artículo asignado"
              style="display:inline-flex;align-items:center;gap:3px;font-size:12px;font-weight:600;color:#0F3460;">
           ✓ <span style="color:#6b7280;font-weight:500;">(${assignedCount})</span>
         </span>`
      : `<span title="Ningún estudiante tiene este artículo asignado"
              style="display:inline-flex;align-items:center;font-size:13px;color:#d1d5db;">—</span>`;

    const prionreadCell = `
      <td style="padding:8px 8px;vertical-align:middle;text-align:center;">
        <div style="display:inline-flex;align-items:center;gap:8px;">
          ${assignedStatus}
          <button class="pv-open-prionread-btn"
                  data-aid="${esc(a.id)}"
                  title="Abrir este artículo en PrionRead admin ↗"
                  style="background:none;border:none;padding:2px 4px;cursor:pointer;
                         font-size:13px;color:#6b7280;line-height:1;border-radius:4px;"
                  onmouseover="this.style.background='#f3f4f6';this.style.color='#0F3460';"
                  onmouseout="this.style.background='none';this.style.color='#6b7280';">↗</button>
        </div>
      </td>`;

    row.innerHTML = selectCell + marksCell + articleCell + yearCell + pagesCell +
                    priorityCell + linksCell + prionreadCell;

    // Wire the row-level checkbox
    const cb = row.querySelector('.pv-row-select');
    if (cb) {
      cb.addEventListener('click', e => {
        e.stopPropagation();
        if (cb.checked) state.selectedIds.add(a.id);
        else            state.selectedIds.delete(a.id);
        updateBulkBar();
        syncSelectAllHeader();
      });
    }

    // ── Wiring ──────────────────────────────────────────────────────────
    row.querySelector('.pv-open-prionread-btn').addEventListener('click', e => {
      e.stopPropagation();
      window.open(`/prionread/admin/articles?open=${encodeURIComponent(a.id)}`,
                  '_blank', 'noopener');
    });

    const pdfPill = row.querySelector('.pv-pdf-pill');
    if (pdfPill) pdfPill.addEventListener('click', e => {
      e.stopPropagation();
      openDetail(a.id, { openPdf: true });
    });

    row.querySelector('.pv-favorite-btn').addEventListener('click', async e => {
      e.stopPropagation();
      const btn = e.currentTarget;
      const next = btn.dataset.active !== '1';
      btn.disabled = true;
      try {
        const r = await api(`/articles/${a.id}/favorite`, {
          method: 'POST',
          body: JSON.stringify({ value: next }),
        });
        a.is_favorite = !!r.is_favorite;
        replaceRow(row, a);
      } catch (err) {
        btn.disabled = false;
        alert('Error: ' + err.message);
      }
    });

    row.querySelector('.pv-read-btn').addEventListener('click', async e => {
      e.stopPropagation();
      const btn = e.currentTarget;
      const next = btn.dataset.active !== '1';
      btn.disabled = true;
      try {
        const r = await api(`/articles/${a.id}/read`, {
          method: 'POST',
          body: JSON.stringify({ value: next }),
        });
        a.is_read = !!r.is_read;
        a.read_at = r.read_at || null;
        replaceRow(row, a);
      } catch (err) {
        btn.disabled = false;
        alert('Error: ' + err.message);
      }
    });

    if (IS_ADMIN) {
      row.querySelector('.pv-milestone-btn').addEventListener('click', e => {
        e.stopPropagation();
        const next = e.currentTarget.dataset.active !== '1';
        patchArticleInline(a, { is_milestone: next }, () => {
          a.is_milestone = next;
          if (next) a.priority = 5;
          replaceRow(row, a);
        });
      });

      row.querySelector('.pv-flag-btn').addEventListener('click', e => {
        e.stopPropagation();
        const next = e.currentTarget.dataset.active !== '1';
        patchArticleInline(a, { is_flagged: next }, () => {
          a.is_flagged = next;
          replaceRow(row, a);
        });
      });

      row.querySelector('.pv-color-dot').addEventListener('click', e => {
        e.stopPropagation();
        openColorPopover(e.currentTarget, a, () => replaceRow(row, a));
      });

      const fetchAbsBtn = row.querySelector('.pv-fetch-abstract-btn');
      if (fetchAbsBtn) fetchAbsBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        fetchAbsBtn.disabled = true;
        const original = fetchAbsBtn.innerHTML;
        fetchAbsBtn.innerHTML = '⏳ Buscando…';
        try {
          const r = await api(`/articles/${a.id}/fetch-abstract`,
                              { method: 'POST' });
          if (r.ok && r.abstract) {
            a.abstract = r.abstract;
            a.has_abstract = true;
            a.abstract_unavailable = false;
            if (r.pubmed_id && !a.pubmed_id) a.pubmed_id = r.pubmed_id;
            replaceRow(row, a);
          } else if (r.status === 'unavailable') {
            a.has_abstract = false;
            a.abstract_unavailable = true;
            if (r.pubmed_id && !a.pubmed_id) a.pubmed_id = r.pubmed_id;
            replaceRow(row, a);
          }
        } catch (err) {
          alert('No se pudo buscar el abstract: ' + err.message);
          fetchAbsBtn.disabled = false;
          fetchAbsBtn.innerHTML = original;
        }
      });

      const prChip = row.querySelector('.pv-priority-chip');
      if (prChip) prChip.addEventListener('click', e => {
        e.stopPropagation();
        openPriorityPopover(e.currentTarget, a, () => replaceRow(row, a));
      });

      const editBtn = row.querySelector('.pv-edit-row-btn');
      if (editBtn) editBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        editBtn.disabled = true;
        try {
          // Pull a fresh copy so the modal sees the latest fields
          // (abstract, dropbox_path, etc.) the list view doesn't carry.
          const fresh = await api(`/articles/${a.id}`);
          openEditModal(fresh);
        } catch (err) {
          alert('No se pudo abrir el editor: ' + err.message);
        } finally {
          editBtn.disabled = false;
        }
      });
    }

    // Only the Article + Year cells open the detail modal — chips and
    // mark buttons in other cells used to swallow stray clicks via
    // stopPropagation, but that's brittle. Scoping the listener to
    // .pv-row-open is the simpler invariant.
    row.addEventListener('click', (e) => {
      if (e.target.closest('.pv-row-open')) openDetail(a.id);
    });
    return row;
  }

  function replaceRow(oldNode, article) {
    const fresh = renderRow(article);
    oldNode.replaceWith(fresh);
  }

  function refreshSortHeaders() {
    document.querySelectorAll('.pv-sort-th').forEach(th => {
      const col = th.dataset.sortCol;
      const label = col.charAt(0).toUpperCase() + col.slice(1);
      let arrow = '';
      if (col === 'title' && state.sort === 'title_asc') arrow = ' ▲';
      else if (col === 'year' && state.sort === 'year_desc') arrow = ' ▼';
      else if (col === 'year' && state.sort === 'year_asc')  arrow = ' ▲';
      th.textContent = label + arrow;
      th.style.color = arrow ? '#111827' : '#6b7280';
    });
  }

  async function patchArticleInline(a, patch, onOk) {
    try {
      await api(`/articles/${a.id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      onOk && onOk();
    } catch (e) {
      console.error('patchArticleInline failed', e);
      alert('No se pudo guardar el cambio: ' + e.message);
    }
  }

  let _popoverEl = null;
  function closePopover() {
    if (_popoverEl) { _popoverEl.remove(); _popoverEl = null; }
    document.removeEventListener('click', closePopoverOnOutside, true);
  }
  function closePopoverOnOutside(e) {
    if (_popoverEl && !_popoverEl.contains(e.target)) closePopover();
  }
  function openPopoverAt(anchor) {
    closePopover();
    const r = anchor.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.style.cssText =
      'position:fixed;z-index:1000;background:white;border:1px solid #e5e7eb;border-radius:10px;' +
      'box-shadow:0 4px 14px rgba(0,0,0,0.12);padding:8px;display:flex;gap:6px;align-items:center;';
    pop.style.top  = (r.bottom + 6) + 'px';
    pop.style.left = (r.left) + 'px';
    document.body.appendChild(pop);
    _popoverEl = pop;
    setTimeout(() => document.addEventListener('click', closePopoverOnOutside, true), 0);
    return pop;
  }

  function openColorPopover(anchor, a, onChange) {
    const pop = openPopoverAt(anchor);
    const mkSwatch = (value, css) => {
      const b = document.createElement('button');
      const selected = (a.color_label || null) === value;
      b.style.cssText =
        `width:22px;height:22px;border-radius:50%;border:2px solid ${selected ? '#111827' : 'transparent'};` +
        `cursor:pointer;${css ? `background:${css};` : 'background:transparent;border-style:dashed;border-color:#9ca3af;'}`;
      b.title = value || 'Sin etiqueta';
      b.addEventListener('click', async () => {
        await patchArticleInline(a, { color_label: value }, () => {
          a.color_label = value;
          onChange && onChange();
        });
        closePopover();
      });
      return b;
    };
    pop.appendChild(mkSwatch(null, null));
    COLOR_LABELS.forEach(c => pop.appendChild(mkSwatch(c.value, c.css)));
  }

  function openPriorityPopover(anchor, a, onChange) {
    const pop = openPopoverAt(anchor);
    [1, 2, 3, 4, 5].forEach(p => {
      const b = document.createElement('button');
      const isCur = (a.priority || 3) === p;
      b.textContent = 'P' + p;
      b.style.cssText =
        'min-width:30px;padding:4px 8px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;' +
        (isCur ? 'background:#0F3460;color:white;border:1px solid #0F3460;'
               : 'background:white;color:#374151;border:1px solid #e5e7eb;');
      b.addEventListener('click', async () => {
        await patchArticleInline(a, { priority: p }, () => {
          a.priority = p;
          onChange && onChange();
        });
        closePopover();
      });
      pop.appendChild(b);
    });
  }

  function renderPagination({ total, page, size }) {
    const pages = Math.max(1, Math.ceil(total / size));
    const wrap  = document.getElementById('pv-pagination');
    wrap.innerHTML = '';
    if (pages <= 1) return;

    const mk = (label, p, current = false, disabled = false) => {
      const b = document.createElement('button');
      b.textContent = label;
      const base = 'padding:6px 10px;font-size:13px;border-radius:8px;border:1px solid;cursor:pointer;transition:all 0.1s;';
      if (current) {
        b.style.cssText = base + 'background:#0F3460;color:white;border-color:#0F3460;';
      } else if (disabled) {
        b.style.cssText = base + 'background:#f9fafb;color:#d1d5db;border-color:#e5e7eb;cursor:not-allowed;';
        b.disabled = true;
      } else {
        b.style.cssText = base + 'background:white;color:#374151;border-color:#e5e7eb;';
        b.addEventListener('mouseenter', () => { b.style.background = '#f3f4f6'; });
        b.addEventListener('mouseleave', () => { b.style.background = 'white'; });
        b.addEventListener('click', () => { state.page = p; loadArticles(); });
      }
      return b;
    };

    wrap.appendChild(mk('◀', page - 1, false, page <= 1));
    const start = Math.max(1, page - 3);
    const end   = Math.min(pages, page + 3);
    if (start > 1) wrap.appendChild(mk('1', 1, page === 1));
    if (start > 2) wrap.appendChild(mk('…', start, false, true));
    for (let i = start; i <= end; i++) wrap.appendChild(mk(String(i), i, i === page));
    if (end < pages - 1) wrap.appendChild(mk('…', end, false, true));
    if (end < pages) wrap.appendChild(mk(String(pages), pages, page === pages));
    wrap.appendChild(mk('▶', page + 1, false, page >= pages));
  }

  // ── article detail modal ───────────────────────────────────────────────
  async function openDetail(aid, options = {}) {
    const modal   = document.getElementById('pv-detail-modal');
    const content = document.getElementById('pv-detail-content');
    _pdfViewerOpen = !!options.openPdf;
    const inner = modal.querySelector('.pv-modal-inner');
    if (inner) inner.style.maxWidth = '';
    modal.style.display = 'flex';
    content.innerHTML = '<div style="text-align:center;padding:40px;color:#9ca3af;">Cargando…</div>';
    try {
      const a = await api('/articles/' + aid);

      const tagHtml = (a.tags && a.tags.length)
        ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:16px;">
            ${a.tags.map(t =>
              `<span style="padding:3px 10px;border-radius:20px;font-size:12px;font-weight:500;
                            ${t.color ? `background:${esc(t.color)}18;color:${esc(t.color)};` : 'background:#eef2ff;color:#4f46e5;'}"
                    >${esc(t.name)}</span>`
            ).join('')}
           </div>`
        : '';

      const prionreadBadge = a.in_prionread
        ? `<span title="${a.prionread_count} estudiante${a.prionread_count !== 1 ? 's' : ''} asignado${a.prionread_count !== 1 ? 's' : ''}"
                 style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;
                        font-size:12px;font-weight:600;background:#d1fae5;color:#065f46;border:1px solid #6ee7b7;
                        margin-bottom:12px;">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;">
              <circle cx="8" cy="8" r="6.5" stroke="#065f46" stroke-width="1.5"/>
              <path d="M5 8.5l2 2 4-4" stroke="#065f46" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            En PrionRead · ${a.prionread_count} estudiante${a.prionread_count !== 1 ? 's' : ''}
           </span>`
        : `<span title="Este artículo no está asignado en PrionRead"
                 style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;
                        font-size:12px;font-weight:600;background:#f3f4f6;color:#6b7280;border:1px solid #d1d5db;
                        margin-bottom:12px;">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;">
              <circle cx="8" cy="8" r="6.5" stroke="#9ca3af" stroke-width="1.5"/>
              <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#9ca3af" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            No asignado en PrionRead
           </span>`;

      const personalChips = `
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px;align-items:center;">
          <button id="pv-detail-fav" type="button"
                  data-active="${a.is_favorite ? '1' : '0'}"
                  style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;
                         font-size:12px;font-weight:600;cursor:pointer;
                         ${a.is_favorite
                           ? 'background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;'
                           : 'background:#f9fafb;color:#6b7280;border:1px solid #e5e7eb;'}">
            <span style="font-size:14px;line-height:1;color:${a.is_favorite ? '#e11d48' : '#9ca3af'};">${a.is_favorite ? '♥' : '♡'}</span>
            ${a.is_favorite ? 'En favoritos' : 'Añadir a favoritos'}
          </button>
          <button id="pv-detail-read" type="button"
                  data-active="${a.is_read ? '1' : '0'}"
                  style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;
                         font-size:12px;font-weight:600;cursor:pointer;
                         ${a.is_read
                           ? 'background:#dcfce7;color:#15803d;border:1px solid #86efac;'
                           : 'background:#f9fafb;color:#6b7280;border:1px solid #e5e7eb;'}">
            <span style="font-size:13px;font-weight:800;line-height:1;color:${a.is_read ? '#15803d' : '#9ca3af'};">✓</span>
            ${a.is_read ? 'Leído por mí' : 'Marcar como leído'}
          </button>
        </div>`;

      content.innerHTML = `
        <h2 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#111827;line-height:1.35;padding-right:24px;">
          ${supHtml(a.title)}
        </h2>
        ${prionreadBadge}
        ${personalChips}
        <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-size:14px;color:#6b7280;margin-bottom:16px;">
          ${a.authors ? esc(a.authors) : '—'}
          ${a.journal ? `<span style="margin:0 4px;color:#d1d5db;">·</span>${esc(a.journal)}` : ''}
          ${a.year    ? `<span style="margin:0 4px;color:#d1d5db;">·</span>${a.year}` : ''}
          ${a.doi     ? `<span style="margin:0 4px;color:#d1d5db;">·</span>
                         <a href="https://doi.org/${esc(a.doi)}" target="_blank" rel="noopener"
                            style="color:#0F3460;text-decoration:none;">${esc(a.doi)}</a>` : ''}
          ${a.pubmed_id ? `<span style="margin:0 4px;color:#d1d5db;">·</span>
                           <a href="https://pubmed.ncbi.nlm.nih.gov/${esc(a.pubmed_id)}/"
                              target="_blank" rel="noopener"
                              title="Abrir en PubMed (útil para copiar el abstract a mano si la descarga falla)"
                              style="color:#0F3460;text-decoration:none;font-weight:600;">
                              PMID ${esc(a.pubmed_id)} ↗
                           </a>` : ''}
        </div>
        ${a.abstract ? `
          <h3 style="font-size:14px;font-weight:600;color:#374151;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.05em;">Abstract</h3>
          <p style="font-size:14px;color:#4b5563;line-height:1.65;margin:0 0 16px;">${supHtml(a.abstract)}</p>
        ` : ''}
        <div id="pv-ai-summary-block" style="margin:0 0 16px;"></div>
        ${a.summary_human ? `
          <h3 style="font-size:14px;font-weight:600;color:#374151;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.05em;">Human notes</h3>
          <p style="font-size:14px;color:#4b5563;line-height:1.65;margin:0 0 16px;">${supHtml(a.summary_human)}</p>
        ` : ''}
        ${a.has_pdf ? `
          <div id="pv-pdf-toolbar" style="margin:0 0 14px;display:flex;align-items:center;gap:8px;">
            <button id="pv-pdf-toggle" type="button"
                    style="padding:6px 12px;border-radius:7px;border:1px solid #d1d5db;background:white;
                           font-size:13px;font-weight:600;color:#374151;cursor:pointer;
                           display:inline-flex;align-items:center;gap:6px;">
              <i class="fas fa-file-pdf" style="color:#b91c1c;"></i>
              <span id="pv-pdf-toggle-label">Ver PDF</span>
            </button>
            <a href="/prionvault/api/articles/${esc(a.id)}/pdf" target="_blank" rel="noopener noreferrer"
               title="Abrir el PDF en pestaña nueva"
               style="font-size:12px;color:#0F3460;text-decoration:none;">
              <i class="fas fa-up-right-from-square" style="margin-right:3px;"></i>nueva pestaña
            </a>
          </div>
          <div id="pv-pdf-viewer" style="display:none;margin:0 0 16px;
                                          border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;
                                          background:#1f2937;"></div>
        ` : (IS_ADMIN && a.doi ? `
          <div id="pv-unpaywall-toolbar" style="margin:0 0 14px;display:flex;align-items:center;gap:8px;">
            <button id="pv-unpaywall-btn" type="button"
                    style="padding:6px 12px;border-radius:7px;border:1px solid #d1d5db;background:white;
                           font-size:13px;font-weight:600;color:#374151;cursor:pointer;
                           display:inline-flex;align-items:center;gap:6px;">
              <i class="fas fa-cloud-arrow-down" style="color:#0F3460;"></i>
              <span>Try Unpaywall</span>
            </button>
            <span id="pv-unpaywall-status" style="font-size:12px;color:#6b7280;"></span>
          </div>
        ` : '')}
        ${tagHtml}
        <div id="pv-tag-picker-section" style="margin-top:22px;padding-top:14px;border-top:1px solid #f3f4f6;"></div>
        <div id="pv-ratings-section" style="margin-top:22px;padding-top:14px;border-top:1px solid #f3f4f6;"></div>
        <div id="pv-similar-section" style="margin-top:18px;padding-top:14px;border-top:1px solid #f3f4f6;"></div>
        <div id="pv-supplementary-section" style="margin-top:18px;padding-top:14px;border-top:1px solid #f3f4f6;"></div>
        <div id="pv-jc-section" style="margin-top:18px;padding-top:14px;border-top:1px solid #f3f4f6;"></div>
        <div id="pv-used-in-section" style="margin-top:18px;padding-top:14px;border-top:1px solid #f3f4f6;"></div>
        <div style="margin-top:18px;padding-top:14px;border-top:1px solid #f3f4f6;
                    display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
          <button id="pv-add-to-pack-btn" type="button"
                  style="padding:7px 14px;border-radius:8px;border:1px solid #d1d5db;background:white;
                         font-size:13px;font-weight:600;color:#0F3460;cursor:pointer;
                         display:inline-flex;align-items:center;gap:6px;">
            <i class="fas fa-cubes-stacked"></i>
            <span>Añadir a PrionPack</span>
          </button>
          ${IS_ADMIN ? `
            <button id="pv-edit-article-btn" type="button"
                    title="Editar campos del artículo (incluye reintento de CrossRef/PubMed con DOI o PMID corregidos)"
                    style="padding:7px 14px;border-radius:8px;border:1px solid #d1d5db;background:white;
                           font-size:13px;font-weight:600;color:#0F3460;cursor:pointer;
                           display:inline-flex;align-items:center;gap:6px;">
              <i class="fas fa-pen-to-square"></i>
              <span>Editar</span>
            </button>
            <button id="pv-delete-article-btn" type="button"
                    title="Eliminar este artículo y su PDF de Dropbox"
                    style="padding:7px 14px;border-radius:8px;border:1px solid #fecaca;background:white;
                           font-size:13px;font-weight:600;color:#b91c1c;cursor:pointer;
                           display:inline-flex;align-items:center;gap:6px;margin-left:auto;">
              <i class="fas fa-trash"></i>
              <span>Eliminar artículo</span>
            </button>` : ''}
        </div>
        <div style="margin-top:20px;padding-top:14px;border-top:1px solid #f3f4f6;
                    font-size:12px;color:#9ca3af;font-family:ui-monospace,monospace;">
          Added: ${a.added_at ? esc(a.added_at.slice(0, 10)) : '—'}
          · Status: ${esc(a.extraction_status || 'pending')}
          ${a.indexed_at ? ' · Indexed: ' + esc(a.indexed_at.slice(0, 10)) : ''}
        </div>
      `;
      renderRatingsSection(a);
      wirePdfViewer(a);
      wirePersonalState(a);
      renderAiSummary(a);
      wireUnpaywallButton(a);
      wireAddToPackButton(a);
      wireEditArticleButton(a);
      wireDeleteArticleButton(a);
      renderTagPickerSection(a);
      renderSimilarSection(a);
      renderSupplementarySection(a);
      renderJcSection(a);
      renderUsedInSection(a);
    } catch (e) {
      content.innerHTML = `<div style="color:#b91c1c;padding:20px;">Error: ${esc(e.message)}</div>`;
    }
  }

  // ── Ratings widget ────────────────────────────────────────────────────
  function starHtml(n, filled, clickable) {
    return Array.from({ length: 5 }, (_, i) => {
      const isFilled = i < n;
      return `<button type="button" class="${clickable ? 'pv-rate-star' : ''}" data-value="${i + 1}"
              ${clickable ? '' : 'disabled'}
              style="background:none;border:none;padding:0 1px;font-size:18px;line-height:1;
                     cursor:${clickable ? 'pointer' : 'default'};
                     color:${isFilled ? '#f59e0b' : '#d1d5db'};">★</button>`;
    }).join('');
  }

  function staticStars(n) {
    return Array.from({ length: 5 }, (_, i) =>
      `<span style="color:${i < n ? '#f59e0b' : '#d1d5db'};font-size:13px;">★</span>`
    ).join('');
  }

  function renderRatingsSection(a) {
    const sec = document.getElementById('pv-ratings-section');
    if (!sec) return;

    const ratings = a.ratings || [];
    const avg     = a.avg_rating;
    const count   = a.rating_count || 0;
    const myRating = a.my_rating || 0;
    const myItem   = ratings.find(r => r.is_own) || null;
    const others   = ratings.filter(r => !r.is_own);

    const avgHtml = (avg != null)
      ? `<div style="display:flex;align-items:center;gap:8px;">
           <span style="font-size:18px;font-weight:700;color:#f59e0b;font-variant-numeric:tabular-nums;">${avg.toFixed(1)}</span>
           <span>${staticStars(Math.round(avg))}</span>
           <span style="font-size:12px;color:#6b7280;">${count} rating${count === 1 ? '' : 's'}</span>
         </div>`
      : '<div style="font-size:13px;color:#9ca3af;">Sin valoraciones aún.</div>';

    sec.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <h3 style="margin:0;font-size:14px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:0.05em;">Ratings</h3>
        ${avgHtml}
      </div>

      <div id="pv-rate-me" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin-bottom:14px;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span style="font-size:12.5px;font-weight:600;color:#374151;">Tu valoración:</span>
          <span id="pv-rate-stars" style="display:inline-flex;">${starHtml(myRating, true, true)}</span>
          <span id="pv-rate-current" style="font-size:12px;color:#6b7280;">${myRating ? myRating + '/5' : 'sin valorar'}</span>
          ${myItem ? `<button id="pv-rate-delete" type="button"
                              style="margin-left:auto;background:none;border:none;color:#b91c1c;font-size:12px;cursor:pointer;">Borrar mi rating</button>` : ''}
        </div>
        <textarea id="pv-rate-comment" rows="2" placeholder="Comentario opcional (máx 500 caracteres)…"
                  maxlength="500"
                  style="margin-top:8px;width:100%;padding:6px 9px;border:1px solid #d1d5db;border-radius:6px;
                         font-size:13px;font-family:inherit;resize:vertical;">${esc(myItem?.comment || '')}</textarea>
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
          <button id="pv-rate-save" type="button" disabled
                  style="padding:5px 12px;border-radius:6px;border:none;background:#0F3460;color:white;
                         font-size:12.5px;font-weight:600;cursor:pointer;opacity:0.5;">Guardar</button>
          <span id="pv-rate-status" style="font-size:11.5px;color:#9ca3af;"></span>
        </div>
      </div>

      ${others.length ? `
        <div>
          <div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">Otras valoraciones</div>
          ${others.map(r => `
            <div style="display:flex;gap:10px;padding:8px 0;border-top:1px solid #f3f4f6;">
              ${r.user_photo
                ? `<img src="${esc(r.user_photo)}" alt="" style="width:28px;height:28px;border-radius:50%;flex-shrink:0;object-fit:cover;">`
                : `<div style="width:28px;height:28px;border-radius:50%;background:#e5e7eb;color:#6b7280;
                              display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;">
                     ${esc((r.user_name || '?').slice(0, 1).toUpperCase())}
                   </div>`}
              <div style="flex:1;min-width:0;">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                  <span style="font-size:12.5px;font-weight:600;color:#111827;">${esc(r.user_name)}</span>
                  <span>${staticStars(r.rating)}</span>
                  <span style="font-size:11px;color:#9ca3af;font-variant-numeric:tabular-nums;">
                    ${r.updated_at ? r.updated_at.slice(0, 10) : ''}
                  </span>
                </div>
                ${r.comment
                  ? `<p style="margin:3px 0 0;font-size:12.5px;color:#4b5563;line-height:1.5;">${esc(r.comment)}</p>`
                  : ''}
              </div>
            </div>`).join('')}
        </div>` : ''}
    `;

    // ── Wiring ───────────────────────────────────────────────────────────
    let selected = myRating;
    let originalComment = myItem?.comment || '';
    const starsEl  = sec.querySelector('#pv-rate-stars');
    const currentEl = sec.querySelector('#pv-rate-current');
    const commentEl = sec.querySelector('#pv-rate-comment');
    const saveBtn   = sec.querySelector('#pv-rate-save');
    const statusEl  = sec.querySelector('#pv-rate-status');

    function paintStars(value) {
      starsEl.innerHTML = starHtml(value, true, true);
      starsEl.querySelectorAll('.pv-rate-star').forEach(b => b.addEventListener('click', () => {
        const clicked = parseInt(b.dataset.value, 10);
        // Click on the same value that is already selected → clear it,
        // so the user can back out of a preview without saving.
        selected = (selected === clicked) ? 0 : clicked;
        paintStars(selected);
        currentEl.textContent = selected > 0 ? selected + '/5' : 'sin valorar';
        updateSaveState();
      }));
    }
    function updateSaveState() {
      const changed = (selected !== myRating) ||
                      ((commentEl.value || '') !== originalComment);
      const valid   = selected >= 1 && selected <= 5;
      saveBtn.disabled = !(changed && valid);
      saveBtn.style.opacity = saveBtn.disabled ? '0.5' : '1';
    }
    paintStars(selected);
    commentEl.addEventListener('input', updateSaveState);

    saveBtn.addEventListener('click', async () => {
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;
      statusEl.textContent = 'Guardando…';
      statusEl.style.color = '#6b7280';
      try {
        const r = await api(`/articles/${a.id}/ratings`, {
          method: 'POST',
          body: JSON.stringify({ rating: selected, comment: commentEl.value.trim() }),
        });
        // Refresh the section with new data without closing the modal.
        a.ratings      = r.ratings;
        a.avg_rating   = r.avg_rating;
        a.rating_count = r.total;
        a.my_rating    = selected;
        renderRatingsSection(a);
      } catch (e) {
        statusEl.textContent = 'Error: ' + e.message;
        statusEl.style.color = '#b91c1c';
        saveBtn.disabled = false;
      }
    });

    const delBtn = sec.querySelector('#pv-rate-delete');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!confirm('¿Borrar tu valoración para este artículo?')) return;
        delBtn.disabled = true;
        try {
          const r = await api(`/articles/${a.id}/ratings`, { method: 'DELETE' });
          a.ratings      = r.ratings;
          a.avg_rating   = r.avg_rating;
          a.rating_count = r.total;
          a.my_rating    = null;
          renderRatingsSection(a);
        } catch (e) {
          alert('Error al borrar: ' + e.message);
          delBtn.disabled = false;
        }
      });
    }
  }

  // ── PDF viewer (inline) ──────────────────────────────────────────────
  // Tracks whether the user explicitly opened the PDF for THIS modal
  // session, so re-rendering the ratings section doesn't lose it.
  let _pdfViewerOpen = false;
  function wirePdfViewer(a) {
    if (!a.has_pdf) return;
    const toggle  = document.getElementById('pv-pdf-toggle');
    const label   = document.getElementById('pv-pdf-toggle-label');
    const viewer  = document.getElementById('pv-pdf-viewer');
    const inner   = document.querySelector('#pv-detail-modal .pv-modal-inner');
    if (!toggle || !viewer) return;

    function setOpen(open) {
      _pdfViewerOpen = open;
      if (open) {
        if (!viewer.querySelector('iframe')) {
          viewer.innerHTML = `<iframe src="/prionvault/api/articles/${esc(a.id)}/pdf"
                                       style="display:block;width:100%;height:78vh;border:0;background:#1f2937;"
                                       title="PDF: ${esc(a.title || '')}"></iframe>`;
        }
        viewer.style.display = 'block';
        label.textContent = 'Ocultar PDF';
        if (inner) inner.style.maxWidth = '1100px';
      } else {
        viewer.style.display = 'none';
        label.textContent = 'Ver PDF';
        if (inner) inner.style.maxWidth = '';
      }
    }
    toggle.addEventListener('click', () => setOpen(!_pdfViewerOpen));
    // Honour the previously-open state when this is a re-render
    // triggered by a rating save/delete.
    if (_pdfViewerOpen) setOpen(true);
  }

  // ── Try Unpaywall (per-article) ──────────────────────────────────────
  function wireUnpaywallButton(a) {
    const btn = document.getElementById('pv-unpaywall-btn');
    const stEl = document.getElementById('pv-unpaywall-status');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const labelEl = btn.querySelector('span');
      const original = labelEl.textContent;
      labelEl.textContent = 'Consultando…';
      stEl.style.color = '#6b7280';
      stEl.textContent = '';
      try {
        const r = await api(`/articles/${a.id}/fetch-pdf`, { method: 'POST' });
        if (r.ok) {
          stEl.style.color = '#15803d';
          const sizeKb = Math.round((r.size_bytes || 0) / 1024);
          stEl.textContent = `✓ Encolado (${esc(r.host_type || 'OA')}, ${sizeKb} KB). El worker lo procesa en background.`;
          labelEl.textContent = 'Encolado';
        } else {
          stEl.style.color = '#b45309';
          if (r.is_oa && r.landing_url) {
            stEl.innerHTML = `⚠️ ${esc(r.reason || 'sin PDF directo')} · ` +
              `<a href="${esc(r.landing_url)}" target="_blank" rel="noopener noreferrer" style="color:#0F3460;">ver landing</a>`;
          } else {
            stEl.textContent = `⚠️ ${r.reason === 'not_open_access' ? 'No disponible en open access' : (r.reason || 'sin PDF')}`;
          }
          labelEl.textContent = original;
          btn.disabled = false;
        }
      } catch (e) {
        stEl.style.color = '#b91c1c';
        if (e.status === 503) {
          stEl.textContent = 'Unpaywall no disponible — falta UNPAYWALL_EMAIL en el servidor.';
        } else if (e.status === 409) {
          stEl.textContent = 'Este artículo ya tiene PDF.';
        } else {
          stEl.textContent = 'Error: ' + e.message;
        }
        labelEl.textContent = original;
        btn.disabled = false;
      }
    });
  }

  // ── Papers parecidos a este (vector neighbours) ──────────────────────
  async function renderSimilarSection(a) {
    const sec = document.getElementById('pv-similar-section');
    if (!sec) return;
    sec.innerHTML = `
      <h3 style="margin:0 0 8px;font-size:14px;font-weight:600;color:#374151;
                 text-transform:uppercase;letter-spacing:0.05em;">Papers parecidos</h3>
      <div style="font-size:12.5px;color:#9ca3af;">Buscando vecinos vectoriales…</div>`;

    let data;
    try {
      data = await api(`/articles/${a.id}/similar?limit=8`);
    } catch (e) {
      sec.innerHTML = `
        <h3 style="margin:0 0 8px;font-size:14px;font-weight:600;color:#374151;
                   text-transform:uppercase;letter-spacing:0.05em;">Papers parecidos</h3>
        <div style="font-size:12.5px;color:#b91c1c;">Error: ${esc(e.message)}</div>`;
      return;
    }

    const items = data.items || [];
    if (!items.length) {
      sec.innerHTML = `
        <h3 style="margin:0 0 8px;font-size:14px;font-weight:600;color:#374151;
                   text-transform:uppercase;letter-spacing:0.05em;">Papers parecidos</h3>
        <div style="font-size:12.5px;color:#9ca3af;font-style:italic;
                    background:#f9fafb;border-radius:8px;padding:10px 12px;">
          Aún no hay vecinos disponibles. Asegúrate de que este artículo y otros
          de la biblioteca están indexados (Tools → Index for AI search).
        </div>`;
      return;
    }

    sec.innerHTML = `
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0 0 8px;">
        <h3 style="margin:0;font-size:14px;font-weight:600;color:#374151;
                   text-transform:uppercase;letter-spacing:0.05em;">Papers parecidos</h3>
        <span style="font-size:11px;color:#9ca3af;">${items.length} resultado${items.length === 1 ? '' : 's'}</span>
      </div>
      ${items.map(it => {
        const simPct = Math.round((it.similarity || 0) * 100);
        const headerBits = [
          it.authors ? esc((it.authors || '').slice(0, 110)) : '',
          it.year || '',
          it.journal ? esc(it.journal) : '',
        ].filter(Boolean).join(' · ');
        const flags = [
          it.has_summary_ai
            ? `<span title="Tiene resumen IA" style="font-size:10.5px;color:#1d4ed8;background:#dbeafe;padding:1px 5px;border-radius:4px;font-weight:600;">AI ✓</span>`
            : '',
          it.has_pdf
            ? `<span title="Tiene PDF" style="font-size:10.5px;color:#b91c1c;background:#fee2e2;padding:1px 5px;border-radius:4px;font-weight:600;">PDF</span>`
            : '',
        ].filter(Boolean).join(' ');
        return `
          <div class="pv-similar-row" data-aid="${esc(it.id)}"
               style="display:flex;align-items:center;gap:10px;padding:8px 10px;
                      background:#fafafa;border:1px solid #e5e7eb;border-radius:7px;margin-bottom:5px;
                      cursor:pointer;transition:background 0.1s;"
               onmouseover="this.style.background='#fff'" onmouseout="this.style.background='#fafafa'">
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;color:#111827;
                          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${supHtml(it.title || '(sin título)')}
              </div>
              <div style="font-size:11.5px;color:#6b7280;
                          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${headerBits || '—'}</div>
            </div>
            <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
              ${flags}
              <span title="Distancia coseno: ${it.distance != null ? it.distance.toFixed(3) : '—'}"
                    style="font-size:11px;color:#15803d;background:#dcfce7;padding:1px 6px;border-radius:5px;
                           font-weight:600;font-variant-numeric:tabular-nums;">${simPct}%</span>
            </div>
          </div>`;
      }).join('')}
    `;

    sec.querySelectorAll('.pv-similar-row').forEach(row => {
      row.addEventListener('click', () => openDetail(row.dataset.aid));
    });
  }

  // ── Tag picker section in the detail modal ────────────────────────────
  async function renderTagPickerSection(a) {
    const sec = document.getElementById('pv-tag-picker-section');
    if (!sec) return;
    const articleTagIds = new Set((a.tags || []).map(t => t.id));

    sec.innerHTML = `
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0 0 8px;">
        <h3 style="margin:0;font-size:14px;font-weight:600;color:#374151;
                   text-transform:uppercase;letter-spacing:0.05em;">Tags</h3>
        ${IS_ADMIN ? `<span style="font-size:11px;color:#9ca3af;">Click para asignar / quitar</span>` : ''}
      </div>
      <div id="pv-tag-picker-list" style="display:flex;flex-wrap:wrap;gap:6px;
                                          font-size:12px;color:#9ca3af;">Cargando…</div>`;
    if (!IS_ADMIN) {
      // Read-only render: just the assigned tags as chips.
      const list = document.getElementById('pv-tag-picker-list');
      if (!a.tags || !a.tags.length) {
        list.innerHTML = '<span style="font-style:italic;">Sin tags.</span>';
      } else {
        list.innerHTML = a.tags.map(t =>
          `<span style="padding:3px 9px;border-radius:14px;font-size:12px;font-weight:500;
                        background:${esc(t.color || '#9ca3af')}22;color:${esc(t.color || '#4f46e5')};">
             ${esc(t.name)}
           </span>`).join('');
      }
      return;
    }

    let allTags = [];
    try {
      allTags = await api('/tags');
    } catch (e) {
      document.getElementById('pv-tag-picker-list').innerHTML =
        `<span style="color:#b91c1c;">Error: ${esc(e.message)}</span>`;
      return;
    }
    if (!allTags.length) {
      document.getElementById('pv-tag-picker-list').innerHTML =
        `<span style="font-style:italic;">No hay tags todavía. ` +
        `Crea uno con el botón <strong>+</strong> al lado de Tags en el menú.</span>`;
      return;
    }

    renderChips();

    function renderChips() {
      const list = document.getElementById('pv-tag-picker-list');
      list.innerHTML = allTags.map(t => {
        const on = articleTagIds.has(t.id);
        const color = t.color || '#6b7280';
        return `
          <button type="button" class="pv-tag-pick" data-tag-id="${t.id}"
                  style="padding:4px 10px;border-radius:14px;font-size:12px;font-weight:600;
                         cursor:pointer;transition:transform 0.1s ease, opacity 0.1s ease;
                         border:1.5px solid ${esc(color)};
                         background:${on ? esc(color) : 'white'};
                         color:${on ? 'white' : esc(color)};
                         opacity:${on ? '1' : '0.7'};
                         display:inline-flex;align-items:center;gap:5px;">
            ${on ? '<i class="fas fa-check" style="font-size:9px;"></i>' : ''}
            ${esc(t.name)}
          </button>`;
      }).join('');

      list.querySelectorAll('.pv-tag-pick').forEach(b => {
        b.addEventListener('click', async () => {
          const tid = parseInt(b.dataset.tagId, 10);
          const wasOn = articleTagIds.has(tid);
          b.disabled = true;
          try {
            if (wasOn) {
              await api(`/articles/${a.id}/tags/${tid}`, { method: 'DELETE' });
              articleTagIds.delete(tid);
              a.tags = (a.tags || []).filter(x => x.id !== tid);
            } else {
              await api(`/articles/${a.id}/tags/${tid}`, { method: 'PUT' });
              articleTagIds.add(tid);
              const t = allTags.find(x => x.id === tid);
              if (t) a.tags = [...(a.tags || []), t];
            }
            renderChips();
            refreshTags();   // update sidebar counts
          } catch (e) {
            alert('Error: ' + e.message);
            b.disabled = false;
          }
        });
      });
    }
  }

  // ── Supplementary material ────────────────────────────────────────────
  const SUPP_ICONS = {
    pdf:     'fa-file-pdf',     xlsx:    'fa-file-excel',
    csv:     'fa-file-csv',     txt:     'fa-file-lines',
    doc:     'fa-file-word',    ppt:     'fa-file-powerpoint',
    video:   'fa-file-video',   image:   'fa-file-image',
    archive: 'fa-file-zipper',  data:    'fa-file-code',
    other:   'fa-file',
  };
  const SUPP_COLORS = {
    pdf:     '#b91c1c', xlsx:    '#15803d', csv:     '#15803d',
    txt:     '#6b7280', doc:     '#1d4ed8', ppt:     '#c2410c',
    video:   '#7c3aed', image:   '#0e7490', archive: '#92400e',
    data:    '#374151', other:   '#6b7280',
  };
  function fmtBytes(n) {
    if (!n || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  async function renderSupplementarySection(a) {
    const sec = document.getElementById('pv-supplementary-section');
    if (!sec) return;
    const admin = IS_ADMIN;

    const heading = `
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0 0 8px;">
        <h3 style="margin:0;font-size:14px;font-weight:600;color:#374151;
                   text-transform:uppercase;letter-spacing:0.05em;">Material suplementario</h3>
        ${admin ? `<button id="pv-supp-add-btn" type="button"
                      style="padding:4px 10px;font-size:12px;border-radius:6px;border:1px solid #d1d5db;
                             background:white;color:#0F3460;font-weight:600;cursor:pointer;">
                      <i class="fas fa-plus" style="margin-right:4px;"></i>Añadir
                    </button>` : ''}
      </div>`;
    sec.innerHTML = heading +
      `<div id="pv-supp-list" style="font-size:12.5px;color:#9ca3af;">Cargando…</div>`;

    if (admin) wireSupplementaryUpload(a);

    let data;
    try {
      data = await api(`/articles/${a.id}/supplementary`);
    } catch (e) {
      document.getElementById('pv-supp-list').innerHTML =
        `<div style="color:#b91c1c;">Error: ${esc(e.message)}</div>`;
      return;
    }
    renderSupplementaryList(a, data.items || [], admin);
  }

  function renderSupplementaryList(a, items, admin) {
    const list = document.getElementById('pv-supp-list');
    if (!list) return;
    if (!items.length) {
      list.innerHTML = `
        <div style="font-size:12.5px;color:#9ca3af;font-style:italic;
                    background:#f9fafb;border-radius:8px;padding:10px 12px;">
          Sin material suplementario.${admin ? ' Pulsa "Añadir" para subir un archivo.' : ''}
        </div>`;
      return;
    }

    list.innerHTML = items.map(it => {
      const icon  = SUPP_ICONS[it.kind] || SUPP_ICONS.other;
      const color = SUPP_COLORS[it.kind] || SUPP_COLORS.other;
      const meta  = [it.kind.toUpperCase(), fmtBytes(it.size_bytes)]
        .filter(Boolean).join(' · ');
      return `
        <div class="pv-supp-row" data-sid="${esc(it.id)}"
             style="display:flex;align-items:flex-start;gap:10px;padding:9px 11px;
                    background:#fafafa;border:1px solid #e5e7eb;border-radius:7px;margin-bottom:6px;">
          <i class="fas ${icon}" style="color:${color};font-size:18px;flex-shrink:0;
                                          padding-top:1px;width:18px;text-align:center;"></i>
          <div style="flex:1;min-width:0;">
            <a href="#" data-action="open" data-sid="${esc(it.id)}"
               style="font-size:13px;font-weight:600;color:#0F3460;text-decoration:none;
                      display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              ${esc(it.filename)}
            </a>
            <div style="font-size:11px;color:#9ca3af;margin-top:1px;">${esc(meta)}</div>
            ${it.caption
              ? `<div class="pv-supp-caption" data-sid="${esc(it.id)}"
                       style="font-size:12px;color:#374151;margin-top:4px;
                              white-space:pre-wrap;word-break:break-word;">${esc(it.caption)}</div>`
              : admin
                ? `<div class="pv-supp-caption pv-supp-caption-empty" data-sid="${esc(it.id)}"
                         style="font-size:11.5px;color:#9ca3af;font-style:italic;margin-top:4px;cursor:pointer;">
                       Añadir descripción…
                     </div>`
                : ''}
          </div>
          ${admin ? `
            <div style="display:flex;gap:4px;flex-shrink:0;">
              <button type="button" data-action="edit" data-sid="${esc(it.id)}"
                      title="Editar descripción"
                      style="padding:3px 6px;background:transparent;border:1px solid transparent;
                             border-radius:5px;color:#6b7280;cursor:pointer;font-size:12px;">
                <i class="fas fa-pen"></i>
              </button>
              <button type="button" data-action="delete" data-sid="${esc(it.id)}"
                      title="Eliminar"
                      style="padding:3px 6px;background:transparent;border:1px solid transparent;
                             border-radius:5px;color:#b91c1c;cursor:pointer;font-size:12px;">
                <i class="fas fa-trash"></i>
              </button>
            </div>` : ''}
        </div>`;
    }).join('');

    list.querySelectorAll('[data-action="open"]').forEach(el =>
      el.addEventListener('click', async ev => {
        ev.preventDefault();
        const sid = ev.currentTarget.dataset.sid;
        try {
          const r = await api(`/articles/${a.id}/supplementary/${sid}/url`);
          if (r.url) window.open(r.url, '_blank', 'noopener');
        } catch (e) {
          alert('No se pudo abrir el archivo: ' + e.message);
        }
      }));

    if (admin) {
      list.querySelectorAll('[data-action="edit"], .pv-supp-caption').forEach(el =>
        el.addEventListener('click', ev => {
          const sid = ev.currentTarget.dataset.sid;
          const item = items.find(x => x.id === sid);
          if (!item) return;
          const next = prompt('Descripción del archivo:', item.caption || '');
          if (next === null) return;
          patchSupplementaryCaption(a, sid, next.trim(), items);
        }));
      list.querySelectorAll('[data-action="delete"]').forEach(el =>
        el.addEventListener('click', async ev => {
          const sid  = ev.currentTarget.dataset.sid;
          const item = items.find(x => x.id === sid);
          if (!item) return;
          if (!confirm(`¿Eliminar "${item.filename}"?`)) return;
          try {
            await api(`/articles/${a.id}/supplementary/${sid}`, { method: 'DELETE' });
            renderSupplementarySection(a);
          } catch (e) {
            alert('Error al eliminar: ' + e.message);
          }
        }));
    }
  }

  async function patchSupplementaryCaption(a, sid, caption, items) {
    try {
      await api(`/articles/${a.id}/supplementary/${sid}`, {
        method: 'PATCH',
        body: JSON.stringify({ caption }),
      });
      const item = items.find(x => x.id === sid);
      if (item) item.caption = caption;
      renderSupplementaryList(a, items, IS_ADMIN);
    } catch (e) {
      alert('Error guardando descripción: ' + e.message);
    }
  }

  function wireSupplementaryUpload(a) {
    const btn = document.getElementById('pv-supp-add-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.style.display = 'none';
      input.addEventListener('change', async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        const caption = prompt(
          `Descripción para "${f.name}" (opcional):`, '');
        if (caption === null) return;            // cancelled
        const fd = new FormData();
        fd.append('file', f, f.name);
        if (caption.trim()) fd.append('caption', caption.trim());
        btn.disabled = true;
        const original = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Subiendo…';
        try {
          const r = await fetch(API + `/articles/${a.id}/supplementary`, {
            method: 'POST',
            credentials: 'same-origin',
            body: fd,
          });
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            throw new Error(err.detail || err.error || ('HTTP ' + r.status));
          }
          renderSupplementarySection(a);
        } catch (e) {
          alert('Error subiendo el archivo: ' + e.message);
        } finally {
          btn.disabled = false;
          btn.innerHTML = original;
        }
      });
      document.body.appendChild(input);
      input.click();
      setTimeout(() => input.remove(), 5000);
    });
  }

  // ── Used in: PrionPacks + student assignments ────────────────────────
  const USED_IN_STATUS_COLOR = {
    pending:    { bg: '#fef3c7', fg: '#92400e' },
    read:       { bg: '#dbeafe', fg: '#1d4ed8' },
    summarized: { bg: '#ede9fe', fg: '#6d28d9' },
    evaluated:  { bg: '#dcfce7', fg: '#15803d' },
  };

  // ── Journal Club section in the detail modal ─────────────────────────
  const JC_FILE_ICONS = {
    pptx:    'fa-file-powerpoint',
    pdf:     'fa-file-pdf',
    keynote: 'fa-file-image',
    other:   'fa-file',
  };
  const JC_FILE_COLORS = {
    pptx: '#c2410c', pdf: '#b91c1c',
    keynote: '#0e7490', other: '#6b7280',
  };

  async function renderJcSection(a) {
    const sec = document.getElementById('pv-jc-section');
    if (!sec) return;
    const heading = `
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0 0 8px;">
        <h3 style="margin:0;font-size:14px;font-weight:600;color:#374151;
                   text-transform:uppercase;letter-spacing:0.05em;">
          <span style="display:inline-block;padding:1px 6px;border-radius:4px;
                       font-size:11px;font-weight:600;background:#fce7f3;color:#be185d;
                       vertical-align:middle;margin-right:6px;">JC</span>
          Journal Club
        </h3>
        ${IS_ADMIN ? `<button id="pv-jc-add-btn" type="button"
                      style="padding:4px 10px;font-size:12px;border-radius:6px;
                             border:1px solid #fce7f3;background:white;color:#be185d;
                             font-weight:600;cursor:pointer;">
                      <i class="fas fa-plus" style="margin-right:4px;"></i>Añadir presentación
                    </button>` : ''}
      </div>`;
    sec.innerHTML = heading +
      `<div id="pv-jc-list" style="font-size:12.5px;color:#9ca3af;">Cargando…</div>`;

    if (IS_ADMIN) wireJcAddButton(a);

    let data;
    try {
      data = await api(`/articles/${a.id}/jc`);
    } catch (e) {
      document.getElementById('pv-jc-list').innerHTML =
        `<div style="color:#b91c1c;">Error: ${esc(e.message)}</div>`;
      return;
    }
    renderJcList(a, data.items || []);
  }

  function renderJcList(a, items) {
    const list = document.getElementById('pv-jc-list');
    if (!list) return;
    if (!items.length) {
      list.innerHTML = `
        <div style="font-size:12.5px;color:#9ca3af;font-style:italic;
                    background:#fdf2f8;border:1px dashed #fce7f3;
                    border-radius:8px;padding:10px 12px;">
          Sin presentaciones registradas.${IS_ADMIN ? ' Pulsa "Añadir presentación" cuando alguien lo discuta en el JC.' : ''}
        </div>`;
      return;
    }
    list.innerHTML = items.map(p => {
      const dateText = p.presented_at
        ? new Date(p.presented_at).toLocaleDateString('es-ES',
            { day: '2-digit', month: 'short', year: 'numeric' })
        : '(sin fecha)';
      const fileChips = (p.files || []).map(f => {
        const icon  = JC_FILE_ICONS[f.kind] || JC_FILE_ICONS.other;
        const color = JC_FILE_COLORS[f.kind] || JC_FILE_COLORS.other;
        return `
          <button type="button" class="pv-jc-file" data-fid="${esc(f.id)}"
                  title="Abrir ${esc(f.filename)} en una pestaña nueva"
                  style="display:inline-flex;align-items:center;gap:5px;
                         padding:3px 9px;border-radius:6px;border:1px solid #e5e7eb;
                         background:white;color:${color};font-size:11.5px;font-weight:600;
                         cursor:pointer;margin-right:5px;margin-top:4px;">
            <i class="fas ${icon}"></i>
            ${esc(f.filename)}
          </button>`;
      }).join('');
      const adminActions = IS_ADMIN ? `
        <div style="display:flex;gap:4px;flex-shrink:0;">
          <button type="button" class="pv-jc-add-file" data-pid="${esc(p.id)}"
                  title="Añadir otro fichero a esta presentación"
                  style="padding:3px 6px;background:transparent;border:1px solid transparent;
                         border-radius:5px;color:#6b7280;cursor:pointer;font-size:11px;">
            <i class="fas fa-paperclip"></i>
          </button>
          <button type="button" class="pv-jc-edit" data-pid="${esc(p.id)}"
                  data-date="${esc(p.presented_at || '')}"
                  data-presenter="${esc(p.presenter_name || '')}"
                  title="Editar fecha o presentador"
                  style="padding:3px 6px;background:transparent;border:1px solid transparent;
                         border-radius:5px;color:#6b7280;cursor:pointer;font-size:11px;">
            <i class="fas fa-pen"></i>
          </button>
          <button type="button" class="pv-jc-delete" data-pid="${esc(p.id)}"
                  title="Eliminar esta presentación"
                  style="padding:3px 6px;background:transparent;border:1px solid transparent;
                         border-radius:5px;color:#b91c1c;cursor:pointer;font-size:11px;">
            <i class="fas fa-trash"></i>
          </button>
        </div>` : '';
      return `
        <div data-pid="${esc(p.id)}"
             style="background:#fdf2f8;border:1px solid #fce7f3;border-radius:7px;
                    padding:10px 12px;margin-bottom:7px;">
          <div style="display:flex;align-items:center;gap:10px;justify-content:space-between;">
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;color:#831843;">
                <i class="fas fa-calendar-day" style="margin-right:5px;opacity:0.7;"></i>${esc(dateText)} ·
                <i class="fas fa-user-tie" style="margin-left:4px;margin-right:5px;opacity:0.7;"></i>${esc(p.presenter_name || '—')}
              </div>
            </div>
            ${adminActions}
          </div>
          ${fileChips ? `<div style="margin-top:2px;">${fileChips}</div>` : ''}
        </div>`;
    }).join('');

    // Open file in new tab.
    list.querySelectorAll('.pv-jc-file').forEach(b =>
      b.addEventListener('click', async () => {
        const fid = b.dataset.fid;
        try {
          const r = await api(`/jc/files/${fid}/url`);
          if (r.url) window.open(r.url, '_blank', 'noopener');
        } catch (e) {
          alert('No se pudo abrir el fichero: ' + e.message);
        }
      }));

    if (!IS_ADMIN) return;

    list.querySelectorAll('.pv-jc-delete').forEach(b =>
      b.addEventListener('click', async () => {
        if (!confirm('¿Eliminar esta presentación y sus ficheros? Esta acción no se puede deshacer desde la app.')) return;
        try {
          await api(`/jc/${b.dataset.pid}`, { method: 'DELETE' });
          renderJcSection(a);
          loadArticles();    // refresh the JC badge in the list
        } catch (e) { alert('Error: ' + e.message); }
      }));

    list.querySelectorAll('.pv-jc-edit').forEach(b =>
      b.addEventListener('click', async () => {
        const newDate = prompt('Nueva fecha de presentación (YYYY-MM-DD):',
                               b.dataset.date);
        if (newDate === null) return;
        const newPresenter = prompt('Nombre del presentador:',
                                    b.dataset.presenter);
        if (newPresenter === null) return;
        try {
          await api(`/jc/${b.dataset.pid}`, {
            method: 'PATCH',
            body: JSON.stringify({
              presented_at:   newDate.trim(),
              presenter_name: newPresenter.trim(),
            }),
          });
          renderJcSection(a);
        } catch (e) { alert('Error: ' + e.message); }
      }));

    list.querySelectorAll('.pv-jc-add-file').forEach(b =>
      b.addEventListener('click', () => addJcFilesViaPicker(a, b.dataset.pid)));
  }

  function wireJcAddButton(a) {
    const btn = document.getElementById('pv-jc-add-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const today = new Date().toISOString().slice(0, 10);
      const dateStr = prompt('Fecha de la presentación (YYYY-MM-DD):', today);
      if (!dateStr) return;
      const presenter = prompt('Nombre del presentador:');
      if (!presenter || !presenter.trim()) return;

      // Optional file picker — same multipart endpoint as "create".
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = '.pptx,.ppt,.pdf,.key,.odp';
      input.style.display = 'none';
      input.addEventListener('change', async () => {
        const fd = new FormData();
        fd.append('presented_at', dateStr.trim());
        fd.append('presenter_name', presenter.trim());
        for (const f of input.files || []) fd.append('file', f, f.name);

        btn.disabled = true;
        const original = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Subiendo…';
        try {
          const r = await fetch(API + `/articles/${a.id}/jc`, {
            method: 'POST', credentials: 'same-origin', body: fd,
          });
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            throw new Error(err.detail || err.error || ('HTTP ' + r.status));
          }
          renderJcSection(a);
          loadArticles();
        } catch (e) {
          alert('Error: ' + e.message);
        } finally {
          btn.disabled = false;
          btn.innerHTML = original;
        }
      });
      // If the user clicks Cancel on the file picker, fall back to a
      // file-less POST so the metadata-only presentation still lands.
      document.body.appendChild(input);
      input.addEventListener('cancel', async () => {
        try {
          await api(`/articles/${a.id}/jc`, {
            method: 'POST',
            body: JSON.stringify({
              presented_at:   dateStr.trim(),
              presenter_name: presenter.trim(),
            }),
            headers: { 'Content-Type': 'application/json' },
          });
          renderJcSection(a);
          loadArticles();
        } catch (e) { alert('Error: ' + e.message); }
      });
      input.click();
      setTimeout(() => input.remove(), 60000);
    });
  }

  function addJcFilesViaPicker(a, presentationId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.pptx,.ppt,.pdf,.key,.odp';
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      if (!input.files || !input.files.length) return;
      const fd = new FormData();
      for (const f of input.files) fd.append('file', f, f.name);
      try {
        const r = await fetch(API + `/jc/${presentationId}/files`, {
          method: 'POST', credentials: 'same-origin', body: fd,
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.detail || err.error || ('HTTP ' + r.status));
        }
        renderJcSection(a);
      } catch (e) { alert('Error: ' + e.message); }
    });
    document.body.appendChild(input);
    input.click();
    setTimeout(() => input.remove(), 60000);
  }

  async function renderUsedInSection(a) {
    const sec = document.getElementById('pv-used-in-section');
    if (!sec) return;
    sec.innerHTML = `
      <h3 style="margin:0 0 6px;font-size:14px;font-weight:600;color:#374151;
                 text-transform:uppercase;letter-spacing:0.05em;">Used in</h3>
      <div style="font-size:12.5px;color:#9ca3af;">Cargando…</div>`;

    let data;
    try {
      data = await api(`/articles/${a.id}/used-in`);
    } catch (e) {
      sec.innerHTML = `
        <h3 style="margin:0 0 6px;font-size:14px;font-weight:600;color:#374151;
                   text-transform:uppercase;letter-spacing:0.05em;">Used in</h3>
        <div style="font-size:12.5px;color:#b91c1c;">Error: ${esc(e.message)}</div>`;
      return;
    }

    const packs = data.packs || [];
    const students = data.students || [];

    const targetChip = (t) => {
      const label = t === 'intro' ? 'Intro' : 'Generales';
      const bg = t === 'intro' ? '#e0e7ff' : '#dcfce7';
      const fg = t === 'intro' ? '#3730a3' : '#15803d';
      return `<span style="display:inline-flex;align-items:center;font-size:10.5px;font-weight:600;
                           padding:1px 7px;border-radius:5px;background:${bg};color:${fg};">${label}</span>`;
    };

    const packsHtml = packs.length
      ? packs.map(p => `
          <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;
                      background:#fafafa;border:1px solid #e5e7eb;border-radius:7px;margin-bottom:5px;">
            <i class="fas fa-cubes-stacked" style="color:#0F3460;font-size:12px;flex-shrink:0;"></i>
            <div style="flex:1;min-width:0;">
              <div style="font-size:12.5px;font-weight:600;color:#111827;
                          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${esc(p.id)} · ${esc(p.title || '(sin título)')}
              </div>
              ${p.responsible ? `<div style="font-size:11px;color:#6b7280;">${esc(p.responsible)}${p.type ? ' · ' + esc(p.type) : ''}</div>` : ''}
            </div>
            <div style="display:flex;gap:4px;flex-shrink:0;">${(p.lists || []).map(targetChip).join('')}</div>
          </div>`).join('')
      : '';

    const studentsHtml = students.length
      ? students.map(st => {
          const c = USED_IN_STATUS_COLOR[st.status] || { bg: '#f3f4f6', fg: '#6b7280' };
          const initial = (st.name || '?').slice(0, 1).toUpperCase();
          const avatar = st.photo_url
            ? `<img src="${esc(st.photo_url)}" alt="" style="width:24px;height:24px;border-radius:50%;flex-shrink:0;object-fit:cover;">`
            : `<div style="width:24px;height:24px;border-radius:50%;background:#e5e7eb;color:#6b7280;
                          display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;">${esc(initial)}</div>`;
          const dateStr = st.updated_at ? st.updated_at.slice(0, 10) : '';
          return `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;
                        background:#fafafa;border:1px solid #e5e7eb;border-radius:7px;margin-bottom:5px;">
              ${avatar}
              <div style="flex:1;min-width:0;">
                <div style="font-size:12.5px;font-weight:600;color:#111827;
                            white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(st.name)}</div>
                ${st.email ? `<div style="font-size:11px;color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(st.email)}</div>` : ''}
              </div>
              <span style="display:inline-flex;align-items:center;font-size:10.5px;font-weight:600;
                           padding:1px 7px;border-radius:5px;background:${c.bg};color:${c.fg};">${esc(st.status || '—')}</span>
              ${dateStr ? `<span style="font-size:10.5px;color:#9ca3af;font-variant-numeric:tabular-nums;">${dateStr}</span>` : ''}
            </div>`;
        }).join('')
      : '';

    const hasAny = packs.length || students.length;

    sec.innerHTML = `
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0 0 8px;">
        <h3 style="margin:0;font-size:14px;font-weight:600;color:#374151;
                   text-transform:uppercase;letter-spacing:0.05em;">Used in</h3>
        <span style="font-size:11px;color:#9ca3af;">
          ${packs.length} pack${packs.length === 1 ? '' : 's'} · ${students.length} estudiante${students.length === 1 ? '' : 's'}
        </span>
      </div>
      ${!hasAny ? `
        <div style="font-size:12.5px;color:#9ca3af;font-style:italic;
                    background:#f9fafb;border-radius:8px;padding:10px 12px;">
          Este artículo todavía no aparece en ningún PrionPack activo ni está asignado a estudiantes.
        </div>` : ''}
      ${packs.length ? `
        <div style="margin-bottom:10px;">
          <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:5px;">
            PrionPacks (${packs.length})
          </div>
          ${packsHtml}
        </div>` : ''}
      ${students.length ? `
        <div>
          <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:5px;">
            Asignado a estudiantes (${students.length})
          </div>
          ${studentsHtml}
        </div>` : ''}
    `;
  }

  // ── Edit article modal ─────────────────────────────────────────────
  // Opened from the detail modal's "✏ Editar" button. The point of
  // the modal is to recover from a wrong DOI / PMID: the user
  // corrects the identifier, re-runs the lookup, sees the fields
  // refill with the (hopefully correct) metadata, and saves.
  function wireEditArticleButton(a) {
    const btn = document.getElementById('pv-edit-article-btn');
    if (btn) btn.addEventListener('click', () => openEditModal(a));
  }

  let _editTarget = null;

  function openEditModal(a) {
    const modal = document.getElementById('pv-edit-modal');
    if (!modal) return;
    _editTarget = a;
    document.getElementById('pv-edit-title').value    = a.title    || '';
    document.getElementById('pv-edit-authors').value  = a.authors  || '';
    document.getElementById('pv-edit-year').value     = a.year     || '';
    document.getElementById('pv-edit-journal').value  = a.journal  || '';
    document.getElementById('pv-edit-doi').value      = a.doi      || '';
    document.getElementById('pv-edit-pmid').value     = a.pubmed_id || '';
    document.getElementById('pv-edit-abstract').value = a.abstract || '';
    const status = document.getElementById('pv-edit-status');
    status.textContent = '';
    status.style.color = '#6b7280';
    // Reset the Save button — on a successful PATCH the previous open
    // left it disabled with "Guardando…" because close() runs before
    // we restore the label. Re-opening would otherwise show the stale
    // state.
    const saveBtn = document.getElementById('pv-edit-save');
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Guardar cambios';
    }
    const saveNextBtn = document.getElementById('pv-edit-save-next');
    if (saveNextBtn) {
      saveNextBtn.disabled = false;
      saveNextBtn.textContent = 'Guardar y siguiente →';
    }
    const aiBtn = document.getElementById('pv-edit-identify-ai');
    if (aiBtn) {
      const ok = !!a.has_pdf;
      aiBtn.disabled = !ok;
      aiBtn.textContent = '🤖 Buscar PMID con IA';
      aiBtn.style.opacity = ok ? '1' : '0.45';
      aiBtn.style.cursor  = ok ? 'pointer' : 'not-allowed';
      aiBtn.title = ok
        ? 'La IA lee el PDF, identifica el artículo y busca su PMID en PubMed. Si no encuentra el PMID, copia el título al portapapeles para buscarlo a mano.'
        : 'Este artículo no tiene PDF guardado';
    }
    modal.style.display = 'flex';
    setTimeout(() => document.getElementById('pv-edit-doi').focus(), 50);
  }

  function _editStatus(msg, color) {
    const el = document.getElementById('pv-edit-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = color || '#6b7280';
  }

  async function _editRefetch(by) {
    const status = document.getElementById('pv-edit-status');
    const doiEl  = document.getElementById('pv-edit-doi');
    const pmidEl = document.getElementById('pv-edit-pmid');
    const payload = { doi: '', pubmed_id: '' };
    if (by === 'doi')  payload.doi       = doiEl.value.trim();
    if (by === 'pmid') payload.pubmed_id = pmidEl.value.trim();
    if (!payload.doi && !payload.pubmed_id) {
      _editStatus('Rellena un DOI o un PMID antes de buscar.', '#b91c1c');
      return;
    }
    _editStatus(`Consultando ${by === 'doi' ? 'CrossRef / PubMed por DOI' : 'PubMed por PMID'}…`);
    try {
      const r = await api('/articles/lookup', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (!r.found) {
        _editStatus(`No se encontraron metadatos con ese ${by.toUpperCase()}.`, '#b45309');
        return;
      }
      const m = r.metadata || {};
      // Overwrite every field the lookup returned. The user can
      // still hand-edit before saving — we don't second-guess them.
      if (m.title)    document.getElementById('pv-edit-title').value    = m.title;
      if (m.authors)  document.getElementById('pv-edit-authors').value  = m.authors;
      if (m.year)     document.getElementById('pv-edit-year').value     = m.year;
      if (m.journal)  document.getElementById('pv-edit-journal').value  = m.journal;
      if (m.doi)      doiEl.value  = m.doi;
      if (m.pubmed_id) pmidEl.value = m.pubmed_id;
      if (m.abstract) document.getElementById('pv-edit-abstract').value = m.abstract;
      const dupNote = r.duplicate_of && r.duplicate_of !== _editTarget?.id
        ? '  ⚠️ Ya existe otro artículo con ese DOI/PMID — revisa antes de guardar.'
        : '';
      _editStatus(`✓ Metadatos cargados desde ${m.source || 'el resolver'}. Edita si hace falta y guarda.${dupNote}`,
                  dupNote ? '#b45309' : '#15803d');
    } catch (e) {
      _editStatus('Error de lookup: ' + e.message, '#b91c1c');
    }
  }

  // Find the article id that follows the currently-edited one in the
  // visible results table, or null if we're at the last row of the page.
  function _editNextRowId() {
    if (!_editTarget) return null;
    const cb = document.querySelector(`.pv-row-select[data-aid="${_editTarget.id}"]`);
    if (!cb) return null;
    const row = cb.closest('tr');
    let next = row && row.nextElementSibling;
    while (next) {
      const nextCb = next.querySelector('.pv-row-select');
      if (nextCb && nextCb.dataset.aid) return nextCb.dataset.aid;
      next = next.nextElementSibling;
    }
    return null;
  }

  // Best-effort clipboard copy. Returns true if it worked, false if
  // the API was unavailable or the browser rejected (e.g. http context).
  async function _copyToClipboard(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_e) { /* fall through */ }
    // Legacy fallback: hidden textarea + document.execCommand('copy').
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_e) {
      return false;
    }
  }

  // Run "🤖 Buscar PMID con IA": ship the saved PDF off to the backend,
  // get a PMID back, and either chain into _editRefetch('pmid') to
  // refill the form, surface the duplicate warning (PDF was moved
  // aside server-side), or — when PubMed esearch couldn't resolve the
  // title — copy the title to the clipboard and offer a one-click
  // PubMed search link so the user can paste it and pick the PMID by
  // hand.
  async function _editIdentifyAI() {
    if (!_editTarget) return;
    if (!_editTarget.has_pdf) {
      _editStatus('Este artículo no tiene PDF guardado.', '#b91c1c');
      return;
    }
    const btn = document.getElementById('pv-edit-identify-ai');
    if (btn) { btn.disabled = true; btn.textContent = '🤖 Pensando…'; }
    _editStatus('La IA está leyendo el PDF…');
    try {
      const r = await api(`/articles/${_editTarget.id}/identify-pmid`, { method: 'POST' });
      const id = r.identified || {};
      const idLabel = `«${id.title || '(sin título)'}» · ${id.first_author_lastname || '?'} · ${id.year || '?'}`;
      if (r.duplicate) {
        const dup = r.duplicate_of || {};
        const moved = r.moved_to
          ? `<br>📂 PDF movido a <code style="font-size:11px;">${esc(r.moved_to)}</code>`
          : (r.move_error ? `<br><span style="color:#b91c1c;">⚠️ No se pudo mover el PDF: ${esc(r.move_error)}</span>` : '');
        const link = dup.id
          ? ` — <a href="#" id="pv-edit-ai-dup-open" style="color:#0F3460;text-decoration:underline;">Ver original</a>`
          : '';
        const el = document.getElementById('pv-edit-status');
        el.innerHTML =
          `⚠️ Duplicado detectado. La IA identificó ${esc(idLabel)} → PMID ${esc(String(r.pmid))},` +
          ` que ya existe en la biblioteca${link}.${moved}<br>` +
          'Decide si quieres borrar este registro o conservarlo sin PDF.';
        el.style.color = '#b45309';
        if (dup.id) {
          const a = document.getElementById('pv-edit-ai-dup-open');
          if (a) a.addEventListener('click', (ev) => { ev.preventDefault(); openDetail(dup.id); });
        }
        // Reflect the unlink locally so the AI button greys out if pressed again.
        if (_editTarget) _editTarget.has_pdf = false;
      } else {
        document.getElementById('pv-edit-pmid').value = String(r.pmid);
        _editStatus(`La IA identificó ${idLabel} → PMID ${r.pmid}. Buscando metadatos…`);
        await _editRefetch('pmid');
      }
    } catch (e) {
      const body = e.body || {};
      const guessed = body.identified || {};
      const title  = (typeof guessed.title === 'string' ? guessed.title : '').trim();
      const author = guessed.first_author_lastname || '?';
      const year   = guessed.year || '?';

      // PubMed esearch came up empty but the AI did read the PDF — copy
      // the title to the clipboard so the user can paste it into the
      // PubMed search box in their browser. Also emit a one-click link
      // straight to PubMed pre-filled with the title.
      let copied = false;
      if (title) copied = await _copyToClipboard(title);

      const el = document.getElementById('pv-edit-status');
      el.style.color = '#b91c1c';
      const hintParts = [];
      hintParts.push(`No se pudo identificar el PMID con IA: ${esc(e.message || '')}`);
      if (title) {
        const url = `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(title)}`;
        hintParts.push(
          `La IA pensó: «${esc(title)}» · ${esc(String(author))} · ${esc(String(year))}.`);
        if (copied) {
          hintParts.push(
            `<span style="color:#15803d;">📋 Título copiado al portapapeles</span> — ` +
            `pégalo en <a href="${esc(url)}" target="_blank" rel="noopener" ` +
              `style="color:#0F3460;text-decoration:underline;">PubMed</a> ` +
              `o usa el enlace para abrir la búsqueda ya rellenada.`);
        } else {
          hintParts.push(
            `<a href="${esc(url)}" target="_blank" rel="noopener" ` +
              `style="color:#0F3460;text-decoration:underline;">Abrir búsqueda en PubMed con este título ↗</a>`);
        }
      }
      el.innerHTML = hintParts.join('<br>');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🤖 Buscar PMID con IA'; }
    }
  }

  // Shared save handler. Resolves to the saved article's id on success,
  // or null if the PATCH was rejected (409 / validation). The caller
  // decides whether to advance to the next row, reopen the detail modal,
  // or just close.
  async function _editPerformSave(triggerBtnId) {
    if (!_editTarget) return null;
    const updates = {
      title:     document.getElementById('pv-edit-title').value.trim(),
      authors:   document.getElementById('pv-edit-authors').value.trim() || null,
      year:      parseInt(document.getElementById('pv-edit-year').value, 10) || null,
      journal:   document.getElementById('pv-edit-journal').value.trim() || null,
      doi:       document.getElementById('pv-edit-doi').value.trim()  || null,
      pubmed_id: document.getElementById('pv-edit-pmid').value.trim() || null,
      abstract:  document.getElementById('pv-edit-abstract').value.trim() || null,
    };
    if (!updates.title) {
      _editStatus('El título no puede estar vacío.', '#b91c1c');
      return null;
    }
    const btn = triggerBtnId ? document.getElementById(triggerBtnId) : null;
    let originalLabel = null;
    if (btn) { originalLabel = btn.textContent; btn.disabled = true; btn.textContent = 'Guardando…'; }
    try {
      await api(`/articles/${_editTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      });
      return _editTarget.id;
    } catch (e) {
      if (e.status === 409) {
        const dup = (e.body && e.body.duplicate_of) || '';
        const where = (e.body && e.body.matched_on === 'pubmed_id') ? 'PMID' : 'DOI';
        const linkHtml = dup
          ? ` — <a href="#" id="pv-edit-dup-open" style="color:#0F3460;text-decoration:underline;">Ver existente</a>`
          : '';
        const el = document.getElementById('pv-edit-status');
        el.innerHTML = `⚠️ Ya existe otro artículo con ese ${where}.` +
                       ` Corrige el campo antes de guardar.${linkHtml}`;
        el.style.color = '#b45309';
        if (dup) {
          const lnk = document.getElementById('pv-edit-dup-open');
          if (lnk) lnk.addEventListener('click', (ev) => { ev.preventDefault(); openDetail(dup); });
        }
      } else {
        _editStatus('Error al guardar: ' + e.message, '#b91c1c');
      }
      return null;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
    }
  }

  function wireEditModal() {
    const modal = document.getElementById('pv-edit-modal');
    if (!modal || modal.dataset.wired) return;
    modal.dataset.wired = '1';
    const close = () => { modal.style.display = 'none'; _editTarget = null; };
    document.getElementById('pv-edit-close') ?.addEventListener('click', close);
    document.getElementById('pv-edit-cancel')?.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop')?.addEventListener('click', close);
    document.getElementById('pv-edit-refetch-doi') ?.addEventListener('click', () => _editRefetch('doi'));
    document.getElementById('pv-edit-refetch-pmid')?.addEventListener('click', () => _editRefetch('pmid'));
    document.getElementById('pv-edit-identify-ai') ?.addEventListener('click', _editIdentifyAI);

    document.getElementById('pv-edit-save')?.addEventListener('click', async () => {
      const aid = await _editPerformSave('pv-edit-save');
      if (!aid) return;
      close();
      loadArticles();
      openDetail(aid);
    });

    document.getElementById('pv-edit-save-next')?.addEventListener('click', async () => {
      const nextId = _editNextRowId();
      const aid = await _editPerformSave('pv-edit-save-next');
      if (!aid) return;
      // Refresh the list so the row we just edited shows updated values.
      loadArticles();
      if (!nextId) {
        _editStatus('Guardado. No hay más artículos en esta página.', '#15803d');
        return;
      }
      _editStatus('Guardado. Cargando siguiente…', '#15803d');
      try {
        const next = await api(`/articles/${nextId}`);
        openEditModal(next);
      } catch (e) {
        _editStatus(`Guardado. No se pudo abrir el siguiente: ${e.message}`, '#b91c1c');
      }
    });
  }

  // ── Add to PrionPack (per-article) ───────────────────────────────────
  function wireDeleteArticleButton(a) {
    const btn = document.getElementById('pv-delete-article-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const titleStub = (a.title || '').slice(0, 80);
      const confirmMsg =
        'Vas a eliminar este artículo de la biblioteca:\n\n' +
        `“${titleStub}${(a.title || '').length > 80 ? '…' : ''}”\n\n` +
        '• La fila se borra de la base de datos.\n' +
        '• El PDF se borra de Dropbox (queda en el historial de versiones ~30 días).\n' +
        '• Desaparece de PrionRead, PrionPacks, asignaciones y ratings.\n\n' +
        'Esta acción no se puede deshacer desde la app. ¿Continuar?';
      if (!confirm(confirmMsg)) return;
      btn.disabled = true;
      const orig = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Eliminando…';
      try {
        const r = await api(`/articles/${a.id}`, { method: 'DELETE' });
        // Close the detail modal and reload the list.
        const modal = document.getElementById('pv-detail-modal');
        if (modal) modal.style.display = 'none';
        // If we have a stale selection, drop the deleted id.
        if (state.selectedIds && state.selectedIds.has(a.id)) {
          state.selectedIds.delete(a.id);
          if (typeof updateBulkBar === 'function') updateBulkBar();
        }
        loadArticles();
        refreshStats();
      } catch (e) {
        alert('Error al eliminar: ' + e.message);
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    });
  }

  // Open the pack-picker modal for a list of article ids. Re-uses the
  // same HTML as wireAddToPackButton but POSTs to /import-articles
  // (singular endpoint sees a race per call, the new bulk endpoint
  // applies all references in one update_package).
  async function openBulkPackPicker(articleIds) {
    const modal     = document.getElementById('pv-pack-modal');
    if (!modal) return;
    if (!articleIds || !articleIds.length) {
      alert('Selecciona al menos un artículo primero.');
      return;
    }
    const listEl    = document.getElementById('pv-pack-list');
    const statusEl  = document.getElementById('pv-pack-status');
    const saveBtn   = document.getElementById('pv-pack-save');
    const closeBtn  = document.getElementById('pv-pack-close');
    const cancelBtn = document.getElementById('pv-pack-cancel');
    const titleEl   = modal.querySelector('h2');
    const bodyP     = modal.querySelector('h2 + p');

    // Per-open scope: tweak the title + intro so the user knows this
    // is the bulk path. Reverted on close so the single-article flow
    // still reads cleanly.
    const origTitle = titleEl ? titleEl.innerHTML : '';
    const origBody  = bodyP ? bodyP.innerHTML  : '';
    if (titleEl) titleEl.innerHTML =
      `<i class="fas fa-cubes-stacked" style="color:#0F3460;margin-right:8px;"></i>` +
      `Añadir ${articleIds.length} artículos a un PrionPack`;
    if (bodyP) bodyP.innerHTML =
      `Vas a añadir <strong>${articleIds.length} artículos</strong> a uno o varios PrionPacks ` +
      `activos. Marca en qué lista de referencias entran: ` +
      `<strong>Introducción</strong>, <strong>Generales</strong> o ambas. ` +
      `Las referencias ya presentes (por DOI) se saltan automáticamente.`;
    if (saveBtn) saveBtn.textContent = `Añadir los ${articleIds.length}`;

    function restore() {
      if (titleEl) titleEl.innerHTML = origTitle;
      if (bodyP) bodyP.innerHTML = origBody;
      if (saveBtn) saveBtn.textContent = 'Añadir a los seleccionados';
    }
    function close() { modal.style.display = 'none'; restore(); }

    // Wire the close paths — replace any previous listeners by cloning.
    [closeBtn, cancelBtn].forEach(b => {
      if (!b) return;
      const fresh = b.cloneNode(true);
      b.parentNode.replaceChild(fresh, b);
      fresh.addEventListener('click', close);
    });
    const bd = modal.querySelector('.pv-modal-backdrop');
    if (bd) {
      const freshBd = bd.cloneNode(true);
      bd.parentNode.replaceChild(freshBd, bd);
      freshBd.addEventListener('click', close);
    }

    const selections = new Map();   // pack_id -> Set<"intro"|"general">

    const freshSave = saveBtn.cloneNode(true);
    freshSave.disabled = true;
    freshSave.style.opacity = '0.5';
    saveBtn.parentNode.replaceChild(freshSave, saveBtn);
    const finalSave = freshSave;
    finalSave.textContent = `Añadir los ${articleIds.length}`;

    function refreshSaveState() {
      const any = Array.from(selections.values()).some(s => s.size > 0);
      finalSave.disabled = !any;
      finalSave.style.opacity = finalSave.disabled ? '0.5' : '1';
    }

    modal.style.display = 'flex';
    listEl.innerHTML = '<div style="text-align:center;padding:30px;color:#9ca3af;font-size:13px;">Cargando PrionPacks activos…</div>';
    statusEl.textContent = '';

    let packs = [];
    try {
      const r = await fetch('/prionpacks/api/packages?active=1',
                            { credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      packs = await r.json();
    } catch (e) {
      listEl.innerHTML =
        `<div style="color:#b91c1c;padding:14px;font-size:13px;">Error: ${esc(e.message)}</div>`;
      return;
    }
    if (!packs.length) {
      listEl.innerHTML = '<div style="text-align:center;padding:30px;color:#9ca3af;font-size:13px;">No hay PrionPacks activos.</div>';
      return;
    }

    listEl.innerHTML = packs.map(p => `
      <div style="background:white;border:1px solid #e5e7eb;border-radius:7px;padding:9px 11px;margin-bottom:6px;
                  display:flex;align-items:center;gap:10px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:600;color:#111827;
                      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${esc(p.id)} · ${esc(p.title || '(sin título)')}
          </div>
          <div style="font-size:11px;color:#9ca3af;margin-top:1px;">
            ${esc(p.responsible || '—')}${p.type ? ' · ' + esc(p.type) : ''}
          </div>
        </div>
        <label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#374151;cursor:pointer;">
          <input type="checkbox" class="pv-pack-target" data-pack="${esc(p.id)}" data-target="intro">
          Intro
        </label>
        <label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#374151;cursor:pointer;">
          <input type="checkbox" class="pv-pack-target" data-pack="${esc(p.id)}" data-target="general">
          Generales
        </label>
      </div>`).join('');

    listEl.querySelectorAll('.pv-pack-target').forEach(cb => {
      cb.addEventListener('change', () => {
        const pkgId = cb.dataset.pack;
        const tgt   = cb.dataset.target;
        const set   = selections.get(pkgId) || new Set();
        if (cb.checked) set.add(tgt); else set.delete(tgt);
        if (set.size === 0) selections.delete(pkgId);
        else selections.set(pkgId, set);
        refreshSaveState();
      });
    });

    finalSave.addEventListener('click', async () => {
      if (finalSave.disabled) return;
      finalSave.disabled = true;
      statusEl.style.color = '#6b7280';
      statusEl.textContent = `Añadiendo a ${selections.size} PrionPack(s)…`;
      const results = [];
      for (const [pkgId, targets] of selections.entries()) {
        try {
          const r = await fetch(
            `/prionpacks/api/packages/${encodeURIComponent(pkgId)}/import-articles`,
            {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                article_ids: articleIds,
                targets: Array.from(targets),
              }),
            }
          );
          const data = await r.json().catch(() => ({}));
          results.push({ pkgId, status: r.status, data });
        } catch (e) {
          results.push({ pkgId, status: 0, data: { error: e.message } });
        }
      }
      const okCount = results.filter(x => x.status === 200).length;
      const totals = results.reduce((acc, x) => {
        if (x.data && x.data.added) {
          acc.intro   += (x.data.added.intro   || 0);
          acc.general += (x.data.added.general || 0);
        }
        return acc;
      }, { intro: 0, general: 0 });
      statusEl.style.color = '#15803d';
      statusEl.textContent =
        `Hecho: ${okCount}/${results.length} packs · ` +
        `${totals.intro} en Intro · ${totals.general} en Generales.`;
      finalSave.style.opacity = '0.5';
    });
  }

  function wireAddToPackButton(a) {
    const btn   = document.getElementById('pv-add-to-pack-btn');
    const modal = document.getElementById('pv-pack-modal');
    if (!btn || !modal) return;

    const listEl   = document.getElementById('pv-pack-list');
    const statusEl = document.getElementById('pv-pack-status');
    const saveBtn  = document.getElementById('pv-pack-save');
    const closeBtn = document.getElementById('pv-pack-close');
    const cancelBtn = document.getElementById('pv-pack-cancel');

    let packs = [];
    const selections = new Map();  // pack_id -> Set of "intro"|"general"

    function refreshSaveState() {
      const anyChecked = Array.from(selections.values()).some(s => s.size > 0);
      saveBtn.disabled = !anyChecked;
      saveBtn.style.opacity = saveBtn.disabled ? '0.5' : '1';
    }

    function close() { modal.style.display = 'none'; }

    closeBtn.addEventListener('click', close);
    cancelBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    btn.addEventListener('click', async () => {
      selections.clear();
      modal.style.display = 'flex';
      listEl.innerHTML = '<div style="text-align:center;padding:30px;color:#9ca3af;font-size:13px;">Cargando PrionPacks activos…</div>';
      statusEl.textContent = '';
      saveBtn.disabled = true;
      saveBtn.style.opacity = '0.5';
      try {
        const r = await fetch('/prionpacks/api/packages?active=1', {credentials: 'same-origin'});
        if (!r.ok) throw new Error('HTTP ' + r.status);
        packs = await r.json();
      } catch (e) {
        listEl.innerHTML = `<div style="color:#b91c1c;padding:14px;font-size:13px;">Error: ${esc(e.message)}</div>`;
        return;
      }
      if (!packs.length) {
        listEl.innerHTML = '<div style="text-align:center;padding:30px;color:#9ca3af;font-size:13px;">No hay PrionPacks activos.</div>';
        return;
      }
      listEl.innerHTML = packs.map(p => `
        <div style="background:white;border:1px solid #e5e7eb;border-radius:7px;padding:9px 11px;margin-bottom:6px;
                    display:flex;align-items:center;gap:10px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:#111827;
                        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              ${esc(p.id)} · ${esc(p.title || '(sin título)')}
            </div>
            <div style="font-size:11px;color:#9ca3af;margin-top:1px;">
              ${esc(p.responsible || '—')}${p.type ? ' · ' + esc(p.type) : ''}
            </div>
          </div>
          <label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#374151;cursor:pointer;">
            <input type="checkbox" class="pv-pack-target" data-pack="${esc(p.id)}" data-target="intro">
            Intro
          </label>
          <label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#374151;cursor:pointer;">
            <input type="checkbox" class="pv-pack-target" data-pack="${esc(p.id)}" data-target="general">
            Generales
          </label>
        </div>
      `).join('');

      listEl.querySelectorAll('.pv-pack-target').forEach(cb => {
        cb.addEventListener('change', () => {
          const pkgId = cb.dataset.pack;
          const tgt = cb.dataset.target;
          const set = selections.get(pkgId) || new Set();
          if (cb.checked) set.add(tgt);
          else set.delete(tgt);
          if (set.size === 0) selections.delete(pkgId);
          else selections.set(pkgId, set);
          refreshSaveState();
        });
      });
    });

    saveBtn.addEventListener('click', async () => {
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;
      statusEl.style.color = '#6b7280';
      statusEl.textContent = 'Añadiendo…';
      const ops = [];
      for (const [pkgId, targets] of selections.entries()) {
        ops.push(fetch(`/prionpacks/api/packages/${encodeURIComponent(pkgId)}/import-article`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ article_id: a.id, targets: Array.from(targets) }),
        }).then(async r => ({ pkgId, status: r.status, json: await r.json().catch(() => ({})) })));
      }
      const results = await Promise.all(ops);
      const ok    = results.filter(r => r.status === 200 && r.json.ok);
      const dup   = results.filter(r => r.status === 200 && !r.json.ok && r.json.reason === 'already_in_pack');
      const fail  = results.filter(r => r.status !== 200);
      const parts = [];
      if (ok.length)   parts.push(`<span style="color:#15803d;">✓ ${ok.length} pack${ok.length === 1 ? '' : 's'} actualizado${ok.length === 1 ? '' : 's'}</span>`);
      if (dup.length)  parts.push(`<span style="color:#b45309;">△ ${dup.length} ya tenía${dup.length === 1 ? '' : 'n'} el artículo</span>`);
      if (fail.length) parts.push(`<span style="color:#b91c1c;">✗ ${fail.length} fallo${fail.length === 1 ? '' : 's'}</span>`);
      statusEl.innerHTML = parts.join(' · ');
      saveBtn.disabled = false;
    });
  }

  // ── Personal state chips (favorite + read) in the detail modal ───────
  // ── AI summary section (Capa 3) ──────────────────────────────────────
  // Cache the AI providers catalogue across the page so the detail
  // modal and the bulk modal share one round-trip instead of refetching.
  let _aiProvidersPromise = null;
  function getAiProviders() {
    if (!_aiProvidersPromise) {
      _aiProvidersPromise = api('/admin/ai-providers')
        .then(r => r.providers || {})
        .catch(() => ({}));
    }
    return _aiProvidersPromise;
  }

  function renderAiSummary(a) {
    const block = document.getElementById('pv-ai-summary-block');
    if (!block) return;

    const header = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin:0 0 6px;gap:8px;flex-wrap:wrap;">
        <h3 style="margin:0;font-size:14px;font-weight:600;color:#374151;
                   text-transform:uppercase;letter-spacing:0.05em;">AI summary</h3>
        ${IS_ADMIN ? `
          <div style="display:flex;gap:6px;align-items:center;">
            <select id="pv-ai-provider" title="Modelo de IA a usar"
                    style="font-size:11.5px;padding:3px 6px;border-radius:6px;
                           border:1px solid #d1d5db;background:white;color:#374151;
                           max-width:170px;">
              <option value="">Cargando…</option>
            </select>
            <button id="pv-ai-generate"
                    style="padding:4px 10px;border-radius:6px;border:1px solid #d1d5db;background:white;
                           font-size:11.5px;font-weight:600;color:#0F3460;cursor:pointer;">
              ${a.summary_ai ? '↻ Regenerate' : '✨ Generate'}
            </button>
            ${a.summary_ai ? `
              <button id="pv-ai-clear"
                      title="Borrar el resumen IA"
                      style="padding:4px 8px;border-radius:6px;border:1px solid #fecaca;background:white;
                             font-size:11.5px;color:#b91c1c;cursor:pointer;">🗑</button>` : ''}
          </div>` : ''}
      </div>`;

    const body = a.summary_ai
      ? `<div style="font-size:14px;color:#4b5563;line-height:1.65;
                     background:#f9fafb;border-radius:8px;padding:10px 12px;
                     white-space:pre-wrap;">${markdownLite(a.summary_ai)}</div>`
      : `<div style="font-size:13px;color:#9ca3af;font-style:italic;
                     background:#f9fafb;border-radius:8px;padding:10px 12px;">
          Sin resumen IA todavía${IS_ADMIN ? ' — clic en ✨ Generate para crearlo.' : '.'}
         </div>`;

    block.innerHTML = header + body +
      `<div id="pv-ai-status" style="margin-top:6px;font-size:11.5px;color:#9ca3af;"></div>`;

    if (!IS_ADMIN) return;

    const genBtn   = document.getElementById('pv-ai-generate');
    const clearBtn = document.getElementById('pv-ai-clear');
    const statusEl = document.getElementById('pv-ai-status');
    const provEl   = document.getElementById('pv-ai-provider');

    // Populate the provider dropdown. Default to the value persisted
    // by the bulk-summary modal so the detail picker stays in sync.
    getAiProviders().then(providers => {
      if (!provEl) return;
      const stored = localStorage.getItem('pv-summary-provider') || 'anthropic';
      const keys = Object.keys(providers);
      if (!keys.length) {
        provEl.innerHTML = '<option value="">(sin proveedores)</option>';
        provEl.disabled = true;
        if (genBtn) {
          genBtn.disabled = true;
          genBtn.style.opacity = '0.5';
        }
        return;
      }
      provEl.innerHTML = keys.map(k => {
        const p = providers[k];
        const off = !p.configured;
        return `<option value="${esc(k)}" ${off ? 'disabled' : ''}>
                  ${esc(p.label)}${off ? ' (sin API key)' : ''}
                </option>`;
      }).join('');
      // Pick stored if valid+configured, else the first configured one.
      const ok = providers[stored] && providers[stored].configured;
      provEl.value = ok
        ? stored
        : (keys.find(k => providers[k].configured) || stored);
      provEl.addEventListener('change', () => {
        if (provEl.value) localStorage.setItem('pv-summary-provider', provEl.value);
      });
    });

    if (genBtn) genBtn.addEventListener('click', async () => {
      const provider = (provEl && provEl.value) ||
                       localStorage.getItem('pv-summary-provider') ||
                       'anthropic';
      genBtn.disabled = true;
      const original = genBtn.textContent;
      genBtn.textContent = '⏳ Generando…';
      statusEl.style.color = '#6b7280';
      statusEl.textContent = 'Llamando a la IA — puede tardar 5-15 s…';
      try {
        const r = await api(`/articles/${a.id}/summary`, {
          method: 'POST',
          body: JSON.stringify({ provider }),
        });
        a.summary_ai = r.summary_ai;
        renderAiSummary(a);
        const cost = r.cost_usd != null ? ` · $${r.cost_usd.toFixed(4)}` : '';
        const tin  = r.tokens_in  != null ? ` · ${r.tokens_in} in` : '';
        const tout = r.tokens_out != null ? ` / ${r.tokens_out} out` : '';
        const src  = r.used_full_text ? ' (texto completo)' : ' (solo abstract)';
        const modelTag = r.model ? ` [${r.model}]` : '';
        const newStatus = document.getElementById('pv-ai-status');
        if (newStatus) {
          newStatus.style.color = '#15803d';
          newStatus.textContent = `✓ Generado en ${(r.elapsed_ms/1000).toFixed(1)} s${modelTag}${src}${tin}${tout}${cost}`;
        }
      } catch (e) {
        statusEl.style.color = '#b91c1c';
        if (e.status === 503) {
          statusEl.textContent = 'IA no disponible: API key no configurada en el servidor.';
        } else {
          statusEl.textContent = 'Error: ' + e.message;
        }
        genBtn.disabled = false;
        genBtn.textContent = original;
      }
    });

    if (clearBtn) clearBtn.addEventListener('click', async () => {
      if (!confirm('¿Borrar el resumen IA de este artículo? Se podrá regenerar.')) return;
      clearBtn.disabled = true;
      try {
        await api(`/articles/${a.id}/summary`, { method: 'DELETE' });
        a.summary_ai = null;
        renderAiSummary(a);
      } catch (e) {
        statusEl.style.color = '#b91c1c';
        statusEl.textContent = 'Error al borrar: ' + e.message;
        clearBtn.disabled = false;
      }
    });
  }

  function wirePersonalState(a) {
    const favBtn  = document.getElementById('pv-detail-fav');
    const readBtn = document.getElementById('pv-detail-read');

    async function toggle(btn, endpoint, key, refresh) {
      if (!btn) return;
      const next = btn.dataset.active !== '1';
      btn.disabled = true;
      try {
        const r = await api(`/articles/${a.id}/${endpoint}`, {
          method: 'POST',
          body: JSON.stringify({ value: next }),
        });
        refresh(r);
      } catch (e) {
        alert('Error: ' + e.message);
        btn.disabled = false;
      }
    }

    if (favBtn) favBtn.addEventListener('click', () => toggle(favBtn, 'favorite', 'is_favorite', r => {
      a.is_favorite = !!r.is_favorite;
      // Re-render chips inline without reopening the modal.
      const fresh = renderPersonalChip(a, 'fav');
      favBtn.outerHTML = fresh;
      wirePersonalState(a);
    }));
    if (readBtn) readBtn.addEventListener('click', () => toggle(readBtn, 'read', 'is_read', r => {
      a.is_read = !!r.is_read;
      a.read_at = r.read_at || null;
      const fresh = renderPersonalChip(a, 'read');
      readBtn.outerHTML = fresh;
      wirePersonalState(a);
    }));
  }

  function renderPersonalChip(a, kind) {
    if (kind === 'fav') {
      return `<button id="pv-detail-fav" type="button"
                  data-active="${a.is_favorite ? '1' : '0'}"
                  style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;
                         font-size:12px;font-weight:600;cursor:pointer;
                         ${a.is_favorite
                           ? 'background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;'
                           : 'background:#f9fafb;color:#6b7280;border:1px solid #e5e7eb;'}">
                <span style="font-size:14px;line-height:1;color:${a.is_favorite ? '#e11d48' : '#9ca3af'};">${a.is_favorite ? '♥' : '♡'}</span>
                ${a.is_favorite ? 'En favoritos' : 'Añadir a favoritos'}
              </button>`;
    }
    return `<button id="pv-detail-read" type="button"
                data-active="${a.is_read ? '1' : '0'}"
                style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;
                       font-size:12px;font-weight:600;cursor:pointer;
                       ${a.is_read
                         ? 'background:#dcfce7;color:#15803d;border:1px solid #86efac;'
                         : 'background:#f9fafb;color:#6b7280;border:1px solid #e5e7eb;'}">
              <span style="font-size:13px;font-weight:800;line-height:1;color:${a.is_read ? '#15803d' : '#9ca3af'};">✓</span>
              ${a.is_read ? 'Leído por mí' : 'Marcar como leído'}
            </button>`;
  }

  function closeDetail() {
    _pdfViewerOpen = false;
    const inner = document.querySelector('#pv-detail-modal .pv-modal-inner');
    if (inner) inner.style.maxWidth = '';
    document.getElementById('pv-detail-modal').style.display = 'none';
  }

  // ── wiring ─────────────────────────────────────────────────────────────
  function init() {
    const debounce = (fn, ms) => {
      let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    };
    const onSearch = debounce(() => { state.page = 1; loadArticles(); }, 200);

    const searchInput = document.getElementById('pv-search-input');
    const searchModeBtn = document.getElementById('btn-search-mode');

    function setSearchMode(mode) {
      searchModeBtn.dataset.mode = mode;
      if (mode === 'ai') {
        searchModeBtn.style.background = '#0F3460';
        searchModeBtn.style.color = 'white';
        searchModeBtn.style.borderColor = '#0F3460';
        searchInput.placeholder = 'Pregunta a la biblioteca en lenguaje natural (Enter para enviar)…';
      } else {
        searchModeBtn.style.background = 'transparent';
        searchModeBtn.style.color = '#6b7280';
        searchModeBtn.style.borderColor = '#d1d5db';
        searchInput.placeholder = 'Search title, abstract, authors, journal…';
        closeRagPanel();
      }
    }

    searchInput.addEventListener('input', e => {
      if (searchModeBtn.dataset.mode === 'ai') return;  // text-only debounced search
      state.q = e.target.value.trim();
      onSearch();
    });
    searchInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && searchModeBtn.dataset.mode === 'ai') {
        e.preventDefault();
        runRagSearch(searchInput.value.trim());
      }
    });
    searchModeBtn.addEventListener('click', () => {
      setSearchMode(searchModeBtn.dataset.mode === 'ai' ? 'text' : 'ai');
    });

    // Three coloured AI buttons in the search bar — each sends the
    // current input text as a question to that provider, with the
    // selection persisted in localStorage so Enter in AI mode picks
    // the last-used model.
    function syncAskBtnSelection() {
      const cur = localStorage.getItem('pv-summary-provider') || 'anthropic';
      document.querySelectorAll('.pv-ask-btn').forEach(b => {
        b.style.borderColor = b.dataset.provider === cur ? '#0F3460' : 'transparent';
        b.style.boxShadow = b.dataset.provider === cur
          ? '0 0 0 1px white inset' : 'none';
      });
    }
    document.querySelectorAll('.pv-ask-btn').forEach(btn => {
      btn.addEventListener('mouseenter', () => { btn.style.transform = 'scale(1.15)'; });
      btn.addEventListener('mouseleave', () => { btn.style.transform = 'scale(1)'; });
      btn.addEventListener('click', () => {
        const provider = btn.dataset.provider;
        localStorage.setItem('pv-summary-provider', provider);
        syncAskBtnSelection();
        // Reflect the choice in the answer panel's dropdown too.
        const rp = document.getElementById('pv-rag-provider');
        if (rp) rp.value = provider;
        const text = searchInput.value.trim();
        if (!text) {
          searchInput.focus();
          searchInput.placeholder = 'Escribe tu pregunta y vuelve a pulsar el botón…';
          return;
        }
        setSearchMode('ai');
        runRagSearch(text);
      });
    });
    syncAskBtnSelection();

    // Visual signal that an input has text — easy to miss otherwise
    // when the placeholder/value contrast is low.
    function paintInputState(wrap, hasText) {
      if (!wrap) return;
      wrap.style.background   = hasText ? '#eff6ff' : '#f3f4f6';
      wrap.style.borderColor  = hasText ? '#bfdbfe' : 'transparent';
    }
    const searchWrap = document.getElementById('pv-search-wrap');
    paintInputState(searchWrap, !!searchInput.value.trim());
    searchInput.addEventListener('input',
      () => paintInputState(searchWrap, !!searchInput.value.trim()));

    const bulkLookupWrap = document.getElementById('pv-bulk-lookup-wrap');
    const bulkLookupInputEl = document.getElementById('pv-bulk-lookup-input');
    if (bulkLookupWrap && bulkLookupInputEl) {
      paintInputState(bulkLookupWrap, !!bulkLookupInputEl.value.trim());
      bulkLookupInputEl.addEventListener('input',
        () => paintInputState(bulkLookupWrap, !!bulkLookupInputEl.value.trim()));
    }

    document.getElementById('pv-rag-close').addEventListener('click', closeRagPanel);

    // Provider picker inside the RAG panel — shares the preference
    // with the bulk-summary modal via pv-summary-provider.
    const ragProv = document.getElementById('pv-rag-provider');
    const ragRerun = document.getElementById('pv-rag-rerun');
    if (ragProv) {
      ragProv.value = localStorage.getItem('pv-summary-provider') || 'anthropic';
      ragProv.addEventListener('change', () => {
        localStorage.setItem('pv-summary-provider', ragProv.value);
        syncAskBtnSelection();
      });
    }
    if (ragRerun) {
      ragRerun.addEventListener('click', () => {
        const q = document.getElementById('pv-rag-query');
        const query = q ? q.textContent.trim() : '';
        if (query) runRagSearch(query);
      });
    }
    document.getElementById('filter-year-min').addEventListener('change', e => {
      state.yearMin = parseInt(e.target.value, 10) || null; state.page = 1; loadArticles();
    });
    document.getElementById('filter-year-max').addEventListener('change', e => {
      state.yearMax = parseInt(e.target.value, 10) || null; state.page = 1; loadArticles();
    });
    document.getElementById('filter-authors').addEventListener('input', debounce(e => {
      state.authors = e.target.value.trim(); state.page = 1; loadArticles();
    }, 250));
    document.getElementById('filter-journal').addEventListener('input', debounce(e => {
      state.journal = e.target.value.trim(); state.page = 1; loadArticles();
    }, 250));
    document.getElementById('filter-sort').addEventListener('change', e => {
      state.sort = e.target.value; state.page = 1; loadArticles();
    });

    const prBtn = document.getElementById('btn-filter-prionread');
    prBtn.addEventListener('click', () => {
      // Cycle: null → true → false → null
      state.inPrionread = state.inPrionread === null ? true : state.inPrionread === true ? false : null;
      state.page = 1;
      const labels = {
        null:  '👥 Asignado: todos',
        true:  '👥 Asignados ✓',
        false: '👥 Sin asignar',
      };
      prBtn.textContent = labels[state.inPrionread];
      const active = state.inPrionread !== null;
      prBtn.style.background     = active ? '#0F3460' : 'white';
      prBtn.style.color          = active ? 'white' : '#374151';
      prBtn.style.borderColor    = active ? '#0F3460' : '#e5e7eb';
      loadArticles();
    });

    function wireTriStateButton(id, stateKey, labels) {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.addEventListener('click', () => {
        state[stateKey] = state[stateKey] === null ? true
                       : state[stateKey] === true ? false : null;
        state.page = 1;
        btn.textContent = labels[state[stateKey]];
        const active = state[stateKey] !== null;
        btn.style.background  = active ? '#0F3460' : 'white';
        btn.style.color       = active ? 'white' : '#374151';
        btn.style.borderColor = active ? '#0F3460' : '#e5e7eb';
        loadArticles();
      });
    }
    wireTriStateButton('btn-filter-milestone', 'isMilestone', {
      null: '★ Hito: todos', true: '★ Solo hitos', false: '★ No hitos',
    });
    wireTriStateButton('btn-filter-flagged', 'isFlagged', {
      null: '🚩 Bandera: todos', true: '🚩 Solo marcados', false: '🚩 Sin bandera',
    });
    wireTriStateButton('btn-filter-favorite', 'isFavorite', {
      null: '❤ Favoritos: todos', true: '❤ Mis favoritos', false: '❤ No favoritos',
    });
    wireTriStateButton('btn-filter-read', 'isRead', {
      null: '✓ Leídos: todos', true: '✓ Leídos por mí', false: '✓ No leídos',
    });

    document.getElementById('filter-color').addEventListener('change', e => {
      state.colorLabel = e.target.value || null;
      state.page = 1;
      loadArticles();
    });
    document.getElementById('filter-priority-eq').addEventListener('change', e => {
      const v = parseInt(e.target.value, 10);
      state.priorityEq = Number.isFinite(v) ? v : null;
      state.page = 1;
      loadArticles();
    });
    document.getElementById('filter-has-jc')?.addEventListener('change', e => {
      const v = e.target.value;
      state.hasJc = v === '1' ? true : (v === '0' ? false : null);
      state.page = 1;
      loadArticles();
    });
    document.getElementById('filter-jc-presenter')?.addEventListener('input',
      debounce(e => {
        state.jcPresenter = e.target.value.trim();
        state.page = 1;
        loadArticles();
      }, 250));
    document.getElementById('filter-jc-year')?.addEventListener('change', e => {
      const v = parseInt(e.target.value, 10);
      state.jcYear = Number.isFinite(v) ? v : null;
      state.page = 1;
      loadArticles();
    });

    document.getElementById('filter-has-pp')?.addEventListener('change', e => {
      const v = e.target.value;
      state.hasPp = v === '1' ? true : (v === '0' ? false : null);
      state.page = 1;
      loadArticles();
    });

    document.getElementById('filter-pp-id')?.addEventListener('change', e => {
      state.ppId = e.target.value || '';
      state.page = 1;
      loadArticles();
    });
    document.getElementById('filter-abstract-status')?.addEventListener('change', e => {
      state.abstractStatus = e.target.value || '';
      state.page = 1;
      loadArticles();
    });
    document.getElementById('filter-indexed-status')?.addEventListener('change', e => {
      state.indexedStatus = e.target.value || '';
      state.page = 1;
      loadArticles();
    });
    const psSel = document.getElementById('page-size-select');
    if (psSel) {
      psSel.value = String(state.size);
      psSel.addEventListener('change', e => {
        const v = parseInt(e.target.value, 10);
        state.size = Number.isFinite(v) && v > 0 ? v : 100;
        localStorage.setItem('pv-page-size', String(state.size));
        state.page = 1;
        loadArticles();
      });
    }
    document.getElementById('filter-extraction').addEventListener('change', e => {
      state.extraction = e.target.value || null;
      state.page = 1;
      loadArticles();
    });

    document.querySelectorAll('.pv-sort-th').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sortCol;
        // Cycle desc → asc → default for each column
        if (col === 'title') {
          state.sort = state.sort === 'title_asc' ? 'added_desc' : 'title_asc';
        } else if (col === 'year') {
          state.sort = state.sort === 'year_desc' ? 'year_asc'
                     : state.sort === 'year_asc'  ? 'added_desc'
                                                  : 'year_desc';
        }
        const sortSelect = document.getElementById('filter-sort');
        if (sortSelect) sortSelect.value = state.sort;
        state.page = 1;
        loadArticles();
      });
    });
    refreshSortHeaders();

    document.querySelectorAll('.pv-sidebar-nav .pv-nav-btn[data-filter], aside .pv-nav-btn[data-filter]')
      .forEach(btn => {
        btn.addEventListener('click', () => {
          const f = btn.dataset.filter;
          state.tagId     = null;
          state.hasSummary = (f === 'no-summary') ? 'none' : null;
          state.sort       = (f === 'recent') ? 'added_desc' : state.sort;
          state.page = 1;
          loadArticles();
        });
      });

    document.getElementById('pv-detail-close').addEventListener('click', closeDetail);
    document.querySelector('#pv-detail-modal .pv-modal-backdrop').addEventListener('click', closeDetail);

    if (IS_ADMIN) {
      wireImport();
      wireQueue();
      wireAddByDoi();
      wireEditModal();
      wireBatchImport();
      wireScanFolder();
      wireCleanMetadata();
      wireRetryAbstracts();
      wireDuplicates();
      wireBatchSummary();
      wireBatchIndex();
      wireBatchExtract();
      wireBatchOcr();
      wireBatchSearchable();
      wireBulkBar();
      wireBulkLookup();
      wireBulkTagModal();
    }

    refreshStats();
    wireNewTagButton();
    refreshTags();
    wireNewCollectionButton();
    refreshCollections();
    refreshPrionPacksDropdown();
    wireSidebarToggles();

    // Wire focus trapping for every modal in the page. Safe / idempotent.
    document.querySelectorAll('.pv-modal').forEach(m => wireModalFocusTrap(m));
    loadArticles().then(() => {
      const openId = new URLSearchParams(window.location.search).get('open');
      if (openId) openDetail(openId);
    });
  }

  // ── Import modal ─────────────────────────────────────────────────────
  //
  // Session-scoped: every PDF dropped into the modal returns a job id
  // from /api/ingest/upload; we accumulate those ids and poll only
  // them, so the UI never mixes in unrelated background work.
  //
  // When the queue drains we render a per-file summary card and, for
  // articles the resolver couldn't enrich (source=no_metadata, marked
  // in the job step as "done | md5=…"), offer a 🤖 button that runs
  // the same AI-PMID flow the Edit modal uses.

  let _importPolling = null;
  const _importSession = {
    jobIds:      new Set(),     // ids enqueued from this dropzone
    totalQueued: 0,             // total files we managed to enqueue
    totalDropped: 0,            // total .pdf files the user dropped
    finished:    false,         // summary already rendered
  };

  function _resetImportSession() {
    _importSession.jobIds.clear();
    _importSession.totalQueued  = 0;
    _importSession.totalDropped = 0;
    _importSession.finished     = false;
    const progress = document.getElementById('pv-import-progress');
    if (progress) { progress.innerHTML = ''; progress.style.display = 'none'; }
  }

  function wireImport() {
    const btn            = document.getElementById('btn-import-pdfs');
    const modal          = document.getElementById('pv-import-modal');
    const closeBtn       = document.getElementById('pv-import-close');
    const dropzone       = document.getElementById('pv-dropzone');
    const fileInput      = document.getElementById('pv-file-input');
    const fileInputPlain = document.getElementById('pv-file-input-plain');
    const pickFiles      = document.getElementById('pv-pick-files');
    const pickFolder     = document.getElementById('pv-pick-folder');
    if (!btn || !modal) return;

    const open  = () => { _resetImportSession(); modal.style.display = 'flex'; };
    const close = () => { modal.style.display = 'none'; stopProgressPolling(); };
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    pickFiles.addEventListener('click',  () => fileInputPlain.click());
    pickFolder.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change',      e => uploadFiles(e.target.files));
    fileInputPlain.addEventListener('change', e => uploadFiles(e.target.files));

    ['dragenter', 'dragover'].forEach(ev =>
      dropzone.addEventListener(ev, e => {
        e.preventDefault(); e.stopPropagation();
        dropzone.classList.add('is-drag');
      })
    );
    ['dragleave', 'drop'].forEach(ev =>
      dropzone.addEventListener(ev, e => {
        e.preventDefault(); e.stopPropagation();
        dropzone.classList.remove('is-drag');
      })
    );
    dropzone.addEventListener('drop', async e => {
      const files = await collectFilesFromDataTransfer(e.dataTransfer);
      if (files.length) uploadFiles(files);
    });

    // Open-article links inside per-file summary cards — delegated so
    // we don't have to rebind every time the summary re-renders.
    const progressEl = document.getElementById('pv-import-progress');
    if (progressEl) progressEl.addEventListener('click', (ev) => {
      const a = ev.target.closest('.pv-import-open-article');
      if (!a) return;
      ev.preventDefault();
      const aid = a.dataset.aid;
      if (aid) openDetail(aid);
    });
  }

  async function collectFilesFromDataTransfer(dt) {
    const out = [];
    if (!dt || !dt.items) {
      Array.from(dt.files || []).forEach(f => {
        if (f.name.toLowerCase().endsWith('.pdf')) out.push(f);
      });
      return out;
    }
    const entries = Array.from(dt.items).map(it => it.webkitGetAsEntry?.()).filter(Boolean);
    const walk = async entry => {
      if (entry.isFile) {
        await new Promise(res => entry.file(f => {
          if (f.name.toLowerCase().endsWith('.pdf')) out.push(f);
          res();
        }));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const children = await new Promise(res => reader.readEntries(res));
        for (const c of children) await walk(c);
      }
    };
    for (const e of entries) await walk(e);
    return out;
  }

  async function uploadFiles(files) {
    const arr = Array.from(files || []).filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (!arr.length) return;
    const progress = document.getElementById('pv-import-progress');
    progress.style.display = '';
    // Don't clear progress — additional drops in the same session should
    // append, not wipe earlier per-file rows.
    _importSession.totalDropped += arr.length;
    _importSession.finished = false;
    _setImportHeader(`Subiendo ${arr.length} PDF${arr.length === 1 ? '' : 's'}…`);

    const BATCH = 25;
    let queuedNow = 0;
    let failedNow = 0;
    for (let i = 0; i < arr.length; i += BATCH) {
      const batch = arr.slice(i, i + BATCH);
      const fd = new FormData();
      batch.forEach(f => fd.append('file', f, f.name));
      try {
        const r = await fetch('/prionvault/api/ingest/upload', {
          method: 'POST',
          credentials: 'same-origin',
          body: fd,
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          appendProgressLine(`Batch ${i / BATCH + 1}: ${err.error || r.status}`, 'error');
          failedNow += batch.length;
          continue;
        }
        const j = await r.json();
        (j.job_ids || []).forEach(id => _importSession.jobIds.add(Number(id)));
        queuedNow += j.queued || 0;
        if ((j.queued || 0) < batch.length) {
          failedNow += batch.length - (j.queued || 0);
        }
      } catch (e) {
        appendProgressLine(`Batch ${i / BATCH + 1}: ${e.message}`, 'error');
        failedNow += batch.length;
      }
    }
    _importSession.totalQueued += queuedNow;
    if (failedNow) {
      appendProgressLine(
        `No se pudieron encolar ${failedNow} de ${arr.length} ficheros (ver detalle arriba).`,
        'error');
    }
    _setImportHeader(`Procesando ${queuedNow} fichero${queuedNow === 1 ? '' : 's'}…`);

    // Only kick the poller off after at least one job was created.
    if (_importSession.jobIds.size > 0) startProgressPolling();
    refreshStats();
  }

  // The header is a single sticky row at the top of the progress panel
  // that shows live counts for *this session*. We update it in place
  // so the log below stays clean — no more spammy "queued: 0 · ..."
  // lines repeating every 4 seconds.
  function _setImportHeader(text, kind = 'info') {
    const progress = document.getElementById('pv-import-progress');
    if (!progress) return;
    let header = progress.querySelector('.pv-import-header');
    if (!header) {
      header = document.createElement('div');
      header.className = 'pv-row pv-import-header';
      header.style.cssText = 'background:#f3f4f6;padding:6px 8px;border-radius:6px;margin-bottom:6px;font-weight:600;';
      progress.prepend(header);
    }
    const color = kind === 'error' ? '#b91c1c' : kind === 'ok' ? '#15803d' : '#374151';
    header.innerHTML = `<span style="color:${color};">${escapeHtml(text)}</span>`;
  }

  function appendProgressLine(text, kind) {
    const progress = document.getElementById('pv-import-progress');
    if (!progress) return;
    const row = document.createElement('div');
    row.className = 'pv-row';
    const color = kind === 'error' ? '#b91c1c' : kind === 'ok' ? '#15803d' : '#6b7280';
    row.innerHTML = `<span style="color:${color};flex-shrink:0;">●</span>
                     <span><b style="color:#374151;">${new Date().toLocaleTimeString()}</b> ${escapeHtml(text)}</span>`;
    progress.appendChild(row);
    progress.scrollTop = progress.scrollHeight;
  }

  function startProgressPolling() {
    stopProgressPolling();
    const tick = async () => {
      if (_importSession.jobIds.size === 0) return;
      const idsParam = Array.from(_importSession.jobIds).join(',');
      try {
        const r = await fetch(
          `/prionvault/api/ingest/jobs?ids=${idsParam}&limit=1000`,
          { credentials: 'same-origin' });
        if (!r.ok) return;
        const data = await r.json();
        const jobs = data.items || [];
        _renderSessionProgress(jobs);

        const terminal = jobs.filter(j =>
          j.status === 'done' || j.status === 'duplicate' || j.status === 'failed');
        if (jobs.length > 0 && terminal.length === jobs.length && !_importSession.finished) {
          _importSession.finished = true;
          stopProgressPolling();
          _renderImportSummary(jobs);
          refreshStats();
        }
      } catch (_e) { /* transient — try again next tick */ }
    };
    tick();  // first tick now, don't wait 4s
    _importPolling = setInterval(tick, 4000);
  }

  // Live header counts while jobs are in-flight.
  function _renderSessionProgress(jobs) {
    const counts = { done: 0, duplicate: 0, failed: 0, inFlight: 0 };
    for (const j of jobs) {
      if (j.status === 'done')           counts.done++;
      else if (j.status === 'duplicate') counts.duplicate++;
      else if (j.status === 'failed')    counts.failed++;
      else                               counts.inFlight++;
    }
    const total = jobs.length || _importSession.totalQueued;
    const processed = counts.done + counts.duplicate + counts.failed;
    const bits = [`${processed} / ${total} procesados`];
    if (counts.done)      bits.push(`<span style="color:#15803d;">✓ ${counts.done}</span>`);
    if (counts.duplicate) bits.push(`<span style="color:#b45309;">⟳ ${counts.duplicate}</span>`);
    if (counts.failed)    bits.push(`<span style="color:#b91c1c;">✗ ${counts.failed}</span>`);
    const progress = document.getElementById('pv-import-progress');
    let header = progress.querySelector('.pv-import-header');
    if (!header) {
      header = document.createElement('div');
      header.className = 'pv-row pv-import-header';
      header.style.cssText = 'background:#f3f4f6;padding:6px 8px;border-radius:6px;margin-bottom:6px;font-weight:600;';
      progress.prepend(header);
    }
    header.innerHTML = bits.join(' &nbsp;·&nbsp; ');
  }

  // Once the session is drained, draw one card per file with the
  // specific outcome and — for the no-metadata case — a 🤖 button.
  function _renderImportSummary(jobs) {
    const progress = document.getElementById('pv-import-progress');
    if (!progress) return;

    // Clear log rows but keep the header row.
    Array.from(progress.querySelectorAll('.pv-row')).forEach(el => {
      if (!el.classList.contains('pv-import-header')) el.remove();
    });

    const counts = { done: 0, ok_meta: 0, no_meta: 0, duplicate: 0, failed: 0 };
    const cards = [];
    jobs.forEach(j => {
      const card = _buildJobSummaryCard(j);
      cards.push(card);
      if (j.status === 'done') {
        counts.done++;
        if (_jobLacksMetadata(j)) counts.no_meta++; else counts.ok_meta++;
      } else if (j.status === 'duplicate') counts.duplicate++;
      else if (j.status === 'failed')     counts.failed++;
    });
    cards.forEach(c => progress.appendChild(c));

    const summaryBits = [`Sesión terminada — ${jobs.length} fichero${jobs.length === 1 ? '' : 's'}`];
    if (counts.ok_meta)   summaryBits.push(`<span style="color:#15803d;">✓ ${counts.ok_meta} con metadatos</span>`);
    if (counts.no_meta)   summaryBits.push(`<span style="color:#92400e;">⚠ ${counts.no_meta} sin metadatos</span>`);
    if (counts.duplicate) summaryBits.push(`<span style="color:#b45309;">⟳ ${counts.duplicate} duplicado${counts.duplicate === 1 ? '' : 's'}</span>`);
    if (counts.failed)    summaryBits.push(`<span style="color:#b91c1c;">✗ ${counts.failed} fallido${counts.failed === 1 ? '' : 's'}</span>`);
    const header = progress.querySelector('.pv-import-header');
    if (header) header.innerHTML = summaryBits.join(' &nbsp;·&nbsp; ');
  }

  function _jobLacksMetadata(j) {
    // The worker writes "done | md5=..." when CrossRef/PubMed/title
    // search all came back empty. That's our cue to offer the AI flow.
    return j.status === 'done' && /^done\s*\|\s*md5=/.test(j.step || '');
  }

  function _buildJobSummaryCard(j) {
    const card = document.createElement('div');
    card.className = 'pv-row';
    card.style.cssText = 'align-items:flex-start;padding:6px 8px;border-radius:6px;border:1px solid #e5e7eb;margin-bottom:4px;';
    card.dataset.jobId = j.id;

    const fname = j.pdf_filename || '(sin nombre)';
    const step  = j.step || '';

    let badge, badgeBg, badgeFg;
    let bodyLines = [];
    let actionHtml = '';

    if (j.status === 'duplicate') {
      const by = step.match(/by ([^\s|]+)/)?.[1] || '?';
      badge   = '⟳ Duplicado'; badgeBg = '#fef3c7'; badgeFg = '#92400e';
      bodyLines.push(`Coincide con un artículo existente (por ${by}).`);
      bodyLines.push(`El PDF se ha movido a la carpeta <code style="font-size:11px;">_duplicates/</code> dentro de la subcarpeta del año.`);
      if (j.article_id) actionHtml = _aLinkArticle(j.article_id, 'Ver original');
    } else if (j.status === 'failed') {
      badge   = '✗ Error'; badgeBg = '#fee2e2'; badgeFg = '#b91c1c';
      bodyLines.push(`<span style="color:#b91c1c;">${escapeHtml(j.error || step || 'Error desconocido')}</span>`);
      // Retry is meaningful here — the worker keeps the source PDF and a
      // single click re-queues the job.
      actionHtml = `<button class="pv-import-retry-btn" data-job-id="${j.id}"
                            style="padding:3px 8px;border-radius:5px;border:1px solid #d1d5db;background:white;font-size:11.5px;cursor:pointer;">↻ Reintentar</button>`;
    } else if (j.status === 'done') {
      const noMeta = _jobLacksMetadata(j);
      if (noMeta) {
        badge   = '⚠ Sin metadatos'; badgeBg = '#fef3c7'; badgeFg = '#92400e';
        bodyLines.push('El PDF se subió a Dropbox pero CrossRef / PubMed no devolvieron metadatos.');
        bodyLines.push('Probablemente el PDF no contenía DOI legible. La IA puede leer el título y resolver el PMID.');
        actionHtml = `<button class="pv-import-ai-btn" data-job-id="${j.id}" data-aid="${escapeHtml(j.article_id || '')}"
                              style="padding:3px 8px;border-radius:5px;border:none;background:#7c3aed;color:white;font-size:11.5px;font-weight:600;cursor:pointer;">🤖 Intentar con IA</button>`;
      } else {
        badge   = '✓ Importado'; badgeBg = '#dcfce7'; badgeFg = '#15803d';
        const doi   = step.match(/doi=([^\s|]+)/)?.[1];
        const pmid  = step.match(/pmid=([^\s|]+)/)?.[1];
        const path  = step.match(/\|\s*(\/[^\s]+)/g);
        const target = path && path[path.length - 1] ? path[path.length - 1].replace(/^\|\s*/, '') : '';
        if (doi)    bodyLines.push(`DOI: <code style="font-size:11px;">${escapeHtml(doi)}</code>`);
        if (pmid)   bodyLines.push(`PMID: <code style="font-size:11px;">${escapeHtml(pmid)}</code>`);
        if (target) bodyLines.push(`Archivo en: <code style="font-size:11px;">${escapeHtml(target)}</code>`);
        if (j.article_id) actionHtml = _aLinkArticle(j.article_id, 'Ver artículo');
      }
    } else {
      badge   = j.status; badgeBg = '#e5e7eb'; badgeFg = '#374151';
      bodyLines.push(escapeHtml(step));
    }

    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;width:100%;flex-wrap:wrap;">
        <span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:10.5px;font-weight:700;
                     background:${badgeBg};color:${badgeFg};white-space:nowrap;">${escapeHtml(badge)}</span>
        <span style="flex:1;min-width:0;font-weight:600;color:#111827;font-size:12.5px;
                     overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
              title="${escapeHtml(fname)}">${escapeHtml(fname)}</span>
        ${actionHtml}
      </div>
      ${bodyLines.length ? `<div style="margin-left:0;margin-top:4px;color:#4b5563;font-size:12px;line-height:1.5;">
        ${bodyLines.join('<br>')}
      </div>` : ''}`;

    const retry = card.querySelector('.pv-import-retry-btn');
    if (retry) retry.addEventListener('click', () => _retryImportJob(j.id, card));
    const ai = card.querySelector('.pv-import-ai-btn');
    if (ai) ai.addEventListener('click', () => _aiRecoverImportJob(j, card));
    return card;
  }

  function _aLinkArticle(articleId, label) {
    return `<a href="#" class="pv-import-open-article" data-aid="${escapeHtml(articleId)}"
                style="font-size:11.5px;color:#0F3460;text-decoration:underline;flex-shrink:0;">${escapeHtml(label)} →</a>`;
  }

  async function _retryImportJob(jobId, card) {
    const btn = card.querySelector('.pv-import-retry-btn');
    if (btn) { btn.disabled = true; btn.textContent = '↻ Reintentando…'; }
    try {
      const r = await fetch(`/prionvault/api/ingest/retry/${jobId}`, {
        method: 'POST', credentials: 'same-origin',
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
      // Job is back to queued — restart polling so the card updates
      // when the worker finishes the second attempt.
      _importSession.finished = false;
      startProgressPolling();
    } catch (e) {
      alert('No se pudo reintentar: ' + e.message);
      if (btn) { btn.disabled = false; btn.textContent = '↻ Reintentar'; }
    }
  }

  async function _aiRecoverImportJob(job, card) {
    const aid = job.article_id;
    const btn = card.querySelector('.pv-import-ai-btn');
    if (!aid) {
      alert('No hay artículo asociado al job — no se puede usar IA.');
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '🤖 Pensando…'; }
    try {
      const r = await api(`/articles/${aid}/identify-pmid`, { method: 'POST' });
      if (r.duplicate) {
        const dup = r.duplicate_of || {};
        card.innerHTML = '';
        card.appendChild(_buildAiResultBlock({
          status:   'duplicate',
          fname:    job.pdf_filename,
          pmid:     r.pmid,
          moved_to: r.moved_to,
          moveErr:  r.move_error,
          original: dup,
        }));
        return;
      }
      // 2) Resolve full metadata by PMID.
      const lookup = await api('/articles/lookup', {
        method: 'POST', body: JSON.stringify({ pubmed_id: String(r.pmid) }),
      });
      if (!lookup.found) {
        if (btn) { btn.disabled = false; btn.textContent = '🤖 Intentar con IA'; }
        alert(`La IA propuso PMID ${r.pmid} pero PubMed no devolvió metadatos.`);
        return;
      }
      const m = lookup.metadata || {};
      // 3) PATCH the article with whatever PubMed gave us.
      try {
        await api(`/articles/${aid}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title:     m.title || null,
            authors:   m.authors || null,
            year:      m.year || null,
            journal:   m.journal || null,
            doi:       m.doi || null,
            pubmed_id: m.pubmed_id || String(r.pmid),
            abstract:  m.abstract || null,
          }),
        });
      } catch (e) {
        // PATCH 409 = the resolved PMID/DOI already belongs to another
        // article. Treat as duplicate at this late stage too.
        if (e.status === 409) {
          card.innerHTML = '';
          card.appendChild(_buildAiResultBlock({
            status: 'conflict',
            fname:  job.pdf_filename,
            pmid:   r.pmid,
            error:  e.message,
          }));
          return;
        }
        throw e;
      }
      card.innerHTML = '';
      card.appendChild(_buildAiResultBlock({
        status:   'ok',
        fname:    job.pdf_filename,
        pmid:     m.pubmed_id || String(r.pmid),
        title:    m.title,
        year:     m.year,
        article_id: aid,
      }));
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '🤖 Intentar con IA'; }
      alert('La IA no pudo identificar el PMID: ' + (e.message || 'error'));
    }
  }

  function _buildAiResultBlock(r) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:6px 8px;border-radius:6px;border:1px solid #e5e7eb;margin-bottom:4px;';
    let badge, body;
    if (r.status === 'ok') {
      wrap.style.background = '#f0fdf4';
      badge = '<span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:10.5px;font-weight:700;background:#dcfce7;color:#15803d;">🤖 Recuperado con IA</span>';
      const title = r.title ? `«${escapeHtml((r.title || '').slice(0, 110))}${r.title.length > 110 ? '…' : ''}»` : '';
      body = `<div style="margin-top:4px;font-size:12px;color:#166534;">
                PMID <code>${escapeHtml(String(r.pmid))}</code>${r.year ? ' · ' + escapeHtml(String(r.year)) : ''}<br>
                ${title}
              </div>`;
    } else if (r.status === 'duplicate' || r.status === 'conflict') {
      wrap.style.background = '#fffbeb';
      badge = '<span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:10.5px;font-weight:700;background:#fef3c7;color:#92400e;">⟳ Duplicado tras IA</span>';
      const moved = r.moved_to
        ? `El PDF se ha movido a <code style="font-size:11px;">${escapeHtml(r.moved_to)}</code> y se ha desvinculado del artículo.`
        : (r.moveErr ? `<span style="color:#b91c1c;">No se pudo mover el PDF: ${escapeHtml(r.moveErr)}</span>` : 'Artículo desvinculado.');
      const orig = r.original && r.original.id
        ? `Original: ${_aLinkArticle(r.original.id, 'Ver original')}`
        : (r.error ? `Conflicto: ${escapeHtml(r.error)}` : '');
      body = `<div style="margin-top:4px;font-size:12px;color:#92400e;">
                La IA identificó PMID <code>${escapeHtml(String(r.pmid))}</code>, que ya existe en la biblioteca.<br>
                ${moved}<br>${orig}
              </div>`;
    } else {
      wrap.style.background = '#fef2f2';
      badge = '<span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:10.5px;font-weight:700;background:#fee2e2;color:#b91c1c;">✗ IA sin éxito</span>';
      body = `<div style="margin-top:4px;font-size:12px;color:#7f1d1d;">${escapeHtml(r.error || '')}</div>`;
    }
    wrap.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        ${badge}
        <span style="flex:1;min-width:0;font-weight:600;color:#111827;font-size:12.5px;
                     overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
              title="${escapeHtml(r.fname || '')}">${escapeHtml(r.fname || '')}</span>
        ${r.article_id ? _aLinkArticle(r.article_id, 'Ver artículo') : ''}
      </div>
      ${body}`;
    return wrap;
  }

  function stopProgressPolling() {
    if (_importPolling) { clearInterval(_importPolling); _importPolling = null; }
  }

  // ── Queue panel ────────────────────────────────────────────────────────
  let _queuePolling = null;
  function wireQueue() {
    const btn      = document.getElementById('btn-manage-queue');
    const modal    = document.getElementById('pv-queue-modal');
    const closeBtn = document.getElementById('pv-queue-close');
    if (!btn || !modal) return;

    btn.addEventListener('click', () => {
      modal.style.display = 'flex';
      refreshQueue();
      _queuePolling = setInterval(refreshQueue, 4000);
    });
    const close = () => {
      modal.style.display = 'none';
      if (_queuePolling) { clearInterval(_queuePolling); _queuePolling = null; }
    };
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    const clearBtn = document.getElementById('pv-queue-clear-failed');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        if (!confirm('¿Borrar todas las filas terminadas (failed, duplicate y done)? Las que estén en curso (queued / processing) se mantienen. La acción no se puede deshacer.')) return;
        clearBtn.disabled = true;
        try {
          const r = await fetch('/prionvault/api/ingest/clear-failed', {
            method: 'POST', credentials: 'same-origin',
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
          refreshQueue();
        } catch (e) {
          alert('Error: ' + e.message);
        } finally {
          clearBtn.disabled = false;
        }
      });
    }
  }

  async function refreshQueue() {
    try {
      const r = await fetch('/prionvault/api/ingest/status?recent=80', { credentials: 'same-origin' });
      if (!r.ok) return;
      const s = await r.json();
      document.getElementById('pv-queue-counts').innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:8px;font-size:12px;margin-bottom:4px;">
          <span style="padding:3px 10px;border-radius:20px;background:#f3f4f6;color:#374151;">queued: <b>${s.queued}</b></span>
          <span style="padding:3px 10px;border-radius:20px;background:#fff7ed;color:#c2410c;">processing: <b>${s.processing}</b></span>
          <span style="padding:3px 10px;border-radius:20px;background:#f0fdf4;color:#15803d;">done: <b>${s.done}</b></span>
          <span style="padding:3px 10px;border-radius:20px;background:#eff6ff;color:#1d4ed8;">duplicate: <b>${s.duplicate}</b></span>
          <span style="padding:3px 10px;border-radius:20px;background:#fef2f2;color:#b91c1c;">failed: <b>${s.failed}</b></span>
        </div>
      `;
      const tbody = document.getElementById('pv-queue-rows');
      tbody.innerHTML = '';
      s.recent.forEach(j => tbody.appendChild(renderJobRow(j)));
    } catch (e) { /* ignore */ }
  }

  function renderJobRow(j) {
    const tr = document.createElement('tr');
    const showRetry = (j.status === 'failed' || j.status === 'duplicate');
    const stepFull  = j.step || '';
    // The step string is `done | doi=… | /path/to.pdf` — long, with
    // no spaces inside the URL-ish tokens, so word-break:break-word
    // ended up wrapping one character per line. Truncate to a single
    // line and keep the full value in `title` for hover inspection.
    const stepShort = stepFull.length > 70 ? stepFull.slice(0, 70) + '…' : stepFull;
    tr.innerHTML = `
      <td style="color:#9ca3af;">${j.id}</td>
      <td title="${escapeHtml(j.pdf_filename || '')}">${escapeHtml((j.pdf_filename || '').slice(0, 60))}</td>
      <td><span style="font-size:11px;font-weight:600;color:${statusColor(j.status)};">${escapeHtml(j.status)}</span></td>
      <td title="${escapeHtml(stepFull)}"
          style="color:#6b7280;max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,monospace;font-size:11.5px;">
        ${escapeHtml(stepShort)}
      </td>
      <td title="${escapeHtml(j.error || '')}"
          style="color:#b91c1c;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
        ${escapeHtml((j.error || '').slice(0, 80))}
      </td>
      <td style="color:#9ca3af;white-space:nowrap;">${j.created_at ? j.created_at.slice(0, 16).replace('T', ' ') : ''}</td>
      <td>${showRetry ? `<button class="pv-btn-retry" data-job="${j.id}">Retry</button>` : ''}</td>
    `;
    if (showRetry) {
      tr.querySelector('.pv-btn-retry').addEventListener('click', async () => {
        const r = await fetch('/prionvault/api/ingest/retry/' + j.id, { method: 'POST', credentials: 'same-origin' });
        if (r.ok) refreshQueue();
      });
    }
    return tr;
  }

  function statusColor(s) {
    return s === 'done' ? '#15803d' : s === 'failed' ? '#b91c1c' : s === 'duplicate' ? '#1d4ed8' :
           s === 'processing' ? '#c2410c' : '#6b7280';
  }

  // ── Add by DOI / PMID ────────────────────────────────────────────────
  function parseIdentifier(raw) {
    const s = (raw || '').trim()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    if (/^10\./.test(s))   return { doi: s, pubmed_id: '' };
    if (/^\d+$/.test(s))   return { doi: '', pubmed_id: s };
    return { doi: s, pubmed_id: '' };
  }

  function wireAddByDoi() {
    const btn   = document.getElementById('btn-add-by-doi');
    const modal = document.getElementById('pv-add-modal');
    if (!btn || !modal) return;

    const ident    = document.getElementById('pv-add-identifier');
    const lookup   = document.getElementById('pv-add-lookup');
    const statusEl = document.getElementById('pv-add-status');
    const form     = document.getElementById('pv-add-form');
    const fTitle   = document.getElementById('pv-add-title');
    const fAuthors = document.getElementById('pv-add-authors');
    const fYear    = document.getElementById('pv-add-year');
    const fJournal = document.getElementById('pv-add-journal');
    const fDoi     = document.getElementById('pv-add-doi');
    const fPmid    = document.getElementById('pv-add-pmid');
    const fAbstr   = document.getElementById('pv-add-abstract');
    const fPdf     = document.getElementById('pv-add-pdf');
    const fPdfInfo = document.getElementById('pv-add-pdf-info');
    const btnSave  = document.getElementById('pv-add-save');
    const btnCancel = document.getElementById('pv-add-cancel');
    const btnClose = document.getElementById('pv-add-close');

    function reset() {
      ident.value = '';
      [fTitle, fAuthors, fYear, fJournal, fDoi, fPmid, fAbstr].forEach(el => el.value = '');
      if (fPdf) fPdf.value = '';
      form.style.display = 'none';
      statusEl.textContent = '';
      statusEl.style.color = '#6b7280';
    }

    // Reflect the chosen PDF (name + size) so the user can confirm
    // they picked the right file before clicking Save.
    fPdf?.addEventListener('change', () => {
      const file = fPdf.files && fPdf.files[0];
      if (!fPdfInfo) return;
      if (!file) {
        fPdfInfo.textContent = 'Si adjuntas un PDF aquí, se sube y queda ' +
          'asociado al artículo sin pasar por la detección automática de ' +
          'metadatos (útil para escaneos o copias de baja calidad).';
        fPdfInfo.style.color = '#9ca3af';
        return;
      }
      fPdfInfo.textContent =
        `📎 ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB) — ` +
        `se subirá a Dropbox al guardar.`;
      fPdfInfo.style.color = '#15803d';
    });
    function open()  { reset(); modal.style.display = 'flex'; setTimeout(() => ident.focus(), 50); }
    function close() { modal.style.display = 'none'; }

    btn.addEventListener('click', open);
    btnClose.addEventListener('click', close);
    btnCancel.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    async function doLookup() {
      const { doi, pubmed_id } = parseIdentifier(ident.value);
      if (!doi && !pubmed_id) {
        statusEl.textContent = 'Pega un DOI o un PMID válido.';
        statusEl.style.color = '#b91c1c';
        return;
      }
      statusEl.textContent = 'Consultando CrossRef / PubMed…';
      statusEl.style.color = '#6b7280';
      lookup.disabled = true;
      try {
        const r = await api('/articles/lookup', {
          method: 'POST',
          body: JSON.stringify({ doi, pubmed_id }),
        });
        if (!r.found) {
          statusEl.textContent = 'No se encontraron metadatos. Puedes rellenar el formulario a mano.';
          statusEl.style.color = '#b45309';
          form.style.display = 'block';
          fDoi.value  = doi || '';
          fPmid.value = pubmed_id || '';
          return;
        }
        const m = r.metadata || {};
        fTitle.value   = m.title   || '';
        fAuthors.value = m.authors || '';
        fYear.value    = m.year    || '';
        fJournal.value = m.journal || '';
        fDoi.value     = m.doi     || doi || '';
        fPmid.value    = m.pubmed_id || pubmed_id || '';
        fAbstr.value   = m.abstract  || '';
        form.style.display = 'block';
        if (r.duplicate_of) {
          statusEl.innerHTML = `⚠️ Ya existe un artículo con este DOI/PMID en la biblioteca · ` +
                               `<a href="#" data-aid="${esc(r.duplicate_of)}" id="pv-add-dup-open" ` +
                               `style="color:#0F3460;text-decoration:underline;">Ver existente</a>`;
          statusEl.style.color = '#b45309';
          const lnk = document.getElementById('pv-add-dup-open');
          if (lnk) lnk.addEventListener('click', e => {
            e.preventDefault();
            openDetail(r.duplicate_of);
          });
          btnSave.disabled = true;
          btnSave.style.opacity = '0.5';
        } else {
          statusEl.textContent = `✓ Metadatos cargados desde ${m.source || 'el resolver'}. ` +
                                 `Edita si hace falta y guarda.`;
          statusEl.style.color = '#15803d';
          btnSave.disabled = false;
          btnSave.style.opacity = '1';
        }
      } catch (e) {
        statusEl.textContent = 'Error de lookup: ' + e.message;
        statusEl.style.color = '#b91c1c';
      } finally {
        lookup.disabled = false;
      }
    }
    lookup.addEventListener('click', doLookup);
    ident.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); doLookup(); }
    });

    btnSave.addEventListener('click', async () => {
      if (!fTitle.value.trim()) {
        statusEl.textContent = 'El título es obligatorio.';
        statusEl.style.color = '#b91c1c';
        return;
      }
      btnSave.disabled = true;
      const payload = {
        title:     fTitle.value.trim(),
        authors:   fAuthors.value.trim() || null,
        year:      parseInt(fYear.value, 10) || null,
        journal:   fJournal.value.trim() || null,
        doi:       fDoi.value.trim() || null,
        pubmed_id: fPmid.value.trim() || null,
        abstract:  fAbstr.value.trim() || null,
      };
      const pdfFile = fPdf && fPdf.files && fPdf.files[0];
      try {
        if (pdfFile) {
          // Send metadata + binary together; the new endpoint skips
          // the automatic DOI extraction from the PDF text.
          statusEl.textContent = 'Subiendo PDF y guardando…';
          statusEl.style.color = '#6b7280';
          const fd = new FormData();
          fd.append('pdf', pdfFile);
          fd.append('metadata', JSON.stringify(payload));
          const res = await fetch(API + '/articles/with-pdf', {
            method: 'POST',
            credentials: 'same-origin',
            body: fd,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            const e = new Error(data.error || 'Error al guardar con PDF');
            e.status = res.status;
            e.body = data;
            throw e;
          }
        } else {
          await api('/articles', { method: 'POST', body: JSON.stringify(payload) });
        }
        close();
        loadArticles();
        refreshStats();
      } catch (e) {
        if (e.status === 409) {
          const dup = (e.body && e.body.duplicate_of) || '';
          statusEl.innerHTML = '⚠️ Ya existe un artículo con ese ' +
            (e.body && e.body.matched_on === 'pdf_md5' ? 'mismo PDF' : 'DOI/PMID') +
            (dup
              ? ` — <a href="#" id="pv-add-dup-open" style="color:#0F3460;text-decoration:underline;">Ver existente</a>`
              : ' — no se ha creado.');
          statusEl.style.color = '#b45309';
          const lnk = document.getElementById('pv-add-dup-open');
          if (lnk) lnk.addEventListener('click', (ev) => {
            ev.preventDefault();
            openDetail(dup);
          });
        } else {
          statusEl.textContent = 'Error al guardar: ' + e.message;
          statusEl.style.color = '#b91c1c';
        }
        btnSave.disabled = false;
      }
    });
  }

  // ── Scan Dropbox folder ─────────────────────────────────────────────
  // Triggers /api/ingest/scan-folder, which lists PDFs in the watch
  // folder, queues each one through the regular ingest pipeline, and
  // deletes successful ones from Dropbox. Failures stay in the folder
  // for manual review.
  function wireScanFolder() {
    const btn = document.getElementById('btn-scan-folder');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const folder = prompt(
        'Carpeta de Dropbox a escanear (los PDFs que se importen bien o ya estén ' +
        'en la biblioteca se borrarán de ahí; los que fallen permanecen):',
        '/PrionLab tools/PDFs'
      );
      if (folder === null) return;
      const trimmed = folder.trim();
      if (!trimmed) return;
      btn.disabled = true;
      const originalHtml = btn.innerHTML;
      btn.innerHTML = '<span><i class="fas fa-spinner fa-spin" style="width:13px;margin-right:6px;opacity:0.7;"></i>Escaneando…</span>';
      try {
        const res = await fetch(API + '/ingest/scan-folder', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: trimmed }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          alert(
            `No se pudo escanear la carpeta:\n${data.error || res.status}` +
            (data.detail ? `\n${data.detail}` : '')
          );
        } else {
          const skippedMsg = data.skipped
            ? `\n${data.skipped} omitidos (revisa la consola para el detalle).`
            : '';
          const moreMsg = data.remaining > 0
            ? `\n\nQuedan ${data.remaining} PDFs sin procesar en la carpeta. ` +
              `Vuelve a pulsar "Scan Dropbox folder" cuando termine la cola actual ` +
              `(o tras unos minutos para que el worker descargue espacio en disco).`
            : '';
          alert(
            `Carpeta ${data.folder}: ${data.pdfs_found} PDFs encontrados, ` +
            `${data.queued} encolados en esta tanda.${skippedMsg}\n\n` +
            `Sigue el progreso en el panel de "Ingest queue". Los que terminen ` +
            `bien o sean duplicados se borrarán solos de la carpeta.${moreMsg}`
          );
          if (data.skipped) console.warn('scan-folder skipped:', data.skipped_detail);
          refreshQueue?.();
        }
      } catch (err) {
        alert('Error de red al escanear: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    });
  }

  // ── Clean metadata backfill ──────────────────────────────────────────
  // One-off pass over every article in the library that decodes HTML
  // entities and converts <sup>...</sup> / <sub>...</sub> to Unicode.
  // Triggered manually from the sidebar; the same logic also runs at
  // ingest time via metadata_resolver.Metadata.__post_init__, so the
  // button is mostly useful for rows that already existed when the
  // cleanup pass shipped.
  function wireCleanMetadata() {
    const btn = document.getElementById('btn-clean-metadata');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!confirm('Va a recorrer todos los artículos limpiando entidades HTML y ' +
                   'transformando sup/sub a Unicode. La acción es idempotente y ' +
                   'reversible (sólo actualiza filas con cambios). ¿Continuar?')) {
        return;
      }
      btn.disabled = true;
      const orig = btn.innerHTML;
      btn.innerHTML = '<span><i class="fas fa-spinner fa-spin" style="width:13px;margin-right:6px;opacity:0.7;"></i>Limpiando…</span>';
      try {
        const r = await api('/admin/clean-metadata', { method: 'POST' });
        const pf = r.per_field || {};
        alert(
          `Backfill completado.\n\n` +
          `Filas examinadas: ${r.scanned}\n` +
          `Filas modificadas: ${r.changed_rows}\n` +
          `  · title:    ${pf.title    ?? 0}\n` +
          `  · authors:  ${pf.authors  ?? 0}\n` +
          `  · journal:  ${pf.journal  ?? 0}\n` +
          `  · abstract: ${pf.abstract ?? 0}`
        );
        loadArticles();
      } catch (e) {
        alert('Error: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    });
  }

  // ── Retry-abstracts backfill ─────────────────────────────────────────
  // Drives /api/admin/retry-abstracts in 50-article chunks so the user
  // can rescue PLoS/BMC-style papers that the old esummary-only parser
  // couldn't fetch the abstract for. Each click reports recovered /
  // still missing / remaining so it's obvious whether another round
  // is worth it.
  function wireRetryAbstracts() {
    const btn = document.getElementById('btn-retry-abstracts');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const orig = btn.innerHTML;
      btn.innerHTML = '<span><i class="fas fa-spinner fa-spin" style="width:13px;margin-right:6px;opacity:0.7;"></i>Reintentando…</span>';
      try {
        const r = await api('/admin/retry-abstracts', {
          method: 'POST',
          body: JSON.stringify({ limit: 50 }),
        });
        const more = r.remaining > 0
          ? `\n\nQuedan ${r.remaining} sin abstract. Vuelve a pulsar para procesar otros 50.`
          : '\n\n✓ Sin artículos pendientes.';
        alert(
          `Reintento completado.\n\n` +
          `Procesados: ${r.processed}\n` +
          `Abstract recuperado: ${r.recovered}\n` +
          `Aún sin abstract (marcados como confirmados): ${r.still_missing}\n` +
          `PMIDs descubiertos por el camino: ${r.learned_pmids}` +
          more
        );
        loadArticles();
      } catch (e) {
        alert('Error: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    });
  }

  // ── Batch import by DOI/PMID list ────────────────────────────────────
  function parseBatchEntries(text) {
    return text.split(/[\n\r\t,;]+/).map(s => s.trim()).filter(Boolean).map(parseIdentifier);
  }

  function wireBatchImport() {
    const btn   = document.getElementById('btn-batch-import');
    const modal = document.getElementById('pv-batch-modal');
    if (!btn || !modal) return;

    const ta       = document.getElementById('pv-batch-text');
    const counter  = document.getElementById('pv-batch-count');
    const startBtn = document.getElementById('pv-batch-start');
    const cancelBtn = document.getElementById('pv-batch-cancel');
    const closeBtn = document.getElementById('pv-batch-close');
    const inputWrap = document.getElementById('pv-batch-input-wrap');
    const progWrap  = document.getElementById('pv-batch-progress-wrap');
    const rowsEl   = document.getElementById('pv-batch-rows');
    const summary  = document.getElementById('pv-batch-summary');
    const restartBtn = document.getElementById('pv-batch-restart');
    const doneBtn  = document.getElementById('pv-batch-done');

    function reset() {
      ta.value = '';
      counter.textContent = 'Sin entradas detectadas';
      startBtn.disabled = true;
      startBtn.style.opacity = '0.6';
      inputWrap.style.display = '';
      progWrap.style.display = 'none';
      rowsEl.innerHTML = '';
      summary.style.display = 'none';
      summary.innerHTML = '';
      restartBtn.style.display = 'none';
    }
    function open()  { reset(); modal.style.display = 'flex'; setTimeout(() => ta.focus(), 50); }
    function close() { modal.style.display = 'none'; loadArticles(); refreshStats(); }

    btn.addEventListener('click', open);
    cancelBtn.addEventListener('click', close);
    closeBtn.addEventListener('click', close);
    doneBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);
    restartBtn.addEventListener('click', reset);

    ta.addEventListener('input', () => {
      const entries = parseBatchEntries(ta.value);
      const doiN  = entries.filter(e => e.doi).length;
      const pmidN = entries.filter(e => e.pubmed_id).length;
      counter.textContent = entries.length
        ? `${entries.length} entrada${entries.length === 1 ? '' : 's'} · ${doiN} DOI · ${pmidN} PMID`
        : 'Sin entradas detectadas';
      startBtn.disabled = entries.length === 0;
      startBtn.style.opacity = entries.length === 0 ? '0.6' : '1';
    });

    startBtn.addEventListener('click', async () => {
      const entries = parseBatchEntries(ta.value);
      if (!entries.length) return;
      const useUnpaywall = !!document.getElementById('pv-batch-unpaywall')?.checked;
      inputWrap.style.display = 'none';
      progWrap.style.display = '';
      rowsEl.innerHTML = '';

      const STATUS = {
        loading:   { icon: '…', color: '#3b82f6' },
        ok:        { icon: '✓', color: '#15803d' },
        duplicate: { icon: '△', color: '#b45309' },
        error:     { icon: '✗', color: '#b91c1c' },
      };

      const rowNodes = entries.map((e, i) => {
        const div = document.createElement('div');
        const label = e.doi || `PMID:${e.pubmed_id}`;
        div.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:5px 6px;border-radius:6px;font-size:12.5px;';
        div.innerHTML = `
          <span class="pv-batch-icon" style="width:14px;text-align:center;color:#9ca3af;font-weight:700;flex-shrink:0;">⏳</span>
          <div style="flex:1;min-width:0;">
            <div class="pv-batch-title" style="font-weight:500;color:#374151;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(label)}</div>
            <div class="pv-batch-meta" style="font-size:11.5px;color:#9ca3af;"></div>
          </div>`;
        rowsEl.appendChild(div);
        return div;
      });

      const counts = { ok: 0, duplicate: 0, error: 0 };

      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const node = rowNodes[i];
        const iconEl = node.querySelector('.pv-batch-icon');
        const titleEl = node.querySelector('.pv-batch-title');
        const metaEl = node.querySelector('.pv-batch-meta');
        iconEl.textContent = STATUS.loading.icon;
        iconEl.style.color = STATUS.loading.color;

        try {
          const r = await api('/articles/lookup', {
            method: 'POST',
            body: JSON.stringify(e),
          });
          if (!r.found) {
            iconEl.textContent = STATUS.error.icon;
            iconEl.style.color = STATUS.error.color;
            metaEl.textContent = 'No se encontraron metadatos';
            counts.error++;
            continue;
          }
          if (r.duplicate_of) {
            iconEl.textContent = STATUS.duplicate.icon;
            iconEl.style.color = STATUS.duplicate.color;
            titleEl.textContent = r.metadata.title || (e.doi || `PMID:${e.pubmed_id}`);
            metaEl.textContent = 'Ya existe en la biblioteca';
            counts.duplicate++;
            continue;
          }
          const m = r.metadata;
          const created = await api('/articles', {
            method: 'POST',
            body: JSON.stringify({
              title:     m.title,
              authors:   m.authors,
              year:      m.year,
              journal:   m.journal,
              doi:       m.doi || e.doi || null,
              pubmed_id: m.pubmed_id || e.pubmed_id || null,
              abstract:  m.abstract,
            }),
          });
          iconEl.textContent = STATUS.ok.icon;
          iconEl.style.color = STATUS.ok.color;
          titleEl.textContent = m.title || (e.doi || `PMID:${e.pubmed_id}`);
          const metaBits = [m.authors, m.year].filter(Boolean).join(' · ');
          metaEl.textContent = metaBits;
          counts.ok++;

          if (useUnpaywall && created && created.id && (m.doi || e.doi)) {
            try {
              const fp = await api(`/articles/${created.id}/fetch-pdf`, {
                method: 'POST',
              });
              if (fp.ok) {
                metaEl.textContent = (metaBits ? metaBits + ' · ' : '') +
                  `📄 PDF encolado (Unpaywall: ${esc(fp.host_type || 'OA')})`;
              } else {
                metaEl.textContent = (metaBits ? metaBits + ' · ' : '') +
                  `📄 sin PDF en open access (${esc(fp.reason || 'unknown')})`;
              }
            } catch (fpErr) {
              metaEl.textContent = (metaBits ? metaBits + ' · ' : '') +
                `📄 Unpaywall falló (${esc(fpErr.message)})`;
            }
          }
        } catch (err) {
          if (err.status === 409) {
            iconEl.textContent = STATUS.duplicate.icon;
            iconEl.style.color = STATUS.duplicate.color;
            metaEl.textContent = 'Duplicado (DOI/PMID ya en la biblioteca)';
            counts.duplicate++;
          } else {
            iconEl.textContent = STATUS.error.icon;
            iconEl.style.color = STATUS.error.color;
            metaEl.textContent = err.message;
            counts.error++;
          }
        }
      }

      summary.innerHTML = `
        ${counts.ok        ? `<span style="color:#15803d;">✓ ${counts.ok} importado${counts.ok === 1 ? '' : 's'}</span>` : ''}
        ${counts.duplicate ? `<span style="color:#b45309;">△ ${counts.duplicate} duplicado${counts.duplicate === 1 ? '' : 's'}</span>` : ''}
        ${counts.error     ? `<span style="color:#b91c1c;">✗ ${counts.error} error${counts.error === 1 ? '' : 'es'}</span>` : ''}`;
      summary.style.display = 'flex';
      restartBtn.style.display = '';
    });
  }

  // ── Find duplicates ──────────────────────────────────────────────────
  function wireDuplicates() {
    const btn   = document.getElementById('btn-find-duplicates');
    const modal = document.getElementById('pv-dupes-modal');
    if (!btn || !modal) return;
    const closeBtn = document.getElementById('pv-dupes-close');
    const meta = document.getElementById('pv-dupes-meta');
    const list = document.getElementById('pv-dupes-list');

    function close() { modal.style.display = 'none'; }
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    btn.addEventListener('click', async () => {
      modal.style.display = 'flex';
      list.innerHTML = '';
      meta.textContent = 'Buscando duplicados…';
      try {
        const r = await api('/duplicates');
        if (!r.pairs.length) {
          meta.textContent = 'Sin duplicados detectados.';
          return;
        }
        meta.textContent = `${r.total} par${r.total === 1 ? '' : 'es'} sospechoso${r.total === 1 ? '' : 's'} encontrado${r.total === 1 ? '' : 's'} (ordenados por score).`;
        list.innerHTML = r.pairs.map(p => `
          <div style="border:1px solid #e5e7eb;border-radius:8px;padding:10px;margin-bottom:8px;background:#fafafa;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                ${p.reasons.map(r => `<span style="font-size:11px;padding:2px 7px;border-radius:5px;background:#fef3c7;color:#92400e;font-weight:600;">${esc(r)}</span>`).join('')}
              </div>
              <span style="font-size:11px;color:#6b7280;font-variant-numeric:tabular-nums;">score ${(p.score * 100).toFixed(0)}%</span>
            </div>
            ${[p.a, p.b].map(x => `
              <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;padding:6px 0;border-top:1px solid #f3f4f6;">
                <div style="flex:1;min-width:0;cursor:pointer;" data-open-aid="${esc(x.id)}">
                  <div style="font-size:13px;font-weight:600;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${supHtml(x.title || '(no title)')}</div>
                  <div style="font-size:11.5px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    ${esc(x.authors || '—')}${x.year ? ' · ' + x.year : ''}${x.journal ? ' · ' + esc(x.journal) : ''}
                  </div>
                  <div style="font-size:11px;color:#9ca3af;font-family:monospace;margin-top:2px;">
                    ${x.doi ? 'DOI ' + esc(x.doi) : ''}${x.doi && x.pubmed_id ? ' · ' : ''}${x.pubmed_id ? 'PMID ' + esc(x.pubmed_id) : ''}
                  </div>
                </div>
                <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">
                  <button class="pv-dup-open" data-aid="${esc(x.id)}"
                          style="padding:3px 8px;border-radius:5px;border:1px solid #d1d5db;background:white;font-size:11px;cursor:pointer;">Ver</button>
                  <button class="pv-dup-delete" data-aid="${esc(x.id)}"
                          style="padding:3px 8px;border-radius:5px;border:1px solid #fca5a5;background:white;color:#b91c1c;font-size:11px;cursor:pointer;">Borrar</button>
                </div>
              </div>`).join('')}
          </div>
        `).join('');

        list.querySelectorAll('.pv-dup-open').forEach(b => {
          b.addEventListener('click', () => openDetail(b.dataset.aid));
        });
        list.querySelectorAll('[data-open-aid]').forEach(el => {
          el.addEventListener('click', () => openDetail(el.dataset.openAid));
        });
        list.querySelectorAll('.pv-dup-delete').forEach(b => {
          b.addEventListener('click', async () => {
            if (!confirm('¿Borrar este artículo definitivamente? Se elimina también el PDF de Dropbox.')) return;
            b.disabled = true;
            b.textContent = '…';
            try {
              await api(`/articles/${b.dataset.aid}`, { method: 'DELETE' });
              const card = b.closest('div[style*="border:1px solid #e5e7eb"]');
              if (card) card.style.opacity = '0.5';
              b.textContent = 'Borrado';
            } catch (e) {
              b.textContent = 'Error';
              b.disabled = false;
              alert('Error al borrar: ' + e.message);
            }
          });
        });
      } catch (e) {
        meta.textContent = 'Error: ' + e.message;
      }
    });
  }

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
              <td style="padding:6px 8px;font-size:11.5px;color:#9ca3af;font-variant-numeric:tabular-nums;">${i+1}</td>
              <td style="padding:6px 8px;font-size:11px;color:#15803d;font-weight:700;">✓</td>
              <td style="padding:6px 8px;font-size:11.5px;font-family:ui-monospace,monospace;color:#374151;
                         word-break:break-all;max-width:220px;">${inp}</td>
              <td style="padding:6px 8px;">
                <div style="font-size:13px;font-weight:600;color:#111827;">${supHtml(m.title || '(sin título)')}</div>
                <div style="font-size:11.5px;color:#6b7280;margin-top:1px;">${meta} ${badges}</div>
              </td>
            </tr>`;
        }
        const reason = it.kind === 'unknown'
          ? '<span style="color:#b91c1c;">Formato no reconocido</span>'
          : '<span style="color:#92400e;">No está en la biblioteca</span>';
        return `
          <tr style="border-bottom:1px solid #f3f4f6;">
            <td style="padding:6px 8px;font-size:11.5px;color:#9ca3af;font-variant-numeric:tabular-nums;">${i+1}</td>
            <td style="padding:6px 8px;font-size:11px;color:#b91c1c;font-weight:700;">✗</td>
            <td style="padding:6px 8px;font-size:11.5px;font-family:ui-monospace,monospace;color:#374151;
                       word-break:break-all;max-width:220px;">${inp}</td>
            <td style="padding:6px 8px;font-size:12px;">${reason}</td>
          </tr>`;
      }).join('');

      const notFoundList = (r.items || [])
        .filter(it => !it.match)
        .map(it => it.input)
        .join('\n');

      const copyBtn = notFoundList
        ? `<button id="pv-bulk-lookup-copy" type="button"
                   style="padding:5px 11px;border-radius:6px;border:1px solid #d1d5db;background:white;
                          font-size:11.5px;color:#374151;cursor:pointer;">
            <i class="fas fa-clipboard"></i> Copiar los que no están (${notFound + bad})
          </button>`
        : '';

      resultsEl.innerHTML = summary +
        `<div style="max-height:420px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:8px;">
           <table style="width:100%;border-collapse:collapse;font-size:13px;">
             <thead style="background:#f9fafb;position:sticky;top:0;">
               <tr style="text-align:left;color:#6b7280;font-size:10.5px;
                          text-transform:uppercase;letter-spacing:0.04em;">
                 <th style="padding:8px;border-bottom:1px solid #e5e7eb;width:40px;">#</th>
                 <th style="padding:8px;border-bottom:1px solid #e5e7eb;width:30px;"></th>
                 <th style="padding:8px;border-bottom:1px solid #e5e7eb;width:220px;">Input</th>
                 <th style="padding:8px;border-bottom:1px solid #e5e7eb;">Artículo</th>
               </tr>
             </thead>
             <tbody>${rows}</tbody>
           </table>
         </div>
         <div style="display:flex;justify-content:flex-end;margin-top:10px;">${copyBtn}</div>`;

      // Click row → open detail for the matched article.
      resultsEl.querySelectorAll('tr[data-aid]').forEach(tr => {
        tr.addEventListener('click', () => {
          modal.style.display = 'none';
          openDetail(tr.dataset.aid);
        });
      });
      // Copy not-found list.
      const cb = document.getElementById('pv-bulk-lookup-copy');
      if (cb) cb.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(notFoundList);
          cb.innerHTML = '<i class="fas fa-check"></i> Copiado';
          setTimeout(() => {
            cb.innerHTML = '<i class="fas fa-clipboard"></i> Copiar los que no están (' +
                           (notFound + bad) + ')';
          }, 1800);
        } catch (e) { alert('No se pudo copiar: ' + e.message); }
      });
    }
  }

  function wireBatchSummary() {
    const btn   = document.getElementById('btn-batch-summary');
    const modal = document.getElementById('pv-batch-summary-modal');
    if (!btn || !modal) return;
    const closeBtn   = document.getElementById('pv-batch-summary-close');
    const startBtn   = document.getElementById('pv-bs-start');
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

    function statCard(label, value, color) {
      return `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;">
                <div style="font-size:10.5px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${esc(label)}</div>
                <div style="font-size:18px;font-weight:700;color:${color || '#111827'};font-variant-numeric:tabular-nums;">${esc(value)}</div>
              </div>`;
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
        statCard('Con resumen',    lib.with_summary ?? 0, '#15803d') +
        statCard('Pendientes',     lib.eligible ?? 0, '#b45309');

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
        progLabel.textContent =
          (runLabel ? `[${runLabel}] ` : '') +
          `${done} / ${total} procesados ` +
          (s.failed ? `(${s.failed} con error) ` : '') +
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
        const eligible    = lib.eligible || 0;
        const selectionN  = (window.PV_SUMMARY_SELECTION || []).length;
        const provMeta    = providerMeta[selectedProvider];
        const provReady   = !!(provMeta && provMeta.configured);
        const effective   = selectionN > 0 ? selectionN : eligible;
        startBtn.disabled = effective === 0 || !provReady;
        startBtn.style.opacity = startBtn.disabled ? '0.5' : '1';
        if (!provReady) {
          startBtn.textContent = 'Elige un proveedor';
        } else if (selectionN > 0) {
          startBtn.textContent = `Resumir ${selectionN} seleccionado${selectionN === 1 ? '' : 's'} con ${provMeta.label}`;
        } else {
          startBtn.textContent = eligible > 0
            ? `Start con ${provMeta.label} (${eligible} pendiente${eligible === 1 ? '' : 's'})`
            : 'Start';
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
        errorEl.style.display = 'block';
        errorEl.textContent = 'Último error: ' + s.last_error;
      } else {
        errorEl.style.display = 'none';
      }

      const cost = (s.total_cost_usd || 0).toFixed(3);
      const tin  = s.total_tokens_in  || 0;
      const tout = s.total_tokens_out || 0;
      costEl.textContent = (s.processed || 0) > 0
        ? `Coste esta sesión: $${cost} · ${tin} in / ${tout} out tokens`
        : '';
    }

    startBtn.addEventListener('click', async () => {
      if (!selectedProvider) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Elige un proveedor de IA antes de empezar.';
        return;
      }
      startBtn.disabled = true;
      const selectionIds = window.PV_SUMMARY_SELECTION || null;
      try {
        const body = { provider: selectedProvider };
        if (selectionIds && selectionIds.length) body.ids = selectionIds;
        await api('/admin/batch-summary/start', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        // Selection is consumed by Start — clear it so closing/reopening
        // the modal goes back to the default "all pending" behaviour.
        window.PV_SUMMARY_SELECTION = null;
        refresh();
        startPolling();
      } catch (e) {
        startBtn.disabled = false;
        if (e.status === 409) {
          // Already running — just refresh
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
            <div style="font-size:12px;color:#4b5563;background:#f9fafb;border-radius:6px;
                        padding:6px 8px;margin-top:5px;line-height:1.55;
                        max-height:120px;overflow-y:auto;">${esc(c.extract)}</div>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.pv-rag-open').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        openDetail(a.dataset.aid);
      });
    });
  }

  async function runRagSearch(query) {
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
        body: JSON.stringify({ query, provider }),
      });
      ansEl.style.color = '#1f2937';
      // Render answer with inline citation hyperlinks
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

      renderRagCitations(r.citations || [], r.cited_numbers || []);

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
    const statsEl    = document.getElementById('pv-bi-stats');
    const progWrap   = document.getElementById('pv-bi-progress-wrap');
    const progLabel  = document.getElementById('pv-bi-progress-label');
    const progBar    = document.getElementById('pv-bi-progress-bar');
    const progPct    = document.getElementById('pv-bi-progress-percent');
    const currentEl  = document.getElementById('pv-bi-current');
    const errorEl    = document.getElementById('pv-bi-error');
    const costEl     = document.getElementById('pv-bi-cost');
    const modelEl    = document.getElementById('pv-bi-model');

    let pollHandle = null;
    function stopPolling() { if (pollHandle) { clearInterval(pollHandle); pollHandle = null; } }
    function startPolling() { stopPolling(); pollHandle = setInterval(refresh, 1800); }
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
        s = await api('/admin/batch-index/status');
      } catch (e) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Error consultando estado: ' + e.message;
        return;
      }
      if (modelEl && s.embed_model) modelEl.textContent = s.embed_model;
      const lib = s.library_stats || {};
      statsEl.innerHTML =
        statCard('Total',       lib.total ?? 0) +
        statCard('Indexables',  lib.indexable ?? 0) +
        statCard('Indexados',   lib.indexed ?? 0, '#15803d') +
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

      countersEl.textContent = (s.processed || 0) > 0
        ? `Sesión: ${fmtMB(s.bytes_uploaded)} MB subidos a Dropbox`
        : '';
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
  }

  document.addEventListener('DOMContentLoaded', init);
})();
