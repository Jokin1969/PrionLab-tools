(function () {
  const updateBadge = () => {
    const n = window.PPCart?.count() ?? 0;
    const badge = document.getElementById('pv-cart-badge');
    if (badge) { badge.textContent = n; badge.style.display = n > 0 ? '' : 'none'; }
  };
  window.addEventListener('pp-cart-changed', updateBadge);
  document.addEventListener('DOMContentLoaded', updateBadge);
})();

// Keep every listing row's 🛒 button in sync with the cart, however it
// changed — removing/clearing from the cart drawer (or from PrionPacks,
// since it's the same shared cart) used to leave rows showing "in cart"
// until a full page reload, because only the row's OWN click handler
// ever repainted it, never anything reacting to changes made elsewhere.
(function () {
  const repaintRowCartButtons = () => {
    document.querySelectorAll('.pv-cart-btn[data-aid]').forEach(btn => {
      const inCart = !!window.PPCart?.has(btn.dataset.aid);
      btn.classList.toggle('pv-cart-btn--in', inCart);
      btn.style.background = inCart ? '#d1fae5' : '#f3f4f6';
      btn.style.color      = inCart ? '#065f46' : '#6b7280';
      btn.title = inCart ? 'En el carrito' : 'Añadir al carrito de PrionPacks';
      btn.innerHTML = inCart ? '🛒 ✓' : '🛒';
    });
  };
  window.addEventListener('pp-cart-changed', repaintRowCartButtons);
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

  // ── BibTeX export (for import into the FECYT CVN Editor) ──────────────

  let _bibtexBtn = null;

  async function _doExportBibtex() {
    const ids = _visibleIds();
    if (!ids.length) { alert('No hay referencias visibles.'); return; }

    if (!confirm(`Vas a exportar ${ids.length.toLocaleString()} artículo${ids.length === 1 ? '' : 's'} ` +
                 `en formato BibTeX (.bib), para importar en el asistente de Publicaciones del CVN ` +
                 `Editor de FECYT.\n\n¿Continuar?`)) {
      return;
    }

    _bibtexBtn.disabled  = true;
    const orig           = _bibtexBtn.innerHTML;
    _bibtexBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generando…';

    try {
      const res = await fetch('/prionvault/api/articles/export-refs-bibtex', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ article_ids: ids }),
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
      a.download  = `Referencias_${ts}.bib`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      _close();
    } catch (e) {
      alert('Error de red: ' + e.message);
    } finally {
      _bibtexBtn.disabled  = false;
      _bibtexBtn.innerHTML = orig;
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
    _bibtexBtn    = _el('pv-er-export-bibtex');
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
    _bibtexBtn                    ?.addEventListener('click', _doExportBibtex);
    _el('pv-govasco-close')       ?.addEventListener('click', _closeGovascoModal);
    _el('pv-govasco-cancel')      ?.addEventListener('click', _closeGovascoModal);
    _el('pv-govasco-modal')?.querySelector('.pv-modal-backdrop')
                                  ?.addEventListener('click', _closeGovascoModal);
    _el('pv-govasco-generate')    ?.addEventListener('click', _doExportGovasco);
    _el('pv-er-save-preset')      ?.addEventListener('click', _promptSavePreset);
    _initGlobalChev();
  });

