  // ── article detail modal ───────────────────────────────────────────────
  let _detailCurrentId = null;

  function _detailUpdateNav(aid) {
    _detailCurrentId = aid;
    const idx  = _listIds.indexOf(aid);
    const prev = document.getElementById('pv-detail-prev');
    const next = document.getElementById('pv-detail-next');
    if (prev) prev.disabled = idx <= 0;
    if (next) next.disabled = idx < 0 || idx >= _listIds.length - 1;
  }

  async function openDetail(aid, options = {}) {
    const modal   = document.getElementById('pv-detail-modal');
    const content = document.getElementById('pv-detail-content');
    _pdfViewerOpen = !!options.openPdf;
    const inner = modal.querySelector('.pv-modal-inner');
    if (inner) inner.style.maxWidth = '';
    modal.style.display = 'flex';
    _detailUpdateNav(aid);
    content.innerHTML = '<div style="text-align:center;padding:40px;color:#9ca3af;">Cargando…</div>';
    try {
      const a = await api('/articles/' + aid);

      // Fetch notes separately (not included in main article endpoint)
      try {
        const notesResp = await api('/articles/' + aid + '/notes');
        if (notesResp && notesResp.notes) {
          a.notes = notesResp.notes;
        }
      } catch (e) {
        // If notes endpoint fails, continue without notes
        a.notes = [];
      }

      // Wire cart button in detail modal nav bar
      const detailCartBtn = document.getElementById('pv-detail-cart-btn');
      if (detailCartBtn) {
        const inCart = window.PPCart?.has(a.id);
        detailCartBtn.innerHTML = inCart ? '🛒 ✓' : '🛒';
        detailCartBtn.style.background   = inCart ? '#d1fae5' : 'white';
        detailCartBtn.style.color        = inCart ? '#065f46' : '#374151';
        detailCartBtn.style.borderColor  = inCart ? '#6ee7b7' : '#d1d5db';
        detailCartBtn.title = inCart ? 'En el carrito' : 'Añadir al carrito de PrionPacks';
        detailCartBtn.onclick = () => {
          if (!window.PPCart) return;
          const isInCart = window.PPCart.has(a.id);
          if (isInCart) {
            window.PPCart.remove(a.id);
            detailCartBtn.innerHTML = '🛒';
            detailCartBtn.style.background  = 'white';
            detailCartBtn.style.color       = '#374151';
            detailCartBtn.style.borderColor = '#d1d5db';
            detailCartBtn.title = 'Añadir al carrito de PrionPacks';
          } else {
            window.PPCart.add({
              id: a.id, title: a.title || '', authors: a.authors || '',
              year: a.year || null, journal: a.journal || '',
              doi: a.doi || '', pubmed_id: a.pubmed_id || '', has_pdf: !!a.has_pdf,
            });
            detailCartBtn.innerHTML = '🛒 ✓';
            detailCartBtn.style.background  = '#d1fae5';
            detailCartBtn.style.color       = '#065f46';
            detailCartBtn.style.borderColor = '#6ee7b7';
            detailCartBtn.title = 'En el carrito';
          }
        };
      }

      // Wire email button in detail modal nav bar
      const detailEmailBtn = document.getElementById('pv-detail-email-btn');
      if (detailEmailBtn) {
        detailEmailBtn.onclick = () => {
          if (typeof PVEmailShare !== 'undefined' && PVEmailShare.open) {
            PVEmailShare.open(a);
          }
        };
      }

      // Wire "🔓 Buscar PDF" (open-access search) button in detail modal
      // nav bar — only worth showing when the article has no PDF yet.
      const detailOaBtn = document.getElementById('pv-detail-oa-btn');
      if (detailOaBtn) {
        detailOaBtn.style.display = a.has_pdf ? 'none' : '';
        detailOaBtn.innerHTML = a.oa_author_requested ? '🔓✓' : '🔓';
        detailOaBtn.title = a.oa_author_requested
          ? 'Ya se ha pedido el PDF al autor — clic para volver a intentarlo'
          : 'Buscar el PDF en fuentes de acceso abierto (Unpaywall, OpenAlex)';
        detailOaBtn.onclick = () => openOaSearchModal(a);
      }

      // Wire Notes cluster in detail modal nav bar
      const detailNotesCluster = document.getElementById('pv-detail-notes-cluster');
      if (detailNotesCluster) {
        detailNotesCluster.innerHTML = _noteClusterInner(a.notes || []);
        _wireNoteCluster(detailNotesCluster, a);
      }

      // Wire isolation button in detail modal nav bar
      const detailIsolateBtn = document.getElementById('pv-detail-isolate-btn');
      if (detailIsolateBtn) {
        detailIsolateBtn.onclick = () => {
          // Filter the listing to show only this article
          _setIsolatedArticleId(a.id);
          // Reload the listing with isolation filter
          loadArticles();
          // Close the detail modal
          closeDetail();
        };
      }

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
          ${(IS_ADMIN || IS_JC_RESPONSIBLE || a.is_jc) ? `
          <button id="pv-detail-jc" type="button"
                  data-active="${a.is_jc ? '1' : '0'}"
                  title="${(IS_ADMIN || IS_JC_RESPONSIBLE) ? 'Marca compartida — todos ven los artículos de Journal Club'
                                    : 'Seleccionado para Journal Club'}"
                  style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;
                         font-size:12px;font-weight:600;cursor:${(IS_ADMIN || IS_JC_RESPONSIBLE) ? 'pointer' : 'default'};
                         ${a.is_jc
                           ? 'background:#f3e8ff;color:#6b21a8;border:1px solid #d8b4fe;'
                           : 'background:#f9fafb;color:#6b7280;border:1px solid #e5e7eb;'}">
            <span style="font-size:12px;line-height:1;color:${a.is_jc ? '#7c3aed' : '#9ca3af'};"><i class="fas fa-book-open"></i></span>
            ${a.is_jc ? 'En Journal Club' : 'Marcar para Journal Club'}
          </button>` : ''}
          ${(_jcConvocable(a) && (IS_ADMIN || IS_JC_RESPONSIBLE)) ? `
          <button id="pv-detail-jc-convoke" type="button"
                  title="Convocar Journal Club — enviar fecha/hora a todo el laboratorio"
                  style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;
                         font-size:12px;font-weight:600;cursor:pointer;
                         background:#fdf2f8;color:#9d174d;border:1px solid #fbcfe8;">
            <span style="font-size:12px;line-height:1;"><i class="fas fa-bullhorn"></i></span>
            Convocar
          </button>` : ''}
        </div>`;

      const chatLauncher = `
        <div style="margin:0 0 14px;">
          <button id="pv-detail-chat-btn" type="button"
                  title="Abre un chat para hacer preguntas a la IA sobre este artículo"
                  style="display:inline-flex;align-items:center;gap:8px;padding:9px 16px;border-radius:9px;
                         border:none;background:linear-gradient(135deg,#0F3460,#16528a);color:#fff;
                         font-size:13.5px;font-weight:600;cursor:pointer;box-shadow:0 1px 3px rgba(15,52,96,0.3);">
            <span style="font-size:15px;">🤖</span>
            <span>Preguntar a la IA sobre este artículo</span>
          </button>
          <button id="pv-detail-chat-history-btn" type="button"
                  title="Ver conversaciones anteriores sobre este artículo"
                  style="display:inline-flex;align-items:center;gap:6px;padding:9px 13px;border-radius:9px;
                         border:1px solid #d1d5db;background:white;color:#374151;
                         font-size:12.5px;font-weight:600;cursor:pointer;margin-left:8px;">
            🕑 <span>Chats anteriores</span>
            <span id="pv-detail-chat-count" style="display:none;background:#eef2ff;color:#4f46e5;
                  border-radius:10px;padding:1px 7px;font-size:11px;font-weight:700;"></span>
          </button>
        </div>`;

      content.innerHTML = `
        <h2 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#111827;line-height:1.35;padding-right:24px;">
          ${supHtml(a.title)}<button
            type="button" id="pv-detail-title-copy" data-title="${esc(a.title || '')}"
            title="Copiar título"
            style="all:unset;display:inline-flex;vertical-align:super;margin-left:4px;
                   cursor:pointer;color:#9ca3af;font-size:13px;line-height:1;"
            ><i class="far fa-copy"></i></button>
        </h2>
        ${prionreadBadge}
        ${personalChips}
        ${chatLauncher}
        <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-size:14px;color:#6b7280;margin-bottom:16px;">
          ${a.authors ? esc(a.authors) : '—'}
          ${a.journal ? `<span style="margin:0 4px;color:#d1d5db;">·</span>${esc(a.journal)}` : ''}
          ${a.year    ? `<span style="margin:0 4px;color:#d1d5db;">·</span>${a.year}` : ''}
          ${a.doi     ? `<span style="margin:0 4px;color:#d1d5db;">·</span>
                         <a href="https://doi.org/${esc(a.doi)}" target="_blank" rel="noopener"
                            style="color:#0F3460;text-decoration:none;">${esc(a.doi)}</a><button
                            type="button" id="pv-detail-doi-copy" data-title="${esc(a.doi)}"
                            title="Copiar DOI"
                            style="all:unset;display:inline-flex;vertical-align:super;margin-left:3px;
                                   cursor:pointer;color:#9ca3af;font-size:11px;line-height:1;"
                            ><i class="far fa-copy"></i></button>` : ''}
          ${a.pubmed_id ? `<span style="margin:0 4px;color:#d1d5db;">·</span>
                           <a href="https://pubmed.ncbi.nlm.nih.gov/${esc(a.pubmed_id)}/"
                              target="_blank" rel="noopener"
                              title="Abrir en PubMed (útil para copiar el abstract a mano si la descarga falla)"
                              style="color:#0F3460;text-decoration:none;font-weight:600;">
                              PMID ${esc(a.pubmed_id)} ↗
                           </a><button
                              type="button" id="pv-detail-pmid-copy" data-title="${esc(a.pubmed_id)}"
                              title="Copiar PMID"
                              style="all:unset;display:inline-flex;vertical-align:super;margin-left:3px;
                                     cursor:pointer;color:#9ca3af;font-size:11px;line-height:1;"
                              ><i class="far fa-copy"></i></button>` : ''}
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
        <div id="pv-tag-picker-section" style="margin-top:22px;padding-top:14px;border-top:1px solid #f3f4f6;"></div>
        <div id="pv-ratings-section" style="margin-top:22px;padding-top:14px;border-top:1px solid #f3f4f6;"></div>
        <div id="pv-similar-section" style="margin-top:18px;padding-top:14px;border-top:1px solid #f3f4f6;"></div>
        <div id="pv-supplementary-section" style="margin-top:18px;padding-top:14px;border-top:1px solid #f3f4f6;"></div>
        <div id="pv-jc-section" style="margin-top:18px;padding-top:14px;border-top:1px solid #f3f4f6;"></div>
        <div id="pv-used-in-section" style="margin-top:18px;padding-top:14px;border-top:1px solid #f3f4f6;"></div>
        <div style="margin-top:18px;padding-top:14px;border-top:1px solid #f3f4f6;
                    display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
          <button id="pv-add-to-pack-btn" type="button"
                  style="padding:7px 14px;border-radius:8px;border:1px solid #d1d5db;background:white;
                         font-size:13px;font-weight:600;color:#0F3460;cursor:pointer;
                         display:inline-flex;align-items:center;gap:6px;">
            <i class="fas fa-cubes-stacked"></i>
            <span>Añadir a PrionPack</span>
          </button>
          ${IS_ADMIN ? `
            <button id="pv-edit-article-btn" type="button"
                    title="Editar campos del artículo (incluye reintento de CrossRef/PubMed con DOI o PMID corregidos)"
                    style="padding:7px 14px;border-radius:8px;border:1px solid #d1d5db;background:white;
                           font-size:13px;font-weight:600;color:#0F3460;cursor:pointer;
                           display:inline-flex;align-items:center;gap:6px;">
              <i class="fas fa-pen-to-square"></i>
              <span>Editar</span>
            </button>
            <button id="pv-delete-article-btn" type="button"
                    title="Eliminar este artículo y su PDF de Dropbox"
                    style="padding:7px 14px;border-radius:8px;border:1px solid #fecaca;background:white;
                           font-size:13px;font-weight:600;color:#b91c1c;cursor:pointer;
                           display:inline-flex;align-items:center;gap:6px;margin-left:auto;">
              <i class="fas fa-trash"></i>
              <span>Eliminar artículo</span>
            </button>` : ''}
        </div>
        <div style="margin-top:20px;padding-top:14px;border-top:1px solid #f3f4f6;
                    font-size:12px;color:#9ca3af;font-family:ui-monospace,monospace;">
          Added: ${a.added_at ? esc(a.added_at.slice(0, 10)) : '—'}
          · Status: ${esc(a.extraction_status || 'pending')}
          ${a.indexed_at ? ' · Indexed: ' + esc(a.indexed_at.slice(0, 10)) : ''}
        </div>
      `;
      _wireCopyBtn(document.getElementById('pv-detail-title-copy'), { stopProp: false });
      _wireCopyBtn(document.getElementById('pv-detail-doi-copy'),   { stopProp: false });
      _wireCopyBtn(document.getElementById('pv-detail-pmid-copy'),  { stopProp: false });
      renderRatingsSection(a);
      wirePdfViewer(a);
      wirePersonalState(a);
      wireChatLauncher(a);
      renderAiSummary(a);
      wireUnpaywallButton(a);
      wireAddToPackButton(a);
      wireEditArticleButton(a);
      wireDeleteArticleButton(a);
      renderTagPickerSection(a);
      renderSimilarSection(a);
      renderSupplementarySection(a);
      renderJcSection(a);
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

    // Fetch used-in pack data for all similar articles in parallel
    const usedInMap = {};
    await Promise.all(items.map(async it => {
      try {
        const d = await api(`/articles/${it.id}/used-in`);
        usedInMap[it.id] = d.packs || [];
      } catch { usedInMap[it.id] = []; }
    }));

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

        // DOI / PMID chips
        const idChips = [
          it.doi
            ? `<a href="https://doi.org/${esc(it.doi)}" target="_blank" rel="noopener"
                  onclick="event.stopPropagation()"
                  title="Abrir en doi.org"
                  style="font-size:10.5px;background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe;
                         padding:1px 7px;border-radius:5px;font-weight:600;text-decoration:none;">DOI ↗</a>`
            : '',
          it.pubmed_id
            ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${esc(it.pubmed_id)}/" target="_blank" rel="noopener"
                  onclick="event.stopPropagation()"
                  title="Abrir en PubMed"
                  style="font-size:10.5px;background:#dbeafe;color:#1d4ed8;border:1px solid #93c5fd;
                         padding:1px 7px;border-radius:5px;font-weight:600;text-decoration:none;">PMID ${esc(it.pubmed_id)} ↗</a>`
            : '',
        ].filter(Boolean).join('');

        // PrionPacks usage badges
        const packs = usedInMap[it.id] || [];
        const packBadges = packs.map(p => {
          const sections = (p.lists || []).map(t => t === 'intro' ? 'Intro' : 'General').join('+');
          return `<span title="${esc(p.id)}: ${esc(p.title || '')}"
                        style="font-size:10.5px;background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0;
                               padding:1px 7px;border-radius:5px;font-weight:600;max-width:120px;
                               overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;">
                    📦 ${esc(p.id)}${sections ? ' · ' + sections : ''}
                  </span>`;
        }).join('');

        const extraRow = (idChips || packBadges)
          ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:4px;align-items:center;">
               ${idChips}${packBadges}
             </div>`
          : '';

        return `
          <div class="pv-similar-row" data-aid="${esc(it.id)}"
               style="display:flex;align-items:flex-start;gap:10px;padding:8px 10px;
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
              ${extraRow}
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

  // ── Tag picker section in the detail modal ────────────────────────────
  async function renderTagPickerSection(a) {
    const sec = document.getElementById('pv-tag-picker-section');
    if (!sec) return;
    const articleTagIds = new Set((a.tags || []).map(t => t.id));

    sec.innerHTML = `
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0 0 8px;">
        <h3 style="margin:0;font-size:14px;font-weight:600;color:#374151;
                   text-transform:uppercase;letter-spacing:0.05em;">Tags</h3>
        <span style="font-size:11px;color:#9ca3af;">Click para asignar / quitar</span>
      </div>
      <div id="pv-tag-picker-list" style="display:flex;flex-wrap:wrap;gap:6px;
                                          font-size:12px;color:#9ca3af;">Cargando…</div>`;

    let allTags = [];
    try {
      allTags = await api('/tags');
    } catch (e) {
      const listErr = document.getElementById('pv-tag-picker-list');
      if (listErr) listErr.innerHTML =
        `<span style="color:#b91c1c;">Error: ${esc(e.message)}</span>`;
      return;
    }
    if (!allTags.length) {
      const listEmpty = document.getElementById('pv-tag-picker-list');
      if (listEmpty) listEmpty.innerHTML =
        `<span style="font-style:italic;">No hay tags todavía. ` +
        `Pulsa <strong>"+ Nuevo tag"</strong> para crear el primero.</span>`;
      return;
    }

    renderChips();

    function renderChips() {
      const list = document.getElementById('pv-tag-picker-list');
      list.innerHTML = allTags.map(t => {
        const on = articleTagIds.has(t.id);
        const color = t.color || '#6b7280';
        return `
          <button type="button" class="pv-tag-pick" data-tag-id="${t.id}"
                  style="padding:4px 10px;border-radius:14px;font-size:12px;font-weight:600;
                         cursor:pointer;transition:transform 0.1s ease, opacity 0.1s ease;
                         border:1.5px solid ${esc(color)};
                         background:${on ? esc(color) : 'white'};
                         color:${on ? 'white' : esc(color)};
                         opacity:${on ? '1' : '0.7'};
                         display:inline-flex;align-items:center;gap:5px;">
            ${on ? '<i class="fas fa-check" style="font-size:9px;"></i>' : ''}
            ${esc(t.name)}
          </button>`;
      }).join('');

      list.querySelectorAll('.pv-tag-pick').forEach(b => {
        b.addEventListener('click', async () => {
          const tid = parseInt(b.dataset.tagId, 10);
          const wasOn = articleTagIds.has(tid);
          b.disabled = true;
          try {
            if (wasOn) {
              await api(`/articles/${a.id}/tags/${tid}`, { method: 'DELETE' });
              articleTagIds.delete(tid);
              a.tags = (a.tags || []).filter(x => x.id !== tid);
            } else {
              await api(`/articles/${a.id}/tags/${tid}`, { method: 'PUT' });
              articleTagIds.add(tid);
              const t = allTags.find(x => x.id === tid);
              if (t) a.tags = [...(a.tags || []), t];
            }
            renderChips();
            refreshTags();   // update sidebar counts
          } catch (e) {
            alert('Error: ' + e.message);
            b.disabled = false;
          }
        });
      });

      // "+ Nuevo tag" button — available to all logged-in users.
      const newBtn = list.parentElement.querySelector('.pv-tag-new-inline');
      if (newBtn) newBtn.addEventListener('click', async () => {
        const palette = {
          rojo: '#ef4444', naranja: '#fb923c', amarillo: '#f59e0b',
          verde: '#22c55e', azul: '#3b82f6', morado: '#a855f7',
          rosa: '#ec4899', gris: '#6b7280', cian: '#06b6d4',
        };
        const name = prompt('Nombre del nuevo tag:');
        if (!name || !name.trim()) return;
        const colorInput = prompt(
          'Color (hex #rrggbb o nombre: rojo/naranja/amarillo/verde/azul/morado/rosa/gris/cian).\nVacío = sin color.'
        );
        let color = null;
        if (colorInput && colorInput.trim()) {
          const v = colorInput.trim().toLowerCase();
          color = palette[v] || (v.startsWith('#') ? v : null);
        }
        try {
          const created = await api('/tags', {
            method: 'POST',
            body: JSON.stringify({ name: name.trim(), color }),
          });
          allTags = await api('/tags');
          // Auto-assign the newly created tag to this article.
          await api(`/articles/${a.id}/tags/${created.id}`, { method: 'PUT' });
          articleTagIds.add(created.id);
          a.tags = [...(a.tags || []), created];
          renderChips();
          refreshTags();
        } catch (e) {
          alert('No se pudo crear el tag: ' + e.message);
        }
      });
    }

    // Append "+ Nuevo tag" button below the chip list (rendered once).
    const container = sec.querySelector('#pv-tag-picker-list');
    if (container && !sec.querySelector('.pv-tag-new-inline')) {
      const newTagBtn = document.createElement('button');
      newTagBtn.type = 'button';
      newTagBtn.className = 'pv-tag-new-inline';
      newTagBtn.style.cssText =
        'margin-top:8px;padding:4px 10px;font-size:11px;border-radius:14px;' +
        'border:1px dashed #d1d5db;background:white;color:#6b7280;cursor:pointer;' +
        'display:flex;align-items:center;gap:4px;';
      newTagBtn.innerHTML = '<i class="fas fa-plus" style="font-size:9px;"></i> Nuevo tag';
      container.insertAdjacentElement('afterend', newTagBtn);
    }
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

    // Supplementary uploads are open to any logged-in user since the
    // permission audit — the server tags each row with added_by and
    // only allows the creator (or an admin) to PATCH / DELETE later.
    const heading = `
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0 0 8px;">
        <h3 style="margin:0;font-size:14px;font-weight:600;color:#374151;
                   text-transform:uppercase;letter-spacing:0.05em;">Material suplementario</h3>
        <button id="pv-supp-add-btn" type="button"
                style="padding:4px 10px;font-size:12px;border-radius:6px;border:1px solid #d1d5db;
                       background:white;color:#0F3460;font-weight:600;cursor:pointer;">
          <i class="fas fa-plus" style="margin-right:4px;"></i>Añadir
        </button>
      </div>`;
    sec.innerHTML = heading +
      `<div id="pv-supp-list" style="font-size:12.5px;color:#9ca3af;">Cargando…</div>`;

    wireSupplementaryUpload(a);

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
          Sin material suplementario. Pulsa "Añadir" para subir un archivo.
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
          ${(admin || (it.added_by && it.added_by === USER_ID)) ? `
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

