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
      $('pv-email-to')?.addEventListener('keydown', e => {
        // Go through the button so its disabled state blocks double sends.
        if (e.key === 'Enter') { e.preventDefault(); const b = $('pv-email-send'); if (b && !b.disabled) b.click(); }
      });
      const ctog = $('pv-email-comment-toggle');
      ctog?.addEventListener('change', () => {
        const ta = $('pv-email-comment');
        ta.style.display = ctog.checked ? 'block' : 'none';
        if (ctog.checked) ta.focus();
      });
      // Schedule for later toggle
      const stog = $('pv-email-schedule-toggle');
      stog?.addEventListener('change', () => {
        const controls = $('pv-email-schedule-controls');
        const btn = $('pv-email-send');
        if (controls) {
          controls.style.display = stog.checked ? 'block' : 'none';
          if (stog.checked) {
            // Set default date to tomorrow
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const dateStr = tomorrow.toISOString().split('T')[0];
            $('pv-email-schedule-date').value = dateStr;
            $('pv-email-schedule-date').focus();
            // Update button text
            if (btn) btn.innerHTML = '<i class="fas fa-calendar"></i> Programar';
          } else {
            // Update button text back to send
            if (btn) btn.innerHTML = '<i class="fas fa-paper-plane"></i> Enviar';
          }
        }
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
      const mr = $('pv-email-mark-read');
      if (mr) mr.checked = true;
      // Reset schedule toggle
      const stog = $('pv-email-schedule-toggle');
      if (stog) {
        stog.checked = false;
        const controls = $('pv-email-schedule-controls');
        if (controls) controls.style.display = 'none';
      }
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
      if (btn.disabled) return;  // a send is already in flight
      btn.disabled = true;
      const opts = currentOptions();

      // Check if scheduled
      const isScheduled = $('pv-email-schedule-toggle')?.checked;
      let scheduledAt = null;
      if (isScheduled) {
        const dateVal = $('pv-email-schedule-date').value;
        const timeVal = $('pv-email-schedule-time').value || '09:00';
        if (!dateVal) {
          status.style.color = '#b91c1c'; status.textContent = 'Indica una fecha.'; btn.disabled = false; return;
        }
        // Date/time are the user's LOCAL time (like the JC form) → ISO UTC.
        scheduledAt = new Date(`${dateVal}T${timeVal}:00`).toISOString();
        status.style.color = '#9ca3af';
        status.textContent = 'Programando…';
      } else {
        status.style.color = '#9ca3af';
        status.textContent = 'Enviando…';
      }

      try {
        const markRead = $('pv-email-mark-read')?.checked !== false;
        const payload = { to, ...opts, mark_read: markRead };
        if (scheduledAt) payload.scheduled_at = scheduledAt;
        const r = await api(`/articles/${_article.id}/email`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        try {
          localStorage.setItem(LAST_KEY, to);
          if (opts.comment) localStorage.setItem(COMMENT_KEY, opts.comment);
          else localStorage.removeItem(COMMENT_KEY);
        } catch (e) { /* ignore */ }
        status.style.color = '#15803d';
        if (isScheduled) {
          status.textContent = '✓ ' + (r.message || 'Programado correctamente');
        } else {
          const pdfNote = r.attached_pdf ? ' (con PDF adjunto)'
            : (r.has_pdf ? ' (sin PDF: no disponible o demasiado grande)' : ' (este artículo no tiene PDF)');
          status.textContent = '✓ Enviado' + pdfNote;
          if (markRead && r.marked_read) {
            _article.is_read = true;
            // Light in-place repaint of the listing's ✓ — the article
            // object passed in may be a partial one (e.g. from the cart),
            // so don't rebuild the whole row from it.
            const btn = document.querySelector(`tr[data-aid="${_article.id}"] .pv-read-btn`);
            if (btn) {
              btn.dataset.active = '1';
              btn.style.color = '#15803d';
              btn.title = 'Marcar como no leído';
            }
          }
        }
        setTimeout(close, 1800);
        setTimeout(() => { btn.disabled = false; }, 2000);  // no double send before close
      } catch (e) {
        status.style.color = '#b91c1c';
        status.textContent = 'Error: ' + e.message;
        btn.disabled = false;
      }
    }

    return { open, close };
  })();

  // ── Cart modal — select articles from the cart, act on them ────────────
  const PVCart = (() => {
    const $ = id => document.getElementById(id);
    let _wired = false;
    const _selected = new Set();   // article ids selected INSIDE the modal
    // PPCart only stores a reduced shape (id/title/authors/year/journal/
    // doi/pubmed_id/has_pdf) — notes and JC status aren't in it, so a
    // fresh fetch fills them in for display. Cached per article id so
    // toggling a checkbox doesn't re-fetch the whole cart every time.
    const _extra = new Map();

    function journalYear(a) {
      if (!a.journal) return '';
      return ` · <span style="color:#1e3a8a;font-weight:600;">${esc(a.journal)}</span>` +
        (a.year ? ` <span style="color:#7a1230;font-weight:600;">(${esc(a.year)})</span>` : '');
    }

    async function _fetchExtra(ids) {
      const missing = ids.filter(id => !_extra.has(id));
      if (!missing.length) return;
      try {
        const r = await api('/articles?ids=' + missing.map(encodeURIComponent).join(',') +
                            '&page_size=' + missing.length);
        (r.items || []).forEach(full => _extra.set(full.id, full));
      } catch (e) { /* silent — rows just render without notes/JC state */ }
      // Ids the fetch didn't return anything for (deleted meanwhile, etc.)
      // still get a cache entry so we don't refetch them forever.
      missing.forEach(id => { if (!_extra.has(id)) _extra.set(id, {}); });
    }

    function rowHtml(a) {
      const ex = _extra.get(a.id) || {};
      const hasPdf = ex.has_pdf ?? a.has_pdf;
      const links = [
        hasPdf ? `<a href="${API}/articles/${esc(a.id)}/pdf-view" target="_blank" rel="noopener"
              onclick="event.stopPropagation();" style="color:#b91c1c;text-decoration:none;font-weight:600;">
              <i class="fas fa-file-pdf"></i> PDF</a>` : '',
        hasPdf ? `<a href="${API}/articles/${esc(a.id)}/pdf?download=1" download
              title="Descargar el PDF" onclick="event.stopPropagation();"
              style="color:#6b7280;text-decoration:none;">
              <i class="fas fa-download"></i></a>` : '',
        a.doi ? `<a href="https://doi.org/${encodeURIComponent(a.doi)}" target="_blank" rel="noopener"
              onclick="event.stopPropagation();" style="color:#0F3460;text-decoration:none;">DOI: ${esc(a.doi)}</a>` : '',
        a.pubmed_id ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${esc(a.pubmed_id)}/" target="_blank" rel="noopener"
              onclick="event.stopPropagation();" style="color:#0F3460;text-decoration:none;">PMID: ${esc(a.pubmed_id)}</a>` : '',
      ].filter(Boolean).join(' &nbsp;·&nbsp; ');

      const notesCluster = `<span class="pv-notes-cluster" data-aid="${esc(a.id)}"
             style="display:inline-flex;gap:4px;vertical-align:middle;">${_noteClusterInner(ex.notes)}</span>`;

      const jcHasJc = !!ex.has_jc;
      const jcLook = _jcButtonLook(ex);
      const jcBtn = `<button type="button" class="pv-cart-row-jc-btn" data-aid="${esc(a.id)}"
              title="${esc(jcHasJc && ex.jc_presenters
                  ? `Presentado por ${ex.jc_presenters} en Journal Club — clic para verlo en Gestión de Journal clubs`
                  : jcLook.title)}"
              style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;
                     border:none;cursor:pointer;vertical-align:middle;${jcLook.css}">${jcLook.label}${jcHasJc && ex.jc_count > 1 ? ' ' + ex.jc_count : ''}</button>`;

      const emailBtn = `<button type="button" class="pv-cart-row-email-btn" data-aid="${esc(a.id)}"
              title="Enviar este artículo por email"
              style="display:inline-flex;align-items:center;padding:1px 6px;border-radius:4px;
                     font-size:10.5px;font-weight:600;background:#eef2ff;color:#4f46e5;
                     border:none;cursor:pointer;vertical-align:middle;">
              <i class="fas fa-paper-plane"></i></button>`;

      const copyBtn = `<button type="button" class="pv-cart-row-copy-btn" data-aid="${esc(a.id)}"
              title="Copiar la cita (título, autores, revista, DOI/PMID) para pegar en Word"
              style="display:inline-flex;align-items:center;padding:1px 6px;border-radius:4px;
                     font-size:10.5px;font-weight:600;background:#f3f4f6;color:#374151;
                     border:none;cursor:pointer;vertical-align:middle;">
              <i class="fas fa-copy"></i></button>`;

      return `
        <div class="pv-cart-row" data-aid="${esc(a.id)}"
             style="display:flex;align-items:flex-start;gap:10px;padding:10px 6px;border-bottom:1px solid #f3f4f6;">
          <input type="checkbox" class="pv-cart-row-select" data-aid="${esc(a.id)}"
                 ${_selected.has(a.id) ? 'checked' : ''}
                 style="cursor:pointer;width:14px;height:14px;margin-top:3px;flex-shrink:0;">
          <div style="flex:1;min-width:0;">
            <div class="pv-cart-row-title" data-aid="${esc(a.id)}"
                 title="Ver solo este artículo en el listado"
                 style="font-size:13.5px;font-weight:600;color:#111827;line-height:1.35;cursor:pointer;
                        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(a.title || '(sin título)')}</div>
            <div style="margin-top:2px;font-size:12px;color:#6b7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              ${a.authors ? esc(a.authors) : '—'}${journalYear(a)}
            </div>
            <div style="margin-top:4px;font-size:11px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              ${links ? `<span>${links}</span>` : ''}
              ${notesCluster}
              ${jcBtn}
              ${emailBtn}
              ${copyBtn}
            </div>
          </div>
          <button type="button" class="pv-cart-row-remove" data-aid="${esc(a.id)}"
                  title="Quitar del carrito"
                  style="flex-shrink:0;border:none;background:transparent;color:#d1d5db;
                         cursor:pointer;font-size:14px;padding:4px;"
                  onmouseover="this.style.color='#b91c1c';" onmouseout="this.style.color='#d1d5db';">⚔️</button>
        </div>`;
    }

    function syncActionsBtn() {
      const btn = $('pv-cart-actions-btn');
      if (!btn) return;
      const on = _selected.size > 0;
      btn.disabled = !on;
      btn.style.opacity = on ? '1' : '0.45';
      btn.style.cursor = on ? 'pointer' : 'default';
    }

    function syncSelectAll() {
      const all = $('pv-cart-select-all');
      if (!all) return;
      const items = window.PPCart?.getAll() || [];
      all.checked = items.length > 0 && items.every(a => _selected.has(a.id));
      all.indeterminate = !all.checked && items.some(a => _selected.has(a.id));
    }

    // Renders straight away from whatever's already in the PPCart cache
    // + the _extra cache (both synchronous, in memory) — no waiting on
    // a network round trip before the drawer shows its contents. Any
    // article missing notes/JC data gets it filled in by a background
    // fetch that triggers exactly one follow-up render() when it lands
    // (see _fetchExtra's caller below), instead of the whole list
    // waiting on that fetch to paint anything at all.
    function render() {
      const items = window.PPCart?.getAll() || [];
      // Drop selections for articles no longer in the cart.
      [..._selected].forEach(id => { if (!items.some(a => a.id === id)) _selected.delete(id); });
      const list = $('pv-cart-list');
      const label = $('pv-cart-count-label');
      if (label) label.textContent = items.length
        ? `${items.length} artículo${items.length === 1 ? '' : 's'} en el carrito`
        : 'El carrito está vacío.';
      const missing = items.filter(a => !_extra.has(a.id)).map(a => a.id);
      if (missing.length) {
        _fetchExtra(missing).then(() => {
          // Only repaint if the drawer is still open and the cart
          // hasn't changed under us in the meantime.
          if ($('pv-cart-modal')?.style.display !== 'none') render();
        });
      }
      if (list) list.innerHTML = items.length ? items.map(rowHtml).join('') : `
        <div style="padding:30px 10px;text-align:center;color:#9ca3af;font-size:13px;">
          Añade artículos con el botón 🛒 del listado.
        </div>`;
      list?.querySelectorAll('.pv-cart-row-select').forEach(cb => {
        cb.addEventListener('change', () => {
          if (cb.checked) _selected.add(cb.dataset.aid);
          else _selected.delete(cb.dataset.aid);
          syncActionsBtn();
          syncSelectAll();
        });
      });
      list?.querySelectorAll('.pv-cart-row-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          window.PPCart?.remove(btn.dataset.aid);
          _selected.delete(btn.dataset.aid);
          render();
        });
      });
      // Click the title → isolate this article in the main listing,
      // same as the 📍 pin button in the listing rows.
      list?.querySelectorAll('.pv-cart-row-title').forEach(el => {
        el.addEventListener('click', () => {
          close();
          _setIsolatedArticleId(el.dataset.aid);
          loadArticles();
        });
      });
      list?.querySelectorAll('.pv-notes-cluster').forEach(cl => {
        const aid = cl.dataset.aid;
        // Capture phase so this runs BEFORE _wireNoteCluster's own
        // bubble-phase click handler opens the notes modal — closes
        // any other modal first, so only the latest one stays open.
        cl.addEventListener('click', _pvCloseOtherModals, true);
        _wireNoteCluster(cl, { id: aid, notes: (_extra.get(aid) || {}).notes });
      });
      list?.querySelectorAll('.pv-cart-row-jc-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          _pvCloseOtherModals();
          const aid = btn.dataset.aid;
          btn.disabled = true;
          try {
            await openJcButton({ id: aid }, () => { _extra.delete(aid); render(); });
          } finally {
            btn.disabled = false;
          }
        });
      });
      list?.querySelectorAll('.pv-cart-row-email-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          _pvCloseOtherModals();
          const aid = btn.dataset.aid;
          const full = _extra.get(aid);
          const base = items.find(a => a.id === aid);
          PVEmailShare.open(full && full.title ? full : base);
        });
      });
      list?.querySelectorAll('.pv-cart-row-copy-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const aid = btn.dataset.aid;
          const full = _extra.get(aid);
          const base = items.find(a => a.id === aid);
          const a = (full && full.title) ? full : base;
          if (!a) return;
          const icon = btn.querySelector('i');
          const prevClass = icon ? icon.className : null;
          try {
            await navigator.clipboard.writeText(_citationText(a));
            if (icon) icon.className = 'fas fa-check';
            btn.style.background = '#dcfce7';
            btn.style.color = '#15803d';
          } catch (err) {
            if (icon) icon.className = 'fas fa-xmark';
          } finally {
            setTimeout(() => {
              if (icon && prevClass) icon.className = prevClass;
              btn.style.background = '#f3f4f6';
              btn.style.color = '#374151';
            }, 1400);
          }
        });
      });
      syncActionsBtn();
      syncSelectAll();
    }

    function close() { $('pv-cart-modal').style.display = 'none'; }

    function open() {
      wireOnce();
      const modal = $('pv-cart-modal');
      if (!modal) return;
      if (!(window.PPCart?.getAll() || []).length) {
        alert('El carrito está vacío. Añade artículos con el botón 🛒 del listado.');
        return;
      }
      modal.style.display = 'flex';
      render();
    }

    // ── Actions ────────────────────────────────────────────────────────
    function openActions() {
      if (!_selected.size) return;
      const modal = $('pv-cart-actions-modal');
      if (!modal) return;
      $('pv-cart-actions-count').textContent =
        `${_selected.size} artículo${_selected.size === 1 ? '' : 's'} seleccionado${_selected.size === 1 ? '' : 's'}`;
      modal.style.display = 'flex';
    }
    function closeActions() { $('pv-cart-actions-modal').style.display = 'none'; }

    function selectedArticles() {
      const items = window.PPCart?.getAll() || [];
      return items.filter(a => _selected.has(a.id));
    }

    function actionEmail() {
      const arts = selectedArticles();
      if (!arts.length) return;
      closeActions();
      close();
      if (arts.length === 1) {
        // Exactly the same single-article flow as the row/detail "send
        // by email" button — PDF attachment, preview, everything.
        PVEmailShare.open(arts[0]);
        return;
      }
      openBulkEmail(arts);
    }

    function actionPrionPacks() {
      if (!_selected.size) return;
      // PrionPacks has its own separate staging list (PPImportTray —
      // NOT this cart) for picking a target package per article. Copy
      // just the SELECTED articles there (never the whole cart) and
      // open PrionPacks to let the operator choose the target(s); this
      // cart is untouched either way, and clearing the tray later from
      // inside PrionPacks won't clear this cart back here.
      const arts = selectedArticles();
      arts.forEach(a => window.PPImportTray?.add(a));
      window.open('/prionpacks', '_blank');
      closeActions();
    }

    // ── Bulk email (2+ selected, or the whole cart with PDFs) ────────────
    let _bulkIds = [];
    let _bulkEndpoint = '/articles/email-list';
    function openBulkEmail(arts) {
      _bulkIds = arts.map(a => a.id);
      _bulkEndpoint = '/articles/email-list';
      const modal = $('pv-cart-email-modal');
      if (!modal) return;
      $('pv-cart-email-count').textContent =
        `${arts.length} artículos — se enviará un listado con enlaces, sin PDF adjunto.`;
      $('pv-cart-email-status').textContent = '';
      const toEl = $('pv-cart-email-to');
      const last = (() => { try { return localStorage.getItem('pv-share-last-email') || ''; } catch (e) { return ''; } })();
      toEl.value = last;
      $('pv-cart-email-comment').value = '';
      modal.style.display = 'flex';
      toEl.focus();
    }
    function openCartEmail() {
      const items = window.PPCart?.getAll() || [];
      if (!items.length) { alert('El carrito está vacío.'); return; }
      close();
      _bulkIds = items.map(a => a.id);
      _bulkEndpoint = '/articles/email-cart';
      const modal = $('pv-cart-email-modal');
      if (!modal) return;
      $('pv-cart-email-count').textContent =
        `${items.length} artículo${items.length === 1 ? '' : 's'} del carrito — se enviarán en un único email con los PDFs disponibles adjuntos.`;
      $('pv-cart-email-status').textContent = '';
      const toEl = $('pv-cart-email-to');
      const last = (() => { try { return localStorage.getItem('pv-share-last-email') || ''; } catch (e) { return ''; } })();
      toEl.value = last;
      $('pv-cart-email-comment').value = '';
      modal.style.display = 'flex';
      toEl.focus();
    }
    function closeBulkEmail() { $('pv-cart-email-modal').style.display = 'none'; }

    async function sendBulkEmail() {
      const btn = $('pv-cart-email-send');
      const status = $('pv-cart-email-status');
      const to = ($('pv-cart-email-to').value || '').trim();
      if (!to) { status.style.color = '#b91c1c'; status.textContent = 'Escribe un destinatario.'; return; }
      btn.disabled = true;
      status.style.color = '#9ca3af';
      status.textContent = 'Enviando…';
      try {
        await api(_bulkEndpoint, {
          method: 'POST',
          body: JSON.stringify({
            to, article_ids: _bulkIds,
            comment: ($('pv-cart-email-comment').value || '').trim(),
          }),
        });
        try { localStorage.setItem('pv-share-last-email', to); } catch (e) { /* ignore */ }
        status.style.color = '#15803d';
        status.textContent = '✓ Enviado';
        setTimeout(closeBulkEmail, 1400);
        setTimeout(() => { btn.disabled = false; }, 1600);  // no double send before close
      } catch (e) {
        status.style.color = '#b91c1c';
        status.textContent = 'Error: ' + e.message;
        btn.disabled = false;
      }
    }

    // ── Cart repository (save / browse / restore named snapshots) ────────
    function openSaveCart() {
      const items = window.PPCart?.getAll() || [];
      if (!items.length) { alert('El carrito está vacío.'); return; }
      const modal = $('pv-cart-save-modal');
      if (!modal) return;
      $('pv-cart-save-count').textContent =
        `${items.length} artículo${items.length === 1 ? '' : 's'} en el carrito actual.`;
      $('pv-cart-save-status').textContent = '';
      const nameEl = $('pv-cart-save-name');
      nameEl.value = '';
      modal.style.display = 'flex';
      nameEl.focus();
    }
    function closeSaveCart() { $('pv-cart-save-modal').style.display = 'none'; }

    async function saveCartGo() {
      const btn = $('pv-cart-save-go');
      const status = $('pv-cart-save-status');
      const name = ($('pv-cart-save-name').value || '').trim();
      if (!name) { status.style.color = '#b91c1c'; status.textContent = 'Ponle un nombre.'; return; }
      btn.disabled = true;
      status.style.color = '#9ca3af';
      status.textContent = 'Guardando…';
      try {
        await api('/carts', { method: 'POST', body: JSON.stringify({ name }) });
        status.style.color = '#15803d';
        status.textContent = '✓ Guardado en el repositorio';
        setTimeout(closeSaveCart, 1200);
      } catch (e) {
        status.style.color = '#b91c1c';
        status.textContent = 'Error: ' + e.message;
      } finally {
        btn.disabled = false;
      }
    }

    function _repoCartRowHtml(c) {
      const when = c.created_at ? new Date(c.created_at).toLocaleString('es-ES', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      }) : '';
      return `
        <div class="pv-repo-cart-row" data-cid="${esc(c.id)}"
             style="display:flex;align-items:center;gap:10px;padding:11px 4px;border-bottom:1px solid #f3f4f6;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:13.5px;font-weight:600;color:#111827;overflow:hidden;
                        text-overflow:ellipsis;white-space:nowrap;">${esc(c.name)}</div>
            <div style="margin-top:2px;font-size:11.5px;color:#9ca3af;">
              ${esc(when)} · ${c.count} artículo${c.count === 1 ? '' : 's'}
            </div>
          </div>
          <button type="button" class="pv-repo-cart-restore" data-cid="${esc(c.id)}"
                  style="flex-shrink:0;padding:6px 13px;border-radius:7px;border:1px solid #d1d5db;
                         background:#fff;color:#374151;font-size:12px;font-weight:600;cursor:pointer;">
            <i class="fas fa-rotate-left"></i> Recuperar
          </button>
          <button type="button" class="pv-repo-cart-delete" data-cid="${esc(c.id)}"
                  title="Eliminar este carrito guardado"
                  style="flex-shrink:0;border:none;background:transparent;color:#d1d5db;
                         cursor:pointer;font-size:14px;padding:4px;"
                  onmouseover="this.style.color='#b91c1c';" onmouseout="this.style.color='#d1d5db';">
            <i class="fas fa-trash-alt"></i>
          </button>
        </div>`;
    }

    async function loadRepoCarts() {
      const list = $('pv-cart-repo-list');
      if (!list) return;
      list.innerHTML = '<div style="padding:20px 4px;color:#9ca3af;font-size:12.5px;">Cargando…</div>';
      try {
        const r = await api('/carts');
        const carts = r.carts || [];
        list.innerHTML = carts.length ? carts.map(_repoCartRowHtml).join('') : `
          <div style="padding:24px 4px;text-align:center;color:#9ca3af;font-size:13px;">
            Aún no has guardado ningún carrito.
          </div>`;
        list.querySelectorAll('.pv-repo-cart-restore').forEach(btn => {
          btn.addEventListener('click', () => restoreCart(btn.dataset.cid));
        });
        list.querySelectorAll('.pv-repo-cart-delete').forEach(btn => {
          btn.addEventListener('click', async () => {
            if (!confirm('¿Eliminar este carrito del repositorio? No se puede deshacer.')) return;
            try {
              await api(`/carts/${btn.dataset.cid}`, { method: 'DELETE' });
              loadRepoCarts();
            } catch (e) { alert('No se pudo eliminar: ' + e.message); }
          });
        });
      } catch (e) {
        list.innerHTML = `<div style="padding:20px 4px;color:#b91c1c;font-size:12.5px;">Error: ${esc(e.message)}</div>`;
      }
    }

    function openRepoCarts() {
      const modal = $('pv-cart-repo-modal');
      if (!modal) return;
      modal.style.display = 'flex';
      loadRepoCarts();
    }
    function closeRepoCarts() { $('pv-cart-repo-modal').style.display = 'none'; }

    async function restoreCart(cartId) {
      const current = window.PPCart?.getAll() || [];
      if (current.length && !confirm(
        `El carrito actual tiene ${current.length} artículo${current.length === 1 ? '' : 's'}. ` +
        `Al recuperar este carrito guardado se sustituirán por completo los artículos actuales. ¿Continuar?`
      )) return;
      try {
        await api(`/carts/${cartId}/restore`, { method: 'POST' });
        // PPCart's in-memory cache has no external setter (by design, to
        // keep its public API tiny) — a reload is the simplest way to
        // re-hydrate it from the server, same as it does on first load.
        location.reload();
      } catch (e) {
        alert('No se pudo recuperar el carrito: ' + e.message);
      }
    }

    // ── Transfer cart to other user(s) ────────────────────────────────────
    async function openTransferCart() {
      const items = window.PPCart?.getAll() || [];
      if (!items.length) { alert('El carrito está vacío.'); return; }
      const modal = $('pv-cart-transfer-modal');
      if (!modal) return;
      $('pv-cart-transfer-count').textContent =
        `${items.length} artículo${items.length === 1 ? '' : 's'} se añadirán al carrito de quien elijas.`;
      $('pv-cart-transfer-status').textContent = '';
      const box = $('pv-cart-transfer-users');
      box.innerHTML = '<div style="padding:10px 4px;color:#9ca3af;font-size:12.5px;">Cargando…</div>';
      modal.style.display = 'flex';
      try {
        const r = await api('/cart/transfer-targets');
        const users = r.users || [];
        box.innerHTML = users.length ? users.map(u => `
          <label style="display:flex;align-items:center;gap:8px;padding:5px 2px;font-size:13px;
                        color:#111827;cursor:pointer;">
            <input type="checkbox" class="pv-cart-transfer-user" value="${esc(u.username)}"
                   style="cursor:pointer;width:14px;height:14px;">
            ${esc(u.full_name)}
          </label>`).join('') : '<div style="padding:10px 4px;color:#9ca3af;font-size:12.5px;">No hay otros usuarios activos.</div>';
      } catch (e) {
        box.innerHTML = `<div style="padding:10px 4px;color:#b91c1c;font-size:12.5px;">Error: ${esc(e.message)}</div>`;
      }
    }
    function closeTransferCart() { $('pv-cart-transfer-modal').style.display = 'none'; }

    async function transferCartGo() {
      const btn = $('pv-cart-transfer-go');
      const status = $('pv-cart-transfer-status');
      const usernames = Array.from(document.querySelectorAll('.pv-cart-transfer-user:checked'))
        .map(el => el.value);
      if (!usernames.length) {
        status.style.color = '#b91c1c'; status.textContent = 'Elige al menos un usuario.'; return;
      }
      btn.disabled = true;
      status.style.color = '#9ca3af';
      status.textContent = 'Enviando…';
      try {
        const r = await api('/cart/transfer', { method: 'POST', body: JSON.stringify({ usernames }) });
        const ok = (r.results || []).filter(x => x.ok);
        status.style.color = '#15803d';
        status.textContent = `✓ Enviado a ${ok.length} usuario${ok.length === 1 ? '' : 's'}.`;
        setTimeout(closeTransferCart, 1600);
      } catch (e) {
        status.style.color = '#b91c1c';
        status.textContent = 'Error: ' + e.message;
      } finally {
        btn.disabled = false;
      }
    }

    function openCartChat() {
      const items = window.PPCart?.getAll() || [];
      if (!items.length) { alert('El carrito está vacío.'); return; }
      close();
      PVChat.open(
        { title: `Chat sobre ${items.length} artículo${items.length === 1 ? '' : 's'} del carrito` },
        { groupArticleIds: items.map(a => a.id) },
      );
    }

    function wireOnce() {
      if (_wired) return;
      _wired = true;
      $('pv-cart-close')?.addEventListener('click', close);
      $('pv-cart-hide')?.addEventListener('click', close);
      $('pv-cart-chat-btn')?.addEventListener('click', openCartChat);
      $('pv-cart-email-all-btn')?.addEventListener('click', openCartEmail);
      $('pv-cart-save-btn')?.addEventListener('click', openSaveCart);
      $('pv-cart-save-close')?.addEventListener('click', closeSaveCart);
      document.querySelector('#pv-cart-save-modal .pv-modal-backdrop')?.addEventListener('click', closeSaveCart);
      $('pv-cart-save-go')?.addEventListener('click', saveCartGo);
      $('pv-cart-save-name')?.addEventListener('keydown', e => { if (e.key === 'Enter') saveCartGo(); });
      $('pv-cart-repo-btn')?.addEventListener('click', openRepoCarts);
      $('pv-cart-repo-close')?.addEventListener('click', closeRepoCarts);
      document.querySelector('#pv-cart-repo-modal .pv-modal-backdrop')?.addEventListener('click', closeRepoCarts);
      $('pv-cart-transfer-btn')?.addEventListener('click', openTransferCart);
      $('pv-cart-transfer-close')?.addEventListener('click', closeTransferCart);
      document.querySelector('#pv-cart-transfer-modal .pv-modal-backdrop')?.addEventListener('click', closeTransferCart);
      $('pv-cart-transfer-go')?.addEventListener('click', transferCartGo);
      $('pv-cart-show-in-list')?.addEventListener('click', () => {
        const items = window.PPCart?.getAll() || [];
        if (!items.length) { alert('El carrito está vacío.'); return; }
        close();
        _setIsolatedArticleId(items.map(a => a.id));
        loadArticles();
      });
      $('pv-cart-remove-unselected')?.addEventListener('click', () => {
        const items = window.PPCart?.getAll() || [];
        const unselected = items.filter(a => !_selected.has(a.id));
        if (!unselected.length) { alert('No hay artículos sin seleccionar que quitar.'); return; }
        if (!confirm(`¿Quitar del carrito los ${unselected.length} artículo${unselected.length === 1 ? '' : 's'} no seleccionado${unselected.length === 1 ? '' : 's'}?`)) return;
        unselected.forEach(a => window.PPCart?.remove(a.id));
        render();
      });
      $('pv-cart-clear-all')?.addEventListener('click', () => {
        const items = window.PPCart?.getAll() || [];
        if (!items.length) return;
        if (!confirm(`¿Vaciar el carrito? Se quitarán los ${items.length} artículo${items.length === 1 ? '' : 's'}.`)) return;
        window.PPCart?.clear();
        _selected.clear();
        // An emptied cart has no way to dismiss itself otherwise (no
        // "close" affordance once the list is blank) — close the panel
        // instead of leaving a permanently-empty sidebar open.
        close();
      });
      $('pv-cart-select-all')?.addEventListener('change', (e) => {
        const items = window.PPCart?.getAll() || [];
        if (e.target.checked) items.forEach(a => _selected.add(a.id));
        else _selected.clear();
        render();
      });
      $('pv-cart-actions-btn')?.addEventListener('click', openActions);
      $('pv-cart-actions-close')?.addEventListener('click', closeActions);
      document.querySelector('#pv-cart-actions-modal .pv-modal-backdrop')?.addEventListener('click', closeActions);
      $('pv-cart-action-email')?.addEventListener('click', actionEmail);
      $('pv-cart-action-prionpacks')?.addEventListener('click', actionPrionPacks);
      $('pv-cart-email-close')?.addEventListener('click', closeBulkEmail);
      document.querySelector('#pv-cart-email-modal .pv-modal-backdrop')?.addEventListener('click', closeBulkEmail);
      $('pv-cart-email-send')?.addEventListener('click', sendBulkEmail);
      $('pv-cart-email-to')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendBulkEmail(); });
      // Cart changes elsewhere (row toggle, detail modal, etc.) should
      // keep the open modal's list in sync.
      window.addEventListener('pp-cart-changed', () => {
        if ($('pv-cart-modal')?.style.display !== 'none') render();
      });
    }

    document.getElementById('pv-cart-btn')?.addEventListener('click', open);

    return { open };
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
      const toSummaryBtn = $('pv-note-to-summary');
      if (toSummaryBtn) toSummaryBtn.style.display = _activeId != null ? 'inline-flex' : 'none';
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

    function openAiNoteModal() {
      if (!_article) return;
      if (nextFreeIndex() == null) {
        alert('Ya tienes las 5 notas máximas en este artículo. Elimina alguna antes de generar una nueva con IA.');
        return;
      }
      const modal = $('pv-note-ai-modal');
      if (!modal) return;
      const input = $('pv-note-ai-input');
      if (input) input.value = '';
      const status = $('pv-note-ai-status');
      if (status) status.textContent = '';
      modal.style.display = 'flex';
      setTimeout(() => input?.focus(), 50);
    }
    function closeAiNoteModal() {
      const modal = $('pv-note-ai-modal');
      if (modal) modal.style.display = 'none';
    }

    async function generateAiNote() {
      const input = $('pv-note-ai-input');
      const text = (input?.value || '').trim();
      const status = $('pv-note-ai-status');
      if (!text) {
        if (status) { status.style.color = '#b91c1c'; status.textContent = 'Escribe el texto para la nota.'; }
        return;
      }
      const btn = $('pv-note-ai-generate');
      if (btn) btn.disabled = true;
      if (status) { status.style.color = '#9ca3af'; status.textContent = 'Generando…'; }
      try {
        const r = await api(`/articles/${_article.id}/notes/ai-generate`, {
          method: 'POST',
          body: JSON.stringify({ text }),
        });
        _notes.push(r.note);
        closeAiNoteModal();
        selectNote(r.note.id);
        _refreshNoteClusters(_article.id, _notes, _article);
        const noteStatus = $('pv-note-status');
        if (noteStatus) {
          const label = _AI_DIAG_PROVIDER_LABEL[r.provider] || r.provider;
          if (r.switched) {
            const reqLabel = _AI_DIAG_PROVIDER_LABEL[r.requested_provider] || r.requested_provider;
            noteStatus.style.color = '#b45309';
            noteStatus.textContent = `✓ Generada con ${label} (${reqLabel} no pudo responder)`;
          } else {
            noteStatus.style.color = '#15803d';
            noteStatus.textContent = `✓ Generada con ${label}`;
          }
          setTimeout(() => { if (noteStatus) noteStatus.textContent = ''; }, 3500);
        }
      } catch (e) {
        if (e.status === 409) {
          const noteText = (e.body && e.body.note_text) || '';
          closeAiNoteModal();
          if (noteText && confirm(
            `Ya tienes las 5 notas máximas en este artículo, así que no se pudo guardar.\n\n` +
            `Nota generada:\n"${noteText}"\n\n¿Copiarla al portapapeles?`
          )) {
            navigator.clipboard.writeText(noteText).catch(() => {});
          }
        } else {
          let detail = e.message || 'Error desconocido';
          if (e.body && e.body.attempts && e.body.attempts.length) {
            detail += ' — ' + e.body.attempts
              .map(a => `${_AI_DIAG_PROVIDER_LABEL[a.provider] || a.provider}: ${a.reason}`).join('; ');
          }
          if (status) { status.style.color = '#b91c1c'; status.textContent = 'Error: ' + detail; }
        }
      } finally {
        if (btn) btn.disabled = false;
      }
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
      $('pv-note-ai-btn')?.addEventListener('click', openAiNoteModal);
      $('pv-note-ai-close')?.addEventListener('click', closeAiNoteModal);
      document.querySelector('#pv-note-ai-modal .pv-modal-backdrop')?.addEventListener('click', closeAiNoteModal);
      $('pv-note-ai-generate')?.addEventListener('click', generateAiNote);
      $('pv-note-ai-input')?.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); generateAiNote(); }
      });
      $('pv-note-to-summary')?.addEventListener('click', () => {
        if (_activeId == null) return;
        const note = _notes.find(n => n.id === _activeId);
        if (!note) return;
        const plain = htmlToText(sanitize(note.body || '')).trim();
        if (!plain) { alert('Esta nota está vacía.'); return; }
        PVSummaryNotes.open(_article.id, { appendText: plain });
      });
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

  // ── Resumen IA — Notas del usuario modal ────────────────────────────────
  // Lets an admin append a "## Notas del usuario" section at the end of an
  // article's AI summary (always after Conclusiones, since that's the last
  // of the five generated sections). Re-editing replaces the section
  // instead of stacking duplicates; the backend re-embeds the summary_ai
  // chunk in the background so AI search picks up the new text.
  const PVSummaryNotes = (() => {
    let _articleId = null;
    let _onSaved = null;
    let _wired = false;

    function extractCurrentNotes(summaryAi) {
      const marker = '## Notas del usuario';
      const idx = (summaryAi || '').indexOf(marker);
      if (idx === -1) return '';
      return (summaryAi || '').slice(idx + marker.length).replace(/^\s*\n/, '').trim();
    }

    function wireOnce() {
      if (_wired) return;
      _wired = true;
      const modal = document.getElementById('pv-summary-notes-modal');
      if (!modal) return;
      const close = () => { modal.style.display = 'none'; };
      document.getElementById('pv-summary-notes-close')?.addEventListener('click', close);
      document.getElementById('pv-summary-notes-cancel')?.addEventListener('click', close);
      modal.querySelector('.pv-modal-backdrop')?.addEventListener('click', close);
      document.getElementById('pv-summary-notes-save')?.addEventListener('click', async () => {
        const statusEl = document.getElementById('pv-summary-notes-status');
        const saveBtn  = document.getElementById('pv-summary-notes-save');
        const text = document.getElementById('pv-summary-notes-text').value;
        saveBtn.disabled = true;
        if (statusEl) { statusEl.style.color = '#9ca3af'; statusEl.textContent = 'Guardando…'; }
        try {
          const r = await api(`/articles/${_articleId}/summary/user-notes`, {
            method: 'PATCH', body: JSON.stringify({ text }),
          });
          if (statusEl) { statusEl.style.color = '#15803d'; statusEl.textContent = '✓ Guardado — re-indexando en segundo plano.'; }
          if (_onSaved) _onSaved(r.summary_ai);
          setTimeout(close, 700);
        } catch (e) {
          if (statusEl) { statusEl.style.color = '#b91c1c'; statusEl.textContent = 'Error: ' + e.message; }
        } finally {
          saveBtn.disabled = false;
        }
      });
    }

    // opts.appendText: extra text to seed the textarea with (from a
    // sticky note), on top of whatever "Notas del usuario" already had.
    async function open(articleId, opts = {}) {
      wireOnce();
      _articleId = articleId;
      _onSaved = opts.onSaved || null;
      const modal = document.getElementById('pv-summary-notes-modal');
      const textEl = document.getElementById('pv-summary-notes-text');
      const statusEl = document.getElementById('pv-summary-notes-status');
      if (!modal || !textEl) return;
      statusEl.textContent = '';
      textEl.value = 'Cargando…';
      textEl.disabled = true;
      modal.style.display = 'flex';
      try {
        const fresh = await api(`/articles/${articleId}`);
        if (!fresh.summary_ai || !fresh.summary_ai.trim()) {
          modal.style.display = 'none';
          alert('Este artículo no tiene resumen IA todavía.');
          return;
        }
        let current = extractCurrentNotes(fresh.summary_ai);
        if (opts.appendText) {
          current = current ? `${current}\n\n${opts.appendText}` : opts.appendText;
        }
        textEl.value = current;
      } catch (e) {
        textEl.value = '';
        statusEl.style.color = '#b91c1c';
        statusEl.textContent = 'Error cargando el resumen: ' + e.message;
      } finally {
        textEl.disabled = false;
        textEl.focus();
      }
    }

    return { open };
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
              <button id="pv-ai-edit-notes"
                      title="Añadir/editar una sección 'Notas del usuario' al final del resumen"
                      style="padding:4px 10px;border-radius:6px;border:1px solid #ddd6fe;background:white;
                             font-size:11.5px;font-weight:600;color:#6d28d9;cursor:pointer;">
                ✎ Notas del usuario
              </button>` : ''}
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
      ? `<div style="margin-top:4px;font-size:11px;color:#9ca3af;display:flex;align-items:center;gap:6px;">
           <span>Modelo: ${esc(a.summary_ai_model)}</span>
           ${(IS_ADMIN && a.summary_ai_diagnostics) ? `
             <button id="pv-ai-diag-btn" type="button" title="Ver diagnóstico de la generación (cadena de fallback, errores por intento)"
                     style="border:none;background:none;color:#9ca3af;cursor:pointer;font-size:12px;
                            padding:0 2px;line-height:1;" aria-label="Diagnóstico">🛈</button>` : ''}
         </div>`
      : '';
    block.innerHTML = header + body + notesHtml + modelLine +
      `<div id="pv-ai-status" style="margin-top:6px;font-size:11.5px;color:#9ca3af;"></div>`;

    if (!IS_ADMIN) return;

    const diagBtn = document.getElementById('pv-ai-diag-btn');
    if (diagBtn) {
      diagBtn.addEventListener('click', () => openAiDiagModal(a));
    }

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

    const genBtn      = document.getElementById('pv-ai-generate');
    const clearBtn    = document.getElementById('pv-ai-clear');
    const editNotesBtn = document.getElementById('pv-ai-edit-notes');
    const statusEl    = document.getElementById('pv-ai-status');
    const provEl      = document.getElementById('pv-ai-provider');

    if (editNotesBtn) editNotesBtn.addEventListener('click', () => {
      PVSummaryNotes.open(a.id, {
        onSaved: (newSummary) => {
          a.summary_ai = newSummary;
          renderAiSummary(a);
          const s = document.getElementById('pv-ai-status');
          if (s) { s.style.color = '#15803d'; s.textContent = '✓ Notas del usuario actualizadas.'; }
        },
      });
    });

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
        a.summary_ai_diagnostics = r.summary_ai_diagnostics || null;
        a.has_summary_ai = true;
        renderAiSummary(a);
        // Keep the listing row's provider badge (Claude/GPT/Gemini) in sync —
        // it's rendered from a separate copy of the article fetched when the
        // list loaded, so without this it would keep showing whatever badge
        // (or none) was there before this generation, until the list reloads.
        try {
          _patchRowProviderBadge(a.id, a.summary_ai_provider);
        } catch (rowErr) {
          console.warn('No se pudo refrescar la insignia de proveedor en el listado:', rowErr);
        }
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
    if (jcBtn && (IS_ADMIN || IS_JC_RESPONSIBLE)) jcBtn.addEventListener('click', () => toggle(jcBtn, 'jc-mark', 'is_jc', r => {
      a.is_jc = !!r.is_jc;
      const fresh = renderPersonalChip(a, 'jc');
      jcBtn.outerHTML = fresh;
      document.getElementById('pv-detail-jc-convoke')?.remove();
      if (_jcConvocable(a) && (IS_ADMIN || IS_JC_RESPONSIBLE)) {
        document.getElementById('pv-detail-jc')?.insertAdjacentHTML('afterend', `
          <button id="pv-detail-jc-convoke" type="button"
                  title="Convocar Journal Club — enviar fecha/hora a todo el laboratorio"
                  style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;
                         font-size:12px;font-weight:600;cursor:pointer;
                         background:#fdf2f8;color:#9d174d;border:1px solid #fbcfe8;">
            <span style="font-size:12px;line-height:1;"><i class="fas fa-bullhorn"></i></span>
            Convocar
          </button>`);
        document.getElementById('pv-detail-jc-convoke')?.addEventListener('click', () => {
          PVJcConvoke.open(a);
        });
      }
      wirePersonalState(a);
    }));
    document.getElementById('pv-detail-jc-convoke')?.addEventListener('click', () => {
      PVJcConvoke.open(a);
    });
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

