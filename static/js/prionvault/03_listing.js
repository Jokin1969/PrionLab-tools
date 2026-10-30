  // ── Build the list query params (shared by loadArticles + fetchAllFilteredIds) ──
  // When filterSelectedOnly is active with >50 IDs the caller must use POST
  // (IDs go in the request body to avoid Railway URI length limits).
  // For ≤50 IDs the ids=... query param is short enough for a GET.
  function buildListParams() {
    const params = new URLSearchParams();
    if (state.isolatedArticleId) {
      params.set('ids', state.isolatedArticleId);
    } else if (state.filterSelectedOnly && state.selectedIds.size <= 50) {
      params.set('ids', Array.from(state.selectedIds).join(','));
    }
    if (state.q)                   params.set('q', state.q);
    if (state.q && state.qMode === 'or') params.set('q_mode', 'or');
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
    if (state.hasPdf !== null)     params.set('has_pdf', state.hasPdf ? 'true' : 'false');
    if (state.hasDoi !== null)     params.set('has_doi', state.hasDoi ? 'true' : 'false');
    if (state.jcPresenter)         params.set('jc_presenter', state.jcPresenter);
    if (state.jcYear)              params.set('jc_year', state.jcYear);
    if (state.hasPp !== null)      params.set('has_pp', state.hasPp ? '1' : '0');
    if (state.ppId)                params.set('pp_id', state.ppId);
    if (state.hasGlossary !== null)
      params.set('has_glossary', state.hasGlossary ? '1' : '0');
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

  // ── Mark filters, in the table's own column headers ─────────────────────
  // Shared at module scope (not nested inside init()) so both the header
  // click-wiring and one-off state resets elsewhere (e.g. the Library
  // Health modal's applyHealthFilter) can resync the icons' colour.
  const MARK_FILTER_ACTIVE_COLOR = {
    isFlagged: '#e11d48', isMilestone: '#f59e0b', isJc: '#7c3aed',
    isFavorite: '#e11d48', isRead: '#15803d',
    hasPdf: '#b91c1c', hasDoi: '#3730a3', inPrionread: '#0F3460',
  };
  function syncMarkFilterButtons() {
    document.querySelectorAll('.pv-mark-filter-btn').forEach(btn => {
      const key = btn.dataset.mark;
      const active = state[key] === true;
      btn.style.color = active ? (MARK_FILTER_ACTIVE_COLOR[key] || '#0F3460') : '#9ca3af';
    });
    if (window._pvSyncColorDot) window._pvSyncColorDot();
  }

  // Clears every header mark filter (flag/milestone/JC/favorite/read/
  // PDF/DOI/PrionRead-assigned/color) and repaints the icons. Bug fix:
  // sidebar navigation (All articles, Recently added, tags…) never
  // touched these — so activating a mark filter that matched nothing
  // (e.g. the ★ header icon with no milestones set) left the listing
  // permanently empty no matter what else you clicked in the sidebar,
  // because every one of those still carried the same stale isMilestone
  // filter. Only a hard page refresh reset it. Called from the sidebar
  // nav + tag click handlers below so switching context always actually
  // shows articles again.
  function clearMarkFilters() {
    state.isFlagged = null; state.isMilestone = null; state.isJc = null;
    state.isFavorite = null; state.isRead = null;
    state.hasPdf = null; state.hasDoi = null; state.inPrionread = null;
    state.colorLabel = null;
    syncMarkFilterButtons();
  }

  // Close every currently-open .pv-modal (centered dialogs) — used
  // before opening one from inside the cart's floating side panel, so
  // clicking several row buttons in a row only ever leaves the LAST
  // one open instead of stacking. The cart panel itself is a separate,
  // non-blocking fixed drawer (not a .pv-modal), so it's untouched.
  function _pvCloseOtherModals() {
    document.querySelectorAll('.pv-modal').forEach(m => {
      if (m.style.display !== 'none') m.style.display = 'none';
    });
  }

  // Isolate the listing to show only the given article(s). Accepts a
  // single id (string) or an array of ids (e.g. "show the whole cart in
  // the listing") — state.isolatedArticleId stores whatever buildListParams
  // hands straight to the `ids=` query param, which already accepts a
  // comma-separated list (see _fetchExtra's use of it elsewhere).
  function _setIsolatedArticleId(aidOrIds) {
    state.isolatedArticleId = Array.isArray(aidOrIds) ? aidOrIds.join(',') : aidOrIds;
    state.page = 1;
    _updateIsolationIndicator();
  }

  // Clear article isolation to show all articles again
  function _clearArticleIsolation() {
    state.isolatedArticleId = null;
    state.page = 1;
    _updateIsolationIndicator();
  }

  // Update the isolation indicator visibility + count text
  function _updateIsolationIndicator() {
    const indicator = document.getElementById('pv-isolation-indicator');
    if (!indicator) return;
    const ids = state.isolatedArticleId;
    indicator.style.display = ids ? 'inline-block' : 'none';
    if (ids) {
      const n = ids.split(',').filter(Boolean).length;
      const label = indicator.querySelector('.pv-isolation-label');
      if (label) label.textContent = `📍 Aislado a ${n} artículo${n === 1 ? '' : 's'}`;
    }
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

  // Plain-text citation block for "copy → paste into Word", used by the
  // cart's per-row 📋 button. Real \n line breaks (not <br> — this goes
  // straight to the clipboard as text/plain) so Word sees actual
  // paragraph breaks instead of one run-on line.
  function _citationText(a) {
    const lines = [a.title || '(sin título)', ''];
    if (a.authors) lines.push(a.authors, '');
    const journalYear = [a.journal, a.year ? String(a.year) : ''].filter(Boolean).join(', ');
    if (journalYear) lines.push(journalYear, '');
    const ids = [];
    if (a.doi)        ids.push(`DOI: ${a.doi}`);
    if (a.pubmed_id)  ids.push(`PMID: ${a.pubmed_id}`);
    if (ids.length) lines.push(ids.join('  ·  '));
    // Trim a trailing blank line left by the last section not firing.
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  // Plain-text version of the "share by email/WhatsApp" block — same
  // fields as the HTML version below, one per line, with the full URL
  // spelled out next to PMID/DOI (since plain text can't carry a real
  // hyperlink, but a pasted URL is still tappable in WhatsApp/most mail
  // clients).
  function _shareBlockText(a) {
    const lines = [a.title || '(sin título)'];
    if (a.authors) lines.push(a.authors);
    const journalYear = [a.journal, a.year ? String(a.year) : ''].filter(Boolean).join(', ');
    if (journalYear) lines.push(journalYear);
    if (a.pubmed_id) lines.push(`PMID: ${a.pubmed_id} — https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(a.pubmed_id)}/`);
    if (a.doi)       lines.push(`DOI: ${a.doi} — https://doi.org/${encodeURIComponent(a.doi)}`);
    return lines.join('\n');
  }

  // HTML version of the same block, with PMID/DOI as real <a href> links
  // — written to the clipboard's text/html slot alongside the plain-text
  // one above, so pasting into a rich-text target (Gmail compose,
  // WhatsApp Web's message box, Word) keeps them clickable, while a
  // plain-text target (a bare textarea, SMS) still gets the spelled-out
  // URL from _shareBlockText.
  function _shareBlockHtml(a) {
    const lines = [`<div>${esc(a.title || '(sin título)')}</div>`];
    if (a.authors) lines.push(`<div>${esc(a.authors)}</div>`);
    const journalYear = [a.journal, a.year ? String(a.year) : ''].filter(Boolean).join(', ');
    if (journalYear) lines.push(`<div>${esc(journalYear)}</div>`);
    if (a.pubmed_id) {
      const url = `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(a.pubmed_id)}/`;
      lines.push(`<div>PMID: <a href="${esc(url)}">${esc(a.pubmed_id)}</a></div>`);
    }
    if (a.doi) {
      const url = `https://doi.org/${encodeURIComponent(a.doi)}`;
      lines.push(`<div>DOI: <a href="${esc(url)}">${esc(a.doi)}</a></div>`);
    }
    return lines.join('');
  }

  // Writes both representations to the clipboard when the browser
  // supports the rich Clipboard API (ClipboardItem + navigator.clipboard.
  // write), so PMID/DOI paste as clickable links in Gmail/WhatsApp/Word;
  // falls back to a plain-text copy (via the shared _copyToClipboard,
  // which itself falls back further to execCommand) on older browsers or
  // insecure contexts where the rich API is unavailable.
  async function _copyShareBlock(a) {
    const text = _shareBlockText(a);
    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        const item = new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html':  new Blob([_shareBlockHtml(a)], { type: 'text/html' }),
        });
        await navigator.clipboard.write([item]);
        return true;
      }
    } catch (e) { /* fall through to plain-text copy */ }
    return _copyToClipboard(text);
  }

  function _providerBadgeHtml(provider) {
    if (provider === 'anthropic') return '<span class="pv-prov-badge" title="Resumen generado por Claude (Anthropic)" style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#ede9fe;color:#5b21b6;">✦ Claude</span>';
    if (provider === 'openai')    return '<span class="pv-prov-badge" title="Resumen generado por GPT (OpenAI)" style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#dcfce7;color:#15803d;">⬡ GPT</span>';
    if (provider === 'gemini')    return '<span class="pv-prov-badge" title="Resumen generado por Gemini (Google)" style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#dbeafe;color:#1d4ed8;">◈ Gemini</span>';
    return '<span class="pv-prov-badge" title="Resumen IA (proveedor desconocido)" style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#f3f4f6;color:#374151;">AI ✓</span>';
  }

  // Surgical DOM patch for the listing row's provider badge — used right
  // after generating a summary from the detail modal so the row updates
  // without a full re-render (renderRow() depends on many list-only
  // fields — ratings, jc_presenters, has_own_chat, etc. — that the
  // detail-fetched article object doesn't carry, so re-invoking it there
  // silently produced a wrong/stale row instead of throwing).
  function _patchRowProviderBadge(articleId, provider) {
    const listRow = document.querySelector(`tr.pv-article-row[data-aid="${articleId}"]`);
    if (!listRow) return;
    const html = _providerBadgeHtml(provider);
    const existing = listRow.querySelector('.pv-prov-badge');
    if (existing) {
      existing.outerHTML = html;
      return;
    }
    const wrap = listRow.querySelector('.pv-row-badges-wrap');
    // 'beforeend' rather than 'afterbegin': the wrap's first children are
    // the row's primary action buttons (📍 isolate, ✉ email, 🤖 chat, …) —
    // inserting at the front pushed the badge in front of those instead
    // of alongside the other summary badges further along the row.
    if (wrap) wrap.insertAdjacentHTML('beforeend', html);
  }

  function renderRow(a) {
    const row = document.createElement('tr');
    row.className = 'pv-article-row';
    row.dataset.aid = a.id;
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
      a.has_pdf
        ? `<a href="${API}/articles/${esc(a.id)}/pdf?download=1" download
                title="Descargar el PDF directamente"
                onclick="event.stopPropagation();"
                style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:4px;
                       font-size:10.5px;font-weight:600;background:#fee2e2;color:#b91c1c;
                       border:none;cursor:pointer;line-height:1.2;text-decoration:none;"><i class="fas fa-download"></i></a>`
        : !IS_ADMIN ? '' : `<button type="button" class="pv-oa-row-btn" data-aid="${esc(a.id)}"
                title="${a.oa_author_requested ? 'Ya se ha pedido el PDF al autor — clic para volver a intentarlo' : 'Buscar el PDF en fuentes de acceso abierto (Unpaywall, OpenAlex)'}"
                style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:4px;
                       font-size:10.5px;font-weight:600;${a.oa_author_requested ? 'background:#fef3c7;color:#92400e;' : 'background:#eef2ff;color:#4338ca;'}
                       border:none;cursor:pointer;line-height:1.2;">${a.oa_author_requested ? '🔓✓' : '🔓'}</button>`,
      `<button type="button" class="pv-isolate-row-btn" data-aid="${esc(a.id)}"
                title="Mostrar solo este artículo en el listado"
                style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:4px;
                       font-size:10.5px;font-weight:600;background:#fef3c7;color:#92400e;
                       border:none;cursor:pointer;line-height:1.2;">📍</button>`,
      `<button type="button" class="pv-email-row-btn" data-aid="${esc(a.id)}"
                title="Enviar este artículo por email (datos + resumen IA)"
                style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:4px;
                       font-size:10.5px;font-weight:600;background:#eef2ff;color:#4f46e5;
                       border:none;cursor:pointer;line-height:1.2;"><i class="fas fa-paper-plane"></i></button>`,
      `<button type="button" class="pv-chat-row-btn" data-aid="${esc(a.id)}"
                title="${a.has_own_chat ? 'Ya tienes una conversación sobre este artículo — clic para continuarla' : 'Preguntar a la IA sobre este artículo'}"
                style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:4px;
                       font-size:10.5px;font-weight:600;background:${a.has_own_chat ? '#15803d' : '#0F3460'};color:#fff;
                       border:none;cursor:pointer;line-height:1.2;">🤖 Chat</button>`,
      IS_ADMIN
        ? `<button type="button" class="pv-edit-row-btn" data-aid="${esc(a.id)}"
                    title="${a.pubmed_id ? 'Editar artículo + abrir PubMed en otra pestaña' : 'Editar artículo'}"
                    style="display:inline-flex;align-items:center;gap:2px;padding:1px 6px;border-radius:4px;
                           font-size:10.5px;font-weight:600;background:#ede9fe;color:#6d28d9;
                           border:none;cursor:pointer;line-height:1.2;">✏ Editar</button>`
        : '',
      a.has_summary_ai ? _providerBadgeHtml(a.summary_ai_provider) : '',
      a.ai_summary_glossary_version
        ? `<span title="Resumen mejorado con Glosario v${esc(a.ai_summary_glossary_version)}" style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#f0fdf4;color:#166534;">📖 v${esc(a.ai_summary_glossary_version)}</span>`
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
        : (IS_ADMIN && !a.has_abstract && (a.doi || a.pubmed_id))
          ? `<button type="button" class="pv-fetch-abstract-btn" data-aid="${esc(a.id)}"
                     title="Buscar abstract en CrossRef / PubMed"
                     style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#fef3c7;color:#92400e;border:none;cursor:pointer;">⬇ Abstract</button>`
          : '',
      // Always shown, even with no presentation yet (grey) — clicking a
      // grey one jumps straight into "add presentation" for THIS article
      // (no need to search for it, we already know it); clicking a
      // green one (has_jc) opens the existing document(s) as before.
      (() => {
        const look = _jcButtonLook(a);
        const title = a.has_jc && a.jc_presenters
          ? `Presentado por ${a.jc_presenters} en Journal Club — clic para verlo en Gestión de Journal clubs`
          : look.title;
        return `<button type="button" class="pv-row-jc-btn" data-aid="${esc(a.id)}"
              title="${esc(title)}"
              style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;
                     border:none;cursor:pointer;${look.css}">${look.label}${a.has_jc && a.jc_count > 1 ? ' ' + a.jc_count : ''}</button>`;
      })(),
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
    const journal = a.journal
      ? ` · <span style="color:#1e3a8a;font-weight:600;">${esc(a.journal)}</span>`
        + (a.year ? ` <span style="color:#7a1230;font-weight:600;">(${esc(a.year)})</span>` : '')
      : '';

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
                  title="${a.is_jc ? ((IS_ADMIN || IS_JC_RESPONSIBLE) ? 'En Journal Club — clic para quitar' : 'Seleccionado para Journal Club')
                                   : (IS_ADMIN ? 'Marcar para Journal Club' : 'No está en Journal Club')}"
                  style="background:none;border:none;padding:0;font-size:13px;line-height:1;
                         cursor:${(IS_ADMIN || IS_JC_RESPONSIBLE) ? 'pointer' : 'default'};color:${jcColor};"><i class="fas fa-book-open"></i></button>
          ${(_jcConvocable(a) && (IS_ADMIN || IS_JC_RESPONSIBLE)) ? `
          <button class="pv-jc-convoke-row-btn"
                  title="Convocar Journal Club — enviar fecha/hora a todo el laboratorio"
                  style="background:none;border:none;padding:0;font-size:13px;line-height:1;
                         cursor:pointer;color:#9d174d;"><i class="fas fa-bullhorn"></i></button>` : ''}
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
    const _canFetchOA = IS_ADMIN && !a.has_pdf && !a.pdf_dropbox_path
                        && a.pdf_oa_status !== 'not_available'
                        && (a.doi || a.pmc_id);
    const _oaFailed  = IS_ADMIN && !a.has_pdf && !a.pdf_dropbox_path
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
             title="${esc(titleTooltip)}">${supHtml(a.title || '(no title)')}<button
               type="button" class="pv-copy-title-btn" data-title="${esc(a.title || '')}"
               title="Copiar título"
               style="all:unset;display:inline-flex;vertical-align:super;margin-left:3px;
                      cursor:pointer;color:#9ca3af;font-size:10px;line-height:1;"
               ><i class="far fa-copy"></i></button><button
               type="button" class="pv-share-row-btn" data-aid="${esc(a.id)}"
               title="Copiar título, autores, revista, PMID y DOI para pegar en un email o WhatsApp (PMID/DOI quedan como enlaces clicables)"
               style="all:unset;display:inline-flex;vertical-align:super;margin-left:3px;
                      cursor:pointer;color:#9ca3af;font-size:10px;line-height:1;"
               ><i class="fas fa-layer-group"></i></button></div>
        <div style="margin-top:2px;font-size:12px;color:#6b7280;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${authors}${journal}</div>
        ${(tags || badges) ? `<div class="pv-row-badges-wrap" style="display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:4px;overflow:hidden;">${badges}${tags}</div>` : ''}
      </td>`;

    // ── Year cell ────────────────────────────────────────────────────────
    const yearCell = `
      <td class="pv-row-open" style="padding:8px 8px;vertical-align:middle;font-size:13px;color:#374151;
                 font-variant-numeric:tabular-nums;cursor:pointer;">${a.year ? a.year : '—'}</td>`;

    // ── Pages cell ───────────────────────────────────────────────────────
    const pagesCell = a.pdf_pages
      ? `<td style="padding:8px 8px;vertical-align:middle;text-align:center;font-size:12px;color:#374151;">
           <span style="display:inline-flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;padding:2px 6px;border-radius:5px;
                        background:#f3f4f6;font-variant-numeric:tabular-nums;line-height:1.1;">📄<span>${a.pdf_pages}</span></span>
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

    // Per-row button wiring (~25 listeners) is deferred until the row is
    // first clicked: a capture-phase listener on the row runs it just
    // before the click reaches its target, so the target's handlers (added
    // now) still fire for that same click — including programmatic
    // .click() calls. Rendering a 500/1000-row page no longer creates
    // tens of thousands of closures up front.
    const wireRow = () => {
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

      row.querySelector('.pv-jc-convoke-row-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        PVJcConvoke.open(a);
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
        // Shared mark, curated by admins and the JC responsible(s).
        if (!(IS_ADMIN || IS_JC_RESPONSIBLE)) return;
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

      // JC button: open to every role (it was wired inside the admin-only
      // block below, so for anyone else the click fell through to the row
      // and opened the article's detail modal instead).
      const jcRowBtn = row.querySelector('.pv-row-jc-btn');
      if (jcRowBtn) jcRowBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        jcRowBtn.disabled = true;
        try { await openJcButton(a, () => loadArticles()); }
        finally { jcRowBtn.disabled = false; }
      });

      // Row buttons, wired for EVERY role. This block used to be wrapped in
      // `if (IS_ADMIN)`, so for non-admins the 📍, email, chat, notes, cart,
      // copy and share buttons were shown but dead — the click fell through
      // to the row and opened the article's detail modal. The few truly
      // admin-only buttons (fetch abstract, OA fetch/upload, 🔓) are simply
      // not rendered for non-admins, so their wiring below finds nothing.
      {
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

        const isolateRowBtn = row.querySelector('.pv-isolate-row-btn');
        if (isolateRowBtn) isolateRowBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          _setIsolatedArticleId(a.id);
          loadArticles();
        });

        const oaRowBtn = row.querySelector('.pv-oa-row-btn');
        if (oaRowBtn) oaRowBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openOaSearchModal(a);
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



        const shareRowBtn = row.querySelector('.pv-share-row-btn');
        if (shareRowBtn) shareRowBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const icon = shareRowBtn.querySelector('i');
          const prevClass = icon ? icon.className : null;
          const ok = await _copyShareBlock(a);
          if (icon) icon.className = ok ? 'fas fa-check' : 'fas fa-xmark';
          setTimeout(() => { if (icon && prevClass) icon.className = prevClass; }, 1400);
        });

        const cartBtn = row.querySelector('.pv-cart-btn');
        if (cartBtn) cartBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!window.PPCart) return;
          const inCart = window.PPCart.has(a.id);
          if (inCart) {
            window.PPCart.remove(a.id);
            cartBtn.classList.remove('pv-cart-btn--in');
            cartBtn.style.background = 'white';
            cartBtn.style.color = '#374151';
            cartBtn.title = 'Añadir al carrito de PrionPacks';
            cartBtn.innerHTML = '🛒';
          } else {
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
          }
        });
      }

    };
    // Wired eagerly: these may attach hover behaviour, not just clicks.
    {
      const noteCluster = row.querySelector('.pv-notes-cluster');
      if (noteCluster) _wireNoteCluster(noteCluster, a);
      const manualUploadBtn = row.querySelector('.pv-oa-manual-btn');
      if (manualUploadBtn) _wireManualUploadBtn(manualUploadBtn, a);
      _wireCopyBtn(row.querySelector('.pv-copy-title-btn'));
    }
    let _rowWired = false;
    row.addEventListener('click', () => {
      if (!_rowWired) { _rowWired = true; wireRow(); }
    }, { capture: true });

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

