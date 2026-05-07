/* PrionPacks – Main application logic */

const PrionPacks = (() => {
  /* ── State ─────────────────────────────────────────────────────────────── */
  let _packages = [];
  let _members  = [];

  // Curated palette: value (stored in member), bg (card), hover, badge (initials circle + toolbar badge), text (dark)
  const MEMBER_PALETTE = [
    { value:'#3b82f6', bg:'#dbeafe', hover:'#bfdbfe', badge:'#93c5fd', text:'#1e40af' }, // blue
    { value:'#22c55e', bg:'#dcfce7', hover:'#bbf7d0', badge:'#86efac', text:'#15803d' }, // green
    { value:'#f97316', bg:'#ffedd5', hover:'#fed7aa', badge:'#fdba74', text:'#c2410c' }, // orange
    { value:'#a855f7', bg:'#ede9fe', hover:'#ddd6fe', badge:'#c4b5fd', text:'#6d28d9' }, // purple
    { value:'#ec4899', bg:'#fce7f3', hover:'#fbcfe8', badge:'#f9a8d4', text:'#be185d' }, // pink
    { value:'#ef4444', bg:'#fee2e2', hover:'#fecaca', badge:'#fca5a5', text:'#b91c1c' }, // red
    { value:'#14b8a6', bg:'#ccfbf1', hover:'#99f6e4', badge:'#5eead4', text:'#0f766e' }, // teal
    { value:'#6366f1', bg:'#e0e7ff', hover:'#c7d2fe', badge:'#a5b4fc', text:'#4338ca' }, // indigo
    { value:'#eab308', bg:'#fef9c3', hover:'#fef08a', badge:'#fde047', text:'#a16207' }, // yellow
    { value:'#84cc16', bg:'#f7fee7', hover:'#ecfccb', badge:'#bef264', text:'#4d7c0f' }, // lime
    { value:'#06b6d4', bg:'#cffafe', hover:'#a5f3fc', badge:'#67e8f9', text:'#0e7490' }, // cyan
    { value:'#f43f5e', bg:'#ffe4e6', hover:'#fecdd3', badge:'#fda4af', text:'#be123c' }, // rose
  ];

  let state = {
    currentId: null,
    view: 'dashboard',
    search: '',
    searchMode: 'simple',  // 'simple' | 'advanced'
    filterStatus: 'all',
    filterPriority: 'all',
    filterResponsible: 'all',
  };

  // Post-it note colors (bg, text-on-bg)
  const NOTE_COLORS = [
    { value: '#fef9c3', text: '#713f12', name: 'Amarillo' },
    { value: '#fce7f3', text: '#831843', name: 'Rosa' },
    { value: '#dbeafe', text: '#1e3a8a', name: 'Azul' },
    { value: '#dcfce7', text: '#14532d', name: 'Verde' },
    { value: '#ffedd5', text: '#7c2d12', name: 'Naranja' },
    { value: '#f3e8ff', text: '#3b0764', name: 'Lavanda' },
  ];

  let _notesPkgId   = null;   // package currently shown in notes panel
  let _notesColor   = NOTE_COLORS[0].value; // selected color for new note
  let _micRecog     = null;   // SpeechRecognition instance

  let _imgUploadCallback = null; // set while image-upload modal is open

  const PRIORITY_LABELS = { high: 'High', medium: 'Medium', low: 'Low', none: 'No priority' };

  /* ── Init ──────────────────────────────────────────────────────────────── */
  async function init() {
    _bindGlobalEvents();
    _bindModalEvents();
    _bindMembersEvents();
    _bindNotesEvents();
    _bindNoteDetailEvents();
    _bindMobileEvents();
    _loadApiKeyField();
    _bindKeyboardShortcuts();
    await _fetchAndRender();
  }

  async function _fetchAndRender() {
    try {
      _packages = await PPStorage.loadAll();
    } catch (e) {
      toast('Could not load packages from server: ' + e.message, 'error');
      _packages = [];
    }
    try {
      _members = await _fetchMembers();
    } catch (e) {
      _members = [];
    }
    _renderResponsibleChips();
    _syncResponsibleChips();
    _renderDashboard();
  }

  async function _fetchMembers() {
    const res = await fetch('/prionpacks/api/members');
    if (!res.ok) throw new Error(res.statusText);
    return res.json();
  }

  /* ── Navigation ────────────────────────────────────────────────────────── */
  function showView(name) {
    state.view = name;
    document.querySelectorAll('.pp-view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + name).classList.add('active');
    _highlightSidebarItem(state.currentId);
  }

  function _highlightSidebarItem(id) {
    document.querySelectorAll('.pp-package-item').forEach(el => {
      el.classList.toggle('active', el.dataset.id === id);
    });
  }

  function showDashboard() {
    state.currentId = null;
    _renderDashboard();
    showView('dashboard');
  }

  function showEditor(id) {
    state.currentId = id;
    const pkg = id ? _packages.find(p => p.id === id) : null;
    _populateEditor(pkg);
    showView('editor');
    _highlightSidebarItem(id);
    // Reset scroll so the first card is fully visible below the sticky toolbar
    const main = document.querySelector('.pp-main');
    if (main) main.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  /* ── Dashboard ─────────────────────────────────────────────────────────── */
  function _renderDashboard() {
    const filtered = _filteredPackages();
    _renderMetrics();
    _renderPackageCards(filtered);
    _renderSidebarList();
  }

  function _norm(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  // Flatten a package into a single normalised "haystack" string covering
  // every user-typed field (top-level cards, findings, gaps, methods,
  // references, alt-titles, etc.) so the search hits content inside the
  // reference abstracts too.
  function _packageHaystack(p) {
    const parts = [
      p.title, p.id, p.description, p.introduction, p.discussion,
      p.coAuthors, p.affiliations, p.abstract, p.authorSummary,
      p.acknowledgments, p.funding, p.conflictsOfInterest, p.credit,
      ...(p.altTitles || []),
      ...(Array.isArray(p.references) ? p.references : [p.references]),
      ...(Array.isArray(p.introReferences) ? p.introReferences : [p.introReferences]),
      ...((p.methods || []).flatMap(m => typeof m === 'string' ? [m] : [m?.title, m?.body])),
      ...((p.findings || []).flatMap(f => [
        f.title, f.titleEnglish, f.description,
        ...(f.figures || []).flatMap(fig => [fig.description, fig.caption]),
        ...(f.tables  || []).map(tbl => tbl.description),
      ])),
      ...((p.gaps?.missingInfo || []).flatMap(g => typeof g === 'string'
        ? [g]
        : [g?.text, g?.neededExperiment])),
    ];
    return parts.map(_norm).filter(Boolean).join('   ');
  }

  // Split an advanced query on , ; tab newline OR runs of 2+ spaces.
  // Single-space-separated phrases are preserved as one token so the user
  // can still search for "RT-QuIC sensitivity" without having to quote it.
  function _splitAdvancedTokens(q) {
    return String(q || '')
      .split(/[,;\t\n]|\s{2,}/)
      .map(t => _norm(t.trim()))
      .filter(Boolean);
  }

  function _matchesSearch(p, q) {
    if (!q) return true;
    const haystack = _packageHaystack(p);
    if (state.searchMode === 'advanced') {
      const tokens = _splitAdvancedTokens(q);
      if (!tokens.length) return true;
      // OR-semantics: a package matches if ANY of the tokens is found.
      return tokens.some(t => haystack.includes(t));
    }
    return haystack.includes(_norm(q));
  }

  function _filteredPackages() {
    const q = _norm(state.search);
    return _packages.filter(p => {
      if (!_matchesSearch(p, q)) return false;
      const s = p.scores?.total ?? 0;
      if (state.filterStatus === 'initial'  && s >= 50) return false;
      if (state.filterStatus === 'progress' && (s < 50 || s >= 90)) return false;
      if (state.filterStatus === 'complete' && s < 90) return false;
      if (state.filterPriority !== 'all' && p.priority !== state.filterPriority) return false;
      if (state.filterResponsible !== 'all') {
        const r = p.responsible || '';
        if (state.filterResponsible === 'none' && r) return false;
        if (state.filterResponsible !== 'none' && r !== state.filterResponsible) return false;
      }
      return true;
    });
  }

  function _renderMetrics() {
    const all = _packages;
    const complete = all.filter(p => (p.scores?.total ?? 0) >= 90).length;
    const progress = all.filter(p => { const s = p.scores?.total ?? 0; return s >= 50 && s < 90; }).length;
    const avg = all.length ? Math.round(all.reduce((a, p) => a + (p.scores?.total ?? 0), 0) / all.length) : 0;
    document.getElementById('metric-total').textContent = all.length;
    document.getElementById('metric-complete').textContent = complete;
    document.getElementById('metric-progress').textContent = progress;
    document.getElementById('metric-avg').textContent = avg + '%';
    document.querySelectorAll('.pp-metric-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === state.filterStatus);
    });
  }

  function _renderPackageCards(packages) {
    const grid = document.getElementById('pp-cards-grid');
    const empty = document.getElementById('pp-empty-state');
    if (!packages.length) {
      grid.innerHTML = '';
      empty.style.display = 'flex';
      return;
    }
    empty.style.display = 'none';
    grid.innerHTML = packages.map(_pkgCardHTML).join('');
    grid.querySelectorAll('.pp-pkg-card').forEach(card => {
      card.addEventListener('click', () => { _closeMobileSidebar(); showEditor(card.dataset.id); });
    });
    grid.querySelectorAll('.pp-pkg-priority-dot').forEach(dot => {
      dot.addEventListener('click', e => { e.stopPropagation(); _cyclePriorityCard(dot); });
    });
    grid.querySelectorAll('.pp-notes-badge').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); _openNotes(btn.dataset.notesId); });
    });
  }

  function _memberColors(hexColor) {
    return MEMBER_PALETTE.find(p => p.value === hexColor) || MEMBER_PALETTE[0];
  }

  function _responsibleConfig(id) {
    const m = _members.find(m => m.id === id);
    if (!m) return null;
    const c = _memberColors(m.color);
    return { initials: m.initials, label: `${m.name} ${m.surname}`, ...c };
  }

  function _pkgCardHTML(p) {
    const score = p.scores?.total ?? 0;
    const fillClass = score >= 90 ? 'pp-fill-complete' : score >= 50 ? 'pp-fill-progress' : 'pp-fill-initial';
    const date = p.lastModified ? new Date(p.lastModified).toLocaleDateString() : '—';
    const findings = (p.findings || []).length;
    const inactive = p.active === false;
    const inactiveCls = inactive ? ' pp-pkg-card-inactive' : '';
    const inactiveBadge = inactive ? '<span class="pp-inactive-badge">Inactivo</span>' : '';
    const resp = _responsibleConfig(p.responsible);
    const cardStyle = resp
      ? `--m-bg:${resp.bg};--m-hover:${resp.hover};--m-badge:${resp.badge};--m-text:${resp.text};`
      : '';
    const respBadge = resp
      ? `<div class="pp-responsible-badge" style="background:${resp.badge};color:${resp.text};" title="${_esc(resp.label)}">${_esc(resp.initials)}</div>`
      : '';
    return `
    <div class="pp-pkg-card${inactiveCls}" data-id="${p.id}" data-responsible="${_esc(p.responsible||'')}" style="${cardStyle}">
      <div class="pp-pkg-card-header">
        <div class="pp-pkg-priority-dot" data-id="${p.id}" data-priority="${p.priority}"
          style="background:${_priorityColor(p.priority)};" title="Click to change priority"></div>
        <div class="pp-pkg-card-body">
          <div class="pp-pkg-card-id">${p.id} ${inactiveBadge}</div>
          <div class="pp-pkg-card-title">${_supHtml(p.title)}</div>
        </div>
        <div class="pp-pkg-card-right">
          ${_notesBadgeHTML(p)}
          ${respBadge}
        </div>
      </div>
      <div class="pp-pkg-card-progress">
        <div class="pp-progress-header"><span>Completeness</span><span>${score}%</span></div>
        <div class="pp-progress-bar">
          <div class="pp-progress-fill ${fillClass}" style="width:${score}%"></div>
        </div>
      </div>
      <div class="pp-pkg-card-footer">
        <span>${findings} finding${findings !== 1 ? 's' : ''}</span>
        <span>${date}</span>
      </div>
    </div>`;
  }

  function _renderSidebarList() {
    const list = document.getElementById('pp-package-list');
    if (!_packages.length) {
      list.innerHTML = '<div style="padding:16px;font-size:12px;color:var(--pp-text-dim);">No packages yet</div>';
      return;
    }
    list.innerHTML = _packages.map(p => {
      const score = p.scores?.total ?? 0;
      const active = p.id === state.currentId ? ' active' : '';
      const inactive = p.active === false ? ' pp-package-item-inactive' : '';
      const inactiveBadge = p.active === false ? '<span class="pp-inactive-badge pp-inactive-badge-sm">Inactivo</span>' : '';
      return `
      <div class="pp-package-item${active}${inactive}" data-id="${p.id}">
        <div class="pp-package-item-dot" style="background:${_priorityColor(p.priority)};"></div>
        <div class="pp-package-item-body">
          <div class="pp-package-item-title">${_supHtml(p.title)} ${inactiveBadge}</div>
          <div class="pp-package-item-meta">
            <span>${p.id}</span>
            <div class="pp-package-item-bar"><div class="pp-package-item-bar-fill" style="width:${score}%;"></div></div>
            <span>${score}%</span>
          </div>
        </div>
      </div>`;
    }).join('');
    list.querySelectorAll('.pp-package-item').forEach(item => {
      item.addEventListener('click', () => showEditor(item.dataset.id));
    });
  }

  async function _cyclePriorityCard(dot) {
    const id = dot.dataset.id;
    const order = ['none', 'low', 'medium', 'high'];
    const next = order[(order.indexOf(dot.dataset.priority || 'none') + 1) % order.length];
    const pkg = _packages.find(p => p.id === id);
    if (!pkg) return;
    try {
      const updated = await PPStorage.update(id, { ...pkg, priority: next });
      const idx = _packages.findIndex(p => p.id === id);
      if (idx >= 0) _packages[idx] = updated;
      dot.dataset.priority = next;
      dot.style.background = _priorityColor(next);
      dot.title = PRIORITY_LABELS[next];
      _renderSidebarList();
    } catch (e) {
      toast('Could not update priority: ' + e.message, 'error');
    }
  }

  /* ── Editor ────────────────────────────────────────────────────────────── */
  /* ── Send for Review ───────────────────────────────────────────────────── */
  let _selectedColleagues = new Set();
  let _claudeModalCallback = null;

  /* ── Investigations file attachments ──────────────────────────────────── */
  const INV_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

  function _invMimeFromFile(file) {
    if (file.type) return file.type;
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'pdf')  return 'application/pdf';
    if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    return 'application/msword';
  }

  function _invIsPdf(mimeType) { return mimeType === 'application/pdf'; }

  function _createInvFileChip(file) {
    const chip = document.createElement('div');
    chip.className = 'pp-inv-chip';
    chip.dataset.dataUrl  = file.dataUrl;
    chip.dataset.mimeType = file.mimeType;
    chip.dataset.name     = file.name;
    chip.dataset.id       = file.id;

    const isPdf = _invIsPdf(file.mimeType);
    const iconClass = isPdf ? 'fa-file-pdf pp-inv-icon-pdf' : 'fa-file-word pp-inv-icon-word';

    chip.innerHTML = `
      <button class="pp-inv-chip-open" title="${isPdf ? 'Abrir en nueva pestaña' : 'Descargar'}">
        <i class="fas ${iconClass} pp-inv-file-icon"></i>
        <span class="pp-inv-chip-name">${_esc(file.name)}</span>
      </button>
      <button class="pp-ai-btn pp-ai-btn-xs pp-inv-file-ai-btn" data-ai-label="Documento adjunto: ${_esc(file.name)}" title="${isPdf ? 'Incluir PDF como contexto para Claude' : 'Solo PDFs pueden enviarse a Claude'}">AI</button>
      <button class="pp-inv-chip-remove pp-btn-icon" title="Eliminar"><i class="fas fa-times"></i></button>`;

    chip.querySelector('.pp-inv-chip-open').addEventListener('click', () => _openInvFile(chip));
    chip.querySelector('.pp-inv-chip-remove').addEventListener('click', () => { chip.remove(); _scheduleAutosave(); });
    chip.querySelector('.pp-inv-file-ai-btn').addEventListener('click', e => {
      e.currentTarget.classList.toggle('active');
    });

    return chip;
  }

  function _openInvFile(chip) {
    const dataUrl  = chip.dataset.dataUrl;
    const mimeType = chip.dataset.mimeType;
    const name     = chip.dataset.name;
    const base64   = dataUrl.split(',')[1];
    const bytes    = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const blob     = new Blob([bytes], { type: mimeType });
    const url      = URL.createObjectURL(blob);
    if (_invIsPdf(mimeType)) {
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 15000);
    } else {
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
    }
  }

  function _renderInvFiles(files) {
    const list = document.getElementById('investigations-files');
    if (!list) return;
    list.innerHTML = '';
    (files || []).forEach(f => list.appendChild(_createInvFileChip(f)));
    _updateCollapseIndicators();
  }

  function _handleInvFiles(fileList) {
    const list = document.getElementById('investigations-files');
    if (!list) return;
    Array.from(fileList).forEach(file => {
      if (file.size > INV_MAX_BYTES) {
        toast(`"${file.name}" supera el límite de 25 MB.`, 'error');
        return;
      }
      const mimeType = _invMimeFromFile(file);
      const reader = new FileReader();
      reader.onload = ev => {
        const chip = _createInvFileChip({
          id:       'inv' + Date.now() + Math.random().toString(36).slice(2),
          name:     file.name,
          mimeType,
          dataUrl:  ev.target.result,
        });
        list.appendChild(chip);
        _scheduleAutosave();
      };
      reader.readAsDataURL(file);
    });
  }

  function _collectInvFiles() {
    return Array.from(document.querySelectorAll('#investigations-files .pp-inv-chip')).map(chip => ({
      id:       chip.dataset.id,
      name:     chip.dataset.name,
      mimeType: chip.dataset.mimeType,
      dataUrl:  chip.dataset.dataUrl,
    }));
  }

  function _getAIDocuments() {
    return Array.from(document.querySelectorAll('.pp-inv-file-ai-btn.active')).flatMap(btn => {
      const chip = btn.closest('.pp-inv-chip');
      if (!chip || !_invIsPdf(chip.dataset.mimeType)) return [];
      return [{ name: chip.dataset.name, mimeType: chip.dataset.mimeType, dataUrl: chip.dataset.dataUrl }];
    });
  }

  function _getAIContext() {
    const items = [];
    document.querySelectorAll('.pp-ai-btn.active').forEach(btn => {
      const fieldId  = btn.dataset.fieldId;
      const label    = btn.dataset.aiLabel || 'Campo';
      const text     = fieldId ? (document.getElementById(fieldId)?.value || '').trim() : '';
      if (text) items.push({ label, text });
    });
    return items;
  }

  // Centralised handler for errors coming back from PPApi. If Claude refused
  // the prompt, copy the prompt to the clipboard so the user can paste it
  // into ChatGPT / Gemini / etc.
  async function _handleClaudeError(err, errorPrefix) {
    if (err && err.name === 'RefusalError' && err.prompt) {
      let copied = false;
      try {
        await navigator.clipboard.writeText(err.prompt);
        copied = true;
      } catch {
        try {
          const tmp = document.createElement('textarea');
          tmp.value = err.prompt;
          document.body.appendChild(tmp);
          tmp.select();
          document.execCommand('copy');
          tmp.remove();
          copied = true;
        } catch { /* give up */ }
      }
      const msg = copied
        ? '🤖 Claude rehusó. Prompt copiado al portapapeles — pégalo en otra IA (ChatGPT, Gemini…).'
        : '🤖 Claude rehusó y no se pudo copiar el prompt al portapapeles.';
      toast(msg, 'success');
      return;
    }
    toast((errorPrefix || 'Error') + ': ' + err.message, 'error');
  }

  async function _askClaudeField(sourceId, sourceLabel) {
    const sourceEl = document.getElementById(sourceId);
    if (!sourceEl) return;
    const sourceText = sourceEl.value.trim();
    if (!sourceText) { toast('El campo está vacío.', 'error'); return; }

    const context   = _getAIContext().filter(c => !(c.label === sourceLabel && c.text === sourceText));
    const documents = _getAIDocuments();

    _showClaudeModal(null, null, null);
    try {
      const response = await PPApi.askClaude(context, sourceLabel, sourceText, null, documents);
      _showClaudeModal(response, sourceEl, sourceLabel);
    } catch (e) {
      _closeClaudeModal();
      await _handleClaudeError(e, 'Error llamando a Claude');
    }
  }

  async function _askClaudeCaption(figDiv, capTextarea) {
    const capText = capTextarea.value.trim();
    if (!capText && !figDiv.dataset.imageUrl) {
      toast('Añade una descripción o imagen primero.', 'error'); return;
    }

    const context = _getAIContext();
    const imageDataUrl = (figDiv.dataset.imageAsContext === '1' && figDiv.dataset.imageUrl)
      ? figDiv.dataset.imageUrl
      : null;

    _showClaudeModal(null, null, null);
    // Override callback to set capTextarea value
    try {
      const response = await PPApi.askClaude(context, 'Pie de figura', capText || '(describe this figure)', imageDataUrl);
      // Show modal with custom callback
      const modal       = document.getElementById('pp-claude-modal');
      const loading     = document.getElementById('pp-claude-loading');
      const responseEl  = document.getElementById('pp-claude-response-text');
      const footer      = document.getElementById('pp-claude-modal-footer');
      const hint        = document.getElementById('pp-claude-field-hint');

      loading.style.display    = 'none';
      responseEl.style.display = '';
      responseEl.textContent   = response;
      footer.style.display     = '';
      hint.textContent         = '→ Campo: Pie de figura';
      _claudeModalCallback = () => {
        capTextarea.value = response;
        capTextarea.dispatchEvent(new Event('input', { bubbles: true }));
      };
      modal.style.display = '';
    } catch (e) {
      _closeClaudeModal();
      await _handleClaudeError(e, 'Error llamando a Claude');
    }
  }

  function _showClaudeModal(text, sourceEl, sourceLabel) {
    const modal       = document.getElementById('pp-claude-modal');
    const loading     = document.getElementById('pp-claude-loading');
    const responseEl  = document.getElementById('pp-claude-response-text');
    const footer      = document.getElementById('pp-claude-modal-footer');
    const hint        = document.getElementById('pp-claude-field-hint');

    if (text === null) {
      loading.style.display    = '';
      responseEl.style.display = 'none';
      responseEl.textContent   = '';
      footer.style.display     = 'none';
      _claudeModalCallback     = null;
    } else {
      loading.style.display    = 'none';
      responseEl.style.display = '';
      responseEl.textContent   = text;
      footer.style.display     = '';
      hint.textContent         = `→ Campo: ${sourceLabel}`;
      _claudeModalCallback = () => {
        sourceEl.value = text;
        sourceEl.dispatchEvent(new Event('input', { bubbles: true }));
      };
    }
    modal.style.display = '';
  }

  function _closeClaudeModal() {
    document.getElementById('pp-claude-modal').style.display = 'none';
    _claudeModalCallback = null;
  }

  function _openSendModal() {
    if (!state.currentId) return;
    _selectedColleagues = new Set();
    document.querySelectorAll('.pp-colleague-card').forEach(c => {
      c.classList.remove('selected');
      c.setAttribute('aria-pressed', 'false');
    });
    _updateSendBtnState();
    document.getElementById('pp-send-modal').style.display = '';
  }

  function _closeSendModal() {
    document.getElementById('pp-send-modal').style.display = 'none';
  }

  function _updateSendBtnState() {
    const count = _selectedColleagues.size;
    const btn   = document.getElementById('pp-send-btn');
    const label = document.getElementById('pp-send-btn-label');
    if (!btn || !label) return;
    btn.disabled = count === 0;
    label.textContent = count === 0
      ? 'Enviar documento'
      : count === 1
        ? 'Enviar a 1 destinatario'
        : `Enviar a ${count} destinatarios`;
  }

  async function _sendReview() {
    if (_selectedColleagues.size === 0 || !state.currentId) return;
    const btn = document.getElementById('pp-send-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando…';
    try {
      const resp = await fetch(`/prionpacks/api/packages/${state.currentId}/send-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients: Array.from(_selectedColleagues) }),
      });

      // SMTP not configured — server returns the file directly
      if (resp.headers.get('X-PP-SMTP-Missing') === '1') {
        const newVersion = resp.headers.get('X-PP-Version') || '1';
        const blob = await resp.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        const cd   = resp.headers.get('Content-Disposition') || '';
        const m    = cd.match(/filename="([^"]+)"/);
        a.href = url; a.download = m ? m[1] : 'package.docx';
        a.click(); URL.revokeObjectURL(url);
        _closeSendModal();
        _updateVersionBadge(parseInt(newVersion, 10));
        toast('SMTP no configurado — documento descargado localmente.', 'info');
        return;
      }

      const data = await resp.json();
      if (!resp.ok) { toast(data.error || 'Error enviando.', 'error'); return; }
      _closeSendModal();
      _updateVersionBadge(data.version);
      const sentNames = (data.sent || []).map(r => r.name).join(', ');
      const failedCount = (data.failed || []).length;
      if (failedCount > 0) {
        toast(`v${data.version} enviada a ${sentNames}. Falló para ${failedCount} destinatario/s.`, 'info');
      } else {
        toast(`Documento v${data.version} enviado a ${sentNames}.`, 'success');
      }
    } catch (err) {
      toast('Error de red: ' + err.message, 'error');
    } finally {
      btn.innerHTML = '<i class="fas fa-paper-plane"></i> <span id="pp-send-btn-label">Enviar documento</span>';
      _updateSendBtnState();
    }
  }

  function _updateVersionBadge(version) {
    const badge = document.getElementById('editor-version-badge');
    if (badge && version) {
      badge.textContent = `v${version} enviada`;
      badge.style.display = '';
    }
    const pkg = PPStorage.get(state.currentId);
    if (pkg) PPStorage.update(state.currentId, { docxVersion: version });
  }

  function _populateEditor(pkg) {
    const isNew = !pkg;
    // Reset all AI context toggles
    document.querySelectorAll('.pp-ai-btn.active').forEach(b => b.classList.remove('active'));
    // Reset image-as-context on all figure items
    document.querySelectorAll('.pp-figure-item').forEach(div => {
      div.dataset.imageAsContext = '';
      const imgAiBtn = div.querySelector('.pp-fig-img-ai-btn');
      if (imgAiBtn) imgAiBtn.classList.remove('active');
    });

    const idBadge = document.getElementById('editor-id-badge');
    idBadge.textContent = isNew ? 'PRP-NEW' : pkg.id;
    _applyMemberColorToBadge(idBadge, !isNew ? pkg.responsible : null);
    document.getElementById('btn-delete-package').style.display = isNew ? 'none' : '';
    document.getElementById('btn-send-review').style.display    = isNew ? 'none' : '';
    _updateEditorNotesBtn(isNew ? null : pkg);
    const vBadge = document.getElementById('editor-version-badge');
    if (!isNew && pkg.docxVersion) {
      vBadge.textContent = `v${pkg.docxVersion} enviada`;
      vBadge.style.display = '';
    } else {
      vBadge.style.display = 'none';
    }
    document.getElementById('pp-send-download-link').href =
      isNew ? '#' : `/prionpacks/api/packages/${pkg.id}/docx`;

    // Download word button
    const dlWord = document.getElementById('btn-download-word');
    dlWord.href = isNew ? '#' : `/prionpacks/api/packages/${pkg.id}/docx`;
    dlWord.style.display = isNew ? 'none' : '';

    document.getElementById('meta-id').textContent = isNew ? '—' : pkg.id;
    document.getElementById('meta-created').textContent = isNew ? '—' : _fmtDate(pkg.createdAt);
    document.getElementById('meta-modified').textContent = isNew ? '—' : _fmtDate(pkg.lastModified);

    const titleEl = document.getElementById('field-title');
    titleEl.value = pkg?.title || '';
    _updateTitleDisplay(titleEl.value);

    const altTitles = Array.isArray(pkg?.altTitles) ? pkg.altTitles : [];
    _renderAltTitlesEditor(altTitles);
    _updateAltTitlesDisplay(altTitles);
    _restoreAltTitlesState();

    document.getElementById('field-description').value = pkg?.description || '';

    _setPriority(pkg?.priority || 'none');
    const respSel = document.getElementById('field-responsible');
    respSel.innerHTML = '<option value="">— Sin asignar —</option>' +
      _members.map(m => `<option value="${_esc(m.id)}">${_esc(m.name + ' ' + m.surname)}</option>`).join('');
    respSel.value = pkg?.responsible || '';
    _renderFindings(pkg?.findings || []);

    const missingInfo = (pkg?.gaps?.missingInfo || []).map(g =>
      typeof g === 'string' ? { text: g, findingId: null, neededExperiment: '' } : g
    );
    _renderGapList('missing', missingInfo);
    _refreshGapFindingSelects();
    _updateFindingGapIndicators();
    _updateScore(pkg?.scores || { findings: 0, figures: 0, manuscript: 0, closing: 0, total: 0 });
    _recalcScore();

    // Optional sections — basic info group
    const optionalSectionsBasic = [
      { field: 'field-coauthors',    section: 'section-coauthors',    btn: 'btn-toggle-coauthors',    icon: 'fa-users',     label: 'Co-authors',     key: 'coAuthors' },
      { field: 'field-affiliations', section: 'section-affiliations', btn: 'btn-toggle-affiliations', icon: 'fa-university',label: 'Affiliations',   key: 'affiliations' },
      { field: 'field-abstract',     section: 'section-abstract',     btn: 'btn-toggle-abstract',     icon: 'fa-align-left',label: 'Abstract',       key: 'abstract' },
      { field: 'field-authorsummary',section: 'section-authorsummary',btn: 'btn-toggle-authorsummary',icon: 'fa-user-edit', label: 'Author Summary', key: 'authorSummary' },
      { field: 'field-introduction', section: 'section-introduction', btn: 'btn-toggle-introduction', icon: 'fa-book-open', label: 'Introduction',   key: 'introduction' },
    ];
    optionalSectionsBasic.forEach(({ field, section, btn, icon, label, key }) => {
      const val = pkg?.[key] || '';
      document.getElementById(field).value = val;
      const visible = !!val;
      document.getElementById(section).style.display = visible ? '' : 'none';
      _updateToggleBtn(btn, visible, icon, label);
    });

    // Optional sections — gaps group
    const optionalSectionsGaps = [
      { field: 'field-discussion',        section: 'section-discussion',     btn: 'btn-toggle-discussion',     icon: 'fa-comments',      label: 'Discussion',          key: 'discussion' },
      { field: 'field-acknowledgments',   section: 'section-acknowledgments',btn: 'btn-toggle-acknowledgments',icon: 'fa-heart',         label: 'Acknowledgments',     key: 'acknowledgments' },
      { field: 'field-funding',           section: 'section-funding',        btn: 'btn-toggle-funding',        icon: 'fa-coins',         label: 'Funding',             key: 'funding' },
      { field: 'field-conflictsofinterest',section:'section-conflicts',      btn: 'btn-toggle-conflicts',      icon: 'fa-balance-scale', label: 'Conflicts of interest', key: 'conflictsOfInterest' },
      { field: 'field-credit',            section: 'section-credit',         btn: 'btn-toggle-credit',         icon: 'fa-list-check',    label: 'CReDiT',              key: 'credit' },
    ];
    optionalSectionsGaps.forEach(({ field, section, btn, icon, label, key }) => {
      const val = pkg?.[key] || '';
      document.getElementById(field).value = val;
      const visible = !!val;
      document.getElementById(section).style.display = visible ? '' : 'none';
      _updateToggleBtn(btn, visible, icon, label);
    });

    // References — multi-field. Backward compat: legacy single-string value
    // is wrapped into a 1-element array so it still loads cleanly.
    const rawRefs = pkg?.references;
    let refs = [];
    if (Array.isArray(rawRefs)) refs = rawRefs.filter(r => r && String(r).trim());
    else if (typeof rawRefs === 'string' && rawRefs.trim()) refs = [rawRefs.trim()];
    _renderReferencesList(refs);
    const refsVisible = refs.length > 0;
    document.getElementById('section-references').style.display = refsVisible ? '' : 'none';
    _updateToggleBtn('btn-toggle-references', refsVisible, 'fa-list', 'References');

    // Introduction References (Ri-XX)
    const rawIntroRefs = pkg?.introReferences;
    let introRefs = [];
    if (Array.isArray(rawIntroRefs)) introRefs = rawIntroRefs.filter(r => r && String(r).trim());
    else if (typeof rawIntroRefs === 'string' && rawIntroRefs.trim()) introRefs = [rawIntroRefs.trim()];
    _renderIntroReferencesList(introRefs);

    // Methods — multi-field. Each item has {title, body}. Legacy single-string
    // value (or list of strings) is wrapped into a list of body-only items.
    const rawMethods = pkg?.methods;
    let methods = [];
    if (Array.isArray(rawMethods)) {
      methods = rawMethods.map(m => {
        if (typeof m === 'string') return { title: '', body: m };
        return { title: (m?.title || '').toString(), body: (m?.body || '').toString() };
      }).filter(m => (m.title && m.title.trim()) || (m.body && m.body.trim()));
    } else if (typeof rawMethods === 'string' && rawMethods.trim()) {
      methods = [{ title: '', body: rawMethods.trim() }];
    }
    _renderMethodsList(methods);
    const methodsVisible = methods.length > 0;
    document.getElementById('section-methods').style.display = methodsVisible ? '' : 'none';
    _updateToggleBtn('btn-toggle-methods', methodsVisible, 'fa-flask-vial', 'Methods');

    // Investigations
    const inv = pkg?.investigations || {};
    document.getElementById('field-investigations-text').value = inv.text || '';
    _renderInvFiles(inv.files || []);
    // Reset per-file AI toggles (already cleared via innerHTML reset in _renderInvFiles)

    // Active toggle — default true
    const isActive = pkg ? (pkg.active !== false) : true;
    _setActiveState(isActive, /*skipAutosave=*/true);

    // Collapsible sections — install buttons (idempotent) and refresh indicators
    _setupCollapsibleSections();
    _updateCollapseIndicators();
    _setupAnchorButtons();
    _setupSupPreviews();
    _setupSectionClipboards();
  }

  /* ── Active/Inactive toggle ────────────────────────────────────────────── */
  function _setActiveState(active, skipAutosave) {
    const btn  = document.getElementById('btn-active-toggle');
    const form = document.querySelector('.pp-editor-form');
    if (!btn || !form) return;
    if (active) {
      btn.classList.add('is-active');
      btn.classList.remove('is-inactive');
      btn.title = 'Activo';
      btn.innerHTML = '<i class="fas fa-toggle-on"></i> <span class="pp-active-toggle-label">Activo</span>';
      form.classList.remove('pp-form-locked');
    } else {
      btn.classList.remove('is-active');
      btn.classList.add('is-inactive');
      btn.title = 'Inactivo';
      btn.innerHTML = '<i class="fas fa-toggle-off"></i> <span class="pp-active-toggle-label">Inactivo</span>';
      form.classList.add('pp-form-locked');
    }
    if (!skipAutosave) _scheduleAutosave();
  }

  function _getCurrentActive() {
    const btn = document.getElementById('btn-active-toggle');
    return !btn || btn.classList.contains('is-active');
  }

  /* ── References (multi-field with per-field DOI chips & AI toggles) ───── */
  // Matches DOIs including those with parenthesised segments like (00) or (02).
  // Alternation: plain chars  |  complete (…) group — so a trailing ) in prose
  // is never consumed, but 10.1016/s0896-6273(00)00046-5 is matched whole.
  const _DOI_RE = /\b10\.\d{4,}\/(?:[^\s,;>\]()]+|\([^)]*\))+/g;

  function _renderDoiChipsFor(textarea, container) {
    if (!container) return;
    const matches = (textarea.value || '').match(_DOI_RE) || [];
    const unique = [...new Set(matches)];
    container.innerHTML = '';
    unique.forEach(doi => {
      const a = document.createElement('a');
      a.className = 'pp-doi-chip';
      a.href = `https://doi.org/${doi}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = doi;
      a.textContent = doi;
      container.appendChild(a);
    });
  }

  function _renderReferencesList(refs) {
    const list = document.getElementById('references-list');
    if (!list) return;
    list.innerHTML = '';
    (refs || []).forEach((r, idx) => list.appendChild(_createReferenceItem(r, idx)));
    if (state.currentId) {
      list.querySelectorAll('.pp-reference-item').forEach((item, idx) => {
        if (localStorage.getItem(`pp-col:${state.currentId}:r:${idx}`) === '1')
          item.classList.add('pp-reference-collapsed');
      });
    }
    _setupAnchorButtons(list);
    _setupSupPreviews(list);
    _updateReferencesCount();
    _refreshAllJumpButtons();
  }

  function _createReferenceItem(text, idx) {
    const id      = `field-reference-${idx}`;
    const chipsId = `reference-doi-chips-${idx}`;
    const div = document.createElement('div');
    div.className = 'pp-reference-item';
    div.innerHTML = `
      <div class="pp-reference-header">
        <button type="button" class="pp-collapse-btn pp-collapse-btn--inline" title="Collapse / expand reference"></button>
        <span class="pp-reference-number">R-${String(idx + 1).padStart(2, '0')}</span>
        <span class="pp-reference-preview"></span>
        <span class="pp-reference-header-doi"></span>
        <button type="button" class="pp-ai-btn" data-field-id="${id}" data-ai-label="Referencia ${idx + 1}" title="Incluir como contexto para Claude">AI</button>
        <button type="button" class="pp-btn-icon btn-remove" title="Eliminar referencia"><i class="fas fa-trash"></i></button>
      </div>
      <div class="pp-reference-body">
        <textarea id="${id}" class="pp-textarea pp-reference-textarea" rows="6" placeholder="Pega aquí una referencia (título, autores, DOI, resumen…)"></textarea>
        <div id="${chipsId}" class="pp-doi-chips"></div>
      </div>`;
    const ta        = div.querySelector('textarea');
    const chips     = div.querySelector('.pp-doi-chips');
    const headerDoi = div.querySelector('.pp-reference-header-doi');
    const preview   = div.querySelector('.pp-reference-preview');
    ta.value = text || '';
    const refreshPreview = () => {
      const first = (ta.value || '').split('\n').find(l => l.trim()) || '';
      const clipped = first.length > 90 ? first.slice(0, 90) + '…' : first;
      preview.innerHTML = _supHtml(clipped);
    };
    const refreshHeaderDoi = () => {
      const matches = (ta.value || '').match(_DOI_RE) || [];
      headerDoi.innerHTML = '';
      if (matches.length) {
        const first = matches[0];
        const a = document.createElement('a');
        a.className = 'pp-doi-chip pp-doi-chip-sm';
        a.href = `https://doi.org/${first}`;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = first;
        a.textContent = first;
        a.addEventListener('click', e => e.stopPropagation());
        headerDoi.appendChild(a);
      }
    };
    ta.addEventListener('input', () => {
      _renderDoiChipsFor(ta, chips);
      refreshPreview();
      refreshHeaderDoi();
    });
    div.querySelector('.pp-collapse-btn').addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      div.classList.toggle('pp-reference-collapsed');
      _saveItemCollapse('r', div, div.classList.contains('pp-reference-collapsed'));
    });
    div.querySelector('.btn-remove').addEventListener('click', () => {
      div.remove();
      _renumberReferences();
      _scheduleAutosave();
      _updateCollapseIndicators();
      _updateReferencesCount();
      _refreshAllJumpButtons();
    });
    _renderDoiChipsFor(ta, chips);
    refreshPreview();
    refreshHeaderDoi();
    return div;
  }

  function _updateReferencesCount() {
    const span = document.getElementById('references-count');
    if (!span) return;
    const n = document.querySelectorAll('#references-list .pp-reference-item').length;
    span.textContent = n > 0 ? `(${n})` : '';
    const collapseBtn = document.getElementById('btn-collapse-all-refs');
    if (collapseBtn) collapseBtn.style.display = n > 0 ? '' : 'none';
  }

  // ── Collapse-state persistence helpers (per package, per item) ──────────
  function _itemColKey(type, el) {
    const pid = state.currentId;
    if (!pid) return null;
    if (type === 'f') return `pp-col:${pid}:f:${el.dataset.id}`;
    const sel = type === 'm'  ? '#methods-list .pp-method-item'
              : type === 'r'  ? '#references-list .pp-reference-item'
              : type === 'ir' ? '#intro-references-list .pp-reference-item'
              :                 '#gaps-missing-list .pp-gap-item';
    const idx = Array.from(document.querySelectorAll(sel)).indexOf(el);
    return idx >= 0 ? `pp-col:${pid}:${type}:${idx}` : null;
  }
  function _saveItemCollapse(type, el, collapsed) {
    const k = _itemColKey(type, el);
    if (!k) return;
    if (collapsed) localStorage.setItem(k, '1');
    else           localStorage.removeItem(k);
  }

  function _toggleCollapseAllRefs() {
    const items = document.querySelectorAll('#references-list .pp-reference-item');
    if (!items.length) return;
    const allCollapsed = Array.from(items).every(el => el.classList.contains('pp-reference-collapsed'));
    items.forEach(el => {
      el.classList.toggle('pp-reference-collapsed', !allCollapsed);
      _saveItemCollapse('r', el, !allCollapsed);
    });
    const btn = document.getElementById('btn-collapse-all-refs');
    if (btn) btn.innerHTML = allCollapsed
      ? '<i class="fas fa-expand-alt"></i> Expand all'
      : '<i class="fas fa-compress-alt"></i> Collapse all';
  }

  async function _askClaudeDiscussion() {
    const refs = Array.from(document.querySelectorAll('#references-list .pp-reference-item textarea'))
      .map(ta => ta.value.trim()).filter(Boolean);
    if (!refs.length) { toast('No hay referencias para analizar.', 'error'); return; }

    const pkg      = state.currentId ? PPStorage.get(state.currentId) : null;
    const pkgTitle = pkg?.title || document.getElementById('title-display')?.textContent?.trim() || 'este manuscrito';
    const refsText = refs.map((r, i) => `[R-${String(i + 1).padStart(2, '0')}] ${r}`).join('\n\n---\n\n');

    const prompt = `A continuación se presentan las referencias bibliográficas del PrionPack titulado "${pkgTitle}". Estas referencias fueron seleccionadas por su relevancia para el manuscrito, especialmente para la sección de Discusión.

Analiza cuidadosamente el contenido de cada referencia y genera un listado estructurado de los temas de discusión más interesantes que podrían abordarse en la sección de Discusión del manuscrito. Para cada tema incluye: (1) el tema concreto, (2) las referencias que lo sustentan (ej. R-01, R-03), y (3) por qué sería relevante discutirlo en el contexto del manuscrito.

Referencias:

${refsText}`;

    const btn = document.getElementById('btn-discuss-claude');
    if (btn) btn.classList.add('loading');
    _showClaudeModal(null, null, null);
    try {
      const response = await PPApi.askClaude([], 'Discusión del manuscrito', prompt, null, []);
      const modal      = document.getElementById('pp-claude-modal');
      const loading    = document.getElementById('pp-claude-loading');
      const responseEl = document.getElementById('pp-claude-response-text');
      const footer     = document.getElementById('pp-claude-modal-footer');
      const hint       = document.getElementById('pp-claude-field-hint');
      loading.style.display    = 'none';
      responseEl.style.display = '';
      responseEl.textContent   = response;
      footer.style.display     = '';
      hint.textContent         = '→ Temas de Discusión sugeridos';
      _claudeModalCallback     = null;
      modal.style.display      = '';
    } catch (e) {
      _closeClaudeModal();
      await _handleClaudeError(e, 'Error llamando a Claude');
    } finally {
      if (btn) btn.classList.remove('loading');
    }
  }

  function _renumberReferences() {
    document.querySelectorAll('#references-list .pp-reference-item').forEach((item, i) => {
      const id      = `field-reference-${i}`;
      const chipsId = `reference-doi-chips-${i}`;
      item.querySelector('.pp-reference-number').textContent = `R-${String(i + 1).padStart(2, '0')}`;
      const ta    = item.querySelector('textarea');
      const aiBtn = item.querySelector('.pp-ai-btn');
      const chips = item.querySelector('.pp-doi-chips');
      ta.id = id;
      aiBtn.dataset.fieldId = id;
      aiBtn.dataset.aiLabel = `Referencia ${i + 1}`;
      chips.id = chipsId;
    });
  }

  function _addReference(focus = true) {
    const list = document.getElementById('references-list');
    if (!list) return;
    const idx  = list.children.length;
    const item = _createReferenceItem('', idx);
    list.appendChild(item);
    _setupAnchorButtons(item);
    _setupSupPreviews(item);
    if (focus) item.querySelector('textarea').focus();
    _scheduleAutosave();
    _updateCollapseIndicators();
    _updateReferencesCount();
    _refreshAllJumpButtons();
  }

  function _collectReferences() {
    return Array.from(document.querySelectorAll('#references-list .pp-reference-textarea'))
      .map(t => (t.value || '').trim())
      .filter(Boolean);
  }

  /* ── Introduction References (Ri-XX) ─────────────────────────────────── */

  function _renderIntroReferencesList(refs) {
    const list = document.getElementById('intro-references-list');
    if (!list) return;
    list.innerHTML = '';
    (refs || []).forEach((r, idx) => list.appendChild(_createIntroReferenceItem(r, idx)));
    if (state.currentId) {
      list.querySelectorAll('.pp-reference-item').forEach((item, idx) => {
        if (localStorage.getItem(`pp-col:${state.currentId}:ir:${idx}`) === '1')
          item.classList.add('pp-reference-collapsed');
      });
    }
    _setupAnchorButtons(list);
    _setupSupPreviews(list);
    _updateIntroReferencesCount();
    _refreshAllJumpButtons();
  }

  function _createIntroReferenceItem(text, idx) {
    const id      = `field-intro-reference-${idx}`;
    const chipsId = `intro-reference-doi-chips-${idx}`;
    const div = document.createElement('div');
    div.className = 'pp-reference-item pp-intro-reference-item';
    div.innerHTML = `
      <div class="pp-reference-header">
        <button type="button" class="pp-collapse-btn pp-collapse-btn--inline" title="Collapse / expand reference"></button>
        <span class="pp-reference-number">Ri-${String(idx + 1).padStart(2, '0')}</span>
        <span class="pp-reference-preview"></span>
        <span class="pp-reference-header-doi"></span>
        <button type="button" class="pp-ai-btn" data-field-id="${id}" data-ai-label="Ref. Intro ${idx + 1}" title="Incluir como contexto para Claude">AI</button>
        <button type="button" class="pp-btn-icon btn-remove" title="Eliminar referencia"><i class="fas fa-trash"></i></button>
      </div>
      <div class="pp-reference-body">
        <textarea id="${id}" class="pp-textarea pp-reference-textarea pp-intro-reference-textarea" rows="6" placeholder="Pega aquí una referencia de introducción (título, autores, DOI, resumen…)"></textarea>
        <div id="${chipsId}" class="pp-doi-chips"></div>
      </div>`;
    const ta        = div.querySelector('textarea');
    const chips     = div.querySelector('.pp-doi-chips');
    const headerDoi = div.querySelector('.pp-reference-header-doi');
    const preview   = div.querySelector('.pp-reference-preview');
    ta.value = text || '';
    const refreshPreview = () => {
      const first = (ta.value || '').split('\n').find(l => l.trim()) || '';
      const clipped = first.length > 90 ? first.slice(0, 90) + '…' : first;
      preview.innerHTML = _supHtml(clipped);
    };
    const refreshHeaderDoi = () => {
      const matches = (ta.value || '').match(_DOI_RE) || [];
      headerDoi.innerHTML = '';
      if (matches.length) {
        const first = matches[0];
        const a = document.createElement('a');
        a.className = 'pp-doi-chip pp-doi-chip-sm';
        a.href = `https://doi.org/${first}`;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = first;
        a.textContent = first;
        a.addEventListener('click', e => e.stopPropagation());
        headerDoi.appendChild(a);
      }
    };
    ta.addEventListener('input', () => {
      _renderDoiChipsFor(ta, chips);
      refreshPreview();
      refreshHeaderDoi();
      _scheduleAutosave();
    });
    div.querySelector('.pp-collapse-btn').addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      div.classList.toggle('pp-reference-collapsed');
      _saveItemCollapse('ir', div, div.classList.contains('pp-reference-collapsed'));
    });
    div.querySelector('.btn-remove').addEventListener('click', () => {
      div.remove();
      _renumberIntroReferences();
      _scheduleAutosave();
      _updateCollapseIndicators();
      _updateIntroReferencesCount();
      _refreshAllJumpButtons();
    });
    _renderDoiChipsFor(ta, chips);
    refreshPreview();
    refreshHeaderDoi();
    return div;
  }

  function _updateIntroReferencesCount() {
    const span = document.getElementById('intro-references-count');
    if (!span) return;
    const n = document.querySelectorAll('#intro-references-list .pp-reference-item').length;
    span.textContent = n > 0 ? `(${n})` : '';
    const collapseBtn = document.getElementById('btn-collapse-all-intro-refs');
    if (collapseBtn) collapseBtn.style.display = n > 0 ? '' : 'none';
  }

  function _toggleCollapseAllIntroRefs() {
    const items = document.querySelectorAll('#intro-references-list .pp-reference-item');
    if (!items.length) return;
    const allCollapsed = Array.from(items).every(el => el.classList.contains('pp-reference-collapsed'));
    items.forEach(el => {
      el.classList.toggle('pp-reference-collapsed', !allCollapsed);
      _saveItemCollapse('ir', el, !allCollapsed);
    });
    const btn = document.getElementById('btn-collapse-all-intro-refs');
    if (btn) btn.innerHTML = allCollapsed
      ? '<i class="fas fa-expand-alt"></i> Expand all'
      : '<i class="fas fa-compress-alt"></i> Collapse all';
  }

  function _renumberIntroReferences() {
    document.querySelectorAll('#intro-references-list .pp-reference-item').forEach((item, i) => {
      const id      = `field-intro-reference-${i}`;
      const chipsId = `intro-reference-doi-chips-${i}`;
      item.querySelector('.pp-reference-number').textContent = `Ri-${String(i + 1).padStart(2, '0')}`;
      const ta    = item.querySelector('textarea');
      const aiBtn = item.querySelector('.pp-ai-btn');
      const chips = item.querySelector('.pp-doi-chips');
      ta.id = id;
      aiBtn.dataset.fieldId = id;
      aiBtn.dataset.aiLabel = `Ref. Intro ${i + 1}`;
      chips.id = chipsId;
    });
  }

  function _addIntroReference(focus = true) {
    const list = document.getElementById('intro-references-list');
    if (!list) return;
    const idx  = list.children.length;
    const item = _createIntroReferenceItem('', idx);
    list.appendChild(item);
    _setupAnchorButtons(item);
    _setupSupPreviews(item);
    _updateIntroReferencesCount();
    _refreshAllJumpButtons();
    _scheduleAutosave();
    if (focus) item.querySelector('textarea')?.focus();
  }

  function _collectIntroReferences() {
    return Array.from(document.querySelectorAll('#intro-references-list .pp-intro-reference-textarea'))
      .map(t => (t.value || '').trim())
      .filter(Boolean);
  }

  /* ── Quick-jump buttons in section headers ────────────────────────────── */
  function _refreshAllJumpButtons() {
    _refreshJumpButtonsFor({
      containerId: 'findings-jump',
      sectionId:   'section-findings',
      itemSelector:'.pp-finding-block',
      itemCollapsedClass: 'pp-finding-collapsed',
      prefix: 'F-',
    });
    _refreshJumpButtonsFor({
      containerId: 'methods-jump',
      sectionId:   'section-methods',
      itemSelector:'#methods-list .pp-method-item',
      itemCollapsedClass: 'pp-method-collapsed',
      prefix: 'M-',
    });
    _refreshJumpButtonsFor({
      containerId: 'intro-references-jump',
      sectionId:   'section-introduction',
      itemSelector:'#intro-references-list .pp-reference-item',
      itemCollapsedClass: 'pp-reference-collapsed',
      prefix: 'Ri-',
    });
    _refreshJumpButtonsFor({
      containerId: 'references-jump',
      sectionId:   'section-references',
      itemSelector:'#references-list .pp-reference-item',
      itemCollapsedClass: 'pp-reference-collapsed',
      prefix: 'R-',
    });
    _refreshJumpButtonsFor({
      containerId: 'gaps-jump',
      sectionId:   'section-gaps',
      itemSelector:'#gaps-missing-list .pp-gap-item',
      itemCollapsedClass: 'pp-gap-collapsed',
      prefix: 'G-',
    });
  }

  function _refreshJumpButtonsFor({ containerId, sectionId, itemSelector, itemCollapsedClass, prefix }) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const items = Array.from(document.querySelectorAll(itemSelector));
    container.innerHTML = '';
    items.forEach((el, i) => {
      const code = `${prefix}${String(i + 1).padStart(2, '0')}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pp-jump-btn';
      btn.textContent = code;
      btn.title = `Ir a ${code}`;
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        // Expand parent section card if collapsed
        if (sectionId) {
          const card = document.getElementById(sectionId);
          if (card?.classList.contains('pp-card-collapsed')) {
            card.classList.remove('pp-card-collapsed');
            localStorage.removeItem('pp-collapse:' + sectionId);
            // Sync the collapse caret icon
            const caret = card.querySelector('.pp-section-header > .pp-collapse-btn i');
            if (caret) {
              caret.classList.add('fa-caret-down');
              caret.classList.remove('fa-caret-right');
            }
          }
        }
        // Expand item-specific collapse
        if (itemCollapsedClass) {
          el.classList.remove(itemCollapsedClass);
        }
        // Scroll into view + brief outline highlight
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.outline = '2px solid var(--pp-accent)';
        el.style.outlineOffset = '2px';
        setTimeout(() => {
          el.style.outline = '';
          el.style.outlineOffset = '';
        }, 1500);
      });
      container.appendChild(btn);
    });
  }

  /* ── Methods (multi-field, each with title + body, mirror of References) ─ */
  function _renderMethodsList(methods) {
    const list = document.getElementById('methods-list');
    if (!list) return;
    list.innerHTML = '';
    (methods || []).forEach((m, idx) => list.appendChild(_createMethodItem(m, idx)));
    if (state.currentId) {
      list.querySelectorAll('.pp-method-item').forEach((item, idx) => {
        if (localStorage.getItem(`pp-col:${state.currentId}:m:${idx}`) === '1')
          item.classList.add('pp-method-collapsed');
      });
    }
    _setupAnchorButtons(list);
    _setupSupPreviews(list);
    _initDragDrop(list, {
      itemSelector: '.pp-method-item',
      onReorder: () => {
        _renumberMethods();
        _refreshAllJumpButtons();
        _recalcScore();
        _scheduleAutosave();
      },
    });
    _refreshAllJumpButtons();
  }

  function _createMethodItem(m, idx) {
    const titleId = `field-method-title-${idx}`;
    const bodyId  = `field-method-body-${idx}`;
    const data = m || {};
    const div = document.createElement('div');
    div.className = 'pp-method-item';
    div.draggable = true;
    div.innerHTML = `
      <div class="pp-method-header">
        <i class="fas fa-grip-vertical pp-drag-handle" title="Arrastra para reordenar"></i>
        <button type="button" class="pp-collapse-btn pp-collapse-btn--inline" title="Collapse / expand method"></button>
        <span class="pp-method-number">M-${String(idx + 1).padStart(2, '0')}</span>
        <input type="text" id="${titleId}" class="pp-input pp-method-title-input" placeholder="Título del método…" value="${_esc(data.title || '')}" />
        <button type="button" class="pp-ai-btn" data-field-id="${titleId}" data-ai-label="Método ${idx + 1} — título" title="Incluir el título como contexto para Claude">AI</button>
        <button type="button" class="pp-btn-icon btn-remove" title="Eliminar método"><i class="fas fa-trash"></i></button>
      </div>
      <div class="pp-method-body">
        <div class="pp-label-ai-row">
          <label class="pp-label pp-label-sm">Desarrollo</label>
          <div class="pp-field-ai-actions">
            <button type="button" class="pp-ai-btn" data-field-id="${bodyId}" data-ai-label="Método ${idx + 1} — desarrollo" title="Incluir el desarrollo como contexto para Claude">AI</button>
            <button type="button" class="pp-claude-ask-btn pp-method-claude-btn" data-source-id="${bodyId}" data-source-label="Método ${idx + 1}" title="Preguntar a Claude sobre este método">
              <i class="fas fa-robot"></i> Claude
            </button>
          </div>
        </div>
        <textarea id="${bodyId}" class="pp-textarea pp-method-body-textarea" rows="6" placeholder="Describe los pasos, equipo, reactivos, parámetros…">${_esc(data.body || '')}</textarea>
      </div>`;
    div.querySelector('.pp-collapse-btn').addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      div.classList.toggle('pp-method-collapsed');
      _saveItemCollapse('m', div, div.classList.contains('pp-method-collapsed'));
    });
    div.querySelector('.btn-remove').addEventListener('click', () => {
      div.remove();
      _renumberMethods();
      _scheduleAutosave();
      _updateCollapseIndicators();
      _refreshAllJumpButtons();
    });
    return div;
  }

  function _renumberMethods() {
    document.querySelectorAll('#methods-list .pp-method-item').forEach((item, i) => {
      const titleId = `field-method-title-${i}`;
      const bodyId  = `field-method-body-${i}`;
      item.querySelector('.pp-method-number').textContent = `M-${String(i + 1).padStart(2, '0')}`;
      const titleInput = item.querySelector('.pp-method-title-input');
      const bodyArea   = item.querySelector('.pp-method-body-textarea');
      titleInput.id = titleId;
      bodyArea.id   = bodyId;
      const aiButtons = item.querySelectorAll('.pp-ai-btn');
      if (aiButtons[0]) {
        aiButtons[0].dataset.fieldId = titleId;
        aiButtons[0].dataset.aiLabel = `Método ${i + 1} — título`;
      }
      if (aiButtons[1]) {
        aiButtons[1].dataset.fieldId = bodyId;
        aiButtons[1].dataset.aiLabel = `Método ${i + 1} — desarrollo`;
      }
      const claudeBtn = item.querySelector('.pp-method-claude-btn');
      if (claudeBtn) {
        claudeBtn.dataset.sourceId    = bodyId;
        claudeBtn.dataset.sourceLabel = `Método ${i + 1}`;
      }
    });
  }

  function _addMethod(focus = true) {
    const list = document.getElementById('methods-list');
    if (!list) return;
    const idx  = list.children.length;
    const item = _createMethodItem({ title: '', body: '' }, idx);
    list.appendChild(item);
    _setupAnchorButtons(item);
    _setupSupPreviews(item);
    _initDragDrop(list, {
      itemSelector: '.pp-method-item',
      onReorder: () => {
        _renumberMethods();
        _refreshAllJumpButtons();
        _recalcScore();
        _scheduleAutosave();
      },
    });
    if (focus) item.querySelector('input').focus();
    _scheduleAutosave();
    _updateCollapseIndicators();
    _refreshAllJumpButtons();
  }

  function _collectMethods() {
    return Array.from(document.querySelectorAll('#methods-list .pp-method-item')).map(item => {
      const title = (item.querySelector('.pp-method-title-input')?.value || '').trim();
      const body  = (item.querySelector('.pp-method-body-textarea')?.value || '').trim();
      return { title, body };
    }).filter(m => m.title || m.body);
  }

  /* ── Collapsible sections ──────────────────────────────────────────────── */
  /* ── Anchor button (lock textarea height across reloads/collapse) ──────── */
  function _setupAnchorButtons(scope) {
    const root = scope || document;
    root.querySelectorAll('textarea.pp-textarea').forEach(ta => {
      if (!ta.id) return;                     // anchor needs a stable storage key
      if (ta.dataset.anchorWrapped === '1') return;

      // Wrap the textarea in a relatively-positioned container so we can
      // place the anchor button absolutely over its bottom-right corner.
      const wrap = document.createElement('div');
      wrap.className = 'pp-textarea-wrap';
      ta.parentNode.insertBefore(wrap, ta);
      wrap.appendChild(ta);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pp-anchor-btn';
      btn.title = 'Anclar el tamaño actual del campo';
      btn.innerHTML = '<i class="fas fa-anchor"></i>';
      wrap.appendChild(btn);

      ta.dataset.anchorWrapped = '1';

      // Restore previously-anchored height
      const key   = 'pp-anchor-h:' + (state.currentId || 'new') + ':' + ta.id;
      const saved = localStorage.getItem(key);
      if (saved) {
        ta.style.height = saved;
        btn.classList.add('is-anchored');
        btn.title = 'Tamaño anclado — clic para liberar';
      }

      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        if (btn.classList.contains('is-anchored')) {
          ta.style.height = '';
          localStorage.removeItem(key);
          btn.classList.remove('is-anchored');
          btn.title = 'Anclar el tamaño actual del campo';
          toast('Tamaño liberado.', 'info');
        } else {
          // 1) Expand to fit the full content first: clear inline height so
          //    scrollHeight reports the size needed to show all text without
          //    a scrollbar; then read it and use that as the anchor height.
          // 2) A small +6 px pad avoids a 1-line scrollbar on some browsers.
          // 3) Cap at 80 % of the viewport so a huge paste doesn't take over
          //    the whole screen — the user can keep scrolling inside.
          ta.style.height = 'auto';
          const fit  = ta.scrollHeight;
          const cap  = Math.round(window.innerHeight * 0.8);
          const h    = Math.max(80, Math.min(cap, fit + 6));
          const px   = h + 'px';
          ta.style.height = px;
          localStorage.setItem(key, px);
          btn.classList.add('is-anchored');
          btn.title = 'Tamaño anclado — clic para liberar';
          const fitFlag = fit + 6 <= cap ? '' : ' (limitado al 80 % del alto de pantalla)';
          toast('Anclado para mostrar todo el texto: ' + px + fitFlag + '.', 'success');
        }
      });
    });
  }

  /* ── Live superscript preview underneath textareas ─────────────────────── */
  // <textarea> elements can only show plain text, so when the user types
  // PrP^Sc^ the markers stay literal in the editor. To give live feedback
  // we attach a small preview block under each wrapped textarea that only
  // appears when at least one ^xxx^ pattern is detected.
  function _setupSupPreviews(scope) {
    const root = scope || document;
    const supRe = /\^\S[^\^\n]*?\^/;
    root.querySelectorAll('textarea.pp-textarea').forEach(ta => {
      if (ta.dataset.supPreviewWired === '1') return;
      const wrap = ta.closest('.pp-textarea-wrap');
      if (!wrap) return;

      let preview = wrap.querySelector(':scope > .pp-sup-preview');
      if (!preview) {
        preview = document.createElement('div');
        preview.className = 'pp-sup-preview';
        preview.style.display = 'none';
        wrap.appendChild(preview);
      }

      const update = () => {
        const text = ta.value || '';
        if (!supRe.test(text)) {
          preview.style.display = 'none';
          return;
        }
        preview.innerHTML = '<span class="pp-sup-preview-label">Vista previa con superíndice</span>' + _supHtml(text);
        preview.style.display = '';
      };

      ta.addEventListener('input', update);
      ta.dataset.supPreviewWired = '1';
      update();
    });
  }

  /* ── Clipboard button per section header ──────────────────────────────── */
  function _setupSectionClipboards() {
    document.querySelectorAll('.pp-card-section').forEach(card => {
      const header = card.querySelector('.pp-section-header');
      if (!header) return;
      if (header.querySelector('.pp-section-clip-btn')) return;
      const title = header.querySelector('.pp-section-title');
      if (!title) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pp-section-clip-btn';
      btn.title = 'Copiar el contenido de la sección al portapapeles';
      btn.innerHTML = '<i class="fas fa-paperclip"></i>';
      btn.addEventListener('click', async e => {
        e.preventDefault();
        e.stopPropagation();
        const text = _collectSectionText(card);
        if (!text || !text.trim()) {
          toast('La sección está vacía.', 'error');
          return;
        }
        try {
          await navigator.clipboard.writeText(text);
          toast('Sección copiada al portapapeles.', 'success');
        } catch {
          const tmp = document.createElement('textarea');
          tmp.value = text;
          document.body.appendChild(tmp);
          tmp.select();
          let ok = false;
          try { ok = document.execCommand('copy'); } catch {}
          tmp.remove();
          toast(ok ? 'Sección copiada al portapapeles.' : 'No se pudo copiar.', ok ? 'success' : 'error');
        }
      });
      // Insert right after the title h2 so the clip sits next to the section name
      title.insertAdjacentElement('afterend', btn);
    });
  }

  // Plain-text extractor mirroring the structure of the Word export.
  function _collectSectionText(card) {
    switch (card.id) {
      case 'section-basic':         return _collectBasicInfoText();
      case 'section-investigations':return _collectInvestigationsText();
      case 'section-findings':      return _collectFindingsText();
      case 'section-gaps':          return _collectGapsText();
      case 'section-methods':       return _collectMethodsText();
      case 'section-references':    return _collectReferencesText();
      default: {
        // Fallback: any optional section card with a single textarea.
        const ta = card.querySelector('textarea.pp-textarea');
        return ta ? ta.value.trim() : '';
      }
    }
  }

  function _collectBasicInfoText() {
    const title = document.getElementById('field-title')?.value.trim() || '';
    const desc  = document.getElementById('field-description')?.value.trim() || '';
    const alts  = _collectAltTitlesFromEditor();
    let out = '';
    if (title) out += 'Título: ' + title + '\n';
    if (alts.length) {
      out += '\nTítulos alternativos:\n';
      alts.forEach(a => { out += '  - ' + a + '\n'; });
    }
    if (desc) out += '\nDescripción general: ' + desc + '\n';
    return out.trim();
  }

  function _collectInvestigationsText() {
    const text  = document.getElementById('field-investigations-text')?.value.trim() || '';
    const files = Array.from(document.querySelectorAll('#investigations-files .pp-inv-chip-name'))
      .map(el => el.textContent.trim()).filter(Boolean);
    let out = '';
    if (text) out += text + '\n';
    if (files.length) {
      out += '\nDocumentos adjuntos:\n';
      files.forEach(f => { out += '  - ' + f + '\n'; });
    }
    return out.trim();
  }

  function _collectFindingsText() {
    const blocks = document.querySelectorAll('.pp-finding-block');
    const parts = [];
    blocks.forEach((block, i) => {
      const num    = `F-${String(i + 1).padStart(2, '0')}`;
      const title  = block.querySelector('.pp-finding-title-input')?.value.trim() || '';
      const enRaw  = block.querySelector('.pp-finding-en-badge')?.dataset.raw?.trim() || '';
      const desc   = block.querySelector('textarea[id^="fdesc-"]')?.value.trim() || '';
      let p = '▶ ' + num + (title ? ' — ' + title : '') + '\n';
      if (enRaw) p += 'EN: ' + enRaw + '\n';
      if (desc)  p += desc + '\n';

      // Figures
      block.querySelectorAll('.pp-figure-item').forEach((fig, fi) => {
        const figDesc = fig.querySelector('.pp-figure-input')?.value.trim() || '';
        const figCap  = fig.querySelector('.pp-fig-cap-textarea')?.value.trim() || '';
        let line = `Figura ${i + 1}.${fi + 1}`;
        if (figDesc) line += '  —  ' + figDesc;
        p += '\n' + line;
        if (figCap) p += '\n  ' + figCap;
        p += '\n';
      });

      // Tables
      block.querySelectorAll('.pp-table-row').forEach((tbl, ti) => {
        const tDesc = tbl.querySelector('.pp-table-input')?.value.trim() || '';
        let line = `Tabla ${i + 1}.${ti + 1}`;
        if (tDesc) line += '  —  ' + tDesc;
        p += '\n' + line + '\n';
      });

      parts.push(p.trimEnd());
    });
    return parts.join('\n\n');
  }

  function _collectGapsText() {
    const items = document.querySelectorAll('#gaps-missing-list .pp-gap-item');
    const findings = Array.from(document.querySelectorAll('.pp-finding-block')).map((b, i) => ({
      id:    b.dataset.id || '',
      num:   i + 1,
      title: b.querySelector('.pp-finding-title-input')?.value.trim() || '',
    }));
    const lines = [];
    items.forEach((item, i) => {
      const num    = `G-${String(i + 1).padStart(2, '0')}`;
      const text   = item.querySelector('input[type="text"]')?.value.trim() || '';
      const needed = item.querySelector('.pp-gap-needed-input')?.value.trim() || '';
      const fid    = item.querySelector('.pp-gap-finding-select')?.value || '';
      let p = `${num} — Missing: ${text}`;
      if (needed) p += `\n     → Needed: ${needed}`;
      if (fid) {
        const f = findings.find(x => x.id === fid);
        if (f) p += `\n     → Vinculado a F-${String(f.num).padStart(2, '0')}: ${f.title}`;
      }
      lines.push(p);
    });
    return lines.join('\n\n');
  }

  function _collectMethodsText() {
    const items = document.querySelectorAll('#methods-list .pp-method-item');
    const lines = [];
    items.forEach((item, i) => {
      const num   = `M-${String(i + 1).padStart(2, '0')}`;
      const title = item.querySelector('.pp-method-title-input')?.value.trim() || '';
      const body  = item.querySelector('.pp-method-body-textarea')?.value.trim() || '';
      let p = num + (title ? ' — ' + title : '');
      if (body) p += '\n' + body;
      lines.push(p);
    });
    return lines.join('\n\n');
  }

  function _collectReferencesText() {
    const items = Array.from(document.querySelectorAll('#references-list .pp-reference-textarea'))
      .map(t => t.value.trim()).filter(Boolean);
    return items.map((r, i) => `[${i + 1}] ${r}`).join('\n\n');
  }

  function _collectIntroReferencesText() {
    const items = Array.from(document.querySelectorAll('#intro-references-list .pp-intro-reference-textarea'))
      .map(t => t.value.trim()).filter(Boolean);
    return items.map((r, i) => `[Ri-${String(i + 1).padStart(2, '0')}] ${r}`).join('\n\n');
  }

  function _setupCollapsibleSections() {
    document.querySelectorAll('.pp-card-section').forEach(card => {
      const header = card.querySelector('.pp-section-header');
      if (!header) return;
      const cardId = card.id || '';
      const stateKey = cardId ? ('pp-collapse:' + cardId) : '';

      // Re-apply persisted state every time we run (idempotent for the
      // button itself; the class application is the important bit).
      if (stateKey && localStorage.getItem(stateKey) === '1') {
        card.classList.add('pp-card-collapsed');
      }

      if (header.querySelector('.pp-collapse-btn')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pp-collapse-btn pp-collapse-btn--empty';
      btn.title = 'Collapse / expand section';
      const alreadyCollapsed = card.classList.contains('pp-card-collapsed');
      btn.innerHTML = `<i class="fas ${alreadyCollapsed ? 'fa-caret-right' : 'fa-caret-down'}"></i>`;
      btn.addEventListener('click', () => {
        const collapsed = card.classList.toggle('pp-card-collapsed');
        const i = btn.querySelector('i');
        i.classList.toggle('fa-caret-down', !collapsed);
        i.classList.toggle('fa-caret-right', collapsed);
        if (stateKey) {
          if (collapsed) localStorage.setItem(stateKey, '1');
          else           localStorage.removeItem(stateKey);
        }
      });
      header.insertBefore(btn, header.firstChild);
    });

    const form = document.querySelector('.pp-editor-form');
    if (form && !form.dataset.collapseInputBound) {
      form.addEventListener('input', _updateCollapseIndicators);
      form.dataset.collapseInputBound = '1';
    }
  }

  function _hasCardContent(card) {
    for (const ta of card.querySelectorAll('textarea')) {
      if (ta.value && ta.value.trim()) return true;
    }
    for (const inp of card.querySelectorAll('input[type="text"]')) {
      if (inp.value && inp.value.trim()) return true;
    }
    for (const list of card.querySelectorAll('.pp-findings-list, .pp-dynamic-list, .pp-inv-files-list')) {
      if (list.children.length > 0) return true;
    }
    return false;
  }

  function _updateCollapseIndicators() {
    document.querySelectorAll('.pp-card-section').forEach(card => {
      const btn = card.querySelector('.pp-section-header > .pp-collapse-btn');
      if (!btn) return;
      const has = _hasCardContent(card);
      btn.classList.toggle('pp-collapse-btn--filled', has);
      btn.classList.toggle('pp-collapse-btn--empty', !has);
    });
  }

  function _updateTitleDisplay(text) {
    const display = document.getElementById('title-display');
    if (!display) return;
    const trimmed = (text || '').trim();
    if (trimmed) {
      display.innerHTML = _supHtml(trimmed);
      display.classList.remove('pp-title-display-empty');
    } else {
      display.textContent = 'Untitled package';
      display.classList.add('pp-title-display-empty');
    }
  }

  /* ── Alternative titles ────────────────────────────────────────────────── */
  function _renderAltTitlesEditor(altTitles) {
    const list = document.getElementById('alt-titles-list');
    if (!list) return;
    list.innerHTML = '';
    (altTitles || []).forEach((t, idx) => {
      const row = document.createElement('div');
      row.className = 'pp-alt-title-row';
      row.dataset.index = idx;
      row.innerHTML = `
        <input type="text" class="pp-input pp-alt-title-input" value="${_esc(t)}" placeholder="Alternative title…" />
        <button type="button" class="pp-btn-icon btn-remove" title="Remove alternative title">
          <i class="fas fa-trash"></i>
        </button>`;
      const input = row.querySelector('.pp-alt-title-input');
      input.addEventListener('input', () => {
        _updateAltTitlesDisplay(_collectAltTitlesFromEditor());
        _updateAltTitlesIndicator();
      });
      row.querySelector('.btn-remove').addEventListener('click', () => {
        row.remove();
        _updateAltTitlesDisplay(_collectAltTitlesFromEditor());
        _updateAltTitlesIndicator();
        _scheduleAutosave();
      });
      list.appendChild(row);
    });
    _updateAltTitlesIndicator();
  }

  function _collectAltTitlesFromEditor() {
    return Array.from(document.querySelectorAll('#alt-titles-list .pp-alt-title-input'))
      .map(i => i.value.trim())
      .filter(Boolean);
  }

  function _updateAltTitlesDisplay(_altTitles) {
    // Alternative titles are intentionally not shown in the top title bar.
    // They live in the Basic Info editor and are exported to the DOCX.
  }

  function _addAltTitleRow() {
    const list = document.getElementById('alt-titles-list');
    if (!list) return;
    const current = _collectAltTitlesFromEditor();
    current.push('');
    _renderAltTitlesEditor(current);
    const inputs = list.querySelectorAll('.pp-alt-title-input');
    inputs[inputs.length - 1]?.focus();
    // Make sure the group is expanded so the new row is visible
    document.getElementById('alt-titles-group')?.classList.remove('pp-alt-titles-collapsed');
    _updateAltTitlesIndicator();
  }

  // The alt-titles collapse triangle works just like the section ones:
  // green/filled when there is content, amber/blinking when empty.
  function _updateAltTitlesIndicator() {
    const btn = document.getElementById('btn-toggle-alt-titles');
    if (!btn) return;
    const has = _collectAltTitlesFromEditor().length > 0;
    btn.classList.toggle('pp-collapse-btn--filled', has);
    btn.classList.toggle('pp-collapse-btn--empty',  !has);
  }

  function _toggleAltTitles() {
    const grp = document.getElementById('alt-titles-group');
    if (!grp) return;
    const collapsed = grp.classList.toggle('pp-alt-titles-collapsed');
    if (collapsed) localStorage.setItem('pp-collapse:alt-titles-group', '1');
    else           localStorage.removeItem('pp-collapse:alt-titles-group');
  }

  function _restoreAltTitlesState() {
    const grp = document.getElementById('alt-titles-group');
    if (!grp) return;
    if (localStorage.getItem('pp-collapse:alt-titles-group') === '1') {
      grp.classList.add('pp-alt-titles-collapsed');
    } else {
      grp.classList.remove('pp-alt-titles-collapsed');
    }
  }

  /* ── Toggle helpers ────────────────────────────────────────────────────── */
  function _updateToggleBtn(btnId, active, icon, label) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.classList.toggle('active', active);
    btn.innerHTML = active
      ? `<i class="fas ${icon}"></i> ${label} <i class="fas fa-times" style="font-size:10px;margin-left:2px;"></i>`
      : `<i class="fas ${icon}"></i> ${label}`;
  }

  // Generic toggle: no content guard, just hide/show
  function _toggleSection(sectionId, btnId, icon, label) {
    const section = document.getElementById(sectionId);
    if (!section) return;
    const visible = section.style.display !== 'none';
    if (visible) {
      section.style.display = 'none';
      _updateToggleBtn(btnId, false, icon, label);
    } else {
      section.style.display = '';
      _updateToggleBtn(btnId, true, icon, label);
      const field = section.querySelector('textarea, input[type="text"]');
      if (field) field.focus();
    }
  }

  function _toggleIntroduction() {
    _toggleSection('section-introduction', 'btn-toggle-introduction', 'fa-book-open', 'Introduction');
  }

  function _toggleDiscussion() {
    _toggleSection('section-discussion', 'btn-toggle-discussion', 'fa-comments', 'Discussion');
  }

  /* ── Autosave ──────────────────────────────────────────────────────────── */
  let _autosaveTimer = null;
  let _gapCounter = 0;

  function _scheduleAutosave() {
    if (!state.currentId) return;
    const indicator = document.getElementById('autosave-status');
    if (indicator) indicator.textContent = '';
    clearTimeout(_autosaveTimer);
    _autosaveTimer = setTimeout(_doAutosave, 1500);
  }

  async function _doAutosave() {
    if (!state.currentId) return;
    const title = (document.getElementById('field-title').value || '').trim();
    if (!title) return;
    const indicator = document.getElementById('autosave-status');
    if (indicator) indicator.textContent = 'Guardando…';
    const data = _collectAllData(title);
    try {
      const saved = await PPStorage.update(state.currentId, data);
      const idx = _packages.findIndex(p => p.id === state.currentId);
      if (idx >= 0) _packages[idx] = saved;
      document.getElementById('meta-modified').textContent = _fmtDate(saved.lastModified);
      _renderSidebarList();
      if (indicator) {
        indicator.textContent = '✓ Guardado';
        setTimeout(() => { if (indicator) indicator.textContent = ''; }, 2000);
      }
    } catch (e) {
      if (indicator) indicator.textContent = '⚠ Error';
    }
  }

  function _collectAllData(title) {
    return {
      title: title || (document.getElementById('field-title').value || '').trim(),
      altTitles: _collectAltTitlesFromEditor(),
      description: document.getElementById('field-description').value.trim(),
      priority: _getCurrentPriority(),
      responsible: document.getElementById('field-responsible').value || null,
      active: _getCurrentActive(),
      coAuthors: document.getElementById('field-coauthors').value.trim() || null,
      affiliations: document.getElementById('field-affiliations').value.trim() || null,
      abstract: document.getElementById('field-abstract').value.trim() || null,
      authorSummary: document.getElementById('field-authorsummary').value.trim() || null,
      introduction: document.getElementById('field-introduction').value.trim() || null,
      introReferences: _collectIntroReferences(),
      methods: _collectMethods(),
      discussion: document.getElementById('field-discussion').value.trim() || null,
      acknowledgments: document.getElementById('field-acknowledgments').value.trim() || null,
      funding: document.getElementById('field-funding').value.trim() || null,
      conflictsOfInterest: document.getElementById('field-conflictsofinterest').value.trim() || null,
      references: _collectReferences(),
      credit: document.getElementById('field-credit').value.trim() || null,
      investigations: {
        text:  document.getElementById('field-investigations-text').value.trim() || '',
        files: _collectInvFiles(),
      },
      findings: _collectFindings(),
      gaps: {
        missingInfo: _collectGapList('gaps-missing-list'),
      },
      scores: _collectScores(),
    };
  }

  /* ── Priority ──────────────────────────────────────────────────────────── */
  function _setPriority(priority) {
    document.querySelectorAll('.pp-priority-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.priority === priority);
    });
  }

  /* ── Findings ──────────────────────────────────────────────────────────── */
  function _renderFindings(findings) {
    const container = document.getElementById('findings-container');
    const empty = document.getElementById('findings-empty');
    container.innerHTML = '';
    if (!findings.length) {
      empty.style.display = 'flex';
      _updateCollapseIndicators();
      _refreshAllJumpButtons();
      return;
    }
    empty.style.display = 'none';
    findings.forEach((f, i) => container.appendChild(_createFindingBlock(f, i + 1)));
    _initDragDrop(container, {
      itemSelector: '.pp-finding-block',
      onReorder: () => {
        _renumberFindings();
        _refreshGapFindingSelects();
        _recalcScore();
        _refreshAllJumpButtons();
        _scheduleAutosave();
      },
    });
    _updateCollapseIndicators();
    _setupAnchorButtons(container);
    _setupSupPreviews(container);
    _refreshAllJumpButtons();
  }

  function _createFindingBlock(finding, num) {
    const div = document.createElement('div');
    div.className = 'pp-finding-block';
    div.dataset.id = finding.id;
    div.draggable = true;
    if (state.currentId && localStorage.getItem(`pp-col:${state.currentId}:f:${finding.id}`) === '1')
      div.classList.add('pp-finding-collapsed');
    const enBadge = finding.titleEnglish
      ? _buildEnBadgeHTML(finding.titleEnglish) : '';

    div.innerHTML = `
      <div class="pp-finding-header">
        <i class="fas fa-grip-vertical pp-drag-handle"></i>
        <button type="button" class="pp-collapse-btn pp-collapse-btn--inline pp-finding-collapse-btn" title="Collapse / expand finding"></button>
        <span class="pp-finding-number">F-${String(num).padStart(2,'0')}</span>
        <input type="text" id="ftitle-${finding.id}" class="pp-finding-title-input" placeholder="Finding title…" value="${_esc(finding.title||'')}" />
        <button class="pp-ai-btn" data-field-id="ftitle-${finding.id}" data-ai-label="Finding título: ${_esc(finding.title||'(sin título)')}" title="Incluir título como contexto para Claude">AI</button>
        <button class="pp-btn-icon btn-claude" title="Translate with Claude" onclick="PrionPacks.translateFinding(this)">
          <i class="fas fa-robot"></i>
        </button>
        <button class="pp-btn-icon btn-remove" title="Remove finding" onclick="PrionPacks.removeFinding(this)">
          <i class="fas fa-trash"></i>
        </button>
      </div>
      ${enBadge}
      <div class="pp-finding-content">
        <textarea id="fdesc-${finding.id}" class="pp-textarea" rows="3" placeholder="Describe the main result…">${_esc(finding.description||'')}</textarea>
        <div class="pp-field-ai-row">
          <button class="pp-ai-btn" data-field-id="fdesc-${finding.id}" data-ai-label="Finding descripción: ${_esc(finding.title||'(sin título)')}" title="Incluir descripción como contexto para Claude">AI</button>
          <button class="pp-claude-ask-btn pp-claude-finding-btn" data-source-id="fdesc-${finding.id}" data-source-label="Finding: ${_esc(finding.title||'(sin título)')}" title="Preguntar a Claude sobre este finding">
            <i class="fas fa-robot"></i> Claude
          </button>
        </div>
        <div class="pp-figs-tables-section">
          <div class="pp-figs-tables-header">
            <span class="pp-figs-tables-label">Figures &amp; Tables</span>
            <div class="pp-figs-tables-btns">
              <button class="pp-btn pp-btn-ghost pp-btn-sm btn-add-figure">
                <i class="fas fa-plus"></i> Add Figure
              </button>
              <button class="pp-btn pp-btn-ghost pp-btn-sm btn-add-table">
                <i class="fas fa-table"></i> Add Table
              </button>
            </div>
          </div>
          <div class="pp-figures-list"></div>
          <div class="pp-tables-list"></div>
        </div>
      </div>
      <div class="pp-finding-gap-indicator"></div>`;

    // Populate figures
    const figList = div.querySelector('.pp-figures-list');
    (finding.figures || []).forEach((fig, i) => figList.appendChild(_createFigureItem(fig, i + 1)));

    // Populate tables
    const tblList = div.querySelector('.pp-tables-list');
    (finding.tables || []).forEach((tbl, i) => tblList.appendChild(_createTableRow(tbl, i + 1)));

    // Add buttons
    div.querySelector('.btn-add-figure').addEventListener('click', () => _addFigureToList(figList));
    div.querySelector('.btn-add-table').addEventListener('click', () => _addTableToList(tblList));

    div.querySelector('.pp-finding-title-input').addEventListener('input', _recalcScore);
    div.querySelector('.pp-finding-title-input').addEventListener('input', e => {
      const aiBtn = div.querySelector('.pp-ai-btn[data-field-id="ftitle-' + finding.id + '"]');
      if (aiBtn) aiBtn.dataset.aiLabel = 'Finding título: ' + (e.target.value.trim() || '(sin título)');
      const claudeBtn = div.querySelector('.pp-claude-finding-btn');
      if (claudeBtn) {
        claudeBtn.dataset.sourceLabel = 'Finding: ' + (e.target.value.trim() || '(sin título)');
      }
    });
    div.querySelector('.pp-textarea').addEventListener('input', _recalcScore);
    return div;
  }

  /* ── Figure items ──────────────────────────────────────────────────────── */
  function _createFigureItem(fig, num) {
    const div = document.createElement('div');
    div.className = 'pp-figure-item';
    div.dataset.imageUrl = fig.imageUrl || '';
    div.dataset.caption  = fig.caption  || '';
    div.dataset.imageAsContext = '';

    const figInputId = `figdesc-${fig.id || 'fig'+num}`;
    const capTextareaId = `figcap-${fig.id || 'fig'+num}`;

    div.innerHTML = `
      <div class="pp-figure-top">
        <span class="pp-figure-num">Fig ${num}</span>
        <input type="text" id="${figInputId}" class="pp-figure-input" placeholder="Figure description…" value="${_esc(fig.description||'')}" />
        <div class="pp-figure-btns">
          <button class="pp-ai-btn pp-ai-btn-xs" data-field-id="${figInputId}" data-ai-label="Figura ${num}: descripción" title="Contexto para Claude">AI</button>
          <button class="pp-fig-img-btn pp-btn-icon" title="Upload image"><i class="fas fa-image"></i></button>
          <button class="pp-fig-cap-btn pp-btn-icon pp-hidden" title="Add caption"><i class="fas fa-align-left"></i></button>
          <button class="pp-btn-icon btn-remove" title="Remove figure"><i class="fas fa-times"></i></button>
        </div>
      </div>
      <div class="pp-fig-cap-editor pp-hidden">
        <textarea id="${capTextareaId}" class="pp-textarea pp-fig-cap-textarea" rows="2" placeholder="Figure legend / pie de figura…"></textarea>
        <div class="pp-field-ai-row">
          <button class="pp-ai-btn pp-ai-btn-xs pp-fig-img-ai-btn" title="Incluir imagen como contexto visual para Claude">AI img</button>
          <button class="pp-ai-btn pp-ai-btn-xs pp-fig-cap-ai-btn" data-field-id="${capTextareaId}" data-ai-label="Pie de figura ${num}" title="Incluir pie de figura como contexto para Claude">AI</button>
          <button class="pp-claude-ask-btn pp-fig-cap-claude-btn" title="Pedir a Claude que escriba el pie de figura"><i class="fas fa-robot"></i> Claude</button>
        </div>
        <div class="pp-fig-cap-actions">
          <button class="pp-btn pp-btn-sm pp-btn-ghost pp-fig-cap-cancel">Cancel</button>
          <button class="pp-btn pp-btn-sm pp-btn-primary pp-fig-cap-save"><i class="fas fa-check"></i> Save caption</button>
        </div>
      </div>`;

    _bindFigureItemEvents(div);
    _updateFigurePreview(div); // sets up thumbnail and button states from dataset
    return div;
  }

  function _bindFigureItemEvents(div) {
    const imgBtn    = div.querySelector('.pp-fig-img-btn');
    const capBtn    = div.querySelector('.pp-fig-cap-btn');
    const removeBtn = div.querySelector('.btn-remove');
    const capEditor = div.querySelector('.pp-fig-cap-editor');
    const capInput  = div.querySelector('.pp-fig-cap-textarea');
    const descInput = div.querySelector('.pp-figure-input');

    imgBtn.addEventListener('click', () => {
      _openImgUploadModal(dataUrl => {
        div.dataset.imageUrl = dataUrl;
        _updateFigurePreview(div);
        _recalcScore();
      });
    });

    capBtn.addEventListener('click', () => {
      const opening = capEditor.classList.contains('pp-hidden');
      capEditor.classList.toggle('pp-hidden');
      if (opening) {
        capInput.value = div.dataset.caption || '';
        capInput.focus();
      }
    });

    div.querySelector('.pp-fig-cap-save').addEventListener('click', () => {
      div.dataset.caption = capInput.value.trim();
      capEditor.classList.add('pp-hidden');
      _updateFigurePreview(div);
    });

    div.querySelector('.pp-fig-cap-cancel').addEventListener('click', () => {
      capEditor.classList.add('pp-hidden');
    });

    removeBtn.addEventListener('click', () => {
      const list = div.closest('.pp-figures-list');
      div.remove();
      _renumberList(list, '.pp-figure-item', '.pp-figure-num', 'Fig ');
      _recalcScore();
    });

    descInput.addEventListener('input', _recalcScore);

    // AI img toggle button — toggles image-as-context
    const imgAiBtn = div.querySelector('.pp-fig-img-ai-btn');
    if (imgAiBtn) {
      imgAiBtn.addEventListener('click', () => {
        const active = imgAiBtn.classList.toggle('active');
        div.dataset.imageAsContext = active ? '1' : '';
      });
    }

    // Caption AI toggle (standard)
    const capAiBtn = div.querySelector('.pp-fig-cap-ai-btn');
    if (capAiBtn) {
      capAiBtn.addEventListener('click', () => capAiBtn.classList.toggle('active'));
    }

    // Caption Claude button
    const capClaudeBtn = div.querySelector('.pp-fig-cap-claude-btn');
    if (capClaudeBtn) {
      capClaudeBtn.addEventListener('click', () => _askClaudeCaption(div, capInput));
    }
  }

  function _updateFigurePreview(div) {
    const imageUrl = div.dataset.imageUrl || '';
    const caption  = div.dataset.caption  || '';
    const hasImg   = !!imageUrl;
    const hasCap   = !!(caption.trim());

    // Image button state
    const imgBtn = div.querySelector('.pp-fig-img-btn');
    imgBtn.classList.toggle('active', hasImg);
    imgBtn.title = hasImg ? 'Change image' : 'Upload image';

    // Caption button: only visible when image present
    const capBtn = div.querySelector('.pp-fig-cap-btn');
    capBtn.classList.toggle('pp-hidden', !hasImg);
    capBtn.classList.toggle('active', hasCap);
    capBtn.title = hasCap ? 'Edit caption' : 'Add caption';

    // Remove old preview if any
    div.querySelector('.pp-figure-preview')?.remove();

    if (hasImg) {
      const preview = document.createElement('div');
      preview.className = 'pp-figure-preview';

      const thumb = document.createElement('img');
      thumb.className = 'pp-figure-thumb';
      thumb.src = imageUrl;
      thumb.alt = 'Figure preview';
      thumb.addEventListener('click', () => _openFigureViewModal(imageUrl, caption));

      const badges = document.createElement('div');
      badges.className = 'pp-figure-badges';
      badges.innerHTML = `
        <span class="pp-fig-badge pp-fig-badge-img"><i class="fas fa-image"></i> Image</span>
        <span class="pp-fig-badge ${hasCap ? 'pp-fig-badge-cap' : 'pp-fig-badge-nocap'}">
          <i class="fas fa-${hasCap ? 'comment-dots' : 'comment-slash'}"></i>
          ${hasCap ? 'Caption' : 'No caption'}
        </span>`;

      preview.appendChild(thumb);
      preview.appendChild(badges);

      // Insert after .pp-figure-top (before caption editor)
      div.querySelector('.pp-figure-top').insertAdjacentElement('afterend', preview);
    }
  }

  function _addFigureToList(list) {
    const num = list.querySelectorAll('.pp-figure-item').length + 1;
    const item = _createFigureItem({ id: 'fig' + Date.now(), description: '', imageUrl: '', caption: '' }, num);
    list.appendChild(item);
    item.querySelector('.pp-figure-input').focus();
    _recalcScore();
  }

  /* ── Table rows ────────────────────────────────────────────────────────── */
  function _createTableRow(tbl, num) {
    const div = document.createElement('div');
    div.className = 'pp-table-row';
    div.innerHTML = `
      <span class="pp-table-num">Tbl ${num}</span>
      <input type="text" class="pp-table-input" placeholder="Table description…" value="${_esc(tbl.description||'')}" />
      <button class="pp-btn-icon btn-remove" title="Remove table"><i class="fas fa-times"></i></button>`;
    div.querySelector('.btn-remove').addEventListener('click', () => {
      const list = div.closest('.pp-tables-list');
      div.remove();
      _renumberList(list, '.pp-table-row', '.pp-table-num', 'Tbl ');
      _recalcScore();
    });
    div.querySelector('.pp-table-input').addEventListener('input', _recalcScore);
    return div;
  }

  function _addTableToList(list) {
    const num = list.querySelectorAll('.pp-table-row').length + 1;
    const row = _createTableRow({ id: 'tbl' + Date.now(), description: '' }, num);
    list.appendChild(row);
    row.querySelector('.pp-table-input').focus();
    _recalcScore();
  }

  function _renumberList(list, itemSel, numSel, prefix) {
    list.querySelectorAll(itemSel).forEach((el, i) => {
      const numEl = el.querySelector(numSel);
      if (numEl) numEl.textContent = prefix + (i + 1);
    });
  }

  /* ── Image upload modal ────────────────────────────────────────────────── */
  function _openImgUploadModal(callback) {
    _imgUploadCallback = callback;
    document.getElementById('pp-img-upload-modal').style.display = '';
    // Reset file input so same file can be re-selected
    document.getElementById('pp-img-file-input').value = '';
    setTimeout(() => document.getElementById('pp-img-drop-zone').focus(), 50);
  }

  function _closeImgUploadModal() {
    document.getElementById('pp-img-upload-modal').style.display = 'none';
    _imgUploadCallback = null;
  }

  function _handleImageFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('Please select a valid image file.', 'error'); return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast('Image too large (max 10 MB).', 'error'); return;
    }
    const reader = new FileReader();
    reader.onload = ev => {
      const cb = _imgUploadCallback;
      _closeImgUploadModal();
      if (cb) cb(ev.target.result);
    };
    reader.readAsDataURL(file);
  }

  /* ── Figure viewer modal ───────────────────────────────────────────────── */
  function _openFigureViewModal(imageUrl, caption) {
    document.getElementById('pp-fig-view-img').src = imageUrl;
    const capEl = document.getElementById('pp-fig-view-caption');
    if (caption && caption.trim()) {
      capEl.textContent = caption;
      capEl.style.display = '';
    } else {
      capEl.style.display = 'none';
    }
    document.getElementById('pp-fig-view-modal').style.display = '';
  }

  function _closeFigureViewModal() {
    document.getElementById('pp-fig-view-modal').style.display = 'none';
    document.getElementById('pp-fig-view-img').src = '';
  }

  /* ── Translate ─────────────────────────────────────────────────────────── */
  async function translateFinding(btn) {
    const block = btn.closest('.pp-finding-block');
    const text = block.querySelector('.pp-finding-title-input').value.trim();
    if (!text) { toast('Enter a finding title first.', 'error'); return; }
    btn.classList.add('loading');
    btn.querySelector('i').className = 'fas fa-spinner';
    try {
      const translated = await PPApi.translateTitle(text);
      let badge = block.querySelector('.pp-finding-en-badge');
      const html = _buildEnBadgeHTML(translated);
      if (badge) {
        badge.outerHTML = html;
      } else {
        block.querySelector('.pp-finding-header').insertAdjacentHTML('afterend', html);
      }
      toast('Translation complete!', 'success');
    } catch (e) {
      await _handleClaudeError(e, 'Translation error');
    } finally {
      btn.classList.remove('loading');
      btn.querySelector('i').className = 'fas fa-robot';
    }
  }

  /* ── Gap lists ─────────────────────────────────────────────────────────── */
  function _renderGapList(type, items) {
    if (type !== 'missing') return;
    const list = document.getElementById('gaps-missing-list');
    list.innerHTML = items.map(g => _gapMissingItemHTML(g)).join('');
    list.querySelectorAll('input[type="text"]').forEach(inp =>
      inp.addEventListener('input', () => { _recalcScore(); _updateFindingGapIndicators(); })
    );
    list.querySelectorAll('.pp-gap-needed-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.pp-gap-item').querySelector('.pp-gap-needed-row');
        if (row) {
          const hidden = row.style.display === 'none' || row.style.display === '';
          row.style.display = hidden ? '' : 'none';
          btn.classList.toggle('active', hidden);
        }
      });
    });
    list.querySelectorAll('.pp-gap-finding-select').forEach(sel => {
      sel.addEventListener('change', () => {
        sel.dataset.findingId = sel.value;
        sel.classList.toggle('assigned', !!sel.value);
        sel.closest('.pp-gap-item').classList.toggle('has-finding', !!sel.value);
        _updateFindingGapIndicators();
      });
    });
    if (state.currentId) {
      list.querySelectorAll('.pp-gap-item').forEach((item, idx) => {
        if (localStorage.getItem(`pp-col:${state.currentId}:g:${idx}`) === '1')
          item.classList.add('pp-gap-collapsed');
      });
    }
    _renumberGaps();
    _updateCollapseIndicators();
    _refreshAllJumpButtons();
  }

  function _renumberGaps() {
    document.querySelectorAll('#gaps-missing-list .pp-gap-item').forEach((item, i) => {
      const num = item.querySelector('.pp-gap-number');
      if (num) num.textContent = `G-${String(i + 1).padStart(2, '0')}`;
    });
  }

  function _gapMissingItemHTML(gap) {
    const text = typeof gap === 'string' ? gap : (gap.text || '');
    const findingId = typeof gap === 'string' ? '' : (gap.findingId || '');
    const neededExp = typeof gap === 'string' ? '' : (gap.neededExperiment || '');
    const hasFinding = findingId ? ' has-finding' : '';
    const assignedClass = findingId ? ' assigned' : '';
    const neededDisplay = neededExp ? '' : 'none';
    const neededActive = neededExp ? ' active' : '';
    const gid = 'gapm-' + (++_gapCounter);
    return `<div class="pp-gap-item${hasFinding}">
      <div class="pp-gap-item-top">
        <button type="button" class="pp-collapse-btn pp-collapse-btn--inline pp-gap-collapse-btn" title="Collapse / expand gap" ></button>
        <span class="pp-gap-number"></span>
        <input type="text" id="${gid}" value="${_esc(text)}" placeholder="Missing information…" />
        <button class="pp-ai-btn pp-ai-btn-xs" data-field-id="${gid}" data-ai-label="Gap (info faltante)" title="Contexto para Claude">AI</button>
        <button class="pp-btn pp-btn-sm pp-btn-ghost pp-gap-needed-toggle${neededActive}" title="Add a needed experiment to address this gap" type="button">
          <i class="fas fa-flask"></i> Needed experiment
        </button>
        <button class="pp-btn-icon btn-remove" title="Remove gap" onclick="this.closest('.pp-gap-item').remove();PrionPacks._renumberGaps();PrionPacks._refreshAllJumpButtons();PrionPacks._recalcScore();PrionPacks._updateFindingGapIndicators();">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div class="pp-gap-needed-row" style="display:${neededDisplay}">
        <label class="pp-gap-needed-label"><i class="fas fa-flask"></i> Needed experiment for this gap</label>
        <textarea class="pp-gap-needed-input pp-textarea" rows="2" placeholder="Describe the experiment proposed to address this missing information…">${_esc(neededExp)}</textarea>
      </div>
      <div class="pp-gap-finding-row">
        <span class="pp-gap-finding-label">Links to finding:</span>
        <select class="pp-gap-finding-select${assignedClass}" data-finding-id="${_esc(findingId)}">
          <option value="">— None —</option>
        </select>
      </div>
    </div>`;
  }

  function addGapItem(type) {
    if (type !== 'missing') return;
    const list = document.getElementById('gaps-missing-list');
    const tmp = document.createElement('div');
    tmp.innerHTML = _gapMissingItemHTML({ text: '', findingId: null, neededExperiment: '' });
    const item = tmp.firstElementChild;
    list.appendChild(item);
    item.querySelector('input[type="text"]').addEventListener('input', () => { _recalcScore(); _updateFindingGapIndicators(); });
    const neededToggle = item.querySelector('.pp-gap-needed-toggle');
    neededToggle.addEventListener('click', () => {
      const row = item.querySelector('.pp-gap-needed-row');
      if (row) {
        const hidden = row.style.display === 'none' || row.style.display === '';
        row.style.display = hidden ? '' : 'none';
        neededToggle.classList.toggle('active', hidden);
      }
    });
    const sel = item.querySelector('.pp-gap-finding-select');
    sel.addEventListener('change', () => {
      sel.dataset.findingId = sel.value;
      sel.classList.toggle('assigned', !!sel.value);
      item.classList.toggle('has-finding', !!sel.value);
      _updateFindingGapIndicators();
    });
    _refreshGapFindingSelects();
    _renumberGaps();
    _refreshAllJumpButtons();
    item.querySelector('input[type="text"]').focus();
    _recalcScore();
  }

  /* ── Gap-Finding association ───────────────────────────────────────────── */
  function _refreshGapFindingSelects() {
    const findings = Array.from(document.querySelectorAll('.pp-finding-block'));
    const optsHTML = '<option value="">— None —</option>' + findings.map((block, i) => {
      const num = 'F-' + String(i+1).padStart(2,'0');
      const title = block.querySelector('.pp-finding-title-input')?.value.trim() || '(untitled)';
      return `<option value="${_esc(block.dataset.id)}">${_esc(num + ': ' + title)}</option>`;
    }).join('');

    document.querySelectorAll('.pp-gap-finding-select').forEach(sel => {
      const savedId = sel.dataset.findingId || sel.value || '';
      sel.innerHTML = optsHTML;
      if (savedId) {
        sel.value = savedId;
        const matched = !!sel.value;
        sel.classList.toggle('assigned', matched);
        sel.closest('.pp-gap-item')?.classList.toggle('has-finding', matched);
        if (!matched) sel.dataset.findingId = '';
      }
    });
  }

  function _updateFindingGapIndicators() {
    const gapMap = {};
    document.querySelectorAll('#gaps-missing-list .pp-gap-item').forEach(item => {
      const sel = item.querySelector('.pp-gap-finding-select');
      const fid = sel?.value;
      if (fid) {
        if (!gapMap[fid]) gapMap[fid] = [];
        gapMap[fid].push(item.querySelector('input[type="text"]')?.value.trim() || '(gap)');
      }
    });

    document.querySelectorAll('.pp-finding-block').forEach(block => {
      const fid = block.dataset.id;
      const indicator = block.querySelector('.pp-finding-gap-indicator');
      if (!indicator) return;
      const gaps = gapMap[fid] || [];
      if (gaps.length) {
        indicator.classList.add('visible');
        const count = gaps.length;
        indicator.innerHTML = '';
        const icon = document.createElement('i');
        icon.className = 'fas fa-link';
        const text = document.createElement('span');
        text.textContent = `${count} gap${count !== 1 ? 's' : ''} associated — `;
        const link = document.createElement('span');
        link.className = 'pp-finding-gap-link';
        link.textContent = `view gap${count !== 1 ? 's' : ''}`;
        link.addEventListener('click', () => _scrollToGap(fid));
        text.appendChild(link);
        indicator.appendChild(icon);
        indicator.appendChild(text);
      } else {
        indicator.classList.remove('visible');
        indicator.innerHTML = '';
      }
    });
  }

  function _scrollToGap(findingId) {
    const items = Array.from(document.querySelectorAll('#gaps-missing-list .pp-gap-item'))
      .filter(item => item.querySelector('.pp-gap-finding-select')?.value === findingId);
    if (items.length) {
      items[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      items.forEach(item => {
        item.style.outline = '2px solid var(--pp-accent)';
        setTimeout(() => { item.style.outline = ''; }, 2000);
      });
    }
  }

  /* ── Scoring — findings 60%, figures 25%, gaps 15% ────────────────────── */
  function _recalcScore() {
    const findings = document.querySelectorAll('.pp-finding-block');

    // ── 1. FINDINGS (30%) ────────────────────────────────────────────────
    let fScore = 0, totalFigs = 0, filledFigs = 0;
    findings.forEach(block => {
      const title = block.querySelector('.pp-finding-title-input')?.value.trim() || '';
      const desc  = block.querySelector('.pp-textarea')?.value.trim() || '';
      fScore += (title ? 40 : 0) + (desc.length > 30 ? 60 : 0);
      block.querySelectorAll('.pp-figure-input, .pp-table-input').forEach(inp => {
        totalFigs++;
        if (inp.value.trim().length > 5) filledFigs++;
      });
    });
    if (findings.length) fScore = Math.round(fScore / findings.length);

    // ── 2. FIGURES & TABLES (15%) ────────────────────────────────────────
    let figScore = 0;
    if (totalFigs) figScore = Math.round((filledFigs / totalFigs) * 100);
    else if (findings.length) figScore = 20;

    // ── 3. MANUSCRIPT TEXT (35%) ─────────────────────────────────────────
    // Each field counts equally. "Done" = enough chars; partial = at least
    // some content; an alt() callback is honoured for fields that can be
    // satisfied by something other than text length (e.g. attached PDFs).
    const manuscriptFields = [
      { id: 'field-title',               minChars: 5   },
      { id: 'field-description',         minChars: 30  },
      { id: 'field-investigations-text', minChars: 30,
        alt: () => document.querySelectorAll('#investigations-files .pp-inv-chip').length > 0 },
      { id: 'field-abstract',            minChars: 100 },
      { id: 'field-authorsummary',       minChars: 100 },
      { id: 'field-introduction',        minChars: 100 },
      { id: 'field-discussion',          minChars: 100 },
    ];
    let manuscriptDone = 0;
    manuscriptFields.forEach(f => {
      const v = (document.getElementById(f.id)?.value || '').trim();
      if (v.length >= f.minChars)        manuscriptDone += 1;
      else if (f.alt && f.alt())         manuscriptDone += 1;
      else if (v.length > 0)             manuscriptDone += 0.5;
    });
    // Methods is multi-field — count it as fully done if there is at least one
    // method with a body of >=80 chars; half if there is at least one method
    // with any title or body.
    const methodsBodies = Array.from(document.querySelectorAll('#methods-list .pp-method-body-textarea'));
    const methodsTitles = Array.from(document.querySelectorAll('#methods-list .pp-method-title-input'));
    const methodsFilled = methodsBodies.some(t => (t.value || '').trim().length >= 80);
    const methodsAny    = methodsBodies.some(t => (t.value || '').trim()) ||
                          methodsTitles.some(t => (t.value || '').trim());
    if      (methodsFilled) manuscriptDone += 1;
    else if (methodsAny)    manuscriptDone += 0.5;
    const mScore = Math.round((manuscriptDone / (manuscriptFields.length + 1)) * 100);

    // ── 4. CLOSING & GAPS (20%) ──────────────────────────────────────────
    const closingFields = [
      { id: 'field-acknowledgments',      minChars: 20 },
      { id: 'field-funding',              minChars: 20 },
      { id: 'field-conflictsofinterest',  minChars: 10 },
      { id: 'field-credit',               minChars: 20 },
    ];
    let closingDone = 0;
    // References is multi-field — count it as fully done if there is at least
    // one non-empty reference, half if the section exists but is empty.
    const refsCount = document.querySelectorAll('#references-list .pp-reference-textarea').length;
    const refsFilled = Array.from(document.querySelectorAll('#references-list .pp-reference-textarea'))
      .filter(t => (t.value || '').trim().length >= 30).length;
    if (refsFilled > 0) closingDone += 1;
    else if (refsCount > 0) closingDone += 0.5;
    // Re-balance: there are now 5 closing items (4 single + references)
    closingFields.forEach(f => {
      const v = (document.getElementById(f.id)?.value || '').trim();
      if (v.length >= f.minChars) closingDone += 1;
      else if (v.length > 0)      closingDone += 0.5;
    });
    // closingFields has 4 entries; references adds a 5th item to the divisor.
    const closingFieldScore = Math.round((closingDone / (closingFields.length + 1)) * 100);
    // Gap health: documenting gaps is good; an explosion of gaps is bad.
    const gapCount = document.querySelectorAll('#gaps-missing-list .pp-gap-item').length;
    const gapHealth = gapCount === 0 ? 40
                    : gapCount <= 5 ? 100
                    : Math.max(20, 100 - (gapCount - 5) * 10);
    const cScore = Math.round((closingFieldScore + gapHealth) / 2);

    // ── TOTAL ────────────────────────────────────────────────────────────
    const total = Math.round(fScore * 0.30 + figScore * 0.15 + mScore * 0.35 + cScore * 0.20);
    _updateScore({ findings: fScore, figures: figScore, manuscript: mScore, closing: cScore, total });
    document.getElementById('meta-findings-count').textContent = findings.length;
  }

  function _updateScore(scores) {
    const { findings = 0, figures = 0, manuscript = 0, closing = 0, total = 0 } = scores;
    document.getElementById('score-pct').textContent = total + '%';
    const fill = document.getElementById('score-circle-fill');
    fill.style.strokeDashoffset = 251.2 - (total / 100) * 251.2;
    fill.style.stroke = total >= 90 ? '#26de81' : total >= 70 ? '#ffa502' : '#00d4aa';
    _setBar('findings',   findings);
    _setBar('figures',    figures);
    _setBar('manuscript', manuscript);
    _setBar('closing',    closing);
    let rec;
    if (total < 30)      rec = 'Just getting started — capture your first findings and ideas.';
    else if (total < 50) rec = 'Initial phase — keep developing your main findings.';
    else if (total < 70) rec = 'Good progress — focus on figures, intro/methods, and reducing gaps.';
    else if (total < 85) rec = 'Almost there — start drafting abstract, discussion and closing sections.';
    else if (total < 95) rec = 'Manuscript-ready — polish references, CReDiT and acknowledgments.';
    else                  rec = 'Ready for submission! Excellent work.';
    document.getElementById('score-rec-text').textContent = rec;
  }

  function _setBar(key, value) {
    const b = document.getElementById('score-bar-' + key);
    const v = document.getElementById('score-val-' + key);
    if (b) b.style.width = value + '%';
    if (v) v.textContent = value + '%';
  }

  /* ── Findings: add / remove ────────────────────────────────────────────── */
  function addFinding() {
    const container = document.getElementById('findings-container');
    const num = container.querySelectorAll('.pp-finding-block').length + 1;
    const block = _createFindingBlock({id:'f'+Date.now(),title:'',titleEnglish:'',description:'',figures:[],tables:[]}, num);
    container.appendChild(block);
    _setupAnchorButtons(block);
    _setupSupPreviews(block);
    document.getElementById('findings-empty').style.display = 'none';
    block.querySelector('.pp-finding-title-input').focus();
    _initDragDrop(container, {
      itemSelector: '.pp-finding-block',
      onReorder: () => {
        _renumberFindings();
        _refreshGapFindingSelects();
        _recalcScore();
        _refreshAllJumpButtons();
        _scheduleAutosave();
      },
    });
    _refreshGapFindingSelects();
    _recalcScore();
    _refreshAllJumpButtons();
  }

  function removeFinding(btn) {
    btn.closest('.pp-finding-block').remove();
    _renumberFindings();
    _refreshGapFindingSelects();
    _updateFindingGapIndicators();
    _recalcScore();
    _refreshAllJumpButtons();
  }

  function _renumberFindings() {
    document.querySelectorAll('.pp-finding-number').forEach((el, i) => {
      el.textContent = 'F-' + String(i+1).padStart(2,'0');
    });
  }

  /* ── Save ──────────────────────────────────────────────────────────────── */
  async function savePackage() {
    const title = (document.getElementById('field-title').value || '').trim();
    if (!title) { toast('Please enter a title.', 'error'); document.getElementById('field-title').focus(); return; }

    const btn = document.getElementById('btn-save-package');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando…';

    const data = _collectAllData(title);

    try {
      let saved;
      if (state.currentId) {
        saved = await PPStorage.update(state.currentId, data);
        const idx = _packages.findIndex(p => p.id === state.currentId);
        if (idx >= 0) _packages[idx] = saved;
      } else {
        saved = await PPStorage.create(data);
        _packages.push(saved);
        state.currentId = saved.id;
      }
      const savedBadge = document.getElementById('editor-id-badge');
      savedBadge.textContent = saved.id;
      _applyMemberColorToBadge(savedBadge, saved.responsible);
      document.getElementById('btn-delete-package').style.display = '';
      document.getElementById('btn-send-review').style.display = '';
      const dlWord = document.getElementById('btn-download-word');
      dlWord.href = `/prionpacks/api/packages/${saved.id}/docx`;
      dlWord.style.display = '';
      document.getElementById('meta-id').textContent = saved.id;
      document.getElementById('meta-created').textContent = _fmtDate(saved.createdAt);
      document.getElementById('meta-modified').textContent = _fmtDate(saved.lastModified);
      _renderSidebarList();
      _highlightSidebarItem(saved.id);
      toast('Package saved!', 'success');
    } catch (e) {
      toast('Save failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-save"></i> Guardar';
    }
  }

  function _collectFindings() {
    return Array.from(document.querySelectorAll('.pp-finding-block')).map(block => {
      const badge = block.querySelector('.pp-finding-en-badge');
      return {
        id: block.dataset.id || ('f' + Date.now()),
        title: block.querySelector('.pp-finding-title-input')?.value.trim() || '',
        titleEnglish: badge ? (badge.dataset.raw || '').trim() : '',
        description: block.querySelector('.pp-textarea')?.value.trim() || '',
        figures: Array.from(block.querySelectorAll('.pp-figure-item')).map((item, i) => ({
          id: 'fig' + (i + 1),
          description: item.querySelector('.pp-figure-input')?.value.trim() || '',
          imageUrl: item.dataset.imageUrl || null,
          caption:  item.dataset.caption  || null,
        })),
        tables: Array.from(block.querySelectorAll('.pp-table-row')).map((row, i) => ({
          id: 'tbl' + (i + 1),
          description: row.querySelector('.pp-table-input')?.value.trim() || '',
        })),
      };
    });
  }

  function _collectGapList(listId) {
    if (listId === 'gaps-missing-list') {
      return Array.from(document.querySelectorAll('#' + listId + ' .pp-gap-item')).map(item => ({
        text: item.querySelector('input[type="text"]')?.value.trim() || '',
        findingId: item.querySelector('.pp-gap-finding-select')?.value || null,
        neededExperiment: item.querySelector('.pp-gap-needed-input')?.value.trim() || null,
      })).filter(g => g.text);
    }
    return [];
  }

  function _collectScores() {
    return {
      findings:   _readPct('score-val-findings'),
      figures:    _readPct('score-val-figures'),
      manuscript: _readPct('score-val-manuscript'),
      closing:    _readPct('score-val-closing'),
      total:      _readPct('score-pct'),
    };
  }

  function _readPct(id) {
    return parseInt(document.getElementById(id)?.textContent, 10) || 0;
  }

  function _getCurrentPriority() {
    return document.querySelector('.pp-priority-btn.active')?.dataset.priority || 'none';
  }

  /* ── Delete ────────────────────────────────────────────────────────────── */
  async function deletePackage() {
    if (!state.currentId) return;
    if (!confirm('Delete this package? This cannot be undone.')) return;
    try {
      await PPStorage.remove(state.currentId);
      _packages = _packages.filter(p => p.id !== state.currentId);
      state.currentId = null;
      showDashboard();
      toast('Package deleted.', 'error');
    } catch (e) {
      toast('Delete failed: ' + e.message, 'error');
    }
  }

  /* ── Drag & Drop ───────────────────────────────────────────────────────── */
  function _initDragDrop(container, opts) {
    const itemSelector = opts?.itemSelector || '.pp-finding-block';
    const onReorder    = opts?.onReorder    || (() => {});
    let dragging = null;
    container.querySelectorAll(itemSelector).forEach(block => {
      if (block.dataset.dragWired === '1') return;
      block.draggable = true;
      block.addEventListener('dragstart', e => {
        dragging = block; block.style.opacity = '.4'; e.dataTransfer.effectAllowed = 'move';
      });
      block.addEventListener('dragend', () => {
        dragging = null; block.style.opacity = '';
        container.querySelectorAll(itemSelector).forEach(b => b.classList.remove('drag-over'));
        onReorder();
      });
      block.addEventListener('dragover', e => {
        e.preventDefault();
        if (!dragging || dragging === block) return;
        const mid = block.getBoundingClientRect().top + block.getBoundingClientRect().height / 2;
        if (e.clientY < mid) container.insertBefore(dragging, block);
        else block.insertAdjacentElement('afterend', dragging);
        container.querySelectorAll(itemSelector).forEach(b => b.classList.remove('drag-over'));
        block.classList.add('drag-over');
      });
      block.addEventListener('dragleave', () => block.classList.remove('drag-over'));
      block.addEventListener('drop', e => { e.preventDefault(); block.classList.remove('drag-over'); });
      block.dataset.dragWired = '1';
    });
  }

  /* ── Restore from backup modal ─────────────────────────────────────────── */
  function _openRestoreModal() {
    const modal = document.getElementById('pp-restore-modal');
    modal.style.display = 'flex';
    _loadRestoreList();
  }

  function _closeRestoreModal() {
    document.getElementById('pp-restore-modal').style.display = 'none';
  }

  async function _loadRestoreList() {
    const list = document.getElementById('pp-restore-list');
    list.innerHTML = '<div class="pp-restore-loading"><i class="fas fa-spinner fa-spin"></i> Cargando backups…</div>';
    try {
      const res = await fetch('/prionpacks/api/backup/list');
      const backups = await res.json();
      if (!backups.length) {
        list.innerHTML = '<div class="pp-restore-empty"><i class="fas fa-cloud" style="font-size:28px;opacity:.3;display:block;margin-bottom:8px;"></i>No hay backups disponibles en Dropbox todavía.</div>';
        return;
      }
      list.innerHTML = backups.map(b => {
        const raw = b.timestamp || '';
        const date = raw.length === 15
          ? `${raw.slice(6,8)}/${raw.slice(4,6)}/${raw.slice(0,4)}  ${raw.slice(9,11)}:${raw.slice(11,13)}:${raw.slice(13,15)}`
          : raw;
        return `
        <div class="pp-restore-item">
          <div class="pp-restore-item-icon"><i class="fas fa-file-archive"></i></div>
          <div class="pp-restore-item-body">
            <div class="pp-restore-item-date">${date}</div>
            <div class="pp-restore-item-meta">${b.size_kb} KB · ${_esc(b.name)}</div>
          </div>
          <button class="pp-restore-item-btn" data-path="${_esc(b.path)}" data-name="${_esc(date)}">
            <i class="fas fa-undo-alt"></i> Restaurar
          </button>
        </div>`;
      }).join('');

      list.querySelectorAll('.pp-restore-item-btn').forEach(btn => {
        btn.addEventListener('click', () => _confirmRestore(btn.dataset.path, btn.dataset.name));
      });
    } catch (e) {
      list.innerHTML = '<div class="pp-restore-empty" style="color:#ef4444;"><i class="fas fa-exclamation-triangle"></i> No se pudo cargar la lista de backups.</div>';
    }
  }

  async function _confirmRestore(path, dateLabel) {
    const ok = confirm(
      `¿Restaurar el backup del ${dateLabel}?\n\n` +
      `Se sustituirán TODOS los datos actuales. Se guardará una copia local antes de sobreescribir.\n\n` +
      `Esta acción no se puede deshacer desde la interfaz.`
    );
    if (!ok) return;

    const btn = document.querySelector(`.pp-restore-item-btn[data-path="${CSS.escape(path)}"]`);
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }

    try {
      const res = await fetch('/prionpacks/api/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const data = await res.json();
      if (data.status === 'ok') {
        _closeRestoreModal();
        toast('✓ Datos restaurados correctamente. Recargando…', 'success');
        setTimeout(() => location.reload(), 1800);
      } else {
        toast('⚠ Error al restaurar: ' + (data.message || 'error desconocido'), 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-undo-alt"></i> Restaurar'; }
      }
    } catch (e) {
      toast('⚠ No se pudo conectar con el servidor', 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-undo-alt"></i> Restaurar'; }
    }
  }

  /* ── Manual Dropbox backup ─────────────────────────────────────────────── */
  async function _runManualBackup() {
    const btn = document.getElementById('btn-backup-dropbox');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    const originalHTML = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando…';
    try {
      const res = await fetch('/prionpacks/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      const data = await res.json();
      if (data.status === 'ok') {
        toast('✓ Backup guardado en Dropbox correctamente', 'success');
      } else if (data.status === 'skipped') {
        toast('Sin cambios desde el último backup — no era necesario subir', 'info');
      } else {
        toast('⚠ Error en el backup: ' + (data.message || 'error desconocido'), 'error');
      }
    } catch (e) {
      toast('⚠ No se pudo conectar con el servidor para el backup', 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHTML;
    }
  }

  /* ── Global events ─────────────────────────────────────────────────────── */
  function _bindGlobalEvents() {
    document.getElementById('btn-new-package').addEventListener('click', () => showEditor(null));
    document.getElementById('btn-new-package-main').addEventListener('click', () => showEditor(null));
    document.getElementById('btn-fab-new')?.addEventListener('click', () => showEditor(null));
    document.getElementById('btn-mobile-new')?.addEventListener('click', () => { _closeMobileSidebar(); showEditor(null); });
    document.getElementById('btn-editor-notes')?.addEventListener('click', () => { if (state.currentId) _openNotes(state.currentId); });
    document.getElementById('btn-backup-dropbox')?.addEventListener('click', _runManualBackup);
    document.getElementById('btn-open-restore')?.addEventListener('click', _openRestoreModal);
    document.getElementById('pp-restore-modal-close')?.addEventListener('click', _closeRestoreModal);
    document.getElementById('pp-restore-modal-cancel')?.addEventListener('click', _closeRestoreModal);
    document.getElementById('pp-restore-backdrop')?.addEventListener('click', _closeRestoreModal);
    document.getElementById('btn-first-package')?.addEventListener('click', () => showEditor(null));
    document.getElementById('btn-back-dashboard').addEventListener('click', showDashboard);
    document.getElementById('btn-save-package').addEventListener('click', savePackage);
    document.getElementById('btn-delete-package').addEventListener('click', deletePackage);

    // Alternative titles
    document.getElementById('btn-add-alt-title')?.addEventListener('click', _addAltTitleRow);
    document.getElementById('btn-toggle-alt-titles')?.addEventListener('click', _toggleAltTitles);

    // Documentation view
    document.getElementById('btn-show-docs')?.addEventListener('click', () => showView('docs'));
    document.getElementById('btn-docs-back')?.addEventListener('click', showDashboard);

    // Doc-block collapse triangles — restore saved state, then bind clicks
    document.querySelectorAll('.pp-doc-block').forEach(block => {
      const id  = block.id;
      const key = id ? 'pp-collapse:' + id : '';
      if (key && localStorage.getItem(key) === '1') {
        block.classList.add('pp-doc-block-collapsed');
      }
    });
    document.querySelectorAll('.pp-doc-collapse-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        const block = btn.closest('.pp-doc-block');
        if (!block) return;
        const collapsed = block.classList.toggle('pp-doc-block-collapsed');
        if (block.id) {
          if (collapsed) localStorage.setItem('pp-collapse:' + block.id, '1');
          else           localStorage.removeItem('pp-collapse:' + block.id);
        }
      });
    });
    // Delegated copy handler for any documentation block
    document.querySelectorAll('.pp-doc-copy-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const targetId = btn.dataset.target;
        const txt = document.getElementById(targetId)?.textContent || '';
        if (!txt) { toast('No hay contenido que copiar.', 'error'); return; }
        try {
          await navigator.clipboard.writeText(txt);
          toast('Texto copiado al portapapeles.', 'success');
        } catch (e) {
          try {
            const tmp = document.createElement('textarea');
            tmp.value = txt;
            document.body.appendChild(tmp);
            tmp.select();
            document.execCommand('copy');
            tmp.remove();
            toast('Texto copiado al portapapeles.', 'success');
          } catch {
            toast('No se pudo copiar. Selecciona el texto manualmente.', 'error');
          }
        }
      });
    });

    const searchInput = document.getElementById('pp-search');
    const searchHint  = document.getElementById('pp-search-hint');
    const searchMode  = document.getElementById('btn-search-mode');

    function _refreshSearchHint() {
      if (!searchHint) return;
      if (state.searchMode !== 'advanced' || !state.search.trim()) {
        searchHint.style.display = 'none';
        searchHint.textContent = '';
        return;
      }
      const tokens = _splitAdvancedTokens(state.search);
      const matches = _filteredPackages().length;
      searchHint.style.display = '';
      searchHint.textContent = `${tokens.length} term${tokens.length === 1 ? '' : 's'} · ${matches} match${matches === 1 ? '' : 'es'}`;
    }

    function _applySearchMode() {
      const advanced = state.searchMode === 'advanced';
      searchMode?.classList.toggle('is-active', advanced);
      searchInput.placeholder = advanced
        ? 'Paste DOIs / terms separated by , ; tab or new line…'
        : 'Search all fields…';
      _refreshSearchHint();
    }

    // Restore saved mode (so it survives reloads, like the rest of the UI)
    if (localStorage.getItem('pp-search-mode') === 'advanced') {
      state.searchMode = 'advanced';
    }
    _applySearchMode();

    // Restore responsible filter
    const savedResp = localStorage.getItem('pp-filter-responsible');
    if (savedResp) state.filterResponsible = savedResp;
    _syncResponsibleChips();

    searchInput.addEventListener('input', e => {
      state.search = e.target.value;
      _renderDashboard();
      _refreshSearchHint();
    });
    searchMode?.addEventListener('click', () => {
      state.searchMode = state.searchMode === 'advanced' ? 'simple' : 'advanced';
      localStorage.setItem('pp-search-mode', state.searchMode);
      _applySearchMode();
      _renderDashboard();
      searchInput.focus();
    });
    document.getElementById('filter-status').addEventListener('change', e => {
      state.filterStatus = e.target.value;
      _syncMetricButtons();
      _renderDashboard();
    });
    document.getElementById('filter-priority').addEventListener('change', e => {
      state.filterPriority = e.target.value;
      _renderDashboard();
    });

    document.getElementById('filter-responsible-chips').addEventListener('click', e => {
      const chip = e.target.closest('.pp-resp-chip');
      if (!chip) return;
      state.filterResponsible = chip.dataset.responsible;
      localStorage.setItem('pp-filter-responsible', state.filterResponsible);
      _syncResponsibleChips();
      _renderDashboard();
    });

    document.querySelectorAll('.pp-metric-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const f = btn.dataset.filter;
        state.filterStatus = f;
        document.getElementById('filter-status').value = f;
        _syncMetricButtons();
        _renderDashboard();
        document.getElementById('pp-cards-grid').scrollIntoView({ behavior: 'smooth' });
      });
    });

    document.getElementById('btn-add-finding').addEventListener('click', addFinding);
    document.getElementById('btn-send-review').addEventListener('click', _openSendModal);

    // Toggle buttons — basic info group
    document.getElementById('btn-toggle-coauthors').addEventListener('click', () =>
      _toggleSection('section-coauthors', 'btn-toggle-coauthors', 'fa-users', 'Co-authors'));
    document.getElementById('btn-toggle-affiliations').addEventListener('click', () =>
      _toggleSection('section-affiliations', 'btn-toggle-affiliations', 'fa-university', 'Affiliations'));
    document.getElementById('btn-toggle-abstract').addEventListener('click', () =>
      _toggleSection('section-abstract', 'btn-toggle-abstract', 'fa-align-left', 'Abstract'));
    document.getElementById('btn-toggle-authorsummary').addEventListener('click', () =>
      _toggleSection('section-authorsummary', 'btn-toggle-authorsummary', 'fa-user-edit', 'Author Summary'));
    document.getElementById('btn-toggle-introduction').addEventListener('click', _toggleIntroduction);
    document.getElementById('btn-toggle-methods').addEventListener('click', () => {
      _toggleSection('section-methods', 'btn-toggle-methods', 'fa-flask-vial', 'Methods');
      const section = document.getElementById('section-methods');
      const list    = document.getElementById('methods-list');
      if (section && section.style.display !== 'none' && list && list.children.length === 0) {
        _addMethod(false);
      }
    });
    document.getElementById('btn-add-method')?.addEventListener('click', () => _addMethod(true));
    // Delegated AI / Claude clicks for dynamic method rows
    document.getElementById('methods-list')?.addEventListener('click', e => {
      const aiBtn = e.target.closest('.pp-ai-btn');
      if (aiBtn && e.currentTarget.contains(aiBtn)) {
        aiBtn.classList.toggle('active');
        return;
      }
      const claudeBtn = e.target.closest('.pp-claude-ask-btn');
      if (claudeBtn && e.currentTarget.contains(claudeBtn)) {
        _askClaudeField(claudeBtn.dataset.sourceId, claudeBtn.dataset.sourceLabel);
      }
    });

    // Toggle buttons — gaps group
    document.getElementById('btn-toggle-discussion').addEventListener('click', _toggleDiscussion);
    document.getElementById('btn-toggle-acknowledgments').addEventListener('click', () =>
      _toggleSection('section-acknowledgments', 'btn-toggle-acknowledgments', 'fa-heart', 'Acknowledgments'));
    document.getElementById('btn-toggle-funding').addEventListener('click', () =>
      _toggleSection('section-funding', 'btn-toggle-funding', 'fa-coins', 'Funding'));
    document.getElementById('btn-toggle-conflicts').addEventListener('click', () =>
      _toggleSection('section-conflicts', 'btn-toggle-conflicts', 'fa-balance-scale', 'Conflicts of interest'));
    // References section: open the section and ensure at least one ref row exists.
    document.getElementById('btn-toggle-references').addEventListener('click', () => {
      _toggleSection('section-references', 'btn-toggle-references', 'fa-list', 'References');
      const section = document.getElementById('section-references');
      const list    = document.getElementById('references-list');
      if (section && section.style.display !== 'none' && list && list.children.length === 0) {
        _addReference(false);
      }
    });
    document.getElementById('btn-add-reference')?.addEventListener('click', () => _addReference(true));
    document.getElementById('btn-collapse-all-refs')?.addEventListener('click', () => _toggleCollapseAllRefs());
    document.getElementById('btn-discuss-claude')?.addEventListener('click', () => _askClaudeDiscussion());
    // Delegated AI toggle for dynamic reference rows
    document.getElementById('references-list')?.addEventListener('click', e => {
      const aiBtn = e.target.closest('.pp-ai-btn');
      if (aiBtn && e.currentTarget.contains(aiBtn)) {
        aiBtn.classList.toggle('active');
      }
    });
    // Introduction References
    document.getElementById('btn-add-intro-reference')?.addEventListener('click', () => _addIntroReference(true));
    document.getElementById('btn-collapse-all-intro-refs')?.addEventListener('click', () => _toggleCollapseAllIntroRefs());

    // Intro References sub-section collapse triangle (left of the label)
    const introRefsSub = document.getElementById('intro-refs-sub');
    const introRefsBtn = document.querySelector('.pp-intro-refs-collapse-btn');
    if (introRefsSub && introRefsBtn) {
      const KEY = 'pp-collapse:intro-refs-sub';
      if (localStorage.getItem(KEY) === '1') introRefsSub.classList.add('pp-intro-refs-collapsed');
      introRefsBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        const collapsed = introRefsSub.classList.toggle('pp-intro-refs-collapsed');
        if (collapsed) localStorage.setItem(KEY, '1');
        else           localStorage.removeItem(KEY);
      });
    }
    document.getElementById('intro-references-list')?.addEventListener('click', e => {
      const aiBtn = e.target.closest('.pp-ai-btn');
      if (aiBtn && e.currentTarget.contains(aiBtn)) {
        aiBtn.classList.toggle('active');
      }
    });
    document.getElementById('btn-clip-intro-refs')?.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      const text = _collectIntroReferencesText();
      if (!text || !text.trim()) { toast('No hay referencias de introducción.', 'error'); return; }
      try {
        await navigator.clipboard.writeText(text);
        toast('Referencias de introducción copiadas al portapapeles.', 'success');
      } catch {
        const tmp = document.createElement('textarea');
        tmp.value = text;
        document.body.appendChild(tmp);
        tmp.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch {}
        tmp.remove();
        toast(ok ? 'Referencias de introducción copiadas al portapapeles.' : 'No se pudo copiar.', ok ? 'success' : 'error');
      }
    });
    document.getElementById('btn-toggle-credit').addEventListener('click', () =>
      _toggleSection('section-credit', 'btn-toggle-credit', 'fa-list-check', 'CReDiT'));

    // Active/Inactive toggle
    document.getElementById('btn-active-toggle').addEventListener('click', () => {
      _setActiveState(!_getCurrentActive());
    });

    document.getElementById('field-responsible').addEventListener('change', e => {
      _applyMemberColorToBadge(document.getElementById('editor-id-badge'), e.target.value);
    });

    // Investigations file input
    document.getElementById('pp-inv-file-input').addEventListener('change', e => {
      if (e.target.files.length) {
        _handleInvFiles(e.target.files);
        e.target.value = '';
      }
    });

    // Static field Claude ask buttons
    document.querySelectorAll('.pp-claude-ask-btn[data-source-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        _askClaudeField(btn.dataset.sourceId, btn.dataset.sourceLabel);
      });
    });

    // Static field AI toggles
    document.querySelectorAll('.pp-ai-btn[data-field-id]').forEach(btn => {
      btn.addEventListener('click', () => btn.classList.toggle('active'));
    });

    // Event delegation for dynamic findings AI toggles and Claude buttons
    document.getElementById('findings-container').addEventListener('click', e => {
      const collapseBtn = e.target.closest('.pp-finding-collapse-btn');
      if (collapseBtn) {
        e.preventDefault();
        e.stopPropagation();
        const block = collapseBtn.closest('.pp-finding-block');
        if (block) {
          block.classList.toggle('pp-finding-collapsed');
          _saveItemCollapse('f', block, block.classList.contains('pp-finding-collapsed'));
        }
        return;
      }
      const aiBtn = e.target.closest('.pp-ai-btn');
      if (aiBtn) { aiBtn.classList.toggle('active'); return; }
      const claudeBtn = e.target.closest('.pp-claude-finding-btn');
      if (claudeBtn) {
        _askClaudeField(claudeBtn.dataset.sourceId, claudeBtn.dataset.sourceLabel);
        return;
      }
      const applyBtn = e.target.closest('.pp-finding-en-apply');
      if (applyBtn) {
        const badge = applyBtn.closest('.pp-finding-en-badge');
        const block = applyBtn.closest('.pp-finding-block');
        const titleInput = block?.querySelector('.pp-finding-title-input');
        const raw = badge?.dataset.raw || '';
        if (titleInput && raw) {
          titleInput.value = raw;
          // Fire input event so autosave + score recalc + AI label refresh trigger
          titleInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        badge?.remove();
        _scheduleAutosave();
        toast('Traducción aplicada al título.', 'success');
      }
    });

    // Event delegation for gap AI toggles and collapse
    document.getElementById('gaps-missing-list').addEventListener('click', e => {
      const colBtn = e.target.closest('.pp-gap-collapse-btn');
      if (colBtn) {
        e.preventDefault();
        e.stopPropagation();
        const item = colBtn.closest('.pp-gap-item');
        if (item) {
          item.classList.toggle('pp-gap-collapsed');
          _saveItemCollapse('g', item, item.classList.contains('pp-gap-collapsed'));
        }
        return;
      }
      const aiBtn = e.target.closest('.pp-ai-btn');
      if (aiBtn) aiBtn.classList.toggle('active');
    });

    // Autosave on any input in the editor
    document.getElementById('view-editor').addEventListener('input', _scheduleAutosave);

    document.querySelectorAll('.pp-priority-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.pp-priority-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    const titleEl = document.getElementById('field-title');
    titleEl.addEventListener('input', e => { _updateTitleDisplay(e.target.value); });

    document.getElementById('btn-save-api-key').addEventListener('click', () => {
      const key = document.getElementById('field-api-key').value.trim();
      if (!key) { toast('Enter an API key.', 'error'); return; }
      PPStorage.saveApiKey(key);
      const status = document.getElementById('api-key-status');
      status.textContent = '✓ Saved';
      status.className = 'pp-api-status ok';
      toast('API key saved.', 'success');
    });
  }

  function _bindModalEvents() {
    // Image upload modal
    document.getElementById('pp-img-modal-close').addEventListener('click', _closeImgUploadModal);
    document.getElementById('pp-img-modal-backdrop').addEventListener('click', _closeImgUploadModal);

    const dropZone   = document.getElementById('pp-img-drop-zone');
    const fileInput  = document.getElementById('pp-img-file-input');
    const browseLink = dropZone.querySelector('.pp-img-browse-link');

    // Only the "browse files" link opens the file picker — clicking elsewhere
    // on the drop zone keeps focus inside the modal so Ctrl/⌘ + V can paste.
    if (browseLink) {
      browseLink.addEventListener('click', e => {
        e.stopPropagation();
        fileInput.click();
      });
    }
    fileInput.addEventListener('change', e => { if (e.target.files[0]) _handleImageFile(e.target.files[0]); });

    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer.files[0]) _handleImageFile(e.dataTransfer.files[0]);
    });

    // Local paste listener on the focused drop zone (works in browsers that
    // don't deliver paste events to document when focus is on a non-input).
    dropZone.addEventListener('paste', e => {
      if (!_imgUploadCallback) return;
      const imageItem = Array.from(e.clipboardData?.items || []).find(i => i.type.startsWith('image/'));
      if (imageItem) { e.preventDefault(); _handleImageFile(imageItem.getAsFile()); }
    });

    // Paste support while modal is open
    document.addEventListener('paste', e => {
      if (document.getElementById('pp-img-upload-modal').style.display === 'none') return;
      if (!_imgUploadCallback) return;
      const imageItem = Array.from(e.clipboardData?.items || []).find(i => i.type.startsWith('image/'));
      if (imageItem) { e.preventDefault(); _handleImageFile(imageItem.getAsFile()); }
    });

    // Figure viewer modal
    document.getElementById('pp-fig-view-close').addEventListener('click', _closeFigureViewModal);
    document.getElementById('pp-fig-view-backdrop').addEventListener('click', _closeFigureViewModal);

    // Send review modal
    document.getElementById('pp-send-backdrop').addEventListener('click', _closeSendModal);
    document.getElementById('pp-send-modal-close').addEventListener('click', _closeSendModal);
    document.getElementById('pp-send-cancel').addEventListener('click', _closeSendModal);
    document.getElementById('pp-send-btn').addEventListener('click', _sendReview);

    document.querySelectorAll('.pp-colleague-card').forEach(card => {
      card.addEventListener('click', () => {
        const key = card.dataset.key;
        if (_selectedColleagues.has(key)) {
          _selectedColleagues.delete(key);
          card.classList.remove('selected');
          card.setAttribute('aria-pressed', 'false');
        } else {
          _selectedColleagues.add(key);
          card.classList.add('selected');
          card.setAttribute('aria-pressed', 'true');
        }
        _updateSendBtnState();
      });
    });

    // Claude response modal
    document.getElementById('pp-claude-modal-close').addEventListener('click', _closeClaudeModal);
    document.getElementById('pp-claude-modal-backdrop').addEventListener('click', _closeClaudeModal);
    document.getElementById('pp-claude-modal-discard').addEventListener('click', _closeClaudeModal);
    document.getElementById('pp-claude-modal-apply').addEventListener('click', () => {
      if (_claudeModalCallback) _claudeModalCallback();
      _closeClaudeModal();
    });

    // Escape closes any open modal
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (document.getElementById('pp-claude-modal').style.display    !== 'none') _closeClaudeModal();
      if (document.getElementById('pp-img-upload-modal').style.display !== 'none') _closeImgUploadModal();
      if (document.getElementById('pp-fig-view-modal').style.display  !== 'none') _closeFigureViewModal();
      if (document.getElementById('pp-send-modal').style.display      !== 'none') _closeSendModal();
    });
  }

  function _syncMetricButtons() {
    document.querySelectorAll('.pp-metric-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === state.filterStatus);
    });
  }

  function _renderResponsibleChips() {
    const container = document.getElementById('filter-responsible-chips');
    if (!container) return;
    const cur = state.filterResponsible;
    const memberChips = _members.map(m => {
      const c = _memberColors(m.color);
      return `<button class="pp-resp-chip${cur === m.id ? ' active' : ''}" data-responsible="${_esc(m.id)}"
        title="${_esc(m.name + ' ' + m.surname)}"
        style="--m-badge:${c.badge};--m-text:${c.text};--m-bg:${c.bg};">${_esc(m.initials)}</button>`;
    }).join('');
    container.innerHTML =
      `<button class="pp-resp-chip pp-resp-chip-all${cur === 'all' ? ' active' : ''}" data-responsible="all" title="Todos">Todos</button>` +
      memberChips +
      `<button class="pp-resp-chip pp-resp-chip-none${cur === 'none' ? ' active' : ''}" data-responsible="none" title="Sin asignar">—</button>`;
  }

  function _syncResponsibleChips() {
    document.querySelectorAll('#filter-responsible-chips .pp-resp-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.responsible === state.filterResponsible);
    });
  }

  function _applyMemberColorToBadge(el, responsibleId) {
    const resp = responsibleId ? _responsibleConfig(responsibleId) : null;
    if (resp) {
      el.style.setProperty('--m-badge', resp.badge);
      el.style.setProperty('--m-text',  resp.text);
    } else {
      el.style.removeProperty('--m-badge');
      el.style.removeProperty('--m-text');
    }
  }

  function _loadApiKeyField() {
    const key = PPStorage.getApiKey();
    if (key) {
      document.getElementById('field-api-key').value = key;
      const status = document.getElementById('api-key-status');
      status.textContent = '✓ Active';
      status.className = 'pp-api-status ok';
    }
  }

  function _bindKeyboardShortcuts() {
    document.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'n') { e.preventDefault(); showEditor(null); }
        if (e.key === 's' && state.view === 'editor') { e.preventDefault(); savePackage(); }
        if (e.key === 'f') { e.preventDefault(); document.getElementById('pp-search').focus(); }
      }
    });
  }

  /* ── Helpers ───────────────────────────────────────────────────────────── */
  function _priorityColor(p) {
    return { high:'#ff4757', medium:'#ffa502', low:'#26de81', none:'#747d8c' }[p] || '#747d8c';
  }

  function _fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
  }

  function _esc(str) {
    return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Render text with markdown-style superscript markers: PrP^Sc^ -> PrP<sup>Sc</sup>.
  // The input is HTML-escaped first; only the <sup> tags we generate are kept.
  // The regex requires the segment to start with a non-whitespace char so it
  // does not match stray "^ ... ^" patterns where the carets are isolated;
  // internal spaces inside the brackets are allowed (e.g. ^max value^).
  // Used in read-only display contexts (titles, badges, dashboard cards…).
  function _supHtml(str) {
    const escaped = _esc(str);
    return escaped.replace(/\^(\S[^\^\n]*?)\^/g, '<sup>$1</sup>');
  }

  // Builds the EN badge HTML shown under a finding header. The raw translation
  // (with its ^...^ superscript markers preserved) is stored on data-raw so the
  // "Apply" button can copy it verbatim into the title input, and so that
  // _collectFindings can save it without losing the markers.
  function _buildEnBadgeHTML(text) {
    const raw = String(text || '');
    return `<div class="pp-finding-en-badge" data-raw="${_esc(raw)}">
      <span class="pp-finding-en-text">EN: ${_supHtml(raw)}</span>
      <button type="button" class="pp-btn pp-btn-sm pp-finding-en-apply" title="Pasar la traducción al título y borrar este aviso">
        <i class="fas fa-check"></i> Usar como título
      </button>
    </div>`;
  }

  /* ── Toast ─────────────────────────────────────────────────────────────── */
  function toast(msg, type) {
    const c = document.getElementById('pp-toast-container');
    const el = document.createElement('div');
    el.className = 'pp-toast' + (type==='error'?' pp-toast-error':type==='success'?' pp-toast-success':'');
    const icon = type==='error'?'fa-exclamation-circle':type==='success'?'fa-check-circle':'fa-info-circle';
    el.innerHTML = `<i class="fas ${icon}"></i> ${_esc(msg)}`;
    c.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  /* ── Members view ──────────────────────────────────────────────────────── */

  function showMembers() {
    showView('members');
    _renderMembersGrid();
  }

  function _renderMembersGrid() {
    const grid = document.getElementById('pp-members-grid');
    if (!grid) return;
    if (!_members.length) {
      grid.innerHTML = '<div class="pp-members-empty"><i class="fas fa-users"></i><p>No hay miembros aún. Crea el primero.</p></div>';
      return;
    }
    grid.innerHTML = _members.map(m => {
      const c = _memberColors(m.color);
      return `
      <div class="pp-member-card" data-id="${_esc(m.id)}">
        <div class="pp-member-avatar" style="background:${c.badge};color:${c.text};">${_esc(m.initials)}</div>
        <div class="pp-member-info">
          <div class="pp-member-name">${_esc(m.name + ' ' + m.surname)}</div>
          <div class="pp-member-email">${_esc(m.email || '—')}</div>
        </div>
        <div class="pp-member-swatch" style="background:${m.color};" title="${m.color}"></div>
        <div class="pp-member-actions">
          <button class="pp-btn-icon btn-edit-member" data-id="${_esc(m.id)}" title="Editar">
            <i class="fas fa-pen"></i>
          </button>
          <button class="pp-btn-icon btn-delete-member pp-btn-icon-danger" data-id="${_esc(m.id)}" title="Eliminar">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>`;
    }).join('');

    grid.querySelectorAll('.btn-edit-member').forEach(btn =>
      btn.addEventListener('click', () => _openMemberModal(btn.dataset.id)));
    grid.querySelectorAll('.btn-delete-member').forEach(btn =>
      btn.addEventListener('click', () => _deleteMember(btn.dataset.id)));
  }

  let _editingMemberId = null;
  let _selectedColor   = MEMBER_PALETTE[0].value;

  function _openMemberModal(memberId) {
    _editingMemberId = memberId || null;
    const m = memberId ? _members.find(x => x.id === memberId) : null;

    document.getElementById('pp-member-modal-title').innerHTML =
      memberId ? '<i class="fas fa-user-edit"></i> Editar miembro'
               : '<i class="fas fa-user-plus"></i> Añadir miembro';
    document.getElementById('member-name').value     = m?.name     || '';
    document.getElementById('member-surname').value  = m?.surname  || '';
    document.getElementById('member-initials').value = m?.initials || '';
    document.getElementById('member-email').value    = m?.email    || '';
    document.getElementById('member-password').value = '';
    document.getElementById('member-pwd-hint').style.display = memberId ? '' : 'none';
    document.getElementById('pp-member-error').style.display = 'none';

    _selectedColor = m?.color || MEMBER_PALETTE[0].value;
    _renderColorPalette();
    document.getElementById('pp-member-modal').style.display = 'flex';
    document.getElementById('member-name').focus();
  }

  function _renderColorPalette() {
    const el = document.getElementById('member-color-palette');
    el.innerHTML = MEMBER_PALETTE.map(p =>
      `<button type="button" class="pp-color-swatch${p.value === _selectedColor ? ' selected' : ''}"
        data-color="${p.value}" style="background:${p.value};" title="${p.value}">
        ${p.value === _selectedColor ? '<i class="fas fa-check"></i>' : ''}
      </button>`
    ).join('');
    el.querySelectorAll('.pp-color-swatch').forEach(btn => {
      btn.addEventListener('click', () => {
        _selectedColor = btn.dataset.color;
        _renderColorPalette();
      });
    });
  }

  function _closeMemberModal() {
    document.getElementById('pp-member-modal').style.display = 'none';
    _editingMemberId = null;
  }

  async function _saveMember() {
    const name    = document.getElementById('member-name').value.trim();
    const surname = document.getElementById('member-surname').value.trim();
    if (!name || !surname) {
      _showMemberError('Nombre y apellidos son obligatorios.');
      return;
    }
    const payload = {
      name, surname,
      initials: document.getElementById('member-initials').value.trim() || undefined,
      email:    document.getElementById('member-email').value.trim(),
      color:    _selectedColor,
    };
    const pwd = document.getElementById('member-password').value;
    if (pwd) payload.password = pwd;

    const saveBtn = document.getElementById('pp-member-modal-save');
    saveBtn.disabled = true;
    try {
      let res;
      if (_editingMemberId) {
        res = await fetch(`/prionpacks/api/members/${_editingMemberId}`, {
          method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload),
        });
      } else {
        res = await fetch('/prionpacks/api/members', {
          method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload),
        });
      }
      const data = await res.json();
      if (!res.ok) { _showMemberError(data.error || 'Error al guardar.'); return; }

      _members = await _fetchMembers();
      _renderResponsibleChips();
      _syncResponsibleChips();
      _closeMemberModal();
      _renderMembersGrid();
      toast(_editingMemberId ? 'Miembro actualizado.' : 'Miembro creado.', 'success');
    } catch (e) {
      _showMemberError('Error de red: ' + e.message);
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function _deleteMember(memberId) {
    const m = _members.find(x => x.id === memberId);
    if (!m || !confirm(`¿Eliminar a ${m.name} ${m.surname}? Esta acción no se puede deshacer.`)) return;
    try {
      const res = await fetch(`/prionpacks/api/members/${memberId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      _members = await _fetchMembers();
      _renderResponsibleChips();
      _syncResponsibleChips();
      _renderMembersGrid();
      toast('Miembro eliminado.', 'success');
    } catch (e) {
      toast('Error al eliminar: ' + e.message, 'error');
    }
  }

  function _showMemberError(msg) {
    const el = document.getElementById('pp-member-error');
    el.textContent = msg;
    el.style.display = '';
  }

  function _bindMembersEvents() {
    document.getElementById('btn-show-members')?.addEventListener('click', showMembers);
    document.getElementById('btn-members-back')?.addEventListener('click', showDashboard);
    document.getElementById('btn-add-member')?.addEventListener('click', () => _openMemberModal(null));
    document.getElementById('pp-member-modal-close')?.addEventListener('click', _closeMemberModal);
    document.getElementById('pp-member-modal-cancel')?.addEventListener('click', _closeMemberModal);
    document.getElementById('pp-member-backdrop')?.addEventListener('click', _closeMemberModal);
    document.getElementById('pp-member-modal-save')?.addEventListener('click', _saveMember);
    document.getElementById('btn-member-pwd-toggle')?.addEventListener('click', () => {
      const inp = document.getElementById('member-password');
      const icon = document.querySelector('#btn-member-pwd-toggle i');
      inp.type = inp.type === 'password' ? 'text' : 'password';
      icon.className = inp.type === 'password' ? 'fas fa-eye' : 'fas fa-eye-slash';
    });
    // Auto-derive initials from name+surname inputs
    const autoInitials = () => {
      const ini = document.getElementById('member-initials');
      if (ini && !ini.dataset.userEdited) {
        const n = document.getElementById('member-name').value.trim();
        const s = document.getElementById('member-surname').value.trim();
        ini.value = ((n[0] || '') + (s[0] || '')).toUpperCase();
      }
    };
    document.getElementById('member-name')?.addEventListener('input', autoInitials);
    document.getElementById('member-surname')?.addEventListener('input', autoInitials);
    document.getElementById('member-initials')?.addEventListener('input', function() {
      this.dataset.userEdited = this.value ? '1' : '';
    });
  }

  /* ── Editor notes button ───────────────────────────────────────────────── */

  function _updateEditorNotesBtn(pkg) {
    const btn   = document.getElementById('btn-editor-notes');
    const label = document.getElementById('editor-notes-label');
    if (!btn) return;
    if (!pkg) { btn.style.display = 'none'; return; }
    const count = (pkg.notes || []).length;
    btn.style.display = '';
    btn.classList.toggle('pp-btn-notes-has-notes', count > 0);
    label.textContent = count > 0 ? `${count} nota${count !== 1 ? 's' : ''}` : 'Notas';
  }

  /* ── Mobile sidebar ────────────────────────────────────────────────────── */

  function _openMobileSidebar() {
    const sidebar  = document.getElementById('pp-sidebar');
    const overlay  = document.getElementById('pp-mobile-overlay');
    sidebar?.classList.add('pp-sidebar-open');
    if (overlay) { overlay.style.display = 'block'; requestAnimationFrame(() => overlay.classList.add('active')); }
    document.body.style.overflow = 'hidden';
  }

  function _closeMobileSidebar() {
    const sidebar = document.getElementById('pp-sidebar');
    const overlay = document.getElementById('pp-mobile-overlay');
    sidebar?.classList.remove('pp-sidebar-open');
    overlay?.classList.remove('active');
    document.body.style.overflow = '';
    if (overlay) setTimeout(() => { if (!overlay.classList.contains('active')) overlay.style.display = ''; }, 260);
  }

  function _bindMobileEvents() {
    document.getElementById('btn-mobile-hamburger')?.addEventListener('click', _openMobileSidebar);
    document.getElementById('btn-sidebar-close')?.addEventListener('click', _closeMobileSidebar);
    document.getElementById('pp-mobile-overlay')?.addEventListener('click', _closeMobileSidebar);
    // Close sidebar when navigating to docs/members
    document.getElementById('btn-show-docs')?.addEventListener('click', _closeMobileSidebar, true);
    document.getElementById('btn-show-members')?.addEventListener('click', _closeMobileSidebar, true);
  }

  /* ── Notes helpers ──────────────────────────────────────────────────────── */

  function _notesBadgeHTML(p) {
    const count = (p.notes || []).length;
    if (count === 0) {
      // Subtle hover-reveal icon — doesn't clutter, doesn't block card clicks
      return `<button class="pp-notes-badge pp-notes-badge-empty" data-notes-id="${_esc(p.id)}" title="Añadir nota"><i class="far fa-sticky-note"></i></button>`;
    }
    const label = count === 1 ? '1 tarea pendiente' : `${count} tareas pendientes`;
    return `<button class="pp-notes-badge has-notes" data-notes-id="${_esc(p.id)}" title="${label}"><i class="fas fa-sticky-note"></i> ${count}</button>`;
  }

  function _openNotes(pkgId) {
    _notesPkgId = pkgId;
    const pkg   = _packages.find(p => p.id === pkgId);
    const backdrop = document.getElementById('pp-notes-backdrop');
    const panel    = document.getElementById('pp-notes-panel');
    document.getElementById('notes-panel-pkg-id').textContent = pkgId || '';
    _renderNotesGrid(pkg?.notes || []);
    _renderNotesColors();
    backdrop.style.display = 'block';
    panel.style.display = 'flex';
    requestAnimationFrame(() => { backdrop.classList.add('active'); panel.classList.add('active'); });
    document.getElementById('pp-notes-textarea').value = '';
    document.getElementById('pp-notes-textarea').focus();
  }

  function _closeNotes() {
    const backdrop = document.getElementById('pp-notes-backdrop');
    const panel    = document.getElementById('pp-notes-panel');
    backdrop?.classList.remove('active');
    panel?.classList.remove('active');
    if (backdrop) setTimeout(() => { backdrop.style.display = ''; }, 300);
    if (panel)    setTimeout(() => { panel.style.display = ''; }, 300);
    _stopVoice();
    _notesPkgId = null;
  }

  function _renderNotesColors() {
    const container = document.getElementById('pp-notes-colors');
    if (!container) return;
    container.innerHTML = '<span class="pp-notes-colors-label">Color:</span>' +
      NOTE_COLORS.map(c =>
        `<button class="pp-note-color-swatch${c.value === _notesColor ? ' selected' : ''}"
           style="background:${c.value}; border-color:${c.value === _notesColor ? c.text : 'transparent'};"
           data-color="${c.value}" title="${c.name}"></button>`
      ).join('');
    container.querySelectorAll('.pp-note-color-swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        _notesColor = sw.dataset.color;
        _renderNotesColors();
      });
    });
  }

  function _renderNotesGrid(notes) {
    const grid = document.getElementById('pp-notes-grid');
    if (!grid) return;
    if (!notes.length) { grid.innerHTML = ''; return; }
    const colorMap = Object.fromEntries(NOTE_COLORS.map(c => [c.value, c.text]));
    grid.innerHTML = notes.map(n => {
      const textColor = colorMap[n.color] || '#374151';
      const date = n.createdAt ? new Date(n.createdAt).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' }) : '';
      const hasImg = /<img/i.test(n.text || '');
      const preview = _esc(_htmlToText(n.text).slice(0, 140));
      const imgHint = hasImg ? ' <span style="opacity:.6;font-size:10px;">🖼</span>' : '';
      return `<div class="pp-note-card" style="background:${n.color};color:${textColor};" data-note-id="${_esc(n.id)}" title="Clic para editar">
        <div class="pp-note-card-text">${preview}${imgHint}</div>
        <div class="pp-note-card-footer">
          <span class="pp-note-card-date">${date}</span>
          <button class="pp-note-card-delete" data-note-id="${_esc(n.id)}" title="Eliminar nota"><i class="fas fa-trash-alt"></i></button>
        </div>
      </div>`;
    }).join('');
    grid.querySelectorAll('.pp-note-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('.pp-note-card-delete')) return;
        _openNoteDetail(card.dataset.noteId);
      });
    });
    grid.querySelectorAll('.pp-note-card-delete').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); _deleteNote(btn.dataset.noteId); });
    });
  }

  /* ── Note detail modal ──────────────────────────────────────────────────── */

  let _detailNoteId = null;

  // Compress a File/Blob image via Canvas → JPEG base64 (max 900px, q=0.65)
  function _compressImage(file) {
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

  // Sanitize HTML saved from contenteditable — allow only safe tags + base64 images
  function _sanitizeNoteHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const ALLOWED = new Set(['b','i','strong','em','br','p','div','span','ul','ol','li','img']);
    function walk(node) {
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
          // Strip all attributes (no style, class, event handlers)
          while (child.attributes.length) child.removeAttribute(child.attributes[0].name);
          walk(child);
        }
      });
    }
    walk(doc.body);
    return doc.body.innerHTML;
  }

  // Extract plain text from HTML (for mini card previews)
  function _htmlToText(html) {
    const d = document.createElement('div');
    d.innerHTML = html || '';
    return d.textContent || '';
  }

  function _openNoteDetail(noteId) {
    if (!_notesPkgId) return;
    const pkg  = _packages.find(p => p.id === _notesPkgId);
    const note = (pkg?.notes || []).find(n => n.id === noteId);
    if (!note) return;
    _detailNoteId = noteId;

    const backdrop = document.getElementById('pp-note-detail-backdrop');
    const modal    = document.getElementById('pp-note-detail-modal');
    const content  = document.getElementById('pp-note-detail-content');
    const dateEl   = document.getElementById('pp-note-detail-date');

    content.innerHTML = _sanitizeNoteHtml(note.text || '');
    dateEl.textContent = note.createdAt
      ? new Date(note.createdAt).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '';

    _renderNoteDetailColors(note.color);
    _applyNoteDetailBg(note.color);

    backdrop.style.display = 'block';
    modal.style.display = 'flex';
    requestAnimationFrame(() => { backdrop.classList.add('active'); modal.classList.add('active'); });
    setTimeout(() => { content.focus(); _placeCursorAtEnd(content); }, 220);
  }

  function _placeCursorAtEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function _closeNoteDetail() {
    const backdrop = document.getElementById('pp-note-detail-backdrop');
    const modal    = document.getElementById('pp-note-detail-modal');
    backdrop?.classList.remove('active');
    modal?.classList.remove('active');
    if (backdrop) setTimeout(() => { backdrop.style.display = ''; }, 220);
    if (modal)    setTimeout(() => { modal.style.display = ''; }, 220);
    _detailNoteId = null;
  }

  function _applyNoteDetailBg(color) {
    const colorEntry = NOTE_COLORS.find(c => c.value === color) || NOTE_COLORS[0];
    const header  = document.getElementById('pp-note-detail-header');
    const content = document.getElementById('pp-note-detail-content');
    const modal   = document.getElementById('pp-note-detail-modal');
    if (header)  header.style.background = color;
    if (content) { content.style.background = color; content.style.color = colorEntry.text; }
    if (modal)   modal.style.background = color;
  }

  function _renderNoteDetailColors(activeColor) {
    const container = document.getElementById('pp-note-detail-colors');
    if (!container) return;
    container.innerHTML = NOTE_COLORS.map(c =>
      `<button class="pp-note-color-swatch${c.value === activeColor ? ' selected' : ''}"
         style="background:${c.value}; border-color:${c.value === activeColor ? c.text : 'rgba(0,0,0,0.15)'};"
         data-color="${c.value}" title="${c.name}"></button>`
    ).join('');
    container.querySelectorAll('.pp-note-color-swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        _renderNoteDetailColors(sw.dataset.color);
        _applyNoteDetailBg(sw.dataset.color);
      });
    });
  }

  function _getDetailActiveColor() {
    const sel = document.querySelector('#pp-note-detail-colors .pp-note-color-swatch.selected');
    return sel?.dataset.color || NOTE_COLORS[0].value;
  }

  async function _saveNoteDetail() {
    if (!_notesPkgId || !_detailNoteId) return;
    const content = document.getElementById('pp-note-detail-content');
    const html    = _sanitizeNoteHtml(content?.innerHTML || '');
    const plain   = _htmlToText(html).trim();
    if (!plain) { toast('La nota no puede estar vacía.', 'error'); return; }
    const color = _getDetailActiveColor();
    const pkg   = _packages.find(p => p.id === _notesPkgId);
    if (!pkg) return;
    const notes = (pkg.notes || []).map(n =>
      n.id === _detailNoteId ? { ...n, text: html, color } : n
    );
    try {
      const saved = await PPStorage.update(_notesPkgId, { notes });
      const idx = _packages.findIndex(p => p.id === _notesPkgId);
      if (idx >= 0) _packages[idx] = saved;
      _renderNotesGrid(saved.notes || []);
      _renderSidebarList();
      if (state.currentId === _notesPkgId) _updateEditorNotesBtn(saved);
      _closeNoteDetail();
    } catch (e) { toast('Error guardando la nota: ' + e.message, 'error'); }
  }

  async function _handleNotePaste(e) {
    const items = Array.from(e.clipboardData?.items || []);
    const imgItem = items.find(it => it.type.startsWith('image/'));
    if (!imgItem) return; // let browser handle plain text paste
    e.preventDefault();
    const file = imgItem.getAsFile();
    if (!file) return;
    const b64 = await _compressImage(file);
    const img = document.createElement('img');
    img.src = b64;
    const sel = window.getSelection();
    if (!sel.rangeCount) {
      document.getElementById('pp-note-detail-content')?.appendChild(img);
      return;
    }
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(img);
    range.setStartAfter(img);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function _bindNoteDetailEvents() {
    document.getElementById('pp-note-detail-backdrop')?.addEventListener('click', _closeNoteDetail);
    document.getElementById('btn-note-detail-close')?.addEventListener('click', _closeNoteDetail);
    document.getElementById('btn-note-detail-save')?.addEventListener('click', _saveNoteDetail);
    document.getElementById('btn-note-detail-delete')?.addEventListener('click', () => {
      const idToDelete = _detailNoteId;
      if (idToDelete) { _closeNoteDetail(); setTimeout(() => _deleteNote(idToDelete), 230); }
    });
    const content = document.getElementById('pp-note-detail-content');
    content?.addEventListener('paste', _handleNotePaste);
    content?.addEventListener('keydown', e => {
      if (e.key === 'Escape') _closeNoteDetail();
      if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); _saveNoteDetail(); }
    });
  }

  async function _addNote() {
    if (!_notesPkgId) return;
    const textarea = document.getElementById('pp-notes-textarea');
    const text = (textarea?.value || '').trim();
    if (!text) { toast('Escribe algo antes de añadir la nota.', 'error'); return; }
    const pkg = _packages.find(p => p.id === _notesPkgId);
    if (!pkg) return;
    const newNote = { id: `n${Date.now()}`, text, color: _notesColor, createdAt: new Date().toISOString() };
    const notes = [...(pkg.notes || []), newNote];
    try {
      const saved = await PPStorage.update(_notesPkgId, { notes });
      const idx = _packages.findIndex(p => p.id === _notesPkgId);
      if (idx >= 0) _packages[idx] = saved;
      _renderNotesGrid(saved.notes || []);
      _renderSidebarList();
      if (state.currentId === _notesPkgId) _updateEditorNotesBtn(saved);
      textarea.value = '';
    } catch (e) { toast('Error guardando la nota: ' + e.message, 'error'); }
  }

  async function _deleteNote(noteId) {
    if (!_notesPkgId) return;
    const pkg = _packages.find(p => p.id === _notesPkgId);
    if (!pkg) return;
    const notes = (pkg.notes || []).filter(n => n.id !== noteId);
    try {
      const saved = await PPStorage.update(_notesPkgId, { notes });
      const idx = _packages.findIndex(p => p.id === _notesPkgId);
      if (idx >= 0) _packages[idx] = saved;
      _renderNotesGrid(saved.notes || []);
      _renderSidebarList();
      if (state.currentId === _notesPkgId) _updateEditorNotesBtn(saved);
    } catch (e) { toast('Error eliminando la nota: ' + e.message, 'error'); }
  }

  /* ── Voice input (SpeechRecognition) ───────────────────────────────────── */

  function _startVoice(textarea) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { toast('Tu navegador no soporta entrada de voz.', 'error'); return; }
    if (_micRecog) { _stopVoice(); return; }
    const mic = document.getElementById('btn-notes-mic');
    _micRecog = new SpeechRecognition();
    _micRecog.lang = 'es-ES';
    _micRecog.continuous = false;
    _micRecog.interimResults = true;
    mic?.classList.add('listening');
    let interim = '';
    _micRecog.onresult = e => {
      interim = '';
      let final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      if (final) {
        textarea.value = (textarea.value + ' ' + final).trim();
        interim = '';
      }
    };
    _micRecog.onerror = () => _stopVoice();
    _micRecog.onend   = () => _stopVoice();
    _micRecog.start();
  }

  function _stopVoice() {
    _micRecog?.stop();
    _micRecog = null;
    document.getElementById('btn-notes-mic')?.classList.remove('listening');
  }

  /* ── Notes event bindings ───────────────────────────────────────────────── */

  function _bindNotesEvents() {
    document.getElementById('btn-notes-close')?.addEventListener('click', _closeNotes);
    document.getElementById('pp-notes-backdrop')?.addEventListener('click', _closeNotes);
    document.getElementById('btn-notes-add')?.addEventListener('click', _addNote);
    document.getElementById('btn-notes-mic')?.addEventListener('click', () => {
      const ta = document.getElementById('pp-notes-textarea');
      _startVoice(ta);
    });
    document.getElementById('pp-notes-textarea')?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); _addNote(); }
    });
  }

  return {
    init, showDashboard, showEditor,
    addFinding, removeFinding,
    translateFinding, addGapItem, savePackage, deletePackage,
    toast, _recalcScore, _updateFindingGapIndicators, _scrollToGap,
    _renumberGaps, _refreshAllJumpButtons,
  };
})();

document.addEventListener('DOMContentLoaded', PrionPacks.init);
