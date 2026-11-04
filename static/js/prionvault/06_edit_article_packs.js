  // ── Edit article modal ─────────────────────────────────────────────
  // Opened from the detail modal's "✏ Editar" button. The point of
  // the modal is to recover from a wrong DOI / PMID: the user
  // corrects the identifier, re-runs the lookup, sees the fields
  // refill with the (hopefully correct) metadata, and saves.
  function wireEditArticleButton(a) {
    const btn = document.getElementById('pv-edit-article-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const fresh = await api(`/articles/${a.id}`);
        openEditModal(fresh);
      } catch (err) {
        alert('No se pudo abrir el editor: ' + err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  let _editTarget = null;

  function openEditModal(a) {
    const modal = document.getElementById('pv-edit-modal');
    if (!modal) return;
    _editTarget = a;
    document.getElementById('pv-edit-title').value    = a.title    || '';
    document.getElementById('pv-edit-authors').value  = a.authors  || '';
    document.getElementById('pv-edit-year').value     = a.year     || '';
    document.getElementById('pv-edit-journal').value  = a.journal  || '';
    document.getElementById('pv-edit-doi').value      = a.doi      || '';
    document.getElementById('pv-edit-pmid').value     = a.pubmed_id || '';
    document.getElementById('pv-edit-abstract').value = a.abstract || '';
    const status = document.getElementById('pv-edit-status');
    status.textContent = '';
    status.style.color = '#6b7280';
    // Reset the Save button — on a successful PATCH the previous open
    // left it disabled with "Guardando…" because close() runs before
    // we restore the label. Re-opening would otherwise show the stale
    // state.
    const saveBtn = document.getElementById('pv-edit-save');
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Guardar cambios';
    }
    const saveNextBtn = document.getElementById('pv-edit-save-next');
    if (saveNextBtn) {
      saveNextBtn.disabled = false;
      saveNextBtn.textContent = 'Guardar y siguiente →';
    }
    const nextBtn = document.getElementById('pv-edit-next');
    if (nextBtn) { nextBtn.disabled = false; nextBtn.textContent = 'Siguiente →'; }
    const prevBtn = document.getElementById('pv-edit-prev');
    if (prevBtn) { prevBtn.disabled = false; prevBtn.textContent = '← Anterior'; }
    const delBtn = document.getElementById('pv-edit-delete');
    if (delBtn) { delBtn.disabled = false; delBtn.textContent = '🗑 Borrar artículo'; }
    const noAbsBtn = document.getElementById('pv-edit-no-abstract');
    if (noAbsBtn) { noAbsBtn.disabled = false; noAbsBtn.textContent = '📕 Sin abstract'; }
    _editRenderPdfPreview(a);
    _editSyncPmidLink(a.pubmed_id || '');
    // Reset the "Sin PMID" toggle so the styling doesn't bleed across
    // articles when the operator navigates Siguiente / Anterior.
    _editSyncNoPmidButton(!!a.pubmed_unavailable);
    // Mount the attach-PDF dropzone. Shown prominently when the article
    // has no PDF yet, smaller "reemplazar" hint otherwise.
    _editSyncPdfAttach(!!a.has_pdf);
    const aiBtn = document.getElementById('pv-edit-identify-ai');
    if (aiBtn) {
      const ok = !!a.has_pdf;
      aiBtn.disabled = !ok;
      aiBtn.textContent = '🤖 Buscar PMID con IA';
      aiBtn.style.opacity = ok ? '1' : '0.45';
      aiBtn.style.cursor  = ok ? 'pointer' : 'not-allowed';
      aiBtn.title = ok
        ? 'La IA lee el PDF, identifica el artículo y busca su PMID en PubMed. Si no encuentra el PMID, copia el título al portapapeles para buscarlo a mano.'
        : 'Este artículo no tiene PDF guardado';
    }
    // AI summary token info + PDF verification block
    _editRenderTokensBlock(a);
    _editRenderVerifyBlock(a);

    const editCartBtn = document.getElementById('pv-edit-cart-btn');
    if (editCartBtn) {
      const inCart = window.PPCart?.has(a.id);
      editCartBtn.innerHTML = inCart ? '🛒 ✓' : '🛒';
      editCartBtn.style.background   = inCart ? '#d1fae5' : '#f9fafb';
      editCartBtn.style.color        = inCart ? '#065f46' : '#374151';
      editCartBtn.style.borderColor  = inCart ? '#6ee7b7' : '#d1d5db';
      editCartBtn.title = inCart ? 'En el carrito' : 'Añadir al carrito de PrionPacks';
      editCartBtn.onclick = () => {
        if (!window.PPCart) return;
        window.PPCart.add({
          id: a.id, title: a.title || '', authors: a.authors || '',
          year: a.year || null, journal: a.journal || '',
          doi: a.doi || '', pubmed_id: a.pubmed_id || '', has_pdf: !!a.has_pdf,
        });
        editCartBtn.innerHTML = '🛒 ✓';
        editCartBtn.style.background  = '#d1fae5';
        editCartBtn.style.color       = '#065f46';
        editCartBtn.style.borderColor = '#6ee7b7';
        editCartBtn.title = 'En el carrito';
      };
    }

    modal.style.display = 'flex';
    setTimeout(() => document.getElementById('pv-edit-doi').focus(), 50);
  }

  function _editRenderTokensBlock(a) {
    const block = document.getElementById('pv-edit-tokens-block');
    if (!block) return;
    const hasSummary = a.has_summary_ai || !!(a.summary_ai || '').trim();
    const hasNotes   = !!(a.summary_ai_notes || '').trim();
    if (!hasSummary && !hasNotes) { block.style.display = 'none'; return; }
    block.style.display = 'block';

    // Provider selector
    const provSel  = document.getElementById('pv-edit-summary-provider');
    if (provSel) provSel.value = a.summary_ai_provider || '';

    // Token counts
    const countEl = document.getElementById('pv-edit-tokens-counts');
    if (countEl) {
      const tin  = a.summary_tokens_in;
      const tout = a.summary_tokens_out;
      countEl.textContent = (tin != null || tout != null)
        ? `${(tin || 0).toLocaleString('es-ES')} in / ${(tout || 0).toLocaleString('es-ES')} out tk`
        : '';
    }

    // Error note preview + clear button
    const clearBtn    = document.getElementById('pv-edit-clear-notes');
    const notesPreview = document.getElementById('pv-edit-notes-preview');
    if (clearBtn && notesPreview) {
      if (hasNotes) {
        clearBtn.style.display = 'inline-flex';
        notesPreview.style.display = 'block';
        // Show just the first line (type + message) to keep it compact
        notesPreview.textContent = a.summary_ai_notes.split('\n')[0];
      } else {
        clearBtn.style.display = 'none';
        notesPreview.style.display = 'none';
        notesPreview.textContent = '';
      }
    }
  }

  function _editRenderVerifyBlock(a) {
    const block  = document.getElementById('pv-edit-verify-block');
    if (!block) return;
    const v = a.pdf_verify;
    if (!v || !v.status) { block.style.display = 'none'; return; }

    block.style.display = 'block';
    const badge  = document.getElementById('pv-edit-verify-badge');
    const score  = document.getElementById('pv-edit-verify-score');
    const detail = document.getElementById('pv-edit-verify-detail');

    const cfg = {
      mismatch:  { label: '✗ Mismatch',    bg: '#fee2e2', color: '#7f1d1d' },
      suspect:   { label: '⚠ Sospechoso',  bg: '#fef3c7', color: '#7c2d12' },
      ok:        { label: '✓ OK',           bg: '#d1fae5', color: '#065f46' },
      manual_ok: { label: '✓ OK manual',   bg: '#d1fae5', color: '#065f46' },
      no_pdf_text: { label: '◐ Sin texto', bg: '#f3f4f6', color: '#374151' },
    }[v.status] || { label: v.status, bg: '#f3f4f6', color: '#374151' };

    badge.textContent = cfg.label;
    badge.style.background = cfg.bg;
    badge.style.color = cfg.color;
    badge.style.padding = '2px 8px';
    badge.style.borderRadius = '99px';

    score.textContent = v.score != null ? `(score: ${Number(v.score).toFixed(2)})` : '';

    let detailTxt = '';
    if (v.detail) {
      try {
        const d = typeof v.detail === 'string' ? JSON.parse(v.detail) : v.detail;
        const lines = [];
        if (d.title_ok   === false) lines.push('• Título: discrepancia detectada');
        if (d.year_ok    === false) lines.push('• Año: discrepancia detectada');
        if (d.journal_ok === false) lines.push('• Revista: discrepancia detectada');
        if (d.authors_ok === false) lines.push('• Autores: discrepancia detectada');
        if (d.verdict)              lines.push(`Veredicto IA: ${d.verdict}`);
        if (d.reasoning)            lines.push(`Razonamiento: ${d.reasoning}`);
        detailTxt = lines.join('\n');
      } catch (_) {
        detailTxt = String(v.detail);
      }
    }
    detail.textContent = detailTxt;
    if (v.checked_at) {
      const dt = new Date(v.checked_at);
      detail.textContent += (detailTxt ? '\n' : '') +
        `Verificado: ${dt.toLocaleDateString('es-ES')} ${dt.toLocaleTimeString('es-ES', {hour:'2-digit',minute:'2-digit'})}`;
    }
  }

  function _editStatus(msg, color) {
    const el = document.getElementById('pv-edit-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = color || '#6b7280';
  }

  async function _editRefetch(by) {
    const status = document.getElementById('pv-edit-status');
    const doiEl  = document.getElementById('pv-edit-doi');
    const pmidEl = document.getElementById('pv-edit-pmid');
    const payload = { doi: '', pubmed_id: '' };
    if (by === 'doi')  payload.doi       = doiEl.value.trim();
    if (by === 'pmid') payload.pubmed_id = pmidEl.value.trim();
    if (!payload.doi && !payload.pubmed_id) {
      _editStatus('Rellena un DOI o un PMID antes de buscar.', '#b91c1c');
      return;
    }
    _editStatus(`Consultando ${by === 'doi' ? 'CrossRef / PubMed por DOI' : 'PubMed por PMID'}…`);
    try {
      const r = await api('/articles/lookup', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (!r.found) {
        _editStatus(`No se encontraron metadatos con ese ${by.toUpperCase()}.`, '#b45309');
        return;
      }
      const m = r.metadata || {};
      // Overwrite every field the lookup returned. The user can
      // still hand-edit before saving — we don't second-guess them.
      if (m.title)    document.getElementById('pv-edit-title').value    = m.title;
      if (m.authors)  document.getElementById('pv-edit-authors').value  = m.authors;
      if (m.year)     document.getElementById('pv-edit-year').value     = m.year;
      if (m.journal)  document.getElementById('pv-edit-journal').value  = m.journal;
      if (m.doi)      doiEl.value  = m.doi;
      if (m.pubmed_id) pmidEl.value = m.pubmed_id;
      _editSyncPmidLink(pmidEl.value);
      if (m.abstract) document.getElementById('pv-edit-abstract').value = m.abstract;
      const dupNote = r.duplicate_of && r.duplicate_of !== _editTarget?.id
        ? '  ⚠️ Ya existe otro artículo con ese DOI/PMID — revisa antes de guardar.'
        : '';
      _editStatus(`✓ Metadatos cargados desde ${m.source || 'el resolver'}. Edita si hace falta y guarda.${dupNote}`,
                  dupNote ? '#b45309' : '#15803d');
    } catch (e) {
      _editStatus('Error de lookup: ' + e.message, '#b91c1c');
    }
  }

  // Find the article id that follows the currently-edited one in the
  // visible results table, or null if we're at the last row of the page.
  function _editNextRowId() {
    if (!_editTarget) return null;
    const cb = document.querySelector(`.pv-row-select[data-aid="${_editTarget.id}"]`);
    if (!cb) return null;
    const row = cb.closest('tr');
    let next = row && row.nextElementSibling;
    while (next) {
      const nextCb = next.querySelector('.pv-row-select');
      if (nextCb && nextCb.dataset.aid) return nextCb.dataset.aid;
      next = next.nextElementSibling;
    }
    return null;
  }

  // Mirror of _editNextRowId but walking backwards.
  function _editPrevRowId() {
    if (!_editTarget) return null;
    const cb = document.querySelector(`.pv-row-select[data-aid="${_editTarget.id}"]`);
    if (!cb) return null;
    const row = cb.closest('tr');
    let prev = row && row.previousElementSibling;
    while (prev) {
      const prevCb = prev.querySelector('.pv-row-select');
      if (prevCb && prevCb.dataset.aid) return prevCb.dataset.aid;
      prev = prev.previousElementSibling;
    }
    return null;
  }

  // Toggle the "PMID ↗" external link button next to the PMID input
  // to match the current value. Reads from the DOM (input.value)
  // rather than from _editTarget so it stays correct after the user
  // pastes / clears the field, or after _editRefetch fills it in.
  function _editSyncPmidLink(rawValue) {
    const link = document.getElementById('pv-edit-pmid-link');
    if (!link) return;
    const pmid = String(rawValue || '').trim();
    if (/^\d+$/.test(pmid)) {
      link.href = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
      link.style.display = '';
      link.title = `Abrir PMID ${pmid} en PubMed (nueva pestaña)`;
    } else {
      link.removeAttribute('href');
      link.style.display = 'none';
    }
  }

  // Render the mini-PDF preview at the top of the Edit modal. Sized
  // at ~1/4 of the detail-modal viewer (78vh) so the title is
  // legible without taking over the modal. The Open Parameters
  // (#view=FitH&toolbar=0) ask Chromium / Firefox to fit the page
  // width and hide the toolbar; Safari ignores them but the iframe
  // still renders correctly.
  function _editRenderPdfPreview(a) {
    const box = document.getElementById('pv-edit-pdf-preview');
    if (!box) return;
    if (!a || !a.has_pdf) {
      box.style.display = 'none';
      box.innerHTML = '';
      return;
    }
    box.style.display = 'block';
    box.innerHTML = `<iframe
        src="/prionvault/api/articles/${esc(a.id)}/pdf#view=FitH&toolbar=0&navpanes=0"
        style="display:block;width:100%;height:220px;border:0;background:#1f2937;"
        title="PDF: ${esc(a.title || '')}"></iframe>`;
  }

  // Best-effort clipboard copy. Returns true if it worked, false if
  // the API was unavailable or the browser rejected (e.g. http context).
  async function _copyToClipboard(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_e) { /* fall through */ }
    // Legacy fallback: hidden textarea + document.execCommand('copy').
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_e) {
      return false;
    }
  }

  // Show / repaint the "Adjuntar PDF" dropzone in the Edit modal.
  // hasPdf=true means the article already has a PDF — the zone shrinks
  // to a one-line "Reemplazar" hint. hasPdf=false → prominent attach
  // CTA. The handlers are wired once on first call (closure flag).
  let _pdfAttachWired = false;
  function _editSyncPdfAttach(hasPdf) {
    const wrap   = document.getElementById('pv-edit-pdf-attach');
    const drop   = document.getElementById('pv-edit-pdf-drop');
    const text   = document.getElementById('pv-edit-pdf-drop-text');
    const file   = document.getElementById('pv-edit-pdf-file');
    const status = document.getElementById('pv-edit-pdf-upload-status');
    const delBtn = document.getElementById('pv-edit-pdf-delete');
    if (!wrap || !drop || !file) return;
    wrap.style.display = '';
    status.style.display = 'none';
    status.innerHTML = '';
    if (delBtn) delBtn.style.display = hasPdf ? 'inline-flex' : 'none';
    if (hasPdf) {
      drop.style.padding = '8px 12px';
      drop.style.fontSize = '12px';
      drop.style.borderStyle = 'dashed';
      text.innerHTML = '<strong>Reemplazar PDF</strong> — arrastra otro fichero o pulsa para seleccionar.';
    } else {
      drop.style.padding = '14px';
      drop.style.fontSize = '13px';
      drop.style.borderStyle = 'dashed';
      text.innerHTML = '<strong>Adjuntar PDF</strong> — arrastra un archivo aquí o pulsa para seleccionar.';
    }
    file.value = '';
    if (_pdfAttachWired) return;
    _pdfAttachWired = true;
    file.addEventListener('change', () => {
      if (file.files && file.files[0]) _editUploadPdf(file.files[0]);
    });
    delBtn?.addEventListener('click', _editDeletePdf);
    // Drag-and-drop affordance. The <label> already triggers the
    // hidden <input>, but we also handle dragenter / drop so a file
    // dropped on the box is picked up directly.
    drop.addEventListener('dragenter', (e) => {
      e.preventDefault(); e.stopPropagation();
      drop.style.background = '#dbeafe';
      drop.style.borderColor = '#0F3460';
    });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
    drop.addEventListener('dragleave', (e) => {
      e.preventDefault(); e.stopPropagation();
      drop.style.background = '#f9fafb';
      drop.style.borderColor = '#d1d5db';
    });
    drop.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      drop.style.background = '#f9fafb';
      drop.style.borderColor = '#d1d5db';
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) _editUploadPdf(f);
    });
  }

  // "🗑" next to the dropzone: removes the PDF currently attached to the
  // article (Dropbox file + every PDF-related column/index), so it goes
  // back to a clean "no PDF" state — distinct from "Reemplazar PDF",
  // which uploads a new one straight away.
  async function _editDeletePdf() {
    if (!_editTarget) return;
    if (!confirm(
      'Vas a eliminar el PDF adjunto a este artículo (se borra también de Dropbox).\n\n' +
      'El artículo se queda sin PDF hasta que subas otro. ¿Continuar?'
    )) return;
    const btn = document.getElementById('pv-edit-pdf-delete');
    const status = document.getElementById('pv-edit-pdf-upload-status');
    if (btn) btn.disabled = true;
    status.style.display = 'block';
    status.style.color = '#374151';
    status.textContent = '⏳ Eliminando PDF…';
    try {
      await api(`/articles/${_editTarget.id}/pdf`, { method: 'DELETE' });
      _editTarget.has_pdf = false;
      _editRenderPdfPreview(_editTarget);
      _editSyncPdfAttach(false);
      status.style.display = 'block';
      status.style.color = '#15803d';
      status.textContent = '✓ PDF eliminado.';
      setTimeout(() => { status.style.display = 'none'; status.textContent = ''; }, 2000);
      loadArticles();
    } catch (e) {
      status.style.display = 'block';
      status.style.color = '#b91c1c';
      status.textContent = 'Error al eliminar: ' + e.message;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ── "🔓 Buscar PDF" — on-demand open-access search ────────────────────
  // Tries Unpaywall then OpenAlex (server-side, a few seconds); on failure
  // offers a ready-to-send "ask the author" email as the last resort.
  let _oaSearchWired = false;
  let _oaCurrentArticle = null;
  function _oaStepHtml(label, state, detail) {
    const icon = state === 'pending' ? '<i class="fas fa-spinner fa-spin" style="color:#9ca3af;"></i>'
               : state === 'ok'      ? '<i class="fas fa-check" style="color:#15803d;"></i>'
               :                       '<i class="fas fa-xmark" style="color:#b91c1c;"></i>';
    return `<div style="display:flex;align-items:center;gap:8px;font-size:13px;">
      <span style="width:16px;text-align:center;flex-shrink:0;">${icon}</span>
      <span style="font-weight:600;color:#111827;">${esc(label)}</span>
      ${detail ? `<span style="color:#6b7280;font-size:12px;">— ${esc(detail)}</span>` : ''}
    </div>`;
  }
  function _oaSourceLabel(source) {
    return source === 'unpaywall' ? 'Unpaywall' : source === 'openalex' ? 'OpenAlex' : source;
  }

  function _oaWireOnce() {
    if (_oaSearchWired) return;
    _oaSearchWired = true;
    const close = () => { document.getElementById('pv-oa-search-modal').style.display = 'none'; };
    document.getElementById('pv-oa-search-close')?.addEventListener('click', close);
    document.querySelector('#pv-oa-search-modal .pv-modal-backdrop')?.addEventListener('click', close);
    document.getElementById('pv-oa-author-copy')?.addEventListener('click', async () => {
      const subject = document.getElementById('pv-oa-author-mailto').dataset.subject || '';
      const body = document.getElementById('pv-oa-author-mailto').dataset.body || '';
      const btn = document.getElementById('pv-oa-author-copy');
      const ok = await _copyToClipboard(`${subject}\n\n${body}`);
      if (ok) {
        const orig = btn.textContent;
        btn.textContent = '✓ Copiado';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }
    });
    document.getElementById('pv-oa-author-email')?.addEventListener('input', _oaUpdateMailtoHref);
    document.getElementById('pv-oa-author-requested')?.addEventListener('click', async () => {
      const a = _oaCurrentArticle;
      if (!a) return;
      const btn = document.getElementById('pv-oa-author-requested');
      btn.disabled = true;
      try {
        const r = await api(`/articles/${a.id}/oa-request`, { method: 'POST' });
        a.oa_author_requested = !!r.oa_author_requested;
        _oaSyncRequestedBtn(a.oa_author_requested);
        _oaSyncBadge(a);
        loadArticles();
      } catch (e) {
        alert('No se pudo actualizar: ' + e.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  function _oaSyncRequestedBtn(requested) {
    const btn = document.getElementById('pv-oa-author-requested');
    if (!btn) return;
    if (requested) {
      btn.textContent = '✓ Ya pedido';
      btn.style.background = '#dcfce7';
      btn.style.color = '#15803d';
      btn.style.borderColor = '#86efac';
    } else {
      btn.textContent = 'Indicar que se ha pedido';
      btn.style.background = '#fff';
      btn.style.color = '#374151';
      btn.style.borderColor = '#d1d5db';
    }
  }

  // Reflects a.oa_author_requested on the 🔓 badge wherever it's shown —
  // the listing row (repainted via loadArticles() after a toggle) and,
  // if the detail modal happens to be open on this same article, its
  // nav-bar button too.
  function _oaSyncBadge(a) {
    const detailOaBtn = document.getElementById('pv-detail-oa-btn');
    if (detailOaBtn) {
      detailOaBtn.innerHTML = a.oa_author_requested ? '🔓✓' : '🔓';
      detailOaBtn.title = a.oa_author_requested
        ? 'Ya se ha pedido el PDF al autor — clic para volver a intentarlo'
        : 'Buscar el PDF en fuentes de acceso abierto (Unpaywall, OpenAlex)';
    }
  }

  function _oaUpdateMailtoHref() {
    const link = document.getElementById('pv-oa-author-mailto');
    if (!link) return;
    const to = (document.getElementById('pv-oa-author-email')?.value || '').trim();
    const subject = link.dataset.subject || '';
    const body = link.dataset.body || '';
    link.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  async function openOaSearchModal(a) {
    _oaWireOnce();
    _oaCurrentArticle = a;
    const modal = document.getElementById('pv-oa-search-modal');
    if (!modal) return;
    document.getElementById('pv-oa-search-article').textContent = a.title || '(sin título)';
    const steps = document.getElementById('pv-oa-search-steps');
    steps.innerHTML = _oaStepHtml('Unpaywall', 'pending') + _oaStepHtml('OpenAlex', 'pending');
    document.getElementById('pv-oa-search-author').style.display = 'none';
    modal.style.display = 'flex';

    try {
      const r = await api(`/articles/${a.id}/oa-search`, { method: 'POST' });
      const tried = r.tried || [];
      steps.innerHTML = tried
        .filter(t => t.source === 'unpaywall' || t.source === 'openalex')
        .map(t => _oaStepHtml(_oaSourceLabel(t.source), t.ok ? 'ok' : 'fail', t.reason))
        .join('');
      if (r.ok) {
        steps.insertAdjacentHTML('beforeend',
          `<div style="margin-top:6px;font-size:13px;color:#15803d;font-weight:600;">
             ✓ PDF encontrado y adjuntado al artículo (${esc(_oaSourceLabel(r.via))}).
           </div>`);
        a.has_pdf = true;
        loadArticles();
        openDetail(a.id);
      } else {
        const authorBlock = document.getElementById('pv-oa-search-author');
        const mailto = r.mailto || { subject: '', body: '', to: '' };
        const link = document.getElementById('pv-oa-author-mailto');
        link.dataset.subject = mailto.subject || '';
        link.dataset.body = mailto.body || '';
        document.getElementById('pv-oa-author-email').value = mailto.to || '';
        _oaUpdateMailtoHref();
        const rgLink = document.getElementById('pv-oa-researchgate-link');
        if (rgLink) rgLink.href = r.researchgate_search_url || '#';
        _oaSyncRequestedBtn(!!a.oa_author_requested);
        authorBlock.style.display = 'block';
      }
    } catch (e) {
      steps.innerHTML = `<div style="color:#b91c1c;font-size:13px;">Error: ${esc(e.message)}</div>`;
    }
  }

  async function _editUploadPdf(file) {
    if (!_editTarget) return;
    if (!file || !file.name || !file.name.toLowerCase().endsWith('.pdf')) {
      _editStatus('Solo PDFs.', '#b91c1c'); return;
    }
    const status = document.getElementById('pv-edit-pdf-upload-status');
    status.style.display = 'block';
    status.style.color = '#374151';
    status.textContent = `⏳ Subiendo ${file.name} (${(file.size/1024/1024).toFixed(1)} MB)…`;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await fetch(`/prionvault/api/articles/${_editTarget.id}/upload-pdf`, {
        method: 'POST',
        credentials: 'same-origin',
        body: fd,
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        status.style.color = '#15803d';
        status.innerHTML = `✓ PDF adjuntado (${(d.size_bytes/1024/1024).toFixed(1)} MB). ` +
          `Las pipelines de extracción / OCR / index / resumen lo recogerán en background.`;
        // Reflect locally so the modal's preview + chips know we have a PDF.
        _editTarget.has_pdf = true;
        _editTarget.dropbox_path = d.dropbox_path;
        _editRenderPdfPreview(_editTarget);
        _editSyncPdfAttach(true);
        // Refresh the listing row's thumbnail too — it caches by URL,
        // so without a fresh cache-busting query string it keeps
        // showing the previous PDF's first page even after this upload.
        {
          const listingRow = document.querySelector(
            `tr.pv-article-row[data-aid="${CSS.escape(_editTarget.id)}"]`);
          const thumbImg = listingRow?.querySelector('img.pv-thumb');
          if (thumbImg) {
            thumbImg.src = `/prionvault/api/articles/${encodeURIComponent(_editTarget.id)}/thumbnail?_=${Date.now()}`;
          }
        }
        // Re-enable the "🤖 Buscar PMID con IA" button — it greys
        // out when there's no PDF.
        const aiBtn = document.getElementById('pv-edit-identify-ai');
        if (aiBtn) { aiBtn.disabled = false; aiBtn.style.opacity = '1';
                     aiBtn.style.cursor = 'pointer'; }
      } else if (r.status === 409) {
        status.style.color = '#b91c1c';
        status.innerHTML = `⚠ Este PDF ya está asignado a otro artículo ` +
          (d.duplicate_of ? `(<a href="#" id="pv-edit-pdf-dup-open" style="color:#0F3460;text-decoration:underline;">ver original</a>)` : '') +
          `. Revisa si es un duplicado antes de re-subirlo.`;
        const a = document.getElementById('pv-edit-pdf-dup-open');
        if (a) a.addEventListener('click', (ev) => { ev.preventDefault(); openDetail(d.duplicate_of); });
      } else {
        status.style.color = '#b91c1c';
        status.textContent = `Error: ${d.detail || d.error || r.status}`;
      }
    } catch (e) {
      status.style.color = '#b91c1c';
      status.textContent = `Error de red: ${e.message}`;
    }
  }

  // Paint the "Sin PMID" toggle based on the article's current
  // pubmed_unavailable flag. Called both when the modal opens for a
  // new article (reset from previous state — the styling sticks
  // visually otherwise) and after the user toggles it.
  function _editSyncNoPmidButton(unavailable) {
    const btn = document.getElementById('pv-edit-no-pmid');
    if (!btn) return;
    btn.disabled = false;
    if (unavailable) {
      btn.textContent     = '✓ Sin PMID — pulsa para deshacer';
      btn.style.background  = '#d1fae5';
      btn.style.color       = '#047857';
      btn.style.borderColor = '#a7f3d0';
      btn.title = 'Marcado como confirmado-sin-PMID. Pulsa para desmarcar y volver a la cola de búsqueda.';
    } else {
      btn.textContent     = '✗ Sin PMID';
      btn.style.background  = 'white';
      btn.style.color       = '#b91c1c';
      btn.style.borderColor = '#fecaca';
      btn.title = 'Marca este artículo como "no tiene PMID en PubMed". Lo excluye de futuras búsquedas de PMID a mano o en bulk.';
    }
  }

  // "✗ Sin PMID" toggle right of the PMID input. Reads the article's
  // current pubmed_unavailable flag and flips it via the existing
  // /articles/<id>/mark-no-pmid endpoint (same one the PMID-manual
  // panel uses), then repaints the button to reflect the new state.
  async function _editMarkNoPmid() {
    if (!_editTarget) return;
    const currently = !!_editTarget.pubmed_unavailable;
    const goingTo   = !currently;
    const confirmMsg = goingTo
      ? ('Marcar este artículo como confirmado-sin-PMID?\n\n' +
         '• La búsqueda automática lo saltará en futuros lotes.\n' +
         '• Desaparece de la lista de "Recuperar PMIDs faltantes".\n' +
         '¿Continuar?')
      : ('Desmarcar "sin PMID"?\n\n' +
         '• El artículo vuelve a la cola de búsqueda de PMID.\n' +
         '¿Continuar?');
    if (!confirm(confirmMsg)) return;

    const btn = document.getElementById('pv-edit-no-pmid');
    const orig = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = '⏳…'; }
    try {
      await api(`/articles/${_editTarget.id}/mark-no-pmid`, {
        method: 'POST',
        body: JSON.stringify({ value: goingTo }),
      });
      // Persist the change on the local _editTarget so navigating
      // Siguiente / Anterior + coming back paints the right state.
      _editTarget.pubmed_unavailable = goingTo;
      _editSyncNoPmidButton(goingTo);
      _editStatus(
        goingTo
          ? 'Marcado como "sin PMID". Las búsquedas automáticas lo dejarán en paz.'
          : 'Desmarcado. El artículo vuelve a la cola de búsqueda de PMID.',
        '#15803d',
      );
    } catch (e) {
      _editStatus(`Error: ${e.message}`, '#b91c1c');
      if (btn) { btn.disabled = false; btn.textContent = orig; }
    }
  }

  // Run "🤖 Buscar PMID con IA": ship the saved PDF off to the backend,
  // get a PMID back, and either chain into _editRefetch('pmid') to
  // refill the form, surface the duplicate warning (PDF was moved
  // aside server-side), or — when PubMed esearch couldn't resolve the
  // title — copy the title to the clipboard and offer a one-click
  // PubMed search link so the user can paste it and pick the PMID by
  // hand.
  async function _editIdentifyAI() {
    if (!_editTarget) return;
    if (!_editTarget.has_pdf) {
      _editStatus('Este artículo no tiene PDF guardado.', '#b91c1c');
      return;
    }
    const btn = document.getElementById('pv-edit-identify-ai');
    if (btn) { btn.disabled = true; btn.textContent = '🤖 Pensando…'; }
    _editStatus('La IA está leyendo el PDF…');
    try {
      const r = await api(`/articles/${_editTarget.id}/identify-pmid`, { method: 'POST' });
      const id = r.identified || {};
      const idLabel = `«${id.title || '(sin título)'}» · ${id.first_author_lastname || '?'} · ${id.year || '?'}`;
      if (r.duplicate) {
        const dup = r.duplicate_of || {};
        const moved = r.moved_to
          ? `<br>📂 PDF movido a <code style="font-size:11px;">${esc(r.moved_to)}</code>`
          : (r.move_error ? `<br><span style="color:#b91c1c;">⚠️ No se pudo mover el PDF: ${esc(r.move_error)}</span>` : '');
        const link = dup.id
          ? ` — <a href="#" id="pv-edit-ai-dup-open" style="color:#0F3460;text-decoration:underline;">Ver original</a>`
          : '';
        const el = document.getElementById('pv-edit-status');
        el.innerHTML =
          `⚠️ Duplicado detectado. La IA identificó ${esc(idLabel)} → PMID ${esc(String(r.pmid))},` +
          ` que ya existe en la biblioteca${link}.${moved}<br>` +
          'Decide si quieres borrar este registro o conservarlo sin PDF.';
        el.style.color = '#b45309';
        if (dup.id) {
          const a = document.getElementById('pv-edit-ai-dup-open');
          if (a) a.addEventListener('click', (ev) => { ev.preventDefault(); openDetail(dup.id); });
        }
        // Reflect the unlink locally so the AI button greys out if pressed again.
        if (_editTarget) _editTarget.has_pdf = false;
      } else {
        document.getElementById('pv-edit-pmid').value = String(r.pmid);
        _editStatus(`La IA identificó ${idLabel} → PMID ${r.pmid}. Buscando metadatos…`);
        await _editRefetch('pmid');
      }
    } catch (e) {
      const body = e.body || {};
      const guessed = body.identified || {};
      const title  = (typeof guessed.title === 'string' ? guessed.title : '').trim();
      const author = guessed.first_author_lastname || '?';
      const year   = guessed.year || '?';

      // PubMed esearch came up empty but the AI did read the PDF — copy
      // the title to the clipboard so the user can paste it into the
      // PubMed search box in their browser. Also emit a one-click link
      // straight to PubMed pre-filled with the title.
      let copied = false;
      if (title) copied = await _copyToClipboard(title);

      const el = document.getElementById('pv-edit-status');
      el.style.color = '#b91c1c';
      const hintParts = [];
      hintParts.push(`No se pudo identificar el PMID con IA: ${esc(e.message || '')}`);
      if (title) {
        const url = `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(title)}`;
        hintParts.push(
          `La IA pensó: «${esc(title)}» · ${esc(String(author))} · ${esc(String(year))}.`);
        if (copied) {
          hintParts.push(
            `<span style="color:#15803d;">📋 Título copiado al portapapeles</span> — ` +
            `pégalo en <a href="${esc(url)}" target="_blank" rel="noopener" ` +
              `style="color:#0F3460;text-decoration:underline;">PubMed</a> ` +
              `o usa el enlace para abrir la búsqueda ya rellenada.`);
        } else {
          hintParts.push(
            `<a href="${esc(url)}" target="_blank" rel="noopener" ` +
              `style="color:#0F3460;text-decoration:underline;">Abrir búsqueda en PubMed con este título ↗</a>`);
        }
      }
      el.innerHTML = hintParts.join('<br>');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🤖 Buscar PMID con IA'; }
    }
  }

  // Shared save handler. Resolves to the saved article's id on success,
  // or null if the PATCH was rejected (409 / validation). The caller
  // decides whether to advance to the next row, reopen the detail modal,
  // or just close.
  async function _editPerformSave(triggerBtnId) {
    if (!_editTarget) return null;
    const updates = {
      title:     document.getElementById('pv-edit-title').value.trim(),
      authors:   document.getElementById('pv-edit-authors').value.trim() || null,
      year:      parseInt(document.getElementById('pv-edit-year').value, 10) || null,
      journal:   document.getElementById('pv-edit-journal').value.trim() || null,
      doi:       document.getElementById('pv-edit-doi').value.trim()  || null,
      pubmed_id: document.getElementById('pv-edit-pmid').value.trim() || null,
      abstract:  document.getElementById('pv-edit-abstract').value.trim() || null,
    };
    if (!updates.title) {
      _editStatus('El título no puede estar vacío.', '#b91c1c');
      return null;
    }
    const btn = triggerBtnId ? document.getElementById(triggerBtnId) : null;
    let originalLabel = null;
    if (btn) { originalLabel = btn.textContent; btn.disabled = true; btn.textContent = 'Guardando…'; }
    try {
      await api(`/articles/${_editTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      });
      return _editTarget.id;
    } catch (e) {
      if (e.status === 409) {
        const dup = (e.body && e.body.duplicate_of) || '';
        const where = (e.body && e.body.matched_on === 'pubmed_id') ? 'PMID' : 'DOI';
        const linkHtml = dup
          ? ` — <a href="#" id="pv-edit-dup-open" style="color:#0F3460;text-decoration:underline;">Ver existente</a>`
          : '';
        const el = document.getElementById('pv-edit-status');
        el.innerHTML = `⚠️ Ya existe otro artículo con ese ${where}.` +
                       ` Corrige el campo antes de guardar.${linkHtml}`;
        el.style.color = '#b45309';
        if (dup) {
          const lnk = document.getElementById('pv-edit-dup-open');
          if (lnk) lnk.addEventListener('click', (ev) => { ev.preventDefault(); openDetail(dup); });
        }
      } else {
        _editStatus('Error al guardar: ' + e.message, '#b91c1c');
      }
      return null;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
    }
  }

  function wireEditModal() {
    const modal = document.getElementById('pv-edit-modal');
    if (!modal || modal.dataset.wired) return;
    modal.dataset.wired = '1';
    const close = () => {
      modal.style.display = 'none';
      _editTarget = null;
      // Drop the iframe so it stops loading / playing PDF.js timers.
      const pdfBox = document.getElementById('pv-edit-pdf-preview');
      if (pdfBox) { pdfBox.style.display = 'none'; pdfBox.innerHTML = ''; }
    };
    document.getElementById('pv-edit-close') ?.addEventListener('click', close);
    document.getElementById('pv-edit-cancel')?.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop')?.addEventListener('click', close);
    _wireCopyBtn(document.getElementById('pv-edit-title-copy'), {
      stopProp: false,
      getValue: () => document.getElementById('pv-edit-title').value.trim(),
    });
    _wireCopyBtn(document.getElementById('pv-edit-journal-copy'), {
      stopProp: false,
      getValue: () => document.getElementById('pv-edit-journal').value.trim(),
    });
    _wireCopyBtn(document.getElementById('pv-edit-doi-copy'), {
      stopProp: false,
      getValue: () => document.getElementById('pv-edit-doi').value.trim(),
    });
    _wireCopyBtn(document.getElementById('pv-edit-pmid-copy'), {
      stopProp: false,
      getValue: () => document.getElementById('pv-edit-pmid').value.trim(),
    });
    document.getElementById('pv-edit-refetch-doi') ?.addEventListener('click', () => _editRefetch('doi'));
    document.getElementById('pv-edit-refetch-pmid')?.addEventListener('click', () => _editRefetch('pmid'));
    document.getElementById('pv-edit-identify-ai') ?.addEventListener('click', _editIdentifyAI);
    document.getElementById('pv-edit-no-pmid')     ?.addEventListener('click', _editMarkNoPmid);

    // Quick filler for the "no abstract" case — saves the admin from
    // copy-pasting the literal sentinel string. Doesn't auto-save;
    // the user still has to press Guardar so this composes with
    // any other edits in flight.
    document.getElementById('pv-edit-no-abstract')?.addEventListener('click', () => {
      const ta = document.getElementById('pv-edit-abstract');
      if (ta) {
        ta.value = 'No abstract available.';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        _editStatus('Abstract marcado como "No abstract available." — recuerda Guardar.', '#6b7280');
      }
    });

    // Keep the "PMID ↗" link in sync with whatever's in the input.
    // Hidden when empty so the user only sees it when there's an
    // actual PubMed entry to open.
    const pmidInput = document.getElementById('pv-edit-pmid');
    if (pmidInput) {
      const syncPmidLink = () => _editSyncPmidLink(pmidInput.value);
      pmidInput.addEventListener('input', syncPmidLink);
      pmidInput.addEventListener('change', syncPmidLink);
    }

    document.getElementById('pv-edit-save')?.addEventListener('click', async () => {
      const aid = await _editPerformSave('pv-edit-save');
      if (!aid) return;
      close();
      loadArticles();
      openDetail(aid);
    });

    document.getElementById('pv-edit-save-next')?.addEventListener('click', async () => {
      const nextId = _editNextRowId();
      const aid = await _editPerformSave('pv-edit-save-next');
      if (!aid) return;
      loadArticles();
      await _editAdvanceTo(nextId, 'Guardado.');
    });

    // Plain "Siguiente →" / "← Anterior": no save, no delete, just
    // move on. Useful when the current row is fine as-is and the
    // admin wants to skim through the list.
    document.getElementById('pv-edit-next')?.addEventListener('click', async () => {
      const nextId = _editNextRowId();
      await _editAdvanceTo(nextId, '');
    });
    document.getElementById('pv-edit-prev')?.addEventListener('click', async () => {
      const prevId = _editPrevRowId();
      await _editAdvanceTo(prevId, '');
    });

    // "🗑 Borrar artículo": typically used right after the AI flow
    // surfaces "este ya está metido". Wipes the row + PDF and jumps
    // straight to the next article so the triage keeps flowing.
    // When the deleted row was the last on the current page, advance
    // to the next page automatically and open its first visible row.
    document.getElementById('pv-edit-delete')?.addEventListener('click', async () => {
      if (!_editTarget) return;
      // Capture now — modal close can null _editTarget while await is pending.
      const target = _editTarget;
      const stub = (target.title || '').slice(0, 80);
      const ok = confirm(
        'Vas a eliminar este artículo de la biblioteca:\n\n' +
        `"${stub}${(target.title || '').length > 80 ? '…' : ''}"\n\n` +
        '• La fila se borra de la base de datos.\n' +
        '• El PDF se borra de Dropbox (queda en el historial ~30 días).\n' +
        '• Desaparece de PrionRead, PrionPacks, asignaciones y ratings.\n\n' +
        'Esta acción no se puede deshacer desde la app. ¿Continuar?'
      );
      if (!ok) return;
      // Snapshot navigation context BEFORE the row disappears.
      const nextId = _editNextRowId();
      const hasMorePages = (state.page * state.size) < (state.lastTotal || 0);
      const btn = document.getElementById('pv-edit-delete');
      const orig = btn ? btn.textContent : null;
      if (btn) { btn.disabled = true; btn.textContent = 'Eliminando…'; }
      try {
        await api(`/articles/${target.id}`, { method: 'DELETE' });
      } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = orig; }
        _editStatus('Error al eliminar: ' + e.message, '#b91c1c');
        return;
      }
      if (state.selectedIds && state.selectedIds.has(target.id)) {
        state.selectedIds.delete(target.id);
        if (typeof updateBulkBar === 'function') updateBulkBar();
      }
      refreshStats();
      if (btn) { btn.disabled = false; btn.textContent = orig; }

      if (nextId) {
        loadArticles();
        await _editAdvanceTo(nextId, 'Artículo eliminado.');
        return;
      }
      if (hasMorePages) {
        state.page += 1;
        await loadArticles();
        const firstRow = document.querySelector('.pv-row-select');
        const firstId  = firstRow ? firstRow.dataset.aid : null;
        await _editAdvanceTo(firstId, `Artículo eliminado. Página ${state.page}.`);
        return;
      }
      loadArticles();
      _editStatus('Artículo eliminado. No hay más artículos.', '#15803d');
    });

    // Provider selector — saves immediately on change
    document.getElementById('pv-edit-summary-provider')?.addEventListener('change', async (e) => {
      if (!_editTarget) return;
      const val = e.target.value || null;
      try {
        await api(`/articles/${_editTarget.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ summary_ai_provider: val }),
        });
        _editTarget.summary_ai_provider = val;
        _editStatus('Proveedor actualizado.', '#15803d');
        // Refresh the row badge in the list without a full reload
        const row = document.querySelector(`[data-aid="${_editTarget.id}"]`)?.closest('tr,li,.pv-row');
        if (row) loadArticles();
      } catch (err) {
        _editStatus('Error al guardar proveedor: ' + err.message, '#b91c1c');
      }
    });

    // Clear error note button
    document.getElementById('pv-edit-clear-notes')?.addEventListener('click', async () => {
      if (!_editTarget) return;
      const btn = document.getElementById('pv-edit-clear-notes');
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = '⏳';
      try {
        await api(`/articles/${_editTarget.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ summary_ai_notes: null }),
        });
        _editTarget.summary_ai_notes = null;
        _editRenderTokensBlock(_editTarget);
        _editStatus('Nota de error eliminada.', '#15803d');
      } catch (err) {
        _editStatus('Error: ' + err.message, '#b91c1c');
      } finally {
        btn.disabled = false; btn.textContent = orig;
      }
    });

    // PDF verification quick-actions
    document.getElementById('pv-edit-verify-ok')?.addEventListener('click', async () => {
      if (!_editTarget) return;
      const btn = document.getElementById('pv-edit-verify-ok');
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = '⏳';
      try {
        await api('/admin/verify-metadata/mark', {
          method: 'POST',
          body: JSON.stringify({ ids: [_editTarget.id], status: 'manual_ok' }),
        });
        // Refresh the block with the new status
        if (_editTarget.pdf_verify) _editTarget.pdf_verify.status = 'manual_ok';
        _editRenderVerifyBlock(_editTarget);
        _editStatus('Marcado como OK manual.', '#15803d');
      } catch (e) {
        _editStatus('Error: ' + e.message, '#b91c1c');
      } finally {
        btn.disabled = false; btn.textContent = orig;
      }
    });

    document.getElementById('pv-edit-verify-recheck')?.addEventListener('click', async () => {
      if (!_editTarget) return;
      const btn = document.getElementById('pv-edit-verify-recheck');
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = '⏳';
      try {
        await api('/admin/verify-metadata/recheck', {
          method: 'POST',
          body: JSON.stringify({ ids: [_editTarget.id] }),
        });
        // Clear the verification block — will be set on next verifier run
        if (_editTarget.pdf_verify) _editTarget.pdf_verify.status = null;
        _editRenderVerifyBlock(_editTarget);
        _editStatus('Marcado para reverificación. Se analizará en el próximo ciclo.', '#6b7280');
      } catch (e) {
        _editStatus('Error: ' + e.message, '#b91c1c');
      } finally {
        btn.disabled = false; btn.textContent = orig;
      }
    });
  }

  // Shared "open the next article in the visible list" helper. If
  // there's no next row on the current page, closes the modal with
  // a status message instead so the admin knows pagination is the
  // next step.
  async function _editAdvanceTo(nextId, prefix) {
    if (!nextId) {
      const msg = (prefix ? prefix + ' ' : '') + 'No hay más artículos en esta página.';
      _editStatus(msg.trim(), '#15803d');
      return;
    }
    if (prefix) _editStatus(`${prefix} Cargando siguiente…`, '#15803d');
    try {
      const next = await api(`/articles/${nextId}`);
      openEditModal(next);
    } catch (e) {
      _editStatus(`${prefix || ''} No se pudo abrir el siguiente: ${e.message}`.trim(), '#b91c1c');
    }
  }

  // ── Add to PrionPack (per-article) ───────────────────────────────────
  function wireDeleteArticleButton(a) {
    const btn = document.getElementById('pv-delete-article-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const titleStub = (a.title || '').slice(0, 80);
      const confirmMsg =
        'Vas a eliminar este artículo de la biblioteca:\n\n' +
        `“${titleStub}${(a.title || '').length > 80 ? '…' : ''}”\n\n` +
        '• La fila se borra de la base de datos.\n' +
        '• El PDF se borra de Dropbox (queda en el historial de versiones ~30 días).\n' +
        '• Desaparece de PrionRead, PrionPacks, asignaciones y ratings.\n\n' +
        'Esta acción no se puede deshacer desde la app. ¿Continuar?';
      if (!confirm(confirmMsg)) return;
      btn.disabled = true;
      const orig = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Eliminando…';
      try {
        const r = await api(`/articles/${a.id}`, { method: 'DELETE' });
        // Close the detail modal and reload the list.
        const modal = document.getElementById('pv-detail-modal');
        if (modal) modal.style.display = 'none';
        // If we have a stale selection, drop the deleted id.
        if (state.selectedIds && state.selectedIds.has(a.id)) {
          state.selectedIds.delete(a.id);
          if (typeof updateBulkBar === 'function') updateBulkBar();
        }
        loadArticles();
        refreshStats();
      } catch (e) {
        alert('Error al eliminar: ' + e.message);
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    });
  }

  // Open the pack-picker modal for a list of article ids. Re-uses the
  // same HTML as wireAddToPackButton but POSTs to /import-articles
  // (singular endpoint sees a race per call, the new bulk endpoint
  // applies all references in one update_package).
  async function openBulkPackPicker(articleIds) {
    const modal     = document.getElementById('pv-pack-modal');
    if (!modal) return;
    if (!articleIds || !articleIds.length) {
      alert('Selecciona al menos un artículo primero.');
      return;
    }
    const listEl    = document.getElementById('pv-pack-list');
    const statusEl  = document.getElementById('pv-pack-status');
    const saveBtn   = document.getElementById('pv-pack-save');
    const closeBtn  = document.getElementById('pv-pack-close');
    const cancelBtn = document.getElementById('pv-pack-cancel');
    const titleEl   = modal.querySelector('h2');
    const bodyP     = modal.querySelector('h2 + p');

    // Per-open scope: tweak the title + intro so the user knows this
    // is the bulk path. Reverted on close so the single-article flow
    // still reads cleanly.
    const origTitle = titleEl ? titleEl.innerHTML : '';
    const origBody  = bodyP ? bodyP.innerHTML  : '';
    if (titleEl) titleEl.innerHTML =
      `<i class="fas fa-cubes-stacked" style="color:#0F3460;margin-right:8px;"></i>` +
      `Añadir ${articleIds.length} artículos a un PrionPack`;
    if (bodyP) bodyP.innerHTML =
      `Vas a añadir <strong>${articleIds.length} artículos</strong> a uno o varios PrionPacks ` +
      `activos. Marca en qué lista de referencias entran: ` +
      `<strong>Introducción</strong>, <strong>Generales</strong> o ambas. ` +
      `Las referencias ya presentes (por DOI) se saltan automáticamente.`;
    if (saveBtn) saveBtn.textContent = `Añadir los ${articleIds.length}`;

    function restore() {
      if (titleEl) titleEl.innerHTML = origTitle;
      if (bodyP) bodyP.innerHTML = origBody;
      if (saveBtn) saveBtn.textContent = 'Añadir a los seleccionados';
    }
    function close() { modal.style.display = 'none'; restore(); }

    // Wire the close paths — replace any previous listeners by cloning.
    [closeBtn, cancelBtn].forEach(b => {
      if (!b) return;
      const fresh = b.cloneNode(true);
      b.parentNode.replaceChild(fresh, b);
      fresh.addEventListener('click', close);
    });
    const bd = modal.querySelector('.pv-modal-backdrop');
    if (bd) {
      const freshBd = bd.cloneNode(true);
      bd.parentNode.replaceChild(freshBd, bd);
      freshBd.addEventListener('click', close);
    }

    const selections = new Map();   // pack_id -> Set<"intro"|"general">

    const freshSave = saveBtn.cloneNode(true);
    freshSave.disabled = true;
    freshSave.style.opacity = '0.5';
    saveBtn.parentNode.replaceChild(freshSave, saveBtn);
    const finalSave = freshSave;
    finalSave.textContent = `Añadir los ${articleIds.length}`;

    function refreshSaveState() {
      const any = Array.from(selections.values()).some(s => s.size > 0);
      finalSave.disabled = !any;
      finalSave.style.opacity = finalSave.disabled ? '0.5' : '1';
    }

    modal.style.display = 'flex';
    listEl.innerHTML = '<div style="text-align:center;padding:30px;color:#9ca3af;font-size:13px;">Cargando PrionPacks activos…</div>';
    statusEl.textContent = '';

    let packs = [];
    try {
      const r = await fetch('/prionpacks/api/packages?active=1',
                            { credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      packs = await r.json();
    } catch (e) {
      listEl.innerHTML =
        `<div style="color:#b91c1c;padding:14px;font-size:13px;">Error: ${esc(e.message)}</div>`;
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
      </div>`).join('');

    listEl.querySelectorAll('.pv-pack-target').forEach(cb => {
      cb.addEventListener('change', () => {
        const pkgId = cb.dataset.pack;
        const tgt   = cb.dataset.target;
        const set   = selections.get(pkgId) || new Set();
        if (cb.checked) set.add(tgt); else set.delete(tgt);
        if (set.size === 0) selections.delete(pkgId);
        else selections.set(pkgId, set);
        refreshSaveState();
      });
    });

    finalSave.addEventListener('click', async () => {
      if (finalSave.disabled) return;
      finalSave.disabled = true;
      statusEl.style.color = '#6b7280';
      statusEl.textContent = `Añadiendo a ${selections.size} PrionPack(s)…`;
      const results = [];
      for (const [pkgId, targets] of selections.entries()) {
        try {
          const r = await fetch(
            `/prionpacks/api/packages/${encodeURIComponent(pkgId)}/import-articles`,
            {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                article_ids: articleIds,
                targets: Array.from(targets),
              }),
            }
          );
          const data = await r.json().catch(() => ({}));
          results.push({ pkgId, status: r.status, data });
        } catch (e) {
          results.push({ pkgId, status: 0, data: { error: e.message } });
        }
      }
      const okCount = results.filter(x => x.status === 200).length;
      const totals = results.reduce((acc, x) => {
        if (x.data && x.data.added) {
          acc.intro   += (x.data.added.intro   || 0);
          acc.general += (x.data.added.general || 0);
        }
        if (x.data && x.data.skipped) {
          acc.skippedIntro   += (x.data.skipped.intro   || 0);
          acc.skippedGeneral += (x.data.skipped.general || 0);
        }
        return acc;
      }, { intro: 0, general: 0, skippedIntro: 0, skippedGeneral: 0 });
      const totalAdded = totals.intro + totals.general;
      const totalSkipped = totals.skippedIntro + totals.skippedGeneral;
      if (totalAdded === 0 && totalSkipped > 0) {
        // Nothing actually landed — every target already had this
        // reference (by DOI or article_id). Flag it clearly instead of
        // a green "Hecho" that reads as success when it did nothing.
        statusEl.style.color = '#b45309';
        statusEl.textContent =
          `⚠ No se añadió nada nuevo: ya estaban referenciados en los packs/listas elegidos ` +
          `(${totalSkipped} ya presentes).`;
      } else {
        statusEl.style.color = '#15803d';
        statusEl.textContent =
          `Hecho: ${okCount}/${results.length} packs · ` +
          `${totals.intro} en Intro · ${totals.general} en Generales` +
          (totalSkipped ? ` · ${totalSkipped} ya presentes (omitidos)` : '') + '.';
      }
      finalSave.style.opacity = '0.5';
    });
  }

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

