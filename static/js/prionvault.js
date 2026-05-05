/* PrionVault — frontend (Phase 1)
 *
 * Reads:
 *   GET /prionvault/api/articles      (list + filters + full-text q)
 *   GET /prionvault/api/articles/:id  (detail)
 *   GET /prionvault/api/articles/stats
 *   GET /prionvault/api/tags
 *
 * Writes (admin only — UI hides controls; backend enforces):
 *   POST   /prionvault/api/tags
 *   PUT    /prionvault/api/articles/:aid/tags/:tag_id
 *   DELETE /prionvault/api/articles/:aid/tags/:tag_id
 *   PATCH  /prionvault/api/articles/:aid
 *   DELETE /prionvault/api/articles/:aid
 *   POST   /prionvault/api/articles/:aid/annotations
 *   DELETE /prionvault/api/annotations/:id
 *
 * The semantic-search button is wired but currently calls a 501 stub
 * — the UI gracefully degrades to "coming soon" when that happens.
 */
(() => {
  const API = '/prionvault/api';

  const ROLE = (document.querySelector('meta[name="pv-user-role"]')?.content || '').trim();
  const USER_ID = (document.querySelector('meta[name="pv-user-id"]')?.content || '').trim();
  const IS_ADMIN = ROLE === 'admin';
  document.body.classList.toggle('pv-role-admin',  IS_ADMIN);
  document.body.classList.toggle('pv-role-reader', !IS_ADMIN);

  const state = {
    q: '',
    sort: 'added_desc',
    yearMin: null,
    yearMax: null,
    journal: '',
    tagId: null,
    hasSummary: null,    // 'ai' | 'human' | 'none' | null
    page: 1,
    size: 25,
  };

  // ── helpers ────────────────────────────────────────────────────────────
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                                  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const supHtml = s => esc(s).replace(/\^(\S[^\^\n]*?)\^/g, '<sup>$1</sup>');

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err.error || ('HTTP ' + res.status);
      const e = new Error(msg);
      e.status = res.status;
      throw e;
    }
    return res.json();
  }

  // ── render: stats ──────────────────────────────────────────────────────
  async function refreshStats() {
    try {
      const s = await api('/articles/stats');
      const set = (id, n) => {
        const el = document.getElementById(id);
        if (el) el.textContent = String(n);
      };
      set('count-total',      s.total);
      set('count-no-summary', s.total - s.with_summary_ai);
      set('count-indexed',    s.indexed);
    } catch (e) { console.error(e); }
  }

  // ── render: tags ───────────────────────────────────────────────────────
  async function refreshTags() {
    try {
      const tags = await api('/tags');
      const container = document.getElementById('tag-list');
      container.innerHTML = '';
      tags.forEach(t => {
        const btn = document.createElement('button');
        btn.className = 'pv-nav-btn';
        btn.dataset.tagId = t.id;
        btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;">
          <span style="width:8px;height:8px;border-radius:50%;background:${esc(t.color || '#9ca3af')}"></span>
          ${esc(t.name)}
        </span><span class="pv-count">${t.count}</span>`;
        btn.addEventListener('click', () => {
          state.tagId = state.tagId === t.id ? null : t.id;
          state.page = 1;
          loadArticles();
          highlightActiveTag();
        });
        container.appendChild(btn);
      });
      highlightActiveTag();
    } catch (e) { console.error(e); }
  }

  function highlightActiveTag() {
    document.querySelectorAll('#tag-list .pv-nav-btn').forEach(b => {
      const isActive = String(b.dataset.tagId) === String(state.tagId);
      b.style.background = isActive ? 'var(--pv-accent-bg)' : '';
      b.style.color      = isActive ? 'var(--pv-accent)' : '';
    });
  }

  // ── render: article list ───────────────────────────────────────────────
  async function loadArticles() {
    const params = new URLSearchParams();
    if (state.q)        params.set('q', state.q);
    if (state.sort)     params.set('sort', state.sort);
    if (state.yearMin)  params.set('year_min', state.yearMin);
    if (state.yearMax)  params.set('year_max', state.yearMax);
    if (state.journal)  params.set('journal', state.journal);
    if (state.tagId)    params.set('tag', state.tagId);
    if (state.hasSummary) params.set('has_summary', state.hasSummary);
    params.set('page',  state.page);
    params.set('size',  state.size);

    const grid = document.getElementById('pv-results-grid');
    grid.innerHTML = '<div class="pv-empty">Loading…</div>';

    try {
      const r = await api('/articles?' + params.toString());
      document.getElementById('pv-result-count').textContent =
        r.total + ' result' + (r.total === 1 ? '' : 's');
      document.getElementById('pv-result-page').textContent =
        'page ' + r.page + ' / ' + Math.max(1, Math.ceil(r.total / r.size));

      if (r.items.length === 0) {
        grid.innerHTML = '<div class="pv-empty">No articles match these filters.</div>';
        renderPagination(r);
        return;
      }
      grid.innerHTML = '';
      r.items.forEach(a => grid.appendChild(renderCard(a)));
      renderPagination(r);
    } catch (e) {
      grid.innerHTML = '<div class="pv-empty">Error: ' + esc(e.message) + '</div>';
    }
  }

  function renderCard(a) {
    const card = document.createElement('article');
    card.className = 'pv-card';
    const tags = (a.tags || []).slice(0, 5).map(t =>
      `<span class="pv-tag-chip" style="${t.color ? `background:${esc(t.color)}22;color:${esc(t.color)}` : ''}">${esc(t.name)}</span>`
    ).join('');
    const flagIndexed = a.indexed_at ? '<span class="pv-card-flag indexed">indexed</span>' : '';
    const flagSummary = a.has_summary_ai ? '<span class="pv-card-flag" style="background:#dbeafe;color:#1d4ed8">AI ✓</span>' : '';

    card.innerHTML = `
      <div class="pv-card-title">${supHtml(a.title || '(no title)')}</div>
      <div class="pv-card-meta">
        ${a.authors ? esc(a.authors).slice(0, 100) : '—'}
        ${a.journal ? '<span class="pv-card-meta-sep">·</span>' + esc(a.journal) : ''}
        ${a.year ? '<span class="pv-card-meta-sep">·</span>' + a.year : ''}
        ${a.doi ? '<span class="pv-card-meta-sep">·</span><span title="' + esc(a.doi) + '">DOI</span>' : ''}
      </div>
      <div class="pv-card-flags" style="display:flex;gap:6px;align-items:center">
        ${flagSummary} ${flagIndexed}
        <button class="pv-prionread-btn ${a.in_prionread ? 'active' : ''}"
                data-aid="${esc(a.id)}"
                data-in="${a.in_prionread ? '1' : '0'}"
                data-count="${a.prionread_count || 0}"
                title="${a.in_prionread ? 'En PrionRead (clic para quitar)' : 'Enviar a PrionRead'}">📚</button>
      </div>
      ${a.tags && a.tags.length ? `<div class="pv-card-tags">${tags}</div>` : ''}
    `;
    card.querySelector('.pv-prionread-btn').addEventListener('click', e => {
      e.stopPropagation();
      togglePrionRead(e.currentTarget, a.id);
    });
    card.addEventListener('click', () => openDetail(a.id));
    return card;
  }

  async function togglePrionRead(btn, aid) {
    const inPrionRead = btn.dataset.in === '1';
    if (inPrionRead) {
      const count = parseInt(btn.dataset.count || '0', 10);
      const who = count > 1 ? `${count} usuarios` : count === 1 ? '1 usuario' : 'ningún usuario';
      if (!confirm(`Este artículo está asignado a ${who} en PrionRead.\n¿Quitar para todos?`)) return;
    } else {
      if (!confirm('¿Deseas enviar este artículo a PrionRead?')) return;
    }
    btn.disabled = true;
    try {
      const method = inPrionRead ? 'DELETE' : 'POST';
      const r = await fetch(`/prionvault/api/articles/${aid}/send-to-prionread`, { method });
      const data = await r.json();
      if (data.ok) {
        btn.dataset.in = data.in_prionread ? '1' : '0';
        btn.classList.toggle('active', data.in_prionread);
        btn.title = data.in_prionread ? 'En PrionRead (clic para quitar)' : 'Enviar a PrionRead';
      }
    } catch (e) {
      console.error('togglePrionRead failed', e);
    } finally {
      btn.disabled = false;
    }
  }

  function renderPagination({ total, page, size }) {
    const pages = Math.max(1, Math.ceil(total / size));
    const wrap = document.getElementById('pv-pagination');
    wrap.innerHTML = '';
    if (pages <= 1) return;
    const mk = (label, p, current = false, disabled = false) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (current) b.classList.add('is-current');
      if (disabled) b.disabled = true;
      b.addEventListener('click', () => { state.page = p; loadArticles(); });
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

  // ── article detail modal ───────────────────────────────────────────────
  async function openDetail(aid) {
    const modal = document.getElementById('pv-detail-modal');
    const content = document.getElementById('pv-detail-content');
    modal.style.display = '';
    content.innerHTML = '<div class="pv-empty">Loading…</div>';
    try {
      const a = await api('/articles/' + aid);
      content.innerHTML = `
        <h2 style="margin-top:0">${supHtml(a.title)}</h2>
        <div class="pv-card-meta" style="margin-bottom:14px">
          ${a.authors ? esc(a.authors) : '—'}
          ${a.journal ? '<span class="pv-card-meta-sep">·</span>' + esc(a.journal) : ''}
          ${a.year ? '<span class="pv-card-meta-sep">·</span>' + a.year : ''}
          ${a.doi ? '<span class="pv-card-meta-sep">·</span><a href="https://doi.org/' + esc(a.doi) + '" target="_blank">' + esc(a.doi) + '</a>' : ''}
        </div>
        ${a.abstract ? `<h3>Abstract</h3><p>${supHtml(a.abstract)}</p>` : ''}
        ${a.summary_ai ? `<h3>AI summary</h3><p>${supHtml(a.summary_ai)}</p>` : ''}
        ${a.summary_human ? `<h3>Human notes</h3><p>${supHtml(a.summary_human)}</p>` : ''}
        ${(a.tags && a.tags.length) ? `<div class="pv-card-tags" style="margin-top:14px">${
          a.tags.map(t => `<span class="pv-tag-chip">${esc(t.name)}</span>`).join('')
        }</div>` : ''}
        <div style="margin-top:20px;font-size:11px;color:var(--pv-text-dim);font-family:'JetBrains Mono',monospace">
          Added: ${a.added_at ? esc(a.added_at.slice(0,10)) : '—'}
          · Status: ${esc(a.extraction_status || 'pending')}
          ${a.indexed_at ? ' · Indexed: ' + esc(a.indexed_at.slice(0,10)) : ''}
        </div>
      `;
    } catch (e) {
      content.innerHTML = '<div class="pv-empty">Error: ' + esc(e.message) + '</div>';
    }
  }

  function closeDetail() {
    document.getElementById('pv-detail-modal').style.display = 'none';
  }

  // ── wiring ─────────────────────────────────────────────────────────────
  function init() {
    const debounce = (fn, ms) => {
      let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    };
    const onSearch = debounce(() => { state.page = 1; loadArticles(); }, 200);

    document.getElementById('pv-search-input').addEventListener('input', e => {
      state.q = e.target.value.trim();
      onSearch();
    });
    document.getElementById('btn-search-mode').addEventListener('click', () => {
      // Stub for Phase 5 — currently just opens an info toast.
      alert('AI semantic search arrives in Phase 5 (vector embeddings).');
    });
    document.getElementById('filter-year-min').addEventListener('change', e => {
      state.yearMin = parseInt(e.target.value, 10) || null; state.page = 1; loadArticles();
    });
    document.getElementById('filter-year-max').addEventListener('change', e => {
      state.yearMax = parseInt(e.target.value, 10) || null; state.page = 1; loadArticles();
    });
    document.getElementById('filter-journal').addEventListener('input', debounce(e => {
      state.journal = e.target.value.trim(); state.page = 1; loadArticles();
    }, 250));
    document.getElementById('filter-sort').addEventListener('change', e => {
      state.sort = e.target.value; state.page = 1; loadArticles();
    });

    document.querySelectorAll('.pv-sidebar-nav .pv-nav-btn[data-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        const f = btn.dataset.filter;
        state.tagId = null;
        state.hasSummary = (f === 'no-summary') ? 'none' : null;
        state.sort = (f === 'recent') ? 'added_desc' : state.sort;
        state.page = 1;
        loadArticles();
      });
    });

    document.getElementById('pv-detail-close').addEventListener('click', closeDetail);
    document.querySelector('#pv-detail-modal .pv-modal-backdrop')
      .addEventListener('click', closeDetail);

    // ── Admin: Import + Queue modals ───────────────────────────────────
    if (IS_ADMIN) {
      wireImport();
      wireQueue();
    }

    refreshStats();
    refreshTags();
    loadArticles();
  }

  // ── Import modal (admin only) ────────────────────────────────────────
  let _importPolling = null;
  function wireImport() {
    const btn       = document.getElementById('btn-import-pdfs');
    const modal     = document.getElementById('pv-import-modal');
    const closeBtn  = document.getElementById('pv-import-close');
    const dropzone  = document.getElementById('pv-dropzone');
    const fileInput = document.getElementById('pv-file-input');
    const fileInputPlain = document.getElementById('pv-file-input-plain');
    const pickFiles  = document.getElementById('pv-pick-files');
    const pickFolder = document.getElementById('pv-pick-folder');
    const progress   = document.getElementById('pv-import-progress');
    if (!btn || !modal) return;

    const open  = () => { modal.style.display = ''; startProgressPolling(); };
    const close = () => { modal.style.display = 'none'; stopProgressPolling(); };
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    pickFiles.addEventListener('click',  () => fileInputPlain.click());
    pickFolder.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change',      e => uploadFiles(e.target.files));
    fileInputPlain.addEventListener('change', e => uploadFiles(e.target.files));

    // Drag-and-drop
    ['dragenter', 'dragover'].forEach(ev =>
      dropzone.addEventListener(ev, e => {
        e.preventDefault(); e.stopPropagation();
        dropzone.classList.add('is-drag');
      })
    );
    ['dragleave', 'drop'].forEach(ev =>
      dropzone.addEventListener(ev, e => {
        e.preventDefault(); e.stopPropagation();
        dropzone.classList.remove('is-drag');
      })
    );
    dropzone.addEventListener('drop', async e => {
      const files = await collectFilesFromDataTransfer(e.dataTransfer);
      if (files.length) uploadFiles(files);
    });
  }

  // Walk the dropped DataTransfer (which may include folders) and return
  // a flat list of File objects whose names end in .pdf.
  async function collectFilesFromDataTransfer(dt) {
    const out = [];
    if (!dt || !dt.items) {
      Array.from(dt.files || []).forEach(f => {
        if (f.name.toLowerCase().endsWith('.pdf')) out.push(f);
      });
      return out;
    }
    const entries = Array.from(dt.items).map(it => it.webkitGetAsEntry?.()).filter(Boolean);
    const walk = async entry => {
      if (entry.isFile) {
        await new Promise(res => entry.file(f => {
          if (f.name.toLowerCase().endsWith('.pdf')) out.push(f);
          res();
        }));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const children = await new Promise(res => reader.readEntries(res));
        for (const c of children) await walk(c);
      }
    };
    for (const e of entries) await walk(e);
    return out;
  }

  async function uploadFiles(files) {
    const arr = Array.from(files || []).filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (!arr.length) return;
    const progress = document.getElementById('pv-import-progress');
    progress.style.display = '';
    progress.innerHTML = '';
    appendProgress(`Queueing ${arr.length} PDF${arr.length === 1 ? '' : 's'}…`, 'info');

    // Send in batches of 25 to avoid hitting upload limits.
    const BATCH = 25;
    let queued = 0;
    for (let i = 0; i < arr.length; i += BATCH) {
      const batch = arr.slice(i, i + BATCH);
      const fd = new FormData();
      batch.forEach(f => fd.append('file', f, f.name));
      try {
        const r = await fetch('/prionvault/api/ingest/upload', {
          method: 'POST',
          credentials: 'same-origin',
          body: fd,
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          appendProgress(`Batch ${i/BATCH+1}: ${err.error || r.status}`, 'error');
          continue;
        }
        const j = await r.json();
        queued += j.queued || 0;
        appendProgress(`Batch ${i/BATCH+1}: ${j.queued} queued.`, 'ok');
      } catch (e) {
        appendProgress(`Batch ${i/BATCH+1}: ${e.message}`, 'error');
      }
    }
    appendProgress(`Total queued: ${queued} / ${arr.length}.`, 'info');
    refreshStats();
  }

  function appendProgress(text, kind) {
    const progress = document.getElementById('pv-import-progress');
    if (!progress) return;
    const row = document.createElement('div');
    row.className = 'pv-row';
    const colour = kind === 'error' ? '#b91c1c' : kind === 'ok' ? '#15803d' : '';
    row.innerHTML = `<span style="color:${colour}">●</span> <b>${new Date().toLocaleTimeString()}</b> ${escapeHtml(text)}`;
    progress.appendChild(row);
    progress.scrollTop = progress.scrollHeight;
  }

  function startProgressPolling() {
    stopProgressPolling();
    const tick = async () => {
      try {
        const r = await fetch('/prionvault/api/ingest/status?recent=50', { credentials: 'same-origin' });
        if (!r.ok) return;
        const s = await r.json();
        appendProgress(
          `queued: ${s.queued} · processing: ${s.processing} · done: ${s.done} ` +
          `· duplicate: ${s.duplicate} · failed: ${s.failed}`, 'info');
        if (s.queued + s.processing === 0) {
          stopProgressPolling();
          _showImportSummary(s.recent || []);
        }
      } catch (e) { /* ignore transient */ }
    };
    _importPolling = setInterval(tick, 4000);
  }

  function _showImportSummary(jobs) {
    if (!jobs.length) return;
    appendProgress('── Resumen por fichero ──', 'info');
    jobs.forEach(j => {
      const fname = j.pdf_filename || '(sin nombre)';
      const step  = j.step || '';
      let kind = 'ok', label = '';
      if (j.status === 'done') {
        const doi   = step.match(/doi=([^\s|]+)/)?.[1];
        const pmid  = step.match(/pmid=([^\s|]+)/)?.[1];
        const path  = step.match(/\| (\/[^\s]+)/)?.[1];
        const id    = doi ? `DOI: ${doi}` : pmid ? `PMID: ${pmid}` : '';
        const folder = path ? path.split('/').slice(0, -1).join('/') : '';
        label = `✓ ${fname} → ${id}${folder ? ' → ' + folder : ''}`;
      } else if (j.status === 'duplicate') {
        const by = step.match(/by ([^\s|]+)/)?.[1] || '';
        label = `⟳ ${fname} — duplicado (${by})`;
        kind = 'info';
      } else if (j.status === 'failed') {
        label = `✗ ${fname} — error: ${j.error || step}`;
        kind = 'error';
      } else {
        label = `${fname} — ${j.status}`;
      }
      appendProgress(label, kind);
    });
  }
  function stopProgressPolling() {
    if (_importPolling) { clearInterval(_importPolling); _importPolling = null; }
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Queue panel ──────────────────────────────────────────────────────
  let _queuePolling = null;
  function wireQueue() {
    const btn      = document.getElementById('btn-manage-queue');
    const modal    = document.getElementById('pv-queue-modal');
    const closeBtn = document.getElementById('pv-queue-close');
    if (!btn || !modal) return;

    btn.addEventListener('click', () => {
      modal.style.display = '';
      refreshQueue();
      _queuePolling = setInterval(refreshQueue, 4000);
    });
    const close = () => {
      modal.style.display = 'none';
      if (_queuePolling) { clearInterval(_queuePolling); _queuePolling = null; }
    };
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);
  }

  async function refreshQueue() {
    try {
      const r = await fetch('/prionvault/api/ingest/status?recent=80', { credentials: 'same-origin' });
      if (!r.ok) return;
      const s = await r.json();
      const counts = document.getElementById('pv-queue-counts');
      counts.innerHTML = `
        <span>queued: <b>${s.queued}</b></span>
        <span class="pv-pill-proc">processing: <b>${s.processing}</b></span>
        <span class="pv-pill-done">done: <b>${s.done}</b></span>
        <span class="pv-pill-dup">duplicate: <b>${s.duplicate}</b></span>
        <span class="pv-pill-fail">failed: <b>${s.failed}</b></span>
      `;
      const tbody = document.getElementById('pv-queue-rows');
      tbody.innerHTML = '';
      s.recent.forEach(j => tbody.appendChild(renderJobRow(j)));
    } catch (e) { /* ignore */ }
  }

  function renderJobRow(j) {
    const tr = document.createElement('tr');
    const showRetry = (j.status === 'failed' || j.status === 'duplicate');
    tr.innerHTML = `
      <td>${j.id}</td>
      <td title="${escapeHtml(j.pdf_filename || '')}">${escapeHtml((j.pdf_filename || '').slice(0, 60))}</td>
      <td class="pv-status">${escapeHtml(j.status)}</td>
      <td class="pv-status">${escapeHtml(j.step || '')}</td>
      <td class="pv-error">${escapeHtml(j.error || '')}</td>
      <td>${j.created_at ? j.created_at.slice(0,16).replace('T',' ') : ''}</td>
      <td>${showRetry ? `<button class="pv-btn-retry" data-job="${j.id}">Retry</button>` : ''}</td>
    `;
    if (showRetry) {
      tr.querySelector('.pv-btn-retry').addEventListener('click', async () => {
        const r = await fetch('/prionvault/api/ingest/retry/' + j.id, { method: 'POST', credentials: 'same-origin' });
        if (r.ok) refreshQueue();
      });
    }
    return tr;
  }

  document.addEventListener('DOMContentLoaded', init);
})();
