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
      <div class="pv-card-flags" style="display:flex;gap:6px">${flagSummary} ${flagIndexed}</div>
      ${a.tags && a.tags.length ? `<div class="pv-card-tags">${tags}</div>` : ''}
    `;
    card.addEventListener('click', () => openDetail(a.id));
    return card;
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

    refreshStats();
    refreshTags();
    loadArticles();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
