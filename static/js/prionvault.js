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
    priorityEq: null,    // null = all, else integer 1-5 (exact match)
    extraction: null,    // null = all, 'extracted' | 'pending' | 'failed'
    isFavorite: null,    // null = all, true = only favorites, false = non-favorites
    isRead: null,        // null = all, true = personally read, false = unread
    page: 1,
    size: parseInt(localStorage.getItem('pv-page-size') || '100', 10) || 100,
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
      const base = err.error || ('HTTP ' + res.status);
      const msg  = err.detail ? `${base}: ${err.detail}` : base;
      const e = new Error(msg);
      e.status = res.status;
      e.detail = err.detail;
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
    if (state.priorityEq)          params.set('priority_eq', state.priorityEq);
    if (state.extraction)          params.set('extraction_status', state.extraction);
    if (state.isFavorite !== null) params.set('is_favorite', state.isFavorite ? '1' : '0');
    if (state.isRead     !== null) params.set('is_read',     state.isRead     ? '1' : '0');
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

    const ratingChip = (a.avg_rating != null && a.rating_count > 0)
      ? `<span title="Rating medio ${a.avg_rating.toFixed(1)}/5 · ${a.rating_count} valoración${a.rating_count === 1 ? '' : 'es'}${a.my_rating ? ' · tu rating: ' + a.my_rating + '/5' : ''}"
              style="display:inline-flex;align-items:center;gap:2px;padding:1px 6px;border-radius:4px;
                     font-size:10.5px;font-weight:600;background:#fef3c7;color:#92400e;">
           <span style="color:#f59e0b;">★</span>${a.avg_rating.toFixed(1)}
           <span style="color:#b45309;opacity:0.75;font-weight:500;">(${a.rating_count})</span>
         </span>`
      : '';

    const badges = [
      a.has_summary_ai
        ? '<span style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#dbeafe;color:#1d4ed8;">AI ✓</span>'
        : '',
      a.indexed_at
        ? '<span style="display:inline-flex;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;background:#dcfce7;color:#15803d;">indexed</span>'
        : '',
      ratingChip,
    ].filter(Boolean).join('');

    const authors = a.authors ? esc(a.authors) : '—';
    const journal = a.journal ? ` · ${esc(a.journal)}` : '';

    // ── Marks cell: flag + color dot + milestone (vertical stack) ────────
    const colorCss = a.color_label ? (COLOR_CSS[a.color_label] || '#9ca3af') : null;
    const flagColor = a.is_flagged ? '#e11d48' : '#e5e7eb';
    const flagTitle = a.is_flagged ? 'Marcada 🚩 — clic para quitar' : 'Marcar bandera';
    const milestoneColor = a.is_milestone ? '#f59e0b' : '#d1d5db';
    const colorTitle = a.color_label ? `Etiqueta: ${esc(a.color_label)}` : 'Sin etiqueta de color';

    const favColor  = a.is_favorite ? '#e11d48' : '#d1d5db';
    const readColor = a.is_read     ? '#15803d' : '#d1d5db';

    const marksCell = `
      <td style="padding:8px 8px;vertical-align:middle;text-align:center;">
        <div style="display:flex;align-items:center;justify-content:center;gap:6px;">
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
          <span style="width:1px;height:14px;background:#e5e7eb;"></span>
          <button class="pv-favorite-btn"
                  data-active="${a.is_favorite ? '1' : '0'}"
                  title="${a.is_favorite ? 'Quitar de mis favoritos' : 'Añadir a mis favoritos'}"
                  style="background:none;border:none;padding:0;font-size:14px;line-height:1;cursor:pointer;
                         color:${favColor};">${a.is_favorite ? '♥' : '♡'}</button>
          <button class="pv-read-btn"
                  data-active="${a.is_read ? '1' : '0'}"
                  title="${a.is_read ? 'Marcar como no leído' : 'Marcar como leído por mí'}"
                  style="background:none;border:none;padding:0;font-size:13px;line-height:1;cursor:pointer;
                         color:${readColor};font-weight:700;">✓</button>
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
      ? `<button type="button" class="pv-pdf-pill"
                 title="PDF disponible — clic para abrir el visor"
                 style="display:inline-flex;align-items:center;padding:1px 6px;border-radius:5px;
                        font-size:10.5px;font-weight:600;background:#fee2e2;color:#b91c1c;
                        border:none;cursor:pointer;">PDF</button>`
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

    const pdfPill = row.querySelector('.pv-pdf-pill');
    if (pdfPill) pdfPill.addEventListener('click', e => {
      e.stopPropagation();
      openDetail(a.id, { openPdf: true });
    });

    row.querySelector('.pv-favorite-btn').addEventListener('click', async e => {
      e.stopPropagation();
      const btn = e.currentTarget;
      const next = btn.dataset.active !== '1';
      btn.disabled = true;
      try {
        const r = await api(`/articles/${a.id}/favorite`, {
          method: 'POST',
          body: JSON.stringify({ value: next }),
        });
        a.is_favorite = !!r.is_favorite;
        replaceRow(row, a);
      } catch (err) {
        btn.disabled = false;
        alert('Error: ' + err.message);
      }
    });

    row.querySelector('.pv-read-btn').addEventListener('click', async e => {
      e.stopPropagation();
      const btn = e.currentTarget;
      const next = btn.dataset.active !== '1';
      btn.disabled = true;
      try {
        const r = await api(`/articles/${a.id}/read`, {
          method: 'POST',
          body: JSON.stringify({ value: next }),
        });
        a.is_read = !!r.is_read;
        a.read_at = r.read_at || null;
        replaceRow(row, a);
      } catch (err) {
        btn.disabled = false;
        alert('Error: ' + err.message);
      }
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
  async function openDetail(aid, options = {}) {
    const modal   = document.getElementById('pv-detail-modal');
    const content = document.getElementById('pv-detail-content');
    _pdfViewerOpen = !!options.openPdf;
    const inner = modal.querySelector('.pv-modal-inner');
    if (inner) inner.style.maxWidth = '';
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

      const personalChips = `
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px;align-items:center;">
          <button id="pv-detail-fav" type="button"
                  data-active="${a.is_favorite ? '1' : '0'}"
                  style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;
                         font-size:12px;font-weight:600;cursor:pointer;
                         ${a.is_favorite
                           ? 'background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;'
                           : 'background:#f9fafb;color:#6b7280;border:1px solid #e5e7eb;'}">
            <span style="font-size:14px;line-height:1;color:${a.is_favorite ? '#e11d48' : '#9ca3af'};">${a.is_favorite ? '♥' : '♡'}</span>
            ${a.is_favorite ? 'En favoritos' : 'Añadir a favoritos'}
          </button>
          <button id="pv-detail-read" type="button"
                  data-active="${a.is_read ? '1' : '0'}"
                  style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;
                         font-size:12px;font-weight:600;cursor:pointer;
                         ${a.is_read
                           ? 'background:#dcfce7;color:#15803d;border:1px solid #86efac;'
                           : 'background:#f9fafb;color:#6b7280;border:1px solid #e5e7eb;'}">
            <span style="font-size:13px;font-weight:800;line-height:1;color:${a.is_read ? '#15803d' : '#9ca3af'};">✓</span>
            ${a.is_read ? 'Leído por mí' : 'Marcar como leído'}
          </button>
        </div>`;

      content.innerHTML = `
        <h2 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#111827;line-height:1.35;padding-right:24px;">
          ${supHtml(a.title)}
        </h2>
        ${prionreadBadge}
        ${personalChips}
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
        <div id="pv-ai-summary-block" style="margin:0 0 16px;"></div>
        ${a.summary_human ? `
          <h3 style="font-size:14px;font-weight:600;color:#374151;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.05em;">Human notes</h3>
          <p style="font-size:14px;color:#4b5563;line-height:1.65;margin:0 0 16px;">${supHtml(a.summary_human)}</p>
        ` : ''}
        ${a.has_pdf ? `
          <div id="pv-pdf-toolbar" style="margin:0 0 14px;display:flex;align-items:center;gap:8px;">
            <button id="pv-pdf-toggle" type="button"
                    style="padding:6px 12px;border-radius:7px;border:1px solid #d1d5db;background:white;
                           font-size:13px;font-weight:600;color:#374151;cursor:pointer;
                           display:inline-flex;align-items:center;gap:6px;">
              <i class="fas fa-file-pdf" style="color:#b91c1c;"></i>
              <span id="pv-pdf-toggle-label">Ver PDF</span>
            </button>
            <a href="/prionvault/api/articles/${esc(a.id)}/pdf" target="_blank" rel="noopener noreferrer"
               title="Abrir el PDF en pestaña nueva"
               style="font-size:12px;color:#0F3460;text-decoration:none;">
              <i class="fas fa-up-right-from-square" style="margin-right:3px;"></i>nueva pestaña
            </a>
          </div>
          <div id="pv-pdf-viewer" style="display:none;margin:0 0 16px;
                                          border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;
                                          background:#1f2937;"></div>
        ` : (IS_ADMIN && a.doi ? `
          <div id="pv-unpaywall-toolbar" style="margin:0 0 14px;display:flex;align-items:center;gap:8px;">
            <button id="pv-unpaywall-btn" type="button"
                    style="padding:6px 12px;border-radius:7px;border:1px solid #d1d5db;background:white;
                           font-size:13px;font-weight:600;color:#374151;cursor:pointer;
                           display:inline-flex;align-items:center;gap:6px;">
              <i class="fas fa-cloud-arrow-down" style="color:#0F3460;"></i>
              <span>Try Unpaywall</span>
            </button>
            <span id="pv-unpaywall-status" style="font-size:12px;color:#6b7280;"></span>
          </div>
        ` : '')}
        ${tagHtml}
        <div id="pv-ratings-section" style="margin-top:22px;padding-top:14px;border-top:1px solid #f3f4f6;"></div>
        <div id="pv-similar-section" style="margin-top:18px;padding-top:14px;border-top:1px solid #f3f4f6;"></div>
        <div id="pv-supplementary-section" style="margin-top:18px;padding-top:14px;border-top:1px solid #f3f4f6;"></div>
        <div id="pv-used-in-section" style="margin-top:18px;padding-top:14px;border-top:1px solid #f3f4f6;"></div>
        <div style="margin-top:18px;padding-top:14px;border-top:1px solid #f3f4f6;">
          <button id="pv-add-to-pack-btn" type="button"
                  style="padding:7px 14px;border-radius:8px;border:1px solid #d1d5db;background:white;
                         font-size:13px;font-weight:600;color:#0F3460;cursor:pointer;
                         display:inline-flex;align-items:center;gap:6px;">
            <i class="fas fa-cubes-stacked"></i>
            <span>Add to PrionPack</span>
          </button>
        </div>
        <div style="margin-top:20px;padding-top:14px;border-top:1px solid #f3f4f6;
                    font-size:12px;color:#9ca3af;font-family:ui-monospace,monospace;">
          Added: ${a.added_at ? esc(a.added_at.slice(0, 10)) : '—'}
          · Status: ${esc(a.extraction_status || 'pending')}
          ${a.indexed_at ? ' · Indexed: ' + esc(a.indexed_at.slice(0, 10)) : ''}
        </div>
      `;
      renderRatingsSection(a);
      wirePdfViewer(a);
      wirePersonalState(a);
      renderAiSummary(a);
      wireUnpaywallButton(a);
      wireAddToPackButton(a);
      renderSimilarSection(a);
      renderSupplementarySection(a);
      renderUsedInSection(a);
    } catch (e) {
      content.innerHTML = `<div style="color:#b91c1c;padding:20px;">Error: ${esc(e.message)}</div>`;
    }
  }

  // ── Ratings widget ────────────────────────────────────────────────────
  function starHtml(n, filled, clickable) {
    return Array.from({ length: 5 }, (_, i) => {
      const isFilled = i < n;
      return `<button type="button" class="${clickable ? 'pv-rate-star' : ''}" data-value="${i + 1}"
              ${clickable ? '' : 'disabled'}
              style="background:none;border:none;padding:0 1px;font-size:18px;line-height:1;
                     cursor:${clickable ? 'pointer' : 'default'};
                     color:${isFilled ? '#f59e0b' : '#d1d5db'};">★</button>`;
    }).join('');
  }

  function staticStars(n) {
    return Array.from({ length: 5 }, (_, i) =>
      `<span style="color:${i < n ? '#f59e0b' : '#d1d5db'};font-size:13px;">★</span>`
    ).join('');
  }

  function renderRatingsSection(a) {
    const sec = document.getElementById('pv-ratings-section');
    if (!sec) return;

    const ratings = a.ratings || [];
    const avg     = a.avg_rating;
    const count   = a.rating_count || 0;
    const myRating = a.my_rating || 0;
    const myItem   = ratings.find(r => r.is_own) || null;
    const others   = ratings.filter(r => !r.is_own);

    const avgHtml = (avg != null)
      ? `<div style="display:flex;align-items:center;gap:8px;">
           <span style="font-size:18px;font-weight:700;color:#f59e0b;font-variant-numeric:tabular-nums;">${avg.toFixed(1)}</span>
           <span>${staticStars(Math.round(avg))}</span>
           <span style="font-size:12px;color:#6b7280;">${count} rating${count === 1 ? '' : 's'}</span>
         </div>`
      : '<div style="font-size:13px;color:#9ca3af;">Sin valoraciones aún.</div>';

    sec.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <h3 style="margin:0;font-size:14px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:0.05em;">Ratings</h3>
        ${avgHtml}
      </div>

      <div id="pv-rate-me" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin-bottom:14px;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span style="font-size:12.5px;font-weight:600;color:#374151;">Tu valoración:</span>
          <span id="pv-rate-stars" style="display:inline-flex;">${starHtml(myRating, true, true)}</span>
          <span id="pv-rate-current" style="font-size:12px;color:#6b7280;">${myRating ? myRating + '/5' : 'sin valorar'}</span>
          ${myItem ? `<button id="pv-rate-delete" type="button"
                              style="margin-left:auto;background:none;border:none;color:#b91c1c;font-size:12px;cursor:pointer;">Borrar mi rating</button>` : ''}
        </div>
        <textarea id="pv-rate-comment" rows="2" placeholder="Comentario opcional (máx 500 caracteres)…"
                  maxlength="500"
                  style="margin-top:8px;width:100%;padding:6px 9px;border:1px solid #d1d5db;border-radius:6px;
                         font-size:13px;font-family:inherit;resize:vertical;">${esc(myItem?.comment || '')}</textarea>
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
          <button id="pv-rate-save" type="button" disabled
                  style="padding:5px 12px;border-radius:6px;border:none;background:#0F3460;color:white;
                         font-size:12.5px;font-weight:600;cursor:pointer;opacity:0.5;">Guardar</button>
          <span id="pv-rate-status" style="font-size:11.5px;color:#9ca3af;"></span>
        </div>
      </div>

      ${others.length ? `
        <div>
          <div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">Otras valoraciones</div>
          ${others.map(r => `
            <div style="display:flex;gap:10px;padding:8px 0;border-top:1px solid #f3f4f6;">
              ${r.user_photo
                ? `<img src="${esc(r.user_photo)}" alt="" style="width:28px;height:28px;border-radius:50%;flex-shrink:0;object-fit:cover;">`
                : `<div style="width:28px;height:28px;border-radius:50%;background:#e5e7eb;color:#6b7280;
                              display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;">
                     ${esc((r.user_name || '?').slice(0, 1).toUpperCase())}
                   </div>`}
              <div style="flex:1;min-width:0;">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                  <span style="font-size:12.5px;font-weight:600;color:#111827;">${esc(r.user_name)}</span>
                  <span>${staticStars(r.rating)}</span>
                  <span style="font-size:11px;color:#9ca3af;font-variant-numeric:tabular-nums;">
                    ${r.updated_at ? r.updated_at.slice(0, 10) : ''}
                  </span>
                </div>
                ${r.comment
                  ? `<p style="margin:3px 0 0;font-size:12.5px;color:#4b5563;line-height:1.5;">${esc(r.comment)}</p>`
                  : ''}
              </div>
            </div>`).join('')}
        </div>` : ''}
    `;

    // ── Wiring ───────────────────────────────────────────────────────────
    let selected = myRating;
    let originalComment = myItem?.comment || '';
    const starsEl  = sec.querySelector('#pv-rate-stars');
    const currentEl = sec.querySelector('#pv-rate-current');
    const commentEl = sec.querySelector('#pv-rate-comment');
    const saveBtn   = sec.querySelector('#pv-rate-save');
    const statusEl  = sec.querySelector('#pv-rate-status');

    function paintStars(value) {
      starsEl.innerHTML = starHtml(value, true, true);
      starsEl.querySelectorAll('.pv-rate-star').forEach(b => b.addEventListener('click', () => {
        const clicked = parseInt(b.dataset.value, 10);
        // Click on the same value that is already selected → clear it,
        // so the user can back out of a preview without saving.
        selected = (selected === clicked) ? 0 : clicked;
        paintStars(selected);
        currentEl.textContent = selected > 0 ? selected + '/5' : 'sin valorar';
        updateSaveState();
      }));
    }
    function updateSaveState() {
      const changed = (selected !== myRating) ||
                      ((commentEl.value || '') !== originalComment);
      const valid   = selected >= 1 && selected <= 5;
      saveBtn.disabled = !(changed && valid);
      saveBtn.style.opacity = saveBtn.disabled ? '0.5' : '1';
    }
    paintStars(selected);
    commentEl.addEventListener('input', updateSaveState);

    saveBtn.addEventListener('click', async () => {
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;
      statusEl.textContent = 'Guardando…';
      statusEl.style.color = '#6b7280';
      try {
        const r = await api(`/articles/${a.id}/ratings`, {
          method: 'POST',
          body: JSON.stringify({ rating: selected, comment: commentEl.value.trim() }),
        });
        // Refresh the section with new data without closing the modal.
        a.ratings      = r.ratings;
        a.avg_rating   = r.avg_rating;
        a.rating_count = r.total;
        a.my_rating    = selected;
        renderRatingsSection(a);
      } catch (e) {
        statusEl.textContent = 'Error: ' + e.message;
        statusEl.style.color = '#b91c1c';
        saveBtn.disabled = false;
      }
    });

    const delBtn = sec.querySelector('#pv-rate-delete');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!confirm('¿Borrar tu valoración para este artículo?')) return;
        delBtn.disabled = true;
        try {
          const r = await api(`/articles/${a.id}/ratings`, { method: 'DELETE' });
          a.ratings      = r.ratings;
          a.avg_rating   = r.avg_rating;
          a.rating_count = r.total;
          a.my_rating    = null;
          renderRatingsSection(a);
        } catch (e) {
          alert('Error al borrar: ' + e.message);
          delBtn.disabled = false;
        }
      });
    }
  }

  // ── PDF viewer (inline) ──────────────────────────────────────────────
  // Tracks whether the user explicitly opened the PDF for THIS modal
  // session, so re-rendering the ratings section doesn't lose it.
  let _pdfViewerOpen = false;
  function wirePdfViewer(a) {
    if (!a.has_pdf) return;
    const toggle  = document.getElementById('pv-pdf-toggle');
    const label   = document.getElementById('pv-pdf-toggle-label');
    const viewer  = document.getElementById('pv-pdf-viewer');
    const inner   = document.querySelector('#pv-detail-modal .pv-modal-inner');
    if (!toggle || !viewer) return;

    function setOpen(open) {
      _pdfViewerOpen = open;
      if (open) {
        if (!viewer.querySelector('iframe')) {
          viewer.innerHTML = `<iframe src="/prionvault/api/articles/${esc(a.id)}/pdf"
                                       style="display:block;width:100%;height:78vh;border:0;background:#1f2937;"
                                       title="PDF: ${esc(a.title || '')}"></iframe>`;
        }
        viewer.style.display = 'block';
        label.textContent = 'Ocultar PDF';
        if (inner) inner.style.maxWidth = '1100px';
      } else {
        viewer.style.display = 'none';
        label.textContent = 'Ver PDF';
        if (inner) inner.style.maxWidth = '';
      }
    }
    toggle.addEventListener('click', () => setOpen(!_pdfViewerOpen));
    // Honour the previously-open state when this is a re-render
    // triggered by a rating save/delete.
    if (_pdfViewerOpen) setOpen(true);
  }

  // ── Try Unpaywall (per-article) ──────────────────────────────────────
  function wireUnpaywallButton(a) {
    const btn = document.getElementById('pv-unpaywall-btn');
    const stEl = document.getElementById('pv-unpaywall-status');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const labelEl = btn.querySelector('span');
      const original = labelEl.textContent;
      labelEl.textContent = 'Consultando…';
      stEl.style.color = '#6b7280';
      stEl.textContent = '';
      try {
        const r = await api(`/articles/${a.id}/fetch-pdf`, { method: 'POST' });
        if (r.ok) {
          stEl.style.color = '#15803d';
          const sizeKb = Math.round((r.size_bytes || 0) / 1024);
          stEl.textContent = `✓ Encolado (${esc(r.host_type || 'OA')}, ${sizeKb} KB). El worker lo procesa en background.`;
          labelEl.textContent = 'Encolado';
        } else {
          stEl.style.color = '#b45309';
          if (r.is_oa && r.landing_url) {
            stEl.innerHTML = `⚠️ ${esc(r.reason || 'sin PDF directo')} · ` +
              `<a href="${esc(r.landing_url)}" target="_blank" rel="noopener noreferrer" style="color:#0F3460;">ver landing</a>`;
          } else {
            stEl.textContent = `⚠️ ${r.reason === 'not_open_access' ? 'No disponible en open access' : (r.reason || 'sin PDF')}`;
          }
          labelEl.textContent = original;
          btn.disabled = false;
        }
      } catch (e) {
        stEl.style.color = '#b91c1c';
        if (e.status === 503) {
          stEl.textContent = 'Unpaywall no disponible — falta UNPAYWALL_EMAIL en el servidor.';
        } else if (e.status === 409) {
          stEl.textContent = 'Este artículo ya tiene PDF.';
        } else {
          stEl.textContent = 'Error: ' + e.message;
        }
        labelEl.textContent = original;
        btn.disabled = false;
      }
    });
  }

  // ── Papers parecidos a este (vector neighbours) ──────────────────────
  async function renderSimilarSection(a) {
    const sec = document.getElementById('pv-similar-section');
    if (!sec) return;
    sec.innerHTML = `
      <h3 style="margin:0 0 8px;font-size:14px;font-weight:600;color:#374151;
                 text-transform:uppercase;letter-spacing:0.05em;">Papers parecidos</h3>
      <div style="font-size:12.5px;color:#9ca3af;">Buscando vecinos vectoriales…</div>`;

    let data;
    try {
      data = await api(`/articles/${a.id}/similar?limit=8`);
    } catch (e) {
      sec.innerHTML = `
        <h3 style="margin:0 0 8px;font-size:14px;font-weight:600;color:#374151;
                   text-transform:uppercase;letter-spacing:0.05em;">Papers parecidos</h3>
        <div style="font-size:12.5px;color:#b91c1c;">Error: ${esc(e.message)}</div>`;
      return;
    }

    const items = data.items || [];
    if (!items.length) {
      sec.innerHTML = `
        <h3 style="margin:0 0 8px;font-size:14px;font-weight:600;color:#374151;
                   text-transform:uppercase;letter-spacing:0.05em;">Papers parecidos</h3>
        <div style="font-size:12.5px;color:#9ca3af;font-style:italic;
                    background:#f9fafb;border-radius:8px;padding:10px 12px;">
          Aún no hay vecinos disponibles. Asegúrate de que este artículo y otros
          de la biblioteca están indexados (Tools → Index for AI search).
        </div>`;
      return;
    }

    sec.innerHTML = `
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0 0 8px;">
        <h3 style="margin:0;font-size:14px;font-weight:600;color:#374151;
                   text-transform:uppercase;letter-spacing:0.05em;">Papers parecidos</h3>
        <span style="font-size:11px;color:#9ca3af;">${items.length} resultado${items.length === 1 ? '' : 's'}</span>
      </div>
      ${items.map(it => {
        const simPct = Math.round((it.similarity || 0) * 100);
        const headerBits = [
          it.authors ? esc((it.authors || '').slice(0, 110)) : '',
          it.year || '',
          it.journal ? esc(it.journal) : '',
        ].filter(Boolean).join(' · ');
        const flags = [
          it.has_summary_ai
            ? `<span title="Tiene resumen IA" style="font-size:10.5px;color:#1d4ed8;background:#dbeafe;padding:1px 5px;border-radius:4px;font-weight:600;">AI ✓</span>`
            : '',
          it.has_pdf
            ? `<span title="Tiene PDF" style="font-size:10.5px;color:#b91c1c;background:#fee2e2;padding:1px 5px;border-radius:4px;font-weight:600;">PDF</span>`
            : '',
        ].filter(Boolean).join(' ');
        return `
          <div class="pv-similar-row" data-aid="${esc(it.id)}"
               style="display:flex;align-items:center;gap:10px;padding:8px 10px;
                      background:#fafafa;border:1px solid #e5e7eb;border-radius:7px;margin-bottom:5px;
                      cursor:pointer;transition:background 0.1s;"
               onmouseover="this.style.background='#fff'" onmouseout="this.style.background='#fafafa'">
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;color:#111827;
                          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${supHtml(it.title || '(sin título)')}
              </div>
              <div style="font-size:11.5px;color:#6b7280;
                          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${headerBits || '—'}</div>
            </div>
            <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
              ${flags}
              <span title="Distancia coseno: ${it.distance != null ? it.distance.toFixed(3) : '—'}"
                    style="font-size:11px;color:#15803d;background:#dcfce7;padding:1px 6px;border-radius:5px;
                           font-weight:600;font-variant-numeric:tabular-nums;">${simPct}%</span>
            </div>
          </div>`;
      }).join('')}
    `;

    sec.querySelectorAll('.pv-similar-row').forEach(row => {
      row.addEventListener('click', () => openDetail(row.dataset.aid));
    });
  }

  // ── Supplementary material ────────────────────────────────────────────
  const SUPP_ICONS = {
    pdf:     'fa-file-pdf',     xlsx:    'fa-file-excel',
    csv:     'fa-file-csv',     txt:     'fa-file-lines',
    doc:     'fa-file-word',    ppt:     'fa-file-powerpoint',
    video:   'fa-file-video',   image:   'fa-file-image',
    archive: 'fa-file-zipper',  data:    'fa-file-code',
    other:   'fa-file',
  };
  const SUPP_COLORS = {
    pdf:     '#b91c1c', xlsx:    '#15803d', csv:     '#15803d',
    txt:     '#6b7280', doc:     '#1d4ed8', ppt:     '#c2410c',
    video:   '#7c3aed', image:   '#0e7490', archive: '#92400e',
    data:    '#374151', other:   '#6b7280',
  };
  function fmtBytes(n) {
    if (!n || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  async function renderSupplementarySection(a) {
    const sec = document.getElementById('pv-supplementary-section');
    if (!sec) return;
    const admin = IS_ADMIN;

    const heading = `
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0 0 8px;">
        <h3 style="margin:0;font-size:14px;font-weight:600;color:#374151;
                   text-transform:uppercase;letter-spacing:0.05em;">Material suplementario</h3>
        ${admin ? `<button id="pv-supp-add-btn" type="button"
                      style="padding:4px 10px;font-size:12px;border-radius:6px;border:1px solid #d1d5db;
                             background:white;color:#0F3460;font-weight:600;cursor:pointer;">
                      <i class="fas fa-plus" style="margin-right:4px;"></i>Añadir
                    </button>` : ''}
      </div>`;
    sec.innerHTML = heading +
      `<div id="pv-supp-list" style="font-size:12.5px;color:#9ca3af;">Cargando…</div>`;

    if (admin) wireSupplementaryUpload(a);

    let data;
    try {
      data = await api(`/articles/${a.id}/supplementary`);
    } catch (e) {
      document.getElementById('pv-supp-list').innerHTML =
        `<div style="color:#b91c1c;">Error: ${esc(e.message)}</div>`;
      return;
    }
    renderSupplementaryList(a, data.items || [], admin);
  }

  function renderSupplementaryList(a, items, admin) {
    const list = document.getElementById('pv-supp-list');
    if (!list) return;
    if (!items.length) {
      list.innerHTML = `
        <div style="font-size:12.5px;color:#9ca3af;font-style:italic;
                    background:#f9fafb;border-radius:8px;padding:10px 12px;">
          Sin material suplementario.${admin ? ' Pulsa "Añadir" para subir un archivo.' : ''}
        </div>`;
      return;
    }

    list.innerHTML = items.map(it => {
      const icon  = SUPP_ICONS[it.kind] || SUPP_ICONS.other;
      const color = SUPP_COLORS[it.kind] || SUPP_COLORS.other;
      const meta  = [it.kind.toUpperCase(), fmtBytes(it.size_bytes)]
        .filter(Boolean).join(' · ');
      return `
        <div class="pv-supp-row" data-sid="${esc(it.id)}"
             style="display:flex;align-items:flex-start;gap:10px;padding:9px 11px;
                    background:#fafafa;border:1px solid #e5e7eb;border-radius:7px;margin-bottom:6px;">
          <i class="fas ${icon}" style="color:${color};font-size:18px;flex-shrink:0;
                                          padding-top:1px;width:18px;text-align:center;"></i>
          <div style="flex:1;min-width:0;">
            <a href="#" data-action="open" data-sid="${esc(it.id)}"
               style="font-size:13px;font-weight:600;color:#0F3460;text-decoration:none;
                      display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              ${esc(it.filename)}
            </a>
            <div style="font-size:11px;color:#9ca3af;margin-top:1px;">${esc(meta)}</div>
            ${it.caption
              ? `<div class="pv-supp-caption" data-sid="${esc(it.id)}"
                       style="font-size:12px;color:#374151;margin-top:4px;
                              white-space:pre-wrap;word-break:break-word;">${esc(it.caption)}</div>`
              : admin
                ? `<div class="pv-supp-caption pv-supp-caption-empty" data-sid="${esc(it.id)}"
                         style="font-size:11.5px;color:#9ca3af;font-style:italic;margin-top:4px;cursor:pointer;">
                       Añadir descripción…
                     </div>`
                : ''}
          </div>
          ${admin ? `
            <div style="display:flex;gap:4px;flex-shrink:0;">
              <button type="button" data-action="edit" data-sid="${esc(it.id)}"
                      title="Editar descripción"
                      style="padding:3px 6px;background:transparent;border:1px solid transparent;
                             border-radius:5px;color:#6b7280;cursor:pointer;font-size:12px;">
                <i class="fas fa-pen"></i>
              </button>
              <button type="button" data-action="delete" data-sid="${esc(it.id)}"
                      title="Eliminar"
                      style="padding:3px 6px;background:transparent;border:1px solid transparent;
                             border-radius:5px;color:#b91c1c;cursor:pointer;font-size:12px;">
                <i class="fas fa-trash"></i>
              </button>
            </div>` : ''}
        </div>`;
    }).join('');

    list.querySelectorAll('[data-action="open"]').forEach(el =>
      el.addEventListener('click', async ev => {
        ev.preventDefault();
        const sid = ev.currentTarget.dataset.sid;
        try {
          const r = await api(`/articles/${a.id}/supplementary/${sid}/url`);
          if (r.url) window.open(r.url, '_blank', 'noopener');
        } catch (e) {
          alert('No se pudo abrir el archivo: ' + e.message);
        }
      }));

    if (admin) {
      list.querySelectorAll('[data-action="edit"], .pv-supp-caption').forEach(el =>
        el.addEventListener('click', ev => {
          const sid = ev.currentTarget.dataset.sid;
          const item = items.find(x => x.id === sid);
          if (!item) return;
          const next = prompt('Descripción del archivo:', item.caption || '');
          if (next === null) return;
          patchSupplementaryCaption(a, sid, next.trim(), items);
        }));
      list.querySelectorAll('[data-action="delete"]').forEach(el =>
        el.addEventListener('click', async ev => {
          const sid  = ev.currentTarget.dataset.sid;
          const item = items.find(x => x.id === sid);
          if (!item) return;
          if (!confirm(`¿Eliminar "${item.filename}"?`)) return;
          try {
            await api(`/articles/${a.id}/supplementary/${sid}`, { method: 'DELETE' });
            renderSupplementarySection(a);
          } catch (e) {
            alert('Error al eliminar: ' + e.message);
          }
        }));
    }
  }

  async function patchSupplementaryCaption(a, sid, caption, items) {
    try {
      await api(`/articles/${a.id}/supplementary/${sid}`, {
        method: 'PATCH',
        body: JSON.stringify({ caption }),
      });
      const item = items.find(x => x.id === sid);
      if (item) item.caption = caption;
      renderSupplementaryList(a, items, IS_ADMIN);
    } catch (e) {
      alert('Error guardando descripción: ' + e.message);
    }
  }

  function wireSupplementaryUpload(a) {
    const btn = document.getElementById('pv-supp-add-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.style.display = 'none';
      input.addEventListener('change', async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        const caption = prompt(
          `Descripción para "${f.name}" (opcional):`, '');
        if (caption === null) return;            // cancelled
        const fd = new FormData();
        fd.append('file', f, f.name);
        if (caption.trim()) fd.append('caption', caption.trim());
        btn.disabled = true;
        const original = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Subiendo…';
        try {
          const r = await fetch(API + `/articles/${a.id}/supplementary`, {
            method: 'POST',
            credentials: 'same-origin',
            body: fd,
          });
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            throw new Error(err.detail || err.error || ('HTTP ' + r.status));
          }
          renderSupplementarySection(a);
        } catch (e) {
          alert('Error subiendo el archivo: ' + e.message);
        } finally {
          btn.disabled = false;
          btn.innerHTML = original;
        }
      });
      document.body.appendChild(input);
      input.click();
      setTimeout(() => input.remove(), 5000);
    });
  }

  // ── Used in: PrionPacks + student assignments ────────────────────────
  const USED_IN_STATUS_COLOR = {
    pending:    { bg: '#fef3c7', fg: '#92400e' },
    read:       { bg: '#dbeafe', fg: '#1d4ed8' },
    summarized: { bg: '#ede9fe', fg: '#6d28d9' },
    evaluated:  { bg: '#dcfce7', fg: '#15803d' },
  };

  async function renderUsedInSection(a) {
    const sec = document.getElementById('pv-used-in-section');
    if (!sec) return;
    sec.innerHTML = `
      <h3 style="margin:0 0 6px;font-size:14px;font-weight:600;color:#374151;
                 text-transform:uppercase;letter-spacing:0.05em;">Used in</h3>
      <div style="font-size:12.5px;color:#9ca3af;">Cargando…</div>`;

    let data;
    try {
      data = await api(`/articles/${a.id}/used-in`);
    } catch (e) {
      sec.innerHTML = `
        <h3 style="margin:0 0 6px;font-size:14px;font-weight:600;color:#374151;
                   text-transform:uppercase;letter-spacing:0.05em;">Used in</h3>
        <div style="font-size:12.5px;color:#b91c1c;">Error: ${esc(e.message)}</div>`;
      return;
    }

    const packs = data.packs || [];
    const students = data.students || [];

    const targetChip = (t) => {
      const label = t === 'intro' ? 'Intro' : 'Generales';
      const bg = t === 'intro' ? '#e0e7ff' : '#dcfce7';
      const fg = t === 'intro' ? '#3730a3' : '#15803d';
      return `<span style="display:inline-flex;align-items:center;font-size:10.5px;font-weight:600;
                           padding:1px 7px;border-radius:5px;background:${bg};color:${fg};">${label}</span>`;
    };

    const packsHtml = packs.length
      ? packs.map(p => `
          <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;
                      background:#fafafa;border:1px solid #e5e7eb;border-radius:7px;margin-bottom:5px;">
            <i class="fas fa-cubes-stacked" style="color:#0F3460;font-size:12px;flex-shrink:0;"></i>
            <div style="flex:1;min-width:0;">
              <div style="font-size:12.5px;font-weight:600;color:#111827;
                          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${esc(p.id)} · ${esc(p.title || '(sin título)')}
              </div>
              ${p.responsible ? `<div style="font-size:11px;color:#6b7280;">${esc(p.responsible)}${p.type ? ' · ' + esc(p.type) : ''}</div>` : ''}
            </div>
            <div style="display:flex;gap:4px;flex-shrink:0;">${(p.lists || []).map(targetChip).join('')}</div>
          </div>`).join('')
      : '';

    const studentsHtml = students.length
      ? students.map(st => {
          const c = USED_IN_STATUS_COLOR[st.status] || { bg: '#f3f4f6', fg: '#6b7280' };
          const initial = (st.name || '?').slice(0, 1).toUpperCase();
          const avatar = st.photo_url
            ? `<img src="${esc(st.photo_url)}" alt="" style="width:24px;height:24px;border-radius:50%;flex-shrink:0;object-fit:cover;">`
            : `<div style="width:24px;height:24px;border-radius:50%;background:#e5e7eb;color:#6b7280;
                          display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;">${esc(initial)}</div>`;
          const dateStr = st.updated_at ? st.updated_at.slice(0, 10) : '';
          return `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;
                        background:#fafafa;border:1px solid #e5e7eb;border-radius:7px;margin-bottom:5px;">
              ${avatar}
              <div style="flex:1;min-width:0;">
                <div style="font-size:12.5px;font-weight:600;color:#111827;
                            white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(st.name)}</div>
                ${st.email ? `<div style="font-size:11px;color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(st.email)}</div>` : ''}
              </div>
              <span style="display:inline-flex;align-items:center;font-size:10.5px;font-weight:600;
                           padding:1px 7px;border-radius:5px;background:${c.bg};color:${c.fg};">${esc(st.status || '—')}</span>
              ${dateStr ? `<span style="font-size:10.5px;color:#9ca3af;font-variant-numeric:tabular-nums;">${dateStr}</span>` : ''}
            </div>`;
        }).join('')
      : '';

    const hasAny = packs.length || students.length;

    sec.innerHTML = `
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0 0 8px;">
        <h3 style="margin:0;font-size:14px;font-weight:600;color:#374151;
                   text-transform:uppercase;letter-spacing:0.05em;">Used in</h3>
        <span style="font-size:11px;color:#9ca3af;">
          ${packs.length} pack${packs.length === 1 ? '' : 's'} · ${students.length} estudiante${students.length === 1 ? '' : 's'}
        </span>
      </div>
      ${!hasAny ? `
        <div style="font-size:12.5px;color:#9ca3af;font-style:italic;
                    background:#f9fafb;border-radius:8px;padding:10px 12px;">
          Este artículo todavía no aparece en ningún PrionPack activo ni está asignado a estudiantes.
        </div>` : ''}
      ${packs.length ? `
        <div style="margin-bottom:10px;">
          <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:5px;">
            PrionPacks (${packs.length})
          </div>
          ${packsHtml}
        </div>` : ''}
      ${students.length ? `
        <div>
          <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:5px;">
            Asignado a estudiantes (${students.length})
          </div>
          ${studentsHtml}
        </div>` : ''}
    `;
  }

  // ── Add to PrionPack (per-article) ───────────────────────────────────
  function wireAddToPackButton(a) {
    const btn   = document.getElementById('pv-add-to-pack-btn');
    const modal = document.getElementById('pv-pack-modal');
    if (!btn || !modal) return;

    const listEl   = document.getElementById('pv-pack-list');
    const statusEl = document.getElementById('pv-pack-status');
    const saveBtn  = document.getElementById('pv-pack-save');
    const closeBtn = document.getElementById('pv-pack-close');
    const cancelBtn = document.getElementById('pv-pack-cancel');

    let packs = [];
    const selections = new Map();  // pack_id -> Set of "intro"|"general"

    function refreshSaveState() {
      const anyChecked = Array.from(selections.values()).some(s => s.size > 0);
      saveBtn.disabled = !anyChecked;
      saveBtn.style.opacity = saveBtn.disabled ? '0.5' : '1';
    }

    function close() { modal.style.display = 'none'; }

    closeBtn.addEventListener('click', close);
    cancelBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    btn.addEventListener('click', async () => {
      selections.clear();
      modal.style.display = 'flex';
      listEl.innerHTML = '<div style="text-align:center;padding:30px;color:#9ca3af;font-size:13px;">Cargando PrionPacks activos…</div>';
      statusEl.textContent = '';
      saveBtn.disabled = true;
      saveBtn.style.opacity = '0.5';
      try {
        const r = await fetch('/prionpacks/api/packages?active=1', {credentials: 'same-origin'});
        if (!r.ok) throw new Error('HTTP ' + r.status);
        packs = await r.json();
      } catch (e) {
        listEl.innerHTML = `<div style="color:#b91c1c;padding:14px;font-size:13px;">Error: ${esc(e.message)}</div>`;
        return;
      }
      if (!packs.length) {
        listEl.innerHTML = '<div style="text-align:center;padding:30px;color:#9ca3af;font-size:13px;">No hay PrionPacks activos.</div>';
        return;
      }
      listEl.innerHTML = packs.map(p => `
        <div style="background:white;border:1px solid #e5e7eb;border-radius:7px;padding:9px 11px;margin-bottom:6px;
                    display:flex;align-items:center;gap:10px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:#111827;
                        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              ${esc(p.id)} · ${esc(p.title || '(sin título)')}
            </div>
            <div style="font-size:11px;color:#9ca3af;margin-top:1px;">
              ${esc(p.responsible || '—')}${p.type ? ' · ' + esc(p.type) : ''}
            </div>
          </div>
          <label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#374151;cursor:pointer;">
            <input type="checkbox" class="pv-pack-target" data-pack="${esc(p.id)}" data-target="intro">
            Intro
          </label>
          <label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#374151;cursor:pointer;">
            <input type="checkbox" class="pv-pack-target" data-pack="${esc(p.id)}" data-target="general">
            Generales
          </label>
        </div>
      `).join('');

      listEl.querySelectorAll('.pv-pack-target').forEach(cb => {
        cb.addEventListener('change', () => {
          const pkgId = cb.dataset.pack;
          const tgt = cb.dataset.target;
          const set = selections.get(pkgId) || new Set();
          if (cb.checked) set.add(tgt);
          else set.delete(tgt);
          if (set.size === 0) selections.delete(pkgId);
          else selections.set(pkgId, set);
          refreshSaveState();
        });
      });
    });

    saveBtn.addEventListener('click', async () => {
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;
      statusEl.style.color = '#6b7280';
      statusEl.textContent = 'Añadiendo…';
      const ops = [];
      for (const [pkgId, targets] of selections.entries()) {
        ops.push(fetch(`/prionpacks/api/packages/${encodeURIComponent(pkgId)}/import-article`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ article_id: a.id, targets: Array.from(targets) }),
        }).then(async r => ({ pkgId, status: r.status, json: await r.json().catch(() => ({})) })));
      }
      const results = await Promise.all(ops);
      const ok    = results.filter(r => r.status === 200 && r.json.ok);
      const dup   = results.filter(r => r.status === 200 && !r.json.ok && r.json.reason === 'already_in_pack');
      const fail  = results.filter(r => r.status !== 200);
      const parts = [];
      if (ok.length)   parts.push(`<span style="color:#15803d;">✓ ${ok.length} pack${ok.length === 1 ? '' : 's'} actualizado${ok.length === 1 ? '' : 's'}</span>`);
      if (dup.length)  parts.push(`<span style="color:#b45309;">△ ${dup.length} ya tenía${dup.length === 1 ? '' : 'n'} el artículo</span>`);
      if (fail.length) parts.push(`<span style="color:#b91c1c;">✗ ${fail.length} fallo${fail.length === 1 ? '' : 's'}</span>`);
      statusEl.innerHTML = parts.join(' · ');
      saveBtn.disabled = false;
    });
  }

  // ── Personal state chips (favorite + read) in the detail modal ───────
  // ── AI summary section (Capa 3) ──────────────────────────────────────
  // Cache the AI providers catalogue across the page so the detail
  // modal and the bulk modal share one round-trip instead of refetching.
  let _aiProvidersPromise = null;
  function getAiProviders() {
    if (!_aiProvidersPromise) {
      _aiProvidersPromise = api('/admin/ai-providers')
        .then(r => r.providers || {})
        .catch(() => ({}));
    }
    return _aiProvidersPromise;
  }

  function renderAiSummary(a) {
    const block = document.getElementById('pv-ai-summary-block');
    if (!block) return;

    const header = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin:0 0 6px;gap:8px;flex-wrap:wrap;">
        <h3 style="margin:0;font-size:14px;font-weight:600;color:#374151;
                   text-transform:uppercase;letter-spacing:0.05em;">AI summary</h3>
        ${IS_ADMIN ? `
          <div style="display:flex;gap:6px;align-items:center;">
            <select id="pv-ai-provider" title="Modelo de IA a usar"
                    style="font-size:11.5px;padding:3px 6px;border-radius:6px;
                           border:1px solid #d1d5db;background:white;color:#374151;
                           max-width:170px;">
              <option value="">Cargando…</option>
            </select>
            <button id="pv-ai-generate"
                    style="padding:4px 10px;border-radius:6px;border:1px solid #d1d5db;background:white;
                           font-size:11.5px;font-weight:600;color:#0F3460;cursor:pointer;">
              ${a.summary_ai ? '↻ Regenerate' : '✨ Generate'}
            </button>
            ${a.summary_ai ? `
              <button id="pv-ai-clear"
                      title="Borrar el resumen IA"
                      style="padding:4px 8px;border-radius:6px;border:1px solid #fecaca;background:white;
                             font-size:11.5px;color:#b91c1c;cursor:pointer;">🗑</button>` : ''}
          </div>` : ''}
      </div>`;

    const body = a.summary_ai
      ? `<div style="font-size:14px;color:#4b5563;line-height:1.65;
                     background:#f9fafb;border-radius:8px;padding:10px 12px;
                     white-space:pre-wrap;">${supHtml(a.summary_ai)}</div>`
      : `<div style="font-size:13px;color:#9ca3af;font-style:italic;
                     background:#f9fafb;border-radius:8px;padding:10px 12px;">
          Sin resumen IA todavía${IS_ADMIN ? ' — clic en ✨ Generate para crearlo.' : '.'}
         </div>`;

    block.innerHTML = header + body +
      `<div id="pv-ai-status" style="margin-top:6px;font-size:11.5px;color:#9ca3af;"></div>`;

    if (!IS_ADMIN) return;

    const genBtn   = document.getElementById('pv-ai-generate');
    const clearBtn = document.getElementById('pv-ai-clear');
    const statusEl = document.getElementById('pv-ai-status');
    const provEl   = document.getElementById('pv-ai-provider');

    // Populate the provider dropdown. Default to the value persisted
    // by the bulk-summary modal so the detail picker stays in sync.
    getAiProviders().then(providers => {
      if (!provEl) return;
      const stored = localStorage.getItem('pv-summary-provider') || 'anthropic';
      const keys = Object.keys(providers);
      if (!keys.length) {
        provEl.innerHTML = '<option value="">(sin proveedores)</option>';
        provEl.disabled = true;
        if (genBtn) {
          genBtn.disabled = true;
          genBtn.style.opacity = '0.5';
        }
        return;
      }
      provEl.innerHTML = keys.map(k => {
        const p = providers[k];
        const off = !p.configured;
        return `<option value="${esc(k)}" ${off ? 'disabled' : ''}>
                  ${esc(p.label)}${off ? ' (sin API key)' : ''}
                </option>`;
      }).join('');
      // Pick stored if valid+configured, else the first configured one.
      const ok = providers[stored] && providers[stored].configured;
      provEl.value = ok
        ? stored
        : (keys.find(k => providers[k].configured) || stored);
      provEl.addEventListener('change', () => {
        if (provEl.value) localStorage.setItem('pv-summary-provider', provEl.value);
      });
    });

    if (genBtn) genBtn.addEventListener('click', async () => {
      const provider = (provEl && provEl.value) ||
                       localStorage.getItem('pv-summary-provider') ||
                       'anthropic';
      genBtn.disabled = true;
      const original = genBtn.textContent;
      genBtn.textContent = '⏳ Generando…';
      statusEl.style.color = '#6b7280';
      statusEl.textContent = 'Llamando a la IA — puede tardar 5-15 s…';
      try {
        const r = await api(`/articles/${a.id}/summary`, {
          method: 'POST',
          body: JSON.stringify({ provider }),
        });
        a.summary_ai = r.summary_ai;
        renderAiSummary(a);
        const cost = r.cost_usd != null ? ` · $${r.cost_usd.toFixed(4)}` : '';
        const tin  = r.tokens_in  != null ? ` · ${r.tokens_in} in` : '';
        const tout = r.tokens_out != null ? ` / ${r.tokens_out} out` : '';
        const src  = r.used_full_text ? ' (texto completo)' : ' (solo abstract)';
        const modelTag = r.model ? ` [${r.model}]` : '';
        const newStatus = document.getElementById('pv-ai-status');
        if (newStatus) {
          newStatus.style.color = '#15803d';
          newStatus.textContent = `✓ Generado en ${(r.elapsed_ms/1000).toFixed(1)} s${modelTag}${src}${tin}${tout}${cost}`;
        }
      } catch (e) {
        statusEl.style.color = '#b91c1c';
        if (e.status === 503) {
          statusEl.textContent = 'IA no disponible: API key no configurada en el servidor.';
        } else {
          statusEl.textContent = 'Error: ' + e.message;
        }
        genBtn.disabled = false;
        genBtn.textContent = original;
      }
    });

    if (clearBtn) clearBtn.addEventListener('click', async () => {
      if (!confirm('¿Borrar el resumen IA de este artículo? Se podrá regenerar.')) return;
      clearBtn.disabled = true;
      try {
        await api(`/articles/${a.id}/summary`, { method: 'DELETE' });
        a.summary_ai = null;
        renderAiSummary(a);
      } catch (e) {
        statusEl.style.color = '#b91c1c';
        statusEl.textContent = 'Error al borrar: ' + e.message;
        clearBtn.disabled = false;
      }
    });
  }

  function wirePersonalState(a) {
    const favBtn  = document.getElementById('pv-detail-fav');
    const readBtn = document.getElementById('pv-detail-read');

    async function toggle(btn, endpoint, key, refresh) {
      if (!btn) return;
      const next = btn.dataset.active !== '1';
      btn.disabled = true;
      try {
        const r = await api(`/articles/${a.id}/${endpoint}`, {
          method: 'POST',
          body: JSON.stringify({ value: next }),
        });
        refresh(r);
      } catch (e) {
        alert('Error: ' + e.message);
        btn.disabled = false;
      }
    }

    if (favBtn) favBtn.addEventListener('click', () => toggle(favBtn, 'favorite', 'is_favorite', r => {
      a.is_favorite = !!r.is_favorite;
      // Re-render chips inline without reopening the modal.
      const fresh = renderPersonalChip(a, 'fav');
      favBtn.outerHTML = fresh;
      wirePersonalState(a);
    }));
    if (readBtn) readBtn.addEventListener('click', () => toggle(readBtn, 'read', 'is_read', r => {
      a.is_read = !!r.is_read;
      a.read_at = r.read_at || null;
      const fresh = renderPersonalChip(a, 'read');
      readBtn.outerHTML = fresh;
      wirePersonalState(a);
    }));
  }

  function renderPersonalChip(a, kind) {
    if (kind === 'fav') {
      return `<button id="pv-detail-fav" type="button"
                  data-active="${a.is_favorite ? '1' : '0'}"
                  style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;
                         font-size:12px;font-weight:600;cursor:pointer;
                         ${a.is_favorite
                           ? 'background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;'
                           : 'background:#f9fafb;color:#6b7280;border:1px solid #e5e7eb;'}">
                <span style="font-size:14px;line-height:1;color:${a.is_favorite ? '#e11d48' : '#9ca3af'};">${a.is_favorite ? '♥' : '♡'}</span>
                ${a.is_favorite ? 'En favoritos' : 'Añadir a favoritos'}
              </button>`;
    }
    return `<button id="pv-detail-read" type="button"
                data-active="${a.is_read ? '1' : '0'}"
                style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;
                       font-size:12px;font-weight:600;cursor:pointer;
                       ${a.is_read
                         ? 'background:#dcfce7;color:#15803d;border:1px solid #86efac;'
                         : 'background:#f9fafb;color:#6b7280;border:1px solid #e5e7eb;'}">
              <span style="font-size:13px;font-weight:800;line-height:1;color:${a.is_read ? '#15803d' : '#9ca3af'};">✓</span>
              ${a.is_read ? 'Leído por mí' : 'Marcar como leído'}
            </button>`;
  }

  function closeDetail() {
    _pdfViewerOpen = false;
    const inner = document.querySelector('#pv-detail-modal .pv-modal-inner');
    if (inner) inner.style.maxWidth = '';
    document.getElementById('pv-detail-modal').style.display = 'none';
  }

  // ── wiring ─────────────────────────────────────────────────────────────
  function init() {
    const debounce = (fn, ms) => {
      let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    };
    const onSearch = debounce(() => { state.page = 1; loadArticles(); }, 200);

    const searchInput = document.getElementById('pv-search-input');
    const searchModeBtn = document.getElementById('btn-search-mode');

    function setSearchMode(mode) {
      searchModeBtn.dataset.mode = mode;
      if (mode === 'ai') {
        searchModeBtn.style.background = '#0F3460';
        searchModeBtn.style.color = 'white';
        searchModeBtn.style.borderColor = '#0F3460';
        searchInput.placeholder = 'Pregunta a la biblioteca en lenguaje natural (Enter para enviar)…';
      } else {
        searchModeBtn.style.background = 'transparent';
        searchModeBtn.style.color = '#6b7280';
        searchModeBtn.style.borderColor = '#d1d5db';
        searchInput.placeholder = 'Search title, abstract, authors, journal…';
        closeRagPanel();
      }
    }

    searchInput.addEventListener('input', e => {
      if (searchModeBtn.dataset.mode === 'ai') return;  // text-only debounced search
      state.q = e.target.value.trim();
      onSearch();
    });
    searchInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && searchModeBtn.dataset.mode === 'ai') {
        e.preventDefault();
        runRagSearch(searchInput.value.trim());
      }
    });
    searchModeBtn.addEventListener('click', () => {
      setSearchMode(searchModeBtn.dataset.mode === 'ai' ? 'text' : 'ai');
    });
    document.getElementById('pv-rag-close').addEventListener('click', closeRagPanel);
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
    wireTriStateButton('btn-filter-favorite', 'isFavorite', {
      null: '❤ Favoritos: todos', true: '❤ Mis favoritos', false: '❤ No favoritos',
    });
    wireTriStateButton('btn-filter-read', 'isRead', {
      null: '✓ Leídos: todos', true: '✓ Leídos por mí', false: '✓ No leídos',
    });

    document.getElementById('filter-color').addEventListener('change', e => {
      state.colorLabel = e.target.value || null;
      state.page = 1;
      loadArticles();
    });
    document.getElementById('filter-priority-eq').addEventListener('change', e => {
      const v = parseInt(e.target.value, 10);
      state.priorityEq = Number.isFinite(v) ? v : null;
      state.page = 1;
      loadArticles();
    });
    const psSel = document.getElementById('page-size-select');
    if (psSel) {
      psSel.value = String(state.size);
      psSel.addEventListener('change', e => {
        const v = parseInt(e.target.value, 10);
        state.size = Number.isFinite(v) && v > 0 ? v : 100;
        localStorage.setItem('pv-page-size', String(state.size));
        state.page = 1;
        loadArticles();
      });
    }
    document.getElementById('filter-extraction').addEventListener('change', e => {
      state.extraction = e.target.value || null;
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
      wireAddByDoi();
      wireBatchImport();
      wireDuplicates();
      wireBatchSummary();
      wireBatchIndex();
      wireBatchExtract();
      wireBatchOcr();
      wireBatchSearchable();
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

    const clearBtn = document.getElementById('pv-queue-clear-failed');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        if (!confirm('¿Borrar todas las filas con status failed o duplicate? Esta acción no se puede deshacer.')) return;
        clearBtn.disabled = true;
        try {
          const r = await fetch('/prionvault/api/ingest/clear-failed', {
            method: 'POST', credentials: 'same-origin',
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
          refreshQueue();
        } catch (e) {
          alert('Error: ' + e.message);
        } finally {
          clearBtn.disabled = false;
        }
      });
    }
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
      const useUnpaywall = !!document.getElementById('pv-batch-unpaywall')?.checked;
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
          const created = await api('/articles', {
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
          const metaBits = [m.authors, m.year].filter(Boolean).join(' · ');
          metaEl.textContent = metaBits;
          counts.ok++;

          if (useUnpaywall && created && created.id && (m.doi || e.doi)) {
            try {
              const fp = await api(`/articles/${created.id}/fetch-pdf`, {
                method: 'POST',
              });
              if (fp.ok) {
                metaEl.textContent = (metaBits ? metaBits + ' · ' : '') +
                  `📄 PDF encolado (Unpaywall: ${esc(fp.host_type || 'OA')})`;
              } else {
                metaEl.textContent = (metaBits ? metaBits + ' · ' : '') +
                  `📄 sin PDF en open access (${esc(fp.reason || 'unknown')})`;
              }
            } catch (fpErr) {
              metaEl.textContent = (metaBits ? metaBits + ' · ' : '') +
                `📄 Unpaywall falló (${esc(fpErr.message)})`;
            }
          }
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

  // ── Batch AI summary modal ───────────────────────────────────────────
  function wireBatchSummary() {
    const btn   = document.getElementById('btn-batch-summary');
    const modal = document.getElementById('pv-batch-summary-modal');
    if (!btn || !modal) return;
    const closeBtn   = document.getElementById('pv-batch-summary-close');
    const startBtn   = document.getElementById('pv-bs-start');
    const stopBtn    = document.getElementById('pv-bs-stop');
    const statsEl    = document.getElementById('pv-bs-stats');
    const progWrap   = document.getElementById('pv-bs-progress-wrap');
    const progLabel  = document.getElementById('pv-bs-progress-label');
    const progBar    = document.getElementById('pv-bs-progress-bar');
    const progPct    = document.getElementById('pv-bs-progress-percent');
    const currentEl  = document.getElementById('pv-bs-current');
    const errorEl    = document.getElementById('pv-bs-error');
    const costEl     = document.getElementById('pv-bs-cost');

    let pollHandle = null;
    function stopPolling() {
      if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
    }
    function startPolling() {
      stopPolling();
      pollHandle = setInterval(refresh, 1800);
    }

    const providersEl = document.getElementById('pv-bs-providers');
    let selectedProvider =
        localStorage.getItem('pv-summary-provider') || 'anthropic';
    let providerMeta = {};  // populated by refreshProviders()

    function renderProviderPicker() {
      if (!providersEl) return;
      const cards = Object.entries(providerMeta).map(([key, p]) => {
        const active = key === selectedProvider;
        const off    = !p.configured;
        const border = active && !off ? '#0F3460'
                                       : (off ? '#e5e7eb' : '#d1d5db');
        const bg     = active && !off ? '#eef2ff' : 'white';
        const colorLabel = off ? '#9ca3af' : '#111827';
        return `
          <button type="button" class="pv-bs-provider-btn" data-provider="${esc(key)}"
                  ${off ? 'disabled' : ''}
                  style="background:${bg};border:2px solid ${border};border-radius:8px;
                         padding:8px 10px;text-align:left;cursor:${off ? 'not-allowed' : 'pointer'};
                         transition:border-color 0.15s, background 0.15s;
                         opacity:${off ? '0.5' : '1'};">
            <div style="font-size:12.5px;font-weight:600;color:${colorLabel};">
              ${esc(p.label)}
            </div>
            <div style="font-size:10.5px;color:#9ca3af;margin-top:2px;font-variant-numeric:tabular-nums;">
              ${esc(p.model)}<br>
              $${p.price_in.toFixed(2)}/M in · $${p.price_out.toFixed(2)}/M out
              ${off ? `<br><span style="color:#b91c1c;">${esc(p.env)} no configurada</span>` : ''}
            </div>
          </button>`;
      }).join('');
      providersEl.innerHTML = cards;
      providersEl.querySelectorAll('.pv-bs-provider-btn').forEach(b =>
        b.addEventListener('click', () => {
          if (b.disabled) return;
          selectedProvider = b.dataset.provider;
          localStorage.setItem('pv-summary-provider', selectedProvider);
          renderProviderPicker();
          refresh();         // recompute Start button label / state
        }));
    }

    async function refreshProviders() {
      try {
        const r = await api('/admin/ai-providers');
        providerMeta = r.providers || {};
        // If the persisted provider is no longer configured, fall back
        // to the first configured one (or just keep the bad value so
        // the user sees the disabled state and picks another).
        if (providerMeta[selectedProvider] &&
            !providerMeta[selectedProvider].configured) {
          const firstOk = Object.keys(providerMeta)
            .find(k => providerMeta[k].configured);
          if (firstOk) selectedProvider = firstOk;
        }
        renderProviderPicker();
      } catch (e) {
        if (providersEl) providersEl.innerHTML =
          `<div style="grid-column:1/-1;color:#b91c1c;font-size:12px;">
             No se pudo cargar la lista de proveedores: ${esc(e.message)}
           </div>`;
      }
    }

    function open() {
      modal.style.display = 'flex';
      refreshProviders();
      refresh();
      startPolling();
    }
    function close() {
      modal.style.display = 'none';
      stopPolling();
    }
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    function statCard(label, value, color) {
      return `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;">
                <div style="font-size:10.5px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${esc(label)}</div>
                <div style="font-size:18px;font-weight:700;color:${color || '#111827'};font-variant-numeric:tabular-nums;">${esc(value)}</div>
              </div>`;
    }

    async function refresh() {
      let s;
      try {
        s = await api('/admin/batch-summary/status');
      } catch (e) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Error consultando estado: ' + e.message;
        return;
      }
      const lib = s.library_stats || {};
      statsEl.innerHTML =
        statCard('Total',          lib.total ?? 0) +
        statCard('Con texto',      lib.with_text ?? 0) +
        statCard('Con resumen',    lib.with_summary ?? 0, '#15803d') +
        statCard('Pendientes',     lib.eligible ?? 0, '#b45309');

      if (s.running) {
        progWrap.style.display = 'block';
        const total = s.eligible_total || 0;
        const done  = (s.processed || 0) + (s.failed || 0);
        const pct   = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        progBar.style.width = pct + '%';
        progPct.textContent = pct + '%';
        const runMeta = providerMeta[s.provider];
        const runLabel = runMeta ? runMeta.label : (s.provider || '');
        progLabel.textContent =
          (runLabel ? `[${runLabel}] ` : '') +
          `${done} / ${total} procesados ` +
          (s.failed ? `(${s.failed} con error) ` : '') +
          (s.stop_requested ? '— deteniendo…' : '— corriendo…');
        if (s.current_article) {
          currentEl.style.display = 'block';
          currentEl.innerHTML = `<strong>Actual:</strong> ${esc(s.current_article.title)}`;
        } else {
          currentEl.style.display = 'none';
        }
        startBtn.style.display = 'none';
        stopBtn.style.display = 'inline-flex';
        stopBtn.disabled = !!s.stop_requested;
      } else {
        startBtn.style.display = 'inline-flex';
        stopBtn.style.display = 'none';
        currentEl.style.display = 'none';
        const eligible = lib.eligible || 0;
        const provMeta = providerMeta[selectedProvider];
        const provReady = !!(provMeta && provMeta.configured);
        startBtn.disabled = eligible === 0 || !provReady;
        startBtn.style.opacity = startBtn.disabled ? '0.5' : '1';
        if (!provReady) {
          startBtn.textContent = 'Elige un proveedor';
        } else {
          startBtn.textContent = eligible > 0
            ? `Start con ${provMeta.label} (${eligible} pendiente${eligible === 1 ? '' : 's'})`
            : 'Start';
        }
        if (s.finished_at && (s.processed || s.failed)) {
          progWrap.style.display = 'block';
          const total = s.eligible_total || 0;
          const done  = (s.processed || 0) + (s.failed || 0);
          const pct   = total > 0 ? Math.round((done / total) * 100) : 100;
          progBar.style.width = pct + '%';
          progPct.textContent = pct + '%';
          progLabel.textContent = `Terminado: ${s.processed} OK, ${s.failed} con error`;
        }
      }

      if (s.last_error) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Último error: ' + s.last_error;
      } else {
        errorEl.style.display = 'none';
      }

      const cost = (s.total_cost_usd || 0).toFixed(3);
      const tin  = s.total_tokens_in  || 0;
      const tout = s.total_tokens_out || 0;
      costEl.textContent = (s.processed || 0) > 0
        ? `Coste esta sesión: $${cost} · ${tin} in / ${tout} out tokens`
        : '';
    }

    startBtn.addEventListener('click', async () => {
      if (!selectedProvider) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Elige un proveedor de IA antes de empezar.';
        return;
      }
      startBtn.disabled = true;
      try {
        await api('/admin/batch-summary/start', {
          method: 'POST',
          body: JSON.stringify({ provider: selectedProvider }),
        });
        refresh();
        startPolling();
      } catch (e) {
        startBtn.disabled = false;
        if (e.status === 409) {
          // Already running — just refresh
          refresh();
        } else {
          errorEl.style.display = 'block';
          errorEl.textContent = 'No se pudo iniciar: ' + e.message;
        }
      }
    });

    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      try {
        await api('/admin/batch-summary/stop', { method: 'POST' });
        refresh();
      } catch (e) {
        stopBtn.disabled = false;
        errorEl.style.display = 'block';
        errorEl.textContent = 'No se pudo detener: ' + e.message;
      }
    });
  }

  // ── RAG (Ask the library) — Phase 5 ──────────────────────────────────
  function annotateCitations(answer, citations) {
    // Wrap inline [N] markers with a clickable span that scrolls to / opens
    // the matching citation card below.
    const byNum = new Map(citations.map(c => [c.n, c]));
    return esc(answer).replace(/\[(\d{1,3})\]/g, (m, nStr) => {
      const n = parseInt(nStr, 10);
      const c = byNum.get(n);
      if (!c) return m;
      return `<a href="#" data-rag-cite="${n}" data-aid="${esc(c.article_id)}" ` +
             `style="text-decoration:none;font-weight:700;color:#0F3460;">[${n}]</a>`;
    });
  }

  function renderRagCitations(citations, citedNumbers) {
    const container = document.getElementById('pv-rag-citations');
    const title = document.getElementById('pv-rag-citations-title');
    if (!citations.length) {
      title.style.display = 'none';
      container.innerHTML = '';
      return;
    }
    title.style.display = 'block';
    const baseLabel = citedNumbers.length
      ? `Referencias citadas (${citedNumbers.length}/${citations.length} recuperadas)`
      : `Referencias recuperadas (${citations.length})`;
    title.textContent = baseLabel;

    const citedSet = new Set(citedNumbers);
    container.innerHTML = citations.map(c => {
      const isUsed = citedSet.has(c.n);
      const simPct = Math.round((c.similarity || 0) * 100);
      const rrChip = (c.rerank_score != null)
        ? `<span title="Voyage rerank-2 relevance score (0–1)"
                 style="font-size:10.5px;color:#7c3aed;background:#f5f3ff;border:1px solid #ddd6fe;
                        padding:1px 6px;border-radius:5px;font-variant-numeric:tabular-nums;font-weight:600;">
             RR ${c.rerank_score.toFixed(2)}
           </span>`
        : '';
      const headerBits = [
        c.authors ? esc(c.authors).slice(0, 110) : '',
        c.year || '',
        c.journal ? esc(c.journal) : '',
      ].filter(Boolean).join(' · ');
      return `
        <div id="pv-rag-cite-${c.n}" data-rag-cite-card="${c.n}"
             style="display:flex;gap:10px;align-items:flex-start;
                    background:${isUsed ? '#fff' : '#fafafa'};
                    border:1px solid ${isUsed ? '#cbd5e1' : '#e5e7eb'};
                    border-left:3px solid ${isUsed ? '#0F3460' : '#cbd5e1'};
                    border-radius:8px;padding:10px 12px;">
          <div style="font-size:12px;font-weight:700;color:#0F3460;flex-shrink:0;
                      min-width:24px;">[${c.n}]</div>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
              <a href="#" data-aid="${esc(c.article_id)}" class="pv-rag-open"
                 style="font-size:13.5px;font-weight:600;color:#111827;text-decoration:none;">
                ${supHtml(c.title || '(no title)')}
              </a>
              <span style="font-size:11px;color:#15803d;font-variant-numeric:tabular-nums;font-weight:600;">
                ${simPct}% match
              </span>
              ${rrChip}
            </div>
            ${headerBits ? `<div style="font-size:11.5px;color:#6b7280;margin-top:1px;">${headerBits}</div>` : ''}
            <div style="font-size:12px;color:#4b5563;background:#f9fafb;border-radius:6px;
                        padding:6px 8px;margin-top:5px;line-height:1.55;
                        max-height:120px;overflow-y:auto;">${esc(c.extract)}</div>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.pv-rag-open').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        openDetail(a.dataset.aid);
      });
    });
  }

  async function runRagSearch(query) {
    const panel  = document.getElementById('pv-rag-panel');
    const qEl    = document.getElementById('pv-rag-query');
    const stEl   = document.getElementById('pv-rag-status');
    const ansEl  = document.getElementById('pv-rag-answer');
    const metaEl = document.getElementById('pv-rag-meta');
    const citEl  = document.getElementById('pv-rag-citations');
    const titEl  = document.getElementById('pv-rag-citations-title');
    const resultsMeta = document.getElementById('pv-results-meta');
    const resultsGrid = document.getElementById('pv-results-grid');
    const pagination  = document.getElementById('pv-pagination');

    if (!query) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'block';
    if (resultsMeta) resultsMeta.style.display = 'none';
    if (resultsGrid) resultsGrid.style.display = 'none';
    if (pagination)  pagination.style.display  = 'none';

    qEl.textContent = query;
    stEl.style.color = '#6b7280';
    stEl.textContent = 'Recuperando fragmentos relevantes y consultando a Claude…';
    ansEl.style.color = '#9ca3af';
    ansEl.textContent = '…';
    metaEl.textContent = '';
    citEl.innerHTML = '';
    titEl.style.display = 'none';

    try {
      const r = await api('/search/semantic', {
        method: 'POST',
        body: JSON.stringify({ query }),
      });
      ansEl.style.color = '#1f2937';
      // Render answer with inline citation hyperlinks
      ansEl.innerHTML = annotateCitations(r.answer || '', r.citations || []);

      const confLabel = r.confidence ? `Confianza: <strong>${esc(r.confidence)}</strong>` : '';
      const hybridBadge = r.hybrid_used
        ? `<span title="Vector ${r.hybrid_vector_hits} + BM25 ${r.hybrid_bm25_hits} → ${r.hybrid_fused} fusionados"
                 style="display:inline-block;margin-left:6px;font-size:10.5px;color:#0369a1;
                        background:#f0f9ff;border:1px solid #bae6fd;padding:1px 6px;
                        border-radius:5px;font-weight:600;letter-spacing:0.02em;">
            🔀 hybrid · ${r.hybrid_vector_hits}v + ${r.hybrid_bm25_hits}b → ${r.hybrid_fused}
           </span>`
        : '';
      const rrBadge = r.rerank_used
        ? `<span style="display:inline-block;margin-left:6px;font-size:10.5px;color:#7c3aed;
                        background:#f5f3ff;border:1px solid #ddd6fe;padding:1px 6px;
                        border-radius:5px;font-weight:600;letter-spacing:0.02em;">
            ⚡ reranked${r.rerank_candidates ? ' · ' + r.rerank_candidates + ' cand.' : ''}
           </span>`
        : '';
      const timing = `${(r.elapsed_ms/1000).toFixed(1)} s (retrieval ${r.retrieval_ms} ms)`;
      const totalCost = (r.cost_usd || 0) + (r.rerank_cost_usd || 0);
      const cost = totalCost > 0 ? ` · $${totalCost.toFixed(4)}` : '';
      const tok = (r.tokens_in != null && r.tokens_out != null)
        ? ` · ${r.tokens_in} in / ${r.tokens_out} out tokens` : '';
      stEl.style.color = r.no_results ? '#b45309' : '#15803d';
      stEl.innerHTML = r.no_results
        ? '⚠️ Retrieval no encontró fragmentos relevantes para esta pregunta.'
        : `✓ Generado en ${timing}${cost}${tok}`;
      metaEl.innerHTML = confLabel + hybridBadge + rrBadge;

      renderRagCitations(r.citations || [], r.cited_numbers || []);

      // Wire inline [N] citation links to scroll to the corresponding card
      ansEl.querySelectorAll('a[data-rag-cite]').forEach(a => {
        a.addEventListener('click', e => {
          e.preventDefault();
          const card = document.getElementById('pv-rag-cite-' + a.dataset.ragCite);
          if (card) {
            card.scrollIntoView({behavior: 'smooth', block: 'center'});
            card.style.transition = 'background 0.3s ease';
            card.style.background = '#fef3c7';
            setTimeout(() => { card.style.background = ''; }, 1200);
          }
        });
      });
    } catch (e) {
      ansEl.style.color = '#b91c1c';
      if (e.status === 503) {
        ansEl.textContent = 'Búsqueda IA no disponible — falta configurar API key (VOYAGE_API_KEY o ANTHROPIC_API_KEY) en el servidor.';
      } else {
        ansEl.textContent = 'Error: ' + e.message;
      }
      stEl.textContent = '';
    }
  }

  function closeRagPanel() {
    const panel       = document.getElementById('pv-rag-panel');
    const resultsMeta = document.getElementById('pv-results-meta');
    const resultsGrid = document.getElementById('pv-results-grid');
    const pagination  = document.getElementById('pv-pagination');
    if (panel) panel.style.display = 'none';
    if (resultsMeta) resultsMeta.style.display = '';
    if (resultsGrid) resultsGrid.style.display = '';
    if (pagination)  pagination.style.display  = '';
  }

  // ── Batch indexing modal (Phase 4) ───────────────────────────────────
  function wireBatchIndex() {
    const btn   = document.getElementById('btn-batch-index');
    const modal = document.getElementById('pv-batch-index-modal');
    if (!btn || !modal) return;
    const closeBtn   = document.getElementById('pv-batch-index-close');
    const startBtn   = document.getElementById('pv-bi-start');
    const stopBtn    = document.getElementById('pv-bi-stop');
    const statsEl    = document.getElementById('pv-bi-stats');
    const progWrap   = document.getElementById('pv-bi-progress-wrap');
    const progLabel  = document.getElementById('pv-bi-progress-label');
    const progBar    = document.getElementById('pv-bi-progress-bar');
    const progPct    = document.getElementById('pv-bi-progress-percent');
    const currentEl  = document.getElementById('pv-bi-current');
    const errorEl    = document.getElementById('pv-bi-error');
    const costEl     = document.getElementById('pv-bi-cost');
    const modelEl    = document.getElementById('pv-bi-model');

    let pollHandle = null;
    function stopPolling() { if (pollHandle) { clearInterval(pollHandle); pollHandle = null; } }
    function startPolling() { stopPolling(); pollHandle = setInterval(refresh, 1800); }
    function open()  { modal.style.display = 'flex'; refresh(); startPolling(); }
    function close() { modal.style.display = 'none'; stopPolling(); }
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    function statCard(label, value, color) {
      return `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;">
                <div style="font-size:10.5px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${esc(label)}</div>
                <div style="font-size:18px;font-weight:700;color:${color || '#111827'};font-variant-numeric:tabular-nums;">${esc(value)}</div>
              </div>`;
    }

    async function refresh() {
      let s;
      try {
        s = await api('/admin/batch-index/status');
      } catch (e) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Error consultando estado: ' + e.message;
        return;
      }
      if (modelEl && s.embed_model) modelEl.textContent = s.embed_model;
      const lib = s.library_stats || {};
      statsEl.innerHTML =
        statCard('Total',       lib.total ?? 0) +
        statCard('Indexables',  lib.indexable ?? 0) +
        statCard('Indexados',   lib.indexed ?? 0, '#15803d') +
        statCard('Pendientes',  lib.eligible ?? 0, '#b45309');

      if (s.running) {
        progWrap.style.display = 'block';
        const total = s.eligible_total || 0;
        const done  = (s.processed || 0) + (s.failed || 0) + (s.skipped || 0);
        const pct   = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        progBar.style.width = pct + '%';
        progPct.textContent = pct + '%';
        progLabel.textContent = `${done} / ${total} procesados ` +
          (s.failed ? `(${s.failed} con error) ` : '') +
          (s.skipped ? `(${s.skipped} sin texto) ` : '') +
          (s.stop_requested ? '— deteniendo…' : '— corriendo…');
        if (s.current_article) {
          currentEl.style.display = 'block';
          currentEl.innerHTML = `<strong>Actual:</strong> ${esc(s.current_article.title)}`;
        } else {
          currentEl.style.display = 'none';
        }
        startBtn.style.display = 'none';
        stopBtn.style.display = 'inline-flex';
        stopBtn.disabled = !!s.stop_requested;
      } else {
        startBtn.style.display = 'inline-flex';
        stopBtn.style.display = 'none';
        currentEl.style.display = 'none';
        const eligible = lib.eligible || 0;
        startBtn.disabled = eligible === 0;
        startBtn.style.opacity = eligible === 0 ? '0.5' : '1';
        startBtn.textContent = eligible > 0
          ? `Start (${eligible} pendiente${eligible === 1 ? '' : 's'})`
          : 'Start';
        if (s.finished_at && (s.processed || s.failed || s.skipped)) {
          progWrap.style.display = 'block';
          const total = s.eligible_total || 0;
          const done  = (s.processed || 0) + (s.failed || 0) + (s.skipped || 0);
          const pct   = total > 0 ? Math.round((done / total) * 100) : 100;
          progBar.style.width = pct + '%';
          progPct.textContent = pct + '%';
          progLabel.textContent = `Terminado: ${s.processed} OK, ${s.failed} con error, ${s.skipped} sin texto`;
        }
      }

      if (s.last_error) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Último error: ' + s.last_error;
      } else {
        errorEl.style.display = 'none';
      }

      const cost   = (s.total_cost_usd || 0).toFixed(4);
      const tok    = s.total_tokens    || 0;
      const chunks = s.total_chunks    || 0;
      costEl.textContent = (s.processed || 0) > 0
        ? `Sesión: $${cost} · ${tok} tokens · ${chunks} chunks generados`
        : (lib.chunks_in_index ? `${lib.chunks_in_index} chunks en el índice` : '');
    }

    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        await api('/admin/batch-index/start', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        refresh();
        startPolling();
      } catch (e) {
        startBtn.disabled = false;
        if (e.status === 409) {
          refresh();
        } else {
          errorEl.style.display = 'block';
          errorEl.textContent = 'No se pudo iniciar: ' + e.message;
        }
      }
    });

    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      try {
        await api('/admin/batch-index/stop', { method: 'POST' });
        refresh();
      } catch (e) {
        stopBtn.disabled = false;
        errorEl.style.display = 'block';
        errorEl.textContent = 'No se pudo detener: ' + e.message;
      }
    });
  }

  // ── Batch text extraction modal (pdfplumber) ─────────────────────────
  function wireBatchExtract() {
    const btn   = document.getElementById('btn-batch-extract');
    const modal = document.getElementById('pv-batch-extract-modal');
    if (!btn || !modal) return;
    const closeBtn   = document.getElementById('pv-batch-extract-close');
    const startBtn   = document.getElementById('pv-be-start');
    const stopBtn    = document.getElementById('pv-be-stop');
    const statsEl    = document.getElementById('pv-be-stats');
    const progWrap   = document.getElementById('pv-be-progress-wrap');
    const progLabel  = document.getElementById('pv-be-progress-label');
    const progBar    = document.getElementById('pv-be-progress-bar');
    const progPct    = document.getElementById('pv-be-progress-percent');
    const currentEl  = document.getElementById('pv-be-current');
    const errorEl    = document.getElementById('pv-be-error');
    const countersEl = document.getElementById('pv-be-counters');

    let pollHandle = null;
    function stopPolling() { if (pollHandle) { clearInterval(pollHandle); pollHandle = null; } }
    function startPolling() { stopPolling(); pollHandle = setInterval(refresh, 2000); }
    function open()  { modal.style.display = 'flex'; refresh(); startPolling(); }
    function close() { modal.style.display = 'none'; stopPolling(); }
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    function statCard(label, value, color) {
      return `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;">
                <div style="font-size:10.5px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${esc(label)}</div>
                <div style="font-size:18px;font-weight:700;color:${color || '#111827'};font-variant-numeric:tabular-nums;">${esc(value)}</div>
              </div>`;
    }

    async function refresh() {
      let s;
      try {
        s = await api('/admin/batch-extract/status');
      } catch (e) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Error consultando estado: ' + e.message;
        return;
      }
      const lib = s.library_stats || {};
      statsEl.innerHTML =
        statCard('Total',      lib.total ?? 0) +
        statCard('Con PDF',    lib.with_pdf ?? 0) +
        statCard('Con texto',  lib.with_text ?? 0, '#15803d') +
        statCard('Pendientes', lib.eligible ?? 0, '#b45309');

      if (s.running) {
        progWrap.style.display = 'block';
        const total = s.eligible_total || 0;
        const done  = (s.processed || 0) + (s.failed || 0) + (s.skipped || 0);
        const pct   = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        progBar.style.width = pct + '%';
        progPct.textContent = pct + '%';
        progLabel.textContent = `${done} / ${total} procesados ` +
          (s.failed ? `(${s.failed} con error) ` : '') +
          (s.skipped ? `(${s.skipped} sin capa de texto → para OCR) ` : '') +
          (s.stop_requested ? '— deteniendo…' : '— corriendo…');
        if (s.current_article) {
          currentEl.style.display = 'block';
          currentEl.innerHTML = `<strong>Actual:</strong> ${esc(s.current_article.title)}`;
        } else {
          currentEl.style.display = 'none';
        }
        startBtn.style.display = 'none';
        stopBtn.style.display = 'inline-flex';
        stopBtn.disabled = !!s.stop_requested;
      } else {
        startBtn.style.display = 'inline-flex';
        stopBtn.style.display = 'none';
        currentEl.style.display = 'none';
        const eligible = lib.eligible || 0;
        startBtn.disabled = eligible === 0;
        startBtn.style.opacity = eligible === 0 ? '0.5' : '1';
        startBtn.textContent = eligible > 0
          ? `Start (${eligible} pendiente${eligible === 1 ? '' : 's'})`
          : 'Start';
        if (s.finished_at && (s.processed || s.failed || s.skipped)) {
          progWrap.style.display = 'block';
          const total = s.eligible_total || 0;
          const done  = (s.processed || 0) + (s.failed || 0) + (s.skipped || 0);
          const pct   = total > 0 ? Math.round((done / total) * 100) : 100;
          progBar.style.width = pct + '%';
          progPct.textContent = pct + '%';
          progLabel.textContent =
            `Terminado: ${s.processed} OK, ${s.failed} con error, ` +
            `${s.skipped} sin capa de texto (pasa a OCR)`;
        }
      }

      if (s.last_error) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Último error: ' + s.last_error;
      } else {
        errorEl.style.display = 'none';
      }

      countersEl.textContent = (s.processed || 0) > 0
        ? `Sesión: ${(s.total_chars || 0).toLocaleString()} caracteres · ${s.total_pages || 0} páginas`
        : '';
    }

    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        await api('/admin/batch-extract/start', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        refresh();
        startPolling();
      } catch (e) {
        startBtn.disabled = false;
        if (e.status === 409) {
          refresh();
        } else {
          errorEl.style.display = 'block';
          errorEl.textContent = 'No se pudo iniciar: ' + e.message;
        }
      }
    });

    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      try {
        await api('/admin/batch-extract/stop', { method: 'POST' });
        refresh();
      } catch (e) {
        stopBtn.disabled = false;
        errorEl.style.display = 'block';
        errorEl.textContent = 'No se pudo detener: ' + e.message;
      }
    });
  }

  // ── Batch OCR modal (Phase 6) ────────────────────────────────────────
  function wireBatchOcr() {
    const btn   = document.getElementById('btn-batch-ocr');
    const modal = document.getElementById('pv-batch-ocr-modal');
    if (!btn || !modal) return;
    const closeBtn   = document.getElementById('pv-batch-ocr-close');
    const startBtn   = document.getElementById('pv-bo-start');
    const stopBtn    = document.getElementById('pv-bo-stop');
    const statsEl    = document.getElementById('pv-bo-stats');
    const progWrap   = document.getElementById('pv-bo-progress-wrap');
    const progLabel  = document.getElementById('pv-bo-progress-label');
    const progBar    = document.getElementById('pv-bo-progress-bar');
    const progPct    = document.getElementById('pv-bo-progress-percent');
    const currentEl  = document.getElementById('pv-bo-current');
    const errorEl    = document.getElementById('pv-bo-error');
    const countersEl = document.getElementById('pv-bo-counters');

    let pollHandle = null;
    function stopPolling() { if (pollHandle) { clearInterval(pollHandle); pollHandle = null; } }
    function startPolling() { stopPolling(); pollHandle = setInterval(refresh, 2500); }
    function open()  { modal.style.display = 'flex'; refresh(); startPolling(); }
    function close() { modal.style.display = 'none'; stopPolling(); }
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    function statCard(label, value, color) {
      return `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;">
                <div style="font-size:10.5px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${esc(label)}</div>
                <div style="font-size:18px;font-weight:700;color:${color || '#111827'};font-variant-numeric:tabular-nums;">${esc(value)}</div>
              </div>`;
    }

    async function refresh() {
      let s;
      try {
        s = await api('/admin/batch-ocr/status');
      } catch (e) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Error consultando estado: ' + e.message;
        return;
      }
      const lib = s.library_stats || {};
      statsEl.innerHTML =
        statCard('Total',      lib.total ?? 0) +
        statCard('Con PDF',    lib.with_pdf ?? 0) +
        statCard('OCR’d',      lib.ocrd ?? 0, '#15803d') +
        statCard('Pendientes', lib.eligible ?? 0, '#b45309');

      if (s.running) {
        progWrap.style.display = 'block';
        const total = s.eligible_total || 0;
        const done  = (s.processed || 0) + (s.failed || 0) + (s.skipped || 0);
        const pct   = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        progBar.style.width = pct + '%';
        progPct.textContent = pct + '%';
        progLabel.textContent = `${done} / ${total} procesados ` +
          (s.failed ? `(${s.failed} con error) ` : '') +
          (s.skipped ? `(${s.skipped} sin texto recuperable) ` : '') +
          (s.stop_requested ? '— deteniendo…' : '— corriendo (OCR lento)…');
        if (s.current_article) {
          currentEl.style.display = 'block';
          currentEl.innerHTML = `<strong>Actual:</strong> ${esc(s.current_article.title)}`;
        } else {
          currentEl.style.display = 'none';
        }
        startBtn.style.display = 'none';
        stopBtn.style.display = 'inline-flex';
        stopBtn.disabled = !!s.stop_requested;
      } else {
        startBtn.style.display = 'inline-flex';
        stopBtn.style.display = 'none';
        currentEl.style.display = 'none';
        const eligible = lib.eligible || 0;
        startBtn.disabled = eligible === 0;
        startBtn.style.opacity = eligible === 0 ? '0.5' : '1';
        startBtn.textContent = eligible > 0
          ? `Start (${eligible} pendiente${eligible === 1 ? '' : 's'})`
          : 'Start';
        if (s.finished_at && (s.processed || s.failed || s.skipped)) {
          progWrap.style.display = 'block';
          const total = s.eligible_total || 0;
          const done  = (s.processed || 0) + (s.failed || 0) + (s.skipped || 0);
          const pct   = total > 0 ? Math.round((done / total) * 100) : 100;
          progBar.style.width = pct + '%';
          progPct.textContent = pct + '%';
          progLabel.textContent = `Terminado: ${s.processed} OK, ${s.failed} con error, ${s.skipped} sin texto`;
        }
      }

      if (s.last_error) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Último error: ' + s.last_error;
      } else {
        errorEl.style.display = 'none';
      }

      countersEl.textContent = (s.processed || 0) > 0
        ? `Sesión: ${s.total_chars || 0} caracteres recuperados · ${s.total_pages || 0} páginas OCRd`
        : '';
    }

    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        await api('/admin/batch-ocr/start', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        refresh();
        startPolling();
      } catch (e) {
        startBtn.disabled = false;
        if (e.status === 409) {
          refresh();
        } else {
          errorEl.style.display = 'block';
          errorEl.textContent = 'No se pudo iniciar: ' + e.message;
        }
      }
    });

    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      try {
        await api('/admin/batch-ocr/stop', { method: 'POST' });
        refresh();
      } catch (e) {
        stopBtn.disabled = false;
        errorEl.style.display = 'block';
        errorEl.textContent = 'No se pudo detener: ' + e.message;
      }
    });
  }

  // ── Make PDFs searchable (ocrmypdf — embed text layer) ───────────────
  function wireBatchSearchable() {
    const btn   = document.getElementById('btn-batch-searchable');
    const modal = document.getElementById('pv-batch-searchable-modal');
    if (!btn || !modal) return;
    const closeBtn   = document.getElementById('pv-batch-searchable-close');
    const startBtn   = document.getElementById('pv-bsp-start');
    const stopBtn    = document.getElementById('pv-bsp-stop');
    const statsEl    = document.getElementById('pv-bsp-stats');
    const progWrap   = document.getElementById('pv-bsp-progress-wrap');
    const progLabel  = document.getElementById('pv-bsp-progress-label');
    const progBar    = document.getElementById('pv-bsp-progress-bar');
    const progPct    = document.getElementById('pv-bsp-progress-percent');
    const currentEl  = document.getElementById('pv-bsp-current');
    const errorEl    = document.getElementById('pv-bsp-error');
    const countersEl = document.getElementById('pv-bsp-counters');

    let pollHandle = null;
    function stopPolling() { if (pollHandle) { clearInterval(pollHandle); pollHandle = null; } }
    function startPolling() { stopPolling(); pollHandle = setInterval(refresh, 2500); }
    function open()  { modal.style.display = 'flex'; refresh(); startPolling(); }
    function close() { modal.style.display = 'none'; stopPolling(); }
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    function statCard(label, value, color) {
      return `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;">
                <div style="font-size:10.5px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${esc(label)}</div>
                <div style="font-size:18px;font-weight:700;color:${color || '#111827'};font-variant-numeric:tabular-nums;">${esc(value)}</div>
              </div>`;
    }

    function fmtMB(b) {
      if (!b) return '0';
      return (b / (1024 * 1024)).toFixed(1);
    }

    async function refresh() {
      let s;
      try {
        s = await api('/admin/batch-searchable/status');
      } catch (e) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Error consultando estado: ' + e.message;
        return;
      }
      const lib = s.library_stats || {};
      statsEl.innerHTML =
        statCard('Total',       lib.total ?? 0) +
        statCard('Con PDF',     lib.with_pdf ?? 0) +
        statCard('Searchables', lib.searchable ?? 0, '#15803d') +
        statCard('Pendientes',  lib.eligible ?? 0, '#b45309');

      if (s.running) {
        progWrap.style.display = 'block';
        const total = s.eligible_total || 0;
        const done  = (s.processed || 0) + (s.failed || 0) + (s.skipped || 0);
        const pct   = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        progBar.style.width = pct + '%';
        progPct.textContent = pct + '%';
        progLabel.textContent = `${done} / ${total} procesados ` +
          (s.failed ? `(${s.failed} con error) ` : '') +
          (s.skipped ? `(${s.skipped} ya searchables, marcados) ` : '') +
          (s.stop_requested ? '— deteniendo…' : '— corriendo (ocrmypdf lento)…');
        if (s.current_article) {
          currentEl.style.display = 'block';
          currentEl.innerHTML = `<strong>Actual:</strong> ${esc(s.current_article.title)}`;
        } else {
          currentEl.style.display = 'none';
        }
        startBtn.style.display = 'none';
        stopBtn.style.display = 'inline-flex';
        stopBtn.disabled = !!s.stop_requested;
      } else {
        startBtn.style.display = 'inline-flex';
        stopBtn.style.display = 'none';
        currentEl.style.display = 'none';
        const eligible = lib.eligible || 0;
        startBtn.disabled = eligible === 0;
        startBtn.style.opacity = eligible === 0 ? '0.5' : '1';
        startBtn.textContent = eligible > 0
          ? `Start (${eligible} pendiente${eligible === 1 ? '' : 's'})`
          : 'Start';
        if (s.finished_at && (s.processed || s.failed || s.skipped)) {
          progWrap.style.display = 'block';
          const total = s.eligible_total || 0;
          const done  = (s.processed || 0) + (s.failed || 0) + (s.skipped || 0);
          const pct   = total > 0 ? Math.round((done / total) * 100) : 100;
          progBar.style.width = pct + '%';
          progPct.textContent = pct + '%';
          progLabel.textContent =
            `Terminado: ${s.processed} embebidos, ${s.failed} con error, ` +
            `${s.skipped} ya searchables`;
        }
      }

      if (s.last_error) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Último error: ' + s.last_error;
      } else {
        errorEl.style.display = 'none';
      }

      countersEl.textContent = (s.processed || 0) > 0
        ? `Sesión: ${fmtMB(s.bytes_uploaded)} MB subidos a Dropbox`
        : '';
    }

    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        await api('/admin/batch-searchable/start', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        refresh();
        startPolling();
      } catch (e) {
        startBtn.disabled = false;
        if (e.status === 409) {
          refresh();
        } else {
          errorEl.style.display = 'block';
          errorEl.textContent = 'No se pudo iniciar: ' + e.message;
        }
      }
    });

    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      try {
        await api('/admin/batch-searchable/stop', { method: 'POST' });
        refresh();
      } catch (e) {
        stopBtn.disabled = false;
        errorEl.style.display = 'block';
        errorEl.textContent = 'No se pudo detener: ' + e.message;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
