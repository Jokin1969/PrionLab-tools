/**
 * PrionNotes — generic floating post-it board, ported from the PrionAAV
 * Atlas blueprint. Self-contained: state, rendering, drag, sanitizer and
 * wiring all live in this file (window.PVN is the only public surface).
 *
 * Deliberately separate from PrionVault's existing per-article sticky
 * notes (pp-notes-* / PVNotes in prionvault.js, capped at 5 per article)
 * — this is a generic (entity_type, entity_id) board, uncapped, reused
 * both as a global scratchpad (entity_type='workspace', entity_id='global',
 * opened from the sidebar icon) and per-article (entity_type='article',
 * opened from the detail modal badge).
 *
 * Improvements over the blueprint (per its own §6/§2.3 recommendations):
 *   - Hardened whitelist client-side too: no IMG, no style attribute —
 *     matches the hardened server sanitizer from the start, so the
 *     paste-image-to-base64 feature is dropped entirely (not ported).
 *   - Client-side 500KB precheck before submitting, with a visible error
 *     near the save/add button (not a silent failure).
 *   - Visible error messages on network failures for create/update/delete
 *     (blueprint just swallowed these in catch blocks).
 *   - Drag clamps against the bottom/right viewport edges too, not just
 *     top/left.
 */
window.PVN = (() => {
  const API_BASE = '/prionvault';
  const COLORS = ['#fef9c3', '#dcfce7', '#dbeafe', '#fce7f3', '#fff7ed', '#f3e8ff'];
  const MAX_BYTES = 500_000;

  let entityType = null;
  let entityId = null;
  let localNotes = [];
  let quickColor = COLORS[0];
  let detailNoteId = null;

  // Drag state: `active` starts true on mousedown; `dragging` only flips
  // true on the first real mousemove — this is what distinguishes a
  // simple click on the header from an actual drag.
  const drag = { active: false, dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 };

  function el(id) { return document.getElementById(id); }

  /* ── Sanitizer (hardened: no img, no style) ─────────────────────────── */
  const ALLOWED_TAGS = new Set(['B','I','U','STRONG','EM','BR','P','UL','OL','LI','SPAN','DIV','A']);
  const ALLOWED_ATTRS = new Set(['href', 'title']);

  function sanitizeNoteHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    (function clean(node) {
      [...node.childNodes].forEach(child => {
        if (child.nodeType !== Node.ELEMENT_NODE) return;
        if (!ALLOWED_TAGS.has(child.tagName)) {
          child.replaceWith(document.createTextNode(child.textContent));
          return;
        }
        [...child.attributes].forEach(attr => {
          const n = attr.name.toLowerCase();
          const v = attr.value;
          if (child.tagName === 'A' && n === 'href') {
            if (!/^(https?:|mailto:)/i.test(v)) child.removeAttribute(n);
          } else if (!ALLOWED_ATTRS.has(n)) {
            child.removeAttribute(n);
          }
        });
        if (child.tagName === 'A') {
          child.setAttribute('rel', 'noopener noreferrer');
          child.setAttribute('target', '_blank');
        }
        clean(child);
      });
    })(tmp);
    return tmp.innerHTML;
  }

  function htmlToText(html) {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.textContent || '';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  }

  function showError(targetId, msg) {
    const box = el(targetId);
    if (!box) return;
    box.textContent = msg;
    box.style.display = 'block';
  }
  function clearError(targetId) {
    const box = el(targetId);
    if (!box) return;
    box.style.display = 'none';
    box.textContent = '';
  }

  /* ── HTTP helpers ────────────────────────────────────────────────────── */
  async function req(path, opts) {
    let res;
    try {
      res = await fetch(API_BASE + path, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        ...opts,
      });
    } catch (netErr) {
      const e = new Error('Red caída o servidor reiniciándose. Reintenta en unos segundos.');
      e.network = true;
      throw e;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const e = new Error(body.detail || body.error || ('HTTP ' + res.status));
      e.status = res.status;
      throw e;
    }
    return res.status === 204 ? null : res.json();
  }

  /* ── Open / close main panel ─────────────────────────────────────────── */
  async function open(type, id, label) {
    entityType = type;
    entityId = String(id);
    localNotes = [];
    const labelEl = el('pvn-notes-panel-label');
    if (labelEl) labelEl.textContent = label || entityId;
    const grid = el('pvn-notes-grid');
    if (grid) grid.innerHTML = '<div style="padding:20px;text-align:center;color:#94a3b8;font-size:0.8rem">Cargando…</div>';
    clearError('pvn-notes-error');
    showPanel();
    try {
      localNotes = await req(`/api/prionnotes/${entityType}/${encodeURIComponent(entityId)}`, { method: 'GET' });
    } catch (e) {
      localNotes = [];
      showError('pvn-notes-error', e.message || 'No se pudieron cargar las notas.');
    }
    renderGrid();
    renderColors('pvn-notes-colors', quickColor, c => { quickColor = c; });
  }

  function showPanel() {
    const bd = el('pvn-notes-backdrop');
    const pn = el('pvn-notes-panel');
    if (!bd || !pn) return;
    bd.style.display = 'block';
    pn.style.display = 'flex';
    requestAnimationFrame(() => { bd.classList.add('active'); pn.classList.add('active'); });
    const ta = el('pvn-notes-textarea');
    if (ta) { ta.value = ''; ta.focus(); }
    initDrag();
  }

  function closePanel() {
    const bd = el('pvn-notes-backdrop');
    const pn = el('pvn-notes-panel');
    if (!bd || !pn) return;
    bd.classList.remove('active');
    pn.classList.remove('active');
    // Position is never persisted: reset inline drag position so the
    // panel reopens anchored via CSS (top/right) next time.
    pn.style.left = '';
    pn.style.right = '';
    pn.style.top = '';
    setTimeout(() => { bd.style.display = 'none'; pn.style.display = 'none'; }, 230);
    document.onmousemove = null;
    document.onmouseup = null;
    drag.active = false;
    drag.dragging = false;
  }

  /* ── Grid rendering ──────────────────────────────────────────────────── */
  function renderGrid() {
    const grid = el('pvn-notes-grid');
    if (!grid) return;
    grid.innerHTML = '';
    for (const n of localNotes) {
      const card = document.createElement('div');
      card.className = 'pvn-note-card';
      card.style.background = n.color || COLORS[0];
      card.innerHTML = sanitizeNoteHtml(n.text);
      const footer = document.createElement('div');
      footer.className = 'pvn-note-card-footer';
      const dateEl = document.createElement('span');
      dateEl.className = 'pvn-note-card-date';
      dateEl.textContent = fmtDate(n.updated_at || n.created_at);
      const delBtn = document.createElement('button');
      delBtn.className = 'pvn-note-card-del';
      delBtn.title = 'Eliminar nota';
      delBtn.textContent = '🗑';
      delBtn.type = 'button';
      delBtn.addEventListener('click', e => { e.stopPropagation(); deleteNote(n.id); });
      footer.appendChild(dateEl);
      footer.appendChild(delBtn);
      card.appendChild(footer);
      card.addEventListener('click', () => openDetail(n));
      grid.appendChild(card);
    }
  }

  function renderColors(containerId, activeColor, onChange) {
    const c = el(containerId);
    if (!c) return;
    c.innerHTML = '';
    COLORS.forEach(col => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'pvn-color-dot' + (col === activeColor ? ' active' : '');
      dot.style.background = col;
      dot.title = col;
      dot.addEventListener('click', () => {
        onChange(col);
        c.querySelectorAll('.pvn-color-dot').forEach(d => d.classList.remove('active'));
        dot.classList.add('active');
        if (containerId === 'pvn-note-detail-colors') {
          const content = el('pvn-note-detail-content');
          if (content) content.style.background = col;
        }
      });
      c.appendChild(dot);
    });
  }

  /* ── CRUD ────────────────────────────────────────────────────────────── */
  function sizeCheck(html, targetErrorId) {
    if (new Blob([html]).size > MAX_BYTES) {
      showError(targetErrorId, 'La nota es demasiado larga (máx. 500 KB). Acórtala antes de guardar.');
      return false;
    }
    return true;
  }

  async function addNote() {
    if (!entityType || !entityId) return;
    clearError('pvn-notes-error');
    const ta = el('pvn-notes-textarea');
    const raw = (ta?.value || '').trim();
    if (!raw) return;
    const html = sanitizeNoteHtml(raw.replace(/\n/g, '<br>'));
    if (!sizeCheck(html, 'pvn-notes-error')) return;
    try {
      const note = await req(`/api/prionnotes/${entityType}/${encodeURIComponent(entityId)}`, {
        method: 'POST',
        body: JSON.stringify({ text: html, color: quickColor }),
      });
      localNotes.push(note);
      renderGrid();
      updateBadges();
      if (ta) ta.value = '';
    } catch (e) {
      showError('pvn-notes-error', e.message || 'No se pudo añadir la nota.');
    }
  }

  async function deleteNote(noteId) {
    if (!entityType || !entityId) return;
    if (!confirm('¿Eliminar esta nota?')) return;
    try {
      await req(`/api/prionnotes/${entityType}/${encodeURIComponent(entityId)}/${noteId}`, { method: 'DELETE' });
      localNotes = localNotes.filter(n => n.id !== noteId);
      renderGrid();
      updateBadges();
    } catch (e) {
      showError('pvn-notes-error', e.message || 'No se pudo eliminar la nota.');
    }
  }

  /* ── Detail modal (rich edit) ───────────────────────────────────────── */
  function openDetail(note) {
    detailNoteId = note.id;
    const bd = el('pvn-note-detail-backdrop');
    const panel = el('pvn-note-detail');
    const content = el('pvn-note-detail-content');
    const dateEl = el('pvn-note-detail-date');
    if (!panel || !content) return;
    clearError('pvn-note-detail-error');
    content.innerHTML = sanitizeNoteHtml(note.text);
    content.style.background = note.color || COLORS[0];
    if (dateEl) dateEl.textContent = fmtDate(note.updated_at || note.created_at);
    renderColors('pvn-note-detail-colors', note.color || COLORS[0], () => {});
    bd.style.display = 'block';
    panel.style.display = 'flex';
    requestAnimationFrame(() => { bd.classList.add('active'); panel.classList.add('active'); });
    content.focus();
  }

  function closeDetail() {
    const bd = el('pvn-note-detail-backdrop');
    const panel = el('pvn-note-detail');
    if (!bd || !panel) return;
    bd.classList.remove('active');
    panel.classList.remove('active');
    setTimeout(() => { bd.style.display = 'none'; panel.style.display = 'none'; }, 210);
    detailNoteId = null;
  }

  function getDetailActiveColor() {
    const c = el('pvn-note-detail-colors');
    const active = c?.querySelector('.pvn-color-dot.active');
    return active ? active.title : COLORS[0];
  }

  async function saveDetail() {
    if (!entityType || !entityId || !detailNoteId) return;
    clearError('pvn-note-detail-error');
    const content = el('pvn-note-detail-content');
    const html = sanitizeNoteHtml(content?.innerHTML || '');
    if (!htmlToText(html).trim()) {
      showError('pvn-note-detail-error', 'La nota no puede estar vacía.');
      return;
    }
    if (!sizeCheck(html, 'pvn-note-detail-error')) return;
    try {
      const updated = await req(`/api/prionnotes/${entityType}/${encodeURIComponent(entityId)}/${detailNoteId}`, {
        method: 'PUT',
        body: JSON.stringify({ text: html, color: getDetailActiveColor() }),
      });
      localNotes = localNotes.map(n => n.id === detailNoteId ? updated : n);
      renderGrid();
      updateBadges();
      closeDetail();
    } catch (e) {
      showError('pvn-note-detail-error', e.message || 'No se pudo guardar la nota.');
    }
  }

  async function deleteCurrentDetail() {
    if (!detailNoteId) return;
    const id = detailNoteId;
    closeDetail();
    await deleteNote(id);
  }

  /* ── Badges ──────────────────────────────────────────────────────────── */
  function updateBadges() {
    document.querySelectorAll(`[data-pvn-id="${CSS.escape(entityId)}"][data-pvn-type="${CSS.escape(entityType)}"]`)
      .forEach(badge => {
        const count = localNotes.length;
        if (count === 0) {
          badge.classList.remove('has-notes');
          badge.classList.add('pvn-badge-empty');
          badge.title = 'PrionNotes';
        } else {
          badge.classList.add('has-notes');
          badge.classList.remove('pvn-badge-empty');
          badge.title = `${count} nota${count !== 1 ? 's' : ''}`;
        }
      });
  }

  /* ── Drag (clamped on all four edges) ───────────────────────────────── */
  function initDrag() {
    const handle = el('pvn-notes-drag');
    const panel = el('pvn-notes-panel');
    if (!handle || !panel) return;
    handle.onmousedown = e => {
      if (e.target.closest('#pvn-notes-close')) return;
      drag.active = true;
      drag.dragging = false;
      drag.startX = e.clientX;
      drag.startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      drag.origX = rect.left;
      drag.origY = rect.top;
      panel.style.transition = 'none';
    };
    document.onmousemove = e => {
      if (!drag.active) return;
      if (!drag.dragging) {
        drag.dragging = true;
        panel.style.right = 'auto';
      }
      const rect = panel.getBoundingClientRect();
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      const maxLeft = window.innerWidth - rect.width;
      const maxTop = window.innerHeight - rect.height;
      panel.style.left = Math.min(Math.max(0, drag.origX + dx), Math.max(0, maxLeft)) + 'px';
      panel.style.top = Math.min(Math.max(0, drag.origY + dy), Math.max(0, maxTop)) + 'px';
    };
    document.onmouseup = () => {
      if (drag.active) { drag.active = false; panel.style.transition = ''; }
    };
  }

  /* ── Wiring ──────────────────────────────────────────────────────────── */
  function wireBadge(elm, type, id) {
    if (!elm) return;
    elm.dataset.pvnId = id;
    elm.dataset.pvnType = type;
    elm.addEventListener('click', e => {
      e.stopPropagation();
      open(type, id, id);
    });
  }

  function init() {
    const sidebarBtn = el('pvn-sidebar-btn');
    if (sidebarBtn) sidebarBtn.addEventListener('click', () => open('workspace', 'global', 'Notas generales'));

    const closeBtn = el('pvn-notes-close');
    if (closeBtn) closeBtn.addEventListener('click', closePanel);
    // Click-outside only closes the detail modal, not the main panel
    // (matches the blueprint's documented, intentional asymmetry).
    const detailBd = el('pvn-note-detail-backdrop');
    if (detailBd) detailBd.addEventListener('click', closeDetail);

    const addBtn = el('pvn-notes-add-btn');
    if (addBtn) addBtn.addEventListener('click', addNote);
    const ta = el('pvn-notes-textarea');
    if (ta) ta.addEventListener('keydown', e => {
      // Enter submits, Shift+Enter = newline — quick-add textarea only.
      // The rich detail editor is save-button-only (never Enter-to-save).
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addNote(); }
    });

    const detailClose = el('pvn-note-detail-close');
    if (detailClose) detailClose.addEventListener('click', closeDetail);
    const detailSave = el('pvn-note-detail-save');
    if (detailSave) detailSave.addEventListener('click', saveDetail);
    const detailDelete = el('pvn-note-detail-delete');
    if (detailDelete) detailDelete.addEventListener('click', deleteCurrentDetail);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { open, wireBadge };
})();
