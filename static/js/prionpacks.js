/* PrionPacks – Main application logic */

const PrionPacks = (() => {
  /* ── State ─────────────────────────────────────────────────────────────── */
  let _packages = [];
  let state = {
    currentId: null,
    view: 'dashboard',
    search: '',
    filterStatus: 'all',
    filterPriority: 'all',
  };

  let _imgUploadCallback = null; // set while image-upload modal is open

  const PRIORITY_LABELS = { high: 'High', medium: 'Medium', low: 'Low', none: 'No priority' };

  /* ── Init ──────────────────────────────────────────────────────────────── */
  async function init() {
    _bindGlobalEvents();
    _bindModalEvents();
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
    _renderDashboard();
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

  function _matchesSearch(p, q) {
    if (!q) return true;
    const missingInfo = (p.gaps?.missingInfo || []).map(g => typeof g === 'string' ? g : g.text);
    const fields = [
      p.title, p.id, p.description, p.introduction, p.discussion,
      p.coAuthors, p.affiliations, p.abstract, p.authorSummary,
      p.acknowledgments, p.funding, p.conflictsOfInterest, p.references,
      ...(p.findings || []).flatMap(f => [
        f.title, f.titleEnglish, f.description,
        ...(f.figures || []).flatMap(fig => [fig.description, fig.caption]),
        ...(f.tables  || []).map(tbl => tbl.description),
      ]),
      ...missingInfo,
    ];
    return fields.some(v => v && _norm(v).includes(q));
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
      card.addEventListener('click', () => showEditor(card.dataset.id));
    });
    grid.querySelectorAll('.pp-pkg-priority-dot').forEach(dot => {
      dot.addEventListener('click', e => { e.stopPropagation(); _cyclePriorityCard(dot); });
    });
  }

  function _pkgCardHTML(p) {
    const score = p.scores?.total ?? 0;
    const fillClass = score >= 90 ? 'pp-fill-complete' : score >= 50 ? 'pp-fill-progress' : 'pp-fill-initial';
    const date = p.lastModified ? new Date(p.lastModified).toLocaleDateString() : '—';
    const findings = (p.findings || []).length;
    const inactive = p.active === false;
    const inactiveCls = inactive ? ' pp-pkg-card-inactive' : '';
    const inactiveBadge = inactive ? '<span class="pp-inactive-badge">Inactivo</span>' : '';
    return `
    <div class="pp-pkg-card${inactiveCls}" data-id="${p.id}">
      <div class="pp-pkg-card-header">
        <div class="pp-pkg-priority-dot" data-id="${p.id}" data-priority="${p.priority}"
          style="background:${_priorityColor(p.priority)};" title="Click to change priority"></div>
        <div class="pp-pkg-card-body">
          <div class="pp-pkg-card-id">${p.id} ${inactiveBadge}</div>
          <div class="pp-pkg-card-title">${_supHtml(p.title)}</div>
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

    document.getElementById('editor-id-badge').textContent = isNew ? 'PRP-NEW' : pkg.id;
    document.getElementById('btn-delete-package').style.display = isNew ? 'none' : '';
    document.getElementById('btn-send-review').style.display    = isNew ? 'none' : '';
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
  const _DOI_RE = /\b10\.\d{4,}\/[^\s,;)>\]]+/g;

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
        <button type="button" class="pp-collapse-btn pp-collapse-btn--inline" title="Plegar / desplegar referencia"></button>
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
      ? '<i class="fas fa-expand-alt"></i> Expandir todo'
      : '<i class="fas fa-compress-alt"></i> Colapsar todo';
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
        <button type="button" class="pp-collapse-btn pp-collapse-btn--inline" title="Plegar / desplegar referencia"></button>
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
      ? '<i class="fas fa-expand-alt"></i> Expandir todo'
      : '<i class="fas fa-compress-alt"></i> Colapsar todo';
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
        <button type="button" class="pp-collapse-btn pp-collapse-btn--inline" title="Plegar / desplegar método"></button>
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
      btn.title = 'Plegar / desplegar sección';
      btn.innerHTML = '<i class="fas fa-caret-down"></i>';
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
        <button type="button" class="pp-collapse-btn pp-collapse-btn--inline pp-finding-collapse-btn" title="Plegar / desplegar finding"></button>
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
        <button type="button" class="pp-collapse-btn pp-collapse-btn--inline pp-gap-collapse-btn" title="Plegar / desplegar gap" ></button>
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
      document.getElementById('editor-id-badge').textContent = saved.id;
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

  /* ── Global events ─────────────────────────────────────────────────────── */
  function _bindGlobalEvents() {
    document.getElementById('btn-new-package').addEventListener('click', () => showEditor(null));
    document.getElementById('btn-new-package-main').addEventListener('click', () => showEditor(null));
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

    document.getElementById('pp-search').addEventListener('input', e => {
      state.search = e.target.value;
      _renderDashboard();
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
    document.getElementById('intro-references-list')?.addEventListener('click', e => {
      const aiBtn = e.target.closest('.pp-ai-btn');
      if (aiBtn && e.currentTarget.contains(aiBtn)) {
        aiBtn.classList.toggle('active');
      }
    });
    document.getElementById('btn-toggle-credit').addEventListener('click', () =>
      _toggleSection('section-credit', 'btn-toggle-credit', 'fa-list-check', 'CReDiT'));

    // Active/Inactive toggle
    document.getElementById('btn-active-toggle').addEventListener('click', () => {
      _setActiveState(!_getCurrentActive());
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

  return {
    init, showDashboard, showEditor,
    addFinding, removeFinding,
    translateFinding, addGapItem, savePackage, deletePackage,
    toast, _recalcScore, _updateFindingGapIndicators, _scrollToGap,
    _renumberGaps, _refreshAllJumpButtons,
  };
})();

document.addEventListener('DOMContentLoaded', PrionPacks.init);
