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
 */
(() => {
  const API = '/prionvault/api';

  const ROLE     = (document.querySelector('meta[name="pv-user-role"]')?.content || '').trim();
  const USER_ID  = (document.querySelector('meta[name="pv-user-id"]')?.content || '').trim();
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
    hasSummary: null,
    inPrionread: null,   // null = all, true = in PrionRead, false = not in PrionRead
    page: 1,
    size: 25,
  };

  // ── helpers ────────────────────────────────────────────────────────────
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                                  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const supHtml = s => esc(s).replace(/\^(\S[^\^\n]*?)\^/g, '<sup>$1</sup>');

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

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
        btn.innerHTML = `
          <span style="display:inline-flex;align-items:center;gap:7px;min-width:0;overflow:hidden;">
            <span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${esc(t.color || '#9ca3af')}"></span>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(t.name)}</span>
          </span>
          <span style="font-size:10px;background:rgba(255,255,255,0.14);padding:1px 7px;border-radius:20px;flex-shrink:0;">${t.count}</span>
        `;
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
      b.style.background = isActive ? 'rgba(255,255,255,0.18)' : '';
      b.style.color      = isActive ? 'white' : '';
      b.style.fontWeight = isActive ? '600' : '';
    });
  }

  // ── render: article list ───────────────────────────────────────────────
  async function loadArticles() {
    const params = new URLSearchParams();
    if (state.q)                   params.set('q', state.q);
    if (state.sort)                params.set('sort', state.sort);
    if (state.yearMin)             params.set('year_min', state.yearMin);
    if (state.yearMax)             params.set('year_max', state.yearMax);
    if (state.journal)             params.set('journal', state.journal);
    if (state.tagId)               params.set('tag', state.tagId);
    if (state.hasSummary)          params.set('has_summary', state.hasSummary);
    if (state.inPrionread !== null) params.set('in_prionread', state.inPrionread ? '1' : '0');
    params.set('page', state.page);
    params.set('size', state.size);

    const grid = document.getElementById('pv-results-grid');
    grid.innerHTML = emptyState('Loading…');

    try {
      const r = await api('/articles?' + params.toString());
      document.getElementById('pv-result-count').textContent =
        r.total + ' result' + (r.total === 1 ? '' : 's');
      document.getElementById('pv-result-page').textContent =
        'page ' + r.page + ' / ' + Math.max(1, Math.ceil(r.total / r.size));

      if (r.items.length === 0) {
        grid.innerHTML = emptyState('No articles match these filters.');
        renderPagination(r);
        return;
      }
      grid.innerHTML = '';
      r.items.forEach(a => grid.appendChild(renderRow(a)));
      renderPagination(r);
    } catch (e) {
      grid.innerHTML = emptyState('Error: ' + esc(e.message));
    }
  }

  function emptyState(msg) {
    return `<div style="text-align:center;padding:52px 24px;color:#9ca3af;font-size:14px;">${esc(msg)}</div>`;
  }

  function renderRow(a) {
    const row = document.createElement('article');
    row.style.cssText =
      'display:flex;align-items:flex-start;gap:12px;padding:12px 20px;border-bottom:1px solid #f3f4f6;' +
      'cursor:pointer;transition:background 0.1s;';
    row.addEventListener('mouseenter', () => { row.style.background = '#fafafa'; });
    row.addEventListener('mouseleave', () => { row.style.background = ''; });

    const tags = (a.tags || []).slice(0, 4).map(t =>
      `<span style="display:inline-flex;padding:1px 9px;border-radius:20px;font-size:12px;font-weight:500;
                    ${t.color ? `background:${esc(t.color)}18;color:${esc(t.color)};` : 'background:#eef2ff;color:#4f46e5;'}"
            >${esc(t.name)}</span>`
    ).join('');

    const badges = [
      a.has_summary_ai
        ? '<span style="display:inline-flex;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:600;background:#dbeafe;color:#1d4ed8;">AI ✓</span>'
        : '',
      a.indexed_at
        ? '<span style="display:inline-flex;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:600;background:#dcfce7;color:#15803d;">indexed</span>'
        : '',
    ].filter(Boolean).join('');

    const authors = a.authors ? esc(a.authors).slice(0, 90) : '—';
    const journal = a.journal ? ` · ${esc(a.journal)}` : '';
    const hasMeta = badges || tags;

    row.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px;">
          <span style="font-size:15px;font-weight:600;color:#111827;line-height:1.4;">${supHtml(a.title || '(no title)')}</span>
          ${a.year ? `<span style="font-size:12px;color:#9ca3af;flex-shrink:0;font-variant-numeric:tabular-nums;">${a.year}</span>` : ''}
        </div>
        <p style="margin:0 0 ${hasMeta ? '5px' : '0'};font-size:13px;color:#6b7280;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${authors}${journal}
        </p>
        ${hasMeta ? `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px;">${badges}${tags}</div>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;padding-top:2px;">
        <button class="pv-prionread-btn ${a.in_prionread ? 'pv-prionread-active' : 'pv-prionread-inactive'}"
                data-aid="${esc(a.id)}"
                data-in="${a.in_prionread ? '1' : '0'}"
                title="${a.in_prionread ? 'En PrionRead — abrir ↗' : 'Enviar a PrionRead'}"
                style="font-size:13px;">📚</button>
      </div>
    `;

    row.querySelector('.pv-prionread-btn').addEventListener('click', e => {
      e.stopPropagation();
      togglePrionRead(e.currentTarget, a.id);
    });
    row.addEventListener('click', () => openDetail(a.id));
    return row;
  }

  async function togglePrionRead(btn, aid) {
    const inPrionRead = btn.dataset.in === '1';
    if (inPrionRead) {
      window.open(`/prionread/admin/articles?open=${aid}`, '_blank', 'noopener');
      return;
    }
    if (!confirm('¿Enviar este artículo a PrionRead y asignarlo a todos los estudiantes?')) return;
    btn.disabled = true;
    try {
      const r = await fetch(`/prionvault/api/articles/${aid}/send-to-prionread`, { method: 'POST' });
      const data = await r.json();
      if (data.ok) {
        btn.dataset.in = '1';
        btn.classList.remove('pv-prionread-inactive');
        btn.classList.add('pv-prionread-active');
        btn.title = 'En PrionRead — clic para abrir PrionRead ↗';
      }
    } catch (e) {
      console.error('togglePrionRead failed', e);
    } finally {
      btn.disabled = false;
    }
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

  // ── article detail modal ───────────────────────────────────────────────
  async function openDetail(aid) {
    const modal   = document.getElementById('pv-detail-modal');
    const content = document.getElementById('pv-detail-content');
    modal.style.display = 'flex';
    content.innerHTML = '<div style="text-align:center;padding:40px;color:#9ca3af;">Loading…</div>';
    try {
      const a = await api('/articles/' + aid);

      const tagHtml = (a.tags && a.tags.length)
        ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:16px;">
            ${a.tags.map(t =>
              `<span style="padding:3px 10px;border-radius:20px;font-size:12px;font-weight:500;
                            ${t.color ? `background:${esc(t.color)}18;color:${esc(t.color)};` : 'background:#eef2ff;color:#4f46e5;'}"
                    >${esc(t.name)}</span>`
            ).join('')}
           </div>`
        : '';

      const prionreadBadge = a.in_prionread
        ? `<span title="${a.prionread_count} estudiante${a.prionread_count !== 1 ? 's' : ''} asignado${a.prionread_count !== 1 ? 's' : ''}"
                 style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;
                        font-size:12px;font-weight:600;background:#d1fae5;color:#065f46;border:1px solid #6ee7b7;
                        margin-bottom:12px;">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;">
              <circle cx="8" cy="8" r="6.5" stroke="#065f46" stroke-width="1.5"/>
              <path d="M5 8.5l2 2 4-4" stroke="#065f46" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            En PrionRead · ${a.prionread_count} estudiante${a.prionread_count !== 1 ? 's' : ''}
           </span>`
        : `<span title="Este artículo no está asignado en PrionRead"
                 style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;
                        font-size:12px;font-weight:600;background:#f3f4f6;color:#6b7280;border:1px solid #d1d5db;
                        margin-bottom:12px;">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;">
              <circle cx="8" cy="8" r="6.5" stroke="#9ca3af" stroke-width="1.5"/>
              <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#9ca3af" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            No asignado en PrionRead
           </span>`;

      content.innerHTML = `
        <h2 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#111827;line-height:1.35;padding-right:24px;">
          ${supHtml(a.title)}
        </h2>
        ${prionreadBadge}
        <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-size:14px;color:#6b7280;margin-bottom:16px;">
          ${a.authors ? esc(a.authors) : '—'}
          ${a.journal ? `<span style="margin:0 4px;color:#d1d5db;">·</span>${esc(a.journal)}` : ''}
          ${a.year    ? `<span style="margin:0 4px;color:#d1d5db;">·</span>${a.year}` : ''}
          ${a.doi     ? `<span style="margin:0 4px;color:#d1d5db;">·</span>
                         <a href="https://doi.org/${esc(a.doi)}" target="_blank"
                            style="color:#0F3460;text-decoration:none;">${esc(a.doi)}</a>` : ''}
        </div>
        ${a.abstract ? `
          <h3 style="font-size:14px;font-weight:600;color:#374151;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.05em;">Abstract</h3>
          <p style="font-size:14px;color:#4b5563;line-height:1.65;margin:0 0 16px;">${supHtml(a.abstract)}</p>
        ` : ''}
        ${a.summary_ai ? `
          <h3 style="font-size:14px;font-weight:600;color:#374151;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.05em;">AI summary</h3>
          <p style="font-size:14px;color:#4b5563;line-height:1.65;margin:0 0 16px;">${supHtml(a.summary_ai)}</p>
        ` : ''}
        ${a.summary_human ? `
          <h3 style="font-size:14px;font-weight:600;color:#374151;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.05em;">Human notes</h3>
          <p style="font-size:14px;color:#4b5563;line-height:1.65;margin:0 0 16px;">${supHtml(a.summary_human)}</p>
        ` : ''}
        ${tagHtml}
        <div style="margin-top:20px;padding-top:14px;border-top:1px solid #f3f4f6;
                    font-size:12px;color:#9ca3af;font-family:ui-monospace,monospace;">
          Added: ${a.added_at ? esc(a.added_at.slice(0, 10)) : '—'}
          · Status: ${esc(a.extraction_status || 'pending')}
          ${a.indexed_at ? ' · Indexed: ' + esc(a.indexed_at.slice(0, 10)) : ''}
        </div>
      `;
    } catch (e) {
      content.innerHTML = `<div style="color:#b91c1c;padding:20px;">Error: ${esc(e.message)}</div>`;
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

    const prBtn = document.getElementById('btn-filter-prionread');
    prBtn.addEventListener('click', () => {
      // Cycle: null → true → false → null
      state.inPrionread = state.inPrionread === null ? true : state.inPrionread === true ? false : null;
      state.page = 1;
      const labels = {
        null:  '📚 PrionRead: todos',
        true:  '📚 En PrionRead ✓',
        false: '📚 No en PrionRead ✓',
      };
      prBtn.textContent = labels[state.inPrionread];
      const active = state.inPrionread !== null;
      prBtn.style.background     = active ? '#0F3460' : 'white';
      prBtn.style.color          = active ? 'white' : '#374151';
      prBtn.style.borderColor    = active ? '#0F3460' : '#e5e7eb';
      loadArticles();
    });

    document.querySelectorAll('.pv-sidebar-nav .pv-nav-btn[data-filter], aside .pv-nav-btn[data-filter]')
      .forEach(btn => {
        btn.addEventListener('click', () => {
          const f = btn.dataset.filter;
          state.tagId     = null;
          state.hasSummary = (f === 'no-summary') ? 'none' : null;
          state.sort       = (f === 'recent') ? 'added_desc' : state.sort;
          state.page = 1;
          loadArticles();
        });
      });

    document.getElementById('pv-detail-close').addEventListener('click', closeDetail);
    document.querySelector('#pv-detail-modal .pv-modal-backdrop').addEventListener('click', closeDetail);

    if (IS_ADMIN) {
      wireImport();
      wireQueue();
      wireSync();
    }

    refreshStats();
    refreshTags();
    loadArticles().then(() => {
      const openId = new URLSearchParams(window.location.search).get('open');
      if (openId) openDetail(openId);
    });
  }

  // ── Import modal ─────────────────────────────────────────────────────
  let _importPolling = null;
  function wireImport() {
    const btn            = document.getElementById('btn-import-pdfs');
    const modal          = document.getElementById('pv-import-modal');
    const closeBtn       = document.getElementById('pv-import-close');
    const dropzone       = document.getElementById('pv-dropzone');
    const fileInput      = document.getElementById('pv-file-input');
    const fileInputPlain = document.getElementById('pv-file-input-plain');
    const pickFiles      = document.getElementById('pv-pick-files');
    const pickFolder     = document.getElementById('pv-pick-folder');
    if (!btn || !modal) return;

    const open  = () => { modal.style.display = 'flex'; startProgressPolling(); };
    const close = () => { modal.style.display = 'none'; stopProgressPolling(); };
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    pickFiles.addEventListener('click',  () => fileInputPlain.click());
    pickFolder.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change',      e => uploadFiles(e.target.files));
    fileInputPlain.addEventListener('change', e => uploadFiles(e.target.files));

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
          appendProgress(`Batch ${i / BATCH + 1}: ${err.error || r.status}`, 'error');
          continue;
        }
        const j = await r.json();
        queued += j.queued || 0;
        appendProgress(`Batch ${i / BATCH + 1}: ${j.queued} queued.`, 'ok');
      } catch (e) {
        appendProgress(`Batch ${i / BATCH + 1}: ${e.message}`, 'error');
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
    const color = kind === 'error' ? '#b91c1c' : kind === 'ok' ? '#15803d' : '#6b7280';
    row.innerHTML = `<span style="color:${color};flex-shrink:0;">●</span>
                     <span><b style="color:#374151;">${new Date().toLocaleTimeString()}</b> ${escapeHtml(text)}</span>`;
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
        const doi    = step.match(/doi=([^\s|]+)/)?.[1];
        const pmid   = step.match(/pmid=([^\s|]+)/)?.[1];
        const path   = step.match(/\| (\/[^\s]+)/)?.[1];
        const id     = doi ? `DOI: ${doi}` : pmid ? `PMID: ${pmid}` : '';
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

  // ── Queue panel ────────────────────────────────────────────────────────
  let _queuePolling = null;
  function wireQueue() {
    const btn      = document.getElementById('btn-manage-queue');
    const modal    = document.getElementById('pv-queue-modal');
    const closeBtn = document.getElementById('pv-queue-close');
    if (!btn || !modal) return;

    btn.addEventListener('click', () => {
      modal.style.display = 'flex';
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
      document.getElementById('pv-queue-counts').innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:8px;font-size:12px;margin-bottom:4px;">
          <span style="padding:3px 10px;border-radius:20px;background:#f3f4f6;color:#374151;">queued: <b>${s.queued}</b></span>
          <span style="padding:3px 10px;border-radius:20px;background:#fff7ed;color:#c2410c;">processing: <b>${s.processing}</b></span>
          <span style="padding:3px 10px;border-radius:20px;background:#f0fdf4;color:#15803d;">done: <b>${s.done}</b></span>
          <span style="padding:3px 10px;border-radius:20px;background:#eff6ff;color:#1d4ed8;">duplicate: <b>${s.duplicate}</b></span>
          <span style="padding:3px 10px;border-radius:20px;background:#fef2f2;color:#b91c1c;">failed: <b>${s.failed}</b></span>
        </div>
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
      <td style="color:#9ca3af;">${j.id}</td>
      <td title="${escapeHtml(j.pdf_filename || '')}">${escapeHtml((j.pdf_filename || '').slice(0, 60))}</td>
      <td><span style="font-size:11px;font-weight:600;color:${statusColor(j.status)};">${escapeHtml(j.status)}</span></td>
      <td style="color:#6b7280;max-width:180px;word-break:break-word;">${escapeHtml(j.step || '')}</td>
      <td style="color:#b91c1c;">${escapeHtml(j.error || '')}</td>
      <td style="color:#9ca3af;white-space:nowrap;">${j.created_at ? j.created_at.slice(0, 16).replace('T', ' ') : ''}</td>
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

  function statusColor(s) {
    return s === 'done' ? '#15803d' : s === 'failed' ? '#b91c1c' : s === 'duplicate' ? '#1d4ed8' :
           s === 'processing' ? '#c2410c' : '#6b7280';
  }

  // ── Sync status modal ──────────────────────────────────────────────────
  const SYNC_TABS = [
    { key: 'only_in_prionread',  label: '📄 Solo en PrionRead',  color: '#b45309' },
    { key: 'only_in_prionvault', label: '🗄️ Solo en PrionVault', color: '#1d4ed8' },
    { key: 'in_both',            label: '✅ En ambos',           color: '#166534' },
    { key: 'in_neither',         label: '❓ Sin asignar',        color: '#6b7280' },
  ];

  function wireSync() {
    const btn      = document.getElementById('btn-sync-status');
    const modal    = document.getElementById('pv-sync-modal');
    const closeBtn = document.getElementById('pv-sync-close');
    if (!btn || !modal) return;

    let syncData  = null;
    let activeTab = 'only_in_prionread';

    const open = async () => {
      modal.style.display = 'flex';
      renderSyncLoading();
      try {
        const r = await fetch('/prionvault/api/admin/sync/status', { credentials: 'same-origin' });
        syncData = await r.json();
        renderSync();
      } catch (e) {
        document.getElementById('pv-sync-list').innerHTML =
          '<p style="color:#dc2626;padding:16px;">Error cargando datos de sincronización.</p>';
      }
    };
    const close = () => { modal.style.display = 'none'; };
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    function renderSyncLoading() {
      document.getElementById('pv-sync-summary').innerHTML =
        '<p style="color:#9ca3af;font-size:13px;">Cargando…</p>';
      document.getElementById('pv-sync-tabs').innerHTML = '';
      document.getElementById('pv-sync-list').innerHTML = '';
    }

    function renderSync() {
      if (!syncData) return;
      const s = syncData.summary;

      const summaryEl = document.getElementById('pv-sync-summary');
      summaryEl.innerHTML = SYNC_TABS.map(t => `
        <div style="background:white;border:1px solid #e5e7eb;border-radius:10px;padding:12px 18px;
                    cursor:pointer;min-width:110px;transition:box-shadow 0.1s;"
             data-sync-tab="${t.key}" class="pv-sync-badge"
             onmouseenter="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.08)'"
             onmouseleave="this.style.boxShadow=''">
          <div style="font-size:24px;font-weight:700;color:${t.color};">${s[t.key]}</div>
          <div style="font-size:11px;color:#6b7280;margin-top:3px;line-height:1.3;">${t.label}</div>
        </div>
      `).join('');
      summaryEl.querySelectorAll('.pv-sync-badge').forEach(b => {
        b.addEventListener('click', () => { activeTab = b.dataset.syncTab; renderTabContent(); renderTabButtons(); });
      });

      renderTabButtons();
      renderTabContent();
    }

    function renderTabButtons() {
      const tabsEl = document.getElementById('pv-sync-tabs');
      tabsEl.innerHTML = SYNC_TABS.map(t => `
        <button style="padding:5px 12px;border-radius:7px;border:1px solid;font-size:12px;cursor:pointer;
                       transition:all 0.1s;
                       background:${activeTab === t.key ? t.color : 'white'};
                       color:${activeTab === t.key ? 'white' : '#374151'};
                       border-color:${activeTab === t.key ? t.color : '#d1d5db'};"
                data-sync-tab="${t.key}" class="pv-sync-tab-btn">
          ${t.label} (${syncData.summary[t.key]})
        </button>
      `).join('');
      tabsEl.querySelectorAll('.pv-sync-tab-btn').forEach(b => {
        b.addEventListener('click', () => { activeTab = b.dataset.syncTab; renderTabContent(); renderTabButtons(); });
      });
    }

    function renderTabContent() {
      const listEl   = document.getElementById('pv-sync-list');
      const articles = (syncData.articles || {})[activeTab] || [];
      if (!articles.length) {
        listEl.innerHTML = '<p style="color:#9ca3af;padding:20px;text-align:center;font-size:13px;">No hay artículos en esta categoría.</p>';
        return;
      }
      listEl.innerHTML = articles.map(a => {
        const authStr = typeof a.authors === 'string'
          ? a.authors.split(',').slice(0, 2).join(', ')
          : (a.authors || []).slice(0, 2).join(', ');
        return `
          <div style="padding:10px 4px;border-bottom:1px solid #f3f4f6;display:flex;align-items:flex-start;gap:12px;">
            <div style="flex:1;min-width:0;">
              <p style="margin:0 0 2px;font-weight:600;font-size:13px;color:#111827;">${escapeHtml(a.title || '')}</p>
              <p style="margin:0;font-size:11px;color:#6b7280;">
                ${escapeHtml(authStr)}
                ${a.year ? ' · ' + a.year : ''}
                ${a.journal ? ' · ' + escapeHtml(a.journal) : ''}
                ${a.doi ? ` · <a href="https://doi.org/${escapeHtml(a.doi)}" target="_blank"
                              style="color:#0F3460;text-decoration:none;">DOI</a>` : ''}
              </p>
              ${a.student_count > 0
                ? `<p style="margin:3px 0 0;font-size:11px;color:#059669;">${a.student_count} estudiante${a.student_count !== 1 ? 's' : ''} en PrionRead</p>`
                : ''}
            </div>
            <div style="display:flex;flex-direction:column;gap:5px;align-items:flex-end;flex-shrink:0;">
              ${(activeTab === 'only_in_prionvault' || activeTab === 'in_neither')
                ? `<button class="pv-btn-soft pv-sync-assign-btn" data-aid="${a.id}"
                           style="font-size:11px;padding:4px 10px;">👥 Asignar a todos</button>`
                : ''}
              ${(activeTab === 'only_in_prionread' || activeTab === 'in_neither')
                ? `<span style="font-size:11px;color:#b45309;padding:3px 8px;border:1px solid #fde68a;
                               background:#fffbeb;border-radius:5px;">📄 Sin PDF en PrionVault</span>`
                : ''}
            </div>
          </div>
        `;
      }).join('');

      listEl.querySelectorAll('.pv-sync-assign-btn').forEach(b => {
        b.addEventListener('click', async () => {
          b.disabled = true;
          b.textContent = '⏳ Asignando…';
          try {
            const r = await fetch(`/prionvault/api/articles/${b.dataset.aid}/send-to-prionread`,
              { method: 'POST', credentials: 'same-origin' });
            if (r.ok) {
              b.textContent = '✓ Asignado';
              b.style.color = '#059669';
            } else {
              b.textContent = '❌ Error';
              b.disabled = false;
            }
          } catch { b.textContent = '❌ Error'; b.disabled = false; }
        });
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
