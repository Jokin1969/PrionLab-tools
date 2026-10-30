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
  const IS_PV_USER_ADMIN = (document.querySelector('meta[name="pv-user-is-pv-admin"]')?.content || '') === '1';
  document.body.classList.toggle('pv-role-admin',  IS_ADMIN);
  document.body.classList.toggle('pv-role-reader', !IS_ADMIN);
  document.body.classList.toggle('pv-role-pvadmin', IS_PV_USER_ADMIN);
  // Whether this user is flagged is_jc_responsible — fetched async (it's
  // not in the session, only in users.csv) and re-renders the currently
  // open detail modal's JC section once known, so the "Convocar" button
  // shows up without needing a reload.
  let IS_JC_RESPONSIBLE = false;

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
    hasPdf: null,        // null = all, true = only with PDF (header icon filter)
    hasDoi: null,        // null = all, true = only with DOI (header icon filter)
    jcPresenter: '',     // substring filter on JC presenter name
    jcYear: null,        // year of JC presentation
    hasPp: null,         // null = all, true = en algún PrionPack, false = sin pack
    ppId: '',            // specific PrionPack id (e.g. "PRP-001") or ''
    hasGlossary: null,   // null = all, true = reviewed (has a glossary version recorded), false = not reviewed
    abstractStatus: '',  // '' | 'has' | 'pending' | 'unavailable'
    indexedStatus:  '',  // '' | 'yes' | 'no'
    searchFields:   [],  // [] = all fields; else subset of ['title','authors','abstract']
    qMode:          'and',  // 'and' | 'or' — how multiple bare words in `q` combine
    page: 1,
    // "Todos" (50000, effectively the whole catalogue) is back by request —
    // it's genuinely slow on a large library since the server still has to
    // fetch/serialize every row, so it's opt-in via the dropdown, never
    // the default.
    size: (() => { const n = parseInt(localStorage.getItem('pv-page-size') || '100', 10) || 100;
                   return n > 50000 ? 100 : n; })(),
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
    isolatedArticleId: null, // null = show all, else only show this article
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

  // Wire a "copy this text to clipboard" button: reads `data-title` (or
  // falls back to `getValue()` if given, for inputs), copies it, and
  // briefly swaps the icon for a checkmark as feedback. `stopProp: true`
  // (the default) is needed for buttons sitting inside a clickable row
  // so the click doesn't also trigger the row's own click handler.
  function _wireCopyBtn(btn, { getValue, stopProp = true } = {}) {
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      if (stopProp) e.stopPropagation();
      const text = getValue ? getValue() : (btn.dataset.title || '');
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        const icon = btn.querySelector('i');
        const prevClass = icon ? icon.className : null;
        if (icon) icon.className = 'fas fa-check';
        else btn.textContent = '✓';
        setTimeout(() => {
          if (icon && prevClass) icon.className = prevClass;
        }, 1200);
      });
    });
  }

  // ── AI summary diagnostics modal ──────────────────────────────────────
  // Renders the fallback trail captured by ai_summary.py's generate_summary()
  // (which provider answered, the full chain, and the per-attempt errors)
  // so admins can see WHY a call fell back from Claude to GPT/Gemini even
  // when nothing reached Sentry (e.g. a transient connection error that
  // succeeded on retry, or on the next provider in the chain).
  const _AI_DIAG_PROVIDER_LABEL = { anthropic: 'Claude', openai: 'GPT', gemini: 'Gemini' };

  function _aiDiagText(a, diag) {
    const lines = [];
    lines.push(`Artículo: ${a.title || a.id}`);
    lines.push(`Proveedor solicitado: ${_AI_DIAG_PROVIDER_LABEL[diag.requested_provider] || diag.requested_provider}`);
    lines.push(`Proveedor que respondió: ${_AI_DIAG_PROVIDER_LABEL[diag.used_provider] || diag.used_provider}`);
    lines.push(`¿Hubo fallback?: ${diag.fell_back ? 'Sí' : 'No'}`);
    lines.push(`Cadena intentada: ${(diag.chain || []).map(p => _AI_DIAG_PROVIDER_LABEL[p] || p).join(' → ')}`);
    lines.push(`Inicio: ${diag.started_at || '—'}`);
    lines.push(`Fin: ${diag.finished_at || '—'}`);
    if (diag.skipped && diag.skipped.length) {
      lines.push('');
      lines.push('Proveedores omitidos:');
      diag.skipped.forEach(s => lines.push(`  - ${_AI_DIAG_PROVIDER_LABEL[s.provider] || s.provider}: ${s.reason}`));
    }
    if (diag.attempts && diag.attempts.length) {
      lines.push('');
      lines.push('Intentos:');
      diag.attempts.forEach(at => {
        lines.push(`  - [${_AI_DIAG_PROVIDER_LABEL[at.provider] || at.provider}] intento ${at.attempt} `
          + `(${at.elapsed_ms} ms) → ${at.error_type}: ${at.error}`);
        if (at.cause) lines.push(`      causa raíz: ${at.cause}`);
      });
    } else {
      lines.push('');
      lines.push('Sin errores registrados — el proveedor solicitado respondió a la primera.');
    }
    return lines.join('\n');
  }

  function openAiDiagModal(a) {
    const diag = a.summary_ai_diagnostics;
    const modal = document.getElementById('pv-ai-diag-modal');
    const body = document.getElementById('pv-ai-diag-body');
    if (!modal || !body || !diag) return;

    const provLabel = p => _AI_DIAG_PROVIDER_LABEL[p] || p || '—';
    const chainHtml = (diag.chain || []).map((p, i) => {
      const isUsed = p === diag.used_provider;
      return `<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:5px;
                     font-size:11.5px;font-weight:600;
                     background:${isUsed ? '#dcfce7' : '#f3f4f6'};color:${isUsed ? '#15803d' : '#6b7280'};">
                ${esc(provLabel(p))}${isUsed ? ' ✓' : ''}
              </span>`
        + (i < diag.chain.length - 1 ? '<span style="color:#d1d5db;">→</span>' : '');
    }).join(' ');

    const attemptsHtml = (diag.attempts && diag.attempts.length)
      ? diag.attempts.map(at => `
          <div style="border:1px solid #fecaca;background:#fef2f2;border-radius:7px;padding:8px 10px;margin-bottom:6px;">
            <div style="font-weight:600;color:#991b1b;font-size:12px;">
              ${esc(provLabel(at.provider))} — intento ${esc(at.attempt)} (${esc(at.elapsed_ms)} ms)
            </div>
            <div style="color:#b91c1c;font-size:11.5px;margin-top:2px;">
              ${esc(at.error_type)}: ${esc(at.error)}
            </div>
            ${at.cause ? `<div style="color:#9ca3af;font-size:11px;margin-top:2px;">
              causa raíz: ${esc(at.cause)}
            </div>` : ''}
          </div>`).join('')
      : `<div style="color:#15803d;font-size:12px;">Sin errores registrados — el proveedor solicitado
           respondió a la primera, sin necesidad de reintentos ni fallback.</div>`;

    const skippedHtml = (diag.skipped && diag.skipped.length)
      ? `<div style="margin-top:10px;font-size:11.5px;color:#9ca3af;">
           Omitidos (sin API key configurada): ${diag.skipped.map(s => esc(provLabel(s.provider))).join(', ')}
         </div>`
      : '';

    body.innerHTML = `
      <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 10px;margin-bottom:10px;">
        <span style="color:#9ca3af;">Solicitado:</span><span>${esc(provLabel(diag.requested_provider))}</span>
        <span style="color:#9ca3af;">Respondió:</span>
        <span style="font-weight:600;color:${diag.fell_back ? '#b45309' : '#15803d'};">
          ${esc(provLabel(diag.used_provider))}${diag.fell_back ? ' (fallback)' : ''}
        </span>
        <span style="color:#9ca3af;">Inicio:</span><span>${esc(diag.started_at || '—')}</span>
        <span style="color:#9ca3af;">Fin:</span><span>${esc(diag.finished_at || '—')}</span>
      </div>
      <div style="margin-bottom:10px;">${chainHtml}</div>
      ${attemptsHtml}
      ${skippedHtml}
    `;

    modal.dataset.copyText = _aiDiagText(a, diag);
    modal.style.display = 'flex';
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('pv-ai-diag-close')?.addEventListener('click', () => {
      const m = document.getElementById('pv-ai-diag-modal');
      if (m) m.style.display = 'none';
    });
    document.querySelector('#pv-ai-diag-modal .pv-modal-backdrop')?.addEventListener('click', () => {
      const m = document.getElementById('pv-ai-diag-modal');
      if (m) m.style.display = 'none';
    });
    _wireCopyBtn(document.getElementById('pv-ai-diag-copy'), {
      getValue: () => document.getElementById('pv-ai-diag-modal')?.dataset.copyText || '',
      stopProp: false,
    });
  });

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

  // ── Accessibility pass ───────────────────────────────────────────────
  // Every modal is announced as a dialog labelled by its heading, close
  // buttons get a name, and icon-only buttons (emoji / <i> icons with a
  // tooltip) expose that tooltip as their accessible name — including the
  // ones rendered later (listing rows, detail modal), via an observer.
  function _labelIconButtons(root) {
    root.querySelectorAll('button[title]:not([aria-label])').forEach(b => {
      const txt = (b.textContent || '').replace(/[\s\u200d\ufe0f]/g, '');
      // No real words → the visible content is just an icon/emoji.
      if (!/[A-Za-zÀ-ÿ0-9]{2,}/.test(txt)) b.setAttribute('aria-label', b.title);
    });
  }
  function _wireA11y() {
    document.querySelectorAll('.pv-modal').forEach((m, i) => {
      m.setAttribute('role', 'dialog');
      m.setAttribute('aria-modal', 'true');
      const h = m.querySelector('h2, h3');
      if (h && !m.hasAttribute('aria-labelledby')) {
        if (!h.id) h.id = `pv-modal-title-${i}`;
        m.setAttribute('aria-labelledby', h.id);
      }
      m.querySelectorAll('.pv-modal-close:not([aria-label])')
        .forEach(b => b.setAttribute('aria-label', 'Cerrar'));
    });
    _labelIconButtons(document);
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; _labelIconButtons(document); });
    }).observe(document.body, { childList: true, subtree: true });
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
      set('count-outdated-summary', s.outdated_summary ?? 0);
      const badge = document.getElementById('pv-notes-filter-badge');
      if (badge) {
        const n = s.with_notes ?? 0;
        badge.textContent = String(n);
        badge.style.display = n > 0 ? '' : 'none';
      }
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
    renderCollectionTree();
  }

  // Pure re-render from already-fetched _allCollections/_collRollup — no
  // network round trip. Folding/unfolding a group or subgroup chevron
  // used to call refreshCollections() (a full re-fetch, including
  // /collections/rollup's per-collection DB queries on the backend),
  // which made every expand/collapse click visibly slow for no reason:
  // toggling a fold is a pure UI state change, the data hasn't gone
  // stale. Callers that DID change the underlying data (create/delete/
  // edit a collection) still go through refreshCollections().
  function renderCollectionTree() {
    const container = document.getElementById('collection-list');
    if (!container) return;
    const items = _allCollections;
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
    // Chip shows the plain SUM of article_count across every leaf
    // collection under this group — what the user actually reads it
    // as ("what I'd get by adding up the numbers below"). Note this can
    // exceed the deduplicated unique-article count (kept in the
    // tooltip) if the same paper is filed in more than one collection.
    const colls = Object.values(subBranch).flat();
    const collCount = colls.length;
    const r = (_collRollup.groups || {})[group] || {};
    const subgroupCount  = r.subgroup_count  ?? Object.keys(subBranch).filter(k => k).length;
    const rawTotal        = colls.reduce((acc, c) => acc + (c.article_count || 0), 0);
    const uniqueArticles = r.unique_articles ?? rawTotal;
    const chipNumber = rawTotal;   // headline number
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
        <span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(group)}</span>
      </span>
      <span style="font-size:10px;background:rgba(255,255,255,0.14);padding:1px 7px;border-radius:20px;flex-shrink:0;">${chipNumber}</span>
      ${IS_ADMIN ? `<span class="pv-coll-rename"
            data-group="${esc(group)}"
            title="Renombrar este grupo"
            style="display:inline-flex;align-items:center;justify-content:center;
                   width:18px;height:18px;border-radius:4px;flex-shrink:0;margin-left:2px;
                   color:rgba(255,255,255,0.35);cursor:pointer;visibility:hidden;"
            onmouseover="this.style.background='rgba(255,255,255,0.18)';this.style.color='white';"
            onmouseout="this.style.background='transparent';this.style.color='rgba(255,255,255,0.35)';"
      ><i class="fas fa-pen" style="font-size:9px;"></i></span>` : ''}
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
    // Reveal the ✏/× on hover of the row.
    if (IS_ADMIN) {
      btn.addEventListener('mouseenter', () => {
        const pen = btn.querySelector('.pv-coll-rename');
        if (pen) pen.style.visibility = 'visible';
        const x = btn.querySelector('.pv-coll-del');
        if (x) x.style.visibility = 'visible';
      });
      btn.addEventListener('mouseleave', () => {
        const pen = btn.querySelector('.pv-coll-rename');
        if (pen) pen.style.visibility = 'hidden';
        const x = btn.querySelector('.pv-coll-del');
        if (x) x.style.visibility = 'hidden';
      });
    }
    btn.addEventListener('click', (ev) => {
      // Chevron toggles collapse state without changing the filter.
      if (ev.target.closest('.pv-coll-chevron')) {
        ev.preventDefault();
        _toggleCollapsed(_COLL_GROUPS_KEY, group);
        renderCollectionTree();
        return;
      }
      // ✏ renames the whole group (admin only).
      if (ev.target.closest('.pv-coll-rename')) {
        ev.preventDefault();
        ev.stopPropagation();
        _renameCollectionGroup({ group, subgroup: null });
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
      '• Los artículos NO se borran — solo se desvincula la pertenencia.\n' +
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

  // Admin: rename a group (or one subgroup within it) in one shot —
  // updates every collection under it, wired to the ✏ that shows on
  // hover next to group / subgroup headers.
  async function _renameCollectionGroup({ group, subgroup }) {
    if (!group) return;
    const current = subgroup || group;
    const label = subgroup ? 'el subgrupo' : 'el grupo';
    const name = prompt(`Nuevo nombre para ${label} «${current}»:`, current);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === current) return;
    try {
      const r = await api('/admin/collections/group', {
        method: 'PATCH',
        body: JSON.stringify({ group, subgroup: subgroup || undefined, new_name: trimmed }),
      });
      await refreshCollections();
      if (state.collectionGroup === group &&
          (subgroup ? state.collectionSubgroup === subgroup : true)) {
        state.collectionGroup    = subgroup ? group : trimmed;
        state.collectionSubgroup = subgroup ? trimmed : state.collectionSubgroup;
        refreshFilterIndicators();
      }
      console.log(`Renombradas ${r.updated} colección(es) de ${label} «${current}» a «${trimmed}».`);
    } catch (e) {
      alert('Error al renombrar: ' + e.message);
    }
  }

  function buildSubgroupHeader(group, subgroup, colls, collapsed) {
    // Chip shows the plain SUM of article_count across every leaf
    // collection under (group, subgroup) — the deduplicated unique-
    // article count (which can be lower if the same paper sits in two
    // child folders) is kept in the tooltip instead.
    const collCount     = colls.length;
    const rg = (_collRollup.groups || {})[group] || {};
    const rs = (rg.subgroups || {})[subgroup] || {};
    const uniqueArticles = (rs.unique_articles ?? null);
    const rawTotal       = colls.reduce((acc, c) => acc + (c.article_count || 0), 0);
    const chipNumber     = rawTotal;
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
        <span style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(subgroup)}</span>
      </span>
      <span style="font-size:10px;background:rgba(255,255,255,0.14);padding:1px 7px;border-radius:20px;flex-shrink:0;">${chipNumber}</span>
      ${IS_ADMIN ? `<span class="pv-coll-rename"
            data-group="${esc(group)}" data-subgroup="${esc(subgroup)}"
            title="Renombrar este subgrupo"
            style="display:inline-flex;align-items:center;justify-content:center;
                   width:16px;height:16px;border-radius:4px;flex-shrink:0;margin-left:2px;
                   color:rgba(255,255,255,0.3);cursor:pointer;visibility:hidden;"
            onmouseover="this.style.background='rgba(255,255,255,0.18)';this.style.color='white';"
            onmouseout="this.style.background='transparent';this.style.color='rgba(255,255,255,0.3)';"
      ><i class="fas fa-pen" style="font-size:8px;"></i></span>` : ''}
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
        const pen = btn.querySelector('.pv-coll-rename');
        if (pen) pen.style.visibility = 'visible';
        const x = btn.querySelector('.pv-coll-del');
        if (x) x.style.visibility = 'visible';
      });
      btn.addEventListener('mouseleave', () => {
        const pen = btn.querySelector('.pv-coll-rename');
        if (pen) pen.style.visibility = 'hidden';
        const x = btn.querySelector('.pv-coll-del');
        if (x) x.style.visibility = 'hidden';
      });
    }
    btn.addEventListener('click', (ev) => {
      if (ev.target.closest('.pv-coll-chevron')) {
        ev.preventDefault();
        _toggleCollapsed(_COLL_SUBGROUPS_KEY, `${group}::${subgroup}`);
        renderCollectionTree();
        return;
      }
      if (ev.target.closest('.pv-coll-rename')) {
        ev.preventDefault();
        ev.stopPropagation();
        _renameCollectionGroup({ group, subgroup });
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
    btn.className = 'pv-nav-btn pv-coll-row';
    btn.dataset.collectionId = c.id;
    if (indented) btn.style.paddingLeft = '34px';
    const kindIcon = c.kind === 'smart'
      ? '<i class="fas fa-bolt" style="font-size:10px;opacity:0.5;"></i>'
      : '<i class="fas fa-folder" style="font-size:10px;opacity:0.5;"></i>';
    btn.title = (c.description ? c.description + '\n\n' : '') +
                (IS_ADMIN
                  ? '• Click: filtrar la lista\n' +
                    '• Botón ✏ a la derecha: editar\n' +
                    '• Botón 🗑 a la derecha (o click derecho): eliminar'
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
        miniBtn('pv-coll-delete',    'fa-trash',
                'Eliminar esta colección (los artículos no se borran)')
      : '';
    btn.innerHTML = `
      <span style="display:inline-flex;align-items:center;gap:7px;min-width:0;overflow:hidden;flex:1;">
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
    function deleteThisCollection() {
      if (!confirm(`Borrar la colección "${c.name}"? (los artículos NO se borran)`)) return;
      api(`/collections/${c.id}`, { method: 'DELETE' })
        .then(() => { if (state.collectionId === c.id) state.collectionId = null;
                      refreshCollections(); loadArticles(); })
        .catch(e => alert('Error: ' + e.message));
    }
    btn.addEventListener('contextmenu', ev => {
      if (!IS_ADMIN) return;
      ev.preventDefault();
      deleteThisCollection();
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

      const deleteBadge = btn.querySelector('.pv-coll-delete');
      if (deleteBadge) deleteBadge.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        deleteThisCollection();
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
  let _collectionEditorOpts = {};  // { onSaved(collection) } — set per-open, e.g. by the BibTeX wizard's "Nueva colección" so it can add its selection to the freshly created collection
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

    function close() { modal.style.display = 'none'; _collectionEditing = null; _collectionEditorOpts = {}; }
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
        grab('pv-r-source',       'source');
        const fl = g('pv-r-is-flagged').value;
        if (fl !== '')   rules.is_flagged   = fl === '1';
        const mi = g('pv-r-is-milestone').value;
        if (mi !== '')   rules.is_milestone = mi === '1';
        const hp = g('pv-r-has-pdf').value;
        if (hp !== '')   rules.has_pdf  = hp === '1';
        const hd = g('pv-r-has-doi').value;
        if (hd !== '')   rules.has_doi  = hd === '1';
        const hpm = g('pv-r-has-pmid').value;
        if (hpm !== '')  rules.has_pmid = hpm === '1';
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
        let saved;
        if (_collectionEditing) {
          saved = await api(`/collections/${_collectionEditing}`, { method: 'PATCH', body });
        } else {
          saved = await api('/collections', { method: 'POST', body });
        }
        const onSaved = _collectionEditorOpts.onSaved;
        close();
        await refreshCollections();
        if (onSaved) onSaved(saved);
      } catch (e) {
        errBox.style.display = 'block';
        errBox.textContent = 'Error: ' + e.message;
        saveBtn.disabled = false;
        saveBtn.textContent = original;
      }
    });
  }

  function openCollectionEditor(existing, opts) {
    const modal = document.getElementById('pv-collection-modal');
    if (!modal) return;
    _collectionEditing = existing ? existing.id : null;
    _collectionEditorOpts = opts || {};

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
    document.getElementById('pv-r-source').value = rules.source || '';
    document.getElementById('pv-r-is-flagged').value =
      rules.is_flagged === true ? '1' : (rules.is_flagged === false ? '0' : '');
    document.getElementById('pv-r-is-milestone').value =
      rules.is_milestone === true ? '1' : (rules.is_milestone === false ? '0' : '');
    document.getElementById('pv-r-has-pdf').value =
      rules.has_pdf === true ? '1' : (rules.has_pdf === false ? '0' : '');
    document.getElementById('pv-r-has-doi').value =
      rules.has_doi === true ? '1' : (rules.has_doi === false ? '0' : '');
    document.getElementById('pv-r-has-pmid').value =
      rules.has_pmid === true ? '1' : (rules.has_pmid === false ? '0' : '');

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

