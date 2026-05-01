/* PrionPacks – Main application logic */

const PrionPacks = (() => {
  /* ── State ─────────────────────────────────────────────────────────────── */
  let _packages = [];   // in-memory cache from server
  let state = {
    currentId: null,
    view: 'dashboard',
    search: '',
    filterStatus: 'all',
    filterPriority: 'all',
  };

  const PRIORITY_LABELS = { high: 'High', medium: 'Medium', low: 'Low', none: 'No priority' };

  /* ── Init ──────────────────────────────────────────────────────────────── */
  async function init() {
    _bindGlobalEvents();
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
  }

  /* ── Dashboard ─────────────────────────────────────────────────────────── */
  function _renderDashboard() {
    const filtered = _filteredPackages();
    _renderMetrics();
    _renderPackageCards(filtered);
    _renderSidebarList();
  }

  function _matchesSearch(p, q) {
    if (!q) return true;
    const fields = [
      p.title, p.id, p.description, p.hypothesis,
      ...(p.findings || []).flatMap(f => [f.title, f.titleEnglish, f.description, ...(f.figures || []).map(fig => fig.description)]),
      ...(p.gaps?.missingInfo || []),
      ...(p.gaps?.neededExperiments || []),
    ];
    return fields.some(v => v && String(v).toLowerCase().includes(q));
  }

  function _filteredPackages() {
    const q = state.search.toLowerCase();
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
    return `
    <div class="pp-pkg-card" data-id="${p.id}">
      <div class="pp-pkg-card-header">
        <div class="pp-pkg-priority-dot" data-id="${p.id}" data-priority="${p.priority}"
          style="background:${_priorityColor(p.priority)};" title="Click to change priority"></div>
        <div class="pp-pkg-card-body">
          <div class="pp-pkg-card-id">${p.id}</div>
          <div class="pp-pkg-card-title">${_esc(p.title)}</div>
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
      return `
      <div class="pp-package-item${active}" data-id="${p.id}">
        <div class="pp-package-item-dot" style="background:${_priorityColor(p.priority)};"></div>
        <div class="pp-package-item-body">
          <div class="pp-package-item-title">${_esc(p.title)}</div>
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
  function _populateEditor(pkg) {
    const isNew = !pkg;
    document.getElementById('editor-id-badge').textContent = isNew ? 'PRP-NEW' : pkg.id;
    document.getElementById('btn-delete-package').style.display = isNew ? 'none' : '';
    document.getElementById('meta-id').textContent = isNew ? '—' : pkg.id;
    document.getElementById('meta-created').textContent = isNew ? '—' : _fmtDate(pkg.createdAt);
    document.getElementById('meta-modified').textContent = isNew ? '—' : _fmtDate(pkg.lastModified);

    const titleEl = document.getElementById('field-title');
    titleEl.value = pkg?.title || '';
    _autoResize(titleEl);

    document.getElementById('field-description').value = pkg?.description || '';
    document.getElementById('field-hypothesis').value = pkg?.hypothesis || '';

    _setPriority(pkg?.priority || 'none');
    _renderFindings(pkg?.findings || []);
    _renderGapList('missing', pkg?.gaps?.missingInfo || []);
    _renderGapList('experiments', pkg?.gaps?.neededExperiments || []);
    _updateScore(pkg?.scores || { hypothesis: 0, findings: 0, figures: 0, gaps: 0, total: 0 });
    _recalcScore();
  }

  function _autoResize(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
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
    if (!findings.length) { empty.style.display = 'flex'; return; }
    empty.style.display = 'none';
    findings.forEach((f, i) => container.appendChild(_createFindingBlock(f, i + 1)));
    _initDragDrop(container);
  }

  function _createFindingBlock(finding, num) {
    const div = document.createElement('div');
    div.className = 'pp-finding-block';
    div.dataset.id = finding.id;
    div.draggable = true;
    const enBadge = finding.titleEnglish
      ? `<div class="pp-finding-en-badge">EN: ${_esc(finding.titleEnglish)}</div>` : '';
    div.innerHTML = `
      <div class="pp-finding-header">
        <i class="fas fa-grip-vertical pp-drag-handle"></i>
        <span class="pp-finding-number">F-${String(num).padStart(2,'0')}</span>
        <input type="text" class="pp-finding-title-input" placeholder="Finding title…" value="${_esc(finding.title||'')}" />
        <button class="pp-btn-icon btn-claude" title="Translate with Claude" onclick="PrionPacks.translateFinding(this)">
          <i class="fas fa-robot"></i>
        </button>
        <button class="pp-btn-icon btn-remove" title="Remove finding" onclick="PrionPacks.removeFinding(this)">
          <i class="fas fa-trash"></i>
        </button>
      </div>
      ${enBadge}
      <div class="pp-finding-content">
        <textarea class="pp-textarea" rows="3" placeholder="Describe the main result…">${_esc(finding.description||'')}</textarea>
        <div class="pp-figures-section">
          <div class="pp-figures-label">Associated Figures</div>
          <div class="pp-figures-list">${(finding.figures||[]).map((f,i)=>_figureRowHTML(f,i+1)).join('')}</div>
          <button class="pp-btn pp-btn-ghost pp-btn-sm" onclick="PrionPacks.addFigure(this)">
            <i class="fas fa-plus"></i> Add Figure
          </button>
        </div>
      </div>`;
    div.querySelector('.pp-finding-title-input').addEventListener('input', _recalcScore);
    div.querySelector('.pp-textarea').addEventListener('input', _recalcScore);
    return div;
  }

  function _figureRowHTML(fig, num) {
    return `<div class="pp-figure-row">
      <span class="pp-figure-num">Fig ${num}</span>
      <input type="text" class="pp-figure-input" placeholder="Figure description…" value="${_esc(fig.description||'')}" />
      <button class="pp-btn-icon btn-remove" onclick="PrionPacks.removeFigure(this)"><i class="fas fa-times"></i></button>
    </div>`;
  }

  function addFinding() {
    const container = document.getElementById('findings-container');
    const num = container.querySelectorAll('.pp-finding-block').length + 1;
    const block = _createFindingBlock({id:'f'+Date.now(),title:'',titleEnglish:'',description:'',figures:[]}, num);
    container.appendChild(block);
    document.getElementById('findings-empty').style.display = 'none';
    block.querySelector('.pp-finding-title-input').focus();
    _initDragDrop(container);
    _recalcScore();
  }

  function removeFinding(btn) {
    btn.closest('.pp-finding-block').remove();
    _renumberFindings();
    _recalcScore();
  }

  function _renumberFindings() {
    document.querySelectorAll('.pp-finding-number').forEach((el, i) => {
      el.textContent = 'F-' + String(i+1).padStart(2,'0');
    });
  }

  function addFigure(btn) {
    const list = btn.previousElementSibling;
    const num = list.querySelectorAll('.pp-figure-row').length + 1;
    const tmp = document.createElement('div');
    tmp.innerHTML = _figureRowHTML({description:''}, num);
    list.appendChild(tmp.firstElementChild);
    list.querySelectorAll('.pp-figure-row').forEach((r,i) => {
      r.querySelector('.pp-figure-num').textContent = 'Fig '+(i+1);
    });
    _recalcScore();
  }

  function removeFigure(btn) {
    const row = btn.closest('.pp-figure-row');
    const list = row.closest('.pp-figures-list');
    row.remove();
    list.querySelectorAll('.pp-figure-row').forEach((r,i) => {
      r.querySelector('.pp-figure-num').textContent = 'Fig '+(i+1);
    });
    _recalcScore();
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
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'pp-finding-en-badge';
        block.querySelector('.pp-finding-header').insertAdjacentElement('afterend', badge);
      }
      badge.textContent = 'EN: ' + translated;
      toast('Translation complete!', 'success');
    } catch (e) {
      toast('Translation error: ' + e.message, 'error');
    } finally {
      btn.classList.remove('loading');
      btn.querySelector('i').className = 'fas fa-robot';
    }
  }

  /* ── Gap lists ─────────────────────────────────────────────────────────── */
  function _renderGapList(type, items) {
    const id = type === 'missing' ? 'gaps-missing-list' : 'gaps-experiments-list';
    const list = document.getElementById(id);
    list.innerHTML = items.map(_gapItemHTML).join('');
    list.querySelectorAll('input').forEach(inp => inp.addEventListener('input', _recalcScore));
  }

  function _gapItemHTML(value) {
    return `<div class="pp-dynamic-item">
      <input type="text" value="${_esc(value)}" placeholder="Add item…" />
      <button class="pp-btn-icon btn-remove" onclick="this.closest('.pp-dynamic-item').remove();PrionPacks._recalcScore();">
        <i class="fas fa-times"></i>
      </button>
    </div>`;
  }

  function addGapItem(type) {
    const id = type === 'missing' ? 'gaps-missing-list' : 'gaps-experiments-list';
    const list = document.getElementById(id);
    const tmp = document.createElement('div');
    tmp.innerHTML = _gapItemHTML('');
    const item = tmp.firstElementChild;
    list.appendChild(item);
    item.querySelector('input').focus();
    item.querySelector('input').addEventListener('input', _recalcScore);
    _recalcScore();
  }

  /* ── Scoring ───────────────────────────────────────────────────────────── */
  function _recalcScore() {
    const hypothesis = (document.getElementById('field-hypothesis')?.value || '').trim();
    const findings = document.querySelectorAll('.pp-finding-block');

    let hScore = Math.min(100, hypothesis.length > 20 ? Math.round(hypothesis.length / 3) : hypothesis.length * 5);
    let fScore = 0, figScore = 0, totalFigs = 0, filledFigs = 0;

    findings.forEach(block => {
      const title = block.querySelector('.pp-finding-title-input')?.value.trim() || '';
      const desc  = block.querySelector('.pp-textarea')?.value.trim() || '';
      fScore += (title ? 40 : 0) + (desc.length > 30 ? 60 : 0);
      block.querySelectorAll('.pp-figure-input').forEach(inp => {
        totalFigs++;
        if (inp.value.trim().length > 5) filledFigs++;
      });
    });

    if (findings.length) fScore = Math.round(fScore / findings.length);
    if (totalFigs) figScore = Math.round((filledFigs / totalFigs) * 100);
    else if (findings.length) figScore = 20;

    const gapCount = document.querySelectorAll('#gaps-missing-list .pp-dynamic-item, #gaps-experiments-list .pp-dynamic-item').length;
    const gapScore = gapCount > 5 ? Math.max(20, 100 - (gapCount - 5) * 10) : 100;

    const total = Math.round(hScore * .20 + fScore * .50 + figScore * .20 + gapScore * .10);
    _updateScore({ hypothesis: hScore, findings: fScore, figures: figScore, gaps: gapScore, total });
    document.getElementById('meta-findings-count').textContent = findings.length;
  }

  function _updateScore(scores) {
    const { hypothesis, findings, figures, gaps, total } = scores;
    document.getElementById('score-pct').textContent = total + '%';
    const fill = document.getElementById('score-circle-fill');
    fill.style.strokeDashoffset = 251.2 - (total / 100) * 251.2;
    fill.style.stroke = total >= 90 ? '#26de81' : total >= 70 ? '#ffa502' : '#00d4aa';
    _setBar('hypothesis', hypothesis);
    _setBar('findings', findings);
    _setBar('figures', figures);
    _setBar('gaps', gaps);
    let rec;
    if (total < 50)      rec = 'Initial phase — keep developing your main findings.';
    else if (total < 70) rec = 'Good progress — focus on completing figures and reducing gaps.';
    else if (total < 90) rec = 'Almost ready — consider starting the manuscript draft.';
    else                  rec = '🎉 Ready for manuscript! Excellent work.';
    document.getElementById('score-rec-text').textContent = rec;
  }

  function _setBar(key, value) {
    const b = document.getElementById('score-bar-' + key);
    const v = document.getElementById('score-val-' + key);
    if (b) b.style.width = value + '%';
    if (v) v.textContent = value + '%';
  }

  /* ── Save ──────────────────────────────────────────────────────────────── */
  async function savePackage() {
    const title = (document.getElementById('field-title').value || '').trim();
    if (!title) { toast('Please enter a title.', 'error'); document.getElementById('field-title').focus(); return; }

    const btn = document.getElementById('btn-save-package');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…';

    const data = {
      title,
      description: document.getElementById('field-description').value.trim(),
      priority: _getCurrentPriority(),
      hypothesis: document.getElementById('field-hypothesis').value.trim(),
      findings: _collectFindings(),
      gaps: {
        missingInfo: _collectGapList('gaps-missing-list'),
        neededExperiments: _collectGapList('gaps-experiments-list'),
      },
      scores: _collectScores(),
    };

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
      btn.innerHTML = '<i class="fas fa-save"></i> Save';
    }
  }

  function _collectFindings() {
    return Array.from(document.querySelectorAll('.pp-finding-block')).map(block => {
      const badge = block.querySelector('.pp-finding-en-badge');
      return {
        id: block.dataset.id || ('f' + Date.now()),
        title: block.querySelector('.pp-finding-title-input')?.value.trim() || '',
        titleEnglish: badge ? badge.textContent.replace(/^EN:\s*/, '') : '',
        description: block.querySelector('.pp-textarea')?.value.trim() || '',
        figures: Array.from(block.querySelectorAll('.pp-figure-input')).map((inp, i) => ({
          id: 'fig' + (i + 1), description: inp.value.trim(),
        })),
      };
    });
  }

  function _collectGapList(listId) {
    return Array.from(document.querySelectorAll('#' + listId + ' input'))
      .map(i => i.value.trim()).filter(Boolean);
  }

  function _collectScores() {
    return {
      hypothesis: _readPct('score-val-hypothesis'),
      findings:   _readPct('score-val-findings'),
      figures:    _readPct('score-val-figures'),
      gaps:       _readPct('score-val-gaps'),
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
  function _initDragDrop(container) {
    let dragging = null;
    container.querySelectorAll('.pp-finding-block').forEach(block => {
      block.addEventListener('dragstart', e => {
        dragging = block; block.style.opacity = '.4'; e.dataTransfer.effectAllowed = 'move';
      });
      block.addEventListener('dragend', () => {
        dragging = null; block.style.opacity = '';
        container.querySelectorAll('.pp-finding-block').forEach(b => b.classList.remove('drag-over'));
        _renumberFindings(); _recalcScore();
      });
      block.addEventListener('dragover', e => {
        e.preventDefault();
        if (!dragging || dragging === block) return;
        const mid = block.getBoundingClientRect().top + block.getBoundingClientRect().height / 2;
        if (e.clientY < mid) container.insertBefore(dragging, block);
        else block.insertAdjacentElement('afterend', dragging);
        container.querySelectorAll('.pp-finding-block').forEach(b => b.classList.remove('drag-over'));
        block.classList.add('drag-over');
      });
      block.addEventListener('dragleave', () => block.classList.remove('drag-over'));
      block.addEventListener('drop', e => { e.preventDefault(); block.classList.remove('drag-over'); });
    });
  }

  /* ── Events ────────────────────────────────────────────────────────────── */
  function _bindGlobalEvents() {
    document.getElementById('btn-new-package').addEventListener('click', () => showEditor(null));
    document.getElementById('btn-new-package-main').addEventListener('click', () => showEditor(null));
    document.getElementById('btn-first-package')?.addEventListener('click', () => showEditor(null));
    document.getElementById('btn-back-dashboard').addEventListener('click', showDashboard);
    document.getElementById('btn-save-package').addEventListener('click', savePackage);
    document.getElementById('btn-delete-package').addEventListener('click', deletePackage);

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

    // Metric cards as filter buttons
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

    document.querySelectorAll('.pp-priority-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.pp-priority-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    const titleEl = document.getElementById('field-title');
    titleEl.addEventListener('input', e => { _autoResize(e.target); });
    document.getElementById('field-hypothesis').addEventListener('input', _recalcScore);

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
    addFinding, removeFinding, addFigure, removeFigure,
    translateFinding, addGapItem, savePackage, deletePackage,
    toast, _recalcScore,
  };
})();

document.addEventListener('DOMContentLoaded', PrionPacks.init);
