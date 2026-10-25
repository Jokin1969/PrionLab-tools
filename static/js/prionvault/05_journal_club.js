  // ── Journal Club section in the detail modal ─────────────────────────
  const JC_FILE_ICONS = {
    pptx:    'fa-file-powerpoint',
    pdf:     'fa-file-pdf',
    word:    'fa-file-word',
    excel:   'fa-file-excel',
    image:   'fa-file-image',
    keynote: 'fa-file-image',
    other:   'fa-file',
  };
  const JC_FILE_COLORS = {
    pptx: '#c2410c', pdf: '#b91c1c', word: '#1d4ed8', excel: '#15803d',
    image: '#7c3aed', keynote: '#0e7490', other: '#6b7280',
  };

  // Sort direction persists across re-renders of the same modal session
  // (add/edit/delete all re-fetch and re-render) but always starts at
  // "newest first" — matches what the backend already returns by default.
  let _jcSortAsc = false;
  let _jcCurrentItems = [];

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
          <button id="pv-jc-sort-btn" type="button"
                  title="${_jcSortAsc ? 'Ordenado del más antiguo al más reciente — clic para invertir' : 'Ordenado del más reciente al más antiguo — clic para invertir'}"
                  style="margin-left:6px;padding:2px 7px;font-size:10.5px;font-weight:600;
                         border-radius:5px;border:1px solid #fce7f3;background:white;
                         color:#be185d;cursor:pointer;text-transform:none;letter-spacing:normal;
                         vertical-align:middle;">
            <i class="fas ${_jcSortAsc ? 'fa-arrow-up-short-wide' : 'fa-arrow-down-wide-short'}"></i> Fecha
          </button>
        </h3>
        <div style="display:flex;gap:6px;">
          ${(_jcConvocable(a) && !a.jc_count && (IS_ADMIN || IS_JC_RESPONSIBLE)) ? `
            <button id="pv-jc-convoke-btn" type="button"
                    title="Enviar el email de convocatoria a todo el laboratorio, con fecha/hora"
                    style="padding:4px 10px;font-size:12px;border-radius:6px;
                           border:1px solid #fbcfe8;background:#fdf2f8;color:#9d174d;
                           font-weight:600;cursor:pointer;">
              <i class="fas fa-bullhorn" style="margin-right:4px;"></i>Convocar
            </button>` : ''}
          <button id="pv-jc-add-btn" type="button"
                  style="padding:4px 10px;font-size:12px;border-radius:6px;
                         border:1px solid #fce7f3;background:white;color:#be185d;
                         font-weight:600;cursor:pointer;">
            <i class="fas fa-plus" style="margin-right:4px;"></i>Añadir presentación
          </button>
        </div>
      </div>`;
    sec.innerHTML = heading +
      `<div id="pv-jc-list" style="font-size:12.5px;color:#9ca3af;">Cargando…</div>`;

    // JC presentations are open to any logged-in user; the server's
    // creator-or-admin gate handles per-row edit / delete safety.
    wireJcAddButton(a);
    document.getElementById('pv-jc-convoke-btn')?.addEventListener('click', () => {
      PVJcConvoke.open(a);
    });
    document.getElementById('pv-jc-sort-btn')?.addEventListener('click', () => {
      _jcSortAsc = !_jcSortAsc;
      renderJcSection(a);
    });

    let data;
    try {
      data = await api(`/articles/${a.id}/jc`);
    } catch (e) {
      document.getElementById('pv-jc-list').innerHTML =
        `<div style="color:#b91c1c;">Error: ${esc(e.message)}</div>`;
      return;
    }
    _jcCurrentItems = data.items || [];
    renderJcList(a, _jcCurrentItems);
  }

  function renderJcList(a, items) {
    const list = document.getElementById('pv-jc-list');
    if (!list) return;
    items = [...items].sort((x, y) => {
      const dx = x.presented_at ? new Date(x.presented_at).getTime() : 0;
      const dy = y.presented_at ? new Date(y.presented_at).getTime() : 0;
      return _jcSortAsc ? dx - dy : dy - dx;
    });
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
      // Show edit / delete for the user who created the presentation,
      // and for admins (who can curate). Other readers see the row
      // but no action buttons — matches the server-side _ensure_can_modify
      // rule on PATCH and DELETE.
      const canEdit = IS_ADMIN || (p.created_by && p.created_by === USER_ID);
      const fileChips = (p.files || []).map(f => {
        const icon  = JC_FILE_ICONS[f.kind] || JC_FILE_ICONS.other;
        const color = JC_FILE_COLORS[f.kind] || JC_FILE_COLORS.other;
        return `
          <span style="display:inline-flex;align-items:center;border-radius:6px;
                       border:1px solid #e5e7eb;background:white;margin-right:5px;margin-top:4px;overflow:hidden;">
            <button type="button" class="pv-jc-file" data-fid="${esc(f.id)}"
                    title="Abrir ${esc(f.filename)} en una pestaña nueva"
                    style="display:inline-flex;align-items:center;gap:5px;border:none;background:none;
                           padding:3px 9px;color:${color};font-size:11.5px;font-weight:600;cursor:pointer;">
              <i class="fas ${icon}"></i>
              ${esc(f.filename)}
            </button>${canEdit ? `
            <button type="button" class="pv-jc-file-delete" data-fid="${esc(f.id)}" data-filename="${esc(f.filename)}"
                    title="Eliminar este fichero (también se borra de Dropbox)"
                    style="border:none;border-left:1px solid #e5e7eb;background:none;
                           padding:3px 7px;color:#b91c1c;font-size:11px;cursor:pointer;">
              <i class="fas fa-xmark"></i>
            </button>` : ''}
          </span>`;
      }).join('');
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

    // Open file in a new tab, rendered in-browser (never downloaded) —
    // the /view wrapper picks PDF.js / <img> / Office-viewer depending
    // on file kind.
    list.querySelectorAll('.pv-jc-file').forEach(b =>
      b.addEventListener('click', () => {
        window.open(API + `/jc/files/${b.dataset.fid}/view`, '_blank', 'noopener');
      }));

    // No IS_ADMIN gate here: canEdit (render time, above) already governs
    // whether these buttons exist in the DOM at all — a non-admin creator
    // gets them too, so querySelectorAll naturally finds nothing for
    // anyone else instead of needing a second, redundant check here.
    list.querySelectorAll('.pv-jc-file-delete').forEach(b =>
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`¿Eliminar «${b.dataset.filename}»? También se borra de Dropbox si ningún otro Journal Club lo usa.`)) return;
        try {
          await api(`/jc/files/${b.dataset.fid}`, { method: 'DELETE' });
          renderJcSection(a);
        } catch (e) { alert('Error: ' + e.message); }
      }));

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
      const done = () => { renderJcSection(a); loadArticles(); };
      // A free blue-book or reserved article goes through the
      // reservation flow (respects the lock); otherwise — e.g. adding a
      // second presentation — the usual add flow.
      if (!a.has_jc && !(a.jc_count > 0) && (a.is_jc || a.jc_claimed_by)) openJcButton(a, done);
      else openJcFlow(a, done);
    });
  }

  // ── Journal Club — upload modal ─────────────────────────────────────────
  // Replaces the old prompt()-based flow (asked for a date + presenter via
  // two browser prompt() dialogs). Now: pick document type(s), pick files
  // (accumulating across multiple picker opens), pick a responsable from
  // the user directory (or type one in), and the date is inferred from the
  // filename (yyyymmdd) — never asked.
  const PVJcUpload = (() => {
    let _article = null;
    let _onDone = null;
    let _wired = false;
    let _selectedTypes = new Set(['pptx']);
    let _pendingFiles = [];
    let _selectedPresenter = null;   // string or null
    let _usersLoaded = false;

    const fmtSize = (n) => n < 1024 * 1024
      ? `${Math.round(n / 1024)} KB`
      : `${(n / (1024 * 1024)).toFixed(1)} MB`;

    function acceptAttr() {
      const picker = document.getElementById('pv-jc-type-picker');
      const exts = [];
      picker.querySelectorAll('.pv-jc-type-btn').forEach(b => {
        if (_selectedTypes.has(b.dataset.type)) exts.push(...b.dataset.exts.split(','));
      });
      return exts.join(',');
    }

    const _TYPE_ACCENT = { pptx: '#c2410c', word: '#1d4ed8', excel: '#15803d',
                           pdf: '#b91c1c', image: '#7c3aed' };

    function paintTypeButtons() {
      document.querySelectorAll('.pv-jc-type-btn').forEach(b => {
        const on = _selectedTypes.has(b.dataset.type);
        const accent = _TYPE_ACCENT[b.dataset.type] || '#6b7280';
        b.style.borderColor = on ? accent : '#e5e7eb';
        b.style.background  = on ? (accent + '14') : '#fff';
        b.style.color       = on ? accent : '#6b7280';
      });
    }

    function renderFileList() {
      const box = document.getElementById('pv-jc-file-list');
      const addMoreBtn = document.getElementById('pv-jc-add-more');
      if (!_pendingFiles.length) {
        box.innerHTML = '';
        addMoreBtn.style.display = 'none';
      } else {
        box.innerHTML = _pendingFiles.map((f, i) => `
          <div data-i="${i}" style="display:flex;align-items:center;gap:8px;padding:5px 9px;
                      background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;margin-bottom:5px;">
            <span style="flex:1;min-width:0;font-size:12px;color:#374151;overflow:hidden;
                        text-overflow:ellipsis;white-space:nowrap;">${esc(f.name)}</span>
            <span style="font-size:10.5px;color:#9ca3af;flex-shrink:0;">${fmtSize(f.size)}</span>
            <button type="button" class="pv-jc-file-remove" data-i="${i}"
                    style="flex-shrink:0;background:none;border:none;color:#b91c1c;cursor:pointer;
                           font-size:13px;padding:0 2px;">✕</button>
          </div>`).join('');
        addMoreBtn.style.display = 'inline-flex';
        box.querySelectorAll('.pv-jc-file-remove').forEach(b => {
          b.addEventListener('click', () => {
            _pendingFiles.splice(parseInt(b.dataset.i, 10), 1);
            renderFileList();
            validate();
          });
        });
      }
      validate();
    }

    // Uses the static #pv-jc-file-input in the modal (not a dynamically
    // created-and-clicked <input>) — matches the one other file picker
    // in this modal set (pv-add-pdf) that's known to work reliably.
    function openPicker() {
      const input = document.getElementById('pv-jc-file-input');
      if (!input) return;
      input.accept = acceptAttr();
      input.value = '';   // so picking the same file twice still fires 'change'
      input.click();
    }

    async function loadPresenters() {
      const list = document.getElementById('pv-jc-presenter-list');
      try {
        const [dirR, meR] = await Promise.all([
          api('/users-directory'),
          api('/me').catch(() => null),
        ]);
        const users = dirR.users || [];
        const myName = (meR && meR.name) || '';
        const myEmail = (meR && meR.email || '').toLowerCase();
        // The logged-in user goes first — they're almost always the one
        // presenting, so it should be preselected, not something they
        // have to hunt for in an alphabetical list.
        if (myEmail) {
          const i = users.findIndex(u => (u.email || '').toLowerCase() === myEmail);
          if (i > 0) users.unshift(users.splice(i, 1)[0]);
          else if (i === -1 && myName) users.unshift({ name: myName, email: myEmail });
        }
        list.innerHTML = users.map(u => `
          <button type="button" class="pv-jc-presenter-btn" data-name="${esc(u.name || u.email)}"
                  style="padding:5px 11px;border-radius:16px;border:1.5px solid #e5e7eb;background:#fff;
                         color:#374151;font-size:12px;font-weight:600;cursor:pointer;">
            ${esc(u.name || u.email)}
          </button>`).join('') +
          `<button type="button" id="pv-jc-presenter-btn-other"
                   style="padding:5px 11px;border-radius:16px;border:1.5px dashed #9ca3af;background:#fff;
                          color:#6b7280;font-size:12px;font-weight:600;cursor:pointer;">
             Otro…
           </button>`;
        list.querySelectorAll('.pv-jc-presenter-btn').forEach(b => {
          b.addEventListener('click', () => selectPresenter(b.dataset.name, b));
        });
        document.getElementById('pv-jc-presenter-btn-other').addEventListener('click', () => {
          const other = document.getElementById('pv-jc-presenter-other');
          other.style.display = 'block';
          other.focus();
          selectPresenter(null, null);   // deselect until they type something
        });
        // Preselect the logged-in user (first button) by default.
        const firstBtn = list.querySelector('.pv-jc-presenter-btn');
        if (firstBtn) selectPresenter(firstBtn.dataset.name, firstBtn);
        _usersLoaded = true;
      } catch (e) {
        list.innerHTML = `<span style="font-size:12px;color:#b91c1c;">Error cargando usuarios: ${esc(e.message)}</span>`;
      }
    }

    function selectPresenter(name, btnEl) {
      _selectedPresenter = name;
      document.querySelectorAll('.pv-jc-presenter-btn').forEach(b => {
        const on = b === btnEl;
        b.style.borderColor = on ? '#be185d' : '#e5e7eb';
        b.style.background  = on ? '#fdf2f8' : '#fff';
        b.style.color       = on ? '#be185d' : '#374151';
      });
      const otherBtn = document.getElementById('pv-jc-presenter-btn-other');
      if (otherBtn) {
        const onOther = btnEl === null;
        otherBtn.style.borderColor = onOther ? '#be185d' : '#9ca3af';
        otherBtn.style.color = onOther ? '#be185d' : '#6b7280';
      }
      validate();
    }

    function currentPresenterName() {
      const otherInput = document.getElementById('pv-jc-presenter-other');
      if (otherInput && otherInput.style.display !== 'none') {
        return otherInput.value.trim();
      }
      return (_selectedPresenter || '').trim();
    }

    function validate() {
      const confirmBtn = document.getElementById('pv-jc-upload-confirm');
      const ok = _pendingFiles.length > 0 && currentPresenterName().length > 0;
      confirmBtn.disabled = !ok;
      confirmBtn.style.opacity = ok ? '1' : '0.5';
      confirmBtn.style.cursor = ok ? 'pointer' : 'not-allowed';
    }

    function reset() {
      _selectedTypes = new Set(['pptx']);
      _pendingFiles = [];
      _selectedPresenter = null;
      paintTypeButtons();
      renderFileList();
      const other = document.getElementById('pv-jc-presenter-other');
      if (other) { other.style.display = 'none'; other.value = ''; }
      const status = document.getElementById('pv-jc-upload-status');
      if (status) status.textContent = '';
      const warn = document.getElementById('pv-jc-existing-warn');
      if (warn) warn.style.display = 'none';
    }

    // Purely informational — lets whoever's uploading decide whether to
    // add another presentation or go add their file to the existing one
    // (via the 📎 button on the article's JC list) instead. Never blocks.
    async function warnIfExisting(article) {
      const warn = document.getElementById('pv-jc-existing-warn');
      const text = document.getElementById('pv-jc-existing-warn-text');
      if (!warn || !text) return;
      try {
        const data = await api(`/articles/${article.id}/jc`);
        const presentations = data.items || [];
        if (!presentations.length) {
          warn.style.display = 'none';
          return;
        }
        const names = [...new Set(presentations.map(p => p.presenter_name).filter(Boolean))];
        text.textContent = names.length
          ? `Este artículo ya tiene una presentación de Journal Club de ${names.join(', ')}. ` +
            'Si continúas se añadirá una presentación nueva; si querías sumar este archivo a la ' +
            'existente, ciérralo y usa el 📎 junto a ella.'
          : 'Este artículo ya tiene una presentación de Journal Club registrada.';
        warn.style.display = 'block';
      } catch (e) {
        warn.style.display = 'none';
      }
    }

    function wireOnce() {
      if (_wired) return;
      _wired = true;
      const modal = document.getElementById('pv-jc-upload-modal');
      const close = () => { modal.style.display = 'none'; };
      document.getElementById('pv-jc-upload-close')?.addEventListener('click', close);
      document.getElementById('pv-jc-upload-cancel')?.addEventListener('click', close);
      modal.querySelector('.pv-modal-backdrop')?.addEventListener('click', close);

      document.querySelectorAll('.pv-jc-type-btn').forEach(b => {
        b.addEventListener('click', () => {
          const t = b.dataset.type;
          if (_selectedTypes.has(t)) {
            if (_selectedTypes.size > 1) _selectedTypes.delete(t);  // keep >=1 selected
          } else {
            _selectedTypes.add(t);
          }
          paintTypeButtons();
        });
      });

      document.getElementById('pv-jc-pick-files')?.addEventListener('click', openPicker);
      document.getElementById('pv-jc-add-more')?.addEventListener('click', openPicker);
      document.getElementById('pv-jc-file-input')?.addEventListener('change', (e) => {
        for (const f of e.target.files || []) _pendingFiles.push(f);
        renderFileList();
      });

      const dropzone = document.getElementById('pv-jc-dropzone');
      if (dropzone) {
        ['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, (e) => {
          e.preventDefault(); e.stopPropagation();
          dropzone.style.background = '#fce7f3';
          dropzone.style.borderColor = '#be185d';
        }));
        ['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, (e) => {
          e.preventDefault(); e.stopPropagation();
          dropzone.style.background = '#fdf2f8';
          dropzone.style.borderColor = '#f3a8ca';
        }));
        dropzone.addEventListener('drop', (e) => {
          for (const f of e.dataTransfer?.files || []) _pendingFiles.push(f);
          renderFileList();
        });
      }
      document.getElementById('pv-jc-presenter-other')?.addEventListener('input', validate);

      document.getElementById('pv-jc-upload-confirm')?.addEventListener('click', async () => {
        const confirmBtn = document.getElementById('pv-jc-upload-confirm');
        const status = document.getElementById('pv-jc-upload-status');
        const presenterName = currentPresenterName();
        if (!_pendingFiles.length || !presenterName) return;
        confirmBtn.disabled = true;
        status.style.color = '#9ca3af';
        status.textContent = `Subiendo ${_pendingFiles.length} documento(s)…`;
        try {
          const fd = new FormData();
          fd.append('presenter_name', presenterName);
          for (const f of _pendingFiles) fd.append('file', f, f.name);
          const r = await fetch(API + `/articles/${_article.id}/jc`, {
            method: 'POST', credentials: 'same-origin', body: fd,
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) {
            throw new Error(data.detail || data.error || ('HTTP ' + r.status));
          }
          close();
          // A successful upload tags the article "Journal Club – Ok"
          // server-side — refresh the sidebar tag list so it (and its
          // count) shows up without needing a full page reload.
          refreshTags();
          if (data.file_errors && data.file_errors.length) {
            alert(
              `Presentación guardada, pero ${data.file_errors.length} de ` +
              `${_pendingFiles.length} documento(s) no se pudieron subir:\n\n` +
              data.file_errors.map(x => `• ${x.filename}: ${x.error}`).join('\n') +
              '\n\nPuedes añadirlos de nuevo con el clip (📎) junto a la presentación.'
            );
          }
          if (_onDone) _onDone();
        } catch (e) {
          status.style.color = '#b91c1c';
          status.textContent = 'Error: ' + e.message;
          confirmBtn.disabled = false;
        }
      });
    }

    function open(article, onDone) {
      wireOnce();
      _article = article;
      _onDone = onDone;
      reset();
      document.getElementById('pv-jc-upload-modal').style.display = 'flex';
      loadPresenters();
      warnIfExisting(article);
    }

    return { open };
  })();

  // ── Journal Club — choice gate ───────────────────────────────────────────
  // The "JC" button used to always jump straight to PVJcUpload. Now, for an
  // article that isn't marked for JC yet AND has no presentation, it offers
  // a choice first: ask the JC-responsible(s) to consider it (an email, no
  // upload needed), or go ahead and add a presentation directly (the old
  // flow, unchanged). Already-JC articles skip this and go straight to
  // PVJcUpload, exactly as before.
  function _articleNeedsJcChoice(a) {
    if (!a) return false;
    const hasPresentation = a.has_jc || (a.jc_count || 0) > 0;
    return !a.is_jc && !hasPresentation;
  }

  const PVJcChoice = (() => {
    const $ = id => document.getElementById(id);
    let _article = null;
    let _onAddPresentation = null;
    let _wired = false;

    function close() { const m = $('pv-jc-choice-modal'); if (m) m.style.display = 'none'; }

    function setStatus(msg, isError) {
      const el = $('pv-jc-choice-status');
      if (!el) return;
      el.style.color = isError ? '#b91c1c' : '#15803d';
      el.textContent = msg || '';
    }

    async function requestFromResponsible() {
      if (!_article) return;
      const btn = $('pv-jc-choice-request');
      if (btn) btn.disabled = true;
      setStatus('Enviando…', false);
      try {
        const r = await api(`/articles/${_article.id}/jc-request`, { method: 'POST' });
        setStatus(`✓ Enviado a ${(r.sent || []).length} persona${(r.sent || []).length === 1 ? '' : 's'} (responsable de Journal Club y administradores).`, false);
        setTimeout(close, 1600);
      } catch (e) {
        if (e.status === 400 && /no_jc_responsible/.test(e.message || '')) {
          setStatus('No hay ningún usuario marcado como responsable de Journal Club (Panel de administración → Users).', true);
        } else {
          setStatus('Error: ' + (e.message || e), true);
        }
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    function wireOnce() {
      if (_wired) return;
      _wired = true;
      $('pv-jc-choice-close')?.addEventListener('click', close);
      document.querySelector('#pv-jc-choice-modal .pv-modal-backdrop')?.addEventListener('click', close);
      $('pv-jc-choice-request')?.addEventListener('click', requestFromResponsible);
      $('pv-jc-choice-present')?.addEventListener('click', () => {
        close();
        if (_onAddPresentation) _onAddPresentation();
      });
    }

    function open(article, onAddPresentation) {
      _article = article;
      _onAddPresentation = onAddPresentation;
      wireOnce();
      const modal = $('pv-jc-choice-modal');
      if (!modal) return;
      setStatus('', false);
      const reqBtn = $('pv-jc-choice-request');
      if (reqBtn) reqBtn.disabled = false;
      modal.style.display = 'flex';
    }

    return { open };
  })();

  // "Convocar" button — sends the actual lab-wide announcement (date/
  // time/location) once the responsible has picked a slot for an
  // article already marked is_jc but not yet presented.
  const PVJcConvoke = (() => {
    const $ = id => document.getElementById(id);
    let _article = null;
    let _wired = false;

    function close() { const m = $('pv-jc-convoke-modal'); if (m) m.style.display = 'none'; }

    function setStatus(msg, isError) {
      const el = $('pv-jc-convoke-status');
      if (!el) return;
      el.style.color = isError ? '#b91c1c' : '#15803d';
      el.textContent = msg || '';
    }

    function _fmtWhen(dtLocalVal) {
      if (!dtLocalVal) return '';
      const d = new Date(dtLocalVal);
      if (isNaN(d.getTime())) return '';
      const dateStr = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
      const timeStr = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
      return `${dateStr.charAt(0).toUpperCase()}${dateStr.slice(1)}, ${timeStr}`;
    }

    async function send() {
      if (!_article) return;
      const whenVal = ($('pv-jc-convoke-when')?.value || '').trim();
      if (!whenVal) {
        setStatus('Indica cuándo es la sesión (fecha y hora).', true);
        return;
      }
      const whenText = _fmtWhen(whenVal);
      const scheduleVal = ($('pv-jc-convoke-schedule')?.value || '').trim();
      const btn = $('pv-jc-convoke-send');
      if (btn) { btn.disabled = true; }
      setStatus(scheduleVal ? 'Programando…' : 'Enviando a todo el laboratorio…', false);
      try {
        const payload = {
          when_text: whenText,
          presenter_name: ($('pv-jc-convoke-presenter')?.value || '').trim(),
          location_text: ($('pv-jc-convoke-where')?.value || '').trim(),
          notes: ($('pv-jc-convoke-notes')?.value || '').trim(),
        };
        if (scheduleVal) payload.scheduled_at = new Date(scheduleVal).toISOString();
        const r = await api(`/articles/${_article.id}/jc-convocation`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setStatus(r.scheduled
          ? `✓ Convocatoria programada.`
          : `✓ Convocatoria enviada a ${r.recipients} persona${r.recipients === 1 ? '' : 's'}.`, false);
        setTimeout(close, 1800);
        setTimeout(() => { if (btn) btn.disabled = false; }, 2000);  // no double send before close
      } catch (e) {
        setStatus('Error: ' + (e.message || e), true);
        if (btn) btn.disabled = false;
      }
    }

    function wireOnce() {
      if (_wired) return;
      _wired = true;
      $('pv-jc-convoke-close')?.addEventListener('click', close);
      document.querySelector('#pv-jc-convoke-modal .pv-modal-backdrop')?.addEventListener('click', close);
      $('pv-jc-convoke-send')?.addEventListener('click', send);
    }

    function open(article) {
      _article = article;
      wireOnce();
      const modal = $('pv-jc-convoke-modal');
      if (!modal) return;
      setStatus('', false);
      const titleEl = $('pv-jc-convoke-article-title');
      if (titleEl) titleEl.textContent = article.title || '(sin título)';
      ['pv-jc-convoke-when', 'pv-jc-convoke-notes', 'pv-jc-convoke-schedule'].forEach(id => {
        const el = $(id); if (el) el.value = '';
      });
      const whereEl = $('pv-jc-convoke-where');
      if (whereEl) whereEl.value = 'Sala de seminarios';
      // Who presents: PrionVault already knows it when the article was
      // reserved — prefill it (editable), so it never has to go in Notes.
      const presEl = $('pv-jc-convoke-presenter');
      const presHint = $('pv-jc-convoke-presenter-hint');
      const fillPresenter = (name) => {
        if (presEl) presEl.value = name || '';
        if (presHint) presHint.textContent = name ? '(quien reservó el artículo — puedes cambiarlo)' : '(opcional)';
      };
      fillPresenter(article.jc_claimed_by_name || '');
      if (!article.jc_claimed_by_name && article.id) {
        api(`/articles/${article.id}/jc-state`)
          .then(st => { if (st.jc_claimed_by_name && presEl && !presEl.value) fillPresenter(st.jc_claimed_by_name); })
          .catch(() => {});
      }
      const sendBtn = $('pv-jc-convoke-send');
      if (sendBtn) sendBtn.disabled = false;
      modal.style.display = 'flex';
      setTimeout(() => $('pv-jc-convoke-when')?.focus(), 50);
    }

    return { open };
  })();

  // ── Journal Club reservation flow ────────────────────────────────────
  // A blue-book (is_jc) article picked by someone to present is RESERVED:
  // its JC button turns red and locked, and it leaves the blue-book list.
  // Announcing the session (Convocar) unlocks it for the presenter, who
  // then uploads the presentation; after that the button is green and
  // opens "Gestión de Journal clubs" on that article.
  function _jcConvocable(a) {
    return !!(a && (a.is_jc || (a.jc_claimed_by && !a.has_jc && !(a.jc_count > 0))));
  }
  function _jcReserved(a) {
    return !!(a && a.jc_claimed_by && !a.has_jc && !(a.jc_count > 0));
  }
  // Style + tooltip for every "JC" text button (listing, cart).
  function _jcButtonLook(a) {
    if (a.has_jc || a.jc_count > 0) {
      return { css: 'background:#14532d;color:#fef08a;', label: 'JC',
               title: 'Presentado en Journal Club — clic para verlo en Gestión de Journal clubs' };
    }
    if (_jcReserved(a)) {
      const who = a.jc_claimed_by_name || 'otra persona';
      return a.jc_announced_at
        ? { css: 'background:#b91c1c;color:#fff;', label: 'JC',
            title: `Reservado para que lo presente ${who} — sesión anunciada: ya se puede subir la presentación` }
        : { css: 'background:#b91c1c;color:#fff;', label: '🔒 JC',
            title: `Reservado para que lo presente ${who} — bloqueado hasta que se anuncie la sesión` };
    }
    if (a.is_jc) {
      return { css: 'background:#dbeafe;color:#1d4ed8;', label: 'JC',
               title: 'Disponible para Journal Club — clic para presentarlo tú' };
    }
    return { css: 'background:#f3f4f6;color:#9ca3af;', label: 'JC',
             title: 'Sin presentación de Journal Club — clic para añadir una' };
  }

  const PVJcClaim = (() => {
    const $ = id => document.getElementById(id);
    let _wired = false;
    let _onDone = null;
    let _state = null;

    function close() { const m = $('pv-jc-claim-modal'); if (m) m.style.display = 'none'; }
    function body(html) { $('pv-jc-claim-body').innerHTML = html; }
    function btn(id, label, primary, color) {
      const bg = primary ? (color || '#0F3460') : '#fff';
      const fg = primary ? '#fff' : '#374151';
      const border = primary ? 'none' : '1px solid #d1d5db';
      return `<button type="button" id="${id}" style="padding:8px 16px;border-radius:8px;border:${border};
                background:${bg};color:${fg};font-size:13px;font-weight:600;cursor:pointer;">${label}</button>`;
    }
    function fmt(iso) {
      return iso ? new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    }
    function articleCard(st) {
      const meta = [st.authors ? st.authors.split(';')[0].trim() + (st.authors.includes(';') ? ' et al.' : '') : '',
                    st.journal, st.year].filter(Boolean).join(' · ');
      const links = [
        st.has_pdf ? `<a href="${API}/articles/${esc(st.id)}/pdf-view" target="_blank" rel="noopener" style="color:#b91c1c;font-weight:600;text-decoration:none;"><i class="fas fa-file-pdf"></i> PDF</a>` : '',
        st.doi ? `<a href="https://doi.org/${encodeURIComponent(st.doi)}" target="_blank" rel="noopener" style="color:#0F3460;text-decoration:none;">DOI: ${esc(st.doi)}</a>` : '',
        st.pubmed_id ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${esc(st.pubmed_id)}/" target="_blank" rel="noopener" style="color:#0F3460;text-decoration:none;">PMID: ${esc(st.pubmed_id)}</a>` : '',
      ].filter(Boolean).join(' &nbsp;·&nbsp; ');
      return `
        <div style="border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;background:#f9fafb;margin:10px 0 14px;">
          <div style="font-size:14px;font-weight:700;color:#111827;line-height:1.4;">${supHtml(st.title || '(sin título)')}</div>
          ${meta ? `<div style="font-size:12px;color:#6b7280;margin-top:3px;">${esc(meta)}</div>` : ''}
          ${links ? `<div style="font-size:11.5px;margin-top:5px;">${links}</div>` : ''}
          ${st.abstract ? `<div style="font-size:12.5px;color:#374151;line-height:1.55;margin-top:9px;max-height:220px;overflow-y:auto;">${esc(st.abstract)}</div>` : ''}
        </div>`;
    }
    function respNames(st) {
      const n = (st.responsibles || []).filter(Boolean);
      if (!n.length) return 'el responsable de Journal Club';
      return n.length === 1 ? n[0] : n.slice(0, -1).join(', ') + ' y ' + n[n.length - 1];
    }

    function stepIdentity() {
      const me = _state.viewer.name || '(usuario sin nombre)';
      body(`
        <p style="font-size:14px;color:#111827;margin:4px 0 6px;">Vas a reservar este artículo para presentarlo en Journal Club.</p>
        <p style="font-size:14px;color:#111827;margin:0 0 16px;">¿Eres <strong>${esc(me)}</strong>?</p>
        <div style="display:flex;gap:8px;">${btn('pv-jcc-yes', 'Sí, soy yo', true)}${btn('pv-jcc-no', 'No')}</div>`);
      $('pv-jcc-yes').onclick = stepConfirm;
      $('pv-jcc-no').onclick = () => body(`
        <p style="font-size:13.5px;color:#374151;line-height:1.55;">
          Entonces no se reserva nada. Si has entrado con la cuenta de otra persona, cierra sesión y entra con la tuya
          para que la reserva quede a tu nombre.</p>
        <div style="margin-top:14px;">${btn('pv-jcc-close', 'Cerrar', true)}</div>`);
      $('pv-jcc-no').addEventListener('click', () => { const c = $('pv-jcc-close'); if (c) c.onclick = close; });
    }

    function stepConfirm() {
      body(`
        <p style="font-size:14px;color:#111827;margin:4px 0 0;">¿Quieres presentar este artículo en Journal Club?</p>
        ${articleCard(_state)}
        <div style="display:flex;gap:8px;align-items:center;">
          ${btn('pv-jcc-accept', '✓ Sí, quiero presentarlo', true, '#15803d')}${btn('pv-jcc-cancel', 'Cancelar')}
          <span id="pv-jcc-status" style="font-size:12.5px;color:#6b7280;"></span>
        </div>`);
      $('pv-jcc-cancel').onclick = close;
      $('pv-jcc-accept').onclick = async () => {
        $('pv-jcc-accept').disabled = true;
        $('pv-jcc-status').textContent = 'Reservando…';
        try {
          const r = await api(`/articles/${_state.id}/jc-claim`, { method: 'POST' });
          _state.responsibles = r.responsibles || _state.responsibles;
          const note = r.email_sent ? ''
            : `<p style="font-size:12px;color:#b45309;margin-top:10px;">No se pudo enviar el aviso por email${r.email_error ? ' (' + esc(r.email_error) + ')' : ''}; coméntaselo directamente.</p>`;
          body(`
            <div style="font-size:30px;margin:2px 0 6px;">🎉</div>
            <p style="font-size:14.5px;color:#111827;font-weight:700;margin:0 0 6px;">¡Fenomenal, ${esc(_state.viewer.name || '')}!</p>
            <p style="font-size:13.5px;color:#374151;line-height:1.6;margin:0;">
              El artículo queda reservado para ti: nadie más podrá cogerlo y ya no aparece como disponible para Journal Club.
              Hemos avisado a <strong>${esc(respNames(_state))}</strong>, que te dirá cuándo será tu presentación.
              Cuando se anuncie la sesión se desbloqueará el botón <strong>JC</strong> de este artículo para que subas tu presentación.</p>
            ${note}
            <div style="margin-top:16px;">${btn('pv-jcc-ok', 'Entendido', true)}</div>`);
          $('pv-jcc-ok').onclick = () => { close(); if (_onDone) _onDone(); };
        } catch (e) {
          $('pv-jcc-status').style.color = '#b91c1c';
          $('pv-jcc-status').textContent = 'Error: ' + e.message;
          $('pv-jcc-accept').disabled = false;
          if (e.status === 409 && _onDone) _onDone();
        }
      };
    }

    function stepReserved() {
      const st = _state;
      const who = st.jc_claimed_by_name || 'otra persona';
      const since = st.jc_claimed_at ? ` desde el ${fmt(st.jc_claimed_at)}` : '';
      const announced = st.jc_announced_at
        ? `<p style="font-size:12.5px;color:#15803d;margin:6px 0 0;">✓ Sesión anunciada el ${fmt(st.jc_announced_at)} — ya puede subir la presentación.</p>`
        : `<p style="font-size:12.5px;color:#b45309;margin:6px 0 0;">🔒 Bloqueado hasta que se anuncie la sesión (botón «Convocar»).</p>`;
      if (st.viewer.is_manager) {
        body(`
          <p style="font-size:13.5px;color:#111827;margin:4px 0 0;">Reservado para que lo presente <strong>${esc(who)}</strong>${esc(since)}.</p>
          ${announced}
          ${articleCard(st)}
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            ${btn('pv-jcc-upload', 'Subir presentación', true, '#15803d')}
            ${st.jc_announced_at ? '' : btn('pv-jcc-unlock', '🔓 Desbloquear para ' + esc(who.split(' ')[0]))}
            ${btn('pv-jcc-release', 'Liberar (vuelve a estar disponible)', true, '#b91c1c')}
            <span id="pv-jcc-status" style="font-size:12.5px;color:#6b7280;"></span>
          </div>`);
        $('pv-jcc-upload').onclick = () => { close(); PVJcUpload.open(st, _onDone); };
        if ($('pv-jcc-unlock')) $('pv-jcc-unlock').onclick = () => act('jc-unlock', 'Desbloqueado.');
        $('pv-jcc-release').onclick = () => {
          if (!confirm(`¿Liberar este artículo? ${who} dejará de tenerlo reservado y volverá a aparecer como disponible para Journal Club.`)) return;
          act('jc-release', 'Liberado.');
        };
      } else if (st.viewer.is_claimant) {
        body(`
          <p style="font-size:13.5px;color:#374151;line-height:1.6;margin:4px 0 0;">
            Tienes este artículo reservado para presentarlo${esc(since)}. Podrás subir la presentación en cuanto
            <strong>${esc(respNames(st))}</strong> anuncie la sesión.</p>
          ${articleCard(st)}
          <div>${btn('pv-jcc-close', 'Cerrar', true)}</div>`);
        $('pv-jcc-close').onclick = close;
      } else {
        body(`
          <p style="font-size:13.5px;color:#374151;line-height:1.6;margin:4px 0 0;">
            🔒 Este artículo está reservado para que lo presente <strong>${esc(who)}</strong>${esc(since)} en Journal Club.
            Solo ${esc(respNames(st))} o un administrador pueden liberarlo.</p>
          <div style="margin-top:14px;">${btn('pv-jcc-close', 'Cerrar', true)}</div>`);
        $('pv-jcc-close').onclick = close;
      }
    }

    async function act(endpoint, okMsg) {
      const status = $('pv-jcc-status');
      if (status) { status.style.color = '#6b7280'; status.textContent = 'Guardando…'; }
      try {
        await api(`/articles/${_state.id}/${endpoint}`, { method: 'POST' });
        if (status) { status.style.color = '#15803d'; status.textContent = '✓ ' + okMsg; }
        setTimeout(() => { close(); if (_onDone) _onDone(); }, 900);
      } catch (e) {
        if (status) { status.style.color = '#b91c1c'; status.textContent = 'Error: ' + e.message; }
      }
    }

    function wireOnce() {
      if (_wired) return;
      _wired = true;
      $('pv-jc-claim-close')?.addEventListener('click', close);
      document.querySelector('#pv-jc-claim-modal .pv-modal-backdrop')?.addEventListener('click', close);
    }

    function show(state, mode, onDone) {
      wireOnce();
      _state = state; _onDone = onDone;
      $('pv-jc-claim-modal').style.display = 'flex';
      if (mode === 'claim') stepIdentity(); else stepReserved();
    }
    return { show };
  })();

  // Single entry point for every JC button (listing, cart, detail). Always
  // re-reads the article's JC state from the server, so a stale row can't
  // let two people reserve the same article.
  async function openJcButton(article, onDone) {
    let st;
    try {
      st = await api(`/articles/${article.id}/jc-state`);
    } catch (e) {
      alert('No se pudo consultar el Journal Club de este artículo: ' + e.message);
      return;
    }
    if (st.has_jc) {
      PVJcManage.open(st.title || '');
      return;
    }
    if (st.jc_claimed_by) {
      if (st.viewer.is_claimant && st.jc_announced_at && !st.viewer.is_manager) {
        PVJcUpload.open(st, onDone);
        return;
      }
      PVJcClaim.show(st, 'reserved', onDone);
      return;
    }
    if (st.is_jc) {
      PVJcClaim.show(st, 'claim', onDone);
      return;
    }
    openJcFlow(st, onDone);
  }

  // Shared entry point for every "JC" button: gates on whether the
  // article already needs no choice (already JC / already has a
  // presentation) before falling into PVJcUpload.
  function openJcFlow(article, onDone) {
    if (_articleNeedsJcChoice(article)) {
      PVJcChoice.open(article, () => PVJcUpload.open(article, onDone));
    } else {
      PVJcUpload.open(article, onDone);
    }
  }

  // ── Journal Club — find-article modal ───────────────────────────────────
  // Entry point for the sidebar "Añadir Journal clubs" link (open to every
  // role). Locates an EXISTING article by DOI/PMID or by matching a PDF's
  // content, shows a preview, and on confirmation hands off to
  // PVJcUpload — the same modal used from inside an article's detail view.
  const PVJcFind = (() => {
    let _wired = false;
    let _matched = null;

    function showPreview(article) {
      const box  = document.getElementById('pv-jc-find-preview');
      const body = document.getElementById('pv-jc-find-preview-body');
      const form = document.getElementById('pv-jc-find-form');
      _matched = article;
      form.style.display = 'none';
      box.style.display = 'block';
      const bits = [article.authors, article.year, article.journal].filter(Boolean).join(' · ');
      const ids = [article.doi ? `DOI: ${esc(article.doi)}` : '',
                   article.pubmed_id ? `PMID: ${esc(article.pubmed_id)}` : '']
                  .filter(Boolean).join(' · ');
      body.innerHTML = `
        <div style="font-weight:700;">${esc(article.title || '(sin título)')}</div>
        ${bits ? `<div style="color:#6b7280;font-size:12px;margin-top:2px;">${esc(bits)}</div>` : ''}
        ${ids  ? `<div style="margin-top:6px;font-size:11px;color:#9ca3af;">${ids}</div>` : ''}`;
    }

    let _bulkImportPollTimer = null;

    function reset() {
      document.getElementById('pv-jc-find-form').style.display = '';
      document.getElementById('pv-jc-find-preview').style.display = 'none';
      document.getElementById('pv-jc-find-identifier').value = '';
      const status = document.getElementById('pv-jc-find-status');
      status.textContent = '';
      status.style.color = '#9ca3af';
      _matched = null;
      _bulkImportPollTimer && clearTimeout(_bulkImportPollTimer);
      const progress = document.getElementById('pv-jc-find-bulk-progress');
      if (progress) progress.style.display = 'none';
      const result = document.getElementById('pv-jc-find-bulk-result');
      if (result) { result.style.display = 'none'; result.innerHTML = ''; }
      const btn = document.getElementById('pv-jc-find-bulk-btn');
      if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
      const presenterInput = document.getElementById('pv-jc-find-bulk-presenter');
      if (presenterInput) presenterInput.value = '';
    }

    async function startBulkImport() {
      const presenterInput = document.getElementById('pv-jc-find-bulk-presenter');
      const presenterName = (presenterInput.value || '').trim();
      if (!presenterName) {
        alert('Escribe primero el nombre del responsable (tal cual la carpeta en Dropbox).');
        return;
      }
      if (!confirm(
        `Se va a recorrer la carpeta de Dropbox de "${presenterName}" (Journal clubs/${presenterName}/…) ` +
        'y crear una presentación por cada carpeta de fecha cuyo "Article ....pdf" se pueda ' +
        'identificar en PrionVault. Puede tardar varios minutos. ¿Continuar?'
      )) return;

      const btn = document.getElementById('pv-jc-find-bulk-btn');
      const progress = document.getElementById('pv-jc-find-bulk-progress');
      const result = document.getElementById('pv-jc-find-bulk-result');
      btn.disabled = true;
      btn.style.opacity = '0.6';
      result.style.display = 'none';
      progress.style.display = 'block';
      progress.textContent = 'Iniciando…';

      try {
        const r = await fetch(API + '/jc/bulk-import/start', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ presenter_name: presenterName }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.detail || data.error || ('HTTP ' + r.status));
        pollBulkImport();
      } catch (e) {
        progress.style.display = 'none';
        result.style.display = 'block';
        result.innerHTML = `<span style="color:#b91c1c;">Error: ${esc(e.message)}</span>`;
        btn.disabled = false;
        btn.style.opacity = '1';
      }
    }

    // Renders a finished bulk-import result into #pv-jc-find-bulk-result.
    // Shared by the live poll (just-finished run) and by the "recover last
    // report" path (status fetched fresh when the modal reopens) — a run
    // over hundreds of folders can easily outlast the operator's patience
    // for keeping the modal open, but the backend keeps the last result
    // in memory regardless of whether anyone was watching.
    function renderBulkImportResult(status, { recovered = false } = {}) {
      const result = document.getElementById('pv-jc-find-bulk-result');
      result.style.display = 'block';

      if (status.error) {
        result.innerHTML = `<span style="color:#b91c1c;">Error: ${esc(status.error)}</span>`;
        return;
      }
      const r2 = status.result;
      if (!r2) { result.innerHTML = ''; result.style.display = 'none'; return; }

      const lines = [];
      if (recovered) {
        const when = status.finished_at
          ? new Date(status.finished_at).toLocaleString('es-ES')
          : '';
        lines.push(`<div style="font-size:11px;color:#9ca3af;margin-bottom:4px;">` +
          `Último informe recuperado${status.presenter_name ? ` — ${esc(status.presenter_name)}` : ''}` +
          `${when ? ` (${when})` : ''}</div>`);
      }
      lines.push(
        `<div style="font-weight:700;margin-bottom:6px;">` +
        `${r2.date_folders_seen} carpeta(s) de fecha · ` +
        `${r2.presentations_created} presentación(es) nueva(s), ${r2.presentations_reused} ya existían · ` +
        `${r2.files_attached} archivo(s) adjuntado(s)</div>`,
      );
      if (r2.matched && r2.matched.length) {
        lines.push(`
          <details style="margin-top:6px;">
            <summary style="cursor:pointer;font-weight:600;color:#166534;">
              Importados correctamente (${r2.matched.length})
            </summary>
            <ul style="margin:6px 0 0;padding-left:18px;">` +
              r2.matched.map(x => `<li><code>${esc(x.folder)}</code> → ` +
                `${esc(x.article_title || x.article_id)} ` +
                `<span style="color:#6b7280;">(presentación ${esc(x.presentation_status)}` +
                (x.files_attached ? `, ${x.files_attached} archivo(s)` : ', sin archivos nuevos') +
                (x.matched_by ? `, emparejado por ${esc(x.matched_by)}` : '') +
                `)</span></li>`).join('') +
            '</ul></details>');
      }
      if (r2.unmatched && r2.unmatched.length) {
        lines.push(`<div style="font-weight:600;color:#92400e;margin-top:6px;">No identificados (${r2.unmatched.length}):</div>`);
        lines.push('<ul style="margin:4px 0 0;padding-left:18px;">' + r2.unmatched.map(u =>
          `<li><code>${esc(u.folder)}</code> — ${esc(u.reason)}</li>`).join('') + '</ul>');
      }
      if (r2.errors && r2.errors.length) {
        lines.push(`<div style="font-weight:600;color:#b91c1c;margin-top:6px;">Errores (${r2.errors.length}):</div>`);
        lines.push('<ul style="margin:4px 0 0;padding-left:18px;">' + r2.errors.map(u =>
          `<li><code>${esc(u.folder)}</code> — ${esc(u.error)}</li>`).join('') + '</ul>');
      }
      result.innerHTML = lines.join('');
    }

    async function pollBulkImport() {
      const progress = document.getElementById('pv-jc-find-bulk-progress');
      const btn = document.getElementById('pv-jc-find-bulk-btn');
      let status;
      try {
        status = await api('/jc/bulk-import/status');
      } catch (e) {
        _bulkImportPollTimer = setTimeout(pollBulkImport, 2000);
        return;
      }
      if (status.running) {
        progress.textContent = status.total
          ? `Procesando ${status.done}/${status.total} carpetas de fecha…`
          : 'Listando carpetas…';
        _bulkImportPollTimer = setTimeout(pollBulkImport, 1500);
        return;
      }

      progress.style.display = 'none';
      btn.disabled = false;
      btn.style.opacity = '1';
      renderBulkImportResult(status);
    }

    // Checked every time the modal opens: a run can keep going in the
    // background long after the operator closed the modal (or the tab),
    // since it's a server-side thread — this recovers whatever is
    // running or just finished instead of losing it silently.
    async function checkBulkImportOnOpen() {
      let status;
      try {
        status = await api('/jc/bulk-import/status');
      } catch (e) {
        return;
      }
      if (status.running) {
        const btn = document.getElementById('pv-jc-find-bulk-btn');
        const progress = document.getElementById('pv-jc-find-bulk-progress');
        btn.disabled = true;
        btn.style.opacity = '0.6';
        progress.style.display = 'block';
        progress.textContent = status.total
          ? `Procesando ${status.done}/${status.total} carpetas de fecha…`
          : 'Listando carpetas…';
        pollBulkImport();
      } else if (status.result || status.error) {
        renderBulkImportResult(status, { recovered: true });
      }
    }

    async function doSearch(payload, isMultipart) {
      const status = document.getElementById('pv-jc-find-status');
      status.style.color = '#6b7280';
      status.textContent = 'Buscando…';
      try {
        const opts = isMultipart
          ? { method: 'POST', credentials: 'same-origin', body: payload }
          : { method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload) };
        const r = await fetch(API + '/jc/find-article', opts);
        const data = await r.json().catch(() => ({}));
        if (r.status === 404 || data.found === false) {
          status.style.color = '#b91c1c';
          status.textContent = 'No se ha encontrado ningún artículo en PrionVault con ese dato.';
          return;
        }
        if (!r.ok) throw new Error(data.detail || data.error || ('HTTP ' + r.status));
        status.textContent = '';
        showPreview(data.article);
      } catch (e) {
        status.style.color = '#b91c1c';
        status.textContent = 'Error: ' + e.message;
      }
    }

    function wireOnce() {
      if (_wired) return;
      _wired = true;
      const modal = document.getElementById('pv-jc-find-modal');
      const close = () => { modal.style.display = 'none'; };
      document.getElementById('pv-jc-find-close')?.addEventListener('click', close);
      modal.querySelector('.pv-modal-backdrop')?.addEventListener('click', close);

      const searchBtn = document.getElementById('pv-jc-find-search');
      searchBtn?.addEventListener('click', () => {
        const id = document.getElementById('pv-jc-find-identifier').value.trim();
        if (!id) return;
        doSearch({ identifier: id }, false);
      });
      document.getElementById('pv-jc-find-identifier')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); searchBtn?.click(); }
      });

      document.getElementById('pv-jc-find-pdf-btn')?.addEventListener('click', () => {
        document.getElementById('pv-jc-find-pdf-input')?.click();
      });
      document.getElementById('pv-jc-find-pdf-input')?.addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!f) return;
        const fd = new FormData();
        fd.append('file', f, f.name);
        doSearch(fd, true);
      });

      const findDropzone = document.getElementById('pv-jc-find-dropzone');
      if (findDropzone) {
        ['dragenter', 'dragover'].forEach(ev => findDropzone.addEventListener(ev, (e) => {
          e.preventDefault(); e.stopPropagation();
          findDropzone.style.background = '#fce7f3';
          findDropzone.style.borderColor = '#be185d';
        }));
        ['dragleave', 'drop'].forEach(ev => findDropzone.addEventListener(ev, (e) => {
          e.preventDefault(); e.stopPropagation();
          findDropzone.style.background = '#fdf2f8';
          findDropzone.style.borderColor = '#f3a8ca';
        }));
        findDropzone.addEventListener('drop', (e) => {
          const f = e.dataTransfer?.files && e.dataTransfer.files[0];
          if (!f) return;
          const fd = new FormData();
          fd.append('file', f, f.name);
          doSearch(fd, true);
        });
      }

      document.getElementById('pv-jc-find-retry')?.addEventListener('click', reset);
      document.getElementById('pv-jc-find-ok')?.addEventListener('click', () => {
        if (!_matched) return;
        close();
        PVJcUpload.open(_matched, () => loadArticles());
      });

      document.getElementById('pv-jc-find-bulk-btn')?.addEventListener('click', startBulkImport);
    }

    function open() {
      wireOnce();
      reset();
      document.getElementById('pv-jc-find-modal').style.display = 'flex';
      setTimeout(() => document.getElementById('pv-jc-find-identifier')?.focus(), 50);
      checkBulkImportOnOpen();
    }

    return { open };
  })();

  // ── Journal Club — management modal (full history, search, report) ─────
  const PVJcManage = (() => {
    let _wired = false;
    let _items = [];        // flat list from /jc/all, each a {presentation + article} row
    let _filtered = [];     // current search result, pre-sort
    let _searchOr = false;  // AND (default) vs OR between search terms
    let _sortKey = 'date';  // 'date' | 'presenter'
    let _sortAsc = false;   // newest / Z-first by default
    let _repeatedOnly = false;  // only articles presented more than once (>1 distinct presenter)
    let _dateFilter = null;     // ISO 'YYYY-MM-DD' — locate a JC by its presented_at date

    function fmtDate(iso) {
      if (!iso) return '(sin fecha)';
      return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
    }

    function rowHtml(x) {
      const idLinks = [
        x.article_has_pdf ? `<a href="${API}/articles/${esc(x.article_id)}/pdf-view" target="_blank" rel="noopener" onclick="event.stopPropagation();" style="color:#b91c1c;text-decoration:none;font-weight:600;"><i class="fas fa-file-pdf"></i> PDF</a>` : '',
        x.article_doi ? `<a href="https://doi.org/${encodeURIComponent(x.article_doi)}" target="_blank" rel="noopener" onclick="event.stopPropagation();" style="color:#1d4ed8;text-decoration:none;">DOI: ${esc(x.article_doi)}</a>` : '',
        x.article_pmid ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(x.article_pmid)}/" target="_blank" rel="noopener" onclick="event.stopPropagation();" style="color:#1d4ed8;text-decoration:none;">PMID: ${esc(x.article_pmid)}</a>` : '',
      ].filter(Boolean).join(' &nbsp;·&nbsp; ');
      const files = (x.files || []).map(f => {
        const icon = JC_FILE_ICONS[f.kind] || JC_FILE_ICONS.other;
        const color = JC_FILE_COLORS[f.kind] || JC_FILE_COLORS.other;
        return `<button type="button" class="pv-jc-manage-file" data-fid="${esc(f.id)}"
                 title="${esc(f.filename)}"
                 style="display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;
                        margin:1px 4px 1px 0;border-radius:7px;border:1px solid #e5e7eb;background:#fff;
                        color:${color};font-size:16px;cursor:pointer;">
           <i class="fas ${icon}"></i>
         </button>`;
      }).join('') || `<span title="Sin ningún fichero adjunto — el artículo NO lleva la etiqueta compartida &quot;Journal Club – Ok&quot;, que solo se aplica cuando una presentación tiene al menos un documento"
                            style="color:#b91c1c;font-size:10.5px;font-weight:600;white-space:nowrap;">
                        <i class="fas fa-triangle-exclamation"></i> sin archivo</span>`;
      return `
        <tr data-pid="${esc(x.id)}" style="border-bottom:1px solid #f9fafb;cursor:pointer;">
          <td style="padding:7px 4px 7px 10px;vertical-align:middle;text-align:center;width:28px;">
            <input type="checkbox" class="pv-jc-manage-row-select" data-aid="${esc(x.article_id)}"
                   ${state.selectedIds.has(x.article_id) ? 'checked' : ''}
                   onclick="event.stopPropagation();"
                   style="cursor:pointer;width:14px;height:14px;">
          </td>
          <td style="padding:7px 10px;white-space:nowrap;color:#374151;overflow:hidden;text-overflow:ellipsis;">${esc(fmtDate(x.presented_at))}</td>
          <td style="padding:7px 10px;color:#374151;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(x.presenter_name || '—')}</td>
          <td style="padding:7px 10px;color:#111827;overflow:hidden;">
            <div style="font-size:13.5px;font-weight:600;color:#111827;line-height:1.35;
                        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(x.article_title || '(sin título)')}</div>
            <div style="margin-top:1px;font-size:11.5px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              ${x.article_authors ? esc(x.article_authors) : ''}${x.article_journal
                ? ` <span style="color:#a21caf;font-weight:600;">· ${esc(x.article_journal)}${x.article_year ? ` (${esc(x.article_year)})` : ''}</span>`
                : ''}
            </div>
            ${idLinks ? `<div style="margin-top:1px;font-size:11px;">${idLinks}</div>` : ''}
          </td>
          <td style="padding:7px 10px;white-space:nowrap;overflow:hidden;">${files}</td>
        </tr>`;
    }

    function sortIcon(key) {
      if (_sortKey !== key) return 'fa-sort';
      return _sortAsc ? 'fa-sort-up' : 'fa-sort-down';
    }

    function updateSortHeaders() {
      document.querySelectorAll('.pv-jc-manage-sortable').forEach(th => {
        const icon = th.querySelector('i');
        if (icon) icon.className = `fas ${sortIcon(th.dataset.sort)}`;
        icon && (icon.style.opacity = (_sortKey === th.dataset.sort) ? '1' : '0.4');
      });
    }

    function sortedList(list) {
      const sorted = [...list];
      sorted.sort((a, b) => {
        let av, bv, useLocale = false;
        if (_sortKey === 'presenter') {
          av = a.presenter_name || ''; bv = b.presenter_name || ''; useLocale = true;
        } else if (_sortKey === 'article') {
          av = a.article_title || ''; bv = b.article_title || ''; useLocale = true;
        } else if (_sortKey === 'filetype') {
          // Sort by file format (pptx, pdf, word, excel…) — several files
          // on one presentation sort by their kinds joined alphabetically,
          // so mixed-format rows still land somewhere consistent.
          const kindsOf = (row) => (row.files || []).map(f => f.kind || '').sort().join(',');
          av = kindsOf(a); bv = kindsOf(b);
        } else {
          av = a.presented_at || '';
          bv = b.presented_at || '';
        }
        // localeCompare('es') so accented letters (Á, É…) sort next to their
        // plain counterpart (A, E…) instead of after Z, as plain `<`/`>`
        // string comparison would do (accents sort by raw UTF-16 code point).
        const cmp = useLocale
          ? av.localeCompare(bv, 'es', { sensitivity: 'base' })
          : (av < bv ? -1 : av > bv ? 1 : 0);
        return _sortAsc ? cmp : -cmp;
      });
      return sorted;
    }

    // Articles whose every JC presentation has zero attached files never
    // get the shared "Journal Club – Ok" tag (see routes.py
    // api_jc_create: it's only applied once a presentation actually has a
    // document) — this is the #1 reason the tag's count and this modal's
    // count of distinct articles can diverge. Recomputed whenever _items
    // changes, not per-filter, since it's about the whole dataset.
    let _articlesMissingTagCount = 0;
    function _recomputeMissingTagCount() {
      const withFiles = new Set(_items.filter(x => x.files && x.files.length).map(x => x.article_id));
      const allArticles = new Set(_items.map(x => x.article_id));
      _articlesMissingTagCount = [...allArticles].filter(aid => !withFiles.has(aid)).length;
    }

    function render() {
      const tbody = document.getElementById('pv-jc-manage-tbody');
      const count = document.getElementById('pv-jc-manage-count');
      const list = sortedList(_filtered);
      count.innerHTML = `${list.length} de ${_items.length} presentación(es)` +
        (_articlesMissingTagCount
          ? ` <span style="color:#b91c1c;" title="Presentaciones sin ningún fichero adjunto — esos artículos no llevan la etiqueta compartida &quot;Journal Club – Ok&quot;">` +
            `· ⚠ ${_articlesMissingTagCount} artículo(s) sin etiquetar</span>`
          : '');
      updateSortHeaders();
      tbody.innerHTML = list.length
        ? list.map(rowHtml).join('')
        : '<tr><td colspan="5" style="padding:20px;text-align:center;color:#9ca3af;">Sin resultados.</td></tr>';
      tbody.querySelectorAll('tr[data-pid]').forEach(tr => {
        tr.addEventListener('click', (e) => {
          if (e.target.closest('.pv-jc-manage-file') || e.target.closest('a') ||
              e.target.closest('.pv-jc-manage-row-select')) return;
          const x = _items.find(i => i.id === tr.dataset.pid);
          if (x) { close(); openDetail(x.article_id); }
        });
      });
      tbody.querySelectorAll('.pv-jc-manage-file').forEach(b => {
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          window.open(API + `/jc/files/${b.dataset.fid}/view`, '_blank', 'noopener');
        });
      });
      // Same shared state.selectedIds the main listing's row checkboxes
      // use — checking one here selects the article there too, so
      // closing this modal leaves the main listing showing the same
      // selection (no separate "JC selection" concept to keep in sync).
      tbody.querySelectorAll('.pv-jc-manage-row-select').forEach(cb => {
        cb.addEventListener('change', () => {
          const aid = cb.dataset.aid;
          if (cb.checked) state.selectedIds.add(aid);
          else state.selectedIds.delete(aid);
          updateBulkBar();
        });
      });
    }

    // article_id -> count of distinct presenters across all its JC
    // presentations. Recomputed whenever _items changes (see load()).
    let _presenterCountByArticle = new Map();
    function _recomputeRepeatedArticles() {
      const presentersByArticle = new Map();
      for (const x of _items) {
        if (!presentersByArticle.has(x.article_id)) presentersByArticle.set(x.article_id, new Set());
        if (x.presenter_name) presentersByArticle.get(x.article_id).add(x.presenter_name.trim().toLowerCase());
      }
      _presenterCountByArticle = new Map(
        [...presentersByArticle.entries()].map(([aid, set]) => [aid, set.size]));
    }

    // Accent-insensitive compare — "Fernández" and "Fernandez" should
    // match the same way. NFD splits each accented character into its
    // base letter + a combining diacritical mark, which the \p{Diacritic}
    // regex then strips.
    function _foldAccents(s) {
      return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }

    function applySearch() {
      const q = _foldAccents((document.getElementById('pv-jc-manage-search').value || '').trim().toLowerCase());
      let list = _items;
      if (q) {
        const terms = q.split(/\s+/).filter(Boolean);
        list = list.filter(x => {
          const hay = _foldAccents([x.presenter_name, x.article_title, x.article_authors,
                       x.article_journal, x.article_year, x.article_doi, x.article_pmid]
            .filter(Boolean).join(' ').toLowerCase());
          return _searchOr ? terms.some(t => hay.includes(t)) : terms.every(t => hay.includes(t));
        });
      }
      if (_repeatedOnly) {
        list = list.filter(x => (_presenterCountByArticle.get(x.article_id) || 0) > 1);
      }
      if (_dateFilter) {
        list = list.filter(x => x.presented_at === _dateFilter);
      }
      _filtered = list;
      render();
    }

    function populateScopeOptions() {
      const sel = document.getElementById('pv-jc-report-scope');
      const years = [...new Set(_items.map(x => x.article_year).filter(Boolean))].sort((a, b) => b - a);
      const presenters = [...new Set(_items.map(x => x.presenter_name).filter(Boolean))].sort();
      sel.innerHTML = '<option value="">Informe completo</option>' +
        (years.length ? `<optgroup label="Por año">${years.map(y =>
          `<option value="year:${esc(y)}">Año ${esc(y)}</option>`).join('')}</optgroup>` : '') +
        (presenters.length ? `<optgroup label="Por responsable">${presenters.map(p =>
          `<option value="presenter:${esc(p)}">${esc(p)}</option>`).join('')}</optgroup>` : '');
    }

    async function load() {
      const tbody = document.getElementById('pv-jc-manage-tbody');
      tbody.innerHTML = '<tr><td colspan="4" style="padding:20px;text-align:center;color:#9ca3af;">Cargando…</td></tr>';
      try {
        const data = await api('/jc/all');
        _items = data.items || [];
      } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" style="padding:20px;text-align:center;color:#b91c1c;">Error: ${esc(e.message)}</td></tr>`;
        return;
      }
      _recomputeMissingTagCount();
      _recomputeRepeatedArticles();
      populateScopeOptions();
      applySearch();
    }

    function close() {
      document.getElementById('pv-jc-manage-modal').style.display = 'none';
      // Reflect any selection made in this modal on the main listing's
      // already-rendered checkboxes/bulk-bar right away, without
      // needing a reload — state.selectedIds itself was already kept
      // in sync live (see the checkbox wiring in render()).
      document.querySelectorAll('.pv-row-select').forEach(cb => {
        cb.checked = state.selectedIds.has(cb.dataset.aid);
      });
      updateBulkBar();
      syncSelectAllHeader();
    }

    function wireOnce() {
      if (_wired) return;
      _wired = true;
      const modal = document.getElementById('pv-jc-manage-modal');
      document.getElementById('pv-jc-manage-close')?.addEventListener('click', close);
      modal.querySelector('.pv-modal-backdrop')?.addEventListener('click', close);
      document.getElementById('pv-jc-manage-search')?.addEventListener('input', applySearch);
      const setSearchMode = (or) => {
        _searchOr = or;
        const andBtn = document.getElementById('pv-jc-manage-search-and');
        const orBtn  = document.getElementById('pv-jc-manage-search-or');
        [[andBtn, !or], [orBtn, or]].forEach(([btn, active]) => {
          btn.style.background   = active ? '#be185d' : '#fff';
          btn.style.color        = active ? '#fff' : '#9ca3af';
          btn.style.borderColor  = active ? '#be185d' : '#d1d5db';
        });
        applySearch();
      };
      document.getElementById('pv-jc-manage-search-and')?.addEventListener('click', () => setSearchMode(false));
      document.getElementById('pv-jc-manage-search-or')?.addEventListener('click', () => setSearchMode(true));
      document.getElementById('pv-jc-manage-repeated-btn')?.addEventListener('click', (e) => {
        _repeatedOnly = !_repeatedOnly;
        e.currentTarget.style.background  = _repeatedOnly ? '#be185d' : '#fff';
        e.currentTarget.style.color       = _repeatedOnly ? '#fff' : '#6b7280';
        e.currentTarget.style.borderColor = _repeatedOnly ? '#be185d' : '#d1d5db';
        applySearch();
      });
      document.querySelectorAll('.pv-jc-manage-sortable').forEach(th => {
        th.addEventListener('click', () => {
          const key = th.dataset.sort;
          if (_sortKey === key) { _sortAsc = !_sortAsc; }
          else { _sortKey = key; _sortAsc = false; }
          render();
        });
      });
      document.getElementById('pv-jc-manage-add-btn')?.addEventListener('click', () => {
        close();
        PVJcFind.open();
      });
      document.getElementById('pv-jc-manage-report-btn')?.addEventListener('click', () => {
        const panel = document.getElementById('pv-jc-manage-report-panel');
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      });
      document.getElementById('pv-jc-report-download')?.addEventListener('click', () => {
        const groupBy = modal.querySelector('input[name="pv-jc-report-group"]:checked')?.value || 'year_presenter';
        const scopeRaw = document.getElementById('pv-jc-report-scope').value;
        const params = new URLSearchParams({ group_by: groupBy });
        if (scopeRaw) {
          const [scope, ...rest] = scopeRaw.split(':');
          params.set('scope', scope);
          params.set('scope_value', rest.join(':'));
        }
        window.open(API + '/jc/report?' + params.toString(), '_blank', 'noopener');
      });

      // ── Verify Dropbox: catches files renamed/moved/deleted directly in
      // Dropbox after being linked to a JC presentation. ───────────────────
      document.getElementById('pv-jc-manage-verify-btn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const panel = document.getElementById('pv-jc-manage-verify-panel');
        const body  = document.getElementById('pv-jc-manage-verify-body');
        const prevHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        panel.style.display = 'block';
        panel.style.background = '#f9fafb';
        panel.style.border = '1px solid #e5e7eb';
        panel.style.color = '#6b7280';
        body.innerHTML = 'Verificando archivos en Dropbox…';
        try {
          const data = await api('/jc/verify-dropbox', { method: 'POST' });
          if (!data.missing || !data.missing.length) {
            panel.style.background = '#f0fdf4';
            panel.style.border = '1px solid #bbf7d0';
            panel.style.color = '#166534';
            body.innerHTML = `<i class="fas fa-circle-check"></i> Todo correcto — ${data.checked} archivo(s) verificado(s), ningún huérfano.`;
          } else {
            panel.style.background = '#fffbeb';
            panel.style.border = '1px solid #fcd34d';
            panel.style.color = '#92400e';
            body.innerHTML =
              `<div style="font-weight:700;margin-bottom:6px;"><i class="fas fa-triangle-exclamation"></i> ` +
              `${data.missing.length} de ${data.checked} archivo(s) no se encuentran en Dropbox ` +
              `(renombrados, movidos o borrados tras enlazarlos):</div>` +
              `<ul style="margin:0;padding-left:18px;">` +
              data.missing.map(m => `<li style="margin-bottom:3px;">` +
                `<strong>${esc(m.filename)}</strong> — ${esc(m.article_title || '(sin título)')} ` +
                `· ${esc(m.presenter_name || '—')} · ${esc(fmtDate(m.presented_at))}` +
                `<div style="font-size:11px;color:#a16207;">${esc(m.dropbox_path)}</div>` +
                `</li>`).join('') +
              `</ul>`;
          }
        } catch (err) {
          panel.style.background = '#fef2f2';
          panel.style.border = '1px solid #fecaca';
          panel.style.color = '#991b1b';
          body.innerHTML = `<i class="fas fa-circle-exclamation"></i> Error al verificar: ${esc(err.message || String(err))}`;
        } finally {
          btn.disabled = false;
          btn.innerHTML = prevHtml;
        }
      });
      document.getElementById('pv-jc-manage-verify-close')?.addEventListener('click', () => {
        document.getElementById('pv-jc-manage-verify-panel').style.display = 'none';
      });

      // ── Locate a JC by presentation date ──────────────────────────────────
      const calBtn   = document.getElementById('pv-jc-manage-cal-btn');
      const calPopup = document.getElementById('pv-jc-manage-cal-popup');
      const calInput = document.getElementById('pv-jc-manage-cal-input');
      const syncCalBtn = () => {
        const active = !!_dateFilter;
        calBtn.style.background  = active ? '#be185d' : '#fff';
        calBtn.style.color       = active ? '#fff' : '#6b7280';
        calBtn.style.borderColor = active ? '#be185d' : '#d1d5db';
      };
      calBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const opening = calPopup.style.display === 'none';
        calPopup.style.display = opening ? 'block' : 'none';
        if (opening) { calInput.value = _dateFilter || ''; calInput.focus(); }
      });
      document.addEventListener('click', (e) => {
        if (calPopup && calPopup.style.display !== 'none' &&
            !calPopup.contains(e.target) && e.target !== calBtn && !calBtn.contains(e.target)) {
          calPopup.style.display = 'none';
        }
      });
      calInput?.addEventListener('change', () => {
        _dateFilter = calInput.value || null;
        syncCalBtn();
        applySearch();
      });
      document.getElementById('pv-jc-manage-cal-clear')?.addEventListener('click', () => {
        _dateFilter = null;
        calInput.value = '';
        syncCalBtn();
        applySearch();
        calPopup.style.display = 'none';
      });
    }

    function open(searchText) {
      wireOnce();
      if (typeof searchText === 'string') {
        const si = document.getElementById('pv-jc-manage-search');
        if (si) si.value = searchText;
      }
      document.getElementById('pv-jc-manage-modal').style.display = 'flex';
      load();
    }

    return { open, reload: load };
  })();

  // Wired for every role (it used to be wired only inside the admin-only
  // init block, so the sidebar button did nothing for anyone else).
  function wireJcManageButton() {
    document.getElementById('btn-manage-jc')?.addEventListener('click', () => PVJcManage.open());
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

