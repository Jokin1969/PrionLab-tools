  // ── wiring ─────────────────────────────────────────────────────────────
  function init() {
    // Whether this user may send the JC convocation email — not in the
    // session (only in users.csv), so fetched once up front.
    api('/me').then(r => {
      IS_JC_RESPONSIBLE = !!r.is_jc_responsible;
      // Rows drawn before /me answered hid the JC curator controls — redraw.
      if (IS_JC_RESPONSIBLE && !IS_ADMIN) loadArticles();
    }).catch(() => {});
    PVVigilancia.wire();   // Miscelánea → Vigilancia competitiva (all roles)

    const debounce = (fn, ms) => {
      let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    };
    const onSearch = debounce(() => { state.page = 1; loadArticles(); }, 200);

    // Wire up the clear isolation button
    const clearIsolationBtn = document.getElementById('pv-clear-isolation-btn');
    if (clearIsolationBtn) {
      clearIsolationBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        _clearArticleIsolation();
        loadArticles();
      });
    }

    const searchInput = document.getElementById('pv-search-input');

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
      paintSearchInputState(false);
      searchInput.focus();
      state.page = 1;
      loadArticles();
    };
    if (clearBtn) clearBtn.addEventListener('click', clearSearch);

    // ── Field-filter microbuttons (T / Au / A / R) ─────────────────────────
    // Head and "Búsqueda avanzada" modal each have their own copy of these
    // buttons (same data-field, shared class) — paintFieldButton() repaints
    // every instance so both stay in sync regardless of which was clicked.
    const FIELD_COLORS = { title: '#2563eb', authors: '#7c3aed', abstract: '#059669', journal: '#d97706' };
    function paintFieldButtons(field) {
      const active = state.searchFields.indexOf(field) !== -1;
      document.querySelectorAll(`.pv-field-btn[data-field="${field}"]`).forEach(btn => {
        btn.style.background  = active ? FIELD_COLORS[field] : '#f3f4f6';
        btn.style.color       = active ? '#fff' : '#9ca3af';
        btn.style.borderColor = active ? FIELD_COLORS[field] : '#d1d5db';
      });
    }
    document.querySelectorAll('.pv-field-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.field;
        const idx   = state.searchFields.indexOf(field);
        if (idx === -1) state.searchFields.push(field);
        else state.searchFields.splice(idx, 1);
        paintFieldButtons(field);
        state.page = 1;
        loadArticles();
      });
    });

    searchInput.addEventListener('input', e => {
      syncClearBtn();
      state.q = e.target.value.trim();
      // While a quoted title is still being typed/pasted (odd number of
      // quotes), don't search yet — the half-open phrase would run the
      // slow per-word search for nothing. The closing quote triggers it.
      if (((state.q.match(/["“”]/g) || []).length) % 2 === 1) return;
      onSearch();
    });
    searchInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        clearSearch();
      }
    });
    // First paint — in case the input was restored with a value
    // (URL state, persisted filter, etc.).
    syncClearBtn();

    // ── AND / OR toggle for the standard search box ───────────────────────
    // Controls how multiple bare words typed in pv-search-input combine
    // (both in Postgres full-text search and the ILIKE fallback — see
    // buildListParams' q_mode param). AND is the default and matches what
    // a plain multi-word Google-style query implies.
    function setSearchWordMode(mode) {
      state.qMode = mode;
      document.querySelectorAll('.pv-search-mode-btn').forEach(btn => {
        const active = btn.dataset.mode === mode;
        btn.style.background  = active ? '#0F3460' : '#fff';
        btn.style.color       = active ? '#fff' : '#9ca3af';
        btn.style.borderColor = active ? '#0F3460' : '#d1d5db';
      });
      state.page = 1;
      loadArticles();
    }
    document.querySelectorAll('.pv-search-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => setSearchWordMode(btn.dataset.mode));
    });

    // ── "Búsqueda avanzada" modal: mirrors the head's search input ────────
    const advSearchInput = document.getElementById('pv-adv-search-input');
    const advSearchWrap  = document.getElementById('pv-adv-search-wrap');
    const advClearBtn    = document.getElementById('pv-adv-search-clear');
    const paintAdvSearchInputState = (hasText) => {
      if (advSearchWrap) {
        advSearchWrap.style.background  = hasText ? '#fff3e6' : '#f9fafb';
        advSearchWrap.style.borderColor = hasText ? '#fbcea0' : '#e5e7eb';
      }
      if (advClearBtn) advClearBtn.style.display = hasText ? 'inline-flex' : 'none';
    };
    if (advSearchInput) {
      advSearchInput.addEventListener('input', e => {
        searchInput.value = e.target.value;
        syncClearBtn();
        paintAdvSearchInputState(!!e.target.value.trim());
        state.q = e.target.value.trim();
        onSearch();
      });
    }
    advClearBtn?.addEventListener('click', () => {
      if (!advSearchInput) return;
      advSearchInput.value = '';
      searchInput.value = '';
      syncClearBtn();
      paintAdvSearchInputState(false);
      state.q = '';
      advSearchInput.focus();
      state.page = 1;
      loadArticles();
    });
    document.getElementById('btn-advanced-search')?.addEventListener('click', () => {
      if (advSearchInput) {
        advSearchInput.value = searchInput.value;
        paintAdvSearchInputState(!!searchInput.value.trim());
      }
      document.getElementById('pv-advanced-search-modal').style.display = 'flex';
    });
    const closeAdvancedSearchModal = () => {
      document.getElementById('pv-advanced-search-modal').style.display = 'none';
    };
    document.getElementById('pv-advanced-search-close')?.addEventListener('click', closeAdvancedSearchModal);
    document.getElementById('pv-advanced-search-done')?.addEventListener('click', closeAdvancedSearchModal);
    document.getElementById('pv-advanced-search-run')?.addEventListener('click', () => {
      state.page = 1;
      loadArticles();
      closeAdvancedSearchModal();
    });
    document.querySelector('#pv-advanced-search-modal .pv-modal-backdrop')?.addEventListener('click', closeAdvancedSearchModal);

    // ── Library chat — replaces the old strict-grounding "AI search"
    // modal with a persistent, memory-capable chat (see PVLibChat below,
    // and services/library_chat.py on the backend). ──────────────────────
    document.getElementById('btn-ai-search')?.addEventListener('click', () => PVLibChat.open());
    document.getElementById('btn-ref-suggest')?.addEventListener('click', () => PVRefSuggest.open());

    // Visual signal that an input has text — easy to miss otherwise
    // when the placeholder/value contrast is low.
    function paintInputState(wrap, hasText) {
      if (!wrap) return;
      wrap.style.background   = hasText ? '#eff6ff' : '#f3f4f6';
      wrap.style.borderColor  = hasText ? '#bfdbfe' : 'transparent';
    }
    // The main search box gets its own (much lighter empty state, soft
    // orange when it has text) rather than sharing paintInputState's
    // grey/blue — kept separate so the bulk DOI/PMID lookup field below
    // isn't affected.
    function paintSearchInputState(hasText) {
      if (!searchWrap) return;
      searchWrap.style.background  = hasText ? '#fff3e6' : '#fbfbfc';
      searchWrap.style.borderColor = hasText ? '#fbcea0' : '#f0f0f1';
    }
    const searchWrap = document.getElementById('pv-search-wrap');
    paintSearchInputState(!!searchInput.value.trim());
    searchInput.addEventListener('input',
      () => paintSearchInputState(!!searchInput.value.trim()));

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
    document.getElementById('filter-sort').addEventListener('change', e => {
      state.sort = e.target.value; state.page = 1; loadArticles();
    });

    // ── Mark filters, moved from the toolbar strip into the table's own
    // column headers (above "Marcas", "Links" and "Asignado") — icons
    // matching the per-row marks, muted grey when inactive, coloured when
    // active. Binary on/off (not the old 3-way all/yes/no cycle): click =
    // show only articles with that mark, click again = show all. Multiple
    // active marks combine as AND (each is its own query param, ANDed
    // server-side) — matches the row icons 1:1 so there's nothing new to
    // learn, and keeps the toolbar strip free for things that aren't
    // simple booleans (color, priority, free-text search). syncMarkFilterButtons
    // itself lives at module scope (see above buildListParams) so other
    // spots that reset state (e.g. the Library Health modal) can resync too.
    document.querySelectorAll('.pv-mark-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.mark;
        state[key] = state[key] === true ? null : true;
        state.page = 1;
        syncMarkFilterButtons();
        loadArticles();
      });
    });
    syncMarkFilterButtons();

    // ── Color filter popup (header) ─────────────────────────────────────
    // Unlike the boolean marks above, color is a 6-value pick — doesn't
    // fit as a single click-to-toggle icon. The dot opens a small popup
    // listing only the colors the viewer has actually used (fetched once
    // per open), each with its count; picking one filters to it, picking
    // the active one again clears the filter. Single-select: an article
    // has exactly one color, so there's no "AND" case here like the
    // boolean marks.
    (function wireColorFilterPopup() {
      const btn = document.getElementById('pv-color-filter-btn');
      const popup = document.getElementById('pv-color-filter-popup');
      if (!btn || !popup) return;

      function syncDot() {
        const css = COLOR_CSS[state.colorLabel];
        btn.style.background = css || 'none';
        btn.style.borderStyle = css ? 'solid' : 'dashed';
        btn.style.borderColor = css || '#9ca3af';
      }
      syncDot();

      async function renderPopup() {
        popup.innerHTML = '<div style="font-size:11.5px;color:#9ca3af;padding:4px;">Cargando…</div>';
        let colors = [];
        try {
          const data = await api('/articles/colors-in-use');
          colors = data.colors || [];
        } catch (e) {
          popup.innerHTML = `<div style="font-size:11.5px;color:#b91c1c;padding:4px;">Error: ${esc(e.message)}</div>`;
          return;
        }
        if (!colors.length) {
          popup.innerHTML = '<div style="font-size:11.5px;color:#9ca3af;padding:4px;max-width:160px;">Todavía no has marcado ningún artículo con un color.</div>';
          return;
        }
        popup.innerHTML = colors.map(c => {
          const css = COLOR_CSS[c.color] || '#9ca3af';
          const active = state.colorLabel === c.color;
          return `
            <button type="button" class="pv-color-filter-option" data-color="${esc(c.color)}"
                    style="display:flex;align-items:center;gap:8px;width:100%;padding:5px 8px;
                           border:none;border-radius:6px;cursor:pointer;font-size:12.5px;
                           background:${active ? '#f3f4f6' : 'none'};color:#374151;text-align:left;">
              <span style="width:11px;height:11px;border-radius:50%;background:${css};flex-shrink:0;"></span>
              <span style="flex:1;text-transform:capitalize;">${esc(c.color)}</span>
              <span style="color:#9ca3af;font-size:11px;">${c.count}${active ? ' ✓' : ''}</span>
            </button>`;
        }).join('');
        popup.querySelectorAll('.pv-color-filter-option').forEach(opt => {
          opt.addEventListener('click', () => {
            const color = opt.dataset.color;
            state.colorLabel = state.colorLabel === color ? null : color;
            state.page = 1;
            syncDot();
            popup.style.display = 'none';
            loadArticles();
          });
        });
      }

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const opening = popup.style.display === 'none';
        popup.style.display = opening ? 'block' : 'none';
        if (opening) renderPopup();
      });
      document.addEventListener('click', (e) => {
        if (popup.style.display !== 'none' && !popup.contains(e.target) && e.target !== btn) {
          popup.style.display = 'none';
        }
      });

      // Exposed so syncMarkFilterButtons() (module scope, called from
      // resets triggered elsewhere — Library Health shortcuts, "Reset
      // filters"...) can keep this dot in sync too.
      window._pvSyncColorDot = syncDot;
    })();

    document.getElementById('filter-priority-eq').addEventListener('change', e => {
      const v = parseInt(e.target.value, 10);
      state.priorityEq = Number.isFinite(v) ? v : null;
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
          clearMarkFilters();
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

    function _paintNotesFilterBtns() {
      const active = state.hasSummary === 'human';
      ['btn-filter-notes'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.background = active ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)';
        el.style.color      = active ? 'white' : 'rgba(255,255,255,0.5)';
        el.title = active ? 'Mostrando solo artículos con notas — clic para quitar el filtro'
                          : (id === 'btn-filter-notes' ? 'Mostrar solo artículos con notas (sticky notes)'
                                                        : 'Filtrar por artículos con notas en esta sección');
      });
      // Head button lives on a light background, not the dark sidebar —
      // separate (lighter) active/inactive colors from the ones above.
      const headBtn = document.getElementById('btn-filter-notes-head');
      if (headBtn) {
        headBtn.style.background = active ? '#fef3c7' : '#fff';
        headBtn.style.borderColor = active ? '#d97706' : '#d1d5db';
        headBtn.title = active ? 'Mostrando solo artículos con notas — clic para quitar el filtro'
                                : 'Mostrar solo artículos con notas (sticky notes)';
      }
    }
    // Repaint after each loadArticles so active state stays in sync
    const _origLoadArticles = loadArticles;
    // Wire notes-filter button click to also repaint
    document.getElementById('btn-filter-notes')?.addEventListener('click', _paintNotesFilterBtns);
    document.getElementById('btn-filter-notes-head')?.addEventListener('click', () => {
      state.hasSummary = state.hasSummary === 'human' ? null : 'human';
      state.tagId = null;
      clearMarkFilters();
      state.page = 1;
      loadArticles();
      _paintNotesFilterBtns();
    });

    document.getElementById('btn-select-no-pdf')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const icon = btn.querySelector('i');
      const prevClass = icon ? icon.className : null;
      btn.disabled = true;
      if (icon) icon.className = 'fas fa-spinner fa-spin';
      try {
        const ids = await fetchAllNoPdfIds();
        if (!ids.length) {
          alert('No hay ningún artículo sin PDF.');
          return;
        }
        ids.forEach(id => state.selectedIds.add(id));
        // Also apply the "sin PDF" filter and clear anything else that
        // could hide some of those rows — otherwise the bulk bar would
        // say "N seleccionados" while the visible list (still under
        // whatever filters/search were active) shows a totally
        // different, confusing subset (or none of them at all).
        state.q = ''; state.yearMin = null; state.yearMax = null;
        state.journal = ''; state.authors = ''; state.tagId = null;
        clearMarkFilters();
        state.hasPdf = false;
        state.page = 1;
        const si = document.getElementById('pv-search-input');
        if (si) { si.value = ''; const cb = document.getElementById('pv-search-clear'); if (cb) cb.style.display = 'none'; }
        const fy1 = document.getElementById('filter-year-min'); if (fy1) fy1.value = '';
        const fy2 = document.getElementById('filter-year-max'); if (fy2) fy2.value = '';
        const fa = document.getElementById('filter-authors'); if (fa) fa.value = '';
        const fj = document.getElementById('filter-journal'); if (fj) fj.value = '';
        syncMarkFilterButtons();
        await loadArticles();
        document.querySelectorAll('.pv-row-select').forEach(cb => {
          cb.checked = state.selectedIds.has(cb.dataset.aid);
        });
        updateBulkBar();
        syncSelectAllHeader();
      } catch (err) {
        alert('No se pudo seleccionar: ' + (err.message || err));
      } finally {
        btn.disabled = false;
        if (icon && prevClass) icon.className = prevClass;
      }
    });

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

    wireJcManageButton();
    if (IS_ADMIN) {
      wireImport();
      wireQueue();
      wireAddByDoi();
      wireBibtexImport();
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
      wireGlossaryModal();
      wireScimago();
      wireBackups();
      wirePvViewAs();
      wirePvUserAdmin();
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
        hasPp: null, ppId: '', abstractStatus: '', indexedStatus: '', hasPdf: null, hasDoi: null,
        _healthExtra: null, page: 1,
        filterSelectedOnly: true,
      });
      if (state.selectedIds && typeof state.selectedIds.clearSilently === 'function') {
        state.selectedIds.clearSilently();
        ids.forEach(id => state.selectedIds.addSilently(id));
      } else {
        state.selectedIds = new Set(ids);
      }
      syncMarkFilterButtons();
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
    wireNewSmartTagButton();
    refreshTags();
    wireNewCollectionButton();
    refreshCollections();
    refreshPrionPacksDropdown();
    wireSidebarToggles();

    // Wire focus trapping for every modal in the page. Safe / idempotent.
    document.querySelectorAll('.pv-modal').forEach(m => wireModalFocusTrap(m));
    _wireA11y();

    // Apply any incoming ?has_glossary= filter BEFORE the first
    // loadArticles() call below — buildListParams() only reads from
    // `state`, so without this the query string was silently ignored.
    {
      const hg = new URLSearchParams(window.location.search).get('has_glossary');
      if (hg === '1')      state.hasGlossary = true;
      else if (hg === '0') state.hasGlossary = false;
    }

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
      // ?help=1 — deep link straight into the Ayuda modal, e.g. from an
      // email pointing a reader at the extension's help section.
      if (new URLSearchParams(window.location.search).get('help') === '1') {
        const cleanUrl = window.location.pathname +
          (window.location.search.replace(/([?&])help=1/g, '$1').replace(/[?&]$/, '') || '') +
          window.location.hash;
        history.replaceState(null, '', cleanUrl || window.location.pathname);
        window.openPrionVaultHelp?.();
      }
    });
  }

