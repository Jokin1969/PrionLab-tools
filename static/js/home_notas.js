/* ══ Notas de Inicio — post-its flotantes, SOLO en la página de Inicio ═══════
   Tablero compartido para comunicarse entre usuarios: cada nota tiene un
   autor y una visibilidad (privada / todos / lista de personas). Quien puede
   VER una nota puede EDITARLA — así el autor ve la respuesta del destinatario
   en la misma nota. Solo el autor (o Admin) borra o cambia a quién se
   comparte. Vive en el sidebar de PrionVault (entre el bloque de marca y
   el nav de "Library"), no en la página de Inicio.

   Self-contained: no shared el()/api()/toast() helpers exist in this app
   yet, so this file defines its own minimal versions below. */
(function () {
  'use strict';

  const _HOME_NOTA_COLORS = ['#FEF08A', '#BFDBFE', '#BBF7D0', '#FBCFE8', '#FDE68A', '#DDD6FE', '#FECACA', '#E2E8F0'];
  let _homeNotasIconEl = null;

  function el(tag, opts) {
    const node = document.createElement(tag);
    opts = opts || {};
    if (opts.class) node.className = opts.class;
    if (opts.style) node.style.cssText = opts.style;
    if (opts.title) node.title = opts.title;
    if (opts.type) node.type = opts.type;
    if (opts.placeholder) node.placeholder = opts.placeholder;
    if (opts.html !== undefined) node.innerHTML = opts.html;
    if (opts.text !== undefined) node.textContent = opts.text;
    return node;
  }

  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch('/api' + path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    }, opts));
    let data = null;
    try { data = await res.json(); } catch (_) { /* noop */ }
    if (!res.ok) {
      const msg = (data && (data.error || data.detail)) || ('HTTP ' + res.status);
      throw new Error(msg);
    }
    return data || {};
  }

  function toast(msg, type) {
    const t = el('div', { class: 'hn-toast hn-toast--' + (type || 'info'), text: msg });
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, 3000);
  }

  function skeleton(n) {
    const wrap = el('div', { class: 'hn-skeleton' });
    for (let i = 0; i < n; i++) wrap.appendChild(el('div', { class: 'hn-skeleton-block' }));
    return wrap;
  }

  function lsGet(key) { try { return localStorage.getItem('home_notas.' + key); } catch (_) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem('home_notas.' + key, val); } catch (_) { /* noop */ } }

  async function _syncHomeNotasIcon() {
    if (!_homeNotasIconEl) return;
    try {
      const data = await api('/home-notas');
      const n = data.n || 0, nuevas = data.nuevas || 0;
      const badge = _homeNotasIconEl.querySelector('.hn-badge');
      _homeNotasIconEl.classList.toggle('has-notes', n > 0);
      _homeNotasIconEl.classList.toggle('has-nuevas', nuevas > 0);
      if (badge) { badge.textContent = String(n); badge.hidden = n === 0; }
      _homeNotasIconEl.title = nuevas > 0
        ? nuevas + ' nota(s) con cambios nuevos · ' + n + ' en total — clic para abrir'
        : (n > 0 ? n + ' nota(s) — clic para abrir' : 'Notas — clic para escribir la primera');
    } catch (_) { /* noop */ }
  }

  function homeNotasIconNode() {
    const btn = el('button', { class: 'hn-icon-btn', title: 'Notas' });
    btn.innerHTML = '<i class="fas fa-note-sticky"></i><span class="hn-badge" hidden>0</span>';
    btn.addEventListener('click', () => openHomeNotasBoard());
    _homeNotasIconEl = btn;
    _syncHomeNotasIcon();
    return btn;
  }

  function _notaFootText(nota) {
    return nota.editor_nombre ? ('Última edición: ' + nota.editor_nombre) : ('Creada por ' + nota.autor_nombre);
  }

  function _notaVisLabel(nota) {
    return nota.visibilidad === 'privada' ? 'Solo yo'
      : nota.visibilidad === 'todos' ? 'Todos'
        : (nota.destinatarios.length + ' persona' + (nota.destinatarios.length !== 1 ? 's' : '')
          + (nota.destinatarios.length ? (': ' + nota.destinatarios.map(d => d.nombre).join(', ')) : ''));
  }

  // Modal para elegir a QUIÉN se comparte una nota (solo autor/Admin). Cada
  // cambio se aplica al instante (sin botón Guardar).
  function _openHomeNotaShareModal(nota, users, onChange) {
    const overlay = el('div', { class: 'hn-modal-overlay', style: 'z-index:1500' });
    const modal = el('div', { class: 'hn-modal' });
    overlay.appendChild(modal); document.body.appendChild(overlay);
    const _close = () => { overlay.remove(); document.removeEventListener('keydown', _esc, true); };
    function _esc(e) { if (e.key === 'Escape') { e.stopImmediatePropagation(); _close(); } }
    document.addEventListener('keydown', _esc, true);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) _close(); });

    const hdr = el('div', { class: 'hn-modal-hdr' });
    hdr.appendChild(el('span', { class: 'hn-modal-title', html: '<i class="fas fa-users me-2"></i>Compartir esta nota' }));
    const cx = el('button', { class: 'hn-modal-close', html: '&times;' }); cx.addEventListener('click', _close); hdr.appendChild(cx);
    modal.appendChild(hdr);

    const body = el('div', { class: 'hn-modal-body' });
    modal.appendChild(body);
    const topRow = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:2px' });
    topRow.appendChild(el('p', { class: 'hn-help', style: 'margin:0', text: 'Cada cambio se aplica al instante. El autor/a siempre puede ver y editar la nota.' }));
    const statusEl = el('span', { style: 'margin-left:auto;font-size:.72rem;font-weight:700;color:#16a34a;opacity:0;transition:opacity .25s;white-space:nowrap', html: '<i class="fas fa-check me-1"></i>Guardado' });
    topRow.appendChild(statusEl);
    body.appendChild(topRow);
    function _flashSaved() { statusEl.style.opacity = '1'; clearTimeout(_flashSaved._t); _flashSaved._t = setTimeout(() => { statusEl.style.opacity = '0'; }, 900); }

    const allRow = el('label', { class: 'hn-user-row', style: 'font-weight:700;border-bottom:1px solid var(--hn-line,#e2e8f0);margin:10px 0 8px;padding-bottom:10px' });
    const allCb = el('input', { type: 'checkbox' });
    allCb.checked = nota.visibilidad === 'todos';
    allRow.append(allCb, el('div', { style: 'flex:1', html: '<i class="fas fa-globe me-1"></i>Visible para todos' }));
    body.appendChild(allRow);

    const searchIn = el('input', { type: 'search', placeholder: 'Buscar persona…', class: 'hn-form-ctrl', style: 'width:100%;margin-bottom:8px' });
    body.appendChild(searchIn);
    const listBox = el('div', { class: 'hn-user-list', style: 'max-height:280px;overflow:auto' });
    body.appendChild(listBox);

    const currentIds = new Set((nota.destinatarios || []).map(d => d.id_usuario));
    const rows = [];
    for (const u of users) {
      if (u.id_usuario === nota.autor_id) continue; // el autor ya la ve siempre
      const row = el('label', { class: 'hn-user-row' });
      const cb = el('input', { type: 'checkbox' }); cb.dataset.id = u.id_usuario; cb.checked = currentIds.has(u.id_usuario);
      row.appendChild(cb);
      const info = el('div', { style: 'flex:1;min-width:0' });
      info.appendChild(el('div', { style: 'font-weight:600;font-size:.86rem', text: u.nombre + (u.rol ? ' · ' + u.rol : '') }));
      row.appendChild(info);
      row._searchText = (u.nombre + ' ' + (u.rol || '')).toLowerCase();
      cb.addEventListener('change', applyChange);
      rows.push(row);
      listBox.appendChild(row);
    }
    if (nota.visibilidad === 'privada' && !currentIds.size) {
      let last = [];
      try { last = JSON.parse(lsGet('last_viewers') || '[]'); } catch (_) { /* noop */ }
      if (last.length) listBox.querySelectorAll('input[type=checkbox]').forEach(cb => { if (last.includes(cb.dataset.id)) cb.checked = true; });
    }
    searchIn.addEventListener('input', () => {
      const q = searchIn.value.trim().toLowerCase();
      rows.forEach(r => { r.style.display = (!q || r._searchText.includes(q)) ? '' : 'none'; });
    });
    function _syncListEnabled() {
      const disabled = allCb.checked;
      listBox.style.opacity = disabled ? '.4' : '';
      listBox.querySelectorAll('input[type=checkbox]').forEach(c => { c.disabled = disabled; });
      searchIn.disabled = disabled;
    }
    _syncListEnabled();

    let saving = false;
    async function applyChange() {
      if (saving) return;
      saving = true;
      const viewer_ids = Array.from(listBox.querySelectorAll('input[type=checkbox]:checked')).map(c => c.dataset.id);
      const vis = allCb.checked ? 'todos' : (viewer_ids.length ? 'personalizada' : 'privada');
      try {
        const r = await api('/home-notas/' + nota.id_nota, { method: 'PUT', body: JSON.stringify({ visibilidad: vis, viewer_ids }) });
        nota.visibilidad = r.nota.visibilidad; nota.destinatarios = r.nota.destinatarios;
        if (vis === 'personalizada') lsSet('last_viewers', JSON.stringify(viewer_ids));
        _flashSaved();
        onChange(nota);
      } catch (e) { toast('Error al compartir: ' + (e.message || e), 'error'); }
      saving = false;
    }
    allCb.addEventListener('change', () => { _syncListEnabled(); applyChange(); });

    const foot = el('div', { class: 'hn-modal-foot' });
    const closeBtn = el('button', { class: 'hn-btn-secondary', text: 'Cerrar' });
    closeBtn.addEventListener('click', _close);
    foot.appendChild(closeBtn);
    modal.appendChild(foot);
  }

  function _buildNotaCard(nota, canvas, users, isNew) {
    const card = el('div', {
      class: 'hn-card' + (isNew ? ' is-new' : ''),
      style: 'left:' + nota.pos_x + 'px;top:' + nota.pos_y + 'px;width:' + (nota.ancho || 240) + 'px;height:' + (nota.alto || 200) + 'px;background:' + nota.color,
    });
    card.dataset.id = String(nota.id_nota);

    const head = el('div', { class: 'hn-card-head' });
    head.appendChild(el('span', { class: 'hn-card-autor', text: nota.es_mia ? 'Yo' : nota.autor_nombre, title: 'Autor/a: ' + nota.autor_nombre }));
    const actsWrap = el('div', { class: 'hn-card-acts' });
    const shareBtn = el('button', {
      class: 'hn-mini-btn' + (nota.visibilidad !== 'privada' ? ' has-viewers' : ''),
      html: '<i class="fas fa-users"></i>',
      title: (nota.puede_gestionar ? 'Compartir · ' : 'Visible para: ') + _notaVisLabel(nota),
    });
    if (nota.puede_gestionar) {
      shareBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        _openHomeNotaShareModal(nota, users, (updated) => {
          shareBtn.classList.toggle('has-viewers', updated.visibilidad !== 'privada');
          shareBtn.title = 'Compartir · ' + _notaVisLabel(updated);
        });
      });
    } else {
      shareBtn.style.cursor = 'default';
    }
    actsWrap.appendChild(shareBtn);
    if (nota.puede_gestionar) {
      const delBtn = el('button', { class: 'hn-mini-btn danger', title: 'Borrar nota', html: '<i class="fas fa-trash"></i>' });
      delBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!confirm('¿Borrar esta nota? No se puede deshacer.')) return;
        try {
          await api('/home-notas/' + nota.id_nota, { method: 'DELETE' });
          card.remove();
          if (!canvas.querySelector('.hn-card')) canvas.appendChild(_homeNotasEmptyNode());
        } catch (e) { toast('Error al borrar: ' + (e.message || e), 'error'); }
      });
      actsWrap.appendChild(delBtn);
    }
    head.appendChild(actsWrap);
    card.appendChild(head);

    const colorRow = el('div', { class: 'hn-colors' });
    for (const c of _HOME_NOTA_COLORS) {
      const sw = el('button', { class: 'hn-color-sw' + (c === nota.color ? ' active' : ''), style: 'background:' + c, title: 'Color' });
      sw.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          await api('/home-notas/' + nota.id_nota, { method: 'PUT', body: JSON.stringify({ color: c }) });
          nota.color = c; card.style.background = c;
          colorRow.querySelectorAll('.hn-color-sw').forEach(s => s.classList.remove('active'));
          sw.classList.add('active');
        } catch (e) { toast('Error: ' + (e.message || e), 'error'); }
      });
      colorRow.appendChild(sw);
    }
    card.appendChild(colorRow);

    const ta = el('textarea', { class: 'hn-ta', placeholder: 'Escribe aquí…' });
    ta.value = nota.contenido || '';
    const footEl = el('div', { class: 'hn-card-foot', text: _notaFootText(nota) });
    let saveTimer = null;
    ta.addEventListener('input', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          const r = await api('/home-notas/' + nota.id_nota, { method: 'PUT', body: JSON.stringify({ contenido: ta.value }) });
          nota.editor_nombre = r.nota.editor_nombre; footEl.textContent = _notaFootText(nota);
        } catch (_) { /* noop — se reintenta en la próxima pulsación */ }
      }, 600);
    });
    card.appendChild(ta);
    card.appendChild(footEl);

    card.addEventListener('pointerdown', (ev) => {
      if (ev.target === card || ev.target === colorRow) ta.focus();
    });

    const resizeHandle = el('div', { class: 'hn-resize-handle', title: 'Arrastra para cambiar el tamaño' });
    card.appendChild(resizeHandle);
    let resizing = false, rsStartX = 0, rsStartY = 0, rsOrigW = 0, rsOrigH = 0, rsTheta = 0;
    resizeHandle.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      resizing = true; resizeHandle.setPointerCapture(ev.pointerId);
      rsStartX = ev.clientX; rsStartY = ev.clientY;
      rsOrigW = parseFloat(card.style.width) || card.offsetWidth;
      rsOrigH = parseFloat(card.style.height) || card.offsetHeight;
      const m = new DOMMatrixReadOnly(getComputedStyle(card).transform);
      rsTheta = Math.atan2(m.b, m.a);
      card.classList.add('resizing');
    });
    resizeHandle.addEventListener('pointermove', (ev) => {
      if (!resizing) return;
      const dx = ev.clientX - rsStartX, dy = ev.clientY - rsStartY;
      const localDX = dx * Math.cos(rsTheta) + dy * Math.sin(rsTheta);
      const localDY = -dx * Math.sin(rsTheta) + dy * Math.cos(rsTheta);
      const w = Math.min(480, Math.max(180, Math.round(rsOrigW + localDX)));
      const h = Math.min(560, Math.max(160, Math.round(rsOrigH + localDY)));
      card.style.width = w + 'px';
      card.style.height = h + 'px';
    });
    const _endResize = () => { if (!resizing) return; resizing = false; card.classList.remove('resizing'); };
    resizeHandle.addEventListener('pointerup', _endResize);
    resizeHandle.addEventListener('pointercancel', _endResize);

    if (typeof ResizeObserver !== 'undefined') {
      let resizeTimer = null;
      const ro = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(async () => {
          const w = Math.round(parseFloat(card.style.width) || card.getBoundingClientRect().width);
          const h = Math.round(parseFloat(card.style.height) || card.getBoundingClientRect().height);
          if (w === nota.ancho && h === nota.alto) return;
          nota.ancho = w; nota.alto = h;
          try { await api('/home-notas/' + nota.id_nota, { method: 'PUT', body: JSON.stringify({ ancho: w, alto: h }) }); } catch (_) { /* noop */ }
        }, 500);
      });
      ro.observe(card);
    }

    let dragging = false, startX = 0, startY = 0, origX = 0, origY = 0;
    head.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('button')) return;
      dragging = true; head.setPointerCapture(ev.pointerId);
      startX = ev.clientX; startY = ev.clientY;
      origX = parseFloat(card.style.left) || 0; origY = parseFloat(card.style.top) || 0;
      card.classList.add('dragging');
    });
    head.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      card.style.left = Math.max(0, origX + (ev.clientX - startX)) + 'px';
      card.style.top = Math.max(0, origY + (ev.clientY - startY)) + 'px';
    });
    const _endDrag = async () => {
      if (!dragging) return;
      dragging = false; card.classList.remove('dragging');
      const nx = parseFloat(card.style.left) || 0, ny = parseFloat(card.style.top) || 0;
      try { await api('/home-notas/' + nota.id_nota, { method: 'PUT', body: JSON.stringify({ pos_x: nx, pos_y: ny }) }); } catch (_) { /* noop */ }
    };
    head.addEventListener('pointerup', _endDrag);
    head.addEventListener('pointercancel', _endDrag);

    return card;
  }

  function _homeNotasEmptyNode() {
    return el('div', { class: 'hn-empty', html: '<i class="fas fa-note-sticky"></i><p>Todavía no hay notas. Pulsa «Nueva nota» para escribir la primera.</p>' });
  }

  async function openHomeNotasBoard() {
    const overlay = el('div', { class: 'hn-modal-overlay hn-overlay' });
    document.body.appendChild(overlay);
    const panel = el('div', { class: 'hn-panel' });
    overlay.appendChild(panel);
    const _close = () => { overlay.remove(); document.removeEventListener('keydown', _esc); _syncHomeNotasIcon(); };
    function _esc(e) { if (e.key === 'Escape') _close(); }
    document.addEventListener('keydown', _esc);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) _close(); });

    const hdr = el('div', { class: 'hn-panel-hdr' });
    hdr.appendChild(el('span', { class: 'hn-panel-title', html: '<i class="fas fa-note-sticky me-2"></i>Notas de Inicio' }));
    const newBtn = el('button', { class: 'hn-btn-primary', html: '<i class="fas fa-plus me-1"></i>Nueva nota' });
    hdr.appendChild(newBtn);
    const closeBtn = el('button', { class: 'hn-modal-close', html: '&times;' });
    closeBtn.addEventListener('click', _close);
    hdr.appendChild(closeBtn);
    panel.appendChild(hdr);

    const tabsRow = el('div', { class: 'hn-tabs' });
    panel.appendChild(tabsRow);
    panel.appendChild(el('p', { class: 'hn-help', style: 'margin:8px 0 8px 14px;font-size:.78rem', text: 'Arrastra una nota por su cabecera para moverla. Quien puede verla, puede editarla — así ves los cambios de quien te responde.' }));
    const canvas = el('div', { class: 'hn-canvas' });
    panel.appendChild(canvas);

    // Resize the whole board from its bottom-right corner, down to a fixed
    // minimum so the tabs/header/one note row always stay usable.
    const PANEL_MIN_W = 480, PANEL_MIN_H = 360;
    const panelResizeHandle = el('div', { class: 'hn-panel-resize', title: 'Arrastra para cambiar el tamaño del tablero' });
    panel.appendChild(panelResizeHandle);
    let savedSize = null;
    try { savedSize = JSON.parse(lsGet('panel_size') || 'null'); } catch (_) { /* noop */ }
    if (savedSize && savedSize.w && savedSize.h) {
      panel.style.width = Math.max(PANEL_MIN_W, Math.min(window.innerWidth - 40, savedSize.w)) + 'px';
      panel.style.height = Math.max(PANEL_MIN_H, Math.min(window.innerHeight - 40, savedSize.h)) + 'px';
    }
    let prSizing = false, prStartX = 0, prStartY = 0, prOrigW = 0, prOrigH = 0;
    panelResizeHandle.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      prSizing = true; panelResizeHandle.setPointerCapture(ev.pointerId);
      prStartX = ev.clientX; prStartY = ev.clientY;
      const rect = panel.getBoundingClientRect();
      prOrigW = rect.width; prOrigH = rect.height;
      panel.classList.add('resizing');
    });
    panelResizeHandle.addEventListener('pointermove', (ev) => {
      if (!prSizing) return;
      const dx = ev.clientX - prStartX, dy = ev.clientY - prStartY;
      const w = Math.min(window.innerWidth - 40, Math.max(PANEL_MIN_W, Math.round(prOrigW + dx)));
      const h = Math.min(window.innerHeight - 40, Math.max(PANEL_MIN_H, Math.round(prOrigH + dy)));
      panel.style.width = w + 'px';
      panel.style.height = h + 'px';
    });
    const _endPanelResize = () => {
      if (!prSizing) return;
      prSizing = false; panel.classList.remove('resizing');
      lsSet('panel_size', JSON.stringify({ w: parseFloat(panel.style.width), h: parseFloat(panel.style.height) }));
    };
    panelResizeHandle.addEventListener('pointerup', _endPanelResize);
    panelResizeHandle.addEventListener('pointercancel', _endPanelResize);

    let users = [];
    try { users = (await api('/home-notas/usuarios')).usuarios || []; } catch (_) { /* noop */ }

    let tablones = [];
    async function _loadTablones() {
      try { tablones = (await api('/home-tablones')).tablones || []; } catch (_) { tablones = []; }
    }
    await _loadTablones();
    if (!tablones.length) {
      canvas.appendChild(el('p', { class: 'hn-help', text: 'No se pudieron cargar los tablones.' }));
      return;
    }

    const remembered = lsGet('tablon_activo');
    let activeId = tablones.some(t => String(t.id_tablon) === remembered) ? Number(remembered) : tablones[0].id_tablon;

    async function _loadNotas(idTablon) {
      canvas.innerHTML = '';
      canvas.appendChild(skeleton(3));
      let notas = [];
      try {
        const data = await api('/home-notas?id_tablon=' + idTablon);
        notas = data.notas || [];
      } catch (e) {
        canvas.innerHTML = '';
        canvas.appendChild(el('p', { class: 'hn-help', text: 'No se pudieron cargar las notas: ' + (e.message || e) }));
        return;
      }
      const nuevoIds = new Set(notas.filter(n => n.nuevo).map(n => n.id_nota));
      canvas.innerHTML = '';
      if (!notas.length) canvas.appendChild(_homeNotasEmptyNode());
      else for (const n of notas) canvas.appendChild(_buildNotaCard(n, canvas, users, nuevoIds.has(n.id_nota)));
      api('/home-notas/marcar-vistas', { method: 'POST', body: JSON.stringify({ id_tablon: idTablon }) })
        .then(async () => { _syncHomeNotasIcon(); await _loadTablones(); _renderTabs(); })
        .catch(() => {});
    }

    function _renderTabs() {
      tabsRow.innerHTML = '';
      for (const t of tablones) {
        const tab = el('button', { class: 'hn-tab' + (t.id_tablon === activeId ? ' active' : ''), title: t.nombre });
        if (t.nuevas > 0 && t.id_tablon !== activeId) tab.appendChild(el('span', { class: 'hn-tab-dot', title: t.nuevas + ' nota(s) nueva(s) sin ver' }));
        tab.appendChild(el('span', { text: t.nombre }));
        tab.appendChild(el('span', { class: 'hn-tab-count', text: '(' + t.n + ')' }));
        if (t.puede_gestionar) {
          const acts = el('div', { class: 'hn-tab-acts' });
          const ren = el('button', { html: '<i class="fas fa-pen"></i>', title: 'Renombrar tablón' });
          ren.addEventListener('click', (ev) => { ev.stopPropagation(); _renameTablon(t); });
          const del = el('button', { html: '<i class="fas fa-trash"></i>', title: 'Borrar tablón' });
          del.addEventListener('click', (ev) => { ev.stopPropagation(); _deleteTablon(t); });
          acts.append(ren, del);
          tab.appendChild(acts);
        }
        tab.addEventListener('click', () => _switchTo(t.id_tablon));
        tabsRow.appendChild(tab);
      }
      const newTabBtn = el('button', { class: 'hn-tab-new', html: '<i class="fas fa-plus"></i> Nuevo tablón' });
      newTabBtn.addEventListener('click', _createTablon);
      tabsRow.appendChild(newTabBtn);
    }

    async function _switchTo(idTablon) {
      if (idTablon === activeId) return;
      activeId = idTablon;
      lsSet('tablon_activo', String(activeId));
      _renderTabs();
      await _loadNotas(activeId);
    }

    async function _createTablon() {
      const nombre = (prompt('Nombre del nuevo tablón:') || '').trim();
      if (!nombre) return;
      try {
        const r = await api('/home-tablones', { method: 'POST', body: JSON.stringify({ nombre }) });
        await _loadTablones();
        await _switchTo(r.tablon.id_tablon);
        toast('Tablón «' + nombre + '» creado', 'success');
      } catch (e) { toast('No se pudo crear el tablón: ' + (e.message || e), 'error'); }
    }

    async function _renameTablon(t) {
      const nombre = (prompt('Nuevo nombre para «' + t.nombre + '»:', t.nombre) || '').trim();
      if (!nombre || nombre === t.nombre) return;
      try {
        await api('/home-tablones/' + t.id_tablon, { method: 'PUT', body: JSON.stringify({ nombre }) });
        await _loadTablones();
        _renderTabs();
      } catch (e) { toast('No se pudo renombrar: ' + (e.message || e), 'error'); }
    }

    async function _deleteTablon(t) {
      if (!confirm('¿Borrar el tablón «' + t.nombre + '»? Se borrarán sus ' + t.n + ' nota(s). No se puede deshacer.')) return;
      try {
        await api('/home-tablones/' + t.id_tablon, { method: 'DELETE' });
        await _loadTablones();
        if (!tablones.some(x => x.id_tablon === activeId)) activeId = tablones[0].id_tablon;
        lsSet('tablon_activo', String(activeId));
        _renderTabs();
        await _loadNotas(activeId);
        toast('Tablón borrado', 'success');
      } catch (e) { toast('No se pudo borrar: ' + (e.message || e), 'error'); }
    }

    lsSet('tablon_activo', String(activeId));
    _renderTabs();
    await _loadNotas(activeId);

    newBtn.addEventListener('click', async () => {
      const nExisting = canvas.querySelectorAll('.hn-card').length;
      const pos_x = 24 + (nExisting % 6) * 26, pos_y = 24 + (nExisting % 6) * 26;
      try {
        const r = await api('/home-notas', { method: 'POST', body: JSON.stringify({ contenido: '', color: '#FEF08A', visibilidad: 'privada', pos_x, pos_y, id_tablon: activeId }) });
        const emptyMsg = canvas.querySelector('.hn-empty'); if (emptyMsg) emptyMsg.remove();
        const card = _buildNotaCard(r.nota, canvas, users, false);
        canvas.appendChild(card);
        const ta = card.querySelector('textarea'); if (ta) ta.focus();
        await _loadTablones(); _renderTabs();
      } catch (e) { toast('No se pudo crear la nota: ' + (e.message || e), 'error'); }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const mount = document.getElementById('home-notas-icon-mount');
    if (mount) mount.appendChild(homeNotasIconNode());
  });

  window.HomeNotas = { open: openHomeNotasBoard };
})();
