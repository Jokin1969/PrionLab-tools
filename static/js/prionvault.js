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
    isJc: null,          // null = all, true = only Journal Club, false = non-JC
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
    searchFields:   [],  // [] = all fields; else subset of ['title','authors','abstract']
    page: 1,
    // Anyone who had the old "todos" (50000, now removed) stored is brought
    // back to 100 so they don't keep loading the whole catalogue every visit.
    size: (() => { const n = parseInt(localStorage.getItem('pv-page-size') || '100', 10) || 100;
                   return n > 2000 ? 100 : n; })(),
    // selectedIds: a Set that ALSO syncs every change to the server
    // (table: prionvault_user_selection) so the operator's ticks
    // survive refresh, browser switch and server deploys. Starts as
    // a plain Set so any early read can't crash; gets promoted to
    // a _TrackedSelectionSet later (preserving values, if any) once
    // that class exists.
    selectedIds: new Set(),
    // When true, the listing only shows articles in selectedIds — drives
    // the "🔍 Ver sólo seleccionados" toggle in the bulk bar. Persists
    // across modal opens/closes (e.g. picking articles inside the PMID
    // manual list and then surfacing them in the main grid).
    filterSelectedOnly: false,
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

  // Sticky-note colours, assigned by creation order (index 0..4). The
  // colour is NOT user-chosen: 1st note amarilla, 2nd azul, 3rd verde,
  // 4th morada, 5th naranja. Max 5 notes per article per user.
  const PV_NOTE_COLORS = [
    { bg: '#fef9c3', text: '#713f12', name: 'Amarilla' },
    { bg: '#dbeafe', text: '#1e3a8a', name: 'Azul' },
    { bg: '#dcfce7', text: '#14532d', name: 'Verde' },
    { bg: '#f3e8ff', text: '#6b21a8', name: 'Morada' },
    { bg: '#ffedd5', text: '#7c2d12', name: 'Naranja' },
  ];
  const PV_MAX_NOTES = 5;

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
      set('count-notes',      s.with_notes ?? 0);
    } catch (e) { console.error(e); }
  }

  // ── render: tags ───────────────────────────────────────────────────────
  // ── Collections (manual groupings) ────────────────────────────────────
  // Cache the full set of collections so the editor's "group"/"subgroup"
  // datalists can suggest existing labels without a second fetch.
  let _allCollections = [];

  // ── Per-user article selection: persisted across refresh / browser
  // / deploy via /api/user-selection (backed by Postgres) with a
  // localStorage fallback for the unauthenticated edge case. ──────────
  const _SEL_LS_KEY      = 'pv-selected-ids';
  const _SEL_DEBOUNCE_MS = 800;
  let _selBackend        = 'server';   // 'server' | 'local' — flips
                                       // when a /user-selection call
                                       // returns 401/403.
  let _selPending        = { add: new Set(), remove: new Set() };
  let _selTimer          = null;

  function _flushSelectionToLocal() {
    try {
      const arr = Array.from(state.selectedIds || []);
      localStorage.setItem(_SEL_LS_KEY, JSON.stringify(arr));
    } catch (_) { /* quota / disabled — silent */ }
  }

  async function _flushSelectionSync() {
    _selTimer = null;
    if (_selBackend !== 'server') { _flushSelectionToLocal(); return; }
    const add    = Array.from(_selPending.add);
    const remove = Array.from(_selPending.remove);
    _selPending.add.clear();
    _selPending.remove.clear();
    if (!add.length && !remove.length) return;
    try {
      await api('/user-selection', {
        method: 'POST',
        body: JSON.stringify({ add, remove }),
      });
    } catch (e) {
      // Auth failure → fall back to localStorage from here on so the
      // operator's clicks still survive a refresh, even if not across
      // browsers. Any other error is logged and the changes go back
      // into the pending bag for the next attempt.
      if (e && (e.status === 401 || e.status === 403)) {
        _selBackend = 'local';
        _flushSelectionToLocal();
      } else {
        add.forEach(id => _selPending.add.add(id));
        remove.forEach(id => _selPending.remove.add(id));
        console.warn('user-selection sync deferred:', e);
      }
    }
  }

  function _scheduleSelectionSync(diff) {
    if (diff.add)    diff.add.forEach(id    => {
      _selPending.add.add(id);
      _selPending.remove.delete(id);
    });
    if (diff.remove) diff.remove.forEach(id => {
      _selPending.remove.add(id);
      _selPending.add.delete(id);
    });
    if (_selTimer) clearTimeout(_selTimer);
    _selTimer = setTimeout(_flushSelectionSync, _SEL_DEBOUNCE_MS);
  }

  // Subclass of Set whose mutators piggyback a debounced server sync.
  // Use `addSilently` / `clearSilently` from the hydration path so the
  // round-trip that brought us the data doesn't bounce right back.
  class _TrackedSelectionSet extends Set {
    add(value) {
      const had = this.has(value);
      const r = super.add(value);
      if (!had && value) _scheduleSelectionSync({ add: [value] });
      return r;
    }
    delete(value) {
      const had = this.has(value);
      const r = super.delete(value);
      if (had) _scheduleSelectionSync({ remove: [value] });
      return r;
    }
    clear() {
      if (this.size === 0) return super.clear();
      super.clear();
      // Cheaper to PUT an empty list than DELETE then queue future
      // adds against a phantom row count. Use the dedicated endpoint.
      if (_selBackend === 'server') {
        api('/user-selection', { method: 'DELETE' }).catch(e => {
          if (e && (e.status === 401 || e.status === 403)) {
            _selBackend = 'local';
          }
          _flushSelectionToLocal();
        });
      } else {
        _flushSelectionToLocal();
      }
      _selPending.add.clear();
      _selPending.remove.clear();
      if (_selTimer) { clearTimeout(_selTimer); _selTimer = null; }
    }
    // Internal: populate without firing the sync — used by the
    // initial hydrate from /api/user-selection.
    addSilently(value) { return super.add(value); }
    clearSilently()    { return super.clear();     }
  }

  // Promote the placeholder Set in state.selectedIds (initialised
  // up top) to a TrackedSet now that the class exists. Anything that
  // was already in there during early module init is preserved.
  if (!(state.selectedIds instanceof _TrackedSelectionSet)) {
    const _prev = state.selectedIds;
    state.selectedIds = new _TrackedSelectionSet();
    if (_prev && _prev.forEach) _prev.forEach(v => state.selectedIds.addSilently(v));
  }

  // Hydrate the in-memory selection from the server (or localStorage
  // fallback) once at boot. Called from the bootstrap before
  // loadArticles() so the first render's checkboxes paint with the
  // correct ticked state.
  async function _hydrateSelection() {
    state.selectedIds.clearSilently();
    try {
      const r = await api('/user-selection');
      (r.items || []).forEach(id => state.selectedIds.addSilently(id));
      _selBackend = 'server';
    } catch (e) {
      if (e && (e.status === 401 || e.status === 403)) {
        _selBackend = 'local';
      }
      // Whatever the failure, try localStorage so the operator's
      // last session's ticks aren't lost on a network blip.
      try {
        const raw = localStorage.getItem(_SEL_LS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        if (Array.isArray(arr)) {
          arr.forEach(id => id && state.selectedIds.addSilently(id));
        }
      } catch (_) { /* localStorage disabled — empty selection */ }
    }
  }

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

  // Cache of the most recent rollup so synchronous render helpers
  // (buildGroupHeader / buildSubgroupHeader) can read the deduplicated
  // counts without a separate fetch per row. Refreshed alongside the
  // collection list itself in refreshCollections().
  let _collRollup = { group_count: 0, groups: {} };

  async function refreshCollections() {
    const container = document.getElementById('collection-list');
    if (!container) return;
    let items = [];
    try {
      // Fan-out: the rollup is a separate query because /collections
      // (lightweight, per-collection) is hit by other components too,
      // while /collections/rollup does the deduplicating aggregation.
      // Running them in parallel keeps the sidebar load time bounded
      // by the slower of the two, not the sum.
      const [list, rollup] = await Promise.all([
        api('/collections'),
        api('/collections/rollup').catch(e => {
          console.warn('collections rollup failed (using raw counts):', e);
          return { group_count: 0, groups: {} };
        }),
      ]);
      items = list.items || [];
      _collRollup = rollup || { group_count: 0, groups: {} };
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
    // The chip used to show _allCollections.length — the number of
    // leaf collections — which felt off because the user thinks of
    // "Colecciones" as the count of top-level groups, not folders.
    // Now mirrors rollup.group_count (distinct groups). Ungrouped
    // collections still appear in the list under "Sin grupo" but
    // don't contribute to the headline number.
    const n = _collRollup.group_count || 0;
    span.textContent = n > 0 ? `(${n})` : '';
  }

  function buildGroupHeader(group, subBranch, collapsed) {
    // Chip shows the count of DISTINCT SUBGROUPS under this group
    // (so "PrionPacks" reports "3" — PRP-001, PRP-002, PRP-003 —
    // not the sum of articles across them, not the number of leaf
    // collections). The tooltip retains the deeper breakdown so the
    // numerical context is still one hover away.
    const colls = Object.values(subBranch).flat();
    const collCount = colls.length;
    const r = (_collRollup.groups || {})[group] || {};
    const subgroupCount  = r.subgroup_count  ?? Object.keys(subBranch).filter(k => k).length;
    const uniqueArticles = r.unique_articles ?? 0;
    const chipNumber = subgroupCount;   // headline number
    const btn = document.createElement('button');
    btn.className = 'pv-nav-btn';
    btn.dataset.collectionGroup = group;
    btn.title = `Filtrar por grupo "${group}" — ` +
                `${subgroupCount} subgrupo${subgroupCount === 1 ? '' : 's'}, ` +
                `${collCount} colección${collCount === 1 ? '' : 'es'} en total, ` +
                `${uniqueArticles} artículo${uniqueArticles === 1 ? '' : 's'} únicos.\n` +
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
      <span style="font-size:10px;background:rgba(255,255,255,0.14);padding:1px 7px;border-radius:20px;flex-shrink:0;">${chipNumber}</span>
      ${IS_ADMIN ? `<span class="pv-coll-del"
            data-group="${esc(group)}"
            title="Borrar este grupo y todas sus colecciones (${collCount})"
            style="display:inline-flex;align-items:center;justify-content:center;
                   width:18px;height:18px;border-radius:4px;flex-shrink:0;margin-left:2px;
                   color:rgba(255,255,255,0.35);cursor:pointer;visibility:hidden;"
            onmouseover="this.style.background='rgba(239,68,68,0.25)';this.style.color='#fecaca';"
            onmouseout="this.style.background='transparent';this.style.color='rgba(255,255,255,0.35)';"
      ><i class="fas fa-times" style="font-size:10px;"></i></span>` : ''}
    `;
    // Reveal the × on hover of the row.
    if (IS_ADMIN) {
      btn.addEventListener('mouseenter', () => {
        const x = btn.querySelector('.pv-coll-del');
        if (x) x.style.visibility = 'visible';
      });
      btn.addEventListener('mouseleave', () => {
        const x = btn.querySelector('.pv-coll-del');
        if (x) x.style.visibility = 'hidden';
      });
    }
    btn.addEventListener('click', (ev) => {
      // Chevron toggles collapse state without changing the filter.
      if (ev.target.closest('.pv-coll-chevron')) {
        ev.preventDefault();
        _toggleCollapsed(_COLL_GROUPS_KEY, group);
        refreshCollections();
        return;
      }
      // × wipes the whole group (admin only).
      if (ev.target.closest('.pv-coll-del')) {
        ev.preventDefault();
        ev.stopPropagation();
        _deleteCollectionGroup({ group, subgroup: null, count: collCount });
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

  // Admin: delete every collection under a group (or group+subgroup).
  // Wired by the × that shows on hover next to group / subgroup headers.
  // Cascade-deletes membership rows via the FK; the underlying article
  // rows are NEVER touched, only their collection membership.
  async function _deleteCollectionGroup({ group, subgroup, count }) {
    if (!group) return;
    const what = subgroup ? `el subgrupo «${subgroup}»` : `el grupo «${group}»`;
    const msg =
      `Vas a borrar ${what} y sus ${count} colección${count === 1 ? '' : 'es'}.\n\n` +
      '• Las filas de las colecciones desaparecen de la sidebar.\n' +
      '• Los artículos NO se borran — sólo se desvincula la pertenencia.\n' +
      '• Las anotaciones / tags de cada artículo siguen igual.\n\n' +
      'Esta acción no se puede deshacer desde la app. ¿Continuar?';
    if (!confirm(msg)) return;
    const params = new URLSearchParams({ group });
    if (subgroup) params.set('subgroup', subgroup);
    try {
      const r = await api('/admin/collections/group?' + params.toString(),
                          { method: 'DELETE' });
      refreshCollections();
      // Clear active filter if it pointed at the deleted group/subgroup.
      if (state.collectionGroup === group &&
          (subgroup ? state.collectionSubgroup === subgroup : true)) {
        state.collectionGroup    = null;
        state.collectionSubgroup = null;
        state.collectionId       = null;
        loadArticles();
        refreshFilterIndicators();
      }
      // Tiny toast in lieu of a dedicated notifier — alert is the
      // least intrusive option without adding a notification system.
      console.log(`Borradas ${r.deleted} colecciones de ${what}.`);
    } catch (e) {
      alert('Error al borrar: ' + e.message);
    }
  }

  function buildSubgroupHeader(group, subgroup, colls, collapsed) {
    // Chip shows the count of DISTINCT ARTICLES across every leaf
    // collection under (group, subgroup) — deduplicating the case
    // where the same paper sits in two child folders. So a subgroup
    // with one folder of 15 papers and another of 11 (4 shared)
    // chips "17", not "26".
    const collCount     = colls.length;
    const rg = (_collRollup.groups || {})[group] || {};
    const rs = (rg.subgroups || {})[subgroup] || {};
    // Fallback: if the rollup wasn't loaded yet (first paint), use
    // the raw sum so the user sees *something* rather than 0.
    const uniqueArticles = (rs.unique_articles ?? null);
    const rawTotal       = colls.reduce((acc, c) => acc + (c.article_count || 0), 0);
    const chipNumber     = uniqueArticles ?? rawTotal;
    const btn = document.createElement('button');
    btn.className = 'pv-nav-btn';
    btn.dataset.collectionGroup    = group;
    btn.dataset.collectionSubgroup = subgroup;
    btn.title = `Filtrar por "${group} · ${subgroup}" — ` +
                `${chipNumber} artículo${chipNumber === 1 ? '' : 's'} únicos ` +
                `en ${collCount} colección${collCount === 1 ? '' : 'es'} ` +
                `(suma bruta: ${rawTotal}).\n` +
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
      <span style="font-size:10px;background:rgba(255,255,255,0.14);padding:1px 7px;border-radius:20px;flex-shrink:0;">${chipNumber}</span>
      ${IS_ADMIN ? `<span class="pv-coll-del"
            data-group="${esc(group)}" data-subgroup="${esc(subgroup)}"
            title="Borrar este subgrupo y sus ${collCount} colección(es)"
            style="display:inline-flex;align-items:center;justify-content:center;
                   width:16px;height:16px;border-radius:4px;flex-shrink:0;margin-left:2px;
                   color:rgba(255,255,255,0.3);cursor:pointer;visibility:hidden;"
            onmouseover="this.style.background='rgba(239,68,68,0.25)';this.style.color='#fecaca';"
            onmouseout="this.style.background='transparent';this.style.color='rgba(255,255,255,0.3)';"
      ><i class="fas fa-times" style="font-size:9px;"></i></span>` : ''}
    `;
    if (IS_ADMIN) {
      btn.addEventListener('mouseenter', () => {
        const x = btn.querySelector('.pv-coll-del');
        if (x) x.style.visibility = 'visible';
      });
      btn.addEventListener('mouseleave', () => {
        const x = btn.querySelector('.pv-coll-del');
        if (x) x.style.visibility = 'hidden';
      });
    }
    btn.addEventListener('click', (ev) => {
      if (ev.target.closest('.pv-coll-chevron')) {
        ev.preventDefault();
        _toggleCollapsed(_COLL_SUBGROUPS_KEY, `${group}::${subgroup}`);
        refreshCollections();
        return;
      }
      if (ev.target.closest('.pv-coll-del')) {
        ev.preventDefault();
        ev.stopPropagation();
        _deleteCollectionGroup({ group, subgroup, count: collCount });
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
  let _listIds = [];   // IDs in current page order — used for detail modal nav

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
      let r;
      if (state.filterSelectedOnly && state.selectedIds.size > 50) {
        // Send IDs in the POST body to avoid Railway/nginx URI length limits.
        const body = Object.fromEntries(params.entries());
        body.ids = Array.from(state.selectedIds);
        r = await api('/articles', { method: 'POST', body: JSON.stringify(body) });
      } else {
        r = await api('/articles?' + params.toString());
      }
      document.getElementById('pv-result-count').textContent =
        r.total + ' result' + (r.total === 1 ? '' : 's');
      document.getElementById('pv-result-page').textContent =
        'page ' + r.page + ' / ' + Math.max(1, Math.ceil(r.total / r.size));

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

  function _paintOnlySelectedBtn() {
    ['', '-top'].forEach(s => {
      const btn = document.getElementById('pv-bulk-only-selected' + s);
      const lbl = document.getElementById('pv-bulk-only-selected-label' + s);
      if (!btn || !lbl) return;
      if (state.filterSelectedOnly) {
        btn.style.background    = 'white';
        btn.style.color         = '#0F3460';
        btn.style.borderColor   = 'white';
        lbl.textContent = '✓ Mostrando sólo seleccionados — clic para ver todos';
      } else {
        btn.style.background    = 'rgba(255,255,255,0.14)';
        btn.style.color         = 'white';
        btn.style.borderColor   = 'rgba(255,255,255,0.25)';
        lbl.textContent = '🔍 Ver sólo seleccionados';
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
        <span id="pv-bulk-only-selected-label${s}">🔍 Ver sólo seleccionados</span>
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

  // ── Build the list query params (shared by loadArticles + fetchAllFilteredIds) ──
  // When filterSelectedOnly is active with >50 IDs the caller must use POST
  // (IDs go in the request body to avoid Railway URI length limits).
  // For ≤50 IDs the ids=... query param is short enough for a GET.
  function buildListParams() {
    const params = new URLSearchParams();
    if (state.filterSelectedOnly && state.selectedIds.size <= 50) {
      params.set('ids', Array.from(state.selectedIds).join(','));
    }
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
    if (state.isJc       !== null) params.set('is_jc',       state.isJc       ? '1' : '0');
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
    if (state.searchFields && state.searchFields.length)
                                   params.set('search_fields', state.searchFields.join(','));
    // Health-dashboard extra filters (transient, consumed once)
    if (state._healthExtra) {
      for (const [k, v] of Object.entries(state._healthExtra)) params.set(k, v);
      state._healthExtra = null;
    }
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

  // ── Manual PDF upload (for articles where OA fetch failed) ─────────────
  function _wireManualUploadBtn(btn, a) {
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _openManualPdfUpload(a.id, a.title || '(sin título)', btn);
    });
  }

  function _openManualPdfUpload(aid, title, triggerBtn) {
    const existing = document.getElementById('pv-manual-pdf-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'pv-manual-pdf-modal';
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.45);
      z-index:9999;display:flex;align-items:center;justify-content:center;`;

    overlay.innerHTML = `
      <div style="background:#fff;border-radius:10px;padding:28px 28px 24px;
                  max-width:500px;width:calc(100% - 32px);box-shadow:0 8px 32px rgba(0,0,0,0.22);">
        <div style="font-size:15px;font-weight:700;color:#111827;margin-bottom:6px;">
          Subir PDF manualmente
        </div>
        <div style="font-size:12px;color:#6b7280;margin-bottom:18px;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
             title="${esc(title)}">${esc(title.slice(0, 80))}${title.length > 80 ? '…' : ''}</div>

        <!-- Drop zone -->
        <div id="pv-pdf-dropzone"
             style="border:2.5px dashed #93c5fd;border-radius:10px;padding:32px 16px;
                    text-align:center;cursor:pointer;transition:background 0.15s,border-color 0.15s;
                    margin-bottom:14px;background:#f0f7ff;">
          <div style="font-size:32px;margin-bottom:8px;">☁️</div>
          <div style="font-size:14px;font-weight:600;color:#1d4ed8;margin-bottom:4px;">
            Suelta el PDF aquí
          </div>
          <div style="font-size:12px;color:#6b7280;margin-bottom:12px;">o usa el botón de abajo</div>
          <label id="pv-pdf-file-label"
                 style="display:inline-block;padding:6px 18px;border-radius:6px;
                        border:1px solid #3b82f6;background:#fff;color:#2563eb;
                        font-size:12px;font-weight:600;cursor:pointer;">
            Seleccionar archivo PDF
            <input type="file" id="pv-manual-pdf-input" accept=".pdf,application/pdf"
                   style="display:none;">
          </label>
        </div>
        <div id="pv-pdf-selected-name"
             style="font-size:12px;color:#374151;min-height:16px;margin-bottom:10px;
                    text-align:center;font-style:italic;"></div>

        <!-- Progress / status -->
        <div id="pv-manual-pdf-status" style="font-size:13px;min-height:20px;margin-bottom:14px;
                                               text-align:center;"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button id="pv-manual-pdf-cancel"
                  style="padding:7px 16px;border-radius:6px;border:1px solid #d1d5db;
                         background:#fff;color:#374151;font-size:13px;cursor:pointer;">
            Cancelar
          </button>
          <button id="pv-manual-pdf-submit"
                  style="padding:7px 18px;border-radius:6px;border:none;
                         background:#2563eb;color:#fff;font-size:13px;font-weight:600;cursor:pointer;">
            Subir PDF
          </button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const dropzone   = overlay.querySelector('#pv-pdf-dropzone');
    const fileInput  = overlay.querySelector('#pv-manual-pdf-input');
    const nameDiv    = overlay.querySelector('#pv-pdf-selected-name');
    const statusDiv  = overlay.querySelector('#pv-manual-pdf-status');
    const submitBtn  = overlay.querySelector('#pv-manual-pdf-submit');
    const cancelBtn  = overlay.querySelector('#pv-manual-pdf-cancel');
    let   chosenFile = null;

    const setFile = (f) => {
      if (!f) return;
      chosenFile = f;
      nameDiv.textContent = '📄 ' + f.name;
      statusDiv.textContent = '';
    };

    // File picker
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });

    // Drag-and-drop
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.style.background = '#dbeafe';
      dropzone.style.borderColor = '#2563eb';
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.style.background = '#f0f7ff';
      dropzone.style.borderColor = '#93c5fd';
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.style.background = '#f0f7ff';
      dropzone.style.borderColor = '#93c5fd';
      const f = e.dataTransfer.files[0];
      if (f && (f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf')) {
        setFile(f);
      } else if (f) {
        statusDiv.textContent = 'El archivo debe ser un PDF.';
        statusDiv.style.color = '#b91c1c';
      }
    });

    const close = () => overlay.remove();
    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const setStatus = (msg, color) => {
      statusDiv.textContent = msg;
      statusDiv.style.color = color || '#374151';
    };

    submitBtn.addEventListener('click', async () => {
      const file = chosenFile || fileInput.files[0];
      if (!file) {
        setStatus('Selecciona un archivo PDF primero.', '#b91c1c');
        return;
      }
      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
        setStatus('El archivo debe ser un PDF.', '#b91c1c');
        return;
      }

      submitBtn.disabled = true;
      cancelBtn.disabled = true;
      setStatus('📤 Enviando al servidor…', '#2563eb');

      // Simulate progress steps while the synchronous upload runs
      let step = 0;
      const steps = ['📤 Enviando al servidor…', '☁️ Guardando en Dropbox…'];
      const stepTimer = setInterval(() => {
        step = Math.min(step + 1, steps.length - 1);
        setStatus(steps[step], '#2563eb');
      }, 3500);

      const fd = new FormData();
      fd.append('file', file);
      try {
        const r = await fetch(`/prionvault/api/articles/${encodeURIComponent(aid)}/upload-pdf`, {
          method: 'POST',
          credentials: 'same-origin',
          body: fd,
        });
        clearInterval(stepTimer);
        const d = await r.json().catch(() => ({}));

        if (r.ok) {
          setStatus('✓ PDF subido correctamente.', '#15803d');
          submitBtn.textContent = '✓ Listo';
          if (triggerBtn) {
            const td = triggerBtn.closest('td');
            if (td) {
              td.innerHTML = `<img class="pv-thumb"
                src="/prionvault/api/articles/${encodeURIComponent(aid)}/thumbnail?_=${Date.now()}"
                loading="lazy" alt=""
                style="display:block;width:34px;height:44px;object-fit:cover;
                       object-position:top center;border-radius:3px;
                       border:1px solid #e5e7eb;cursor:zoom-in;"
                onerror="this.style.display='none'">`;
            }
          }
          setTimeout(close, 1400);
        } else if (d.error === 'duplicate_pdf') {
          const dupId = d.duplicate_of || '';
          const dupLink = dupId
            ? `<br><a href="?open=${encodeURIComponent(dupId)}" target="_blank"
                  style="display:inline-block;margin-top:8px;padding:5px 14px;
                         border-radius:6px;border:1px solid #d97706;background:#fffbeb;
                         color:#92400e;font-size:12px;font-weight:600;text-decoration:none;">
                 🔍 Ver el artículo que ya lo tiene
               </a>`
            : '';
          statusDiv.innerHTML =
            `<span style="color:#b45309;">⚠️ Este PDF ya existe en la biblioteca.</span><br>
             <span style="font-size:12px;color:#6b7280;">Otro artículo ya tiene este mismo PDF.</span>` +
            dupLink;
          submitBtn.disabled = false;
          submitBtn.textContent = 'Subir PDF';
          cancelBtn.disabled = false;
        } else if (d.error === 'already_has_pdf') {
          setStatus('⚠️ Este artículo ya tiene un PDF asociado.', '#b45309');
          submitBtn.disabled = false;
          submitBtn.textContent = 'Subir PDF';
          cancelBtn.disabled = false;
        } else {
          setStatus('Error: ' + (d.detail || d.error || r.status), '#b91c1c');
          submitBtn.disabled = false;
          submitBtn.textContent = 'Subir PDF';
          cancelBtn.disabled = false;
        }
      } catch (err) {
        clearInterval(stepTimer);
        setStatus('Error de red: ' + err.message, '#b91c1c');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Subir PDF';
        cancelBtn.disabled = false;
      }
    });
  }

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
      `<button type="button" class="pv-email-row-btn" data-aid="${esc(a.id)}"
                title="Enviar este artículo por email (datos + resumen IA)"
                style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:4px;
                       font-size:10.5px;font-weight:600;background:#eef2ff;color:#4f46e5;
                       border:none;cursor:pointer;line-height:1.2;"><i class="fas fa-paper-plane"></i></button>`,
      `<button type="button" class="pv-chat-row-btn" data-aid="${esc(a.id)}"
                title="Preguntar a la IA sobre este artículo"
                style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:4px;
                       font-size:10.5px;font-weight:600;background:#0F3460;color:#fff;
                       border:none;cursor:pointer;line-height:1.2;">🤖 Chat</button>`,
      IS_ADMIN
        ? `<button type="button" class="pv-edit-row-btn" data-aid="${esc(a.id)}"
                    title="${a.pubmed_id ? 'Editar artículo + abrir PubMed en otra pestaña' : 'Editar artículo'}"
                    style="display:inline-flex;align-items:center;gap:2px;padding:1px 6px;border-radius:4px;
                           font-size:10.5px;font-weight:600;background:#ede9fe;color:#6d28d9;
                           border:none;cursor:pointer;line-height:1.2;">✏ Editar</button>`
        : '',
      a.has_summary_ai
        ? (() => {
            const p = a.summary_ai_provider;
            if (p === 'anthropic') return '<span title="Resumen generado por Claude (Anthropic)" style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#ede9fe;color:#5b21b6;">✦ Claude</span>';
            if (p === 'openai')    return '<span title="Resumen generado por GPT (OpenAI)" style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#dcfce7;color:#15803d;">⬡ GPT</span>';
            if (p === 'gemini')    return '<span title="Resumen generado por Gemini (Google)" style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#dbeafe;color:#1d4ed8;">◈ Gemini</span>';
            return '<span title="Resumen IA (proveedor desconocido)" style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#f3f4f6;color:#374151;">AI ✓</span>';
          })()
        : '',
      (IS_ADMIN && a.has_summary_ai && (a.summary_tokens_in || a.summary_tokens_out))
        ? (() => {
            const tin  = a.summary_tokens_in  || 0;
            const tout = a.summary_tokens_out || 0;
            const total = tin + tout;
            const label = total >= 1000 ? (total / 1000).toFixed(1) + 'k tk' : total + ' tk';
            return `<span title="Tokens resumen: ${tin.toLocaleString()} entrada / ${tout.toLocaleString()} salida"
                          style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:500;background:#f3f4f6;color:#6b7280;">${label}</span>`;
          })()
        : '',
      a.indexed_at
        ? (IS_ADMIN
            ? `<button type="button" class="pv-indexed-chip" data-aid="${esc(a.id)}"
                        title="Indexado por Voyage el ${esc((a.indexed_at || '').slice(0, 10))} — clic para ver los chunks (qué texto se embebió y dónde)"
                        style="display:inline-flex;align-items:center;padding:1px 6px;border-radius:4px;
                               font-size:10.5px;font-weight:600;background:#dcfce7;color:#15803d;
                               border:none;cursor:pointer;line-height:1.2;">indexed</button>`
            : '<span style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#dcfce7;color:#15803d;">indexed</span>')
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
      (IS_ADMIN && a.pdf_verify_status === 'mismatch')
        ? `<button type="button" class="pv-verify-chip" data-aid="${esc(a.id)}" data-status="mismatch"
                   title="La IA detectó una discrepancia entre los metadatos del artículo y el contenido del PDF"
                   style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#fee2e2;color:#b91c1c;border:none;cursor:pointer;">✗ Mismatch</button>`
        : '',
      (IS_ADMIN && a.pdf_verify_status === 'suspect')
        ? `<button type="button" class="pv-verify-chip" data-aid="${esc(a.id)}" data-status="suspect"
                   title="La IA tiene dudas sobre si el PDF corresponde a este artículo"
                   style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#fef3c7;color:#92400e;border:none;cursor:pointer;">⚠ Sospechoso</button>`
        : '',
      (IS_ADMIN && (a.pdf_verify_status === 'ok' || a.pdf_verify_status === 'manual_ok'))
        ? `<span title="${a.pdf_verify_status === 'manual_ok' ? 'Verificado manualmente como OK' : 'Verificado por IA: PDF coincide con los metadatos'}"
                  style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#d1fae5;color:#065f46;">✓ Match OK</span>`
        : '',
      // PubMed-inventory provenance + OA status. The same row can
      // carry both badges: provenance is set at import, OA state is
      // updated by the auto-fetcher once it tries.
      a.source === 'pubmed_inventory'
        ? `<span title="Importado desde Inventario PubMed${a.dropbox_path ? '' : ' — todavía sin PDF'}"
                 style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#e0e7ff;color:#3730a3;">📥 Inventario</span>`
        : '',
      (a.source === 'pubmed_inventory' && !a.has_pdf && a.pdf_oa_status === 'not_available')
        ? '<span title="El auto-fetcher ya consultó Unpaywall y PMC; no hay copia abierta. Tienes que conseguir el PDF a mano." style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#fee2e2;color:#b91c1c;">PDF: sin OA</span>'
        : '',
      (a.source === 'pubmed_inventory' && !a.has_pdf && !a.pdf_oa_status)
        ? '<span title="Importado sin PDF. El auto-fetcher lo buscará en breve (cada 60 s)." style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#fef3c7;color:#92400e;">⏳ PDF pendiente</span>'
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
      // Sticky notes — coloured icon per existing note + grey "add"
      // icon while under the 5-note cap. Rendered LEFT of the cart.
      `<span class="pv-notes-cluster" data-aid="${esc(a.id)}"
             style="display:inline-flex;gap:4px;">${_noteClusterInner(a.notes)}</span>`,
      // Cart button — adds article to PrionPacks cart (localStorage).
      // No inline onclick: JSON double-quotes would break the HTML attribute.
      // Wired via addEventListener below (has access to `a` via closure).
      (() => {
        const inCart = window.PPCart?.has(a.id);
        return `<button type="button" class="pv-cart-btn ${inCart ? 'pv-cart-btn--in' : ''}"
                        data-aid="${esc(a.id)}"
                        title="${inCart ? 'En el carrito' : 'Añadir al carrito de PrionPacks'}"
                        style="display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:4px;
                               font-size:10.5px;font-weight:600;border:none;cursor:pointer;
                               ${inCart ? 'background:#d1fae5;color:#065f46;' : 'background:#f3f4f6;color:#6b7280;'}">🛒${inCart ? ' ✓' : ''}</button>`;
      })(),
    ].filter(Boolean).join('');

    const authors = a.authors ? esc(a.authors) : '—';
    const journal = a.journal ? ` · ${esc(a.journal)}` : '';

    // ── Select cell: bulk-selection checkbox (admin only) ────────────────
    const selectCell =
      `<td style="padding:8px 6px 8px 12px;vertical-align:middle;text-align:center;width:32px;">
           <input type="checkbox" class="pv-row-select" data-aid="${esc(a.id)}"
                  ${state.selectedIds.has(a.id) ? 'checked' : ''}
                  onclick="event.stopPropagation();"
                  style="cursor:pointer;width:14px;height:14px;">
         </td>`;

    // ── Marks cell: flag + color dot + milestone (vertical stack) ────────
    const colorCss = a.color_label ? (COLOR_CSS[a.color_label] || '#9ca3af') : null;
    const flagColor = a.is_flagged ? '#e11d48' : '#e5e7eb';
    const flagTitle = a.is_flagged ? 'Marcada 🚩 — clic para quitar' : 'Marcar bandera';
    const milestoneColor = a.is_milestone ? '#f59e0b' : '#d1d5db';
    const colorTitle = a.color_label ? `Etiqueta: ${esc(a.color_label)}` : 'Sin etiqueta de color';

    const favColor  = a.is_favorite ? '#e11d48' : '#d1d5db';
    const readColor = a.is_read     ? '#15803d' : '#d1d5db';
    const jcColor   = a.is_jc       ? '#7c3aed' : '#d1d5db';

    const marksCell = `
      <td style="padding:8px 8px;vertical-align:middle;text-align:center;width:134px;white-space:nowrap;">
        <div style="display:flex;align-items:center;justify-content:center;gap:6px;">
          <button class="pv-flag-btn"
                  data-active="${a.is_flagged ? '1' : '0'}"
                  title="${flagTitle}"
                  style="background:none;border:none;padding:0;line-height:0;
                         cursor:pointer;color:${flagColor};">${FLAG_SVG(a.is_flagged)}</button>
          <span class="pv-color-dot"
                title="${colorTitle}"
                style="width:11px;height:11px;border-radius:50%;flex-shrink:0;cursor:pointer;
                       ${colorCss ? `background:${colorCss};` : 'background:transparent;border:1.5px dashed #d1d5db;'}"></span>
          <button class="pv-milestone-btn"
                  data-active="${a.is_milestone ? '1' : '0'}"
                  title="${a.is_milestone ? 'Hito ★ — clic para quitar' : 'Marcar como hito'}"
                  style="background:none;border:none;padding:0;font-size:15px;line-height:1;
                         cursor:pointer;color:${milestoneColor};">${a.is_milestone ? '★' : '☆'}</button>
          <span style="width:1px;height:14px;background:#e5e7eb;"></span>
          <button class="pv-jc-btn"
                  data-active="${a.is_jc ? '1' : '0'}"
                  title="${a.is_jc ? (IS_ADMIN ? 'En Journal Club — clic para quitar' : 'Seleccionado para Journal Club')
                                   : (IS_ADMIN ? 'Marcar para Journal Club' : 'No está en Journal Club')}"
                  style="background:none;border:none;padding:0;font-size:13px;line-height:1;
                         cursor:${IS_ADMIN ? 'pointer' : 'default'};color:${jcColor};"><i class="fas fa-book-open"></i></button>
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

    // ── Thumbnail cell (first PDF page, shown only when PDF exists) ──────
    const _canFetchOA = !a.has_pdf && !a.pdf_dropbox_path
                        && a.pdf_oa_status !== 'not_available'
                        && (a.doi || a.pmc_id);
    const _oaFailed  = !a.has_pdf && !a.pdf_dropbox_path
                        && a.pdf_oa_status === 'not_available';
    const thumbCell = (a.has_pdf || a.pdf_dropbox_path)
      ? `<td style="padding:4px 4px;vertical-align:middle;text-align:center;">
           <img class="pv-thumb"
                src="/prionvault/api/articles/${esc(a.id)}/thumbnail"
                loading="lazy"
                alt=""
                style="display:block;width:34px;height:44px;object-fit:cover;object-position:top center;
                       border-radius:3px;border:1px solid #e5e7eb;cursor:zoom-in;"
                onerror="this.style.display='none'">
         </td>`
      : _canFetchOA
        ? `<td style="padding:4px 4px;vertical-align:middle;text-align:center;">
             <button class="pv-oa-fetch-btn" data-aid="${esc(a.id)}"
                     title="Descargar PDF en acceso abierto (Unpaywall + PMC)"
                     style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                            width:34px;height:44px;border-radius:3px;border:1px solid #bfdbfe;
                            background:#eff6ff;color:#1d4ed8;cursor:pointer;padding:0;gap:1px;
                            font-size:9px;font-weight:600;line-height:1.1;">
               <span style="font-size:14px;line-height:1;">⬇</span>OA
             </button>
           </td>`
        : _oaFailed
          ? `<td style="padding:4px 4px;vertical-align:middle;text-align:center;">
               <button class="pv-oa-manual-btn" data-aid="${esc(a.id)}" data-title="${esc(a.title||'')}"
                       title="OA no disponible — clic para subir PDF manualmente"
                       style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                              width:34px;height:44px;border-radius:3px;border:1px solid #d1d5db;
                              background:#f9fafb;color:#6b7280;cursor:pointer;padding:0;gap:1px;
                              font-size:9px;font-weight:600;line-height:1.1;">
                 <span style="font-size:13px;line-height:1;">📤</span>PDF
               </button>
             </td>`
          : `<td style="padding:4px 4px;"></td>`;

    // ── Article cell: title, authors+journal, tags+badges ────────────────
    const titleTooltip = [
      a.title,
      a.authors,
      a.journal && `${a.journal}${a.year ? ' · ' + a.year : ''}`,
    ].filter(Boolean).join('\n');

    const articleCell = `
      <td class="pv-row-open" style="padding:8px 12px;vertical-align:middle;width:100%;overflow:hidden;cursor:pointer;">
        <div style="font-size:14px;font-weight:600;color:#111827;line-height:1.35;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
             title="${esc(titleTooltip)}">${supHtml(a.title || '(no title)')}</div>
        <div style="margin-top:2px;font-size:12px;color:#6b7280;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${authors}${journal}</div>
        ${(tags || badges) ? `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:4px;overflow:hidden;">${badges}${tags}</div>` : ''}
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
              title="Prioridad ${prio}/5 — clic para cambiar"
              style="display:inline-flex;align-items:center;justify-content:center;
                     min-width:24px;height:20px;padding:0 6px;border-radius:5px;
                     font-size:11px;font-weight:700;cursor:pointer;
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
          ${IS_ADMIN ? `<button class="pv-open-prionread-btn"
                  data-aid="${esc(a.id)}"
                  title="Abrir este artículo en PrionRead admin ↗"
                  style="background:none;border:none;padding:2px 4px;cursor:pointer;
                         font-size:13px;color:#6b7280;line-height:1;border-radius:4px;"
                  onmouseover="this.style.background='#f3f4f6';this.style.color='#0F3460';"
                  onmouseout="this.style.background='none';this.style.color='#6b7280';">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;">
                    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
                  </svg>
                </button>` : ''}
        </div>
      </td>`;

    row.innerHTML = selectCell + marksCell + thumbCell + articleCell + yearCell + pagesCell +
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
    const prBtn = row.querySelector('.pv-open-prionread-btn');
    if (prBtn) prBtn.addEventListener('click', e => {
      e.stopPropagation();
      window.open(`/prionread/admin/articles?open=${encodeURIComponent(a.id)}`,
                  '_blank', 'noopener');
    });

    const pdfPill = row.querySelector('.pv-pdf-pill');
    if (pdfPill) pdfPill.addEventListener('click', e => {
      e.stopPropagation();
      // On phones the browser hides all its chrome around an inline
      // PDF, which trapped the operator inside the file with no way
      // back to PrionVault. Open our /pdf-view wrapper instead — it
      // pins a "← Volver" bar at the top and still uses the OS's
      // native PDF viewer inside an iframe below.
      if (window.innerWidth <= 800) {
        window.open(`/prionvault/api/articles/${a.id}/pdf-view`,
                    '_blank', 'noopener,noreferrer');
        return;
      }
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

    row.querySelector('.pv-jc-btn').addEventListener('click', async e => {
      e.stopPropagation();
      if (!IS_ADMIN) return;   // JC is a shared, admin-curated mark
      const btn = e.currentTarget;
      const next = btn.dataset.active !== '1';
      btn.disabled = true;
      try {
        const r = await api(`/articles/${a.id}/jc-mark`, {
          method: 'POST',
          body: JSON.stringify({ value: next }),
        });
        a.is_jc = !!r.is_jc;
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

    // Per-user marks (flag / milestone / color / priority) — available to
    // every logged-in user since they're personal (migration 037). Each user
    // organizes their own; readers included.
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

    const prChip = row.querySelector('.pv-priority-chip');
    if (prChip) prChip.addEventListener('click', e => {
      e.stopPropagation();
      openPriorityPopover(e.currentTarget, a, () => replaceRow(row, a));
    });

    if (IS_ADMIN) {
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

      const emailRowBtn = row.querySelector('.pv-email-row-btn');
      if (emailRowBtn) emailRowBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        PVEmailShare.open(a);
      });

      const chatRowBtn = row.querySelector('.pv-chat-row-btn');
      if (chatRowBtn) chatRowBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        PVChat.open(a, { showHistory: false });
      });

      const noteCluster = row.querySelector('.pv-notes-cluster');
      if (noteCluster) _wireNoteCluster(noteCluster, a);

      const indexedChip = row.querySelector('.pv-indexed-chip');
      if (indexedChip) indexedChip.addEventListener('click', (e) => {
        e.stopPropagation();
        openChunksInspector(a.id, a.title);
      });

      const verifyChip = row.querySelector('.pv-verify-chip');
      if (verifyChip) verifyChip.addEventListener('click', async (e) => {
        e.stopPropagation();
        // Open the edit modal focused on this article — the verify block
        // inside the edit modal lets the user mark OK or recheck in-place.
        const fresh = await api(`/articles/${a.id}`);
        openEditModal(fresh);
      });

      const editBtn = row.querySelector('.pv-edit-row-btn');
      if (editBtn) editBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        // If we already know the PMID at list time, pop PubMed in a
        // background tab as part of the same click. Opening before
        // the await keeps the popup-blocker happy (user-gesture
        // chain stays intact). Edit modal still opens.
        if (a.pubmed_id) {
          window.open(`https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(a.pubmed_id)}/`,
                      '_blank', 'noopener');
        }
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

      const oaFetchBtn = row.querySelector('.pv-oa-fetch-btn');
      if (oaFetchBtn) oaFetchBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        oaFetchBtn.disabled = true;
        oaFetchBtn.innerHTML = '<span style="font-size:11px;line-height:1.2;">⏳</span>';
        oaFetchBtn.title = 'Descargando…';
        try {
          const r = await api(`/articles/${a.id}/fetch-oa-pdf`, { method: 'POST' });
          if (r.ok) {
            // PDF now exists — swap button for real thumbnail
            const td = oaFetchBtn.closest('td');
            td.innerHTML = `<img class="pv-thumb"
              src="/prionvault/api/articles/${esc(a.id)}/thumbnail?_=${Date.now()}"
              loading="lazy" alt=""
              style="display:block;width:34px;height:44px;object-fit:cover;object-position:top center;
                     border-radius:3px;border:1px solid #e5e7eb;cursor:zoom-in;"
              onerror="this.style.display='none'">`;
            a.has_pdf = true;
            a.pdf_dropbox_path = r.dropbox_path || true;
          } else {
            // OA not available — swap to manual upload button (persistent state)
            const td = oaFetchBtn.closest('td');
            td.innerHTML = `<button class="pv-oa-manual-btn"
              data-aid="${esc(a.id)}" data-title="${esc(a.title||'')}"
              title="OA no disponible — clic para subir PDF manualmente"
              style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                     width:34px;height:44px;border-radius:3px;border:1px solid #d1d5db;
                     background:#f9fafb;color:#6b7280;cursor:pointer;padding:0;gap:1px;
                     font-size:9px;font-weight:600;line-height:1.1;">
              <span style="font-size:13px;line-height:1;">📤</span>PDF
            </button>`;
            _wireManualUploadBtn(td.querySelector('.pv-oa-manual-btn'), a);
          }
        } catch (err) {
          const td = oaFetchBtn.closest('td');
          td.innerHTML = `<button class="pv-oa-manual-btn"
            data-aid="${esc(a.id)}" data-title="${esc(a.title||'')}"
            title="Error al descargar — clic para subir PDF manualmente"
            style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                   width:34px;height:44px;border-radius:3px;border:1px solid #d1d5db;
                   background:#f9fafb;color:#6b7280;cursor:pointer;padding:0;gap:1px;
                   font-size:9px;font-weight:600;line-height:1.1;">
            <span style="font-size:13px;line-height:1;">📤</span>PDF
          </button>`;
          _wireManualUploadBtn(td.querySelector('.pv-oa-manual-btn'), a);
        }
      });

      const manualUploadBtn = row.querySelector('.pv-oa-manual-btn');
      if (manualUploadBtn) _wireManualUploadBtn(manualUploadBtn, a);

      const cartBtn = row.querySelector('.pv-cart-btn');
      if (cartBtn) cartBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!window.PPCart) return;
        window.PPCart.add({
          id: a.id, title: a.title || '', authors: a.authors || '',
          year: a.year || null, journal: a.journal || '',
          doi: a.doi || '', pubmed_id: a.pubmed_id || '', has_pdf: !!a.has_pdf,
        });
        cartBtn.classList.add('pv-cart-btn--in');
        cartBtn.style.background = '#d1fae5';
        cartBtn.style.color = '#065f46';
        cartBtn.title = 'En el carrito';
        cartBtn.innerHTML = '🛒 ✓';
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
  let _detailCurrentId = null;

  function _detailUpdateNav(aid) {
    _detailCurrentId = aid;
    const idx  = _listIds.indexOf(aid);
    const prev = document.getElementById('pv-detail-prev');
    const next = document.getElementById('pv-detail-next');
    if (prev) prev.disabled = idx <= 0;
    if (next) next.disabled = idx < 0 || idx >= _listIds.length - 1;
  }

  async function openDetail(aid, options = {}) {
    const modal   = document.getElementById('pv-detail-modal');
    const content = document.getElementById('pv-detail-content');
    _pdfViewerOpen = !!options.openPdf;
    const inner = modal.querySelector('.pv-modal-inner');
    if (inner) inner.style.maxWidth = '';
    modal.style.display = 'flex';
    _detailUpdateNav(aid);
    content.innerHTML = '<div style="text-align:center;padding:40px;color:#9ca3af;">Cargando…</div>';
    try {
      const a = await api('/articles/' + aid);

      // Wire cart button in detail modal nav bar
      const detailCartBtn = document.getElementById('pv-detail-cart-btn');
      if (detailCartBtn) {
        const inCart = window.PPCart?.has(a.id);
        detailCartBtn.innerHTML = inCart ? '🛒 ✓' : '🛒';
        detailCartBtn.style.background   = inCart ? '#d1fae5' : 'white';
        detailCartBtn.style.color        = inCart ? '#065f46' : '#374151';
        detailCartBtn.style.borderColor  = inCart ? '#6ee7b7' : '#d1d5db';
        detailCartBtn.title = inCart ? 'En el carrito' : 'Añadir al carrito de PrionPacks';
        detailCartBtn.onclick = () => {
          if (!window.PPCart) return;
          window.PPCart.add({
            id: a.id, title: a.title || '', authors: a.authors || '',
            year: a.year || null, journal: a.journal || '',
            doi: a.doi || '', pubmed_id: a.pubmed_id || '', has_pdf: !!a.has_pdf,
          });
          detailCartBtn.innerHTML = '🛒 ✓';
          detailCartBtn.style.background  = '#d1fae5';
          detailCartBtn.style.color       = '#065f46';
          detailCartBtn.style.borderColor = '#6ee7b7';
          detailCartBtn.title = 'En el carrito';
        };
      }

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
          ${(IS_ADMIN || a.is_jc) ? `
          <button id="pv-detail-jc" type="button"
                  data-active="${a.is_jc ? '1' : '0'}"
                  title="${IS_ADMIN ? 'Marca compartida — todos ven los artículos de Journal Club'
                                    : 'Seleccionado para Journal Club'}"
                  style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;
                         font-size:12px;font-weight:600;cursor:${IS_ADMIN ? 'pointer' : 'default'};
                         ${a.is_jc
                           ? 'background:#f3e8ff;color:#6b21a8;border:1px solid #d8b4fe;'
                           : 'background:#f9fafb;color:#6b7280;border:1px solid #e5e7eb;'}">
            <span style="font-size:12px;line-height:1;color:${a.is_jc ? '#7c3aed' : '#9ca3af'};"><i class="fas fa-book-open"></i></span>
            ${a.is_jc ? 'En Journal Club' : 'Marcar para Journal Club'}
          </button>` : ''}
        </div>`;

      const chatLauncher = `
        <div style="margin:0 0 14px;">
          <button id="pv-detail-chat-btn" type="button"
                  title="Abre un chat para hacer preguntas a la IA sobre este artículo"
                  style="display:inline-flex;align-items:center;gap:8px;padding:9px 16px;border-radius:9px;
                         border:none;background:linear-gradient(135deg,#0F3460,#16528a);color:#fff;
                         font-size:13.5px;font-weight:600;cursor:pointer;box-shadow:0 1px 3px rgba(15,52,96,0.3);">
            <span style="font-size:15px;">🤖</span>
            <span>Preguntar a la IA sobre este artículo</span>
          </button>
          <button id="pv-detail-chat-history-btn" type="button"
                  title="Ver conversaciones anteriores sobre este artículo"
                  style="display:inline-flex;align-items:center;gap:6px;padding:9px 13px;border-radius:9px;
                         border:1px solid #d1d5db;background:white;color:#374151;
                         font-size:12.5px;font-weight:600;cursor:pointer;margin-left:8px;">
            🕑 <span>Chats anteriores</span>
            <span id="pv-detail-chat-count" style="display:none;background:#eef2ff;color:#4f46e5;
                  border-radius:10px;padding:1px 7px;font-size:11px;font-weight:700;"></span>
          </button>
        </div>`;

      content.innerHTML = `
        <h2 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#111827;line-height:1.35;padding-right:24px;">
          ${supHtml(a.title)}
        </h2>
        ${prionreadBadge}
        ${personalChips}
        ${chatLauncher}
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
      wireChatLauncher(a);
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

    // Fetch used-in pack data for all similar articles in parallel
    const usedInMap = {};
    await Promise.all(items.map(async it => {
      try {
        const d = await api(`/articles/${it.id}/used-in`);
        usedInMap[it.id] = d.packs || [];
      } catch { usedInMap[it.id] = []; }
    }));

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

        // DOI / PMID chips
        const idChips = [
          it.doi
            ? `<a href="https://doi.org/${esc(it.doi)}" target="_blank" rel="noopener"
                  onclick="event.stopPropagation()"
                  title="Abrir en doi.org"
                  style="font-size:10.5px;background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe;
                         padding:1px 7px;border-radius:5px;font-weight:600;text-decoration:none;">DOI ↗</a>`
            : '',
          it.pubmed_id
            ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${esc(it.pubmed_id)}/" target="_blank" rel="noopener"
                  onclick="event.stopPropagation()"
                  title="Abrir en PubMed"
                  style="font-size:10.5px;background:#dbeafe;color:#1d4ed8;border:1px solid #93c5fd;
                         padding:1px 7px;border-radius:5px;font-weight:600;text-decoration:none;">PMID ${esc(it.pubmed_id)} ↗</a>`
            : '',
        ].filter(Boolean).join('');

        // PrionPacks usage badges
        const packs = usedInMap[it.id] || [];
        const packBadges = packs.map(p => {
          const sections = (p.lists || []).map(t => t === 'intro' ? 'Intro' : 'General').join('+');
          return `<span title="${esc(p.id)}: ${esc(p.title || '')}"
                        style="font-size:10.5px;background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0;
                               padding:1px 7px;border-radius:5px;font-weight:600;max-width:120px;
                               overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;">
                    📦 ${esc(p.id)}${sections ? ' · ' + sections : ''}
                  </span>`;
        }).join('');

        const extraRow = (idChips || packBadges)
          ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:4px;align-items:center;">
               ${idChips}${packBadges}
             </div>`
          : '';

        return `
          <div class="pv-similar-row" data-aid="${esc(it.id)}"
               style="display:flex;align-items:flex-start;gap:10px;padding:8px 10px;
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
              ${extraRow}
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
        <span style="font-size:11px;color:#9ca3af;">Click para asignar / quitar</span>
      </div>
      <div id="pv-tag-picker-list" style="display:flex;flex-wrap:wrap;gap:6px;
                                          font-size:12px;color:#9ca3af;">Cargando…</div>`;

    let allTags = [];
    try {
      allTags = await api('/tags');
    } catch (e) {
      const listErr = document.getElementById('pv-tag-picker-list');
      if (listErr) listErr.innerHTML =
        `<span style="color:#b91c1c;">Error: ${esc(e.message)}</span>`;
      return;
    }
    if (!allTags.length) {
      const listEmpty = document.getElementById('pv-tag-picker-list');
      if (listEmpty) listEmpty.innerHTML =
        `<span style="font-style:italic;">No hay tags todavía. ` +
        `Pulsa <strong>"+ Nuevo tag"</strong> para crear el primero.</span>`;
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

      // "+ Nuevo tag" button — available to all logged-in users.
      const newBtn = list.parentElement.querySelector('.pv-tag-new-inline');
      if (newBtn) newBtn.addEventListener('click', async () => {
        const palette = {
          rojo: '#ef4444', naranja: '#fb923c', amarillo: '#f59e0b',
          verde: '#22c55e', azul: '#3b82f6', morado: '#a855f7',
          rosa: '#ec4899', gris: '#6b7280', cian: '#06b6d4',
        };
        const name = prompt('Nombre del nuevo tag:');
        if (!name || !name.trim()) return;
        const colorInput = prompt(
          'Color (hex #rrggbb o nombre: rojo/naranja/amarillo/verde/azul/morado/rosa/gris/cian).\nVacío = sin color.'
        );
        let color = null;
        if (colorInput && colorInput.trim()) {
          const v = colorInput.trim().toLowerCase();
          color = palette[v] || (v.startsWith('#') ? v : null);
        }
        try {
          const created = await api('/tags', {
            method: 'POST',
            body: JSON.stringify({ name: name.trim(), color }),
          });
          allTags = await api('/tags');
          // Auto-assign the newly created tag to this article.
          await api(`/articles/${a.id}/tags/${created.id}`, { method: 'PUT' });
          articleTagIds.add(created.id);
          a.tags = [...(a.tags || []), created];
          renderChips();
          refreshTags();
        } catch (e) {
          alert('No se pudo crear el tag: ' + e.message);
        }
      });
    }

    // Append "+ Nuevo tag" button below the chip list (rendered once).
    const container = sec.querySelector('#pv-tag-picker-list');
    if (container && !sec.querySelector('.pv-tag-new-inline')) {
      const newTagBtn = document.createElement('button');
      newTagBtn.type = 'button';
      newTagBtn.className = 'pv-tag-new-inline';
      newTagBtn.style.cssText =
        'margin-top:8px;padding:4px 10px;font-size:11px;border-radius:14px;' +
        'border:1px dashed #d1d5db;background:white;color:#6b7280;cursor:pointer;' +
        'display:flex;align-items:center;gap:4px;';
      newTagBtn.innerHTML = '<i class="fas fa-plus" style="font-size:9px;"></i> Nuevo tag';
      container.insertAdjacentElement('afterend', newTagBtn);
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

    // Supplementary uploads are open to any logged-in user since the
    // permission audit — the server tags each row with added_by and
    // only allows the creator (or an admin) to PATCH / DELETE later.
    const heading = `
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0 0 8px;">
        <h3 style="margin:0;font-size:14px;font-weight:600;color:#374151;
                   text-transform:uppercase;letter-spacing:0.05em;">Material suplementario</h3>
        <button id="pv-supp-add-btn" type="button"
                style="padding:4px 10px;font-size:12px;border-radius:6px;border:1px solid #d1d5db;
                       background:white;color:#0F3460;font-weight:600;cursor:pointer;">
          <i class="fas fa-plus" style="margin-right:4px;"></i>Añadir
        </button>
      </div>`;
    sec.innerHTML = heading +
      `<div id="pv-supp-list" style="font-size:12.5px;color:#9ca3af;">Cargando…</div>`;

    wireSupplementaryUpload(a);

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
          Sin material suplementario. Pulsa "Añadir" para subir un archivo.
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
          ${(admin || (it.added_by && it.added_by === USER_ID)) ? `
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
        <button id="pv-jc-add-btn" type="button"
                style="padding:4px 10px;font-size:12px;border-radius:6px;
                       border:1px solid #fce7f3;background:white;color:#be185d;
                       font-weight:600;cursor:pointer;">
          <i class="fas fa-plus" style="margin-right:4px;"></i>Añadir presentación
        </button>
      </div>`;
    sec.innerHTML = heading +
      `<div id="pv-jc-list" style="font-size:12.5px;color:#9ca3af;">Cargando…</div>`;

    // JC presentations are open to any logged-in user; the server's
    // creator-or-admin gate handles per-row edit / delete safety.
    wireJcAddButton(a);

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
      // Show edit / delete for the user who created the presentation,
      // and for admins (who can curate). Other readers see the row
      // but no action buttons — matches the server-side _ensure_can_modify
      // rule on PATCH and DELETE.
      const canEdit = IS_ADMIN || (p.created_by && p.created_by === USER_ID);
      const adminActions = canEdit ? `
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
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const fresh = await api(`/articles/${a.id}`);
        openEditModal(fresh);
      } catch (err) {
        alert('No se pudo abrir el editor: ' + err.message);
      } finally {
        btn.disabled = false;
      }
    });
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
    const nextBtn = document.getElementById('pv-edit-next');
    if (nextBtn) { nextBtn.disabled = false; nextBtn.textContent = 'Siguiente →'; }
    const prevBtn = document.getElementById('pv-edit-prev');
    if (prevBtn) { prevBtn.disabled = false; prevBtn.textContent = '← Anterior'; }
    const delBtn = document.getElementById('pv-edit-delete');
    if (delBtn) { delBtn.disabled = false; delBtn.textContent = '🗑 Borrar artículo'; }
    const noAbsBtn = document.getElementById('pv-edit-no-abstract');
    if (noAbsBtn) { noAbsBtn.disabled = false; noAbsBtn.textContent = '📕 Sin abstract'; }
    _editRenderPdfPreview(a);
    _editSyncPmidLink(a.pubmed_id || '');
    // Reset the "Sin PMID" toggle so the styling doesn't bleed across
    // articles when the operator navigates Siguiente / Anterior.
    _editSyncNoPmidButton(!!a.pubmed_unavailable);
    // Mount the attach-PDF dropzone. Shown prominently when the article
    // has no PDF yet, smaller "reemplazar" hint otherwise.
    _editSyncPdfAttach(!!a.has_pdf);
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
    // AI summary token info + PDF verification block
    _editRenderTokensBlock(a);
    _editRenderVerifyBlock(a);

    const editCartBtn = document.getElementById('pv-edit-cart-btn');
    if (editCartBtn) {
      const inCart = window.PPCart?.has(a.id);
      editCartBtn.innerHTML = inCart ? '🛒 ✓' : '🛒';
      editCartBtn.style.background   = inCart ? '#d1fae5' : '#f9fafb';
      editCartBtn.style.color        = inCart ? '#065f46' : '#374151';
      editCartBtn.style.borderColor  = inCart ? '#6ee7b7' : '#d1d5db';
      editCartBtn.title = inCart ? 'En el carrito' : 'Añadir al carrito de PrionPacks';
      editCartBtn.onclick = () => {
        if (!window.PPCart) return;
        window.PPCart.add({
          id: a.id, title: a.title || '', authors: a.authors || '',
          year: a.year || null, journal: a.journal || '',
          doi: a.doi || '', pubmed_id: a.pubmed_id || '', has_pdf: !!a.has_pdf,
        });
        editCartBtn.innerHTML = '🛒 ✓';
        editCartBtn.style.background  = '#d1fae5';
        editCartBtn.style.color       = '#065f46';
        editCartBtn.style.borderColor = '#6ee7b7';
        editCartBtn.title = 'En el carrito';
      };
    }

    modal.style.display = 'flex';
    setTimeout(() => document.getElementById('pv-edit-doi').focus(), 50);
  }

  function _editRenderTokensBlock(a) {
    const block = document.getElementById('pv-edit-tokens-block');
    if (!block) return;
    const hasSummary = a.has_summary_ai || !!(a.summary_ai || '').trim();
    const hasNotes   = !!(a.summary_ai_notes || '').trim();
    if (!hasSummary && !hasNotes) { block.style.display = 'none'; return; }
    block.style.display = 'block';

    // Provider selector
    const provSel  = document.getElementById('pv-edit-summary-provider');
    if (provSel) provSel.value = a.summary_ai_provider || '';

    // Token counts
    const countEl = document.getElementById('pv-edit-tokens-counts');
    if (countEl) {
      const tin  = a.summary_tokens_in;
      const tout = a.summary_tokens_out;
      countEl.textContent = (tin != null || tout != null)
        ? `${(tin || 0).toLocaleString('es-ES')} in / ${(tout || 0).toLocaleString('es-ES')} out tk`
        : '';
    }

    // Error note preview + clear button
    const clearBtn    = document.getElementById('pv-edit-clear-notes');
    const notesPreview = document.getElementById('pv-edit-notes-preview');
    if (clearBtn && notesPreview) {
      if (hasNotes) {
        clearBtn.style.display = 'inline-flex';
        notesPreview.style.display = 'block';
        // Show just the first line (type + message) to keep it compact
        notesPreview.textContent = a.summary_ai_notes.split('\n')[0];
      } else {
        clearBtn.style.display = 'none';
        notesPreview.style.display = 'none';
        notesPreview.textContent = '';
      }
    }
  }

  function _editRenderVerifyBlock(a) {
    const block  = document.getElementById('pv-edit-verify-block');
    if (!block) return;
    const v = a.pdf_verify;
    if (!v || !v.status) { block.style.display = 'none'; return; }

    block.style.display = 'block';
    const badge  = document.getElementById('pv-edit-verify-badge');
    const score  = document.getElementById('pv-edit-verify-score');
    const detail = document.getElementById('pv-edit-verify-detail');

    const cfg = {
      mismatch:  { label: '✗ Mismatch',    bg: '#fee2e2', color: '#7f1d1d' },
      suspect:   { label: '⚠ Sospechoso',  bg: '#fef3c7', color: '#7c2d12' },
      ok:        { label: '✓ OK',           bg: '#d1fae5', color: '#065f46' },
      manual_ok: { label: '✓ OK manual',   bg: '#d1fae5', color: '#065f46' },
      no_pdf_text: { label: '◐ Sin texto', bg: '#f3f4f6', color: '#374151' },
    }[v.status] || { label: v.status, bg: '#f3f4f6', color: '#374151' };

    badge.textContent = cfg.label;
    badge.style.background = cfg.bg;
    badge.style.color = cfg.color;
    badge.style.padding = '2px 8px';
    badge.style.borderRadius = '99px';

    score.textContent = v.score != null ? `(score: ${Number(v.score).toFixed(2)})` : '';

    let detailTxt = '';
    if (v.detail) {
      try {
        const d = typeof v.detail === 'string' ? JSON.parse(v.detail) : v.detail;
        const lines = [];
        if (d.title_ok   === false) lines.push('• Título: discrepancia detectada');
        if (d.year_ok    === false) lines.push('• Año: discrepancia detectada');
        if (d.journal_ok === false) lines.push('• Revista: discrepancia detectada');
        if (d.authors_ok === false) lines.push('• Autores: discrepancia detectada');
        if (d.verdict)              lines.push(`Veredicto IA: ${d.verdict}`);
        if (d.reasoning)            lines.push(`Razonamiento: ${d.reasoning}`);
        detailTxt = lines.join('\n');
      } catch (_) {
        detailTxt = String(v.detail);
      }
    }
    detail.textContent = detailTxt;
    if (v.checked_at) {
      const dt = new Date(v.checked_at);
      detail.textContent += (detailTxt ? '\n' : '') +
        `Verificado: ${dt.toLocaleDateString('es-ES')} ${dt.toLocaleTimeString('es-ES', {hour:'2-digit',minute:'2-digit'})}`;
    }
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
      _editSyncPmidLink(pmidEl.value);
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

  // Mirror of _editNextRowId but walking backwards.
  function _editPrevRowId() {
    if (!_editTarget) return null;
    const cb = document.querySelector(`.pv-row-select[data-aid="${_editTarget.id}"]`);
    if (!cb) return null;
    const row = cb.closest('tr');
    let prev = row && row.previousElementSibling;
    while (prev) {
      const prevCb = prev.querySelector('.pv-row-select');
      if (prevCb && prevCb.dataset.aid) return prevCb.dataset.aid;
      prev = prev.previousElementSibling;
    }
    return null;
  }

  // Toggle the "PMID ↗" external link button next to the PMID input
  // to match the current value. Reads from the DOM (input.value)
  // rather than from _editTarget so it stays correct after the user
  // pastes / clears the field, or after _editRefetch fills it in.
  function _editSyncPmidLink(rawValue) {
    const link = document.getElementById('pv-edit-pmid-link');
    if (!link) return;
    const pmid = String(rawValue || '').trim();
    if (/^\d+$/.test(pmid)) {
      link.href = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
      link.style.display = '';
      link.title = `Abrir PMID ${pmid} en PubMed (nueva pestaña)`;
    } else {
      link.removeAttribute('href');
      link.style.display = 'none';
    }
  }

  // Render the mini-PDF preview at the top of the Edit modal. Sized
  // at ~1/4 of the detail-modal viewer (78vh) so the title is
  // legible without taking over the modal. The Open Parameters
  // (#view=FitH&toolbar=0) ask Chromium / Firefox to fit the page
  // width and hide the toolbar; Safari ignores them but the iframe
  // still renders correctly.
  function _editRenderPdfPreview(a) {
    const box = document.getElementById('pv-edit-pdf-preview');
    if (!box) return;
    if (!a || !a.has_pdf) {
      box.style.display = 'none';
      box.innerHTML = '';
      return;
    }
    box.style.display = 'block';
    box.innerHTML = `<iframe
        src="/prionvault/api/articles/${esc(a.id)}/pdf#view=FitH&toolbar=0&navpanes=0"
        style="display:block;width:100%;height:220px;border:0;background:#1f2937;"
        title="PDF: ${esc(a.title || '')}"></iframe>`;
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

  // Show / repaint the "Adjuntar PDF" dropzone in the Edit modal.
  // hasPdf=true means the article already has a PDF — the zone shrinks
  // to a one-line "Reemplazar" hint. hasPdf=false → prominent attach
  // CTA. The handlers are wired once on first call (closure flag).
  let _pdfAttachWired = false;
  function _editSyncPdfAttach(hasPdf) {
    const wrap   = document.getElementById('pv-edit-pdf-attach');
    const drop   = document.getElementById('pv-edit-pdf-drop');
    const text   = document.getElementById('pv-edit-pdf-drop-text');
    const file   = document.getElementById('pv-edit-pdf-file');
    const status = document.getElementById('pv-edit-pdf-upload-status');
    if (!wrap || !drop || !file) return;
    wrap.style.display = '';
    status.style.display = 'none';
    status.innerHTML = '';
    if (hasPdf) {
      drop.style.padding = '8px 12px';
      drop.style.fontSize = '12px';
      drop.style.borderStyle = 'dashed';
      text.innerHTML = '<strong>Reemplazar PDF</strong> — arrastra otro fichero o pulsa para seleccionar.';
    } else {
      drop.style.padding = '14px';
      drop.style.fontSize = '13px';
      drop.style.borderStyle = 'dashed';
      text.innerHTML = '<strong>Adjuntar PDF</strong> — arrastra un archivo aquí o pulsa para seleccionar.';
    }
    file.value = '';
    if (_pdfAttachWired) return;
    _pdfAttachWired = true;
    file.addEventListener('change', () => {
      if (file.files && file.files[0]) _editUploadPdf(file.files[0]);
    });
    // Drag-and-drop affordance. The <label> already triggers the
    // hidden <input>, but we also handle dragenter / drop so a file
    // dropped on the box is picked up directly.
    drop.addEventListener('dragenter', (e) => {
      e.preventDefault(); e.stopPropagation();
      drop.style.background = '#dbeafe';
      drop.style.borderColor = '#0F3460';
    });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
    drop.addEventListener('dragleave', (e) => {
      e.preventDefault(); e.stopPropagation();
      drop.style.background = '#f9fafb';
      drop.style.borderColor = '#d1d5db';
    });
    drop.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      drop.style.background = '#f9fafb';
      drop.style.borderColor = '#d1d5db';
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) _editUploadPdf(f);
    });
  }

  async function _editUploadPdf(file) {
    if (!_editTarget) return;
    if (!file || !file.name || !file.name.toLowerCase().endsWith('.pdf')) {
      _editStatus('Solo PDFs.', '#b91c1c'); return;
    }
    const status = document.getElementById('pv-edit-pdf-upload-status');
    status.style.display = 'block';
    status.style.color = '#374151';
    status.textContent = `⏳ Subiendo ${file.name} (${(file.size/1024/1024).toFixed(1)} MB)…`;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await fetch(`/prionvault/api/articles/${_editTarget.id}/upload-pdf`, {
        method: 'POST',
        credentials: 'same-origin',
        body: fd,
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        status.style.color = '#15803d';
        status.innerHTML = `✓ PDF adjuntado (${(d.size_bytes/1024/1024).toFixed(1)} MB). ` +
          `Las pipelines de extracción / OCR / index / resumen lo recogerán en background.`;
        // Reflect locally so the modal's preview + chips know we have a PDF.
        _editTarget.has_pdf = true;
        _editTarget.dropbox_path = d.dropbox_path;
        _editRenderPdfPreview(_editTarget);
        _editSyncPdfAttach(true);
        // Re-enable the "🤖 Buscar PMID con IA" button — it greys
        // out when there's no PDF.
        const aiBtn = document.getElementById('pv-edit-identify-ai');
        if (aiBtn) { aiBtn.disabled = false; aiBtn.style.opacity = '1';
                     aiBtn.style.cursor = 'pointer'; }
      } else if (r.status === 409) {
        status.style.color = '#b91c1c';
        status.innerHTML = `⚠ Este PDF ya está asignado a otro artículo ` +
          (d.duplicate_of ? `(<a href="#" id="pv-edit-pdf-dup-open" style="color:#0F3460;text-decoration:underline;">ver original</a>)` : '') +
          `. Revisa si es un duplicado antes de re-subirlo.`;
        const a = document.getElementById('pv-edit-pdf-dup-open');
        if (a) a.addEventListener('click', (ev) => { ev.preventDefault(); openDetail(d.duplicate_of); });
      } else {
        status.style.color = '#b91c1c';
        status.textContent = `Error: ${d.detail || d.error || r.status}`;
      }
    } catch (e) {
      status.style.color = '#b91c1c';
      status.textContent = `Error de red: ${e.message}`;
    }
  }

  // Paint the "Sin PMID" toggle based on the article's current
  // pubmed_unavailable flag. Called both when the modal opens for a
  // new article (reset from previous state — the styling sticks
  // visually otherwise) and after the user toggles it.
  function _editSyncNoPmidButton(unavailable) {
    const btn = document.getElementById('pv-edit-no-pmid');
    if (!btn) return;
    btn.disabled = false;
    if (unavailable) {
      btn.textContent     = '✓ Sin PMID — pulsa para deshacer';
      btn.style.background  = '#d1fae5';
      btn.style.color       = '#047857';
      btn.style.borderColor = '#a7f3d0';
      btn.title = 'Marcado como confirmado-sin-PMID. Pulsa para desmarcar y volver a la cola de búsqueda.';
    } else {
      btn.textContent     = '✗ Sin PMID';
      btn.style.background  = 'white';
      btn.style.color       = '#b91c1c';
      btn.style.borderColor = '#fecaca';
      btn.title = 'Marca este artículo como "no tiene PMID en PubMed". Lo excluye de futuras búsquedas de PMID a mano o en bulk.';
    }
  }

  // "✗ Sin PMID" toggle right of the PMID input. Reads the article's
  // current pubmed_unavailable flag and flips it via the existing
  // /articles/<id>/mark-no-pmid endpoint (same one the PMID-manual
  // panel uses), then repaints the button to reflect the new state.
  async function _editMarkNoPmid() {
    if (!_editTarget) return;
    const currently = !!_editTarget.pubmed_unavailable;
    const goingTo   = !currently;
    const confirmMsg = goingTo
      ? ('Marcar este artículo como confirmado-sin-PMID?\n\n' +
         '• La búsqueda automática lo saltará en futuros lotes.\n' +
         '• Desaparece de la lista de "Recuperar PMIDs faltantes".\n' +
         '¿Continuar?')
      : ('Desmarcar "sin PMID"?\n\n' +
         '• El artículo vuelve a la cola de búsqueda de PMID.\n' +
         '¿Continuar?');
    if (!confirm(confirmMsg)) return;

    const btn = document.getElementById('pv-edit-no-pmid');
    const orig = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = '⏳…'; }
    try {
      await api(`/articles/${_editTarget.id}/mark-no-pmid`, {
        method: 'POST',
        body: JSON.stringify({ value: goingTo }),
      });
      // Persist the change on the local _editTarget so navigating
      // Siguiente / Anterior + coming back paints the right state.
      _editTarget.pubmed_unavailable = goingTo;
      _editSyncNoPmidButton(goingTo);
      _editStatus(
        goingTo
          ? 'Marcado como "sin PMID". Las búsquedas automáticas lo dejarán en paz.'
          : 'Desmarcado. El artículo vuelve a la cola de búsqueda de PMID.',
        '#15803d',
      );
    } catch (e) {
      _editStatus(`Error: ${e.message}`, '#b91c1c');
      if (btn) { btn.disabled = false; btn.textContent = orig; }
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
    const close = () => {
      modal.style.display = 'none';
      _editTarget = null;
      // Drop the iframe so it stops loading / playing PDF.js timers.
      const pdfBox = document.getElementById('pv-edit-pdf-preview');
      if (pdfBox) { pdfBox.style.display = 'none'; pdfBox.innerHTML = ''; }
    };
    document.getElementById('pv-edit-close') ?.addEventListener('click', close);
    document.getElementById('pv-edit-cancel')?.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop')?.addEventListener('click', close);
    document.getElementById('pv-edit-doi-copy')?.addEventListener('click', () => {
      const val = document.getElementById('pv-edit-doi').value.trim();
      if (!val) return;
      navigator.clipboard.writeText(val).then(() => {
        const btn = document.getElementById('pv-edit-doi-copy');
        const prev = btn.textContent;
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = prev; }, 1500);
      });
    });
    document.getElementById('pv-edit-refetch-doi') ?.addEventListener('click', () => _editRefetch('doi'));
    document.getElementById('pv-edit-refetch-pmid')?.addEventListener('click', () => _editRefetch('pmid'));
    document.getElementById('pv-edit-identify-ai') ?.addEventListener('click', _editIdentifyAI);
    document.getElementById('pv-edit-no-pmid')     ?.addEventListener('click', _editMarkNoPmid);

    // Quick filler for the "no abstract" case — saves the admin from
    // copy-pasting the literal sentinel string. Doesn't auto-save;
    // the user still has to press Guardar so this composes with
    // any other edits in flight.
    document.getElementById('pv-edit-no-abstract')?.addEventListener('click', () => {
      const ta = document.getElementById('pv-edit-abstract');
      if (ta) {
        ta.value = 'No abstract available.';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        _editStatus('Abstract marcado como "No abstract available." — recuerda Guardar.', '#6b7280');
      }
    });

    // Keep the "PMID ↗" link in sync with whatever's in the input.
    // Hidden when empty so the user only sees it when there's an
    // actual PubMed entry to open.
    const pmidInput = document.getElementById('pv-edit-pmid');
    if (pmidInput) {
      const syncPmidLink = () => _editSyncPmidLink(pmidInput.value);
      pmidInput.addEventListener('input', syncPmidLink);
      pmidInput.addEventListener('change', syncPmidLink);
    }

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
      loadArticles();
      await _editAdvanceTo(nextId, 'Guardado.');
    });

    // Plain "Siguiente →" / "← Anterior": no save, no delete, just
    // move on. Useful when the current row is fine as-is and the
    // admin wants to skim through the list.
    document.getElementById('pv-edit-next')?.addEventListener('click', async () => {
      const nextId = _editNextRowId();
      await _editAdvanceTo(nextId, '');
    });
    document.getElementById('pv-edit-prev')?.addEventListener('click', async () => {
      const prevId = _editPrevRowId();
      await _editAdvanceTo(prevId, '');
    });

    // "🗑 Borrar artículo": typically used right after the AI flow
    // surfaces "este ya está metido". Wipes the row + PDF and jumps
    // straight to the next article so the triage keeps flowing.
    // When the deleted row was the last on the current page, advance
    // to the next page automatically and open its first visible row.
    document.getElementById('pv-edit-delete')?.addEventListener('click', async () => {
      if (!_editTarget) return;
      // Capture now — modal close can null _editTarget while await is pending.
      const target = _editTarget;
      const stub = (target.title || '').slice(0, 80);
      const ok = confirm(
        'Vas a eliminar este artículo de la biblioteca:\n\n' +
        `"${stub}${(target.title || '').length > 80 ? '…' : ''}"\n\n` +
        '• La fila se borra de la base de datos.\n' +
        '• El PDF se borra de Dropbox (queda en el historial ~30 días).\n' +
        '• Desaparece de PrionRead, PrionPacks, asignaciones y ratings.\n\n' +
        'Esta acción no se puede deshacer desde la app. ¿Continuar?'
      );
      if (!ok) return;
      // Snapshot navigation context BEFORE the row disappears.
      const nextId = _editNextRowId();
      const hasMorePages = (state.page * state.size) < (state.lastTotal || 0);
      const btn = document.getElementById('pv-edit-delete');
      const orig = btn ? btn.textContent : null;
      if (btn) { btn.disabled = true; btn.textContent = 'Eliminando…'; }
      try {
        await api(`/articles/${target.id}`, { method: 'DELETE' });
      } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = orig; }
        _editStatus('Error al eliminar: ' + e.message, '#b91c1c');
        return;
      }
      if (state.selectedIds && state.selectedIds.has(target.id)) {
        state.selectedIds.delete(target.id);
        if (typeof updateBulkBar === 'function') updateBulkBar();
      }
      refreshStats();
      if (btn) { btn.disabled = false; btn.textContent = orig; }

      if (nextId) {
        loadArticles();
        await _editAdvanceTo(nextId, 'Artículo eliminado.');
        return;
      }
      if (hasMorePages) {
        state.page += 1;
        await loadArticles();
        const firstRow = document.querySelector('.pv-row-select');
        const firstId  = firstRow ? firstRow.dataset.aid : null;
        await _editAdvanceTo(firstId, `Artículo eliminado. Página ${state.page}.`);
        return;
      }
      loadArticles();
      _editStatus('Artículo eliminado. No hay más artículos.', '#15803d');
    });

    // Provider selector — saves immediately on change
    document.getElementById('pv-edit-summary-provider')?.addEventListener('change', async (e) => {
      if (!_editTarget) return;
      const val = e.target.value || null;
      try {
        await api(`/articles/${_editTarget.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ summary_ai_provider: val }),
        });
        _editTarget.summary_ai_provider = val;
        _editStatus('Proveedor actualizado.', '#15803d');
        // Refresh the row badge in the list without a full reload
        const row = document.querySelector(`[data-aid="${_editTarget.id}"]`)?.closest('tr,li,.pv-row');
        if (row) loadArticles();
      } catch (err) {
        _editStatus('Error al guardar proveedor: ' + err.message, '#b91c1c');
      }
    });

    // Clear error note button
    document.getElementById('pv-edit-clear-notes')?.addEventListener('click', async () => {
      if (!_editTarget) return;
      const btn = document.getElementById('pv-edit-clear-notes');
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = '⏳';
      try {
        await api(`/articles/${_editTarget.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ summary_ai_notes: null }),
        });
        _editTarget.summary_ai_notes = null;
        _editRenderTokensBlock(_editTarget);
        _editStatus('Nota de error eliminada.', '#15803d');
      } catch (err) {
        _editStatus('Error: ' + err.message, '#b91c1c');
      } finally {
        btn.disabled = false; btn.textContent = orig;
      }
    });

    // PDF verification quick-actions
    document.getElementById('pv-edit-verify-ok')?.addEventListener('click', async () => {
      if (!_editTarget) return;
      const btn = document.getElementById('pv-edit-verify-ok');
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = '⏳';
      try {
        await api('/admin/verify-metadata/mark', {
          method: 'POST',
          body: JSON.stringify({ ids: [_editTarget.id], status: 'manual_ok' }),
        });
        // Refresh the block with the new status
        if (_editTarget.pdf_verify) _editTarget.pdf_verify.status = 'manual_ok';
        _editRenderVerifyBlock(_editTarget);
        _editStatus('Marcado como OK manual.', '#15803d');
      } catch (e) {
        _editStatus('Error: ' + e.message, '#b91c1c');
      } finally {
        btn.disabled = false; btn.textContent = orig;
      }
    });

    document.getElementById('pv-edit-verify-recheck')?.addEventListener('click', async () => {
      if (!_editTarget) return;
      const btn = document.getElementById('pv-edit-verify-recheck');
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = '⏳';
      try {
        await api('/admin/verify-metadata/recheck', {
          method: 'POST',
          body: JSON.stringify({ ids: [_editTarget.id] }),
        });
        // Clear the verification block — will be set on next verifier run
        if (_editTarget.pdf_verify) _editTarget.pdf_verify.status = null;
        _editRenderVerifyBlock(_editTarget);
        _editStatus('Marcado para reverificación. Se analizará en el próximo ciclo.', '#6b7280');
      } catch (e) {
        _editStatus('Error: ' + e.message, '#b91c1c');
      } finally {
        btn.disabled = false; btn.textContent = orig;
      }
    });
  }

  // Shared "open the next article in the visible list" helper. If
  // there's no next row on the current page, closes the modal with
  // a status message instead so the admin knows pagination is the
  // next step.
  async function _editAdvanceTo(nextId, prefix) {
    if (!nextId) {
      const msg = (prefix ? prefix + ' ' : '') + 'No hay más artículos en esta página.';
      _editStatus(msg.trim(), '#15803d');
      return;
    }
    if (prefix) _editStatus(`${prefix} Cargando siguiente…`, '#15803d');
    try {
      const next = await api(`/articles/${nextId}`);
      openEditModal(next);
    } catch (e) {
      _editStatus(`${prefix || ''} No se pudo abrir el siguiente: ${e.message}`.trim(), '#b91c1c');
    }
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

  // ── Article AI chat ──────────────────────────────────────────────────
  // A per-article Q&A modal. The prompt behind each question bundles the
  // article (vectorized text), its AI summary and the prior turns of the
  // conversation. Provider fallback (Claude → GPT → Gemini) is handled
  // server-side; the UI just flags when a switch happened. Conversations
  // are persisted so the user can revisit them later.
  const PVChat = (() => {
    let _article = null;   // { id, title }
    let _chatId  = null;   // active conversation id (null until first send)
    let _sending = false;

    const $ = id => document.getElementById(id);

    function providerLabel(key) {
      return ({ anthropic: 'Claude', openai: 'GPT', gemini: 'Gemini' })[key] || key || '';
    }

    async function populateProviders() {
      const sel = $('pv-chat-provider');
      if (!sel) return;
      let providers = {};
      try {
        const r = await api('/chat-providers');
        providers = r.providers || {};
      } catch (e) { /* fall through to a bare default */ }
      const keys = Object.keys(providers);
      if (!keys.length) {
        sel.innerHTML =
          '<option value="anthropic">Claude</option>' +
          '<option value="openai">GPT</option>' +
          '<option value="gemini">Gemini</option>';
      } else {
        sel.innerHTML = keys.map(k => {
          const p = providers[k];
          const off = !p.configured;
          return `<option value="${esc(k)}" ${off ? 'disabled' : ''}>${esc(p.label)}${off ? ' (sin API key)' : ''}</option>`;
        }).join('');
      }
      const stored = localStorage.getItem('pv-chat-provider') || 'anthropic';
      const ok = !providers[stored] || providers[stored].configured;
      sel.value = ok ? stored
                     : (keys.find(k => providers[k].configured) || 'anthropic');
      sel.onchange = () => { if (sel.value) localStorage.setItem('pv-chat-provider', sel.value); };
    }

    function scrollToBottom() {
      const m = $('pv-chat-messages');
      if (m) m.scrollTop = m.scrollHeight;
    }

    function bubbleUser(text) {
      return `<div style="display:flex;justify-content:flex-end;margin:0 0 12px;">
        <div style="max-width:82%;background:#0F3460;color:#fff;border-radius:12px 12px 3px 12px;
                    padding:9px 13px;font-size:13.5px;line-height:1.55;white-space:pre-wrap;">${esc(text)}</div>
      </div>`;
    }

    function bubbleAssistant(text, meta) {
      const m = meta || {};
      const label = m.provider_label || providerLabel(m.provider);
      const badge = label
        ? `<span style="display:inline-block;background:#eef2ff;color:#4f46e5;font-size:10.5px;
                   font-weight:700;padding:1px 7px;border-radius:10px;margin-bottom:5px;">${esc(label)}</span>`
        : '';
      return `<div style="display:flex;justify-content:flex-start;margin:0 0 12px;">
        <div style="max-width:88%;">
          ${badge}
          <div style="background:#f9fafb;border:1px solid #e5e7eb;color:#374151;
                      border-radius:12px 12px 12px 3px;padding:10px 13px;font-size:13.5px;
                      line-height:1.6;white-space:pre-wrap;">${markdownLite(text)}</div>
        </div>
      </div>`;
    }

    function renderMessages(messages) {
      const m = $('pv-chat-messages');
      if (!m) return;
      if (!messages || !messages.length) {
        m.innerHTML = `<div style="text-align:center;color:#9ca3af;font-size:13px;padding:36px 12px;">
          Hazle a la IA cualquier pregunta sobre este artículo.<br>
          <span style="font-size:11.5px;">Metodología, resultados, limitaciones, comparación con otros trabajos…</span>
        </div>`;
        return;
      }
      m.innerHTML = messages.map(msg =>
        msg.role === 'user'
          ? bubbleUser(msg.content)
          : bubbleAssistant(msg.content, msg)
      ).join('');
      scrollToBottom();
    }

    function showSwitchNote(result) {
      const note = $('pv-chat-switch-note');
      if (!note) return;
      if (result && result.switched) {
        const from = providerLabel(result.requested_provider);
        const to   = result.provider_label || providerLabel(result.actual_provider);
        note.style.display = 'block';
        note.innerHTML = `⚠ <strong>${esc(from)}</strong> no pudo responder — te contesté con <strong>${esc(to)}</strong>.`;
      } else {
        note.style.display = 'none';
        note.innerHTML = '';
      }
    }

    async function ensureConversation() {
      if (_chatId) return _chatId;
      const provider = ($('pv-chat-provider') || {}).value || 'anthropic';
      const r = await api(`/articles/${_article.id}/chats`, {
        method: 'POST',
        body: JSON.stringify({ provider }),
      });
      _chatId = r.chat_id;
      return _chatId;
    }

    async function send() {
      if (_sending) return;
      const input = $('pv-chat-input');
      const question = (input.value || '').trim();
      if (!question) return;
      _sending = true;
      const sendBtn = $('pv-chat-send');
      if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '…'; }

      const m = $('pv-chat-messages');
      // Clear the placeholder if this is the first message.
      if (m && m.querySelector('div[style*="text-align:center"]')) m.innerHTML = '';
      if (m) m.insertAdjacentHTML('beforeend', bubbleUser(question));
      input.value = '';
      const thinkingId = 'pv-chat-thinking';
      if (m) {
        m.insertAdjacentHTML('beforeend',
          `<div id="${thinkingId}" style="display:flex;justify-content:flex-start;margin:0 0 12px;">
             <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;
                         padding:10px 13px;font-size:13px;color:#9ca3af;">
               <i class="fas fa-spinner fa-spin"></i> Pensando…
             </div>
           </div>`);
      }
      scrollToBottom();

      try {
        await ensureConversation();
        const provider = ($('pv-chat-provider') || {}).value || undefined;
        const r = await api(`/chats/${_chatId}/ask`, {
          method: 'POST',
          body: JSON.stringify({ question, provider }),
        });
        $(thinkingId)?.remove();
        if (m) m.insertAdjacentHTML('beforeend', bubbleAssistant(r.answer, r));
        showSwitchNote(r);
        scrollToBottom();
        updateLauncherCount(_article);
      } catch (e) {
        $(thinkingId)?.remove();
        let detail = e.message || 'Error desconocido';
        if (e.body && e.body.attempts && e.body.attempts.length) {
          detail += ' — ' + e.body.attempts
            .map(a => `${providerLabel(a.provider)}: ${a.reason}`).join('; ');
        }
        if (m) m.insertAdjacentHTML('beforeend',
          `<div style="margin:0 0 12px;font-size:12.5px;color:#b91c1c;background:#fef2f2;
                       border:1px solid #fecaca;border-radius:10px;padding:9px 12px;">
             No se pudo obtener respuesta: ${esc(detail)}
           </div>`);
        scrollToBottom();
      } finally {
        _sending = false;
        if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Enviar'; }
      }
    }

    function newConversation() {
      _chatId = null;
      showSwitchNote(null);
      renderMessages([]);
      const panel = $('pv-chat-history-panel');
      if (panel) panel.style.display = 'none';
      const input = $('pv-chat-input');
      if (input) input.focus();
    }

    async function loadHistory() {
      const panel = $('pv-chat-history-panel');
      const list  = $('pv-chat-history-list');
      if (!panel || !list) return;
      panel.style.display = 'block';
      list.innerHTML = '<div style="color:#9ca3af;font-size:12.5px;padding:6px;">Cargando…</div>';
      try {
        const r = await api(`/articles/${_article.id}/chats`);
        const chats = r.chats || [];
        if (!chats.length) {
          list.innerHTML = '<div style="color:#9ca3af;font-size:12.5px;padding:6px;">Aún no hay conversaciones sobre este artículo.</div>';
          return;
        }
        list.innerHTML = chats.map(c => {
          const when = c.updated_at ? new Date(c.updated_at).toLocaleString() : '';
          const label = c.provider_label || providerLabel(c.requested_provider);
          return `<div class="pv-chat-hist-item" data-cid="${esc(c.id)}"
                       style="border:1px solid #e5e7eb;border-radius:8px;padding:9px 11px;margin-bottom:7px;
                              cursor:pointer;background:#fff;display:flex;gap:10px;align-items:center;">
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;color:#111827;font-weight:600;white-space:nowrap;
                          overflow:hidden;text-overflow:ellipsis;">${esc(c.title || 'Conversación')}</div>
              <div style="font-size:11px;color:#9ca3af;margin-top:2px;">
                ${esc(when)} · ${c.message_count || 0} mensaje${(c.message_count||0) === 1 ? '' : 's'}
              </div>
            </div>
            <span style="background:#eef2ff;color:#4f46e5;font-size:10.5px;font-weight:700;
                         padding:1px 7px;border-radius:10px;flex-shrink:0;">${esc(label)}</span>
            <button class="pv-chat-hist-del" data-cid="${esc(c.id)}" title="Eliminar conversación"
                    style="flex-shrink:0;background:none;border:none;color:#b91c1c;cursor:pointer;font-size:13px;">🗑</button>
          </div>`;
        }).join('');
        list.querySelectorAll('.pv-chat-hist-item').forEach(el => {
          el.addEventListener('click', ev => {
            if (ev.target.closest('.pv-chat-hist-del')) return;
            openConversation(el.dataset.cid);
          });
        });
        list.querySelectorAll('.pv-chat-hist-del').forEach(btn => {
          btn.addEventListener('click', async ev => {
            ev.stopPropagation();
            if (!confirm('¿Eliminar esta conversación? No se puede deshacer.')) return;
            try {
              await api(`/chats/${btn.dataset.cid}`, { method: 'DELETE' });
              if (_chatId === btn.dataset.cid) newConversation();
              loadHistory();
              updateLauncherCount(_article);
            } catch (e) { alert('No se pudo eliminar: ' + e.message); }
          });
        });
      } catch (e) {
        list.innerHTML = `<div style="color:#b91c1c;font-size:12.5px;padding:6px;">Error: ${esc(e.message)}</div>`;
      }
    }

    async function openConversation(chatId) {
      const m = $('pv-chat-messages');
      if (m) m.innerHTML = '<div style="text-align:center;color:#9ca3af;padding:30px;font-size:13px;">Cargando…</div>';
      const panel = $('pv-chat-history-panel');
      if (panel) panel.style.display = 'none';
      showSwitchNote(null);
      try {
        const chat = await api(`/chats/${chatId}`);
        _chatId = chat.id;
        const sel = $('pv-chat-provider');
        if (sel && chat.requested_provider) sel.value = chat.requested_provider;
        renderMessages(chat.messages || []);
      } catch (e) {
        if (m) m.innerHTML = `<div style="color:#b91c1c;padding:16px;font-size:13px;">Error: ${esc(e.message)}</div>`;
      }
    }

    async function updateLauncherCount(article) {
      const badge = document.getElementById('pv-detail-chat-count');
      if (!badge || !article) return;
      try {
        const r = await api(`/articles/${article.id}/chats`);
        const n = (r.chats || []).length;
        if (n > 0) { badge.style.display = 'inline-block'; badge.textContent = n; }
        else       { badge.style.display = 'none'; }
      } catch (e) { /* silent */ }
    }

    let _wired = false;
    function wireOnce() {
      if (_wired) return;
      _wired = true;
      $('pv-chat-close')?.addEventListener('click', close);
      document.querySelector('#pv-chat-modal .pv-modal-backdrop')?.addEventListener('click', close);
      $('pv-chat-send')?.addEventListener('click', send);
      $('pv-chat-new-btn')?.addEventListener('click', newConversation);
      $('pv-chat-history-btn')?.addEventListener('click', loadHistory);
      const input = $('pv-chat-input');
      if (input) input.addEventListener('keydown', ev => {
        // Enter sends, Shift+Enter makes a newline.
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
      });
    }

    function open(article, opts = {}) {
      _article = article;
      _chatId = null;
      wireOnce();
      const modal = document.getElementById('pv-chat-modal');
      if (!modal) return;
      const titleEl = document.getElementById('pv-chat-article-title');
      if (titleEl) titleEl.innerHTML = supHtml(article.title || '(sin título)');
      const metaEl = document.getElementById('pv-chat-article-meta');
      if (metaEl) {
        const bits = [];
        if (article.authors) bits.push(esc(article.authors));
        const line2 = [];
        if (article.journal) line2.push(esc(article.journal));
        if (article.year)    line2.push(String(article.year));
        if (line2.length) bits.push(line2.join(' · '));
        if (article.doi) {
          bits.push(`<a href="https://doi.org/${esc(article.doi)}" target="_blank" rel="noopener"
                        style="color:#0F3460;text-decoration:none;">${esc(article.doi)}</a>`);
        } else if (article.pubmed_id) {
          bits.push(`PMID ${esc(article.pubmed_id)}`);
        }
        metaEl.innerHTML = bits.join('<br>');
      }
      showSwitchNote(null);
      renderMessages([]);
      modal.style.display = 'flex';
      populateProviders();
      if (opts.showHistory) loadHistory();
      else {
        const panel = $('pv-chat-history-panel');
        if (panel) panel.style.display = 'none';
        $('pv-chat-input')?.focus();
      }
    }

    function close() {
      const modal = document.getElementById('pv-chat-modal');
      if (modal) modal.style.display = 'none';
    }

    return { open, close, updateLauncherCount };
  })();

  function wireChatLauncher(a) {
    const btn     = document.getElementById('pv-detail-chat-btn');
    const histBtn = document.getElementById('pv-detail-chat-history-btn');
    if (btn)     btn.addEventListener('click', () => PVChat.open(a, { showHistory: false }));
    if (histBtn) histBtn.addEventListener('click', () => PVChat.open(a, { showHistory: true }));
    PVChat.updateLauncherCount(a);
  }

  // ── Share article by email ───────────────────────────────────────────
  const PVEmailShare = (() => {
    let _article = null;
    let _me = null;         // {name, email} cached
    let _dirLoaded = false; // users datalist loaded
    let _wired = false;
    const LAST_KEY = 'pv-share-last-email';
    const COMMENT_KEY = 'pv-share-last-comment';
    const $ = id => document.getElementById(id);

    function wireOnce() {
      if (_wired) return;
      _wired = true;
      $('pv-email-close')?.addEventListener('click', close);
      document.querySelector('#pv-email-modal .pv-modal-backdrop')?.addEventListener('click', close);
      $('pv-email-send')?.addEventListener('click', send);
      $('pv-email-preview')?.addEventListener('click', preview);
      $('pv-email-to')?.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
      const ctog = $('pv-email-comment-toggle');
      ctog?.addEventListener('change', () => {
        const ta = $('pv-email-comment');
        ta.style.display = ctog.checked ? 'block' : 'none';
        if (ctog.checked) ta.focus();
      });
      // Preview modal close.
      $('pv-email-preview-close')?.addEventListener('click', () => {
        const m = $('pv-email-preview-modal'); if (m) m.style.display = 'none';
      });
      document.querySelector('#pv-email-preview-modal .pv-modal-backdrop')
        ?.addEventListener('click', () => {
          const m = $('pv-email-preview-modal'); if (m) m.style.display = 'none';
        });
    }

    async function loadDirectory() {
      const sel = $('pv-email-user-select');
      if (sel && !sel.dataset.wired) {
        sel.dataset.wired = '1';
        sel.addEventListener('change', () => {
          if (sel.value) { $('pv-email-to').value = sel.value; }
        });
      }
      if (_dirLoaded) return;
      _dirLoaded = true;
      try {
        const r = await api('/users-directory');
        const users = r.users || [];
        if (sel) sel.innerHTML =
          '<option value="">— Elegir de la lista de usuarios —</option>' +
          users.map(u => `<option value="${esc(u.email)}">${esc(u.name ? u.name + ' — ' + u.email : u.email)}</option>`).join('');
      } catch (e) { /* silent */ }
    }

    function currentOptions() {
      const includeSummary = $('pv-email-include-summary')?.checked !== false;
      const commentOn = $('pv-email-comment-toggle')?.checked;
      const comment = commentOn ? ($('pv-email-comment').value || '').trim() : '';
      return { include_summary: includeSummary, comment };
    }

    async function preview() {
      const btn = $('pv-email-preview');
      const status = $('pv-email-status');
      btn.disabled = true;
      status.style.color = '#9ca3af'; status.textContent = 'Generando previsualización…';
      try {
        const r = await api(`/articles/${_article.id}/email/preview`, {
          method: 'POST', body: JSON.stringify(currentOptions()),
        });
        const frame = $('pv-email-preview-frame');
        if (frame) frame.srcdoc = r.html || '';
        const m = $('pv-email-preview-modal');
        if (m) m.style.display = 'flex';
        status.textContent = '';
      } catch (e) {
        status.style.color = '#b91c1c'; status.textContent = 'Error: ' + e.message;
      } finally { btn.disabled = false; }
    }

    async function open(article) {
      _article = article;
      wireOnce();
      const modal = $('pv-email-modal');
      if (!modal) return;
      const meta = [article.journal, article.year].filter(Boolean).join(' · ');
      $('pv-email-article').innerHTML = supHtml(article.title || '') +
        (meta ? `<div style="font-weight:400;color:#6b7280;font-size:12px;">${esc(meta)}</div>` : '');
      $('pv-email-status').textContent = '';
      $('pv-email-hint').textContent = '';
      const sel = $('pv-email-user-select');
      if (sel) sel.value = '';
      // Prefill the comment with the last one used, if any.
      const lastComment = (() => { try { return localStorage.getItem(COMMENT_KEY) || ''; } catch (e) { return ''; } })();
      const ctog = $('pv-email-comment-toggle');
      const cta = $('pv-email-comment');
      if (cta) { cta.value = lastComment; cta.style.display = lastComment ? 'block' : 'none'; }
      if (ctog) ctog.checked = !!lastComment;
      const incS = $('pv-email-include-summary');
      if (incS) incS.checked = true;
      modal.style.display = 'flex';
      loadDirectory();
      const toEl = $('pv-email-to');
      if (!_me) { try { _me = await api('/me'); } catch (e) { _me = { name: '', email: '' }; } }
      // Prefill with the last email used, else the admin's own email.
      const last = (() => { try { return localStorage.getItem(LAST_KEY) || ''; } catch (e) { return ''; } })();
      toEl.value = last || _me.email || '';
      $('pv-email-hint').innerHTML = last
        ? `Último usado. Empieza a escribir para elegir de la lista de usuarios, o pon otro.`
        : (_me.email
            ? `Por defecto: ${_me.name ? esc(_me.name) + ' ' : ''}&lt;${esc(_me.email)}&gt;. Elige de la lista o escribe otro.`
            : 'Escribe la dirección de destino.');
      toEl.focus();
      toEl.select();
    }

    function close() { const m = $('pv-email-modal'); if (m) m.style.display = 'none'; }

    async function send() {
      const to = ($('pv-email-to').value || '').trim();
      const status = $('pv-email-status');
      if (!to) { status.style.color = '#b91c1c'; status.textContent = 'Indica una dirección de email.'; return; }
      const btn = $('pv-email-send');
      btn.disabled = true;
      status.style.color = '#9ca3af';
      status.textContent = 'Enviando…';
      const opts = currentOptions();
      try {
        const r = await api(`/articles/${_article.id}/email`, {
          method: 'POST',
          body: JSON.stringify({ to, ...opts }),
        });
        try {
          localStorage.setItem(LAST_KEY, to);
          if (opts.comment) localStorage.setItem(COMMENT_KEY, opts.comment);
          else localStorage.removeItem(COMMENT_KEY);
        } catch (e) { /* ignore */ }
        status.style.color = '#15803d';
        const pdfNote = r.attached_pdf ? ' (con PDF adjunto)'
          : (r.has_pdf ? ' (sin PDF: no disponible o demasiado grande)' : ' (este artículo no tiene PDF)');
        status.textContent = '✓ Enviado' + pdfNote;
        setTimeout(close, 1800);
      } catch (e) {
        status.style.color = '#b91c1c';
        status.textContent = 'Error: ' + e.message;
      } finally {
        btn.disabled = false;
      }
    }

    return { open, close };
  })();

  // ── Sticky notes (per-article, per-user) ─────────────────────────────
  // Row cluster: one coloured icon per note + a grey "add" icon (≤5).
  function _noteClusterInner(notes) {
    const list = (notes || []).slice().sort((x, y) => x.color_index - y.color_index);
    const icons = list.map(n => {
      const c = PV_NOTE_COLORS[n.color_index] || PV_NOTE_COLORS[0];
      return `<button type="button" class="pv-note-icon" data-note-id="${esc(n.id)}"
                      title="Abrir nota ${esc(c.name.toLowerCase())}"
                      style="display:inline-flex;align-items:center;padding:1px 6px;border-radius:4px;
                             font-size:10.5px;border:none;cursor:pointer;line-height:1.2;
                             background:${c.bg};color:${c.text};"><i class="fas fa-sticky-note"></i></button>`;
    }).join('');
    const addIcon = list.length < PV_MAX_NOTES
      ? `<button type="button" class="pv-note-add"
                 title="${list.length ? 'Añadir otra nota' : 'Añadir una nota'}"
                 style="display:inline-flex;align-items:center;padding:1px 6px;border-radius:4px;
                        font-size:10.5px;border:none;cursor:pointer;line-height:1.2;
                        background:#f3f4f6;color:#9ca3af;"><i class="far fa-sticky-note"></i></button>`
      : '';
    return icons + addIcon;
  }

  function _wireNoteCluster(container, a) {
    container.querySelectorAll('.pv-note-icon').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        PVNotes.open(a, { noteId: btn.dataset.noteId });
      });
    });
    const addBtn = container.querySelector('.pv-note-add');
    if (addBtn) addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      PVNotes.open(a, { create: true });
    });
  }

  // Re-render every row cluster for this article after a note change,
  // and keep the in-memory article object's `notes` in sync.
  function _refreshNoteClusters(aid, notes, article) {
    if (article) article.notes = notes;
    document.querySelectorAll(`.pv-notes-cluster[data-aid="${window.CSS && CSS.escape ? CSS.escape(aid) : aid}"]`)
      .forEach(cl => {
        cl.innerHTML = _noteClusterInner(notes);
        _wireNoteCluster(cl, article || { id: aid, notes });
      });
  }

  const PVNotes = (() => {
    let _article = null;
    let _notes = [];          // [{id, color_index, body, ...}]
    let _activeId = null;     // note id being edited, or null in compose mode
    let _composeIndex = null; // colour index for a new note in compose mode
    let _wired = false;

    const $ = id => document.getElementById(id);

    // Whitelist-sanitize contenteditable HTML (safe tags + base64 images).
    function sanitize(html) {
      const doc = new DOMParser().parseFromString(html || '', 'text/html');
      const ALLOWED = new Set(['b','i','strong','em','br','p','div','span','ul','ol','li','img']);
      (function walk(node) {
        Array.from(node.childNodes).forEach(child => {
          if (child.nodeType === Node.TEXT_NODE) return;
          if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); return; }
          const tag = child.tagName.toLowerCase();
          if (!ALLOWED.has(tag)) {
            const frag = document.createDocumentFragment();
            Array.from(child.childNodes).forEach(c => frag.appendChild(c.cloneNode(true)));
            child.replaceWith(frag);
            return;
          }
          if (tag === 'img') {
            const src = child.getAttribute('src') || '';
            if (!src.startsWith('data:image/')) { child.remove(); return; }
            while (child.attributes.length) child.removeAttribute(child.attributes[0].name);
            child.setAttribute('src', src);
          } else {
            while (child.attributes.length) child.removeAttribute(child.attributes[0].name);
            walk(child);
          }
        });
      })(doc.body);
      return doc.body.innerHTML;
    }
    function htmlToText(html) {
      const d = document.createElement('div');
      d.innerHTML = html || '';
      return d.textContent || '';
    }
    function compressImage(file) {
      return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = ev => {
          const img = new Image();
          img.onload = () => {
            const MAX = 900;
            let w = img.width, h = img.height;
            if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', 0.65));
          };
          img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
      });
    }

    function nextFreeIndex() {
      const used = new Set(_notes.map(n => n.color_index));
      for (let i = 0; i < PV_MAX_NOTES; i++) if (!used.has(i)) return i;
      return null;
    }

    function activeColor() {
      const idx = _activeId != null
        ? (_notes.find(n => n.id === _activeId) || {}).color_index
        : _composeIndex;
      return PV_NOTE_COLORS[idx] || PV_NOTE_COLORS[0];
    }

    function renderTabs() {
      const tabs = $('pv-note-tabs');
      if (!tabs) return;
      const sorted = _notes.slice().sort((a, b) => a.color_index - b.color_index);
      let html = sorted.map(n => {
        const c = PV_NOTE_COLORS[n.color_index] || PV_NOTE_COLORS[0];
        const active = n.id === _activeId;
        return `<button type="button" class="pv-note-tab" data-note-id="${esc(n.id)}"
                        title="Nota ${esc(c.name.toLowerCase())}"
                        style="width:26px;height:26px;border-radius:50%;cursor:pointer;
                               background:${c.bg};border:2px solid ${active ? c.text : 'transparent'};
                               box-shadow:0 1px 2px rgba(0,0,0,0.12);"></button>`;
      }).join('');
      if (_notes.length < PV_MAX_NOTES) {
        const composing = _activeId == null;
        html += `<button type="button" class="pv-note-tab-add"
                        title="Nueva nota"
                        style="width:26px;height:26px;border-radius:50%;cursor:pointer;
                               background:#f3f4f6;color:#9ca3af;border:2px dashed ${composing ? '#9ca3af' : '#e5e7eb'};
                               display:inline-flex;align-items:center;justify-content:center;font-size:14px;line-height:1;">+</button>`;
      }
      tabs.innerHTML = html;
      tabs.querySelectorAll('.pv-note-tab').forEach(t =>
        t.addEventListener('click', () => selectNote(t.dataset.noteId)));
      const addT = tabs.querySelector('.pv-note-tab-add');
      if (addT) addT.addEventListener('click', startCompose);
    }

    function applyColor() {
      const c = activeColor();
      const ed = $('pv-note-editor');
      const hd = $('pv-note-modal-head');
      if (ed) { ed.style.background = c.bg; ed.style.color = c.text; }
      if (hd) hd.style.background = c.bg;
      const badge = $('pv-note-color-name');
      if (badge) { badge.textContent = c.name; badge.style.color = c.text; }
    }

    function loadEditor() {
      const ed = $('pv-note-editor');
      if (!ed) return;
      const note = _activeId != null ? _notes.find(n => n.id === _activeId) : null;
      ed.innerHTML = note ? sanitize(note.body || '') : '';
      applyColor();
      const delBtn = $('pv-note-delete');
      if (delBtn) delBtn.style.display = _activeId != null ? 'inline-flex' : 'none';
      const dateEl = $('pv-note-date');
      if (dateEl) dateEl.textContent = (note && note.updated_at)
        ? new Date(note.updated_at).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })
        : '';
      setTimeout(() => ed.focus(), 60);
    }

    function selectNote(noteId) {
      _activeId = noteId;
      _composeIndex = null;
      renderTabs();
      loadEditor();
    }

    function startCompose() {
      const idx = nextFreeIndex();
      if (idx == null) return;   // already at max
      _activeId = null;
      _composeIndex = idx;
      renderTabs();
      loadEditor();
    }

    async function save() {
      const ed = $('pv-note-editor');
      if (!ed) return;
      const html = sanitize(ed.innerHTML || '');
      const plain = htmlToText(html).trim();
      const status = $('pv-note-status');
      if (!plain && !/<img/i.test(html)) {
        if (status) { status.style.color = '#b91c1c'; status.textContent = 'La nota está vacía.'; }
        return;
      }
      const saveBtn = $('pv-note-save');
      if (saveBtn) saveBtn.disabled = true;
      if (status) { status.style.color = '#9ca3af'; status.textContent = 'Guardando…'; }
      try {
        if (_activeId != null) {
          const r = await api(`/notes/${_activeId}`, { method: 'PATCH', body: JSON.stringify({ body: html }) });
          const i = _notes.findIndex(n => n.id === _activeId);
          if (i >= 0) _notes[i] = r.note;
        } else {
          const r = await api(`/articles/${_article.id}/notes`, { method: 'POST', body: JSON.stringify({ body: html }) });
          _notes.push(r.note);
          _activeId = r.note.id;
          _composeIndex = null;
        }
        if (status) { status.style.color = '#15803d'; status.textContent = '✓ Guardada'; }
        renderTabs();
        loadEditor();
        _refreshNoteClusters(_article.id, _notes, _article);
        setTimeout(() => { if (status) status.textContent = ''; }, 2000);
      } catch (e) {
        if (status) {
          status.style.color = '#b91c1c';
          status.textContent = e.status === 409 ? 'Máximo 5 notas por artículo.' : ('Error: ' + e.message);
        }
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    }

    async function del() {
      if (_activeId == null) return;
      if (!confirm('¿Eliminar esta nota? No se puede deshacer.')) return;
      try {
        await api(`/notes/${_activeId}`, { method: 'DELETE' });
        _notes = _notes.filter(n => n.id !== _activeId);
        _refreshNoteClusters(_article.id, _notes, _article);
        if (_notes.length) selectNote(_notes.slice().sort((a, b) => a.color_index - b.color_index)[0].id);
        else startCompose();
      } catch (e) { alert('No se pudo eliminar: ' + e.message); }
    }

    async function handlePaste(e) {
      const items = Array.from(e.clipboardData?.items || []);
      const imgItem = items.find(it => it.type.startsWith('image/'));
      if (!imgItem) return;
      e.preventDefault();
      const file = imgItem.getAsFile();
      if (!file) return;
      const b64 = await compressImage(file);
      const img = document.createElement('img');
      img.src = b64;
      const sel = window.getSelection();
      if (!sel.rangeCount) { $('pv-note-editor')?.appendChild(img); return; }
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(img);
      range.setStartAfter(img);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    function wireOnce() {
      if (_wired) return;
      _wired = true;
      $('pv-note-close')?.addEventListener('click', close);
      document.querySelector('#pv-note-modal .pv-modal-backdrop')?.addEventListener('click', close);
      $('pv-note-save')?.addEventListener('click', save);
      $('pv-note-delete')?.addEventListener('click', del);
      const ed = $('pv-note-editor');
      ed?.addEventListener('paste', handlePaste);
      ed?.addEventListener('keydown', e => {
        if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
      });
    }

    async function open(article, opts = {}) {
      _article = article;
      wireOnce();
      const modal = document.getElementById('pv-note-modal');
      if (!modal) return;
      const titleEl = document.getElementById('pv-note-article-title');
      if (titleEl) titleEl.innerHTML = supHtml(article.title || '');
      const status = $('pv-note-status');
      if (status) status.textContent = '';
      modal.style.display = 'flex';
      const ed = $('pv-note-editor');
      if (ed) ed.innerHTML = '<span style="color:#9ca3af;">Cargando…</span>';
      try {
        const r = await api(`/articles/${article.id}/notes`);
        _notes = r.notes || [];
      } catch (e) {
        _notes = article.notes ? article.notes.map(n => ({ ...n, body: '' })) : [];
      }
      // Keep row clusters in sync with the freshly fetched list.
      _refreshNoteClusters(article.id, _notes, article);
      if (opts.noteId && _notes.some(n => n.id === opts.noteId)) selectNote(opts.noteId);
      else if (opts.create && _notes.length < PV_MAX_NOTES) startCompose();
      else if (_notes.length) selectNote(_notes.slice().sort((a, b) => a.color_index - b.color_index)[0].id);
      else startCompose();
    }

    function close() {
      const modal = document.getElementById('pv-note-modal');
      if (modal) modal.style.display = 'none';
    }

    return { open, close };
  })();

  function renderAiSummary(a) {
    const block = document.getElementById('pv-ai-summary-block');
    if (!block) return;

    const header = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin:0 0 6px;gap:8px;flex-wrap:wrap;">
        <h3 style="margin:0;font-size:14px;font-weight:600;color:#374151;
                   text-transform:uppercase;letter-spacing:0.05em;">AI summary</h3>
        ${IS_ADMIN ? `
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <select id="pv-ai-provider" title="Modelo de IA a usar"
                    style="font-size:11.5px;padding:3px 6px;border-radius:6px;
                           border:1px solid #d1d5db;background:white;color:#374151;
                           max-width:170px;">
              <option value="">Cargando…</option>
            </select>
            <label title="Marcada: la IA recibe la orden de resumir ÚNICAMENTE el artículo cuyo título figura en la ficha e ignorar cualquier otro texto del PDF. Útil cuando el PDF trae varios artículos juntos (p. ej. un número de revista) o texto sobrante de otro trabajo.&#10;&#10;Sin marcar: la IA resume todo el texto extraído del PDF tal cual, sin filtrar por título. Es lo normal cuando el PDF contiene un solo artículo."
                   style="display:inline-flex;align-items:center;gap:4px;font-size:11.5px;
                          color:#374151;cursor:pointer;white-space:nowrap;">
              <input type="checkbox" id="pv-ai-title-hint"
                     title="Marcada: la IA resume solo el artículo cuyo título figura en la ficha e ignora el resto del PDF (útil si el PDF mezcla varios artículos).&#10;&#10;Sin marcar: la IA resume todo el texto del PDF sin filtrar por título (lo habitual con un PDF de un solo artículo)."
                     style="accent-color:#0F3460;cursor:pointer;">
              Usar título como filtro
            </label>
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

    const notesHtml = a.summary_ai_notes
      ? `<div style="margin-top:6px;font-size:12px;color:#b91c1c;background:#fef2f2;
                     border:1px solid #fecaca;border-radius:7px;padding:8px 10px;
                     display:flex;align-items:flex-start;gap:8px;">
           <span style="flex:1;">⚠ <strong>Notas resumen:</strong> ${esc(a.summary_ai_notes)}</span>
           ${IS_ADMIN ? `<button id="pv-detail-clear-notes"
                   style="flex-shrink:0;padding:2px 8px;border-radius:5px;border:1px solid #fecaca;
                          background:white;color:#b91c1c;font-size:11px;cursor:pointer;white-space:nowrap;">
                   ✕ Limpiar
                 </button>` : ''}
         </div>`
      : '';
    const modelLine = (a.summary_ai && a.summary_ai_model)
      ? `<div style="margin-top:4px;font-size:11px;color:#9ca3af;">Modelo: ${esc(a.summary_ai_model)}</div>`
      : '';
    block.innerHTML = header + body + notesHtml + modelLine +
      `<div id="pv-ai-status" style="margin-top:6px;font-size:11.5px;color:#9ca3af;"></div>`;

    if (!IS_ADMIN) return;

    // "Limpiar error" button inside the notes warning box
    const clearNotesBtn = document.getElementById('pv-detail-clear-notes');
    if (clearNotesBtn) {
      clearNotesBtn.addEventListener('click', async () => {
        clearNotesBtn.disabled = true;
        clearNotesBtn.textContent = '⏳';
        try {
          await api(`/articles/${a.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ summary_ai_notes: null }),
          });
          a.summary_ai_notes = null;
          // Remove only the notes div — don't rebuild the whole block
          // so the green success status line stays visible.
          clearNotesBtn.closest('div[style]').remove();
        } catch (err) {
          clearNotesBtn.disabled = false;
          clearNotesBtn.textContent = '✕ Limpiar';
        }
      });
    }

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
      const titleHintEl = document.getElementById('pv-ai-title-hint');
      const titleHint = titleHintEl ? titleHintEl.checked : false;
      genBtn.disabled = true;
      const original = genBtn.textContent;
      genBtn.textContent = '⏳ Generando…';
      statusEl.style.color = '#6b7280';
      statusEl.textContent = 'Llamando a la IA — puede tardar 5-15 s…';
      try {
        const r = await api(`/articles/${a.id}/summary`, {
          method: 'POST',
          body: JSON.stringify({ provider, title_hint: titleHint }),
        });
        a.summary_ai          = r.summary_ai;
        a.summary_ai_provider = r.summary_ai_provider || null;
        a.summary_ai_model    = r.model || null;
        a.summary_tokens_in   = r.summary_tokens_in  || null;
        a.summary_tokens_out  = r.summary_tokens_out || null;
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
    // JC is a shared, admin-only mark — only admins can toggle it.
    const jcBtn = document.getElementById('pv-detail-jc');
    if (jcBtn && IS_ADMIN) jcBtn.addEventListener('click', () => toggle(jcBtn, 'jc-mark', 'is_jc', r => {
      a.is_jc = !!r.is_jc;
      const fresh = renderPersonalChip(a, 'jc');
      jcBtn.outerHTML = fresh;
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
    if (kind === 'jc') {
      return `<button id="pv-detail-jc" type="button"
                  data-active="${a.is_jc ? '1' : '0'}"
                  style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;
                         font-size:12px;font-weight:600;cursor:pointer;
                         ${a.is_jc
                           ? 'background:#f3e8ff;color:#6b21a8;border:1px solid #d8b4fe;'
                           : 'background:#f9fafb;color:#6b7280;border:1px solid #e5e7eb;'}">
                <span style="font-size:12px;line-height:1;color:${a.is_jc ? '#7c3aed' : '#9ca3af'};"><i class="fas fa-book-open"></i></span>
                ${a.is_jc ? 'En Journal Club' : 'Marcar para Journal Club'}
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

    // Clear-search × button: visible only when the input has content,
    // clicking it wipes the box, refocuses, and triggers the same
    // debounced reload as typing would. Esc on the input does the
    // same thing for keyboard users.
    const clearBtn = document.getElementById('pv-search-clear');
    const syncClearBtn = () => {
      if (!clearBtn) return;
      clearBtn.style.display = searchInput.value ? 'inline-flex' : 'none';
    };
    const clearSearch = () => {
      if (!searchInput.value && !state.q) return;
      searchInput.value = '';
      state.q = '';
      syncClearBtn();
      searchInput.focus();
      state.page = 1;
      loadArticles();
    };
    if (clearBtn) clearBtn.addEventListener('click', clearSearch);

    // ── Field-filter microbuttons (T / Au / A) ────────────────────────────
    const FIELD_COLORS = { title: '#2563eb', authors: '#7c3aed', abstract: '#059669' };
    document.querySelectorAll('.pv-field-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.field;
        const idx   = state.searchFields.indexOf(field);
        if (idx === -1) {
          state.searchFields.push(field);
          btn.style.background   = FIELD_COLORS[field];
          btn.style.color        = '#fff';
          btn.style.borderColor  = FIELD_COLORS[field];
        } else {
          state.searchFields.splice(idx, 1);
          btn.style.background  = '#f3f4f6';
          btn.style.color       = '#9ca3af';
          btn.style.borderColor = '#d1d5db';
        }
        state.page = 1;
        loadArticles();
      });
    });

    searchInput.addEventListener('input', e => {
      syncClearBtn();
      if (searchModeBtn.dataset.mode === 'ai') return;  // text-only debounced search
      state.q = e.target.value.trim();
      onSearch();
    });
    searchInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        clearSearch();
        return;
      }
      if (e.key === 'Enter' && searchModeBtn.dataset.mode === 'ai') {
        e.preventDefault();
        runRagSearch(searchInput.value.trim());
      }
    });
    // First paint — in case the input was restored with a value
    // (URL state, persisted filter, etc.).
    syncClearBtn();
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
    wireTriStateButton('btn-filter-jc', 'isJc', {
      null: '📖 Journal Club: todos', true: '📖 Mi Journal Club', false: '📖 Fuera de JC',
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
    // "Sólo JC" is a toggle: off (default) = no filter; on = show
    // only articles with at least one Journal Club presentation.
    // The third state ("only WITHOUT JC") of the old dropdown wasn't
    // a feature anyone reached for; dropping it for the simpler UX.
    const jcBtn = document.getElementById('btn-filter-has-jc');
    if (jcBtn) {
      const paintJc = () => {
        const on = state.hasJc === true;
        jcBtn.style.background    = on ? '#0F3460'   : 'white';
        jcBtn.style.color         = on ? 'white'     : '#374151';
        jcBtn.style.borderColor   = on ? '#0F3460'   : '#e5e7eb';
        jcBtn.style.fontWeight    = on ? '600'       : 'normal';
      };
      paintJc();
      jcBtn.addEventListener('click', () => {
        state.hasJc = state.hasJc === true ? null : true;
        state.page = 1;
        paintJc();
        loadArticles();
      });
    }
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
      // Persist the (possibly clamped) value so a stale "todos" is cleaned up.
      localStorage.setItem('pv-page-size', String(state.size));
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
          if (f === 'notes') {
            // Toggle: clicking again deactivates the notes filter
            state.hasSummary = state.hasSummary === 'human' ? null : 'human';
          } else {
            state.hasSummary = (f === 'no-summary') ? 'none' : null;
          }
          state.sort       = (f === 'recent') ? 'added_desc' : state.sort;
          state.page = 1;
          loadArticles();
        });
      });

    // Note-filter toggles on Colecciones and Tags headers
    document.getElementById('btn-notes-filter-collections')?.addEventListener('click', () => {
      state.hasSummary = state.hasSummary === 'human' ? null : 'human';
      state.page = 1;
      loadArticles();
      _paintNotesFilterBtns();
    });
    document.getElementById('btn-notes-filter-tags')?.addEventListener('click', () => {
      state.hasSummary = state.hasSummary === 'human' ? null : 'human';
      state.page = 1;
      loadArticles();
      _paintNotesFilterBtns();
    });

    function _paintNotesFilterBtns() {
      const active = state.hasSummary === 'human';
      ['btn-notes-filter-collections', 'btn-notes-filter-tags', 'btn-filter-notes'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.background = active ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)';
        el.style.color      = active ? 'white' : 'rgba(255,255,255,0.5)';
        el.title = active ? 'Mostrando solo artículos con notas — clic para quitar el filtro'
                          : (id === 'btn-filter-notes' ? 'Mostrar solo artículos con notas personales (Human notes)'
                                                        : 'Filtrar por artículos con notas en esta sección');
      });
    }
    // Repaint after each loadArticles so active state stays in sync
    const _origLoadArticles = loadArticles;
    // Wire notes-filter button click to also repaint
    document.getElementById('btn-filter-notes')?.addEventListener('click', _paintNotesFilterBtns);

    document.getElementById('pv-detail-close').addEventListener('click', closeDetail);
    document.querySelector('#pv-detail-modal .pv-modal-backdrop').addEventListener('click', closeDetail);
    document.getElementById('pv-detail-prev')?.addEventListener('click', () => {
      const idx = _listIds.indexOf(_detailCurrentId);
      if (idx > 0) openDetail(_listIds[idx - 1]);
    });
    document.getElementById('pv-detail-next')?.addEventListener('click', () => {
      const idx = _listIds.indexOf(_detailCurrentId);
      if (idx >= 0 && idx < _listIds.length - 1) openDetail(_listIds[idx + 1]);
    });

    if (IS_ADMIN) {
      wireImport();
      wireQueue();
      wireAddByDoi();
      wireEditModal();
      wireBatchImport();
      wireScanFolder();
      wireCleanMetadata();
      wireRetryAbstracts();
      wirePmidBackfill();
      wirePagesBackfill();
      wireBulkCollectionPicker();
      wirePrionpackSync();
      wireDuplicates();
      wireBatchSummary();
      wireBatchIndex();
      wireBatchExtract();
      wireBatchOcr();
      wireBatchSearchable();
      wirePubmedInventory();
      wireVerifyMetadata();
      wireScreenRefs();
      wireSidebarGroups();
      wireAIStatus();
      wireQueryExpansion();
      wireGlossary();
      wireScimago();
      wireSidebarResize();
      wireMobileDrawer();
      wireBulkBar();
      wireBulkLookup();
      wireBulkTagModal();
    }

    // Register the global IDs-filter helper here so it is always available
    // from page load, regardless of whether the health or verifier modals
    // have been opened first.
    window._pvApplyIdsFilter = function(ids) {
      Object.assign(state, {
        q: '', yearMin: null, yearMax: null, journal: '', authors: '',
        tagId: null, hasSummary: null, inPrionread: null, isFlagged: null,
        isMilestone: null, colorLabel: null, priorityEq: null, extraction: null,
        isFavorite: null, isRead: null, isJc: null, collectionId: null, collectionGroup: null,
        collectionSubgroup: null, hasJc: null, jcPresenter: '', jcYear: null,
        hasPp: null, ppId: '', abstractStatus: '', indexedStatus: '',
        _healthExtra: null, page: 1,
        filterSelectedOnly: true,
      });
      if (state.selectedIds && typeof state.selectedIds.clearSilently === 'function') {
        state.selectedIds.clearSilently();
        ids.forEach(id => state.selectedIds.addSilently(id));
      } else {
        state.selectedIds = new Set(ids);
      }
      // IDs are sent via POST body in loadArticles — no server sync needed here.
      loadArticles();
    };

    // ── Thumbnail hover popup ──────────────────────────────────────────────
    // A single floating <div> reused for all rows. Follows the thumbnail
    // position and disappears when the mouse leaves the image.
    (function wireThumbnailPopup() {
      const popup = document.createElement('div');
      popup.style.cssText = [
        'position:fixed;z-index:9999;pointer-events:none;',
        'display:none;box-shadow:0 8px 32px rgba(0,0,0,0.28);',
        'border-radius:6px;overflow:hidden;border:1px solid #d1d5db;',
        'background:#fff;',
      ].join('');
      document.body.appendChild(popup);

      const popupImg = document.createElement('img');
      popupImg.alt = '';
      popupImg.style.cssText = 'display:block;width:260px;height:auto;';
      popup.appendChild(popupImg);

      let hideTimer = null;

      function show(img, src) {
        clearTimeout(hideTimer);
        popupImg.src = src;
        popup.style.display = 'block';
        position(img);
      }

      function hide() {
        hideTimer = setTimeout(() => { popup.style.display = 'none'; }, 80);
      }

      function position(img) {
        const r = img.getBoundingClientRect();
        const pw = 262;
        const left = r.right + 10 + pw > window.innerWidth
          ? r.left - pw - 6
          : r.right + 6;
        const top = Math.min(r.top, window.innerHeight - 380);
        popup.style.left = left + 'px';
        popup.style.top  = Math.max(4, top) + 'px';
      }

      // Event delegation on the article list container
      const tbody = document.getElementById('pv-results-tbody');
      if (tbody) {
        tbody.addEventListener('mouseover', (e) => {
          const img = e.target.closest('.pv-thumb');
          if (!img || !img.complete || !img.naturalWidth) return;
          show(img, img.src);
        });
        tbody.addEventListener('mouseout', (e) => {
          if (e.target.closest('.pv-thumb')) hide();
        });
      }
    })();

    refreshStats();
    wireNewTagButton();
    refreshTags();
    wireNewCollectionButton();
    refreshCollections();
    refreshPrionPacksDropdown();
    wireSidebarToggles();

    // Wire focus trapping for every modal in the page. Safe / idempotent.
    document.querySelectorAll('.pv-modal').forEach(m => wireModalFocusTrap(m));
    // Pull the user's previously-ticked checkboxes from the server
    // BEFORE the first render so loadArticles paints them correctly.
    // _hydrateSelection never throws; the worst case is an empty
    // working set, identical to a fresh install.
    _hydrateSelection().then(() => loadArticles()).then(() => {
      const openId = new URLSearchParams(window.location.search).get('open');
      if (openId) {
        // Strip ?open= from the URL so a page refresh doesn't re-open the modal.
        const cleanUrl = window.location.pathname +
          (window.location.search.replace(/([?&])open=[^&]*/g, '$1').replace(/[?&]$/, '') || '') +
          window.location.hash;
        history.replaceState(null, '', cleanUrl || window.location.pathname);
        openDetail(openId);
      }
      // Bring back the last RAG search if there's a fresh one
      // saved (≤ 6 h old). Runs after loadArticles so the dashboard
      // is set up before we override the visible section with the
      // restored panel.
      _restoreRagStateIfFresh();
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
    tick();  // first tick now, don't wait
    _importPolling = setInterval(tick, 2000);
  }

  // Human-readable label for each ingest step.
  const _STEP_LABELS = {
    staged:      '⏳ En cola',
    queued:      '⏳ En cola',
    extracting:  '📄 Extrayendo texto…',
    resolving:   '🔍 Buscando metadatos…',
    uploading:   '☁️ Subiendo a Dropbox…',
    indexing:    '🔢 Indexando…',
    done:        '✓ Listo',
    duplicate:   '⟳ Duplicado',
    failed:      '✗ Fallido',
    staged_missing: '✗ PDF perdido',
  };

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

    // Show the current step for any in-flight jobs
    const inFlightJobs = jobs.filter(j =>
      j.status !== 'done' && j.status !== 'duplicate' && j.status !== 'failed');
    if (inFlightJobs.length > 0) {
      const stepKey = inFlightJobs[0].step || inFlightJobs[0].status || 'queued';
      const stepLabel = _STEP_LABELS[stepKey] || stepKey;
      bits.push(`<span style="color:#6b7280;font-weight:400;">${stepLabel}</span>`);
    }

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
      const by  = step.match(/by ([^\s|]+)/)?.[1] || '?';
      const doi = step.match(/doi=([^\s|]+)/)?.[1] || '';
      badge   = '⟳ Duplicado'; badgeBg = '#fef3c7'; badgeFg = '#92400e';
      bodyLines.push(`Coincide con un artículo existente (por ${by}).`);
      if (doi) bodyLines.push(`DOI extraído del PDF: <code style="font-size:11px;">${escapeHtml(doi)}</code>`);
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

    // × force-delete is always available — covers zombies stuck in
    // 'extracting' / 'resolving' after a worker crash, which the
    // bulk "Limpiar terminados" path deliberately won't touch.
    const deleteBtn = `<button class="pv-btn-del" data-job="${j.id}"
                                title="Borrar esta fila (también si está atascada). Borra el PDF staged si lo hubiera."
                                style="border:none;background:transparent;color:#9ca3af;cursor:pointer;
                                       font-size:14px;line-height:1;padding:2px 6px;border-radius:4px;"
                                onmouseover="this.style.background='#fee2e2';this.style.color='#b91c1c';"
                                onmouseout="this.style.background='transparent';this.style.color='#9ca3af';"
                        >×</button>`;
    const retryBtn = showRetry
      ? `<button class="pv-btn-retry" data-job="${j.id}">Retry</button> `
      : '';

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
      <td style="white-space:nowrap;">${retryBtn}${deleteBtn}</td>
    `;
    if (showRetry) {
      tr.querySelector('.pv-btn-retry').addEventListener('click', async () => {
        const r = await fetch('/prionvault/api/ingest/retry/' + j.id, { method: 'POST', credentials: 'same-origin' });
        if (r.ok) refreshQueue();
      });
    }
    tr.querySelector('.pv-btn-del').addEventListener('click', async () => {
      const label = `${j.pdf_filename || '(sin nombre)'} (#${j.id}, ${j.status})`;
      if (!confirm(`Borrar la fila ${label} de la cola?\n\nSi el PDF estaba a medio procesar también se elimina el archivo staged. La acción no se puede deshacer.`)) return;
      try {
        const r = await fetch('/prionvault/api/ingest/jobs/' + j.id, {
          method: 'DELETE', credentials: 'same-origin',
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          alert('No se pudo borrar: ' + (d.error || r.status));
          return;
        }
        refreshQueue();
      } catch (err) {
        alert('Error de red: ' + err.message);
      }
    });
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

    let _addOpts = {};
    function reset() {
      ident.value = '';
      [fTitle, fAuthors, fYear, fJournal, fDoi, fPmid, fAbstr].forEach(el => el.value = '');
      if (fPdf) fPdf.value = '';
      form.style.display = 'none';
      statusEl.textContent = '';
      statusEl.style.color = '#6b7280';
      btnSave.disabled = false;
      btnSave.style.opacity = '1';
      _addOpts = {};
    }

    // External API used by the bulk-lookup modal to open this modal
    // pre-filled with a specific identifier and auto-trigger the lookup.
    window._pvOpenAddByDoi = function(identifier, opts) {
      reset();
      _addOpts = opts || {};
      modal.style.display = 'flex';
      ident.value = identifier || '';
      if (_addOpts.queueLabel) {
        statusEl.textContent = _addOpts.queueLabel;
        statusEl.style.color = '#6b7280';
      }
      setTimeout(doLookup, 80);
    };

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
          await api('/articles/create', { method: 'POST', body: JSON.stringify(payload) });
        }
        const savedCb = _addOpts.onSaved;
        close();
        loadArticles();
        refreshStats();
        if (savedCb) savedCb();
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
  //
  // Chunked client-side so each click drains up to _SCAN_TARGET_PER_CLICK
  // PDFs (default 250). The server caps each request at 50 (downloads
  // are ~1-3 s each and gunicorn would kill anything past ~100 s) and
  // skips files that already have an in-flight job, so back-to-back
  // chunks don't re-process the same PDFs while the worker catches up.
  const _SCAN_CHUNK_SIZE       = 50;
  const _SCAN_TARGET_PER_CLICK = 250;

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
      const chunks = Math.ceil(_SCAN_TARGET_PER_CLICK / _SCAN_CHUNK_SIZE);
      let totalQueued       = 0;
      let totalSkipped      = 0;
      let lastFolder        = trimmed;
      let lastPdfsFound     = 0;
      let lastRemaining     = 0;
      let lastAlreadyQueued = 0;
      const allSkippedDetail = [];
      let lastError         = null;
      try {
        for (let i = 1; i <= chunks; i++) {
          btn.innerHTML =
            `<span><i class="fas fa-spinner fa-spin" style="width:13px;margin-right:6px;opacity:0.7;"></i>` +
            `Escaneando… (lote ${i}/${chunks})</span>`;
          const res = await fetch(API + '/ingest/scan-folder', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder: trimmed, limit: _SCAN_CHUNK_SIZE }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            lastError = data.error || res.status;
            if (data.detail) lastError += `\n${data.detail}`;
            break;
          }
          totalQueued       += data.queued || 0;
          totalSkipped      += data.skipped || 0;
          lastFolder         = data.folder || lastFolder;
          lastPdfsFound      = data.pdfs_found || 0;
          lastRemaining      = data.remaining || 0;
          lastAlreadyQueued  = data.already_queued || 0;
          if (Array.isArray(data.skipped_detail))
            allSkippedDetail.push(...data.skipped_detail);
          // Stop early when nothing new came back — either the folder
          // emptied or every fresh PDF is already in the queue.
          if ((data.queued || 0) === 0) break;
        }

        if (lastError) {
          alert(`No se pudo escanear la carpeta:\n${lastError}`);
        } else {
          const skippedMsg = totalSkipped
            ? `\n${totalSkipped} omitidos (revisa la consola para el detalle).`
            : '';
          const alreadyMsg = lastAlreadyQueued
            ? `\n${lastAlreadyQueued} ya estaban en la cola (no se re-encolan).`
            : '';
          const moreMsg = lastRemaining > 0
            ? `\n\nQuedan ${lastRemaining} PDFs sin procesar en la carpeta. ` +
              `Vuelve a pulsar "Scan Dropbox folder" cuando el worker libere espacio ` +
              `(unos minutos).`
            : '';
          alert(
            `Carpeta ${lastFolder}: ${lastPdfsFound} PDFs encontrados, ` +
            `${totalQueued} encolados en esta tanda.${alreadyMsg}${skippedMsg}\n\n` +
            `Sigue el progreso en el panel de "Ingest queue". Los que terminen ` +
            `bien o sean duplicados se borrarán solos de la carpeta.${moreMsg}`
          );
          if (allSkippedDetail.length)
            console.warn('scan-folder skipped:', allSkippedDetail);
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

  // ── Recuperar páginas PDF (backfill) ─────────────────────────────────
  // Drives /api/admin/backfill-pdf-pages in 50-article chunks. The
  // upload-pdf endpoint already counts pages on the spot for new
  // attachments, but rows imported through older paths (or via the
  // pre-fix dropzone) may have pdf_pages=NULL — this button drains
  // that backlog without having to re-process every PDF.
  function wirePagesBackfill() {
    const btn = document.getElementById('btn-backfill-pages');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const orig = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span><i class="fas fa-spinner fa-spin" style="width:13px;margin-right:6px;opacity:0.7;"></i>Contando…</span>';
      try {
        const r = await api('/admin/backfill-pdf-pages', {
          method: 'POST',
          body: JSON.stringify({ limit: 50 }),
        });
        const more = r.processed >= 50
          ? '\n\nPueden quedar más. Pulsa de nuevo para procesar otros 50.'
          : '\n\n✓ No quedan PDFs pendientes de contar páginas.';
        alert(
          `Procesados: ${r.processed}\n` +
          `Actualizados: ${r.updated}\n` +
          `Fallos: ${r.failed}` + more
        );
      } catch (e) {
        alert('Error: ' + (e.message || e));
      } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    });
  }

  // ── Retry-abstracts backfill ─────────────────────────────────────────
  // Drives /api/admin/retry-abstracts in 250-article chunks so the user
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
          body: JSON.stringify({ limit: 250 }),
        });
        const more = r.remaining > 0
          ? `\n\nQuedan ${r.remaining} sin abstract. Vuelve a pulsar para procesar otros 250.`
          : '\n\n✓ Sin artículos pendientes.';
        const conflictsLine = r.pmid_conflicts
          ? `\n⚠ PMID encontrado pero ya pertenecía a otro artículo (no se asignó, abstract sí): ${r.pmid_conflicts}`
          : '';
        alert(
          `Reintento completado.\n\n` +
          `Procesados: ${r.processed}\n` +
          `Abstract recuperado: ${r.recovered}\n` +
          `Aún sin abstract (marcados como confirmados): ${r.still_missing}\n` +
          `PMIDs descubiertos por el camino: ${r.learned_pmids}` +
          conflictsLine +
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

  // ── PMID backfill modal ──────────────────────────────────────────────
  //
  // We chunk the work in 50-article HTTP requests (~10-25 s each at
  // PubMed's typical 200-500 ms response time) so each one stays
  // comfortably inside the gunicorn 30 s window. A single user click
  // loops up to _PMID_TARGET_PER_CLICK / _PMID_CHUNK_SIZE chunks, so
  // 250 / 50 = 5 sequential requests, ~1-2 min total wall time. The
  // loop breaks early if a chunk comes back with fewer rows than
  // requested (the pending queue ran dry).
  const _PMID_CHUNK_SIZE       = 50;
  const _PMID_TARGET_PER_CLICK = 250;

  function wirePmidBackfill() {
    const btn        = document.getElementById('btn-backfill-pmids');
    const modal      = document.getElementById('pv-pmid-modal');
    const closeBtn   = document.getElementById('pv-pmid-close');
    const runBtn     = document.getElementById('pv-pmid-run');
    const refBtn     = document.getElementById('pv-pmid-refresh');
    const manualBtn  = document.getElementById('pv-pmid-manual');
    const statsEl    = document.getElementById('pv-pmid-stats');
    const logEl      = document.getElementById('pv-pmid-log');
    const manualPanel= document.getElementById('pv-pmid-manual-panel');
    const manualList = document.getElementById('pv-pmid-manual-list');
    const manualCount= document.getElementById('pv-pmid-manual-count');
    if (!btn || !modal) return;

    const close = () => { modal.style.display = 'none'; };
    btn.addEventListener('click', async () => {
      modal.style.display = 'flex';
      logEl.innerHTML =
        `<div style="color:#9ca3af;text-align:center;padding:24px 12px;">El log de búsquedas aparecerá aquí.</div>`;
      if (manualPanel) manualPanel.style.display = 'none';
      await refreshStats();
    });
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);
    refBtn.addEventListener('click', refreshStats);
    runBtn.addEventListener('click', runBatch);
    manualBtn?.addEventListener('click', loadManual);

    async function refreshStats() {
      statsEl.innerHTML = '<span style="color:#6b7280;">Cargando…</span>';
      try {
        const s = await api('/admin/pmid-stats');
        const pct = (n) => s.total ? ` (${(100 * n / s.total).toFixed(1)}%)` : '';
        statsEl.innerHTML = `
          <span style="color:#6b7280;">Total artículos</span>
          <span style="text-align:right;font-weight:700;">${s.total}</span>

          <span style="color:#6b7280;">Con DOI</span>
          <span style="text-align:right;">${s.has_doi}<span style="color:#9ca3af;font-weight:normal;">${pct(s.has_doi)}</span></span>

          <span style="color:#6b7280;">Con PMID</span>
          <span style="text-align:right;">${s.has_pmid}<span style="color:#9ca3af;font-weight:normal;">${pct(s.has_pmid)}</span></span>

          <span style="color:#6b7280;">Con DOI y PMID</span>
          <span style="text-align:right;">${s.has_both}</span>

          <span style="color:#b45309;font-weight:600;">DOI sin PMID</span>
          <span style="text-align:right;color:#b45309;font-weight:700;">${s.has_doi_only}</span>

          <span style="color:#b45309;font-weight:600;">Sin DOI ni PMID</span>
          <span style="text-align:right;color:#b45309;font-weight:700;">${s.has_neither}</span>

          ${s.confirmed_no_pmid ? `
            <span style="color:#6b7280;">Sin PMID confirmado (no existe)</span>
            <span style="text-align:right;color:#6b7280;">${s.confirmed_no_pmid}</span>
          ` : ''}

          <span style="grid-column:1/-1;border-top:1px solid #e5e7eb;margin-top:4px;padding-top:6px;color:#374151;font-weight:600;">
            Pendientes de recuperar: <span style="color:#b91c1c;">${s.missing_pmid}</span>
          </span>
        `;
        if (s.missing_pmid === 0) {
          runBtn.disabled = true;
          runBtn.style.opacity = '0.5';
          runBtn.style.cursor = 'not-allowed';
          runBtn.textContent = '✓ Todos los artículos tienen PMID';
        } else {
          runBtn.disabled = false;
          runBtn.style.opacity = '1';
          runBtn.style.cursor = 'pointer';
          const target = Math.min(_PMID_TARGET_PER_CLICK, s.missing_pmid);
          runBtn.textContent = `🔄 Recuperar PMIDs faltantes (${target} en esta tanda)`;
        }
      } catch (e) {
        statsEl.innerHTML = `<span style="color:#b91c1c;">Error: ${esc(e.message)}</span>`;
      }
    }

    function _appendLog(html, kind) {
      // Replace the placeholder on first append.
      const placeholder = logEl.querySelector('div[style*="text-align:center"]');
      if (placeholder) placeholder.remove();
      const row = document.createElement('div');
      const color = kind === 'ok'     ? '#15803d'
                  : kind === 'error'  ? '#b91c1c'
                  : kind === 'warn'   ? '#b45309'
                  : '#6b7280';
      // data-kind drives the "Solo errores" filter; data-text caches a
      // plain-text version of the row body for the CSV exporter so it
      // doesn't have to parse HTML at download time.
      row.dataset.kind = kind || 'info';
      row.className    = 'pv-pmid-log-row';
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      row.dataset.text = (tmp.textContent || '').trim();
      row.style.cssText = 'display:flex;gap:8px;padding:3px 4px;border-bottom:1px solid #f3f4f6;line-height:1.4;';
      row.innerHTML = `<span style="color:${color};flex-shrink:0;">●</span><span style="flex:1;min-width:0;">${html}</span>`;
      logEl.appendChild(row);
      _syncPmidLogVisibility();
      _syncPmidLogCount();
      logEl.scrollTop = logEl.scrollHeight;
    }

    function _syncPmidLogVisibility() {
      const onlyErrors = !!document.getElementById('pv-pmid-log-errors-only')?.checked;
      logEl.querySelectorAll('.pv-pmid-log-row').forEach(r => {
        if (!onlyErrors) {
          r.style.display = '';
          return;
        }
        // "Errors" = anything that isn't a successful PMID write.
        // We treat 'ok' (PMID found + saved) as success, and 'error'
        // / 'warn' (not found, duplicate, etc.) + 'info' marker
        // lines as the actionable subset to show.
        r.style.display = (r.dataset.kind === 'ok') ? 'none' : '';
      });
    }

    function _syncPmidLogCount() {
      const counter = document.getElementById('pv-pmid-log-count');
      if (!counter) return;
      const total = logEl.querySelectorAll('.pv-pmid-log-row').length;
      const errs  = logEl.querySelectorAll('.pv-pmid-log-row[data-kind="error"], .pv-pmid-log-row[data-kind="warn"]').length;
      counter.textContent = total
        ? `· ${total} entradas${errs ? ` (${errs} sin PMID / duplicados)` : ''}`
        : '';
    }

    document.getElementById('pv-pmid-log-errors-only')?.addEventListener('change', _syncPmidLogVisibility);

    document.getElementById('pv-pmid-log-clear')?.addEventListener('click', () => {
      if (!logEl.querySelector('.pv-pmid-log-row')) return;
      if (!confirm('Vaciar el log de esta sesión?\n\nNo afecta a la base de datos ni a los contadores — sólo limpia lo que ves en este panel.')) return;
      logEl.innerHTML =
        '<div style="color:#9ca3af;text-align:center;padding:24px 12px;">El log de búsquedas aparecerá aquí.</div>';
      _syncPmidLogCount();
    });

    document.getElementById('pv-pmid-log-csv')?.addEventListener('click', () => {
      const rows = Array.from(logEl.querySelectorAll('.pv-pmid-log-row'));
      if (!rows.length) { alert('Log vacío.'); return; }
      const onlyErrors = !!document.getElementById('pv-pmid-log-errors-only')?.checked;
      const visible = onlyErrors
        ? rows.filter(r => r.dataset.kind !== 'ok')
        : rows;
      const csvEsc = (v) => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const out = [['kind', 'text']];
      visible.forEach(r => out.push([r.dataset.kind || 'info', r.dataset.text || '']));
      const csv = out.map(r => r.map(csvEsc).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = url;
      a.download = `prionvault-pmid-log-${stamp}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    async function runBatch() {
      runBtn.disabled = true;
      const orig = runBtn.textContent;
      const CHUNK = _PMID_CHUNK_SIZE;          // 50 per HTTP request
      const TARGET = _PMID_TARGET_PER_CLICK;   // 250 per click
      let totalProcessed = 0;
      let totalFound     = 0;
      try {
        const chunks = Math.ceil(TARGET / CHUNK);
        for (let i = 1; i <= chunks; i++) {
          runBtn.textContent = `⏳ Buscando en PubMed… (lote ${i}/${chunks})`;
          _appendLog(`<b>${new Date().toLocaleTimeString()}</b> Lote ${i}/${chunks} — hasta ${CHUNK} artículos…`);
          const r = await api('/admin/pmid-backfill', {
            method: 'POST',
            body: JSON.stringify({ limit: CHUNK }),
          });
          (r.items || []).forEach(it => {
            const title = (it.title || '').slice(0, 80);
            const titleEsc = esc(title) + (it.title && it.title.length > 80 ? '…' : '');
            if (it.found_pmid && !it.reason) {
              _appendLog(
                `✓ <a href="https://pubmed.ncbi.nlm.nih.gov/${esc(String(it.found_pmid))}/" ` +
                  `target="_blank" rel="noopener" style="color:#0F3460;font-weight:600;">PMID ${esc(String(it.found_pmid))}</a> ` +
                `<span style="color:#9ca3af;">(${esc(it.via || '?')})</span> — ${titleEsc}`,
                'ok'
              );
            } else if (it.reason === 'duplicate') {
              _appendLog(
                `⚠ Duplicado: PMID ${esc(String(it.found_pmid))} ya pertenece a otro artículo — ${titleEsc}`,
                'warn'
              );
            } else if (it.reason === 'not_found') {
              _appendLog(`✗ Sin coincidencia en PubMed — ${titleEsc}`, 'error');
            } else {
              _appendLog(`✗ ${esc(it.reason || 'error')} — ${titleEsc}`, 'error');
            }
          });
          totalProcessed += r.processed || 0;
          totalFound     += r.found || 0;
          // If the server gave us fewer rows than we asked for, the
          // queue is empty — stop early instead of issuing more HTTPs
          // we know will return [].
          if ((r.processed || 0) < CHUNK) break;
        }
        _appendLog(
          `<b>Tanda terminada</b> — procesados ${totalProcessed}, recuperados ${totalFound}.`,
          totalFound > 0 ? 'ok' : 'warn'
        );
        await refreshStats();
        // Refresh the listing so newly-found PMIDs appear as the
        // "PMID ↗" chip without a manual reload.
        if (typeof loadArticles === 'function') loadArticles();
      } catch (e) {
        _appendLog(`Error: ${esc(e.message)}`, 'error');
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = orig;
      }
    }

    // Manual PMID-entry panel: lists every article still without a
    // PMID, with a one-click "Buscar en PubMed" link pre-filled with
    // the title and a tiny input for pasting the PMID found by hand.
    // The PATCH /api/articles/<id> endpoint already handles the
    // uniqueness check (409 on PMID already owned) and the new 422
    // for the VARCHAR(255) bug — we surface either cleanly.
    async function loadManual() {
      if (!manualPanel) return;
      manualPanel.style.display = 'block';
      manualList.innerHTML =
        '<div style="text-align:center;color:#9ca3af;padding:24px 12px;font-size:13px;">Cargando pendientes…</div>';
      try {
        const r = await api('/admin/pmid-missing?limit=500');
        manualCount.textContent = `· ${r.total} en total`;
        if (!r.items || !r.items.length) {
          manualList.innerHTML =
            '<div style="text-align:center;color:#15803d;padding:24px 12px;font-size:13px;">✓ Ningún artículo pendiente. Todos tienen PMID.</div>';
          return;
        }
        // Master "Marcar todos" + per-row checkboxes write into the
        // shared state.selectedIds so the operator can close the modal
        // and find their picks in the main listing via the bulk-bar's
        // "🔍 Ver sólo seleccionados" button.
        const masterHtml = `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;
                      background:#f3f4f6;border-bottom:1px solid #e5e7eb;
                      font-size:11.5px;color:#374151;font-weight:600;
                      position:sticky;top:0;z-index:1;">
            <input type="checkbox" id="pv-pmid-manual-master"
                   title="Marcar / desmarcar todos los visibles"
                   style="margin:0;cursor:pointer;width:14px;height:14px;">
            <label for="pv-pmid-manual-master" style="cursor:pointer;flex:1;">
              Marcar todos los <span id="pv-pmid-manual-master-count">${r.items.length}</span> visibles
              <span style="font-weight:normal;color:#6b7280;">
                — la selección queda disponible al cerrar el modal en el listado principal
              </span>
            </label>
          </div>`;
        manualList.innerHTML = masterHtml + r.items.map(it => _manualPmidRowHtml(it)).join('');

        // Wire per-row save + Enter
        manualList.querySelectorAll('.pv-pmid-manual-save').forEach(b => {
          b.addEventListener('click', () => saveManualPmid(b.dataset.aid));
        });
        manualList.querySelectorAll('.pv-pmid-manual-input').forEach(inp => {
          inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              saveManualPmid(inp.dataset.aid);
            }
          });
        });
        manualList.querySelectorAll('.pv-pmid-manual-nopmid').forEach(b => {
          b.addEventListener('click', () => markNoPmid(b.dataset.aid));
        });

        // Per-row "🗑 Borrar" — same flow as the listing's delete: hits
        // DELETE /api/articles/<id>, which clears the row + the Dropbox
        // PDF + any collection memberships. Confirm dialog because it's
        // irreversible from the UI.
        manualList.querySelectorAll('.pv-pmid-manual-delete').forEach(b => {
          b.addEventListener('click', () => deleteManualRow(b.dataset.aid));
        });

        // Per-row pick checkbox — keeps state.selectedIds in sync.
        const syncMaster = () => {
          const checks  = Array.from(manualList.querySelectorAll('.pv-pmid-manual-pick'));
          const master  = document.getElementById('pv-pmid-manual-master');
          if (!master) return;
          const total   = checks.length;
          const checked = checks.filter(c => c.checked).length;
          master.checked = total > 0 && checked === total;
          master.indeterminate = checked > 0 && checked < total;
        };
        manualList.querySelectorAll('.pv-pmid-manual-pick').forEach(cb => {
          cb.addEventListener('change', () => {
            if (cb.checked) state.selectedIds.add(cb.dataset.aid);
            else            state.selectedIds.delete(cb.dataset.aid);
            updateBulkBar();
            syncSelectAllHeader?.();
            syncMaster();
          });
        });

        // Master "marcar todos los visibles"
        const master = document.getElementById('pv-pmid-manual-master');
        if (master) {
          master.addEventListener('change', () => {
            manualList.querySelectorAll('.pv-pmid-manual-pick').forEach(cb => {
              cb.checked = master.checked;
              if (cb.checked) state.selectedIds.add(cb.dataset.aid);
              else            state.selectedIds.delete(cb.dataset.aid);
            });
            updateBulkBar();
            syncSelectAllHeader?.();
          });
          syncMaster();
        }
      } catch (e) {
        manualList.innerHTML =
          `<div style="color:#b91c1c;padding:14px;font-size:13px;">Error: ${esc(e.message)}</div>`;
      }
    }

    async function deleteManualRow(aid) {
      const row = manualList.querySelector(`[data-row-aid="${CSS.escape(aid)}"]`);
      if (!row) return;
      const status = row.querySelector('.pv-pmid-manual-status');
      const btn    = row.querySelector('.pv-pmid-manual-delete');
      if (!confirm(
        'Borrar este artículo de PrionVault?\n\n' +
        '• La fila se borra de la base de datos.\n' +
        '• El PDF de Dropbox también (queda en el historial ~30 días).\n' +
        '• Desaparece de PrionRead, PrionPacks, asignaciones y ratings.\n\n' +
        'No se puede deshacer. ¿Continuar?'
      )) return;
      const orig = btn.textContent;
      btn.disabled    = true;
      btn.textContent = '⏳';
      status.textContent = '';
      try {
        await api(`/articles/${aid}`, { method: 'DELETE' });
        // Drop from selection if it was picked, then fade the row.
        state.selectedIds.delete(aid);
        updateBulkBar();
        row.style.transition = 'opacity 0.4s';
        row.style.opacity = '0.25';
        setTimeout(() => {
          row.remove();
          if (!manualList.querySelector('[data-row-aid]')) {
            manualList.innerHTML =
              '<div style="text-align:center;color:#15803d;padding:24px 12px;font-size:13px;">✓ Ya está. Todos los pendientes resueltos.</div>';
          }
          refreshStats();
          if (typeof loadArticles === 'function') loadArticles();
        }, 400);
      } catch (e) {
        status.style.color = '#b91c1c';
        status.textContent = `✗ ${e.message || 'error'}`;
        btn.disabled    = false;
        btn.textContent = orig;
      }
    }

    async function saveManualPmid(aid) {
      const row = manualList.querySelector(`[data-row-aid="${CSS.escape(aid)}"]`);
      if (!row) return;
      const input = row.querySelector('.pv-pmid-manual-input');
      const saveBtn = row.querySelector('.pv-pmid-manual-save');
      const status  = row.querySelector('.pv-pmid-manual-status');
      const raw = (input.value || '').trim();
      // Accept "12345678", "PMID 12345678", "PMID:12345678", or even
      // a copy-pasted PubMed URL — strip down to the trailing digits.
      const m = raw.match(/(\d{4,})/);
      if (!m) {
        status.textContent = 'PMID inválido (esperaba dígitos).';
        status.style.color = '#b91c1c';
        return;
      }
      const pmid = m[1];
      saveBtn.disabled    = true;
      const origLabel     = saveBtn.textContent;
      saveBtn.textContent = '⏳';
      status.textContent  = '';
      try {
        await api(`/articles/${aid}`, {
          method: 'PATCH',
          body:   JSON.stringify({ pubmed_id: pmid }),
        });
        // Fade out the row on success and update the running tally.
        row.style.transition = 'opacity 0.4s, max-height 0.4s';
        row.style.opacity = '0.3';
        status.style.color = '#15803d';
        status.textContent = `✓ PMID ${pmid} guardado.`;
        // Refresh the global stats panel and the main listing's
        // "PMID ↗" chips after a moment so the change is visible.
        setTimeout(() => {
          row.remove();
          refreshStats();
          if (typeof loadArticles === 'function') loadArticles();
          // If the list is now empty, replace with success message.
          if (!manualList.querySelector('[data-row-aid]')) {
            manualList.innerHTML =
              '<div style="text-align:center;color:#15803d;padding:24px 12px;font-size:13px;">✓ Ya está. Todos los pendientes resueltos.</div>';
          }
        }, 600);
      } catch (e) {
        const body = e.body || {};
        let msg = e.message || 'error';
        if (e.status === 409 && body.duplicate_of) {
          msg = `Ese PMID ya pertenece a otro artículo. Ver: ${body.duplicate_of}`;
        }
        status.style.color = '#b91c1c';
        status.textContent = `✗ ${msg}`;
        saveBtn.disabled    = false;
        saveBtn.textContent = origLabel;
      }
    }

    // "✗ No existe PMID" — flag the paper as confirmed-not-in-PubMed
    // so the auto-backfill stops trying it and the manual list stops
    // showing it. Reversible via the same endpoint with {value:false}
    // if the admin changes their mind.
    async function markNoPmid(aid) {
      const row    = manualList.querySelector(`[data-row-aid="${CSS.escape(aid)}"]`);
      if (!row) return;
      const btn    = row.querySelector('.pv-pmid-manual-nopmid');
      const status = row.querySelector('.pv-pmid-manual-status');
      if (!confirm('Marcar este artículo como confirmado-sin-PMID?\n\n' +
                   '• La búsqueda automática lo saltará en futuros lotes.\n' +
                   '• Desaparece de esta lista de pendientes.\n' +
                   '• Se puede deshacer luego desde Editar → vaciar campo y guardar.\n\n' +
                   '¿Continuar?')) return;
      const orig = btn.textContent;
      btn.disabled    = true;
      btn.textContent = '⏳';
      status.textContent = '';
      try {
        await api(`/articles/${aid}/mark-no-pmid`, {
          method: 'POST',
          body:   JSON.stringify({ value: true }),
        });
        status.style.color = '#6b7280';
        status.textContent = 'Marcado sin PMID.';
        row.style.transition = 'opacity 0.4s';
        row.style.opacity = '0.3';
        setTimeout(() => {
          row.remove();
          refreshStats();
          if (!manualList.querySelector('[data-row-aid]')) {
            manualList.innerHTML =
              '<div style="text-align:center;color:#15803d;padding:24px 12px;font-size:13px;">✓ Ya está. Todos los pendientes resueltos.</div>';
          }
        }, 500);
      } catch (e) {
        status.style.color = '#b91c1c';
        status.textContent = `✗ ${e.message || 'error'}`;
        btn.disabled    = false;
        btn.textContent = orig;
      }
    }
  }

  function _manualPmidRowHtml(it) {
    const escAttr = (v) => esc(String(v || ''));
    const title   = it.title || '(sin título)';
    const yearTxt = it.year ? ` · ${it.year}` : '';
    const journal = it.journal ? ` · ${esc(it.journal)}` : '';
    const doiLink = it.doi
      ? `<a href="https://doi.org/${escAttr(it.doi)}" target="_blank" rel="noopener" style="color:#3730a3;text-decoration:none;font-weight:600;">DOI</a>`
      : '';
    // PubMed best-match search pre-filled with the title — clicking
    // takes the admin straight to the candidate list; usually the
    // first hit is the paper they're looking at.
    const pubmedUrl =
      'https://pubmed.ncbi.nlm.nih.gov/?term=' + encodeURIComponent(title);
    // Authors string can be quite long (collaborator lists) — trim.
    const authors = (it.authors || '').slice(0, 80) +
                    ((it.authors || '').length > 80 ? '…' : '');
    // Persist selection across renders / refreshes by reading the
    // shared state.selectedIds Set every time we paint a row.
    const checked = state.selectedIds.has(it.id) ? 'checked' : '';
    return `
      <div data-row-aid="${escAttr(it.id)}"
           style="border-bottom:1px solid #e5e7eb;padding:8px 10px;background:white;">
        <div style="display:flex;gap:10px;align-items:flex-start;">
          <input type="checkbox" class="pv-pmid-manual-pick" data-aid="${escAttr(it.id)}" ${checked}
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
            <div style="margin-top:5px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              <a href="${escAttr(pubmedUrl)}" target="_blank" rel="noopener"
                 style="font-size:11.5px;padding:2px 8px;border-radius:4px;background:#dbeafe;color:#1d4ed8;
                        font-weight:600;text-decoration:none;">🔍 Buscar en PubMed ↗</a>
              ${doiLink ? `<span style="font-size:11.5px;">${doiLink}</span>` : ''}
            </div>
          </div>
          <div style="flex-shrink:0;display:flex;flex-direction:column;gap:4px;align-items:flex-end;min-width:200px;">
            <div style="display:flex;gap:5px;">
              <input type="text" class="pv-pmid-manual-input" data-aid="${escAttr(it.id)}"
                     placeholder="Pega el PMID"
                     inputmode="numeric"
                     style="width:130px;padding:5px 8px;border:1px solid #d1d5db;border-radius:5px;font-size:12.5px;font-family:ui-monospace,monospace;">
              <button type="button" class="pv-pmid-manual-save" data-aid="${escAttr(it.id)}"
                      style="padding:5px 12px;border-radius:5px;border:none;background:#0F3460;color:white;font-size:12px;font-weight:600;cursor:pointer;">
                Guardar
              </button>
            </div>
            <div style="display:flex;gap:5px;align-self:flex-end;">
              <button type="button" class="pv-pmid-manual-nopmid" data-aid="${escAttr(it.id)}"
                      title="Marca este artículo como confirmado-sin-PMID. La búsqueda automática y la lista manual lo dejarán en paz."
                      style="padding:3px 10px;border-radius:4px;border:1px solid #fecaca;background:white;color:#b91c1c;font-size:11px;font-weight:600;cursor:pointer;">
                ✗ No existe PMID
              </button>
              <button type="button" class="pv-pmid-manual-delete" data-aid="${escAttr(it.id)}"
                      title="Borrar el artículo de PrionVault (también borra el PDF de Dropbox)."
                      style="padding:3px 10px;border-radius:4px;border:1px solid #fca5a5;background:white;color:#b91c1c;font-size:11px;font-weight:600;cursor:pointer;">
                🗑 Borrar
              </button>
            </div>
            <div class="pv-pmid-manual-status" style="font-size:11px;color:#6b7280;text-align:right;min-height:14px;"></div>
          </div>
        </div>
      </div>
    `;
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
        const dis = r.dismissed_count || 0;
        meta.textContent =
          `${r.total} par${r.total === 1 ? '' : 'es'} sospechoso${r.total === 1 ? '' : 's'} ` +
          `encontrado${r.total === 1 ? '' : 's'} (ordenados por score)` +
          (dis ? ` · ${dis} pareja${dis === 1 ? '' : 's'} marcada${dis === 1 ? '' : 's'} previamente como no-duplicado` : '') +
          '.';
        list.innerHTML = r.pairs.map(p => `
          <div class="pv-dup-pair" data-a="${esc(p.a.id)}" data-b="${esc(p.b.id)}"
               style="border:1px solid #e5e7eb;border-radius:8px;padding:10px;margin-bottom:8px;background:#fafafa;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;flex-wrap:wrap;">
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                ${p.reasons.map(r => `<span style="font-size:11px;padding:2px 7px;border-radius:5px;background:#fef3c7;color:#92400e;font-weight:600;">${esc(r)}</span>`).join('')}
              </div>
              <span style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:11px;color:#6b7280;font-variant-numeric:tabular-nums;">score ${(p.score * 100).toFixed(0)}%</span>
                <button class="pv-dup-dismiss"
                        title="Marcar como NO duplicados. La pareja no volverá a aparecer en futuros escaneos hasta que un artículo sea borrado o lo re-actives manualmente."
                        style="padding:3px 9px;border-radius:5px;border:1px solid #d1d5db;background:white;color:#374151;font-size:11px;font-weight:600;cursor:pointer;">
                  ✗ No son duplicados
                </button>
              </span>
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

        list.querySelectorAll('.pv-dup-dismiss').forEach(b => {
          b.addEventListener('click', async () => {
            const card = b.closest('.pv-dup-pair');
            if (!card) return;
            const reason = prompt(
              'Confirmar que NO son duplicados.\n\n' +
              'La pareja no volverá a aparecer en futuros escaneos. ' +
              'Si quieres, escribe una nota corta para tu propio registro ' +
              '(opcional — pulsa Aceptar sin escribir nada para descartar sin nota):',
              ''
            );
            if (reason === null) return;   // user cancelled
            b.disabled = true;
            const orig = b.textContent;
            b.textContent = '…';
            try {
              await api('/duplicates/dismiss', {
                method: 'POST',
                body: JSON.stringify({
                  a: card.dataset.a,
                  b: card.dataset.b,
                  reason: reason || null,
                }),
              });
              card.style.transition = 'opacity 0.4s, max-height 0.4s';
              card.style.opacity = '0.35';
              setTimeout(() => card.remove(), 400);
            } catch (e) {
              b.disabled = false;
              b.textContent = orig;
              alert('Error: ' + e.message);
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
        return `
          <tr style="border-bottom:1px solid #f3f4f6;">
            <td style="padding:6px 8px;width:32px;"></td>
            <td style="padding:6px 8px;font-size:11.5px;color:#9ca3af;font-variant-numeric:tabular-nums;">${i+1}</td>
            <td style="padding:6px 8px;font-size:11px;color:#b91c1c;font-weight:700;">✗</td>
            <td style="padding:6px 8px;font-size:11.5px;font-family:ui-monospace,monospace;color:#374151;
                       word-break:break-all;max-width:200px;">${inp}</td>
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

      // Sequential "Buscar y añadir" for not-found items.
      const addBtnEl = document.getElementById('pv-bulk-lookup-add');
      if (addBtnEl) addBtnEl.addEventListener('click', () => {
        if (!notFoundItems.length) return;
        // Hide this modal while the add modal is open; re-show after sequence.
        const queue = [...notFoundItems];
        let idx = 0;
        function openNext() {
          if (idx >= queue.length) {
            // All done — re-open the lookup modal.
            modal.style.display = 'flex';
            return;
          }
          modal.style.display = 'none';
          const identifier = queue[idx];
          idx++;
          window._pvOpenAddByDoi(identifier, {
            queueLabel: `Artículo ${idx} de ${queue.length} no encontrados`,
            onSaved: openNext,
          });
        }
        openNext();
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
        hasPp: null, ppId: '', abstractStatus: '', indexedStatus: '', page: 1,
        _healthExtra: { has_summary_ai: hasSummaryVal },
      });
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

  // ── Last-RAG-search persistence ──────────────────────────────────
  // Keep the most recent successful semantic-search result around so
  // returning to PrionVault (after viewing a PDF in another tab, or
  // navigating to another tool and back) doesn't drop the user on a
  // blank dashboard. We persist the entire payload — the model
  // response, not just the query — because re-issuing the call would
  // cost tokens, take 5-15 s and could yield a different answer.
  const _RAG_LS_KEY  = 'pv-rag-last';
  const _RAG_TTL_MS  = 6 * 60 * 60 * 1000;   // 6 h — long enough to
  // cover "open PDF, get distracted, come back after a meeting" but
  // short enough that an answer from this morning won't surprise the
  // user when they sit down tomorrow.

  function _persistRagState(query, provider, topK, r) {
    try {
      // The response can be large with top_k = 200 (lots of citations
      // and extracts). LocalStorage has a ~5 MB hard cap; if our
      // payload happens to overflow we silently skip persistence
      // rather than wipe the user's other settings.
      const payload = {
        v: 1, ts: Date.now(),
        query, provider, topK,
        result: r,
      };
      localStorage.setItem(_RAG_LS_KEY, JSON.stringify(payload));
    } catch (err) {
      // QuotaExceededError or serialization issue. Non-fatal.
      console.warn('rag: could not persist last result', err);
    }
  }

  function _clearRagState() {
    try { localStorage.removeItem(_RAG_LS_KEY); } catch (_) {}
  }

  function _restoreRagStateIfFresh() {
    let raw;
    try { raw = localStorage.getItem(_RAG_LS_KEY); }
    catch (_) { return; }
    if (!raw) return;
    let payload;
    try { payload = JSON.parse(raw); }
    catch (_) { _clearRagState(); return; }
    if (!payload || payload.v !== 1 || !payload.result) {
      _clearRagState();
      return;
    }
    if (Date.now() - (payload.ts || 0) > _RAG_TTL_MS) {
      _clearRagState();
      return;
    }
    // Show the RAG panel pre-populated with the stored result.
    const panel = document.getElementById('pv-rag-panel');
    if (!panel) return;
    panel.style.display = 'block';
    const resultsMeta = document.getElementById('pv-results-meta');
    const resultsGrid = document.getElementById('pv-results-grid');
    const pagination  = document.getElementById('pv-pagination');
    if (resultsMeta) resultsMeta.style.display = 'none';
    if (resultsGrid) resultsGrid.style.display = 'none';
    if (pagination)  pagination.style.display  = 'none';
    // Keep the provider picker in sync so the "Refrescar" button
    // re-runs against the same model the user last picked.
    const provEl = document.getElementById('pv-rag-provider');
    if (provEl) provEl.value = payload.provider;
    _renderRagResult(payload.query, payload.provider,
                     payload.topK || 50, payload.result,
                     /*fromCache=*/true);
    _lastRagQuery = payload.query;
    _lastRagTopK  = payload.topK || 50;
  }

  // Pulled out of runRagSearch so a restored result can re-use the
  // identical rendering path, no duplication of HTML strings. The
  // `fromCache` flag flips the status line so the user knows whether
  // they're seeing a fresh response or a recovered one.
  function _renderRagResult(query, provider, topK, r, fromCache) {
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
    if (fromCache) {
      // Tell the user the answer is being recovered, not freshly
      // generated, so they know to press Refrescar if they want
      // newer evidence.
      stEl.innerHTML = `↻ Última respuesta guardada (pulsa <em>Refrescar</em> para volver a consultar).`;
    } else {
      stEl.innerHTML = r.no_results
        ? '⚠️ Retrieval no encontró fragmentos relevantes para esta pregunta.'
        : `✓ Generado en ${timing}${cost}${tok}`;
    }
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
      _renderRagResult(query, provider, topK, r, /*fromCache=*/false);
      // Persist the result so re-loading PrionVault (after coming back
      // from the PDF viewer, switching tools, etc.) restores the same
      // answer instead of dropping the user back to a blank dashboard.
      _persistRagState(query, provider, topK, r);
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
    // Closing the panel is the user's explicit "I'm done with this
    // answer" signal — drop the persisted copy so it doesn't pop
    // back up next time they reload.
    _clearRagState();
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
        ].join('');
        // Update button labels to show pending counts
        const pdfPending = c.pdf.available - c.pdf.indexed;
        const absPending = c.abstract.available - c.abstract.indexed;
        const sumPending = c.summary.available - c.summary.indexed;
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

    // Full wipe + reindex. Two confirmation prompts because the
    // operation is destructive — we'd rather make the operator
    // explicitly type-through twice than recover from a misclick on
    // a 4-hour-old embedding investment.
    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        const confirm1 = confirm(
          'BORRAR todos los embeddings existentes y regenerarlos ' +
          'desde cero con el modelo actual (voyage-4-large)?\n\n' +
          '• Vacía la tabla article_chunk completa (PDF, abstract y resumen IA).\n' +
          '• Re-indexa TODAS las fuentes disponibles por artículo.\n' +
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
      const minYear = minYearVal && /^\d{4}$/.test(minYearVal) ? parseInt(minYearVal) : null;
      try {
        await api('/admin/pubmed-inventory/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preset, custom_query: customQuery, ...(minYear ? { min_year: minYear } : {}) }),
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

    function openEdit(aid) {
      // Hand off to the existing Edit-modal wiring so the operator can
      // fix the metadata or repoint the DOI/PMID in one place.
      const trigger = document.querySelector(`.pv-edit-row-btn[data-aid="${CSS.escape(aid)}"]`);
      if (trigger) { trigger.click(); return; }
      // If the row isn't visible in the main listing right now, just
      // open the article detail (clicking the listing's row).
      window.open(`/prionvault/articles/${aid}`, '_blank');
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
    if (!btn || !modal) return;

    let _lastResult = null;

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

    function renderResult(r) {
      const items = r.items || [];
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

      const missing = items.some(it =>
        !it.in_vault && (it.pmid || it.doi || it.pmcid) && it.title);
      actions.style.display = missing ? 'flex' : 'none';
    }

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

    return `
      <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin-bottom:8px;">
        <div style="display:flex;align-items:flex-start;gap:10px;">
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
  // ── Translation glossary admin modal ─────────────────────────────────
  function wireGlossary() {
    const btn   = document.getElementById('btn-glossary');
    const modal = document.getElementById('pv-glossary-modal');
    if (!btn || !modal) return;

    const closeBtn = document.getElementById('pv-glossary-close');
    let currentTab = 'import';
    let glossaryTerms = [];

    // Tab switching
    modal.querySelectorAll('.pv-glossary-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        currentTab = e.target.dataset.tab;
        modal.querySelectorAll('.pv-glossary-tab').forEach(t => {
          t.style.borderBottomColor = t.dataset.tab === currentTab ? '#0F3460' : 'transparent';
          t.style.color = t.dataset.tab === currentTab ? '#0F3460' : '#6b7280';
        });
        modal.querySelectorAll('.pv-glossary-tab-content').forEach(content => {
          content.style.display = content.id === `pv-glossary-${currentTab}-tab` ? 'block' : 'none';
        });
        if (currentTab === 'browse') loadBrowseTab();
        if (currentTab === 'stats') loadStats();
        if (currentTab === 'improve') loadImproveTab();
        if (currentTab === 'history') loadHistoryTab();
      });
    });

    function open() { modal.style.display = 'flex'; }
    function close() { modal.style.display = 'none'; }
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    // Browse tab
    async function loadBrowseTab() {
      try {
        const r = await api('/glossary/terms');
        glossaryTerms = r.terms || [];
        renderGlossaryList();
      } catch (e) {
        document.getElementById('pv-glossary-list').innerHTML =
          `<div style="color:#b91c1c;padding:14px;font-size:13px;">Error: ${esc(e.message)}</div>`;
      }
    }

    function renderGlossaryList() {
      const filtEl = document.getElementById('pv-glossary-filter');
      const cntEl  = document.getElementById('pv-glossary-counts');
      const listEl = document.getElementById('pv-glossary-list');
      const filter = (filtEl.value || '').trim().toLowerCase();

      const matches = glossaryTerms.filter(t =>
        !filter ||
        (t.term_en || '').toLowerCase().includes(filter) ||
        (t.term_es_recommended || '').toLowerCase().includes(filter)
      );

      cntEl.textContent = `${glossaryTerms.length} términos` +
        (filter ? ` · ${matches.length} mostrados` : '');

      if (!matches.length) {
        listEl.innerHTML = `<div style="text-align:center;color:#9ca3af;padding:22px;font-size:13px;">
          ${filter ? 'Sin coincidencias.' : 'Cargando glosario…'}
        </div>`;
        return;
      }

      listEl.innerHTML = matches.map(t => {
        const avoided = (t.term_es_avoid || '').split('|').filter(x => x.trim()).map(x => x.trim());
        return `
          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin-bottom:8px;">
            <div style="display:flex;gap:12px;align-items:flex-start;">
              <div style="flex:1;">
                <div style="font-size:13px;font-weight:600;color:#111827;">${esc(t.term_en)}</div>
                <div style="font-size:13px;color:#0F3460;margin-top:2px;font-weight:500;">→ ${esc(t.term_es_recommended)}</div>
                ${t.notes ? `<div style="font-size:11px;color:#6b7280;margin-top:4px;">${esc(t.notes)}</div>` : ''}
                ${avoided.length > 0 ? `
                  <div style="font-size:11px;color:#dc2626;margin-top:4px;font-weight:500;">
                    Evitar: ${avoided.map(x => `<code style="background:#fef2f2;padding:2px 4px;border-radius:3px;">${esc(x)}</code>`).join(' ')}
                  </div>
                ` : ''}
                <div style="font-size:10px;color:#9ca3af;margin-top:4px;">${esc(t.category || 'General')}</div>
              </div>
            </div>
          </div>`;
      }).join('');
    }

    document.getElementById('pv-glossary-filter').addEventListener('input', renderGlossaryList);
    document.getElementById('pv-glossary-category').addEventListener('change', async (e) => {
      const cat = e.target.value;
      try {
        const r = await api(`/glossary/terms?category=${encodeURIComponent(cat)}`);
        glossaryTerms = r.terms || [];
        renderGlossaryList();
      } catch (e) {
        console.error('Failed to filter by category:', e);
      }
    });

    // Stats tab
    async function loadStats() {
      try {
        const stats = await api('/glossary/stats');
        document.querySelector('#pv-glossary-stats-content > div:nth-child(1) > div:first-child').textContent =
          (stats.total_articles_improved || 0).toLocaleString();
        document.querySelector('#pv-glossary-stats-content > div:nth-child(2) > div:first-child').textContent =
          (stats.total_changes || 0).toLocaleString();
        document.querySelector('#pv-glossary-stats-content > div:nth-child(3) > div:first-child').textContent =
          stats.current_glossary_version || '-';

        const byVerEl = document.getElementById('pv-glossary-by-version');
        byVerEl.innerHTML = (stats.by_version || []).map(v => `
          <div style="background:#f3f4f6;border:1px solid #d1d5db;border-radius:8px;padding:10px;display:flex;justify-content:space-between;font-size:12px;">
            <span><strong>v${v.glossary_version}</strong>: ${v.articles_improved} artículos</span>
            <span>${v.total_changes} cambios</span>
          </div>
        `).join('');

        document.getElementById('pv-glossary-export-btn').addEventListener('click', () => {
          window.location.href = '/prionvault/api/glossary/export';
        });
      } catch (e) {
        console.error('Failed to load stats:', e);
      }
    }

    // Improve tab
    async function loadImproveTab() {
      try {
        const [unrev, outd] = await Promise.all([
          api('/glossary/unreviewed?limit=1'),
          api('/glossary/outdated?limit=1')
        ]);

        const total = unrev.total || 0;
        document.getElementById('pv-glossary-unrev-count').textContent = total.toLocaleString();
        document.getElementById('pv-glossary-outd-count').textContent = (outd.total || 0).toLocaleString();

        document.getElementById('pv-glossary-improve-unrev-btn').onclick = () => improveUnreviewed(unrev.total);
        document.getElementById('pv-glossary-improve-outd-btn').onclick = () => improveOutdated(outd.total);
      } catch (e) {
        console.error('Failed to load improve tab:', e);
      }
    }

    async function improveUnreviewed(count) {
      if (!confirm(`¿Mejorar ${count} resúmenes sin revisar?`)) return;
      try {
        const r = await api('/glossary/unreviewed?limit=1000');
        const ids = (r.articles || []).map(a => a.id);
        const result = await api('/glossary/improve-batch', {
          method: 'POST',
          body: JSON.stringify({ article_ids: ids, dry_run: false })
        });
        document.getElementById('pv-glossary-improve-status').textContent =
          `✓ ${result.queued} artículos en cola`;
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    async function improveOutdated(count) {
      if (!confirm(`¿Mejorar ${count} resúmenes desactualizados?`)) return;
      try {
        const r = await api('/glossary/outdated?limit=1000');
        const ids = (r.articles || []).map(a => a.id);
        const result = await api('/glossary/improve-batch', {
          method: 'POST',
          body: JSON.stringify({ article_ids: ids, dry_run: false })
        });
        document.getElementById('pv-glossary-improve-status').textContent =
          `✓ ${result.queued} artículos en cola`;
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    // History tab
    async function loadHistoryTab() {
      try {
        const hist = await api('/glossary/log?limit=20');
        const histEl = document.getElementById('pv-glossary-history-list');
        histEl.innerHTML = (hist.improvements || []).map(h => `
          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin-bottom:8px;font-size:12px;">
            <div style="font-weight:600;color:#111827;">${esc(h.title || h.article_id)}</div>
            <div style="color:#6b7280;margin-top:2px;">v${h.glossary_version} · ${h.changes_count} cambios</div>
            <div style="color:#9ca3af;font-size:11px;margin-top:2px;">${new Date(h.improved_at).toLocaleString('es-ES')}</div>
          </div>
        `).join('');
      } catch (e) {
        console.error('Failed to load history:', e);
      }
    }

    // Import tab - TSV validation and import
    const tsvInput = document.getElementById('pv-glossary-tsv-input');
    const validateBtn = document.getElementById('pv-glossary-validate-btn');
    const importBtn = document.getElementById('pv-glossary-import-btn');
    const fileInput = document.getElementById('pv-glossary-file-input');
    const downloadTemplateBtn = document.getElementById('pv-glossary-download-template-btn');
    const validationArea = document.getElementById('pv-glossary-validation-area');
    const validationErrors = document.getElementById('pv-glossary-validation-errors');
    const validationSuccess = document.getElementById('pv-glossary-validation-success');
    const importStatus = document.getElementById('pv-glossary-import-status');

    let lastValidationData = null;

    async function validateTSV() {
      const tsvContent = tsvInput.value.trim();
      if (!tsvContent) {
        alert('Por favor pega contenido TSV');
        return;
      }

      validationArea.style.display = 'block';
      validationErrors.style.display = 'none';
      validationSuccess.style.display = 'none';
      importStatus.textContent = '';

      try {
        const result = await api('/glossary/validate-tsv', 'POST', { tsv_content: tsvContent });

        if (!result.valid) {
          // Show errors
          const errorList = document.getElementById('pv-glossary-validation-error-list');
          errorList.innerHTML = (result.errors || [])
            .map(e => `<li>${esc(e)}</li>`)
            .join('');
          validationErrors.style.display = 'block';
          lastValidationData = null;
          return;
        }

        // Show success and preview
        lastValidationData = { tsvContent, previewRows: result.preview_rows };
        const previewRows = document.getElementById('pv-glossary-preview-rows');
        previewRows.innerHTML = (result.preview_rows || [])
          .map(row => `
            <tr style="border-bottom:1px solid #e5e7eb;">
              <td style="padding:6px;color:#111827;">${esc(row.term_en)}</td>
              <td style="padding:6px;color:#0F3460;font-weight:500;">${esc(row.term_es_recommended)}</td>
              <td style="padding:6px;color:#dc2626;font-size:11px;">${esc(row.term_es_avoid || '-')}</td>
              <td style="padding:6px;color:#6b7280;font-size:11px;">${esc(row.category || '-')}</td>
            </tr>
          `)
          .join('');

        validationSuccess.style.display = 'block';
      } catch (e) {
        validationErrors.style.display = 'block';
        const errorList = document.getElementById('pv-glossary-validation-error-list');
        errorList.innerHTML = `<li>Error de conexión: ${esc(e.message)}</li>`;
        lastValidationData = null;
      }
    }

    async function performImport() {
      if (!lastValidationData) {
        alert('Primero valida el TSV');
        return;
      }

      importStatus.textContent = 'Importando...';
      importBtn.disabled = true;

      try {
        const result = await api('/glossary/import', 'POST', {
          tsv_content: lastValidationData.tsvContent
        });

        importStatus.textContent = `✓ Importados ${result.imported} términos (v${result.new_version})`;
        importStatus.style.color = '#15803d';
        tsvInput.value = '';
        validationArea.style.display = 'none';
        lastValidationData = null;

        // Reload browse tab
        setTimeout(() => { loadBrowseTab(); currentTab = 'browse'; }, 1000);
      } catch (e) {
        importStatus.textContent = `Error: ${e.message}`;
        importStatus.style.color = '#dc2626';
      } finally {
        importBtn.disabled = false;
      }
    }

    function generateTemplate() {
      const lines = [
        'English\tCastellano recomendado\tEvitar\tComentario\tCategoría',
        'prion\tprión\tprión (con tilde)\tSin tilde en inglés.\tTerminología',
        'prion disease\tenfermedad priónica\tenfermedad por priones\tForma preferida.\tTerminología'
      ];
      tsvInput.value = lines.join('\n');
    }

    function handleFileUpload(file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        tsvInput.value = e.target.result;
        validateTSV();
      };
      reader.onerror = () => alert('Error al leer archivo');
      reader.readAsText(file);
    }

    validateBtn.addEventListener('click', validateTSV);
    importBtn.addEventListener('click', performImport);
    downloadTemplateBtn.addEventListener('click', generateTemplate);
    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        handleFileUpload(e.target.files[0]);
      }
    });

    // Allow drop on textarea
    tsvInput.addEventListener('dragover', (e) => {
      e.preventDefault();
      tsvInput.style.background = '#f0fdf4';
    });
    tsvInput.addEventListener('dragleave', () => {
      tsvInput.style.background = '';
    });
    tsvInput.addEventListener('drop', (e) => {
      e.preventDefault();
      tsvInput.style.background = '';
      if (e.dataTransfer.files.length > 0) {
        handleFileUpload(e.dataTransfer.files[0]);
      }
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

  function wireQueryExpansion() {
    const escAttr = (v) => esc(String(v || ''));
    const btn   = document.getElementById('btn-query-expansion');
    const modal = document.getElementById('pv-qx-modal');
    if (!btn || !modal) return;
    const closeBtn = document.getElementById('pv-qx-close');
    const listEl   = document.getElementById('pv-qx-list');
    const filtEl   = document.getElementById('pv-qx-filter');
    const cntEl    = document.getElementById('pv-qx-counts');
    const termEl   = document.getElementById('pv-qx-new-term');
    const expEl    = document.getElementById('pv-qx-new-expansions');
    const kindEl   = document.getElementById('pv-qx-new-kind');
    const addBtn   = document.getElementById('pv-qx-add');
    let items = [];

    function open()  { modal.style.display = 'flex'; refresh(); }
    function close() { modal.style.display = 'none'; }
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    async function refresh() {
      listEl.innerHTML =
        '<div style="text-align:center;color:#9ca3af;padding:30px;font-size:13px;">Cargando…</div>';
      try {
        const r = await api('/admin/query-expansion/list');
        items = r.items || [];
        render();
      } catch (e) {
        listEl.innerHTML =
          `<div style="color:#b91c1c;padding:14px;font-size:13px;">Error: ${esc(e.message)}</div>`;
      }
    }

    function render() {
      const filter = (filtEl.value || '').trim().toLowerCase();
      const matches = items.filter(it =>
        !filter ||
        it.term.includes(filter) ||
        it.expansions.includes(filter) ||
        it.kind.includes(filter)
      );
      const seedN  = items.filter(it => it.source === 'seed').length;
      const adminN = items.filter(it => it.source === 'admin').length;
      cntEl.textContent =
        `${items.length} entradas · ${seedN} seed · ${adminN} admin` +
        (filter ? ` · ${matches.length} mostradas` : '');
      if (!matches.length) {
        listEl.innerHTML =
          `<div style="text-align:center;color:#9ca3af;padding:24px;font-size:13px;">
             ${filter ? 'Sin coincidencias.' : 'Diccionario vacío.'}
           </div>`;
        return;
      }
      // Single table-like grid for tight scanning.
      listEl.innerHTML = matches.map(it => {
        const srcChip = it.source === 'admin'
          ? `<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:#dcfce7;color:#166534;font-weight:600;">admin</span>`
          : `<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:#e5e7eb;color:#374151;font-weight:600;">seed</span>`;
        const kindChip =
          `<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:#eef2ff;color:#3730a3;font-weight:600;">${esc(it.kind)}</span>`;
        return `
          <div data-term="${escAttr(it.term)}" data-kind="${escAttr(it.kind)}"
               style="display:grid;grid-template-columns:1.5fr 4fr auto auto auto;gap:8px;
                      align-items:center;padding:7px 10px;border-bottom:1px solid #f3f4f6;
                      font-size:12.5px;">
            <div style="font-family:'JetBrains Mono',monospace;font-weight:600;color:#111827;
                        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              ${esc(it.term)}
            </div>
            <div style="color:#4b5563;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
                 title="${escAttr(it.expansions)}">${esc(it.expansions)}</div>
            ${kindChip}
            ${srcChip}
            <button class="pv-qx-row-actions" type="button"
                    title="Editar o borrar"
                    style="background:transparent;border:none;color:#6b7280;cursor:pointer;
                           padding:3px 6px;border-radius:4px;font-size:12px;">⋯</button>
          </div>`;
      }).join('');
      listEl.querySelectorAll('.pv-qx-row-actions').forEach(b => {
        b.addEventListener('click', (ev) => {
          const row = ev.target.closest('[data-term]');
          if (!row) return;
          openRowMenu(row);
        });
      });
    }

    function openRowMenu(row) {
      const term = row.dataset.term;
      const kind = row.dataset.kind;
      const it = items.find(i => i.term === term && i.kind === kind);
      if (!it) return;
      const action = prompt(
        `Entrada: ${term}  (${kind})\n` +
        `Expansiones actuales:\n  ${it.expansions}\n\n` +
        `• Escribe NUEVAS expansiones (coma) para reemplazar.\n` +
        `• Escribe "BORRAR" para eliminar.\n` +
        `• Vacío para cancelar.`,
        it.expansions
      );
      if (action == null || action === '') return;
      if (action.trim().toUpperCase() === 'BORRAR') {
        doDelete(term, kind);
        return;
      }
      doUpsert(term, action.trim(), kind);
    }

    async function doUpsert(term, expansions, kind) {
      try {
        await api('/admin/query-expansion', {
          method: 'POST',
          body: JSON.stringify({term, expansions, kind}),
        });
        refresh();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    async function doDelete(term, kind) {
      if (!confirm(`Borrar "${term}" (${kind})?`)) return;
      try {
        await api('/admin/query-expansion', {
          method: 'DELETE',
          body: JSON.stringify({term, kind}),
        });
        refresh();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    addBtn.addEventListener('click', () => {
      const term = termEl.value.trim();
      const expansions = expEl.value.trim();
      const kind = kindEl.value;
      if (!term || !expansions) {
        alert('Faltan término o expansiones.');
        return;
      }
      doUpsert(term, expansions, kind).then(() => {
        termEl.value = '';
        expEl.value  = '';
        termEl.focus();
      });
    });
    [termEl, expEl].forEach(el => {
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') addBtn.click();
      });
    });
    filtEl.addEventListener('input', render);
  }

  // Opening the modal switches to a tighter 30 s poll so the operator
  // can see status changes nearly in real time.
  function wireAIStatus() {
    const sidebarBtn = document.getElementById('btn-ai-status');
    const modal      = document.getElementById('pv-ai-status-modal');
    const closeBtn   = document.getElementById('pv-ai-status-close');
    const grid       = document.getElementById('pv-ai-status-grid');
    const refreshBtn = document.getElementById('pv-ai-status-refresh');
    const resetBtn   = document.getElementById('pv-ai-status-reset');
    const banner     = document.getElementById('pv-ai-banner');
    const bannerTxt  = document.getElementById('pv-ai-banner-text');

    if (!sidebarBtn || !modal || !banner) return;

    const PROVIDERS = ['anthropic', 'openai', 'gemini', 'voyage', 'unpaywall'];
    const PROVIDER_LABELS = {
      anthropic: 'Anthropic — Claude',
      openai:    'OpenAI — GPT',
      gemini:    'Google — Gemini',
      voyage:    'Voyage — Embeddings',
      unpaywall: 'Unpaywall — Open Access',
    };
    const STATUS_STYLES = {
      ok:               { bg: '#dcfce7', fg: '#166534', label: '✓ Operativo' },
      quota_exhausted:  { bg: '#fee2e2', fg: '#991b1b', label: '✗ Crédito agotado' },
      invalid_key:      { bg: '#fee2e2', fg: '#991b1b', label: '⛔ API key inválida' },
      rate_limited:     { bg: '#fef3c7', fg: '#92400e', label: '⚠ Rate-limited' },
      transient:        { bg: '#fef3c7', fg: '#92400e', label: '⚠ Error transitorio' },
      unknown:          { bg: '#f3f4f6', fg: '#374151', label: '• Sin datos' },
    };

    let bgPoll = null;
    let openPoll = null;

    async function refresh() {
      let snap;
      try {
        snap = await api('/admin/ai-providers-status');
      } catch (e) {
        // Not authenticated as admin, network down — don't spam.
        return null;
      }
      paintBanner(snap);
      if (modal.style.display === 'flex') paintModal(snap);
      return snap;
    }

    function paintBanner(snap) {
      const alerting = (snap.alerting || []);
      if (!alerting.length) {
        banner.style.display = 'none';
        return;
      }
      banner.style.display = 'flex';
      const names = alerting.map(p => PROVIDER_LABELS[p] || p).join(', ');
      bannerTxt.textContent =
        `⚠ ${names} — crédito agotado o API key inválida. Pulsa para ver detalles.`;
    }

    function paintModal(snap) {
      const provs = snap.providers || {};
      grid.innerHTML = PROVIDERS.map(p => {
        const v = provs[p] || {};
        const st = STATUS_STYLES[v.status || 'unknown'] || STATUS_STYLES.unknown;
        const lastOk  = v.last_success_at ? new Date(v.last_success_at).toLocaleString() : '—';
        const lastErr = v.last_error_at   ? new Date(v.last_error_at  ).toLocaleString() : '—';
        const errMsg  = v.last_error
          ? `<div style="margin-top:5px;font-size:11px;color:#7f1d1d;font-family:ui-monospace,monospace;
                         max-height:60px;overflow:auto;background:#fef2f2;
                         padding:5px 7px;border-radius:4px;border:1px solid #fecaca;">${esc(v.last_error)}</div>`
          : '';
        return `
          <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;padding:10px;">
            <div style="font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.04em;font-weight:600;">
              ${esc(PROVIDER_LABELS[p] || p)}
            </div>
            <div style="margin-top:4px;display:inline-flex;padding:3px 9px;border-radius:14px;
                         font-size:11.5px;font-weight:700;background:${st.bg};color:${st.fg};">
              ${esc(st.label)}
            </div>
            <div style="margin-top:8px;font-size:11.5px;color:#374151;line-height:1.5;">
              <div><span style="color:#9ca3af;">Último OK:</span> ${esc(lastOk)}
                ${v.success_count ? `<span style="color:#9ca3af;">(${v.success_count})</span>` : ''}</div>
              <div><span style="color:#9ca3af;">Último error:</span> ${esc(lastErr)}
                ${v.error_count ? `<span style="color:#9ca3af;">(${v.error_count})</span>` : ''}</div>
            </div>
            ${errMsg}
          </div>`;
      }).join('');
    }

    function openModal() {
      modal.style.display = 'flex';
      refresh();
      if (openPoll) clearInterval(openPoll);
      openPoll = setInterval(refresh, 30_000);
    }
    function closeModal() {
      modal.style.display = 'none';
      if (openPoll) { clearInterval(openPoll); openPoll = null; }
    }
    sidebarBtn.addEventListener('click', openModal);
    closeBtn  .addEventListener('click', closeModal);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', closeModal);
    banner.addEventListener('click', openModal);
    refreshBtn.addEventListener('click', refresh);
    resetBtn.addEventListener('click', async () => {
      if (!confirm('Borrar el historial de éxitos/errores de todos los proveedores?')) return;
      try {
        await api('/admin/ai-providers-status/reset', {
          method: 'POST', body: JSON.stringify({}),
        });
        await refresh();
      } catch (e) { alert('Error: ' + e.message); }
    });

    // Background poll (always running, regardless of modal). 60 s is
    // enough to surface a crédit-exhausted state within ~1 min.
    refresh();
    bgPoll = setInterval(refresh, 60_000);
  }

  // ── Mobile drawer (≤800 px) ────────────────────────────────────────
  // On phones the sidebar lives off-screen as a slide-in drawer; the
  // hamburger button toggles a body class that the CSS media query
  // converts into a translateX. All the open/close affordances stay
  // wired regardless of viewport — they're cheap and don't conflict
  // with anything desktop. On a wide screen the drawer state is
  // simply ignored because the sidebar's mobile rules don't fire.
  function wireMobileDrawer() {
    const btn     = document.getElementById('pv-mobile-menu-btn');
    const sidebar = document.getElementById('pv-sidebar');
    if (!btn || !sidebar) return;
    const KLS = 'pv-mobile-drawer-open';

    const open  = () => document.body.classList.add(KLS);
    const close = () => document.body.classList.remove(KLS);
    const toggle = () => document.body.classList.toggle(KLS);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });

    // Tapping the dark backdrop (outside the sidebar) closes the drawer.
    document.addEventListener('click', (e) => {
      if (!document.body.classList.contains(KLS)) return;
      if (e.target === btn || btn.contains(e.target))     return;
      if (sidebar.contains(e.target))                     return;
      close();
    });

    // Tapping any sidebar nav-button closes the drawer so navigation
    // (e.g. opening a modal) doesn't leave the drawer hovering over
    // the new content. Delay 80 ms so the button's own handler fires
    // first and the drawer slide-out doesn't beat the modal opening.
    sidebar.addEventListener('click', (e) => {
      if (e.target.closest('.pv-nav-btn')) setTimeout(close, 80);
    });

    // ESC closes too — handy on tablets with keyboards.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains(KLS)) close();
    });
  }

  // ── Library Health ──────────────────────────────────────────────────────
  // Global so the sidebar button's inline onclick can call it.
  window.openLibraryHealth = async function openLibraryHealth() {
    const modal = document.getElementById('pv-health-modal');
    const body  = document.getElementById('pv-health-body');
    if (!modal || !body) return;
    modal.style.display = 'flex';
    body.innerHTML = '<p style="color:#6b7280;text-align:center;padding:2rem;">Cargando…</p>';

    let d;
    try {
      const res = await fetch('/prionvault/api/articles/health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      d = await res.json();
    } catch (err) {
      body.innerHTML = `<p style="color:#ef4444;text-align:center;padding:2rem;">Error al cargar: ${esc(String(err))}</p>`;
      return;
    }

    const total = d.total || 0;
    const pct   = (n) => total > 0 ? ` (${Math.round(n / total * 100)}%)` : '';

    // Close modal and apply filter to main listing
    function applyHealthFilter(params) {
      modal.style.display = 'none';
      // Reset state to avoid stale filters from previous searches
      state.q = ''; state.yearMin = null; state.yearMax = null;
      state.journal = ''; state.authors = ''; state.tagId = null;
      state.hasSummary = null; state.inPrionread = null;
      state.isFlagged = null; state.isMilestone = null;
      state.colorLabel = null; state.priorityEq = null;
      state.extraction = null; state.isFavorite = null; state.isRead = null;
      state.collectionId = null; state.collectionGroup = null; state.collectionSubgroup = null;
      state.hasJc = null; state.jcPresenter = ''; state.jcYear = null;
      state.hasPp = null; state.ppId = ''; state.abstractStatus = ''; state.indexedStatus = '';
      state.page = 1;
      // Apply health-specific params by temporarily augmenting buildListParams
      // We do this by storing them in state as _health_ properties (cleaned after fetch).
      state._healthParams = params;
      loadArticles();
    }

    // ── Health modal layout helpers ────────────────────────────────────────
    // card(): single stat tile
    function card(label, value, showPct, filterParams, accent) {
      const num = value ?? 0;
      const pctStr = showPct ? ` <span style="font-size:11px;color:#9ca3af;">${pct(num)}</span>` : '';
      const fp = filterParams ? JSON.stringify(filterParams) : null;
      const bg = accent === 'good'   ? '#f0fdf4'
               : accent === 'warn'   ? '#fff7ed'
               : accent === 'bad'    ? '#fef2f2'
               : accent === 'purple' ? '#f5f3ff'
               : '#f9fafb';
      const numColor = accent === 'good'   ? '#15803d'
                     : accent === 'warn'   ? '#c2410c'
                     : accent === 'bad'    ? '#dc2626'
                     : accent === 'purple' ? '#6d28d9'
                     : '#111827';
      const border = accent === 'good'   ? '#bbf7d0'
                   : accent === 'warn'   ? '#fde68a'
                   : accent === 'bad'    ? '#fecaca'
                   : accent === 'purple' ? '#ddd6fe'
                   : '#e5e7eb';
      const interactive = fp ? `onclick='window._pvHealthFilter(${fp})'
        onmouseenter="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.12)';this.style.transform='translateY(-1px)'"
        onmouseleave="this.style.boxShadow='none';this.style.transform=''"` : '';
      return `<div ${interactive}
               style="background:${bg};border:1px solid ${border};border-radius:10px;
                      padding:12px 14px;display:flex;flex-direction:column;gap:3px;
                      transition:box-shadow 0.15s,transform 0.15s;
                      ${fp ? 'cursor:pointer;' : ''}">
        <span style="font-size:21px;font-weight:700;color:${numColor};line-height:1.1;">${num.toLocaleString()}${pctStr}</span>
        <span style="font-size:11.5px;color:#6b7280;line-height:1.3;">${label}</span>
      </div>`;
    }

    // row(cols): a grid row with a fixed number of columns
    function row(cols, items) {
      return `<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:8px;margin-bottom:8px;">${items.join('')}</div>`;
    }

    // section(): titled block, no forced column count (caller uses row())
    function section(title, inner) {
      return `<div style="margin-bottom:20px;">
        <h3 style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;
                   color:#9ca3af;margin:0 0 8px;padding-bottom:6px;border-bottom:1px solid #f3f4f6;">${title}</h3>
        ${inner}
      </div>`;
    }

    // Total hero
    const heroCard = `<div style="text-align:center;background:#f0f4ff;border:1px solid #c7d2fe;
                          border-radius:12px;padding:16px 24px;margin-bottom:20px;">
      <div style="font-size:36px;font-weight:800;color:#3730a3;line-height:1;">${(d.total??0).toLocaleString()}</div>
      <div style="font-size:13px;color:#6b7280;margin-top:4px;">artículos en la biblioteca</div>
    </div>`;

    // Provider badge helper for summary section labels
    const provLabels = {
      anthropic: '✦ Claude',
      openai:    '⬡ GPT',
      gemini:    '◈ Gemini',
    };
    const provColors = {
      anthropic: { bg:'#ede9fe', color:'#5b21b6', border:'#ddd6fe' },
      openai:    { bg:'#dcfce7', color:'#15803d', border:'#bbf7d0' },
      gemini:    { bg:'#dbeafe', color:'#1d4ed8', border:'#bfdbfe' },
    };
    // Pricing per 1M tokens (input / output) in USD
    const provPricing = {
      anthropic: { in: 3.0,  out: 15.0  },
      openai:    { in: 2.0,  out: 8.0   },
      gemini:    { in: 1.25, out: 10.0  },
    };
    const provTokenKeys = {
      anthropic: ['tokens_claude_in',  'tokens_claude_out'],
      openai:    ['tokens_gpt_in',     'tokens_gpt_out'],
      gemini:    ['tokens_gemini_in',  'tokens_gemini_out'],
    };
    function provCard(prov, count, filterVal) {
      const c = provColors[prov] || { bg:'#f3f4f6', color:'#374151', border:'#e5e7eb' };
      const lbl = provLabels[prov] || prov;
      const fp = JSON.stringify({ summary_ai_provider: filterVal });
      const pctStr = `<span style="font-size:11px;color:#9ca3af;"> ${pct(count)}</span>`;

      let tokenLine = '';
      const tk = provTokenKeys[prov];
      const pr = provPricing[prov];
      if (tk && pr) {
        const tin  = d[tk[0]] || 0;
        const tout = d[tk[1]] || 0;
        if (tin || tout) {
          const total = tin + tout;
          const cost  = (tin * pr.in + tout * pr.out) / 1_000_000;
          const fmtTk = total >= 1_000_000
            ? (total / 1_000_000).toFixed(2) + 'M tk'
            : total >= 1000
              ? (total / 1000).toFixed(1) + 'k tk'
              : total + ' tk';
          tokenLine = `<span style="font-size:10.5px;color:${c.color};opacity:0.75;margin-top:1px;">
            ${fmtTk} · $${cost.toFixed(3)}</span>`;
        }
      }

      return `<div onclick='window._pvHealthFilter(${fp})'
               onmouseenter="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.12)';this.style.transform='translateY(-1px)'"
               onmouseleave="this.style.boxShadow='none';this.style.transform=''"
               style="background:${c.bg};border:1px solid ${c.border};border-radius:10px;
                      padding:12px 14px;cursor:pointer;transition:box-shadow 0.15s,transform 0.15s;
                      display:flex;flex-direction:column;gap:3px;">
        <span style="font-size:21px;font-weight:700;color:${c.color};line-height:1.1;">${(count??0).toLocaleString()}${pctStr}</span>
        <span style="font-size:11.5px;color:${c.color};font-weight:600;">${lbl}</span>
        ${tokenLine}
      </div>`;
    }

    const completenessBtn = `<div id="pv-completeness-btn" onclick="window._pvShowCompleteness()"
      onmouseenter="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.12)';this.style.transform='translateY(-1px)'"
      onmouseleave="this.style.boxShadow='none';this.style.transform=''"
      style="display:flex;align-items:center;justify-content:space-between;
             background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;
             padding:14px 18px;margin-bottom:16px;cursor:pointer;
             transition:box-shadow 0.15s,transform 0.15s;">
      <span style="font-size:13.5px;font-weight:600;color:#1d4ed8;">🗂 Completitud de metadatos</span>
      <span style="font-size:18px;color:#3b82f6;font-weight:700;">→</span>
    </div>`;

    body.style.position = 'relative';

    body.innerHTML =
      heroCard +
      completenessBtn +

      section('Contenido', [
        row(2, [card('Con PDF',    d.with_pdf,    true, {has_pdf:'true'},  'good'),
                card('Sin PDF',    d.without_pdf, true, {has_pdf:'false'}, 'warn')]),
        row(2, [card('Con DOI',    d.with_doi,    true, {has_doi:'true'},  'good'),
                card('Sin DOI',    d.without_doi, true, {has_doi:'false'}, 'purple')]),
        row(2, [card('Con PMID',   d.with_pmid,   true, {has_pmid:'true'}, 'good'),
                card('Sin PMID',   d.without_pmid,true, {has_pmid:'false'},'purple')]),
        row(2, [card('Con abstract',    d.with_abstract,    true, {abstract_status:'has'},     'good'),
                card('Sin abstract',    d.without_abstract, true, {abstract_status:'pending'}, 'warn')]),
      ].join('')) +

      section('PDF & OCR', [
        row(3, [card('PDFs escaneados (OCR)',  d.pdf_ocr,              true, {pdf_is_scan:'true'},    ''),
                card('PDFs buscables',         d.pdf_searchable,       true, {pdf_searchable:'true'}, 'good'),
                card('Necesitan buscable',     d.pdf_needs_searchable, true, {pdf_searchable:'false'},'warn')]),
        row(2, [card('Con nº de páginas', d.with_page_count,    true, null, ''),
                card('Sin nº de páginas', d.missing_page_count, true, null, 'warn')]),
        row(2, [card('Fuente: PubMed Inventory', d.from_inventory, true, {source:'pubmed_inventory'}, ''),
                card('Fuente: manual',           d.from_manual,    true, {source:'manual'}, '')]),
      ].join('')) +

      section('Procesamiento & Indexación', [
        row(3, [card('Texto extraído',       d.text_extracted, true, {extraction_status:'extracted'}, 'good'),
                card('Extracción pendiente', d.text_pending,   true, {extraction_status:'pending'},   'warn'),
                card('Extracción fallida',   d.text_failed,    true, {extraction_status:'failed'},    'bad')]),
        row(2, [card(`Indexados (${d.embed_model || 'IA'})`, d.indexed,       true, {indexed_status:'yes'},  'good'),
                card('Necesitan indexación',                  d.needs_indexing,true, {needs_indexing:'true'}, 'warn')]),
      ].join('')) +

      section('Resúmenes IA', (() => {
        // Always show total pair
        let html = row(2, [card('Con resumen IA',     d.with_summary_ai,    true, {has_summary:'ai'},    'good'),
                           card('Con resumen humano', d.with_summary_human, true, {has_summary:'human'}, 'good')]);
        // Per-provider breakdown (only if at least one has data)
        const provRows = [];
        if (d.summary_by_claude > 0) provRows.push(provCard('anthropic', d.summary_by_claude, 'anthropic'));
        if (d.summary_by_gpt    > 0) provRows.push(provCard('openai',    d.summary_by_gpt,    'openai'));
        if (d.summary_by_gemini > 0) provRows.push(provCard('gemini',    d.summary_by_gemini, 'gemini'));
        if (d.summary_by_unknown > 0) {
          const fp = JSON.stringify({ summary_ai_provider: 'unknown' });
          provRows.push(`<div onclick='window._pvHealthFilter(${fp})'
            onmouseenter="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.12)'"
            onmouseleave="this.style.boxShadow='none'"
            style="background:#f3f4f6;border:1px solid #e5e7eb;border-radius:10px;
                   padding:12px 14px;cursor:pointer;transition:box-shadow 0.15s;
                   display:flex;flex-direction:column;gap:3px;">
            <span style="font-size:21px;font-weight:700;color:#374151;line-height:1.1;">${(d.summary_by_unknown??0).toLocaleString()}</span>
            <span style="font-size:11.5px;color:#6b7280;">Sin proveedor registrado</span>
          </div>`);
        }
        if (provRows.length) html += row(Math.min(provRows.length, 3), provRows);
        if (d.with_summary_notes > 0) {
          html += row(1, [card('⚠ Con errores/notas en resumen', d.with_summary_notes, true, {has_summary_notes:'true'}, 'bad')]);
        }
        return html;
      })()) +

      `<div data-glossary-section style="margin-bottom:20px;">
        <h3 style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#9ca3af;margin:0 0 8px;padding-bottom:6px;border-bottom:1px solid #f3f4f6;">Glosario y mejora de resúmenes</h3>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:8px;">
          <div style="background:#fff7ed;border:1px solid #fde68a;border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:3px;">
            <span style="font-size:21px;font-weight:700;color:#c2410c;line-height:1.1;">...</span>
            <span style="font-size:11.5px;color:#6b7280;line-height:1.3;">Resúmenes sin revisar</span>
          </div>
          <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:3px;">
            <span style="font-size:21px;font-weight:700;color:#dc2626;line-height:1.1;">...</span>
            <span style="font-size:11.5px;color:#6b7280;line-height:1.3;">Resúmenes desactualizados</span>
          </div>
        </div>
      </div>` +

      section('🔍 Verificación PDF ↔ metadatos', [
        row(2, [card('✗ Mismatches',  d.verify_mismatch, true, {pdf_verify_status:'mismatch'}, 'bad'),
                card('⚠ Sospechosos', d.verify_suspect,  true, {pdf_verify_status:'suspect'},  'warn')]),
        row(2, [card('✓ Match OK',                d.verify_ok,      true, {pdf_verify_status:'ok_any'},     'good'),
                card('Sin verificar (con PDF)',    d.verify_pending, true, {pdf_verify_status:'unverified'}, '')]),
      ].join(''));

    // Sub-panel: completeness breakdown
    window._pvShowCompleteness = function() {
      const existing = document.getElementById('pv-completeness-panel');
      if (existing) existing.remove();

      const fields = [
        { label: 'Título',    key: 'missing_title',    filter: {has_title:'false'},           accent: d.missing_title   > 0 ? 'warn'   : 'good' },
        { label: 'Autores',   key: 'missing_authors',  filter: {has_authors:'false'},         accent: d.missing_authors > 0 ? 'warn'   : 'good' },
        { label: 'Revista',   key: 'missing_journal',  filter: {has_journal:'false'},         accent: d.missing_journal > 0 ? 'warn'   : 'good' },
        { label: 'Año',       key: 'missing_year',     filter: {has_year:'false'},            accent: d.missing_year    > 0 ? 'warn'   : 'good' },
        { label: 'Abstract',  key: 'missing_abstract', filter: {abstract_status:'pending'},   accent: d.missing_abstract > 0 ? 'warn'  : 'good' },
        { label: 'DOI',       key: 'missing_doi',      filter: {has_doi:'false'},             accent: d.missing_doi     > 0 ? 'purple' : 'good' },
        { label: 'PMID',      key: 'missing_pmid',     filter: {has_pmid:'false'},            accent: d.missing_pmid    > 0 ? 'purple' : 'good' },
      ];

      const fieldCards = fields.map(f => card('Sin ' + f.label, d[f.key] ?? 0, true, f.filter, f.accent)).join('');
      const gridRows = [];
      for (let i = 0; i < fields.length; i += 2) {
        const pair = fields.slice(i, i + 2);
        gridRows.push(`<div style="display:grid;grid-template-columns:repeat(${pair.length},1fr);gap:8px;margin-bottom:8px;">${
          pair.map(f => card('Sin ' + f.label, d[f.key] ?? 0, true, f.filter, f.accent)).join('')
        }</div>`);
      }

      const panel = document.createElement('div');
      panel.id = 'pv-completeness-panel';
      panel.style.cssText = 'position:absolute;inset:0;background:#fff;z-index:10;border-radius:inherit;display:flex;flex-direction:column;overflow:hidden;';
      panel.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid #f3f4f6;flex-shrink:0;">
          <button onclick="document.getElementById('pv-completeness-panel').remove()"
            style="background:none;border:1px solid #e5e7eb;border-radius:8px;padding:5px 12px;
                   cursor:pointer;font-size:13px;color:#374151;font-weight:600;">← Atrás</button>
          <div>
            <div style="font-size:14px;font-weight:700;color:#111827;">Artículos con metadatos incompletos</div>
            <div style="font-size:11.5px;color:#9ca3af;">Haz clic en un campo para ver los artículos afectados</div>
          </div>
        </div>
        <div style="flex:1;overflow-y:auto;padding:18px;">
          <div style="text-align:center;background:#f0f4ff;border:1px solid #c7d2fe;border-radius:12px;
                      padding:14px 24px;margin-bottom:16px;">
            <div style="font-size:32px;font-weight:800;color:#3730a3;line-height:1;">${(d.total??0).toLocaleString()}</div>
            <div style="font-size:12px;color:#6b7280;margin-top:3px;">artículos totales</div>
          </div>
          ${gridRows.join('')}
        </div>
      `;
      body.appendChild(panel);
    };

    // Wire up click handler for health filters
    window._pvHealthFilter = function(params) {
      modal.style.display = 'none';
      // Reset state
      Object.assign(state, {
        q: '', yearMin: null, yearMax: null, journal: '', authors: '',
        tagId: null, hasSummary: null, inPrionread: null, isFlagged: null,
        isMilestone: null, colorLabel: null, priorityEq: null, extraction: null,
        isFavorite: null, isRead: null, isJc: null, collectionId: null, collectionGroup: null,
        collectionSubgroup: null, hasJc: null, jcPresenter: '', jcYear: null,
        hasPp: null, ppId: '', abstractStatus: '', indexedStatus: '', page: 1,
      });

      // Apply known filter params that map to state fields
      if (params.has_summary)       state.hasSummary    = params.has_summary;
      if (params.abstract_status)   state.abstractStatus = params.abstract_status;
      if (params.indexed_status)    state.indexedStatus  = params.indexed_status;
      if (params.extraction_status) state.extraction     = params.extraction_status;

      // For params the state doesn't have native slots for, store as _healthExtra
      // and patch buildListParams temporarily
      const extra = {};
      for (const k of ['has_pdf','has_doi','has_pmid','has_title','has_authors','has_journal','has_year',
                        'pdf_is_scan','pdf_searchable',
                        'source','needs_indexing','has_summary_ai','has_summary_notes',
                        'pdf_verify_status','summary_ai_provider']) {
        if (params[k] !== undefined) extra[k] = params[k];
      }
      state._healthExtra = Object.keys(extra).length ? extra : null;

      loadArticles();
    };

    // Fetch glossary stats and update health modal
    (async () => {
      try {
        const [statsRes, unrevRes, outdRes] = await Promise.all([
          fetch('/prionvault/api/admin/summaries/stats'),
          fetch('/prionvault/api/admin/summaries/unreviewed?limit=1'),
          fetch('/prionvault/api/admin/summaries/outdated?limit=1'),
        ]);

        if (!statsRes.ok || !unrevRes.ok || !outdRes.ok) return;

        const stats = await statsRes.json();
        const unreviewed = await unrevRes.json();
        const outdated = await outdRes.json();

        const unrevCount = unreviewed.total ?? 0;
        const outdCount = outdated.total ?? 0;

        // Find and replace glossary section placeholders
        const glossarySection = body.querySelector('[data-glossary-section]');
        if (glossarySection) {
          const unrevCard = `<div onclick="window.location.href='/admin/glossary#summaries'" style="cursor:pointer;" onmouseenter="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.12)';this.style.transform='translateY(-1px)'" onmouseleave="this.style.boxShadow='none';this.style.transform=''" class="pv-health-card" style="background:#fff7ed;border:1px solid #fde68a;border-radius:10px;padding:12px 14px;transition:box-shadow 0.15s,transform 0.15s;">
            <span style="font-size:21px;font-weight:700;color:#c2410c;line-height:1.1;">${unrevCount.toLocaleString()}</span>
            <span style="font-size:11.5px;color:#6b7280;line-height:1.3;">Resúmenes sin revisar</span>
          </div>`;

          const outdCard = `<div onclick="window.location.href='/admin/glossary#summaries'" style="cursor:pointer;" onmouseenter="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.12)';this.style.transform='translateY(-1px)'" onmouseleave="this.style.boxShadow='none';this.style.transform=''" class="pv-health-card" style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:12px 14px;transition:box-shadow 0.15s,transform 0.15s;">
            <span style="font-size:21px;font-weight:700;color:#dc2626;line-height:1.1;">${outdCount.toLocaleString()}</span>
            <span style="font-size:11.5px;color:#6b7280;line-height:1.3;">Resúmenes desactualizados</span>
          </div>`;

          glossarySection.innerHTML = `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:8px;">${unrevCard}${outdCard}</div>`;
        }
      } catch (err) {
        // Silently fail - health modal still shows placeholder
        console.debug('Failed to load glossary stats:', err);
      }
    })();

  };

  document.addEventListener('DOMContentLoaded', init);
})();

// Cart badge for PrionVault (pp-cart.js loaded before this script)
(function () {
  const updateBadge = () => {
    const n = window.PPCart?.count() ?? 0;
    const badge = document.getElementById('pv-cart-badge');
    if (badge) { badge.textContent = n; badge.style.display = n > 0 ? '' : 'none'; }
  };
  window.addEventListener('pp-cart-changed', updateBadge);
  document.addEventListener('DOMContentLoaded', updateBadge);
})();

// ── Export References ─────────────────────────────────────────────────────
(function () {
  'use strict';

  const BLOCK_META = {
    authors:         { label: 'Autores',           icon: 'fas fa-users' },
    title:           { label: 'Título',             icon: 'fas fa-heading' },
    journal:         { label: 'Revista',            icon: 'fas fa-newspaper' },
    year:            { label: 'Año',                icon: 'fas fa-calendar' },
    doi:             { label: 'DOI',                icon: 'fas fa-link' },
    pmid:            { label: 'PMID',               icon: 'fas fa-flask' },
    author_position: { label: 'Posición del autor', icon: 'fas fa-list-ol' },
  };

  const DEFAULT_CONFIG = () => ({
    blocks: [
      { id: 'authors', active: true, options: {
          mode: 'all',
          separator: 'comma', last_separator: 'and',
          bold: false, italic: false, underline: false, color: '',
          marked_bold: true, marked_italic: true, marked_underline: true, marked_color: '',
      }},
      { id: 'title',           active: true,  options: { bold: false, italic: false, underline: false, color: '' } },
      { id: 'journal',         active: true,  options: { bold: true,  italic: true,  underline: false, color: '' } },
      { id: 'year',            active: true,  options: { bold: false, italic: false, underline: false, color: '' } },
      { id: 'doi',             active: true,  options: { with_link: true,  bold: false, italic: false, underline: false, color: '' } },
      { id: 'pmid',            active: true,  options: { with_link: true,  bold: false, italic: false, underline: false, color: '' } },
      { id: 'author_position', active: false, options: { bold: false, italic: false, underline: false, color: '' } },
    ],
    show_labels:   false,
    show_type:     false,
    marked_author: 'Joaquín Castilla',
  });

  // ── Presets (localStorage) ────────────────────────────────────────────
  const PRESETS_KEY = 'pv-export-refs-presets';

  function _loadPresets() {
    try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '{}'); }
    catch { return {}; }
  }

  function _savePresets(presets) {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  }

  function _presetNames() {
    return Object.keys(_loadPresets()).sort();
  }

  function _saveCurrentAsPreset(name) {
    if (!name) return;
    const presets = _loadPresets();
    presets[name] = JSON.parse(JSON.stringify(_config));
    _savePresets(presets);
    _renderPresetBar();
  }

  function _loadPreset(name) {
    const presets = _loadPresets();
    if (presets[name]) {
      _config = JSON.parse(JSON.stringify(presets[name]));
      _selectedBlockId = null;
      _markedInput.value  = _config.marked_author || 'Joaquín Castilla';
      _showLabels.checked = !!_config.show_labels;
      _showType.checked   = !!_config.show_type;
      _renderBlocks();
      _renderOptions(null);
    }
  }

  function _deletePreset(name) {
    const presets = _loadPresets();
    delete presets[name];
    _savePresets(presets);
    _renderPresetBar();
  }

  function _renderPresetBar() {
    const bar = document.getElementById('pv-er-preset-bar');
    if (!bar) return;
    const names = _presetNames();
    if (!names.length) {
      bar.innerHTML = '<span style="font-size:12px;color:#9ca3af;font-style:italic;">Sin configuraciones guardadas.</span>';
      return;
    }
    bar.innerHTML = names.map(n => `
      <span class="pv-er-preset-chip" data-name="${_esc(n)}"
            style="display:inline-flex;align-items:center;gap:4px;
                   background:#f3f4f6;border:1px solid #d1d5db;border-radius:20px;
                   padding:3px 10px 3px 10px;font-size:12px;color:#374151;
                   cursor:pointer;transition:background .12s;">
        <span class="pv-er-preset-name" title="Cargar "${_esc(n)}"" style="cursor:pointer;">${_esc(n)}</span>
        <button type="button" class="pv-er-preset-del" data-name="${_esc(n)}"
                title="Borrar este ajuste"
                style="background:none;border:none;padding:0 0 0 4px;cursor:pointer;
                       color:#9ca3af;font-size:11px;line-height:1;">×</button>
      </span>`).join('');

    bar.querySelectorAll('.pv-er-preset-name').forEach(el => {
      el.addEventListener('click', () => _loadPreset(el.closest('[data-name]').dataset.name));
    });
    bar.querySelectorAll('.pv-er-preset-del').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (confirm(`¿Borrar el ajuste "${btn.dataset.name}"?`)) _deletePreset(btn.dataset.name);
      });
    });
  }

  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── State ─────────────────────────────────────────────────────────────
  let _config = DEFAULT_CONFIG();
  let _selectedBlockId = null;
  let _dragSrcIdx = null;

  let _modal, _blocksEl, _optionsBody, _optionsEmpty,
      _exportBtn, _markedInput, _showLabels, _showType, _countEl;

  function _el(id) { return document.getElementById(id); }

  // ── Open / close ──────────────────────────────────────────────────────

  function openExportRefs() {
    const ids = _visibleIds();
    if (!ids.length) { alert('No hay referencias visibles en el listado.'); return; }
    _config = DEFAULT_CONFIG();
    _selectedBlockId = null;
    _markedInput.value  = _config.marked_author;
    _showLabels.checked = _config.show_labels;
    _showType.checked   = _config.show_type;
    _countEl.textContent = `${ids.length} referencia${ids.length !== 1 ? 's' : ''}`;
    _renderBlocks();
    _renderOptions(null);
    _renderPresetBar();
    _modal.style.display = 'flex';
  }

  function _close() { _modal.style.display = 'none'; }

  function _visibleIds() {
    return Array.from(document.querySelectorAll('.pv-row-select')).map(cb => cb.dataset.aid);
  }

  // ── Block list renderer ───────────────────────────────────────────────

  function _renderBlocks() {
    _blocksEl.innerHTML = '';
    _config.blocks.forEach((block, idx) => {
      const meta      = BLOCK_META[block.id] || { label: block.id, icon: 'fas fa-circle' };
      const isActive  = block.active;
      const isSel     = block.id === _selectedBlockId;

      const row = document.createElement('div');
      row.draggable   = true;
      row.dataset.idx = idx;
      row.style.cssText = `
        display:flex;align-items:center;gap:6px;padding:7px 8px;border-radius:8px;
        border:1.5px solid ${isSel ? '#0F3460' : (isActive ? '#d1d5db' : '#e5e7eb')};
        background:${isSel ? '#eff6ff' : (isActive ? 'white' : '#f9fafb')};
        cursor:pointer;user-select:none;transition:border-color .15s,background .15s;
        opacity:${isActive ? '1' : '0.55'};`;

      // Drag handle
      const handle = document.createElement('span');
      handle.innerHTML = '<i class="fas fa-grip-vertical"></i>';
      handle.style.cssText = 'color:#9ca3af;font-size:12px;cursor:grab;flex-shrink:0;padding:0 2px;';

      // Toggle checkbox
      const chk = document.createElement('input');
      chk.type    = 'checkbox';
      chk.checked = isActive;
      chk.style.cssText = 'width:14px;height:14px;accent-color:#0F3460;flex-shrink:0;cursor:pointer;';
      chk.addEventListener('click', e => {
        e.stopPropagation();
        _config.blocks[idx].active = chk.checked;
        if (!chk.checked && _selectedBlockId === block.id) {
          _selectedBlockId = null;
          _renderOptions(null);
        }
        _renderBlocks();
      });

      // Icon + label
      const lbl = document.createElement('span');
      lbl.style.cssText = `flex:1;font-size:12.5px;font-weight:${isActive?'500':'400'};
        color:${isActive?'#111827':'#9ca3af'};display:flex;align-items:center;gap:6px;`;
      lbl.innerHTML = `<i class="${meta.icon}" style="font-size:11px;opacity:0.6;"></i>${meta.label}`;

      // Up/down arrows
      const arrowBox = document.createElement('span');
      arrowBox.style.cssText = 'display:flex;flex-direction:column;gap:1px;flex-shrink:0;';
      [['fa-chevron-up', -1], ['fa-chevron-down', 1]].forEach(([icon, dir]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.innerHTML = `<i class="fas ${icon}"></i>`;
        btn.style.cssText = 'background:none;border:none;padding:1px 3px;cursor:pointer;color:#9ca3af;font-size:9px;line-height:1;';
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const ni = idx + dir;
          if (ni < 0 || ni >= _config.blocks.length) return;
          [_config.blocks[idx], _config.blocks[ni]] = [_config.blocks[ni], _config.blocks[idx]];
          _renderBlocks();
        });
        arrowBox.appendChild(btn);
      });

      row.appendChild(handle);
      row.appendChild(chk);
      row.appendChild(lbl);
      row.appendChild(arrowBox);

      // Click → select block
      row.addEventListener('click', () => {
        if (!block.active) return;
        _selectedBlockId = block.id;
        _renderBlocks();
        _renderOptions(block);
      });

      // Drag & drop
      row.addEventListener('dragstart', e => {
        _dragSrcIdx = idx;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => row.style.opacity = '0.3', 0);
      });
      row.addEventListener('dragend', () => { _dragSrcIdx = null; _renderBlocks(); });
      row.addEventListener('dragover', e => { e.preventDefault(); row.style.background = '#dbeafe'; });
      row.addEventListener('dragleave', () => {
        row.style.background = isSel ? '#eff6ff' : (isActive ? 'white' : '#f9fafb');
      });
      row.addEventListener('drop', e => {
        e.preventDefault();
        if (_dragSrcIdx === null || _dragSrcIdx === idx) return;
        const moved = _config.blocks.splice(_dragSrcIdx, 1)[0];
        _config.blocks.splice(idx, 0, moved);
        _dragSrcIdx = null;
        _renderBlocks();
      });

      _blocksEl.appendChild(row);
    });
  }

  // ── Per-block options renderer ────────────────────────────────────────

  function _renderOptions(block) {
    if (!block) {
      _optionsEmpty.style.display = 'flex';
      _optionsBody.style.display  = 'none';
      return;
    }
    _optionsEmpty.style.display = 'none';
    _optionsBody.style.display  = 'block';

    const opts = block.options;
    const bid  = block.id;
    const meta = BLOCK_META[bid] || { label: bid, icon: 'fas fa-circle' };

    let html = `
      <h3 style="margin:0 0 14px;font-size:14px;font-weight:700;color:#111827;
                 display:flex;align-items:center;gap:7px;">
        <i class="${meta.icon}" style="color:#0F3460;font-size:13px;"></i>${meta.label}
      </h3>`;

    if (bid === 'authors') {
      html += _authorsModeHtml(opts);
      html += _formatRow('Formato de todos los autores', opts, 'bold', 'italic', 'underline', 'color');
      html += _markedFmtHtml(opts);
    } else if (bid === 'doi' || bid === 'pmid') {
      html += _linkToggleHtml(opts, bid);
      html += _formatRow('Formato', opts, 'bold', 'italic', 'underline', 'color');
    } else {
      html += _formatRow('Formato', opts, 'bold', 'italic', 'underline', 'color');
    }

    _optionsBody.innerHTML = html;
    _bindOptionEvents(block);
  }

  function _fmtCheckbox(label, key, opts) {
    const id  = `pv-er-opt-${key}`;
    return `<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12.5px;color:#374151;">
      <input type="checkbox" id="${id}" data-key="${key}" ${opts[key] ? 'checked' : ''}
             style="width:13px;height:13px;accent-color:#0F3460;">
      ${label}
    </label>`;
  }

  function _colorPicker(key, opts, label) {
    const val = opts[key] || '#000000';
    const on  = !!opts[key];
    return `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12.5px;color:#374151;">
      <input type="checkbox" id="pv-er-opt-${key}-enabled" data-key="${key}-enabled" ${on ? 'checked' : ''}
             style="width:13px;height:13px;accent-color:#0F3460;">
      ${label}
      <input type="color" id="pv-er-opt-${key}" data-key="${key}" value="${val}"
             ${on ? '' : 'disabled'}
             style="width:28px;height:22px;border:1px solid #d1d5db;border-radius:4px;
                    padding:1px;cursor:pointer;${on ? '' : 'opacity:0.3;'}">
    </label>`;
  }

  function _formatRow(sectionLabel, opts, ...keys) {
    const items = [];
    if (keys.includes('bold'))      items.push(_fmtCheckbox('Negrita',    'bold',      opts));
    if (keys.includes('italic'))    items.push(_fmtCheckbox('Cursiva',    'italic',    opts));
    if (keys.includes('underline')) items.push(_fmtCheckbox('Subrayado',  'underline', opts));
    if (keys.includes('color'))     items.push(_colorPicker('color', opts, 'Color'));
    return `
      <div style="margin-bottom:14px;">
        <p style="margin:0 0 7px;font-size:11px;font-weight:700;letter-spacing:.06em;
                  color:#9ca3af;text-transform:uppercase;">${sectionLabel}</p>
        <div style="display:flex;flex-wrap:wrap;gap:10px 18px;">${items.join('')}</div>
      </div>`;
  }

  function _authorsModeHtml(opts) {
    const m  = opts.mode          || 'all';
    const sp = opts.separator     || 'comma';
    const ls = opts.last_separator || 'and';
    return `
      <div style="margin-bottom:14px;">
        <p style="margin:0 0 7px;font-size:11px;font-weight:700;letter-spacing:.06em;
                  color:#9ca3af;text-transform:uppercase;">Modo de presentación</p>
        <div style="display:flex;flex-direction:column;gap:7px;">
          ${[['all','Todos los autores'],['first_et_al','Primero + et al.'],['first_last','Primero + … + último']]
            .map(([val,lbl]) => `
            <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12.5px;color:#374151;">
              <input type="radio" name="pv-er-author-mode" data-key="mode" value="${val}"
                     ${m===val?'checked':''} style="accent-color:#0F3460;">
              ${lbl}
            </label>`).join('')}
        </div>
      </div>
      <div style="margin-bottom:14px;">
        <p style="margin:0 0 7px;font-size:11px;font-weight:700;letter-spacing:.06em;
                  color:#9ca3af;text-transform:uppercase;">Separador entre autores</p>
        <div style="display:flex;gap:14px;flex-wrap:wrap;">
          ${[['comma','Comas  ( , )'],['semicolon','Puntos y coma  ( ; )']]
            .map(([val,lbl]) => `
            <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12.5px;color:#374151;">
              <input type="radio" name="pv-er-separator" data-key="separator" value="${val}"
                     ${sp===val?'checked':''} style="accent-color:#0F3460;">
              ${lbl}
            </label>`).join('')}
        </div>
      </div>
      <div style="margin-bottom:14px;">
        <p style="margin:0 0 7px;font-size:11px;font-weight:700;letter-spacing:.06em;
                  color:#9ca3af;text-transform:uppercase;">Antes del último autor</p>
        <div style="display:flex;gap:14px;flex-wrap:wrap;">
          ${[['same','Mismo separador'],['and',', and  /  ; and']]
            .map(([val,lbl]) => `
            <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12.5px;color:#374151;">
              <input type="radio" name="pv-er-last-sep" data-key="last_separator" value="${val}"
                     ${ls===val?'checked':''} style="accent-color:#0F3460;">
              ${lbl}
            </label>`).join('')}
        </div>
      </div>`;
  }

  function _markedFmtHtml(opts) {
    const items = [
      _fmtCheckbox('Negrita',   'marked_bold',      opts),
      _fmtCheckbox('Cursiva',   'marked_italic',    opts),
      _fmtCheckbox('Subrayado', 'marked_underline', opts),
      _colorPicker('marked_color', opts, 'Color'),
    ].join('');
    return `
      <div style="margin-bottom:14px;padding:10px 12px;background:#f0f9ff;
                  border-radius:8px;border:1px solid #bae6fd;">
        <p style="margin:0 0 7px;font-size:11px;font-weight:700;letter-spacing:.06em;
                  color:#0369a1;text-transform:uppercase;">
          <i class="fas fa-star" style="margin-right:4px;"></i>Formato del autor marcado
        </p>
        <div style="display:flex;flex-wrap:wrap;gap:10px 18px;">${items}</div>
      </div>`;
  }

  function _linkToggleHtml(opts, bid) {
    return `
      <div style="margin-bottom:14px;">
        <p style="margin:0 0 7px;font-size:11px;font-weight:700;letter-spacing:.06em;
                  color:#9ca3af;text-transform:uppercase;">Enlace</p>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12.5px;color:#374151;">
          <input type="checkbox" id="pv-er-opt-with_link" data-key="with_link"
                 ${opts.with_link!==false?'checked':''} style="width:13px;height:13px;accent-color:#0F3460;">
          Mostrar como hipervínculo
          <span style="color:#9ca3af;font-size:11px;">(${bid==='doi'?'doi.org':'PubMed'})</span>
        </label>
      </div>`;
  }

  // ── Bind option events ────────────────────────────────────────────────

  function _bindOptionEvents(block) {
    const opts = block.options;
    _optionsBody.querySelectorAll('input[type=checkbox][data-key]').forEach(cb => {
      const key = cb.dataset.key;
      if (key.endsWith('-enabled')) {
        const colorKey = key.replace('-enabled', '');
        cb.addEventListener('change', () => {
          const picker = _optionsBody.querySelector(`[data-key="${colorKey}"]`);
          if (!cb.checked) {
            opts[colorKey] = '';
            if (picker) { picker.disabled = true; picker.style.opacity = '0.3'; }
          } else {
            opts[colorKey] = picker ? picker.value : '#000000';
            if (picker) { picker.disabled = false; picker.style.opacity = '1'; }
          }
        });
      } else {
        cb.addEventListener('change', () => { opts[key] = cb.checked; });
      }
    });

    _optionsBody.querySelectorAll('input[type=color][data-key]').forEach(cp => {
      cp.addEventListener('input', () => {
        const enabledCb = _optionsBody.querySelector(`[data-key="${cp.dataset.key}-enabled"]`);
        if (!enabledCb || enabledCb.checked) opts[cp.dataset.key] = cp.value;
      });
    });

    _optionsBody.querySelectorAll('input[type=radio][data-key]').forEach(rb => {
      rb.addEventListener('change', () => { if (rb.checked) opts[rb.dataset.key] = rb.value; });
    });
  }

  // ── Export ────────────────────────────────────────────────────────────

  async function _doExport() {
    const ids = _visibleIds();
    if (!ids.length) { alert('No hay referencias visibles.'); return; }

    _config.marked_author = _markedInput.value.trim();
    _config.show_labels   = _showLabels.checked;
    _config.show_type     = _showType.checked;

    _exportBtn.disabled  = true;
    const orig           = _exportBtn.innerHTML;
    _exportBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generando…';

    try {
      const res = await fetch('/prionvault/api/articles/export-refs-docx', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ article_ids: ids, config: _config }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        alert('Error al exportar: ' + (err.error || res.statusText));
        return;
      }
      const blob  = await res.blob();
      const url   = URL.createObjectURL(blob);
      const a     = document.createElement('a');
      const ts    = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      a.href      = url;
      a.download  = `Referencias_${ts}.docx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      _close();
    } catch (e) {
      alert('Error de red: ' + e.message);
    } finally {
      _exportBtn.disabled  = false;
      _exportBtn.innerHTML = orig;
    }
  }

  // ── Gobierno Vasco export ─────────────────────────────────────────────

  let _govascoAbort = null;   // AbortController while a doc is generating

  function _openGovascoModal() {
    // Guard early so the user isn't presented options for an empty export.
    const n = _visibleIds().length;
    if (!n) { alert('No hay referencias visibles.'); return; }
    const countEl = _el('pv-govasco-count');
    if (countEl) {
      const big = n > _GOVASCO_BIG;
      countEl.innerHTML =
        `Se generará el documento para <strong>${n.toLocaleString()}</strong> ` +
        `artículo${n === 1 ? '' : 's'} (los visibles con el filtro actual).` +
        (big ? ` <span style="color:#b45309;">⚠ Son muchos: puede tardar bastante. ` +
               `Filtra o selecciona antes para reducir la lista.</span>` : '');
    }
    const m = _el('pv-govasco-modal');
    if (m) m.style.display = 'flex';
  }

  function _closeGovascoModal() {
    // Closing mid-generation cancels the in-flight request.
    if (_govascoAbort) _govascoAbort.abort();
    const m = _el('pv-govasco-modal');
    if (m) m.style.display = 'none';
  }

  const _GOVASCO_BIG = 300;   // above this we ask for confirmation

  async function _doExportGovasco() {
    // A second click while generating cancels the run.
    if (_govascoAbort) { _govascoAbort.abort(); return; }

    const ids = _visibleIds();
    if (!ids.length) { alert('No hay referencias visibles.'); return; }

    // Guard against an accidental massive export (e.g. no filter → thousands).
    if (ids.length > _GOVASCO_BIG &&
        !confirm(`Vas a generar el documento del Gobierno Vasco para ` +
                 `${ids.length.toLocaleString()} artículos.\n\n` +
                 `Puede tardar bastante (cada artículo consulta los indicadores ` +
                 `de SCImago) y no siempre es lo que quieres. ¿Continuar?\n\n` +
                 `Consejo: filtra o selecciona antes para acotar la lista.`)) {
      return;
    }

    const genBtn = _el('pv-govasco-generate');
    const esToggle = _el('pv-er-govasco-es');
    const colorToggle = _el('pv-er-govasco-color');
    const boldToggle  = _el('pv-er-govasco-bold');
    const config = {
      format:         'govasco',
      marked_author:  _markedInput.value.trim(),
      lang:           (esToggle && esToggle.checked) ? 'es' : 'en',
      emphasis_color: !!(colorToggle && colorToggle.checked),
      emphasis_bold:  !!(boldToggle && boldToggle.checked),
    };
    _govascoAbort = new AbortController();
    if (genBtn) {
      // Stays enabled: clicking it again cancels the generation.
      genBtn.dataset.orig = genBtn.innerHTML;
      genBtn.dataset.bg   = genBtn.style.background;
      genBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generando… (clic para cancelar)';
      genBtn.style.background = '#b91c1c';
    }
    try {
      const res = await fetch('/prionvault/api/articles/export-refs-docx', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ article_ids: ids, config }),
        signal:  _govascoAbort.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        alert('Error al exportar: ' + (err.error || res.statusText));
        return;
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      const ts   = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      a.href     = url;
      a.download = `Referencias_GobiernoVasco_${ts}.docx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      _closeGovascoModal();
      _close();
    } catch (e) {
      if (e.name !== 'AbortError') alert('Error de red: ' + e.message);
    } finally {
      _govascoAbort = null;
      if (genBtn) {
        genBtn.disabled  = false;
        genBtn.innerHTML = genBtn.dataset.orig || '<i class="fas fa-download"></i> Generar documento';
        genBtn.style.background = genBtn.dataset.bg || '';
      }
    }
  }

  // ── Save preset flow ──────────────────────────────────────────────────

  function _promptSavePreset() {
    const name = prompt('Nombre para este ajuste:', '');
    if (name === null || !name.trim()) return;
    _config.marked_author = _markedInput.value.trim();
    _config.show_labels   = _showLabels.checked;
    _config.show_type     = _showType.checked;
    _saveCurrentAsPreset(name.trim());
  }

  // ── Global details chevron ────────────────────────────────────────────

  function _initGlobalChev() {
    const det  = _el('pv-er-global-details');
    const chev = _el('pv-er-global-chev');
    if (!det || !chev) return;
    det.addEventListener('toggle', () => {
      chev.style.transform = det.open ? 'rotate(90deg)' : '';
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    _modal        = _el('pv-export-refs-modal');
    _blocksEl     = _el('pv-er-blocks');
    _optionsBody  = _el('pv-er-options-body');
    _optionsEmpty = _el('pv-er-options-empty');
    _exportBtn    = _el('pv-er-export');
    _markedInput  = _el('pv-er-marked-author');
    _showLabels   = _el('pv-er-show-labels');
    _showType     = _el('pv-er-show-type');
    _countEl      = _el('pv-export-refs-count');

    if (!_modal) return;

    _el('btn-export-refs')        ?.addEventListener('click', openExportRefs);
    _el('pv-export-refs-close')   ?.addEventListener('click', _close);
    _el('pv-er-cancel')           ?.addEventListener('click', _close);
    _el('pv-export-refs-backdrop')?.addEventListener('click', _close);
    _exportBtn                    ?.addEventListener('click', _doExport);
    _el('pv-er-export-govasco')   ?.addEventListener('click', _openGovascoModal);
    _el('pv-govasco-close')       ?.addEventListener('click', _closeGovascoModal);
    _el('pv-govasco-cancel')      ?.addEventListener('click', _closeGovascoModal);
    _el('pv-govasco-modal')?.querySelector('.pv-modal-backdrop')
                                  ?.addEventListener('click', _closeGovascoModal);
    _el('pv-govasco-generate')    ?.addEventListener('click', _doExportGovasco);
    _el('pv-er-save-preset')      ?.addEventListener('click', _promptSavePreset);
    _initGlobalChev();
  });

  // ── Notifications / Email Digest Modal ────────────────────────────────────
  async function _notifApi(path, opts = {}) {
    const r = await fetch('/prionvault/api' + path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (!r.ok) { const t = await r.text(); throw new Error(t || r.statusText); }
    return r.json();
  }

  // ── Timezones cache ───────────────────────────────────────────────────────
  let _tzOptions = null;
  async function _loadTzOptions() {
    if (_tzOptions) return _tzOptions;
    try {
      _tzOptions = await _notifApi('/notifications/timezones');
    } catch (_) {
      _tzOptions = ['UTC','Europe/Madrid','Europe/London','America/New_York','Asia/Tokyo'];
    }
    return _tzOptions;
  }

  document.addEventListener('DOMContentLoaded', function initNotificationsModal() {
    const modal    = document.getElementById('pv-notifications-modal');
    const openBtn  = document.getElementById('btn-notifications');
    if (!modal || !openBtn) return;

    const closeBtn  = document.getElementById('pv-notif-close');
    const addBtn    = document.getElementById('pv-notif-add');
    const tableWrap = document.getElementById('pv-notif-table-wrap');
    const statusEl  = document.getElementById('pv-notif-status');
    const backdrop  = modal.querySelector('.pv-modal-backdrop');

    const TOPICS = {
      prion:      { label: 'Prion',             color: '#0F3460', bg: '#e0e7ff' },
      prion_like: { label: 'Prion-like',         color: '#7c3aed', bg: '#ede9fe' },
      aav:        { label: 'AAV / Gene therapy', color: '#065f46', bg: '#d1fae5' },
    };
    const FREQ_LABELS = { weekly: 'Semanal', biweekly: 'Quincenal', monthly: 'Mensual' };
    const DOW_LABELS  = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];

    function _showStatus(type, msg, autohide = true) {
      statusEl.innerHTML = msg;
      statusEl.style.display = 'block';
      const info = type === 'info';
      statusEl.style.background = info ? '#eff6ff' : type === 'ok' ? '#f0fdf4' : '#fef2f2';
      statusEl.style.color      = info ? '#1d4ed8' : type === 'ok' ? '#15803d' : '#b91c1c';
      statusEl.style.border     = `1px solid ${info ? '#bfdbfe' : type === 'ok' ? '#bbf7d0' : '#fecaca'}`;
      if (autohide && !info) setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
    }

    function _editFormHtml(sub, tzOptions) {
      const h = String(sub.send_hour  ?? 15).padStart(2,'0');
      const m = String(sub.send_minute ?? 0).padStart(2,'0');
      const tzOpts = tzOptions.map(z =>
        `<option value="${z}"${z === (sub.user_timezone||'UTC') ? ' selected' : ''}>${z.replace(/_/g,' ')}</option>`
      ).join('');
      const topicChips = Object.entries(TOPICS).map(([k, info]) => {
        const on = (sub.topics || ['prion']).includes(k);
        return `<label style="display:inline-flex;align-items:center;gap:5px;padding:4px 11px;
          border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;
          border:2px solid ${on ? info.color : '#d1d5db'};
          background:${on ? info.bg : '#fff'};color:${on ? info.color : '#9ca3af'};">
          <input type="checkbox" name="topic" value="${k}" ${on ? 'checked' : ''}
                 style="display:none;">
          ${info.label}
        </label>`;
      }).join('');
      const isPubmed = (sub.source || 'pubmed') === 'pubmed';
      return `
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;
                  padding:16px;margin-top:4px;display:flex;flex-direction:column;gap:14px;">
        <div style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end;">
          <div>
            <label style="font-size:11px;font-weight:600;color:#6b7280;display:block;margin-bottom:3px;">NOMBRE</label>
            <input name="name" value="${(sub.name||'Mi suscripción').replace(/"/g,'&quot;')}"
                   style="width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid #d1d5db;
                          border-radius:7px;font-size:13px;">
          </div>
          <div>
            <label style="font-size:11px;font-weight:600;color:#6b7280;display:block;margin-bottom:3px;">TIPO</label>
            <select name="source" style="padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;">
              <option value="pubmed" ${isPubmed ? 'selected' : ''}>📡 PubMed digest</option>
              <option value="flagged" ${!isPubmed ? 'selected' : ''}>⚑ PrionVault Picks</option>
            </select>
          </div>
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;color:#6b7280;display:block;margin-bottom:3px;">EMAIL</label>
          <input type="email" name="email" value="${(sub.email||'').replace(/"/g,'&quot;')}"
                 style="width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid #d1d5db;
                        border-radius:7px;font-size:13px;">
        </div>
        <div class="pv-pubmed-fields" style="display:${isPubmed ? 'flex' : 'none'};flex-direction:column;gap:12px;">
          <div>
            <label style="font-size:11px;font-weight:600;color:#6b7280;display:block;margin-bottom:5px;">TEMAS</label>
            <div style="display:flex;flex-wrap:wrap;gap:6px;">${topicChips}</div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <div>
              <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:3px;">Período de búsqueda</label>
              <select name="lookback_days" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;">
                <option value="7" ${(sub.lookback_days||7)==7?'selected':''}>7 días</option>
                <option value="14" ${sub.lookback_days==14?'selected':''}>14 días</option>
                <option value="30" ${sub.lookback_days==30?'selected':''}>30 días</option>
              </select>
            </div>
            <div style="display:flex;align-items:center;gap:8px;padding-top:18px;">
              <input type="checkbox" name="include_oa_only" ${sub.include_oa_only?'checked':''}
                     style="width:15px;height:15px;accent-color:#0F3460;">
              <label style="font-size:12.5px;color:#374151;cursor:pointer;">Solo Open Access</label>
            </div>
          </div>
        </div>
        <div class="pv-flagged-fields" style="display:${!isPubmed ? 'flex' : 'none'};flex-direction:column;gap:10px;">
          <div>
            <label style="font-size:11px;font-weight:600;color:#6b7280;display:block;margin-bottom:3px;">ARTÍCULOS POR EMAIL</label>
            <input type="number" name="articles_per_email" min="1" max="50"
                   value="${sub.articles_per_email || 5}"
                   style="width:80px;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;">
            <span style="font-size:12px;color:#6b7280;margin-left:6px;">artículos aleatorios por email</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <input type="checkbox" name="include_pdfs" ${sub.include_pdfs !== false ? 'checked' : ''}
                   style="width:15px;height:15px;accent-color:#0F3460;">
            <label style="font-size:12.5px;color:#374151;cursor:pointer;">Adjuntar PDFs al email</label>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <input type="checkbox" name="include_ai_summary" ${sub.include_ai_summary !== false ? 'checked' : ''}
                   style="width:15px;height:15px;accent-color:#0F3460;">
            <label style="font-size:12.5px;color:#374151;cursor:pointer;">Enviar el resumen IA en el email
              <span style="color:#9ca3af;">(si el artículo lo tiene)</span></label>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div>
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:3px;">Frecuencia</label>
            <select name="frequency" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;">
              <option value="weekly"   ${(sub.frequency||'weekly')==='weekly'?'selected':''}>Semanal</option>
              <option value="biweekly" ${sub.frequency==='biweekly'?'selected':''}>Quincenal</option>
              <option value="monthly"  ${sub.frequency==='monthly'?'selected':''}>Mensual</option>
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:3px;">Hora</label>
            <input type="time" name="time" value="${h}:${m}"
                   style="width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;">
          </div>
        </div>
        <div>
          <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:5px;">Días</label>
          <div style="display:flex;gap:5px;flex-wrap:wrap;">
            ${DOW_LABELS.map((d,i)=>{
              const activeDays = Array.isArray(sub.days_of_week) ? sub.days_of_week
                : [sub.day_of_week ?? 4];
              const chk = activeDays.includes(i) ? 'checked' : '';
              return `<label style="display:flex;align-items:center;gap:3px;padding:5px 9px;border:1px solid #d1d5db;border-radius:20px;font-size:12px;cursor:pointer;user-select:none;">
                <input type="checkbox" name="days_of_week" value="${i}" ${chk} style="accent-color:#0F3460;">${d}
              </label>`;
            }).join('')}
          </div>
        </div>
        <div>
          <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:3px;">Zona horaria</label>
          <select name="user_timezone" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;">${tzOpts}</select>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px;">
          <button type="button" class="pv-notif-save-btn"
                  style="padding:7px 18px;border-radius:7px;border:none;background:#0F3460;
                         color:#fff;font-size:13px;font-weight:700;cursor:pointer;">
            <i class="fas fa-save" style="margin-right:5px;"></i>Guardar
          </button>
          <button type="button" class="pv-notif-test-btn"
                  style="padding:7px 14px;border-radius:7px;border:1px solid #d1d5db;
                         background:#f9fafb;color:#374151;font-size:13px;cursor:pointer;">
            <i class="fas fa-paper-plane"></i> Prueba
          </button>
          <button type="button" class="pv-notif-preview-btn"
                  style="padding:7px 14px;border-radius:7px;border:1px solid #d1d5db;
                         background:#f9fafb;color:#374151;font-size:13px;cursor:pointer;"
                  title="Ver qué artículos se enviarían sin mandar el email">
            <i class="fas fa-search"></i> Diagnóstico
          </button>
          <button type="button" class="pv-notif-cancel-edit-btn"
                  style="margin-left:auto;padding:7px 14px;border-radius:7px;border:1px solid #d1d5db;
                         background:#fff;color:#374151;font-size:13px;cursor:pointer;">
            Cancelar
          </button>
        </div>
      </div>`;
    }

    function _readForm(formEl) {
      const _val = (sel, def = '') => (formEl.querySelector(sel) || { value: def }).value;
      const _chk = (sel, def = false) => formEl.querySelector(sel) ? formEl.querySelector(sel).checked : def;
      const topics = [...formEl.querySelectorAll('input[name="topic"]:checked')].map(c => c.value);
      const [hh, mm] = (_val('[name="time"]', '15:00') || '15:00').split(':');
      return {
        name:               _val('[name="name"]') .trim() || 'Mi suscripción',
        source:             _val('[name="source"]'),
        email:              _val('[name="email"]').trim(),
        topics:             topics.length ? topics : ['prion'],
        frequency:          _val('[name="frequency"]', 'weekly'),
        days_of_week:       (d => d.length ? d : [4])(Array.from(formEl.querySelectorAll('[name="days_of_week"]:checked')).map(cb=>parseInt(cb.value))),
        send_hour:          parseInt(hh || 15),
        send_minute:        parseInt(mm || 0),
        user_timezone:      _val('[name="user_timezone"]', 'UTC'),
        lookback_days:      parseInt(_val('[name="lookback_days"]', '7')),
        include_oa_only:    _chk('[name="include_oa_only"]'),
        articles_per_email: parseInt(_val('[name="articles_per_email"]', '5') || 5),
        include_pdfs:       _chk('[name="include_pdfs"]', true),
        include_ai_summary: _chk('[name="include_ai_summary"]', true),
        enabled:            true,
      };
    }

    let _expandedId = null, _lastSubs = [], _lastTz = [];

    function _renderTable(subs, tzOptions) {
      if (!subs.length) {
        tableWrap.innerHTML = `<p style="text-align:center;color:#9ca3af;font-size:13px;padding:24px 0;">
          No tienes suscripciones. Crea una nueva abajo.</p>`;
        return;
      }
      const rows = subs.map(sub => {
        const srcChip = sub.source === 'flagged'
          ? `<span style="background:#fef3c7;color:#92400e;font-size:11px;font-weight:600;padding:2px 7px;border-radius:20px;">⚑ Picks</span>`
          : `<span style="background:#e0e7ff;color:#0F3460;font-size:11px;font-weight:600;padding:2px 7px;border-radius:20px;">📡 PubMed</span>`;
        const freqTxt = FREQ_LABELS[sub.frequency] || sub.frequency;
        const DOW_SHORT = ['L','M','X','J','V','S','D'];
        const activeDays = Array.isArray(sub.days_of_week) && sub.days_of_week.length
          ? sub.days_of_week : [sub.day_of_week ?? 4];
        const dow = activeDays.map(d => DOW_SHORT[d] ?? d).join(' ');
        const nextTxt = !sub.enabled
          ? '<span style="color:#92400e;font-weight:600;">⏸ Pausada</span>'
          : (sub.next_send_at
              ? new Date(sub.next_send_at).toLocaleDateString('es-ES',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})
              : '—');
        const dot = sub.enabled
          ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#16a34a;vertical-align:middle;margin-right:4px;"></span>`
          : `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#d1d5db;vertical-align:middle;margin-right:4px;"></span>`;
        const isOpen = _expandedId === sub.id;
        const editFormHtml = isOpen ? _editFormHtml(sub, tzOptions) : '';
        return `
        <tr data-sub-id="${sub.id}" style="border-bottom:1px solid #f3f4f6;">
          <td style="padding:10px 8px;font-size:13px;font-weight:600;color:#111827;max-width:160px;
                     white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${dot}${sub.name || 'Sin nombre'}
          </td>
          <td style="padding:10px 6px;">${srcChip}</td>
          <td style="padding:10px 6px;font-size:12px;color:#6b7280;">${freqTxt} · ${dow}</td>
          <td style="padding:10px 6px;font-size:12px;color:#6b7280;">${nextTxt}</td>
          <td style="padding:10px 6px;white-space:nowrap;">
            <button class="pv-toggle-btn" data-id="${sub.id}" data-enabled="${sub.enabled ? '1' : '0'}"
                    title="${sub.enabled ? 'Pausar estas notificaciones (indefinidamente)' : 'Reanudar estas notificaciones'}"
                    style="padding:4px 10px;border-radius:6px;border:1px solid ${sub.enabled ? '#fde68a' : '#bbf7d0'};
                           background:${sub.enabled ? '#fffbeb' : '#f0fdf4'};color:${sub.enabled ? '#92400e' : '#15803d'};
                           font-size:12px;cursor:pointer;margin-right:4px;">
              <i class="fas fa-${sub.enabled ? 'pause' : 'play'}"></i>
            </button>
            <button class="pv-edit-btn" data-id="${sub.id}"
                    style="padding:4px 10px;border-radius:6px;border:1px solid #d1d5db;
                           background:${isOpen ? '#e0e7ff' : '#fff'};font-size:12px;cursor:pointer;margin-right:4px;">
              <i class="fas fa-pen"></i>
            </button>
            <button class="pv-del-btn" data-id="${sub.id}"
                    style="padding:4px 10px;border-radius:6px;border:1px solid #fecaca;
                           background:#fff;font-size:12px;cursor:pointer;color:#b91c1c;">
              <i class="fas fa-trash"></i>
            </button>
          </td>
        </tr>
        ${isOpen ? `<tr data-edit-row="${sub.id}"><td colspan="5">${editFormHtml}</td></tr>` : ''}`;
      }).join('');

      tableWrap.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid #e5e7eb;">
              <th style="text-align:left;padding:6px 8px;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;">Nombre</th>
              <th style="text-align:left;padding:6px 6px;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;">Tipo</th>
              <th style="text-align:left;padding:6px 6px;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;">Frecuencia</th>
              <th style="text-align:left;padding:6px 6px;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;">Próximo envío</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;

      tableWrap.querySelectorAll('.pv-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          _expandedId = _expandedId === btn.dataset.id ? null : btn.dataset.id;
          _renderTable(_lastSubs, _lastTz);
        });
      });
      tableWrap.querySelectorAll('.pv-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => _toggleSub(btn.dataset.id, btn.dataset.enabled !== '1'));
      });
      tableWrap.querySelectorAll('.pv-del-btn').forEach(btn => {
        btn.addEventListener('click', () => _deleteSub(btn.dataset.id));
      });
      tableWrap.querySelectorAll('.pv-notif-save-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const editRow = btn.closest('[data-edit-row]');
          if (editRow) _saveEdit(editRow.dataset.editRow, btn.closest('div[style*="flex-direction:column"]'));
        });
      });
      tableWrap.querySelectorAll('.pv-notif-test-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const editRow = btn.closest('[data-edit-row]');
          if (editRow) _testSub(editRow.dataset.editRow, btn);
        });
      });
      tableWrap.querySelectorAll('.pv-notif-preview-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const editRow = btn.closest('[data-edit-row]');
          if (editRow) _previewSub(editRow.dataset.editRow, btn);
        });
      });
      tableWrap.querySelectorAll('.pv-notif-cancel-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => { _expandedId = null; _renderTable(_lastSubs, _lastTz); });
      });
      tableWrap.querySelectorAll('[name="source"]').forEach(sel => {
        sel.addEventListener('change', function() {
          const wrap = this.closest('div[style*="flex-direction:column"]');
          if (!wrap) return;
          const pf = wrap.querySelector('.pv-pubmed-fields');
          const ff = wrap.querySelector('.pv-flagged-fields');
          const isPubmed = this.value === 'pubmed';
          if (pf) pf.style.display = isPubmed ? 'flex' : 'none';
          if (ff) ff.style.display = isPubmed ? 'none' : 'block';
        });
      });
      tableWrap.querySelectorAll('input[name="topic"]').forEach(cb => {
        cb.addEventListener('change', () => {
          const lbl = cb.closest('label');
          const info = TOPICS[cb.value];
          if (!info || !lbl) return;
          const on = cb.checked;
          lbl.style.borderColor = on ? info.color : '#d1d5db';
          lbl.style.background  = on ? info.bg    : '#fff';
          lbl.style.color       = on ? info.color : '#9ca3af';
        });
      });
    }

    async function _saveEdit(subId, formEl) {
      if (!formEl) return;
      const data = _readForm(formEl);
      // Preserve the paused/active state across edits — the pause toggle owns
      // it, so editing other settings must not silently re-enable a paused sub.
      const _cur = (_lastSubs || []).find(s => String(s.id) === String(subId));
      if (_cur) data.enabled = _cur.enabled !== false;
      const saveBtn = formEl.querySelector('.pv-notif-save-btn');
      if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
      try {
        await _notifApi(`/notifications/subscriptions/${subId}`, { method: 'PUT', body: JSON.stringify(data) });
        _showStatus('ok', '✓ Guardado.');
        _expandedId = null;
        await _loadAll();
      } catch (e) {
        _showStatus('error', 'Error al guardar: ' + e.message);
        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-save" style="margin-right:5px;"></i>Guardar'; }
      }
    }

    async function _toggleSub(subId, enable) {
      try {
        await _notifApi(`/notifications/subscriptions/${subId}/enabled`,
                        { method: 'POST', body: JSON.stringify({ enabled: enable }) });
        _showStatus('ok', enable ? '✓ Notificaciones reanudadas.' : '⏸ Notificaciones pausadas.');
        await _loadAll();
      } catch (e) {
        _showStatus('error', 'Error al cambiar el estado: ' + e.message);
      }
    }

    async function _deleteSub(subId) {
      if (!confirm('¿Eliminar esta suscripción?')) return;
      try {
        await _notifApi(`/notifications/subscriptions/${subId}`, { method: 'DELETE' });
        _showStatus('ok', '✓ Eliminada.');
        if (_expandedId === subId) _expandedId = null;
        await _loadAll();
      } catch (e) {
        _showStatus('error', 'Error al eliminar: ' + e.message);
      }
    }

    async function _testSub(subId, btn) {
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
      try {
        const r = await _notifApi(`/notifications/subscriptions/${subId}/test`, { method: 'POST' });
        _showStatus('ok', '✓ ' + (r.detail || 'Email de prueba enviado.'));
      } catch (e) {
        _showStatus('error', 'Error: ' + e.message);
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Prueba'; }
      }
    }

    async function _previewSub(subId, btn) {
      const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Consultando…'; }

      // Remove any existing preview panel in the same edit row
      const editRow = btn?.closest('[data-edit-row]');
      editRow?.querySelector('.pv-notif-preview-panel')?.remove();

      try {
        const d = await _notifApi(`/notifications/subscriptions/${subId}/preview`);
        const panelEl = document.createElement('div');
        panelEl.className = 'pv-notif-preview-panel';
        panelEl.style.cssText = 'margin-top:12px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:14px;font-size:12.5px;';

        const fmtDate = iso => iso ? new Date(iso).toLocaleString('es-ES', {day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';

        let html = '';
        if (d.source === 'pubmed') {
          const topicLabels = { prion:'Prion', prion_like:'Prion-like', aav:'AAV / Gene therapy' };
          const topics = (d.topics || []).map(t => topicLabels[t] || t).join(', ');
          const oaWarn = d.oa_only && d.count === 0 && d.count_without_oa_filter > 0
            ? `<div style="margin-top:6px;padding:6px 10px;background:#fef3c7;border-radius:6px;color:#92400e;">
                ⚠ Hay <strong>${d.count_without_oa_filter}</strong> artículos si se desactiva el filtro "Solo OA". Están ocultos porque la suscripción tiene activado <em>Solo Open Access</em>.
               </div>` : '';

          html = `
            <div style="font-weight:700;color:#0369a1;margin-bottom:10px;">
              🔍 Diagnóstico del digest — simulación sin enviar email
            </div>
            <table style="border-collapse:collapse;width:100%;font-size:12px;">
              <tr><td style="color:#6b7280;padding:2px 8px 2px 0;white-space:nowrap;">Temas</td><td><strong>${esc(topics)}</strong></td></tr>
              <tr><td style="color:#6b7280;padding:2px 8px 2px 0;">Período</td><td>${fmtDate(d.since)} → ${fmtDate(d.now)}</td></tr>
              <tr><td style="color:#6b7280;padding:2px 8px 2px 0;">Solo OA</td><td>${d.oa_only ? '✓ Sí' : 'No'}</td></tr>
              <tr><td style="color:#6b7280;padding:2px 8px 2px 0;">Último envío</td><td>${fmtDate(d.last_sent_at)}</td></tr>
              <tr><td style="color:#6b7280;padding:2px 8px 2px 0;">Próximo envío</td><td>${fmtDate(d.next_send_at)}</td></tr>
            </table>
            <div style="margin-top:10px;padding:8px 12px;border-radius:6px;font-weight:700;
                        background:${d.count > 0 ? '#dcfce7' : '#fef2f2'};
                        color:${d.count > 0 ? '#15803d' : '#b91c1c'};">
              ${d.count > 0
                ? `✓ Se enviarían <strong>${d.count} artículo${d.count !== 1 ? 's' : ''}</strong>`
                : '✗ No hay artículos nuevos para este período con los filtros actuales'}
            </div>
            ${oaWarn}`;

          if (d.articles && d.articles.length > 0) {
            html += `<div style="margin-top:10px;"><div style="font-weight:600;color:#374151;margin-bottom:6px;">Artículos (hasta 20):</div>`;
            d.articles.forEach((a, i) => {
              const topic = topicLabels[a.topic] || a.topic || '';
              html += `<div style="padding:6px 0;border-bottom:1px solid #e0f2fe;display:flex;gap:8px;align-items:baseline;">
                <span style="min-width:20px;color:#94a3b8;font-size:11px;">${i+1}.</span>
                <span>
                  <span style="font-weight:600;color:#1e293b;">${esc(a.title || '—')}</span>
                  <span style="color:#64748b;"> · ${a.year || '—'} · ${esc(a.journal || '—')}</span>
                  ${a.doi ? `<a href="https://doi.org/${esc(a.doi)}" target="_blank" style="color:#0F3460;margin-left:6px;">DOI ↗</a>` : ''}
                  ${a.oa ? '<span style="margin-left:6px;font-size:10px;background:#d1fae5;color:#065f46;padding:1px 5px;border-radius:10px;">OA</span>' : ''}
                  ${topic ? `<span style="margin-left:4px;font-size:10px;background:#eff6ff;color:#1e40af;padding:1px 5px;border-radius:10px;">${esc(topic)}</span>` : ''}
                </span>
              </div>`;
            });
            html += '</div>';
          }
        } else {
          // flagged / Picks
          html = `
            <div style="font-weight:700;color:#0369a1;margin-bottom:10px;">
              🔍 Diagnóstico PrionVault Picks — simulación sin enviar email
            </div>
            <div style="padding:8px 12px;border-radius:6px;font-weight:700;
                        background:${d.count > 0 ? '#dcfce7' : '#fef2f2'};
                        color:${d.count > 0 ? '#15803d' : '#b91c1c'};">
              ${d.count > 0
                ? `✓ <strong>${d.count} artículo${d.count !== 1 ? 's' : ''}</strong> marcado${d.count !== 1 ? 's' : ''} se enviarían`
                : '✗ No hay artículos marcados con ⚑ en la biblioteca'}
            </div>`;
          if (d.articles && d.articles.length > 0) {
            html += `<div style="margin-top:10px;"><div style="font-weight:600;color:#374151;margin-bottom:6px;">Artículos seleccionados:</div>`;
            d.articles.forEach((a, i) => {
              html += `<div style="padding:6px 0;border-bottom:1px solid #e0f2fe;display:flex;gap:8px;align-items:baseline;">
                <span style="min-width:20px;color:#94a3b8;font-size:11px;">${i+1}.</span>
                <span>
                  <span style="font-weight:600;color:#1e293b;">${esc(a.title || '—')}</span>
                  <span style="color:#64748b;"> · ${a.year || '—'}</span>
                  ${a.has_pdf ? '<span style="margin-left:6px;font-size:10px;background:#d1fae5;color:#065f46;padding:1px 5px;border-radius:10px;">PDF</span>' : ''}
                </span>
              </div>`;
            });
            html += '</div>';
          }
        }

        html += `<div style="margin-top:10px;text-align:right;">
          <button type="button" onclick="this.closest('.pv-notif-preview-panel').remove()"
                  style="font-size:11px;color:#6b7280;background:none;border:none;cursor:pointer;">✕ Cerrar</button>
        </div>`;

        panelEl.innerHTML = html;
        const formWrap = btn?.closest('div[style*="flex-direction:column"]');
        if (formWrap) formWrap.appendChild(panelEl);

      } catch (e) {
        _showStatus('error', 'Error en diagnóstico: ' + e.message);
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-search"></i> Diagnóstico'; }
      }
    }

    async function _loadAll() {
      _showStatus('info', '<i class="fas fa-spinner fa-spin" style="margin-right:6px;"></i>Cargando…', false);
      addBtn.disabled = true;
      try {
        const [subs, tzOptions] = await Promise.all([
          _notifApi('/notifications/subscriptions'),
          _loadTzOptions(),
        ]);
        _lastSubs = subs; _lastTz = tzOptions;
        statusEl.style.display = 'none';
        _renderTable(subs, tzOptions);
      } catch (e) {
        _showStatus('error', 'Error al cargar: ' + e.message);
      } finally {
        addBtn.disabled = false;
      }
    }

    function _open()  { modal.style.display = 'flex'; _expandedId = null; _loadAll(); }
    function _close() { modal.style.display = 'none'; statusEl.style.display = 'none'; }
    openBtn.addEventListener('click', _open);
    closeBtn.addEventListener('click', _close);
    backdrop.addEventListener('click', _close);
    addBtn.addEventListener('click', async () => {
      const defaults = {
        name: 'Nueva suscripción', source: 'pubmed', email: '', topics: ['prion'],
        frequency: 'weekly', days_of_week: [4], send_hour: 15, send_minute: 0,
        user_timezone: 'UTC', lookback_days: 7, include_oa_only: false,
        articles_per_email: 5, enabled: true,
      };
      try {
        const r = await _notifApi('/notifications/subscriptions', { method: 'POST', body: JSON.stringify(defaults) });
        _expandedId = r.id;
        await _loadAll();
      } catch (e) {
        _showStatus('error', 'Error al crear: ' + e.message);
      }
    });
  });


  // ── Help modal ────────────────────────────────────────────────────────────
  window.openPrionVaultHelp = function openPrionVaultHelp() {
    const modal = document.getElementById('pv-help-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    _helpRenderTab('novedades');

    // Wire tabs (only once)
    if (!modal.dataset.wired) {
      modal.dataset.wired = '1';
      modal.querySelectorAll('.pv-help-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          modal.querySelectorAll('.pv-help-tab').forEach(b => b.classList.remove('pv-help-tab-active'));
          btn.classList.add('pv-help-tab-active');
          _helpRenderTab(btn.dataset.tab);
        });
      });
    }
  };

  function _helpRenderTab(tab) {
    const body = document.getElementById('pv-help-body');
    if (!body) return;

    const NEW = '<span class="pv-help-new-badge">NUEVO</span>';
    const YES = '<span class="pv-help-yes">✓</span>';
    const NO  = '<span class="pv-help-no">—</span>';
    const PART= '<span class="pv-help-partial">parcial</span>';

    const html = {

      // ── Novedades ──────────────────────────────────────────────────────
      novedades: `
        <div class="pv-help-section">
          <h3>Últimas novedades en PrionVault</h3>

          <h4>🏛️ Exportación Gobierno Vasco + SCImago (SJR) ${NEW}</h4>
          <p>Desde el modal <strong>Exportar referencias</strong>, el botón <em>"Formato Gobierno Vasco"</em> genera el .docx con el formato exacto de la justificación (Authors / Title / Name of journal / Volume / páginas / Year / Quality indicators). Al pulsarlo se abre un pequeño diálogo con las opciones de las <strong>etiquetas</strong> de los campos:</p>
          <ul>
            <li><strong>Etiquetas en español</strong> (por defecto en inglés, como pide el Gobierno Vasco).</li>
            <li><strong>Etiquetas en azul</strong> y/o <strong>en negrita</strong>, para resaltar los prefijos «Autores:», «Título:»…</li>
          </ul>
          <p>Los indicadores de calidad (cuartil, decil, percentil, ISSN y país) se rellenan solos a partir de los rankings de <strong>SCImago (SJR)</strong>, que se cargan por años desde <strong>Miscelánea → SCImago (SJR)</strong>. Se elige siempre el mejor cuartil/decil y se muestra la categoría entre paréntesis. Nota: el resto de ajustes de formato del modal (orden de bloques, formato de autores/título, separadores…) <em>no</em> afectan al formato Gobierno Vasco, que es fijo.</p>

          <h4>📝 Revistas manuales por año ${NEW}</h4>
          <p>En el modal de SCImago puedes guardar a mano revistas que SCImago no cubre (o cuyos datos quieras fijar tú). Ahora cada entrada lleva un <strong>Año</strong>: déjalo vacío para que valga para «todos los años» o indica un año concreto. Las revistas guardadas tienen <strong>prioridad</strong> sobre SCImago —si hay entrada para el año del artículo se usan sus datos; si no, la de «todos los años» y, en su defecto, SCImago. La lista de años cargados es ahora desplegable (colapsada por defecto).</p>

          <h4>📖 Journal Club ${NEW}</h4>
          <p>Nueva marca personal de <strong>Journal Club</strong> (icono de libro, violeta), al mismo nivel que favorito/leído/hito: márcala en la ficha, fíltrala en el listado y aplícala en lote. Está disponible tanto en la barra de acciones masivas como en el modal de <em>Búsqueda en lote de DOIs / PMIDs</em>, donde además puedes marcar los resultados con banderita, hito, favorito y leído.</p>

          <h4>🗒️ Notas, chat con IA y compartir por email ${NEW}</h4>
          <p>Cada artículo admite <strong>notas de colores</strong> (hasta 5), un <strong>chat con IA</strong> (Claude → GPT → Gemini con reserva automática) que recibe el artículo vectorizado y su resumen como contexto, y un botón para <strong>enviarlo por email</strong> con previsualización, comentario de introducción, resumen opcional y el PDF adjunto.</p>

          <h4>🔔 Notificaciones por email ${NEW}</h4>
          <p>Configura digests automáticos que te llegan por correo con los artículos más relevantes. Accede desde <strong>Miscelánea → Notificaciones</strong> en el menú lateral. Puedes crear varias suscripciones con configuraciones diferentes.</p>
          <ul>
            <li><strong>PrionVault Picks:</strong> artículos que hayas marcado con bandera (🚩), enviados en el período elegido.</li>
            <li><strong>PubMed Digest:</strong> artículos nuevos en PubMed que coincidan con tus temas de interés.</li>
            <li><strong>Incluir PDFs adjuntos:</strong> si el artículo tiene PDF en Dropbox, se adjunta al email directamente.</li>
            <li>Configurable: frecuencia, horario, zona horaria, número de artículos y temas.</li>
          </ul>

          <h4>❤️ Salud de la biblioteca — Completitud de metadatos ${NEW}</h4>
          <p>El modal de <strong>Salud biblioteca</strong> ahora incluye un sub-panel de completitud de metadatos. Pulsa el botón <em>"🗂 Completitud de metadatos →"</em> para ver cuántos artículos tienen campos vacíos: título, autores, revista, año, abstract, DOI y PMID. Cada número es clickable y filtra el listado principal directamente.</p>

          <h4>👥 Roles de usuario ${NEW}</h4>
          <p>PrionVault ahora soporta dos roles diferenciados: <strong>Administrador</strong> y <strong>Lector</strong>. La pestaña <em>"Roles"</em> de esta ayuda detalla exactamente qué puede hacer cada uno.</p>

          <h4>✅ Selección y acciones masivas para lectores ${NEW}</h4>
          <p>Los lectores pueden ahora usar las checkboxes de la tabla para seleccionar varios artículos y aplicar acciones en lote: bandera, favorito, hito, leído/no leído, color y prioridad. Las acciones destructivas (eliminar, resumir con IA, gestión de tags) siguen siendo exclusivas del administrador.</p>

          <h4>🔍 Nuevos filtros de salud en el listado ${NEW}</h4>
          <p>Desde el modal de Salud biblioteca puedes filtrar el listado principal por artículos a los que les falta título, autores, revista, año, abstract, DOI o PMID. Útil para completar metadatos de forma sistemática.</p>

          <h4>🔐 Mejoras de seguridad</h4>
          <ul>
            <li>Límite de intentos de login (10/min, 50/hora) para proteger contra fuerza bruta.</li>
            <li>Cabeceras HTTP de seguridad: <code>X-Frame-Options</code>, <code>X-Content-Type-Options</code>, CSP, Referrer-Policy.</li>
            <li>Clave de sesión configurable vía <code>APP_SECRET_KEY</code> independiente de la contraseña de admin.</li>
            <li>Rate limiting en endpoints de búsqueda DOI/PMID.</li>
          </ul>
        </div>
      `,

      // ── Roles ─────────────────────────────────────────────────────────
      roles: `
        <div class="pv-help-section">
          <h3>Roles de usuario</h3>
          <p>PrionVault distingue dos roles. El rol se asigna al crear el usuario y determina qué funciones están disponibles en la interfaz.</p>
          <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px;">
            <div style="flex:1;min-width:220px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:14px 16px;">
              <div style="font-weight:700;font-size:14px;color:#0F3460;margin-bottom:6px;">
                <i class="fas fa-shield-halved" style="margin-right:6px;"></i>Administrador
              </div>
              <p style="margin:0;font-size:13px;color:#1e40af;">Acceso completo: puede añadir, editar y eliminar artículos, gestionar PDFs, lanzar procesos de IA y ver todas las herramientas del menú lateral.</p>
            </div>
            <div style="flex:1;min-width:220px;background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:14px 16px;">
              <div style="font-weight:700;font-size:14px;color:#065f46;margin-bottom:6px;">
                <i class="fas fa-user" style="margin-right:6px;"></i>Lector
              </div>
              <p style="margin:0;font-size:13px;color:#065f46;">Acceso de consulta: puede explorar la biblioteca, organizar su lectura personal, crear entradas de Journal Club y recibir notificaciones.</p>
            </div>
          </div>

          <h4>Tabla comparativa de capacidades</h4>
          <table class="pv-help-role-table">
            <thead>
              <tr>
                <th style="width:45%;">Función</th>
                <th style="width:27.5%;text-align:center;">
                  <span style="color:#0F3460;">⚙ Admin</span>
                </th>
                <th style="width:27.5%;text-align:center;">
                  <span style="color:#065f46;">👤 Lector</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr><td colspan="3" style="background:#f9fafb;font-weight:700;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;padding:6px 12px;">Exploración y búsqueda</td></tr>
              <tr><td>Ver listado de artículos</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Búsqueda de texto libre (IA semántica)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Filtros por año, autores, revista, tags, colección…</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Ver abstract, PDF y resumen IA</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Ver artículos similares</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Exportar referencias (Word)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Filtrar por asignación en PrionRead (👥)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>

              <tr><td colspan="3" style="background:#f9fafb;font-weight:700;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;padding:6px 12px;">Estado personal del artículo</td></tr>
              <tr><td>Marcar como favorito (♥)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Marcar como leído (✓)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Poner bandera (🚩)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Marcar como hito (★)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Asignar color y prioridad</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Valorar artículo (★ rating)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>

              <tr><td colspan="3" style="background:#f9fafb;font-weight:700;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;padding:6px 12px;">Selección masiva</td></tr>
              <tr><td>Usar checkboxes y barra de acciones</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Acciones masivas: bandera, favorito, leído, color, prioridad</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Acciones masivas: eliminar artículos</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Acciones masivas: generar resúmenes IA</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Acciones masivas: tags, PrionPack, colección</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>

              <tr><td colspan="3" style="background:#f9fafb;font-weight:700;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;padding:6px 12px;">Colecciones y tags</td></tr>
              <tr><td>Ver colecciones y tags existentes</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Filtrar por colección o tag</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Crear / editar / eliminar colecciones y tags</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>

              <tr><td colspan="3" style="background:#f9fafb;font-weight:700;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;padding:6px 12px;">Journal Club</td></tr>
              <tr><td>Ver presentaciones JC de todos</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Crear nuevas entradas JC</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Adjuntar archivos (PPTX, PDF…) a sus propias entradas</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Editar o eliminar entradas propias</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Editar o eliminar entradas de otros usuarios</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>

              <tr><td colspan="3" style="background:#f9fafb;font-weight:700;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;padding:6px 12px;">Notificaciones</td></tr>
              <tr><td>Configurar suscripciones de email propias</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Recibir PrionVault Picks (artículos con bandera)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>

              <tr><td colspan="3" style="background:#f9fafb;font-weight:700;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;padding:6px 12px;">Gestión de contenido (solo admin)</td></tr>
              <tr><td>Añadir artículos (DOI, PMID, PDF, búsqueda PubMed…)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Editar metadatos de artículos</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Eliminar artículos</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Subir y gestionar PDFs</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Abrir artículo en PrionRead admin ↗</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Búsqueda masiva por DOI / PMID</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Generar resúmenes IA, indexación vectorial</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Gestionar PrionPacks</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Ver Salud biblioteca (métricas del corpus)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Encontrar duplicados, verificar PDFs, Estado IA</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
            </tbody>
          </table>
        </div>
      `,

      // ── Búsqueda ──────────────────────────────────────────────────────
      busqueda: `
        <div class="pv-help-section">
          <h3>Búsqueda y filtros</h3>
          <h4>Barra de búsqueda</h4>
          <p>La barra de búsqueda superior admite tres modos según el botón activo a su izquierda:</p>
          <ul>
            <li><strong>🔤 Texto libre:</strong> búsqueda clásica por título, autores, abstract y notas. Rápida y sin coste.</li>
            <li><strong>🤖 IA semántica:</strong> formula tu pregunta en lenguaje natural y el sistema busca por significado usando embeddings vectoriales. Requiere que los artículos estén indexados.</li>
            <li><strong>🔍 Búsqueda bibliográfica:</strong> consulta PubMed y Scopus en tiempo real. Los resultados se pueden importar directamente a la biblioteca.</li>
          </ul>
          <h4>Filtros del panel lateral</h4>
          <p>Filtra por año, autores, revista, colección, tag, estado PDF, estado resumen IA, bandera, hito, favorito, leído, color, prioridad, Journal Club, PrionPack y asignación PrionRead. Los filtros se combinan (AND).</p>
          <h4>Búsqueda masiva por DOI / PMID <span class="pv-help-chip pv-help-chip-admin">Solo admin</span></h4>
          <p>Pega varios DOIs o PMIDs separados por comas o saltos de línea en el campo de la barra de herramientas para encontrar de golpe qué artículos ya están en la biblioteca y cuáles faltan.</p>
        </div>
      `,

      // ── Notificaciones ────────────────────────────────────────────────
      notificaciones: `
        <div class="pv-help-section">
          <h3>Notificaciones por email</h3>
          <p>Accede desde <strong>Miscelánea → 🔔 Notificaciones</strong>. Puedes crear y gestionar tantas suscripciones como quieras, cada una con su propia configuración.</p>

          <h4>Tipos de suscripción</h4>
          <ul>
            <li><strong>PrionVault Picks:</strong> recopila los artículos de tu biblioteca que tengan bandera 🚩 activa en el período seleccionado (semana, quincena, mes…) y los envía en un digest estructurado.</li>
            <li><strong>PubMed Digest:</strong> busca artículos nuevos en PubMed según los temas que configures y te los envía periódicamente.</li>
          </ul>

          <h4>Opciones de configuración</h4>
          <ul>
            <li><strong>Nombre:</strong> identifica la suscripción (aparece en el asunto del email).</li>
            <li><strong>Email destinatario:</strong> puede ser diferente al de tu cuenta.</li>
            <li><strong>Frecuencia:</strong> diaria, semanal, quincenal o mensual.</li>
            <li><strong>Días de la semana:</strong> en frecuencia semanal, elige qué día llega el email.</li>
            <li><strong>Hora de envío y zona horaria:</strong> el digest se genera y envía a la hora local que indiques.</li>
            <li><strong>Período de búsqueda:</strong> cuántos días atrás mira el sistema para recopilar artículos (1–90 días).</li>
            <li><strong>Artículos por email:</strong> límite máximo de artículos incluidos en cada envío.</li>
            <li><strong>Solo Open Access:</strong> para el digest de PubMed, filtra únicamente artículos con acceso libre.</li>
            <li><strong>Incluir PDFs adjuntos:</strong> si el artículo tiene PDF almacenado en Dropbox, lo adjunta al email. Activado por defecto. Puede desactivarse si prefieres emails más ligeros.</li>
          </ul>

          <h4>Activar / desactivar</h4>
          <p>Cada suscripción tiene un interruptor que la activa o pausa sin necesidad de eliminarla. Los digests solo se envían si hay artículos que cumplan los criterios; si no hay nada nuevo, el email no se manda.</p>
        </div>
      `,

      // ── Salud biblioteca ──────────────────────────────────────────────
      salud: `
        <div class="pv-help-section">
          <h3>Salud de la biblioteca <span class="pv-help-chip pv-help-chip-admin">Solo admin</span></h3>
          <p>Abre desde el botón <strong>❤️ Salud biblioteca</strong> en la parte inferior del menú lateral. Ofrece un diagnóstico completo del estado del corpus.</p>

          <h4>Panel principal — métricas globales</h4>
          <ul>
            <li><strong>Artículos totales, con PDF, sin PDF:</strong> cuántos artículos tiene la biblioteca y qué proporción tiene PDF asociado.</li>
            <li><strong>Extracción de texto:</strong> artículos cuyo PDF ha sido procesado para poder buscar dentro de él (OCR incluido para escaneados).</li>
            <li><strong>Resúmenes IA:</strong> artículos con resumen generado por IA vs. pendientes.</li>
            <li><strong>Indexación vectorial:</strong> artículos disponibles para búsqueda semántica.</li>
            <li><strong>Journal Club:</strong> artículos presentados en sesiones JC.</li>
            <li><strong>Con DOI / con PMID:</strong> cobertura de identificadores para enlazar con bases de datos externas.</li>
          </ul>
          <p>Cada número es un botón clickable: al pulsarlo se cierra el modal y el listado muestra exactamente esos artículos.</p>

          <h4>🗂 Completitud de metadatos ${NEW}</h4>
          <p>Pulsa el botón <em>"🗂 Completitud de metadatos →"</em> para ver un sub-panel con el recuento de artículos que tienen vacíos los campos más importantes:</p>
          <ul>
            <li>Título · Autores · Revista · Año · Abstract · DOI · PMID</li>
          </ul>
          <p>Al igual que las métricas principales, cada contador es clickable y filtra el listado para que puedas completar esos campos de forma sistemática usando el editor de metadatos.</p>
          <p>Vuelve al panel principal con el botón <em>"← Atrás"</em>.</p>
        </div>
      `,

      // ── Journal Club ──────────────────────────────────────────────────
      jc: `
        <div class="pv-help-section">
          <h3>Journal Club (JC)</h3>
          <p>El módulo de Journal Club permite registrar las sesiones en las que se presenta y discute un artículo, con historial de presentadores, fechas y materiales adjuntos.</p>

          <h4>Quién puede hacer qué</h4>
          <ul>
            <li><strong>Cualquier usuario (admin y lector)</strong> puede crear una nueva entrada JC para cualquier artículo de la biblioteca.</li>
            <li>El creador puede editar y eliminar sus propias entradas en cualquier momento.</li>
            <li>El administrador puede editar y eliminar las entradas de cualquier usuario.</li>
            <li>Todos pueden ver el historial completo de sesiones JC.</li>
          </ul>

          <h4>Archivos adjuntos</h4>
          <p>Puedes adjuntar uno o varios archivos a cada entrada JC (presentaciones PPTX, PDFs complementarios, notas…). Los archivos se almacenan en Dropbox y están disponibles para todos los usuarios. El creador de la entrada y el administrador pueden añadir o eliminar adjuntos.</p>

          <h4>Acceso</h4>
          <p>Las entradas JC aparecen en el panel lateral del artículo, en la sección <em>"Journal Club"</em>. También puedes filtrar el listado principal para ver solo artículos con presentaciones JC usando el filtro correspondiente en el menú lateral.</p>
        </div>
      `,
    };

    body.innerHTML = html[tab] || `<p style="color:#9ca3af;">Sección no encontrada.</p>`;
  }


})();
