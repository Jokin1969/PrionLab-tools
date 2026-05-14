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
    isFlagged: null,     // null = all, true = flagged, false = not flagged
    isMilestone: null,   // null = all, true = milestone, false = not
    colorLabel: null,    // null = all, 'red'..'purple', or 'none' for no label
    priorityMin: null,   // null = all, else integer 1-5
    page: 1,
    size: 25,
  };

  const COLOR_LABELS = [
    { value: 'red',    css: '#ef4444' },
    { value: 'orange', css: '#fb923c' },
    { value: 'yellow', css: '#facc15' },
    { value: 'green',  css: '#22c55e' },
    { value: 'blue',   css: '#3b82f6' },
    { value: 'purple', css: '#a855f7' },
  ];
  const COLOR_CSS = Object.fromEntries(COLOR_LABELS.map(c => [c.value, c.css]));

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
    if (state.isFlagged    !== null) params.set('is_flagged',   state.isFlagged    ? '1' : '0');
    if (state.isMilestone  !== null) params.set('is_milestone', state.isMilestone  ? '1' : '0');
    if (state.colorLabel)          params.set('color_label', state.colorLabel);
    if (state.priorityMin)         params.set('priority_min', state.priorityMin);
    params.set('page', state.page);
    params.set('size', state.size);

    const tbody = document.getElementById('pv-results-tbody');
    const table = document.getElementById('pv-results-table');
    const empty = document.getElementById('pv-results-empty');
    const showEmpty = (msg) => {
      table.style.display = 'none';
      empty.style.display = 'block';
      empty.innerHTML = `<div style="text-align:center;padding:52px 24px;color:#9ca3af;font-size:14px;">${esc(msg)}</div>`;
    };
    const showTable = () => {
      table.style.display = '';
      empty.style.display = 'none';
    };

    showEmpty('Loading…');

    try {
      const r = await api('/articles?' + params.toString());
      document.getElementById('pv-result-count').textContent =
        r.total + ' result' + (r.total === 1 ? '' : 's');
      document.getElementById('pv-result-page').textContent =
        'page ' + r.page + ' / ' + Math.max(1, Math.ceil(r.total / r.size));

      if (r.items.length === 0) {
        showEmpty('No articles match these filters.');
        renderPagination(r);
        return;
      }
      showTable();
      tbody.innerHTML = '';
      r.items.forEach(a => tbody.appendChild(renderRow(a)));
      refreshSortHeaders();
      renderPagination(r);
    } catch (e) {
      showEmpty('Error: ' + esc(e.message));
    }
  }

  // Inline SVG flag icon mirroring PrionRead's FlagIcon (small staff + triangle).
  const FLAG_SVG = (active) => `
    <svg viewBox="0 0 10 13" width="13" height="13" style="display:block;"
         fill="${active ? 'currentColor' : 'none'}"
         stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <line x1="1.5" y1="0.5" x2="1.5" y2="12.5"></line>
      <path d="M1.5 1 L9 3.5 L1.5 7 Z"></path>
    </svg>`;

  function renderRow(a) {
    const row = document.createElement('tr');
    row.className = 'pv-article-row';
    row.style.cssText = 'cursor:pointer;border-bottom:1px solid #f3f4f6;transition:background 0.1s;';
    row.addEventListener('mouseenter', () => { row.style.background = '#fafafa'; });
    row.addEventListener('mouseleave', () => { row.style.background = ''; });

    // ── tags + badges (rendered inside the Article cell) ─────────────────
    const tags = (a.tags || []).slice(0, 4).map(t =>
      `<span style="display:inline-flex;padding:1px 8px;border-radius:20px;font-size:11px;font-weight:500;
                    ${t.color ? `background:${esc(t.color)}18;color:${esc(t.color)};` : 'background:#eef2ff;color:#4f46e5;'}"
            >${esc(t.name)}</span>`
    ).join('');

    const badges = [
      a.has_summary_ai
        ? '<span style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#dbeafe;color:#1d4ed8;">AI ✓</span>'
        : '',
      a.indexed_at
        ? '<span style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#dcfce7;color:#15803d;">indexed</span>'
        : '',
    ].filter(Boolean).join('');

    const authors = a.authors ? esc(a.authors) : '—';
    const journal = a.journal ? ` · ${esc(a.journal)}` : '';

    // ── Marks cell: flag + color dot + milestone (vertical stack) ────────
    const colorCss = a.color_label ? (COLOR_CSS[a.color_label] || '#9ca3af') : null;
    const flagColor = a.is_flagged ? '#e11d48' : '#e5e7eb';
    const flagTitle = a.is_flagged ? 'Marcada 🚩 — clic para quitar' : 'Marcar bandera';
    const milestoneColor = a.is_milestone ? '#f59e0b' : '#d1d5db';
    const colorTitle = a.color_label ? `Etiqueta: ${esc(a.color_label)}` : 'Sin etiqueta de color';

    const marksCell = `
      <td style="padding:8px 8px;vertical-align:middle;text-align:center;">
        <div style="display:flex;align-items:center;justify-content:center;gap:8px;">
          <button class="pv-flag-btn"
                  data-active="${a.is_flagged ? '1' : '0'}"
                  title="${flagTitle}"
                  style="background:none;border:none;padding:0;line-height:0;
                         cursor:${IS_ADMIN ? 'pointer' : 'default'};color:${flagColor};">${FLAG_SVG(a.is_flagged)}</button>
          <span class="pv-color-dot"
                title="${colorTitle}"
                style="width:11px;height:11px;border-radius:50%;flex-shrink:0;cursor:${IS_ADMIN ? 'pointer' : 'default'};
                       ${colorCss ? `background:${colorCss};` : 'background:transparent;border:1.5px dashed #d1d5db;'}"></span>
          <button class="pv-milestone-btn"
                  data-active="${a.is_milestone ? '1' : '0'}"
                  title="${a.is_milestone ? 'Hito ★ — clic para quitar' : 'Marcar como hito'}"
                  style="background:none;border:none;padding:0;font-size:15px;line-height:1;
                         cursor:${IS_ADMIN ? 'pointer' : 'default'};color:${milestoneColor};">${a.is_milestone ? '★' : '☆'}</button>
        </div>
      </td>`;

    // ── Article cell: title, authors+journal, tags+badges ────────────────
    const titleTooltip = [
      a.title,
      a.authors,
      a.journal && `${a.journal}${a.year ? ' · ' + a.year : ''}`,
    ].filter(Boolean).join('\n');

    const articleCell = `
      <td style="padding:8px 12px;vertical-align:middle;max-width:520px;">
        <div style="font-size:14px;font-weight:600;color:#111827;line-height:1.35;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
             title="${esc(titleTooltip)}">${supHtml(a.title || '(no title)')}</div>
        <div style="margin-top:2px;font-size:12px;color:#6b7280;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${authors}${journal}</div>
        ${(tags || badges) ? `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:4px;">${badges}${tags}</div>` : ''}
      </td>`;

    // ── Year cell ────────────────────────────────────────────────────────
    const yearCell = `
      <td style="padding:8px 8px;vertical-align:middle;font-size:13px;color:#374151;
                 font-variant-numeric:tabular-nums;">${a.year ? a.year : '—'}</td>`;

    // ── Pages cell ───────────────────────────────────────────────────────
    const pagesCell = a.pdf_pages
      ? `<td style="padding:8px 8px;vertical-align:middle;text-align:center;font-size:12px;color:#374151;">
           <span style="display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:5px;
                        background:#f3f4f6;font-variant-numeric:tabular-nums;">📄 ${a.pdf_pages}</span>
         </td>`
      : `<td style="padding:8px 8px;vertical-align:middle;text-align:center;color:#d1d5db;font-size:12px;">—</td>`;

    // ── Priority cell ────────────────────────────────────────────────────
    const prio = a.priority || 3;
    const prioStyle = prio >= 5 ? 'background:#fee2e2;color:#b91c1c;'
                    : prio === 4 ? 'background:#fef3c7;color:#92400e;'
                    : prio === 3 ? 'background:#e0f2fe;color:#075985;'
                    : prio === 2 ? 'background:#f3f4f6;color:#4b5563;'
                                 : 'background:#e5e7eb;color:#6b7280;';
    const priorityCell = `
      <td style="padding:8px 8px;vertical-align:middle;text-align:center;">
        <span class="pv-priority-chip"
              title="Prioridad ${prio}/5${IS_ADMIN ? ' — clic para cambiar' : ''}"
              style="display:inline-flex;align-items:center;justify-content:center;
                     min-width:24px;height:20px;padding:0 6px;border-radius:5px;
                     font-size:11px;font-weight:700;cursor:${IS_ADMIN ? 'pointer' : 'default'};
                     ${prioStyle}">P${prio}</span>
      </td>`;

    // ── Links cell: PDF (Dropbox), DOI, PMID ─────────────────────────────
    const pillLink = (href, label, bg, fg, title) => href
      ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"
             title="${esc(title)}" onclick="event.stopPropagation();"
             style="display:inline-flex;align-items:center;padding:1px 6px;border-radius:5px;
                    font-size:10.5px;font-weight:600;text-decoration:none;background:${bg};color:${fg};">${label}</a>`
      : '';

    const hasPdf = !!(a.has_pdf || a.pdf_dropbox_path);
    const pdfLink = hasPdf
      ? `<span title="PDF disponible — abrir detalle para descargar"
               style="display:inline-flex;align-items:center;padding:1px 6px;border-radius:5px;
                      font-size:10.5px;font-weight:600;background:#fee2e2;color:#b91c1c;">PDF</span>`
      : '<span title="Sin PDF" style="display:inline-flex;align-items:center;padding:1px 6px;border-radius:5px;font-size:10.5px;font-weight:600;background:#f3f4f6;color:#9ca3af;">PDF</span>';

    const doiLink = pillLink(a.doi ? `https://doi.org/${a.doi}` : null, 'DOI', '#e0e7ff', '#3730a3', 'Abrir DOI');
    const pmidLink = pillLink(a.pubmed_id ? `https://pubmed.ncbi.nlm.nih.gov/${a.pubmed_id}/` : null,
                              'PMID', '#ccfbf1', '#0f766e', 'Abrir PubMed');

    const linksCell = `
      <td style="padding:8px 8px;vertical-align:middle;">
        <div style="display:flex;flex-wrap:wrap;gap:3px;">${pdfLink}${doiLink}${pmidLink}</div>
      </td>`;

    // ── Asignado cell: read-only count + open-in-PrionRead button ───────
    const assignedCount = a.prionread_count || 0;
    const assignedStatus = a.in_prionread
      ? `<span title="${assignedCount} estudiante${assignedCount === 1 ? '' : 's'} con este artículo asignado"
              style="display:inline-flex;align-items:center;gap:3px;font-size:12px;font-weight:600;color:#0F3460;">
           ✓ <span style="color:#6b7280;font-weight:500;">(${assignedCount})</span>
         </span>`
      : `<span title="Ningún estudiante tiene este artículo asignado"
              style="display:inline-flex;align-items:center;font-size:13px;color:#d1d5db;">—</span>`;

    const prionreadCell = `
      <td style="padding:8px 8px;vertical-align:middle;text-align:center;">
        <div style="display:inline-flex;align-items:center;gap:8px;">
          ${assignedStatus}
          <button class="pv-open-prionread-btn"
                  data-aid="${esc(a.id)}"
                  title="Abrir este artículo en PrionRead admin ↗"
                  style="background:none;border:none;padding:2px 4px;cursor:pointer;
                         font-size:13px;color:#6b7280;line-height:1;border-radius:4px;"
                  onmouseover="this.style.background='#f3f4f6';this.style.color='#0F3460';"
                  onmouseout="this.style.background='none';this.style.color='#6b7280';">↗</button>
        </div>
      </td>`;

    row.innerHTML = marksCell + articleCell + yearCell + pagesCell +
                    priorityCell + linksCell + prionreadCell;

    // ── Wiring ──────────────────────────────────────────────────────────
    row.querySelector('.pv-open-prionread-btn').addEventListener('click', e => {
      e.stopPropagation();
      window.open(`/prionread/admin/articles?open=${encodeURIComponent(a.id)}`,
                  '_blank', 'noopener');
    });

    if (IS_ADMIN) {
      row.querySelector('.pv-milestone-btn').addEventListener('click', e => {
        e.stopPropagation();
        const next = e.currentTarget.dataset.active !== '1';
        patchArticleInline(a, { is_milestone: next }, () => {
          a.is_milestone = next;
          if (next) a.priority = 5;
          replaceRow(row, a);
        });
      });

      row.querySelector('.pv-flag-btn').addEventListener('click', e => {
        e.stopPropagation();
        const next = e.currentTarget.dataset.active !== '1';
        patchArticleInline(a, { is_flagged: next }, () => {
          a.is_flagged = next;
          replaceRow(row, a);
        });
      });

      row.querySelector('.pv-color-dot').addEventListener('click', e => {
        e.stopPropagation();
        openColorPopover(e.currentTarget, a, () => replaceRow(row, a));
      });

      const prChip = row.querySelector('.pv-priority-chip');
      if (prChip) prChip.addEventListener('click', e => {
        e.stopPropagation();
        openPriorityPopover(e.currentTarget, a, () => replaceRow(row, a));
      });
    }

    row.addEventListener('click', () => openDetail(a.id));
    return row;
  }

  function replaceRow(oldNode, article) {
    const fresh = renderRow(article);
    oldNode.replaceWith(fresh);
  }

  function refreshSortHeaders() {
    document.querySelectorAll('.pv-sort-th').forEach(th => {
      const col = th.dataset.sortCol;
      const label = col.charAt(0).toUpperCase() + col.slice(1);
      let arrow = '';
      if (col === 'title' && state.sort === 'title_asc') arrow = ' ▲';
      else if (col === 'year' && state.sort === 'year_desc') arrow = ' ▼';
      else if (col === 'year' && state.sort === 'year_asc')  arrow = ' ▲';
      th.textContent = label + arrow;
      th.style.color = arrow ? '#111827' : '#6b7280';
    });
  }

  async function patchArticleInline(a, patch, onOk) {
    try {
      await api(`/articles/${a.id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      onOk && onOk();
    } catch (e) {
      console.error('patchArticleInline failed', e);
      alert('No se pudo guardar el cambio: ' + e.message);
    }
  }

  let _popoverEl = null;
  function closePopover() {
    if (_popoverEl) { _popoverEl.remove(); _popoverEl = null; }
    document.removeEventListener('click', closePopoverOnOutside, true);
  }
  function closePopoverOnOutside(e) {
    if (_popoverEl && !_popoverEl.contains(e.target)) closePopover();
  }
  function openPopoverAt(anchor) {
    closePopover();
    const r = anchor.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.style.cssText =
      'position:fixed;z-index:1000;background:white;border:1px solid #e5e7eb;border-radius:10px;' +
      'box-shadow:0 4px 14px rgba(0,0,0,0.12);padding:8px;display:flex;gap:6px;align-items:center;';
    pop.style.top  = (r.bottom + 6) + 'px';
    pop.style.left = (r.left) + 'px';
    document.body.appendChild(pop);
    _popoverEl = pop;
    setTimeout(() => document.addEventListener('click', closePopoverOnOutside, true), 0);
    return pop;
  }

  function openColorPopover(anchor, a, onChange) {
    const pop = openPopoverAt(anchor);
    const mkSwatch = (value, css) => {
      const b = document.createElement('button');
      const selected = (a.color_label || null) === value;
      b.style.cssText =
        `width:22px;height:22px;border-radius:50%;border:2px solid ${selected ? '#111827' : 'transparent'};` +
        `cursor:pointer;${css ? `background:${css};` : 'background:transparent;border-style:dashed;border-color:#9ca3af;'}`;
      b.title = value || 'Sin etiqueta';
      b.addEventListener('click', async () => {
        await patchArticleInline(a, { color_label: value }, () => {
          a.color_label = value;
          onChange && onChange();
        });
        closePopover();
      });
      return b;
    };
    pop.appendChild(mkSwatch(null, null));
    COLOR_LABELS.forEach(c => pop.appendChild(mkSwatch(c.value, c.css)));
  }

  function openPriorityPopover(anchor, a, onChange) {
    const pop = openPopoverAt(anchor);
    [1, 2, 3, 4, 5].forEach(p => {
      const b = document.createElement('button');
      const isCur = (a.priority || 3) === p;
      b.textContent = 'P' + p;
      b.style.cssText =
        'min-width:30px;padding:4px 8px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;' +
        (isCur ? 'background:#0F3460;color:white;border:1px solid #0F3460;'
               : 'background:white;color:#374151;border:1px solid #e5e7eb;');
      b.addEventListener('click', async () => {
        await patchArticleInline(a, { priority: p }, () => {
          a.priority = p;
          onChange && onChange();
        });
        closePopover();
      });
      pop.appendChild(b);
    });
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
        null:  '👥 Asignado: todos',
        true:  '👥 Asignados ✓',
        false: '👥 Sin asignar',
      };
      prBtn.textContent = labels[state.inPrionread];
      const active = state.inPrionread !== null;
      prBtn.style.background     = active ? '#0F3460' : 'white';
      prBtn.style.color          = active ? 'white' : '#374151';
      prBtn.style.borderColor    = active ? '#0F3460' : '#e5e7eb';
      loadArticles();
    });

    function wireTriStateButton(id, stateKey, labels) {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.addEventListener('click', () => {
        state[stateKey] = state[stateKey] === null ? true
                       : state[stateKey] === true ? false : null;
        state.page = 1;
        btn.textContent = labels[state[stateKey]];
        const active = state[stateKey] !== null;
        btn.style.background  = active ? '#0F3460' : 'white';
        btn.style.color       = active ? 'white' : '#374151';
        btn.style.borderColor = active ? '#0F3460' : '#e5e7eb';
        loadArticles();
      });
    }
    wireTriStateButton('btn-filter-milestone', 'isMilestone', {
      null: '★ Hito: todos', true: '★ Solo hitos', false: '★ No hitos',
    });
    wireTriStateButton('btn-filter-flagged', 'isFlagged', {
      null: '🚩 Bandera: todos', true: '🚩 Solo marcados', false: '🚩 Sin bandera',
    });

    document.getElementById('filter-color').addEventListener('change', e => {
      state.colorLabel = e.target.value || null;
      state.page = 1;
      loadArticles();
    });
    document.getElementById('filter-priority-min').addEventListener('change', e => {
      const v = parseInt(e.target.value, 10);
      state.priorityMin = Number.isFinite(v) ? v : null;
      state.page = 1;
      loadArticles();
    });

    document.querySelectorAll('.pv-sort-th').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sortCol;
        // Cycle desc → asc → default for each column
        if (col === 'title') {
          state.sort = state.sort === 'title_asc' ? 'added_desc' : 'title_asc';
        } else if (col === 'year') {
          state.sort = state.sort === 'year_desc' ? 'year_asc'
                     : state.sort === 'year_asc'  ? 'added_desc'
                                                  : 'year_desc';
        }
        const sortSelect = document.getElementById('filter-sort');
        if (sortSelect) sortSelect.value = state.sort;
        state.page = 1;
        loadArticles();
      });
    });
    refreshSortHeaders();

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
      wireAddByDoi();
      wireBatchImport();
      wireDuplicates();
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

  // ── Add by DOI / PMID ────────────────────────────────────────────────
  function parseIdentifier(raw) {
    const s = (raw || '').trim()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    if (/^10\./.test(s))   return { doi: s, pubmed_id: '' };
    if (/^\d+$/.test(s))   return { doi: '', pubmed_id: s };
    return { doi: s, pubmed_id: '' };
  }

  function wireAddByDoi() {
    const btn   = document.getElementById('btn-add-by-doi');
    const modal = document.getElementById('pv-add-modal');
    if (!btn || !modal) return;

    const ident    = document.getElementById('pv-add-identifier');
    const lookup   = document.getElementById('pv-add-lookup');
    const statusEl = document.getElementById('pv-add-status');
    const form     = document.getElementById('pv-add-form');
    const fTitle   = document.getElementById('pv-add-title');
    const fAuthors = document.getElementById('pv-add-authors');
    const fYear    = document.getElementById('pv-add-year');
    const fJournal = document.getElementById('pv-add-journal');
    const fDoi     = document.getElementById('pv-add-doi');
    const fPmid    = document.getElementById('pv-add-pmid');
    const fAbstr   = document.getElementById('pv-add-abstract');
    const btnSave  = document.getElementById('pv-add-save');
    const btnCancel = document.getElementById('pv-add-cancel');
    const btnClose = document.getElementById('pv-add-close');

    function reset() {
      ident.value = '';
      [fTitle, fAuthors, fYear, fJournal, fDoi, fPmid, fAbstr].forEach(el => el.value = '');
      form.style.display = 'none';
      statusEl.textContent = '';
      statusEl.style.color = '#6b7280';
    }
    function open()  { reset(); modal.style.display = 'flex'; setTimeout(() => ident.focus(), 50); }
    function close() { modal.style.display = 'none'; }

    btn.addEventListener('click', open);
    btnClose.addEventListener('click', close);
    btnCancel.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    async function doLookup() {
      const { doi, pubmed_id } = parseIdentifier(ident.value);
      if (!doi && !pubmed_id) {
        statusEl.textContent = 'Pega un DOI o un PMID válido.';
        statusEl.style.color = '#b91c1c';
        return;
      }
      statusEl.textContent = 'Consultando CrossRef / PubMed…';
      statusEl.style.color = '#6b7280';
      lookup.disabled = true;
      try {
        const r = await api('/articles/lookup', {
          method: 'POST',
          body: JSON.stringify({ doi, pubmed_id }),
        });
        if (!r.found) {
          statusEl.textContent = 'No se encontraron metadatos. Puedes rellenar el formulario a mano.';
          statusEl.style.color = '#b45309';
          form.style.display = 'block';
          fDoi.value  = doi || '';
          fPmid.value = pubmed_id || '';
          return;
        }
        const m = r.metadata || {};
        fTitle.value   = m.title   || '';
        fAuthors.value = m.authors || '';
        fYear.value    = m.year    || '';
        fJournal.value = m.journal || '';
        fDoi.value     = m.doi     || doi || '';
        fPmid.value    = m.pubmed_id || pubmed_id || '';
        fAbstr.value   = m.abstract  || '';
        form.style.display = 'block';
        if (r.duplicate_of) {
          statusEl.innerHTML = `⚠️ Ya existe un artículo con este DOI/PMID en la biblioteca · ` +
                               `<a href="#" data-aid="${esc(r.duplicate_of)}" id="pv-add-dup-open" ` +
                               `style="color:#0F3460;text-decoration:underline;">Ver existente</a>`;
          statusEl.style.color = '#b45309';
          const lnk = document.getElementById('pv-add-dup-open');
          if (lnk) lnk.addEventListener('click', e => {
            e.preventDefault();
            openDetail(r.duplicate_of);
          });
          btnSave.disabled = true;
          btnSave.style.opacity = '0.5';
        } else {
          statusEl.textContent = `✓ Metadatos cargados desde ${m.source || 'el resolver'}. ` +
                                 `Edita si hace falta y guarda.`;
          statusEl.style.color = '#15803d';
          btnSave.disabled = false;
          btnSave.style.opacity = '1';
        }
      } catch (e) {
        statusEl.textContent = 'Error de lookup: ' + e.message;
        statusEl.style.color = '#b91c1c';
      } finally {
        lookup.disabled = false;
      }
    }
    lookup.addEventListener('click', doLookup);
    ident.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); doLookup(); }
    });

    btnSave.addEventListener('click', async () => {
      if (!fTitle.value.trim()) {
        statusEl.textContent = 'El título es obligatorio.';
        statusEl.style.color = '#b91c1c';
        return;
      }
      btnSave.disabled = true;
      const payload = {
        title:     fTitle.value.trim(),
        authors:   fAuthors.value.trim() || null,
        year:      parseInt(fYear.value, 10) || null,
        journal:   fJournal.value.trim() || null,
        doi:       fDoi.value.trim() || null,
        pubmed_id: fPmid.value.trim() || null,
        abstract:  fAbstr.value.trim() || null,
      };
      try {
        await api('/articles', { method: 'POST', body: JSON.stringify(payload) });
        close();
        loadArticles();
        refreshStats();
      } catch (e) {
        if (e.status === 409) {
          statusEl.textContent = '⚠️ Ya existe un artículo con ese DOI/PMID — no se ha creado.';
          statusEl.style.color = '#b45309';
        } else {
          statusEl.textContent = 'Error al guardar: ' + e.message;
          statusEl.style.color = '#b91c1c';
        }
        btnSave.disabled = false;
      }
    });
  }

  // ── Batch import by DOI/PMID list ────────────────────────────────────
  function parseBatchEntries(text) {
    return text.split(/[\n\r\t,;]+/).map(s => s.trim()).filter(Boolean).map(parseIdentifier);
  }

  function wireBatchImport() {
    const btn   = document.getElementById('btn-batch-import');
    const modal = document.getElementById('pv-batch-modal');
    if (!btn || !modal) return;

    const ta       = document.getElementById('pv-batch-text');
    const counter  = document.getElementById('pv-batch-count');
    const startBtn = document.getElementById('pv-batch-start');
    const cancelBtn = document.getElementById('pv-batch-cancel');
    const closeBtn = document.getElementById('pv-batch-close');
    const inputWrap = document.getElementById('pv-batch-input-wrap');
    const progWrap  = document.getElementById('pv-batch-progress-wrap');
    const rowsEl   = document.getElementById('pv-batch-rows');
    const summary  = document.getElementById('pv-batch-summary');
    const restartBtn = document.getElementById('pv-batch-restart');
    const doneBtn  = document.getElementById('pv-batch-done');

    function reset() {
      ta.value = '';
      counter.textContent = 'Sin entradas detectadas';
      startBtn.disabled = true;
      startBtn.style.opacity = '0.6';
      inputWrap.style.display = '';
      progWrap.style.display = 'none';
      rowsEl.innerHTML = '';
      summary.style.display = 'none';
      summary.innerHTML = '';
      restartBtn.style.display = 'none';
    }
    function open()  { reset(); modal.style.display = 'flex'; setTimeout(() => ta.focus(), 50); }
    function close() { modal.style.display = 'none'; loadArticles(); refreshStats(); }

    btn.addEventListener('click', open);
    cancelBtn.addEventListener('click', close);
    closeBtn.addEventListener('click', close);
    doneBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);
    restartBtn.addEventListener('click', reset);

    ta.addEventListener('input', () => {
      const entries = parseBatchEntries(ta.value);
      const doiN  = entries.filter(e => e.doi).length;
      const pmidN = entries.filter(e => e.pubmed_id).length;
      counter.textContent = entries.length
        ? `${entries.length} entrada${entries.length === 1 ? '' : 's'} · ${doiN} DOI · ${pmidN} PMID`
        : 'Sin entradas detectadas';
      startBtn.disabled = entries.length === 0;
      startBtn.style.opacity = entries.length === 0 ? '0.6' : '1';
    });

    startBtn.addEventListener('click', async () => {
      const entries = parseBatchEntries(ta.value);
      if (!entries.length) return;
      inputWrap.style.display = 'none';
      progWrap.style.display = '';
      rowsEl.innerHTML = '';

      const STATUS = {
        loading:   { icon: '…', color: '#3b82f6' },
        ok:        { icon: '✓', color: '#15803d' },
        duplicate: { icon: '△', color: '#b45309' },
        error:     { icon: '✗', color: '#b91c1c' },
      };

      const rowNodes = entries.map((e, i) => {
        const div = document.createElement('div');
        const label = e.doi || `PMID:${e.pubmed_id}`;
        div.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:5px 6px;border-radius:6px;font-size:12.5px;';
        div.innerHTML = `
          <span class="pv-batch-icon" style="width:14px;text-align:center;color:#9ca3af;font-weight:700;flex-shrink:0;">⏳</span>
          <div style="flex:1;min-width:0;">
            <div class="pv-batch-title" style="font-weight:500;color:#374151;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(label)}</div>
            <div class="pv-batch-meta" style="font-size:11.5px;color:#9ca3af;"></div>
          </div>`;
        rowsEl.appendChild(div);
        return div;
      });

      const counts = { ok: 0, duplicate: 0, error: 0 };

      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const node = rowNodes[i];
        const iconEl = node.querySelector('.pv-batch-icon');
        const titleEl = node.querySelector('.pv-batch-title');
        const metaEl = node.querySelector('.pv-batch-meta');
        iconEl.textContent = STATUS.loading.icon;
        iconEl.style.color = STATUS.loading.color;

        try {
          const r = await api('/articles/lookup', {
            method: 'POST',
            body: JSON.stringify(e),
          });
          if (!r.found) {
            iconEl.textContent = STATUS.error.icon;
            iconEl.style.color = STATUS.error.color;
            metaEl.textContent = 'No se encontraron metadatos';
            counts.error++;
            continue;
          }
          if (r.duplicate_of) {
            iconEl.textContent = STATUS.duplicate.icon;
            iconEl.style.color = STATUS.duplicate.color;
            titleEl.textContent = r.metadata.title || (e.doi || `PMID:${e.pubmed_id}`);
            metaEl.textContent = 'Ya existe en la biblioteca';
            counts.duplicate++;
            continue;
          }
          const m = r.metadata;
          await api('/articles', {
            method: 'POST',
            body: JSON.stringify({
              title:     m.title,
              authors:   m.authors,
              year:      m.year,
              journal:   m.journal,
              doi:       m.doi || e.doi || null,
              pubmed_id: m.pubmed_id || e.pubmed_id || null,
              abstract:  m.abstract,
            }),
          });
          iconEl.textContent = STATUS.ok.icon;
          iconEl.style.color = STATUS.ok.color;
          titleEl.textContent = m.title || (e.doi || `PMID:${e.pubmed_id}`);
          metaEl.textContent = [m.authors, m.year].filter(Boolean).join(' · ');
          counts.ok++;
        } catch (err) {
          if (err.status === 409) {
            iconEl.textContent = STATUS.duplicate.icon;
            iconEl.style.color = STATUS.duplicate.color;
            metaEl.textContent = 'Duplicado (DOI/PMID ya en la biblioteca)';
            counts.duplicate++;
          } else {
            iconEl.textContent = STATUS.error.icon;
            iconEl.style.color = STATUS.error.color;
            metaEl.textContent = err.message;
            counts.error++;
          }
        }
      }

      summary.innerHTML = `
        ${counts.ok        ? `<span style="color:#15803d;">✓ ${counts.ok} importado${counts.ok === 1 ? '' : 's'}</span>` : ''}
        ${counts.duplicate ? `<span style="color:#b45309;">△ ${counts.duplicate} duplicado${counts.duplicate === 1 ? '' : 's'}</span>` : ''}
        ${counts.error     ? `<span style="color:#b91c1c;">✗ ${counts.error} error${counts.error === 1 ? '' : 'es'}</span>` : ''}`;
      summary.style.display = 'flex';
      restartBtn.style.display = '';
    });
  }

  // ── Find duplicates ──────────────────────────────────────────────────
  function wireDuplicates() {
    const btn   = document.getElementById('btn-find-duplicates');
    const modal = document.getElementById('pv-dupes-modal');
    if (!btn || !modal) return;
    const closeBtn = document.getElementById('pv-dupes-close');
    const meta = document.getElementById('pv-dupes-meta');
    const list = document.getElementById('pv-dupes-list');

    function close() { modal.style.display = 'none'; }
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    btn.addEventListener('click', async () => {
      modal.style.display = 'flex';
      list.innerHTML = '';
      meta.textContent = 'Buscando duplicados…';
      try {
        const r = await api('/duplicates');
        if (!r.pairs.length) {
          meta.textContent = 'Sin duplicados detectados.';
          return;
        }
        meta.textContent = `${r.total} par${r.total === 1 ? '' : 'es'} sospechoso${r.total === 1 ? '' : 's'} encontrado${r.total === 1 ? '' : 's'} (ordenados por score).`;
        list.innerHTML = r.pairs.map(p => `
          <div style="border:1px solid #e5e7eb;border-radius:8px;padding:10px;margin-bottom:8px;background:#fafafa;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                ${p.reasons.map(r => `<span style="font-size:11px;padding:2px 7px;border-radius:5px;background:#fef3c7;color:#92400e;font-weight:600;">${esc(r)}</span>`).join('')}
              </div>
              <span style="font-size:11px;color:#6b7280;font-variant-numeric:tabular-nums;">score ${(p.score * 100).toFixed(0)}%</span>
            </div>
            ${[p.a, p.b].map(x => `
              <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;padding:6px 0;border-top:1px solid #f3f4f6;">
                <div style="flex:1;min-width:0;cursor:pointer;" data-open-aid="${esc(x.id)}">
                  <div style="font-size:13px;font-weight:600;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${supHtml(x.title || '(no title)')}</div>
                  <div style="font-size:11.5px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    ${esc(x.authors || '—')}${x.year ? ' · ' + x.year : ''}${x.journal ? ' · ' + esc(x.journal) : ''}
                  </div>
                  <div style="font-size:11px;color:#9ca3af;font-family:monospace;margin-top:2px;">
                    ${x.doi ? 'DOI ' + esc(x.doi) : ''}${x.doi && x.pubmed_id ? ' · ' : ''}${x.pubmed_id ? 'PMID ' + esc(x.pubmed_id) : ''}
                  </div>
                </div>
                <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">
                  <button class="pv-dup-open" data-aid="${esc(x.id)}"
                          style="padding:3px 8px;border-radius:5px;border:1px solid #d1d5db;background:white;font-size:11px;cursor:pointer;">Ver</button>
                  <button class="pv-dup-delete" data-aid="${esc(x.id)}"
                          style="padding:3px 8px;border-radius:5px;border:1px solid #fca5a5;background:white;color:#b91c1c;font-size:11px;cursor:pointer;">Borrar</button>
                </div>
              </div>`).join('')}
          </div>
        `).join('');

        list.querySelectorAll('.pv-dup-open').forEach(b => {
          b.addEventListener('click', () => openDetail(b.dataset.aid));
        });
        list.querySelectorAll('[data-open-aid]').forEach(el => {
          el.addEventListener('click', () => openDetail(el.dataset.openAid));
        });
        list.querySelectorAll('.pv-dup-delete').forEach(b => {
          b.addEventListener('click', async () => {
            if (!confirm('¿Borrar este artículo definitivamente? Se elimina también el PDF de Dropbox.')) return;
            b.disabled = true;
            b.textContent = '…';
            try {
              await api(`/articles/${b.dataset.aid}`, { method: 'DELETE' });
              const card = b.closest('div[style*="border:1px solid #e5e7eb"]');
              if (card) card.style.opacity = '0.5';
              b.textContent = 'Borrado';
            } catch (e) {
              b.textContent = 'Error';
              b.disabled = false;
              alert('Error al borrar: ' + e.message);
            }
          });
        });
      } catch (e) {
        meta.textContent = 'Error: ' + e.message;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
