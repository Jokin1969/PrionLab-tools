  // ── Import modal ─────────────────────────────────────────────────────
  //
  // Session-scoped: every PDF dropped into the modal returns a job id
  // from /api/ingest/upload; we accumulate those ids and poll only
  // them, so the UI never mixes in unrelated background work.
  //
  // When the queue drains we render a per-file summary card and, for
  // articles the resolver couldn't enrich (source=no_metadata, marked
  // in the job step as "done | md5=…"), offer a 🤖 button that runs
  // the same AI-PMID flow the Edit modal uses.

  let _importPolling = null;
  const _importSession = {
    jobIds:      new Set(),     // ids enqueued from this dropzone
    totalQueued: 0,             // total files we managed to enqueue
    totalDropped: 0,            // total .pdf files the user dropped
    finished:    false,         // summary already rendered
  };

  function _resetImportSession() {
    _importSession.jobIds.clear();
    _importSession.totalQueued  = 0;
    _importSession.totalDropped = 0;
    _importSession.finished     = false;
    const progress = document.getElementById('pv-import-progress');
    if (progress) { progress.innerHTML = ''; progress.style.display = 'none'; }
  }

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

    const open  = () => { _resetImportSession(); modal.style.display = 'flex'; };
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

    // Open-article links inside per-file summary cards — delegated so
    // we don't have to rebind every time the summary re-renders.
    const progressEl = document.getElementById('pv-import-progress');
    if (progressEl) progressEl.addEventListener('click', (ev) => {
      const a = ev.target.closest('.pv-import-open-article');
      if (!a) return;
      ev.preventDefault();
      const aid = a.dataset.aid;
      if (aid) openDetail(aid);
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
    // Don't clear progress — additional drops in the same session should
    // append, not wipe earlier per-file rows.
    _importSession.totalDropped += arr.length;
    _importSession.finished = false;
    _setImportHeader(`Subiendo ${arr.length} PDF${arr.length === 1 ? '' : 's'}…`);

    const BATCH = 25;
    let queuedNow = 0;
    let failedNow = 0;
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
          appendProgressLine(`Batch ${i / BATCH + 1}: ${err.error || r.status}`, 'error');
          failedNow += batch.length;
          continue;
        }
        const j = await r.json();
        (j.job_ids || []).forEach(id => _importSession.jobIds.add(Number(id)));
        queuedNow += j.queued || 0;
        if ((j.queued || 0) < batch.length) {
          failedNow += batch.length - (j.queued || 0);
        }
      } catch (e) {
        appendProgressLine(`Batch ${i / BATCH + 1}: ${e.message}`, 'error');
        failedNow += batch.length;
      }
    }
    _importSession.totalQueued += queuedNow;
    if (failedNow) {
      appendProgressLine(
        `No se pudieron encolar ${failedNow} de ${arr.length} ficheros (ver detalle arriba).`,
        'error');
    }
    _setImportHeader(`Procesando ${queuedNow} fichero${queuedNow === 1 ? '' : 's'}…`);

    // Only kick the poller off after at least one job was created.
    if (_importSession.jobIds.size > 0) startProgressPolling();
    refreshStats();
  }

  // The header is a single sticky row at the top of the progress panel
  // that shows live counts for *this session*. We update it in place
  // so the log below stays clean — no more spammy "queued: 0 · ..."
  // lines repeating every 4 seconds.
  function _setImportHeader(text, kind = 'info') {
    const progress = document.getElementById('pv-import-progress');
    if (!progress) return;
    let header = progress.querySelector('.pv-import-header');
    if (!header) {
      header = document.createElement('div');
      header.className = 'pv-row pv-import-header';
      header.style.cssText = 'background:#f3f4f6;padding:6px 8px;border-radius:6px;margin-bottom:6px;font-weight:600;';
      progress.prepend(header);
    }
    const color = kind === 'error' ? '#b91c1c' : kind === 'ok' ? '#15803d' : '#374151';
    header.innerHTML = `<span style="color:${color};">${escapeHtml(text)}</span>`;
  }

  function appendProgressLine(text, kind) {
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
      if (_importSession.jobIds.size === 0) return;
      const idsParam = Array.from(_importSession.jobIds).join(',');
      try {
        const r = await fetch(
          `/prionvault/api/ingest/jobs?ids=${idsParam}&limit=1000`,
          { credentials: 'same-origin' });
        if (!r.ok) return;
        const data = await r.json();
        const jobs = data.items || [];
        _renderSessionProgress(jobs);

        const terminal = jobs.filter(j =>
          j.status === 'done' || j.status === 'duplicate' || j.status === 'failed');
        if (jobs.length > 0 && terminal.length === jobs.length && !_importSession.finished) {
          _importSession.finished = true;
          stopProgressPolling();
          _renderImportSummary(jobs);
          refreshStats();
        }
      } catch (_e) { /* transient — try again next tick */ }
    };
    tick();  // first tick now, don't wait
    _importPolling = setInterval(tick, 2000);
  }

  // Human-readable label for each ingest step.
  const _STEP_LABELS = {
    staged:      '⏳ En cola',
    queued:      '⏳ En cola',
    extracting:  '📄 Extrayendo texto…',
    resolving:   '🔍 Buscando metadatos…',
    uploading:   '☁️ Subiendo a Dropbox…',
    indexing:    '🔢 Indexando…',
    done:        '✓ Listo',
    duplicate:   '⟳ Duplicado',
    failed:      '✗ Fallido',
    staged_missing: '✗ PDF perdido',
  };

  // Live header counts while jobs are in-flight.
  function _renderSessionProgress(jobs) {
    const counts = { done: 0, duplicate: 0, failed: 0, inFlight: 0 };
    for (const j of jobs) {
      if (j.status === 'done')           counts.done++;
      else if (j.status === 'duplicate') counts.duplicate++;
      else if (j.status === 'failed')    counts.failed++;
      else                               counts.inFlight++;
    }
    const total = jobs.length || _importSession.totalQueued;
    const processed = counts.done + counts.duplicate + counts.failed;
    const bits = [`${processed} / ${total} procesados`];
    if (counts.done)      bits.push(`<span style="color:#15803d;">✓ ${counts.done}</span>`);
    if (counts.duplicate) bits.push(`<span style="color:#b45309;">⟳ ${counts.duplicate}</span>`);
    if (counts.failed)    bits.push(`<span style="color:#b91c1c;">✗ ${counts.failed}</span>`);

    // Show the current step for any in-flight jobs
    const inFlightJobs = jobs.filter(j =>
      j.status !== 'done' && j.status !== 'duplicate' && j.status !== 'failed');
    if (inFlightJobs.length > 0) {
      const stepKey = inFlightJobs[0].step || inFlightJobs[0].status || 'queued';
      const stepLabel = _STEP_LABELS[stepKey] || stepKey;
      bits.push(`<span style="color:#6b7280;font-weight:400;">${stepLabel}</span>`);
    }

    const progress = document.getElementById('pv-import-progress');
    let header = progress.querySelector('.pv-import-header');
    if (!header) {
      header = document.createElement('div');
      header.className = 'pv-row pv-import-header';
      header.style.cssText = 'background:#f3f4f6;padding:6px 8px;border-radius:6px;margin-bottom:6px;font-weight:600;';
      progress.prepend(header);
    }
    header.innerHTML = bits.join(' &nbsp;·&nbsp; ');
  }

  // Once the session is drained, draw one card per file with the
  // specific outcome and — for the no-metadata case — a 🤖 button.
  function _renderImportSummary(jobs) {
    const progress = document.getElementById('pv-import-progress');
    if (!progress) return;

    // Clear log rows but keep the header row.
    Array.from(progress.querySelectorAll('.pv-row')).forEach(el => {
      if (!el.classList.contains('pv-import-header')) el.remove();
    });

    const counts = { done: 0, ok_meta: 0, no_meta: 0, duplicate: 0, failed: 0 };
    const cards = [];
    jobs.forEach(j => {
      const card = _buildJobSummaryCard(j);
      cards.push(card);
      if (j.status === 'done') {
        counts.done++;
        if (_jobLacksMetadata(j)) counts.no_meta++; else counts.ok_meta++;
      } else if (j.status === 'duplicate') counts.duplicate++;
      else if (j.status === 'failed')     counts.failed++;
    });
    cards.forEach(c => progress.appendChild(c));

    const summaryBits = [`Sesión terminada — ${jobs.length} fichero${jobs.length === 1 ? '' : 's'}`];
    if (counts.ok_meta)   summaryBits.push(`<span style="color:#15803d;">✓ ${counts.ok_meta} con metadatos</span>`);
    if (counts.no_meta)   summaryBits.push(`<span style="color:#92400e;">⚠ ${counts.no_meta} sin metadatos</span>`);
    if (counts.duplicate) summaryBits.push(`<span style="color:#b45309;">⟳ ${counts.duplicate} duplicado${counts.duplicate === 1 ? '' : 's'}</span>`);
    if (counts.failed)    summaryBits.push(`<span style="color:#b91c1c;">✗ ${counts.failed} fallido${counts.failed === 1 ? '' : 's'}</span>`);
    const header = progress.querySelector('.pv-import-header');
    if (header) header.innerHTML = summaryBits.join(' &nbsp;·&nbsp; ');
  }

  function _jobLacksMetadata(j) {
    // The worker writes "done | md5=..." when CrossRef/PubMed/title
    // search all came back empty. That's our cue to offer the AI flow.
    return j.status === 'done' && /^done\s*\|\s*md5=/.test(j.step || '');
  }

  function _buildJobSummaryCard(j) {
    const card = document.createElement('div');
    card.className = 'pv-row';
    card.style.cssText = 'align-items:flex-start;padding:6px 8px;border-radius:6px;border:1px solid #e5e7eb;margin-bottom:4px;';
    card.dataset.jobId = j.id;

    const fname = j.pdf_filename || '(sin nombre)';
    const step  = j.step || '';

    let badge, badgeBg, badgeFg;
    let bodyLines = [];
    let actionHtml = '';

    if (j.status === 'duplicate') {
      const by  = step.match(/by ([^\s|]+)/)?.[1] || '?';
      const doi = step.match(/doi=([^\s|]+)/)?.[1] || '';
      badge   = '⟳ Duplicado'; badgeBg = '#fef3c7'; badgeFg = '#92400e';
      bodyLines.push(`Coincide con un artículo existente (por ${by}).`);
      if (doi) bodyLines.push(`DOI extraído del PDF: <code style="font-size:11px;">${escapeHtml(doi)}</code>`);
      bodyLines.push(`El PDF se ha movido a la carpeta <code style="font-size:11px;">_duplicates/</code> dentro de la subcarpeta del año.`);
      if (j.article_id) actionHtml = _aLinkArticle(j.article_id, 'Ver original');
    } else if (j.status === 'failed') {
      badge   = '✗ Error'; badgeBg = '#fee2e2'; badgeFg = '#b91c1c';
      bodyLines.push(`<span style="color:#b91c1c;">${escapeHtml(j.error || step || 'Error desconocido')}</span>`);
      // Retry is meaningful here — the worker keeps the source PDF and a
      // single click re-queues the job.
      actionHtml = `<button class="pv-import-retry-btn" data-job-id="${j.id}"
                            style="padding:3px 8px;border-radius:5px;border:1px solid #d1d5db;background:white;font-size:11.5px;cursor:pointer;">↻ Reintentar</button>`;
    } else if (j.status === 'done') {
      const noMeta = _jobLacksMetadata(j);
      if (noMeta) {
        badge   = '⚠ Sin metadatos'; badgeBg = '#fef3c7'; badgeFg = '#92400e';
        bodyLines.push('El PDF se subió a Dropbox pero CrossRef / PubMed no devolvieron metadatos.');
        bodyLines.push('Probablemente el PDF no contenía DOI legible. La IA puede leer el título y resolver el PMID.');
        actionHtml = `<button class="pv-import-ai-btn" data-job-id="${j.id}" data-aid="${escapeHtml(j.article_id || '')}"
                              style="padding:3px 8px;border-radius:5px;border:none;background:#7c3aed;color:white;font-size:11.5px;font-weight:600;cursor:pointer;">🤖 Intentar con IA</button>`;
      } else {
        badge   = '✓ Importado'; badgeBg = '#dcfce7'; badgeFg = '#15803d';
        const doi   = step.match(/doi=([^\s|]+)/)?.[1];
        const pmid  = step.match(/pmid=([^\s|]+)/)?.[1];
        const path  = step.match(/\|\s*(\/[^\s]+)/g);
        const target = path && path[path.length - 1] ? path[path.length - 1].replace(/^\|\s*/, '') : '';
        if (doi)    bodyLines.push(`DOI: <code style="font-size:11px;">${escapeHtml(doi)}</code>`);
        if (pmid)   bodyLines.push(`PMID: <code style="font-size:11px;">${escapeHtml(pmid)}</code>`);
        if (target) bodyLines.push(`Archivo en: <code style="font-size:11px;">${escapeHtml(target)}</code>`);
        if (j.article_id) actionHtml = _aLinkArticle(j.article_id, 'Ver artículo');
      }
    } else {
      badge   = j.status; badgeBg = '#e5e7eb'; badgeFg = '#374151';
      bodyLines.push(escapeHtml(step));
    }

    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;width:100%;flex-wrap:wrap;">
        <span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:10.5px;font-weight:700;
                     background:${badgeBg};color:${badgeFg};white-space:nowrap;">${escapeHtml(badge)}</span>
        <span style="flex:1;min-width:0;font-weight:600;color:#111827;font-size:12.5px;
                     overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
              title="${escapeHtml(fname)}">${escapeHtml(fname)}</span>
        ${actionHtml}
      </div>
      ${bodyLines.length ? `<div style="margin-left:0;margin-top:4px;color:#4b5563;font-size:12px;line-height:1.5;">
        ${bodyLines.join('<br>')}
      </div>` : ''}`;

    const retry = card.querySelector('.pv-import-retry-btn');
    if (retry) retry.addEventListener('click', () => _retryImportJob(j.id, card));
    const ai = card.querySelector('.pv-import-ai-btn');
    if (ai) ai.addEventListener('click', () => _aiRecoverImportJob(j, card));
    return card;
  }

  function _aLinkArticle(articleId, label) {
    return `<a href="#" class="pv-import-open-article" data-aid="${escapeHtml(articleId)}"
                style="font-size:11.5px;color:#0F3460;text-decoration:underline;flex-shrink:0;">${escapeHtml(label)} →</a>`;
  }

  async function _retryImportJob(jobId, card) {
    const btn = card.querySelector('.pv-import-retry-btn');
    if (btn) { btn.disabled = true; btn.textContent = '↻ Reintentando…'; }
    try {
      const r = await fetch(`/prionvault/api/ingest/retry/${jobId}`, {
        method: 'POST', credentials: 'same-origin',
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
      // Job is back to queued — restart polling so the card updates
      // when the worker finishes the second attempt.
      _importSession.finished = false;
      startProgressPolling();
    } catch (e) {
      alert('No se pudo reintentar: ' + e.message);
      if (btn) { btn.disabled = false; btn.textContent = '↻ Reintentar'; }
    }
  }

  async function _aiRecoverImportJob(job, card) {
    const aid = job.article_id;
    const btn = card.querySelector('.pv-import-ai-btn');
    if (!aid) {
      alert('No hay artículo asociado al job — no se puede usar IA.');
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '🤖 Pensando…'; }
    try {
      const r = await api(`/articles/${aid}/identify-pmid`, { method: 'POST' });
      if (r.duplicate) {
        const dup = r.duplicate_of || {};
        card.innerHTML = '';
        card.appendChild(_buildAiResultBlock({
          status:   'duplicate',
          fname:    job.pdf_filename,
          pmid:     r.pmid,
          moved_to: r.moved_to,
          moveErr:  r.move_error,
          original: dup,
        }));
        return;
      }
      // 2) Resolve full metadata by PMID.
      const lookup = await api('/articles/lookup', {
        method: 'POST', body: JSON.stringify({ pubmed_id: String(r.pmid) }),
      });
      if (!lookup.found) {
        if (btn) { btn.disabled = false; btn.textContent = '🤖 Intentar con IA'; }
        alert(`La IA propuso PMID ${r.pmid} pero PubMed no devolvió metadatos.`);
        return;
      }
      const m = lookup.metadata || {};
      // 3) PATCH the article with whatever PubMed gave us.
      try {
        await api(`/articles/${aid}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title:     m.title || null,
            authors:   m.authors || null,
            year:      m.year || null,
            journal:   m.journal || null,
            doi:       m.doi || null,
            pubmed_id: m.pubmed_id || String(r.pmid),
            abstract:  m.abstract || null,
          }),
        });
      } catch (e) {
        // PATCH 409 = the resolved PMID/DOI already belongs to another
        // article. Treat as duplicate at this late stage too.
        if (e.status === 409) {
          card.innerHTML = '';
          card.appendChild(_buildAiResultBlock({
            status: 'conflict',
            fname:  job.pdf_filename,
            pmid:   r.pmid,
            error:  e.message,
          }));
          return;
        }
        throw e;
      }
      card.innerHTML = '';
      card.appendChild(_buildAiResultBlock({
        status:   'ok',
        fname:    job.pdf_filename,
        pmid:     m.pubmed_id || String(r.pmid),
        title:    m.title,
        year:     m.year,
        article_id: aid,
      }));
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '🤖 Intentar con IA'; }
      alert('La IA no pudo identificar el PMID: ' + (e.message || 'error'));
    }
  }

  function _buildAiResultBlock(r) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:6px 8px;border-radius:6px;border:1px solid #e5e7eb;margin-bottom:4px;';
    let badge, body;
    if (r.status === 'ok') {
      wrap.style.background = '#f0fdf4';
      badge = '<span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:10.5px;font-weight:700;background:#dcfce7;color:#15803d;">🤖 Recuperado con IA</span>';
      const title = r.title ? `«${escapeHtml((r.title || '').slice(0, 110))}${r.title.length > 110 ? '…' : ''}»` : '';
      body = `<div style="margin-top:4px;font-size:12px;color:#166534;">
                PMID <code>${escapeHtml(String(r.pmid))}</code>${r.year ? ' · ' + escapeHtml(String(r.year)) : ''}<br>
                ${title}
              </div>`;
    } else if (r.status === 'duplicate' || r.status === 'conflict') {
      wrap.style.background = '#fffbeb';
      badge = '<span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:10.5px;font-weight:700;background:#fef3c7;color:#92400e;">⟳ Duplicado tras IA</span>';
      const moved = r.moved_to
        ? `El PDF se ha movido a <code style="font-size:11px;">${escapeHtml(r.moved_to)}</code> y se ha desvinculado del artículo.`
        : (r.moveErr ? `<span style="color:#b91c1c;">No se pudo mover el PDF: ${escapeHtml(r.moveErr)}</span>` : 'Artículo desvinculado.');
      const orig = r.original && r.original.id
        ? `Original: ${_aLinkArticle(r.original.id, 'Ver original')}`
        : (r.error ? `Conflicto: ${escapeHtml(r.error)}` : '');
      body = `<div style="margin-top:4px;font-size:12px;color:#92400e;">
                La IA identificó PMID <code>${escapeHtml(String(r.pmid))}</code>, que ya existe en la biblioteca.<br>
                ${moved}<br>${orig}
              </div>`;
    } else {
      wrap.style.background = '#fef2f2';
      badge = '<span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:10.5px;font-weight:700;background:#fee2e2;color:#b91c1c;">✗ IA sin éxito</span>';
      body = `<div style="margin-top:4px;font-size:12px;color:#7f1d1d;">${escapeHtml(r.error || '')}</div>`;
    }
    wrap.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        ${badge}
        <span style="flex:1;min-width:0;font-weight:600;color:#111827;font-size:12.5px;
                     overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
              title="${escapeHtml(r.fname || '')}">${escapeHtml(r.fname || '')}</span>
        ${r.article_id ? _aLinkArticle(r.article_id, 'Ver artículo') : ''}
      </div>
      ${body}`;
    return wrap;
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
        if (!confirm('¿Borrar todas las filas terminadas (failed, duplicate y done)? Las que estén en curso (queued / processing) se mantienen. La acción no se puede deshacer.')) return;
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
    const stepFull  = j.step || '';
    // The step string is `done | doi=… | /path/to.pdf` — long, with
    // no spaces inside the URL-ish tokens, so word-break:break-word
    // ended up wrapping one character per line. Truncate to a single
    // line and keep the full value in `title` for hover inspection.
    const stepShort = stepFull.length > 70 ? stepFull.slice(0, 70) + '…' : stepFull;

    // × force-delete is always available — covers zombies stuck in
    // 'extracting' / 'resolving' after a worker crash, which the
    // bulk "Limpiar terminados" path deliberately won't touch.
    const deleteBtn = `<button class="pv-btn-del" data-job="${j.id}"
                                title="Borrar esta fila (también si está atascada). Borra el PDF staged si lo hubiera."
                                style="border:none;background:transparent;color:#9ca3af;cursor:pointer;
                                       font-size:14px;line-height:1;padding:2px 6px;border-radius:4px;"
                                onmouseover="this.style.background='#fee2e2';this.style.color='#b91c1c';"
                                onmouseout="this.style.background='transparent';this.style.color='#9ca3af';"
                        >×</button>`;
    const retryBtn = showRetry
      ? `<button class="pv-btn-retry" data-job="${j.id}">Retry</button> `
      : '';

    tr.innerHTML = `
      <td style="color:#9ca3af;">${j.id}</td>
      <td title="${escapeHtml(j.pdf_filename || '')}">${escapeHtml((j.pdf_filename || '').slice(0, 60))}</td>
      <td><span style="font-size:11px;font-weight:600;color:${statusColor(j.status)};">${escapeHtml(j.status)}</span></td>
      <td title="${escapeHtml(stepFull)}"
          style="color:#6b7280;max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,monospace;font-size:11.5px;">
        ${escapeHtml(stepShort)}
      </td>
      <td title="${escapeHtml(j.error || '')}"
          style="color:#b91c1c;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
        ${escapeHtml((j.error || '').slice(0, 80))}
      </td>
      <td style="color:#9ca3af;white-space:nowrap;">${j.created_at ? j.created_at.slice(0, 16).replace('T', ' ') : ''}</td>
      <td style="white-space:nowrap;">${retryBtn}${deleteBtn}</td>
    `;
    if (showRetry) {
      tr.querySelector('.pv-btn-retry').addEventListener('click', async () => {
        const r = await fetch('/prionvault/api/ingest/retry/' + j.id, { method: 'POST', credentials: 'same-origin' });
        if (r.ok) refreshQueue();
      });
    }
    tr.querySelector('.pv-btn-del').addEventListener('click', async () => {
      const label = `${j.pdf_filename || '(sin nombre)'} (#${j.id}, ${j.status})`;
      if (!confirm(`Borrar la fila ${label} de la cola?\n\nSi el PDF estaba a medio procesar también se elimina el archivo staged. La acción no se puede deshacer.`)) return;
      try {
        const r = await fetch('/prionvault/api/ingest/jobs/' + j.id, {
          method: 'DELETE', credentials: 'same-origin',
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          alert('No se pudo borrar: ' + (d.error || r.status));
          return;
        }
        refreshQueue();
      } catch (err) {
        alert('Error de red: ' + err.message);
      }
    });
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
    const fPdf     = document.getElementById('pv-add-pdf');
    const fPdfInfo = document.getElementById('pv-add-pdf-info');
    const btnSave  = document.getElementById('pv-add-save');
    const btnCancel = document.getElementById('pv-add-cancel');
    const btnClose = document.getElementById('pv-add-close');

    let _addOpts = {};
    function reset() {
      ident.value = '';
      [fTitle, fAuthors, fYear, fJournal, fDoi, fPmid, fAbstr].forEach(el => el.value = '');
      if (fPdf) fPdf.value = '';
      form.style.display = 'none';
      statusEl.textContent = '';
      statusEl.style.color = '#6b7280';
      btnSave.disabled = false;
      btnSave.style.opacity = '1';
      _addOpts = {};
    }

    // External API used by the bulk-lookup modal to open this modal
    // pre-filled with a specific identifier and auto-trigger the lookup.
    // opts.nav (optional): {index, total, onPrev, onNext} — when given,
    // shows a Anterior/Siguiente bar so the operator can move through
    // the whole not-found queue instead of getting stuck on the first
    // item whenever CrossRef/PubMed can't resolve it either.
    window._pvOpenAddByDoi = function(identifier, opts) {
      reset();
      _addOpts = opts || {};
      modal.style.display = 'flex';
      ident.value = identifier || '';
      if (_addOpts.queueLabel) {
        statusEl.textContent = _addOpts.queueLabel;
        statusEl.style.color = '#6b7280';
      }
      const navBar  = document.getElementById('pv-add-queue-nav');
      const prevBtn = document.getElementById('pv-add-queue-prev');
      const nextBtn = document.getElementById('pv-add-queue-next');
      const webLink = document.getElementById('pv-add-queue-websearch');
      const nav = _addOpts.nav;
      if (navBar) {
        navBar.style.display = nav ? 'flex' : 'none';
        if (nav) {
          prevBtn.disabled = nav.index <= 0;
          prevBtn.style.opacity = prevBtn.disabled ? '0.4' : '1';
          prevBtn.style.cursor = prevBtn.disabled ? 'default' : 'pointer';
          nextBtn.textContent = nav.index >= nav.total - 1 ? 'Terminar' : 'Siguiente ›';
          prevBtn.onclick = () => nav.onPrev();
          nextBtn.onclick = () => nav.onNext();
        }
      }
      if (webLink) {
        webLink.href = 'https://scholar.google.com/scholar?q=' +
          encodeURIComponent(identifier || (_addOpts.prefill && _addOpts.prefill.title) || '');
      }
      // BibTeX-import misses without a DOI/PMID have nothing to look up —
      // skip the auto-lookup (it would just show "pega un DOI/PMID válido")
      // and drop the parsed title/authors/year straight into the manual
      // form instead, so the operator only has to search-and-paste a DOI.
      if (!identifier && _addOpts.prefill) {
        const p = _addOpts.prefill;
        fTitle.value   = p.title   || '';
        fAuthors.value = p.authors || '';
        fYear.value    = p.year    || '';
        fJournal.value = p.journal || '';
        form.style.display = 'block';
        statusEl.textContent = 'Sin DOI/PMID en el .bib — revisa/completa a mano o pega un identificador arriba.';
        statusEl.style.color = '#b45309';
        return;
      }
      setTimeout(doLookup, 80);
    };

    // Reflect the chosen PDF (name + size) so the user can confirm
    // they picked the right file before clicking Save.
    fPdf?.addEventListener('change', () => {
      const file = fPdf.files && fPdf.files[0];
      if (!fPdfInfo) return;
      if (!file) {
        fPdfInfo.textContent = 'Si adjuntas un PDF aquí, se sube y queda ' +
          'asociado al artículo sin pasar por la detección automática de ' +
          'metadatos (útil para escaneos o copias de baja calidad).';
        fPdfInfo.style.color = '#9ca3af';
        return;
      }
      fPdfInfo.textContent =
        `📎 ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB) — ` +
        `se subirá a Dropbox al guardar.`;
      fPdfInfo.style.color = '#15803d';
    });
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
      const pdfFile = fPdf && fPdf.files && fPdf.files[0];
      try {
        if (pdfFile) {
          // Send metadata + binary together; the new endpoint skips
          // the automatic DOI extraction from the PDF text.
          statusEl.textContent = 'Subiendo PDF y guardando…';
          statusEl.style.color = '#6b7280';
          const fd = new FormData();
          fd.append('pdf', pdfFile);
          fd.append('metadata', JSON.stringify(payload));
          const res = await fetch(API + '/articles/with-pdf', {
            method: 'POST',
            credentials: 'same-origin',
            body: fd,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            const e = new Error(data.error || 'Error al guardar con PDF');
            e.status = res.status;
            e.body = data;
            throw e;
          }
        } else {
          await api('/articles/create', { method: 'POST', body: JSON.stringify(payload) });
        }
        const savedCb = _addOpts.onSaved;
        close();
        loadArticles();
        refreshStats();
        if (savedCb) savedCb();
      } catch (e) {
        if (e.status === 409) {
          const dup = (e.body && e.body.duplicate_of) || '';
          statusEl.innerHTML = '⚠️ Ya existe un artículo con ese ' +
            (e.body && e.body.matched_on === 'pdf_md5' ? 'mismo PDF' : 'DOI/PMID') +
            (dup
              ? ` — <a href="#" id="pv-add-dup-open" style="color:#0F3460;text-decoration:underline;">Ver existente</a>`
              : ' — no se ha creado.');
          statusEl.style.color = '#b45309';
          const lnk = document.getElementById('pv-add-dup-open');
          if (lnk) lnk.addEventListener('click', (ev) => {
            ev.preventDefault();
            openDetail(dup);
          });
        } else {
          statusEl.textContent = 'Error al guardar: ' + e.message;
          statusEl.style.color = '#b91c1c';
        }
        btnSave.disabled = false;
      }
    });
  }

  // ── BibTeX import wizard ─────────────────────────────────────────────
  function wireBibtexImport() {
    const btn      = document.getElementById('btn-import-bibtex');
    const modal    = document.getElementById('pv-bibtex-modal');
    if (!btn || !modal) return;

    const closeBtn   = document.getElementById('pv-bibtex-close');
    const fileInput  = document.getElementById('pv-bibtex-file');
    const analyzeBtn = document.getElementById('pv-bibtex-analyze');
    const uploadStatus = document.getElementById('pv-bibtex-upload-status');
    const statsEl    = document.getElementById('pv-bibtex-stats');
    const bulkBar    = document.getElementById('pv-bibtex-bulk-bar');
    const selectAll  = document.getElementById('pv-bibtex-select-all');
    const selCountEl = document.getElementById('pv-bibtex-selected-count');
    const tagSelect  = document.getElementById('pv-bibtex-tag-select');
    const applyTagBtn = document.getElementById('pv-bibtex-apply-tag');
    const collSelect = document.getElementById('pv-bibtex-coll-select');
    const applyCollBtn = document.getElementById('pv-bibtex-apply-coll');
    const actionStatus = document.getElementById('pv-bibtex-action-status');
    const foundSection = document.getElementById('pv-bibtex-found-section');
    const foundList  = document.getElementById('pv-bibtex-found-list');
    const missingSection = document.getElementById('pv-bibtex-missing-section');
    const missingList = document.getElementById('pv-bibtex-missing-list');

    let _entries = [];
    const _selected = new Set(); // matched article ids currently checked

    function setActionStatus(text, color) {
      actionStatus.textContent = text;
      actionStatus.style.color = color || '#6b7280';
      actionStatus.style.display = text ? 'block' : 'none';
    }
    function reset() {
      fileInput.value = '';
      uploadStatus.textContent = '';
      statsEl.style.display = 'none';
      bulkBar.style.display = 'none';
      setActionStatus('');
      foundSection.style.display = 'none';
      missingSection.style.display = 'none';
      foundList.innerHTML = '';
      missingList.innerHTML = '';
      _entries = [];
      _selected.clear();
      if (selectAll) selectAll.checked = false;
    }
    function open()  { reset(); modal.style.display = 'flex'; }
    function close() { modal.style.display = 'none'; }

    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    function statCard(label, value, color) {
      return `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;">
                <div style="font-size:10.5px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${esc(label)}</div>
                <div style="font-size:18px;font-weight:700;color:${color || '#111827'};font-variant-numeric:tabular-nums;">${esc(value)}</div>
              </div>`;
    }

    function updateSelCount() {
      selCountEl.textContent = _selected.size
        ? `${_selected.size} seleccionado${_selected.size === 1 ? '' : 's'}`
        : '';
    }

    function refreshPickers() {
      tagSelect.innerHTML = '<option value="">Añadir tag…</option>' +
        _allTags.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
      collSelect.innerHTML = '<option value="">Añadir a colección…</option>' +
        _allCollections
          .map(c => `<option value="${esc(c.id)}">${esc(c.name)}${c.kind === 'smart' ? ' ⚡' : ''}</option>`).join('') +
        '<option value="__new__">＋ Nueva colección…</option>';
    }

    function foundRowHtml(e) {
      const meta = [e.authors ? e.authors.split(';')[0] : '', e.year, e.journal].filter(Boolean).join(' · ');
      return `
        <div class="pv-bibtex-found-row" data-aid="${esc(e.match.id)}"
             style="display:flex;align-items:flex-start;gap:8px;padding:6px;border-radius:6px;cursor:pointer;">
          <input type="checkbox" class="pv-bibtex-found-chk" data-aid="${esc(e.match.id)}" style="margin-top:2px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:12.5px;font-weight:500;color:#374151;">${esc(e.match.title || e.title)}</div>
            <div style="font-size:11px;color:#9ca3af;">${esc(meta)}</div>
          </div>
        </div>`;
    }

    function missingRowHtml(e, idx) {
      const meta = [e.authors ? e.authors.split(';')[0] : '', e.year, e.journal].filter(Boolean).join(' · ');
      const idLine = [e.doi ? `DOI: ${esc(e.doi)}` : '', e.pubmed_id ? `PMID: ${esc(e.pubmed_id)}` : '']
        .filter(Boolean).join(' · ');
      return `
        <div class="pv-bibtex-missing-row" data-idx="${idx}"
             style="display:flex;align-items:flex-start;gap:8px;padding:6px;border-radius:6px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:12.5px;font-weight:500;color:#374151;">${esc(e.title || '(sin título)')}</div>
            <div style="font-size:11px;color:#9ca3af;">${esc(meta)}</div>
            ${idLine ? `<div style="font-size:11px;color:#9ca3af;">${idLine}</div>` : ''}
          </div>
          <button class="pv-bibtex-locate" data-idx="${idx}" type="button"
                  style="flex-shrink:0;padding:4px 10px;border-radius:6px;border:1px solid #d1d5db;
                         background:white;color:#374151;font-size:11.5px;font-weight:600;cursor:pointer;">
            Buscar
          </button>
        </div>`;
    }

    function render() {
      const found   = _entries.filter(e => e.match);
      const missing = _entries.filter(e => !e.match);

      statsEl.style.display = 'grid';
      statsEl.innerHTML =
        statCard('Entradas', _entries.length) +
        statCard('Ya en la biblioteca', found.length, '#15803d') +
        statCard('No encontradas', missing.length, '#b45309');

      bulkBar.style.display = found.length ? 'flex' : 'none';
      refreshPickers();

      foundSection.style.display = found.length ? 'block' : 'none';
      foundList.innerHTML = found.length
        ? found.map(foundRowHtml).join('')
        : '';

      missingSection.style.display = missing.length ? 'block' : 'none';
      missingList.innerHTML = missing.length
        ? missing.map((e) => missingRowHtml(e, _entries.indexOf(e))).join('')
        : '';

      foundList.querySelectorAll('.pv-bibtex-found-chk').forEach(chk => {
        chk.addEventListener('change', () => {
          if (chk.checked) _selected.add(chk.dataset.aid);
          else _selected.delete(chk.dataset.aid);
          updateSelCount();
        });
      });
      foundList.querySelectorAll('.pv-bibtex-found-row').forEach(row => {
        row.addEventListener('click', e => {
          if (e.target.matches('input[type=checkbox]')) return;
          modal.style.display = 'none';
          openDetail(row.dataset.aid);
        });
      });
      missingList.querySelectorAll('.pv-bibtex-locate').forEach(b => {
        b.addEventListener('click', e => {
          e.stopPropagation();
          openMissingQueue(parseInt(b.dataset.idx, 10));
        });
      });
      updateSelCount();
    }

    selectAll.addEventListener('change', () => {
      _selected.clear();
      foundList.querySelectorAll('.pv-bibtex-found-chk').forEach(chk => {
        chk.checked = selectAll.checked;
        if (selectAll.checked) _selected.add(chk.dataset.aid);
      });
      updateSelCount();
    });

    // Push the missing entries through the existing Add-by-DOI queue-nav
    // flow, prefilling title/authors/year/journal when there's no
    // DOI/PMID to auto-resolve. Marking each entry's row as imported
    // once saved, without a full re-analysis of the file.
    function openMissingQueue(startIdx) {
      const missingIdxs = _entries.map((e, i) => (!e.match ? i : -1)).filter(i => i >= 0);
      let pos = missingIdxs.indexOf(startIdx);
      if (pos < 0) pos = 0;
      function openAt(p) {
        if (p < 0 || p >= missingIdxs.length) { modal.style.display = 'flex'; return; }
        pos = p;
        const idx = missingIdxs[pos];
        const e = _entries[idx];
        const identifier = e.doi || e.pubmed_id || '';
        modal.style.display = 'none';
        window._pvOpenAddByDoi(identifier, {
          queueLabel: `Entrada ${pos + 1} de ${missingIdxs.length} no encontradas`,
          prefill: { title: e.title, authors: e.authors, year: e.year, journal: e.journal },
          onSaved: () => { e.match = { id: null, title: e.title, year: e.year }; openAt(pos + 1); },
          nav: {
            index: pos, total: missingIdxs.length,
            onPrev: () => openAt(pos - 1),
            onNext: () => openAt(pos + 1),
          },
        });
      }
      openAt(pos);
    }

    analyzeBtn.addEventListener('click', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) { uploadStatus.textContent = 'Elige primero un archivo .bib.'; uploadStatus.style.color = '#b91c1c'; return; }
      analyzeBtn.disabled = true;
      uploadStatus.textContent = 'Analizando…';
      uploadStatus.style.color = '#6b7280';
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch(API + '/bibtex/import-parse', {
          method: 'POST', credentials: 'same-origin', body: fd,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
        _entries = data.entries || [];
        _selected.clear();
        uploadStatus.textContent = `✓ ${data.total} entradas · ${data.found} ya en biblioteca · ${data.missing} no encontradas`;
        uploadStatus.style.color = '#15803d';
        render();
      } catch (e) {
        uploadStatus.textContent = 'Error: ' + e.message;
        uploadStatus.style.color = '#b91c1c';
      } finally {
        analyzeBtn.disabled = false;
      }
    });

    applyTagBtn.addEventListener('click', async () => {
      const tagId = tagSelect.value;
      const tagName = tagSelect.selectedOptions[0]?.textContent || '';
      if (!tagId) { alert('Elige una tag primero.'); return; }
      if (!_selected.size) { alert('Selecciona al menos un artículo encontrado.'); return; }
      const n = _selected.size;
      applyTagBtn.disabled = true;
      const original = applyTagBtn.textContent;
      applyTagBtn.textContent = 'Añadiendo…';
      setActionStatus(`⏳ Añadiendo la tag "${tagName}" a ${n} artículo(s)…`);
      try {
        await api('/articles/bulk-tags', {
          method: 'POST',
          body: JSON.stringify({ ids: [..._selected], add_tag_ids: [parseInt(tagId, 10)] }),
        });
        setActionStatus(`✓ Tag "${tagName}" añadida a ${n} artículo(s).`, '#15803d');
        tagSelect.value = '';
      } catch (e) {
        setActionStatus(`✗ Error al añadir la tag: ${e.message}`, '#b91c1c');
      } finally {
        applyTagBtn.disabled = false;
        applyTagBtn.textContent = original;
      }
    });

    applyCollBtn.addEventListener('click', async () => {
      let collId = collSelect.value;
      if (!collId) { alert('Elige una colección primero.'); return; }
      if (!_selected.size) { alert('Selecciona al menos un artículo encontrado.'); return; }
      const n = _selected.size;
      if (collId === '__new__') {
        // Route through the full collection editor (name, color, group,
        // subgroup, smart rules) instead of a bare prompt() — a
        // quick-create with no group was landing collections outside
        // every folder, flat and out of place next to the sidebar's
        // properly grouped ones. onSaved adds the current selection to
        // whatever gets created.
        const ids = [..._selected];
        modal.style.display = 'none';
        openCollectionEditor(null, {
          onSaved: async (created) => {
            modal.style.display = 'flex';
            setActionStatus(`⏳ Añadiendo ${ids.length} artículo(s) a la nueva colección "${created.name}"…`);
            try {
              await api(`/collections/${created.id}/articles`, {
                method: 'POST',
                body: JSON.stringify({ ids }),
              });
              setActionStatus(`✓ ${ids.length} artículo(s) añadidos a la nueva colección "${created.name}".`, '#15803d');
              refreshPickers();
            } catch (e) {
              setActionStatus(`✗ Error al añadir a la colección: ${e.message}`, '#b91c1c');
            }
          },
        });
        return;
      }
      const collName = collSelect.selectedOptions[0]?.textContent || '';
      applyCollBtn.disabled = true;
      const original = applyCollBtn.textContent;
      applyCollBtn.textContent = 'Añadiendo…';
      setActionStatus(`⏳ Añadiendo ${n} artículo(s) a "${collName}"…`);
      try {
        await api(`/collections/${collId}/articles`, {
          method: 'POST',
          body: JSON.stringify({ ids: [..._selected] }),
        });
        setActionStatus(`✓ ${n} artículo(s) añadidos a "${collName}".`, '#15803d');
        refreshPickers();
        collSelect.value = '';
      } catch (e) {
        setActionStatus(`✗ Error al añadir a la colección: ${e.message}`, '#b91c1c');
      } finally {
        applyCollBtn.disabled = false;
        applyCollBtn.textContent = original;
      }
    });
  }

  // ── Scan Dropbox folder ─────────────────────────────────────────────
  // Triggers /api/ingest/scan-folder, which lists PDFs in the watch
  // folder, queues each one through the regular ingest pipeline, and
  // deletes successful ones from Dropbox. Failures stay in the folder
  // for manual review.
  //
  // Chunked client-side so each click drains up to _SCAN_TARGET_PER_CLICK
  // PDFs (default 250). The server caps each request at 50 (downloads
  // are ~1-3 s each and gunicorn would kill anything past ~100 s) and
  // skips files that already have an in-flight job, so back-to-back
  // chunks don't re-process the same PDFs while the worker catches up.
  const _SCAN_CHUNK_SIZE       = 50;
  const _SCAN_TARGET_PER_CLICK = 250;

  function wireScanFolder() {
    const btn = document.getElementById('btn-scan-folder');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const folder = prompt(
        'Carpeta de Dropbox a escanear (los PDFs que se importen bien o ya estén ' +
        'en la biblioteca se borrarán de ahí; los que fallen permanecen):',
        '/PrionLab tools/PDFs'
      );
      if (folder === null) return;
      const trimmed = folder.trim();
      if (!trimmed) return;
      btn.disabled = true;
      const originalHtml = btn.innerHTML;
      const chunks = Math.ceil(_SCAN_TARGET_PER_CLICK / _SCAN_CHUNK_SIZE);
      let totalQueued       = 0;
      let totalSkipped      = 0;
      let lastFolder        = trimmed;
      let lastPdfsFound     = 0;
      let lastRemaining     = 0;
      let lastAlreadyQueued = 0;
      const allSkippedDetail = [];
      let lastError         = null;
      try {
        for (let i = 1; i <= chunks; i++) {
          btn.innerHTML =
            `<span><i class="fas fa-spinner fa-spin" style="width:13px;margin-right:6px;opacity:0.7;"></i>` +
            `Escaneando… (lote ${i}/${chunks})</span>`;
          const res = await fetch(API + '/ingest/scan-folder', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder: trimmed, limit: _SCAN_CHUNK_SIZE }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            lastError = data.error || res.status;
            if (data.detail) lastError += `\n${data.detail}`;
            break;
          }
          totalQueued       += data.queued || 0;
          totalSkipped      += data.skipped || 0;
          lastFolder         = data.folder || lastFolder;
          lastPdfsFound      = data.pdfs_found || 0;
          lastRemaining      = data.remaining || 0;
          lastAlreadyQueued  = data.already_queued || 0;
          if (Array.isArray(data.skipped_detail))
            allSkippedDetail.push(...data.skipped_detail);
          // Stop early when nothing new came back — either the folder
          // emptied or every fresh PDF is already in the queue.
          if ((data.queued || 0) === 0) break;
        }

        if (lastError) {
          alert(`No se pudo escanear la carpeta:\n${lastError}`);
        } else {
          const skippedMsg = totalSkipped
            ? `\n${totalSkipped} omitidos (revisa la consola para el detalle).`
            : '';
          const alreadyMsg = lastAlreadyQueued
            ? `\n${lastAlreadyQueued} ya estaban en la cola (no se re-encolan).`
            : '';
          const moreMsg = lastRemaining > 0
            ? `\n\nQuedan ${lastRemaining} PDFs sin procesar en la carpeta. ` +
              `Vuelve a pulsar "Scan Dropbox folder" cuando el worker libere espacio ` +
              `(unos minutos).`
            : '';
          alert(
            `Carpeta ${lastFolder}: ${lastPdfsFound} PDFs encontrados, ` +
            `${totalQueued} encolados en esta tanda.${alreadyMsg}${skippedMsg}\n\n` +
            `Sigue el progreso en el panel de "Ingest queue". Los que terminen ` +
            `bien o sean duplicados se borrarán solos de la carpeta.${moreMsg}`
          );
          if (allSkippedDetail.length)
            console.warn('scan-folder skipped:', allSkippedDetail);
          refreshQueue?.();
        }
      } catch (err) {
        alert('Error de red al escanear: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    });
  }

  // ── Clean metadata backfill ──────────────────────────────────────────
  // One-off pass over every article in the library that decodes HTML
  // entities and converts <sup>...</sup> / <sub>...</sub> to Unicode.
  // Triggered manually from the sidebar; the same logic also runs at
  // ingest time via metadata_resolver.Metadata.__post_init__, so the
  // button is mostly useful for rows that already existed when the
  // cleanup pass shipped.
  function wireCleanMetadata() {
    const btn = document.getElementById('btn-clean-metadata');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!confirm('Va a recorrer todos los artículos limpiando entidades HTML y ' +
                   'transformando sup/sub a Unicode. La acción es idempotente y ' +
                   'reversible (solo actualiza filas con cambios). ¿Continuar?')) {
        return;
      }
      btn.disabled = true;
      const orig = btn.innerHTML;
      btn.innerHTML = '<span><i class="fas fa-spinner fa-spin" style="width:13px;margin-right:6px;opacity:0.7;"></i>Limpiando…</span>';
      try {
        const r = await api('/admin/clean-metadata', { method: 'POST' });
        const pf = r.per_field || {};
        alert(
          `Backfill completado.\n\n` +
          `Filas examinadas: ${r.scanned}\n` +
          `Filas modificadas: ${r.changed_rows}\n` +
          `  · title:    ${pf.title    ?? 0}\n` +
          `  · authors:  ${pf.authors  ?? 0}\n` +
          `  · journal:  ${pf.journal  ?? 0}\n` +
          `  · abstract: ${pf.abstract ?? 0}`
        );
        loadArticles();
      } catch (e) {
        alert('Error: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    });
  }

  // ── Recuperar páginas PDF (backfill) ─────────────────────────────────
  // Drives /api/admin/backfill-pdf-pages in 50-article chunks. The
  // upload-pdf endpoint already counts pages on the spot for new
  // attachments, but rows imported through older paths (or via the
  // pre-fix dropzone) may have pdf_pages=NULL — this button drains
  // that backlog without having to re-process every PDF.
  function wirePagesBackfill() {
    const btn = document.getElementById('btn-backfill-pages');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const orig = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span><i class="fas fa-spinner fa-spin" style="width:13px;margin-right:6px;opacity:0.7;"></i>Contando…</span>';
      try {
        const r = await api('/admin/backfill-pdf-pages', {
          method: 'POST',
          body: JSON.stringify({ limit: 50 }),
        });
        const more = r.processed >= 50
          ? '\n\nPueden quedar más. Pulsa de nuevo para procesar otros 50.'
          : '\n\n✓ No quedan PDFs pendientes de contar páginas.';
        alert(
          `Procesados: ${r.processed}\n` +
          `Actualizados: ${r.updated}\n` +
          `Fallos: ${r.failed}` + more
        );
      } catch (e) {
        alert('Error: ' + (e.message || e));
      } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    });
  }

  // ── Retry-abstracts backfill ─────────────────────────────────────────
  // Drives /api/admin/retry-abstracts in 250-article chunks so the user
  // can rescue PLoS/BMC-style papers that the old esummary-only parser
  // couldn't fetch the abstract for. Each click reports recovered /
  // still missing / remaining so it's obvious whether another round
  // is worth it.
  function wireRetryAbstracts() {
    const btn = document.getElementById('btn-retry-abstracts');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const orig = btn.innerHTML;
      btn.innerHTML = '<span><i class="fas fa-spinner fa-spin" style="width:13px;margin-right:6px;opacity:0.7;"></i>Reintentando…</span>';
      try {
        const r = await api('/admin/retry-abstracts', {
          method: 'POST',
          body: JSON.stringify({ limit: 250 }),
        });
        const more = r.remaining > 0
          ? `\n\nQuedan ${r.remaining} sin abstract. Vuelve a pulsar para procesar otros 250.`
          : '\n\n✓ Sin artículos pendientes de reintentar ahora mismo.';
        const confirmedLine = r.confirmed_unavailable_total
          ? `\n\n(${r.confirmed_unavailable_total} artículo(s) están confirmados sin abstract disponible en PubMed/CrossRef — no se reintentan en cada clic, solo cada 24h por si la fuente se actualiza.)`
          : '';
        const conflictsLine = r.pmid_conflicts
          ? `\n⚠ PMID encontrado pero ya pertenecía a otro artículo (no se asignó, abstract sí): ${r.pmid_conflicts}`
          : '';
        alert(
          `Reintento completado.\n\n` +
          `Procesados: ${r.processed}\n` +
          `Abstract recuperado: ${r.recovered}\n` +
          `Aún sin abstract (marcados como confirmados): ${r.still_missing}\n` +
          `PMIDs descubiertos por el camino: ${r.learned_pmids}` +
          conflictsLine +
          more +
          confirmedLine
        );
        loadArticles();
      } catch (e) {
        alert('Error: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    });
  }

  // ── PMID backfill modal ──────────────────────────────────────────────
  //
  // We chunk the work in 50-article HTTP requests (~10-25 s each at
  // PubMed's typical 200-500 ms response time) so each one stays
  // comfortably inside the gunicorn 30 s window. A single user click
  // loops up to _PMID_TARGET_PER_CLICK / _PMID_CHUNK_SIZE chunks, so
  // 250 / 50 = 5 sequential requests, ~1-2 min total wall time. The
  // loop breaks early if a chunk comes back with fewer rows than
  // requested (the pending queue ran dry).
  const _PMID_CHUNK_SIZE       = 50;
  const _PMID_TARGET_PER_CLICK = 250;

  function wirePmidBackfill() {
    const btn        = document.getElementById('btn-backfill-pmids');
    const modal      = document.getElementById('pv-pmid-modal');
    const closeBtn   = document.getElementById('pv-pmid-close');
    const runBtn     = document.getElementById('pv-pmid-run');
    const refBtn     = document.getElementById('pv-pmid-refresh');
    const manualBtn  = document.getElementById('pv-pmid-manual');
    const statsEl    = document.getElementById('pv-pmid-stats');
    const logEl      = document.getElementById('pv-pmid-log');
    const manualPanel= document.getElementById('pv-pmid-manual-panel');
    const manualList = document.getElementById('pv-pmid-manual-list');
    const manualCount= document.getElementById('pv-pmid-manual-count');
    if (!btn || !modal) return;

    const close = () => { modal.style.display = 'none'; };
    btn.addEventListener('click', async () => {
      modal.style.display = 'flex';
      logEl.innerHTML =
        `<div style="color:#9ca3af;text-align:center;padding:24px 12px;">El log de búsquedas aparecerá aquí.</div>`;
      if (manualPanel) manualPanel.style.display = 'none';
      await refreshStats();
    });
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);
    refBtn.addEventListener('click', refreshStats);
    runBtn.addEventListener('click', runBatch);
    manualBtn?.addEventListener('click', loadManual);

    async function refreshStats() {
      statsEl.innerHTML = '<span style="color:#6b7280;">Cargando…</span>';
      try {
        const s = await api('/admin/pmid-stats');
        const pct = (n) => s.total ? ` (${(100 * n / s.total).toFixed(1)}%)` : '';
        statsEl.innerHTML = `
          <span style="color:#6b7280;">Total artículos</span>
          <span style="text-align:right;font-weight:700;">${s.total}</span>

          <span style="color:#6b7280;">Con DOI</span>
          <span style="text-align:right;">${s.has_doi}<span style="color:#9ca3af;font-weight:normal;">${pct(s.has_doi)}</span></span>

          <span style="color:#6b7280;">Con PMID</span>
          <span style="text-align:right;">${s.has_pmid}<span style="color:#9ca3af;font-weight:normal;">${pct(s.has_pmid)}</span></span>

          <span style="color:#6b7280;">Con DOI y PMID</span>
          <span style="text-align:right;">${s.has_both}</span>

          <span style="color:#b45309;font-weight:600;">DOI sin PMID</span>
          <span style="text-align:right;color:#b45309;font-weight:700;">${s.has_doi_only}</span>

          <span style="color:#b45309;font-weight:600;">Sin DOI ni PMID</span>
          <span style="text-align:right;color:#b45309;font-weight:700;">${s.has_neither}</span>

          ${s.confirmed_no_pmid ? `
            <span style="color:#6b7280;">Sin PMID confirmado (no existe)</span>
            <span style="text-align:right;color:#6b7280;">${s.confirmed_no_pmid}</span>
          ` : ''}

          <span style="grid-column:1/-1;border-top:1px solid #e5e7eb;margin-top:4px;padding-top:6px;color:#374151;font-weight:600;">
            Pendientes de recuperar: <span style="color:#b91c1c;">${s.missing_pmid}</span>
          </span>
        `;
        if (s.missing_pmid === 0) {
          runBtn.disabled = true;
          runBtn.style.opacity = '0.5';
          runBtn.style.cursor = 'not-allowed';
          runBtn.textContent = '✓ Todos los artículos tienen PMID';
        } else {
          runBtn.disabled = false;
          runBtn.style.opacity = '1';
          runBtn.style.cursor = 'pointer';
          const target = Math.min(_PMID_TARGET_PER_CLICK, s.missing_pmid);
          runBtn.textContent = `🔄 Recuperar PMIDs faltantes (${target} en esta tanda)`;
        }
      } catch (e) {
        statsEl.innerHTML = `<span style="color:#b91c1c;">Error: ${esc(e.message)}</span>`;
      }
    }

    function _appendLog(html, kind) {
      // Replace the placeholder on first append.
      const placeholder = logEl.querySelector('div[style*="text-align:center"]');
      if (placeholder) placeholder.remove();
      const row = document.createElement('div');
      const color = kind === 'ok'     ? '#15803d'
                  : kind === 'error'  ? '#b91c1c'
                  : kind === 'warn'   ? '#b45309'
                  : '#6b7280';
      // data-kind drives the "Solo errores" filter; data-text caches a
      // plain-text version of the row body for the CSV exporter so it
      // doesn't have to parse HTML at download time.
      row.dataset.kind = kind || 'info';
      row.className    = 'pv-pmid-log-row';
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      row.dataset.text = (tmp.textContent || '').trim();
      row.style.cssText = 'display:flex;gap:8px;padding:3px 4px;border-bottom:1px solid #f3f4f6;line-height:1.4;';
      row.innerHTML = `<span style="color:${color};flex-shrink:0;">●</span><span style="flex:1;min-width:0;">${html}</span>`;
      logEl.appendChild(row);
      _syncPmidLogVisibility();
      _syncPmidLogCount();
      logEl.scrollTop = logEl.scrollHeight;
    }

    function _syncPmidLogVisibility() {
      const onlyErrors = !!document.getElementById('pv-pmid-log-errors-only')?.checked;
      logEl.querySelectorAll('.pv-pmid-log-row').forEach(r => {
        if (!onlyErrors) {
          r.style.display = '';
          return;
        }
        // "Errors" = anything that isn't a successful PMID write.
        // We treat 'ok' (PMID found + saved) as success, and 'error'
        // / 'warn' (not found, duplicate, etc.) + 'info' marker
        // lines as the actionable subset to show.
        r.style.display = (r.dataset.kind === 'ok') ? 'none' : '';
      });
    }

    function _syncPmidLogCount() {
      const counter = document.getElementById('pv-pmid-log-count');
      if (!counter) return;
      const total = logEl.querySelectorAll('.pv-pmid-log-row').length;
      const errs  = logEl.querySelectorAll('.pv-pmid-log-row[data-kind="error"], .pv-pmid-log-row[data-kind="warn"]').length;
      counter.textContent = total
        ? `· ${total} entradas${errs ? ` (${errs} sin PMID / duplicados)` : ''}`
        : '';
    }

    document.getElementById('pv-pmid-log-errors-only')?.addEventListener('change', _syncPmidLogVisibility);

    document.getElementById('pv-pmid-log-clear')?.addEventListener('click', () => {
      if (!logEl.querySelector('.pv-pmid-log-row')) return;
      if (!confirm('Vaciar el log de esta sesión?\n\nNo afecta a la base de datos ni a los contadores — solo limpia lo que ves en este panel.')) return;
      logEl.innerHTML =
        '<div style="color:#9ca3af;text-align:center;padding:24px 12px;">El log de búsquedas aparecerá aquí.</div>';
      _syncPmidLogCount();
    });

    document.getElementById('pv-pmid-log-csv')?.addEventListener('click', () => {
      const rows = Array.from(logEl.querySelectorAll('.pv-pmid-log-row'));
      if (!rows.length) { alert('Log vacío.'); return; }
      const onlyErrors = !!document.getElementById('pv-pmid-log-errors-only')?.checked;
      const visible = onlyErrors
        ? rows.filter(r => r.dataset.kind !== 'ok')
        : rows;
      const csvEsc = (v) => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const out = [['kind', 'text']];
      visible.forEach(r => out.push([r.dataset.kind || 'info', r.dataset.text || '']));
      const csv = out.map(r => r.map(csvEsc).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = url;
      a.download = `prionvault-pmid-log-${stamp}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    async function runBatch() {
      runBtn.disabled = true;
      const orig = runBtn.textContent;
      const CHUNK = _PMID_CHUNK_SIZE;          // 50 per HTTP request
      const TARGET = _PMID_TARGET_PER_CLICK;   // 250 per click
      let totalProcessed = 0;
      let totalFound     = 0;
      try {
        const chunks = Math.ceil(TARGET / CHUNK);
        for (let i = 1; i <= chunks; i++) {
          runBtn.textContent = `⏳ Buscando en PubMed… (lote ${i}/${chunks})`;
          _appendLog(`<b>${new Date().toLocaleTimeString()}</b> Lote ${i}/${chunks} — hasta ${CHUNK} artículos…`);
          const r = await api('/admin/pmid-backfill', {
            method: 'POST',
            body: JSON.stringify({ limit: CHUNK }),
          });
          (r.items || []).forEach(it => {
            const title = (it.title || '').slice(0, 80);
            const titleEsc = esc(title) + (it.title && it.title.length > 80 ? '…' : '');
            if (it.found_pmid && !it.reason) {
              _appendLog(
                `✓ <a href="https://pubmed.ncbi.nlm.nih.gov/${esc(String(it.found_pmid))}/" ` +
                  `target="_blank" rel="noopener" style="color:#0F3460;font-weight:600;">PMID ${esc(String(it.found_pmid))}</a> ` +
                `<span style="color:#9ca3af;">(${esc(it.via || '?')})</span> — ${titleEsc}`,
                'ok'
              );
            } else if (it.reason === 'duplicate') {
              _appendLog(
                `⚠ Duplicado: PMID ${esc(String(it.found_pmid))} ya pertenece a otro artículo — ${titleEsc}`,
                'warn'
              );
            } else if (it.reason === 'not_found') {
              _appendLog(`✗ Sin coincidencia en PubMed — ${titleEsc}`, 'error');
            } else {
              _appendLog(`✗ ${esc(it.reason || 'error')} — ${titleEsc}`, 'error');
            }
          });
          totalProcessed += r.processed || 0;
          totalFound     += r.found || 0;
          // If the server gave us fewer rows than we asked for, the
          // queue is empty — stop early instead of issuing more HTTPs
          // we know will return [].
          if ((r.processed || 0) < CHUNK) break;
        }
        _appendLog(
          `<b>Tanda terminada</b> — procesados ${totalProcessed}, recuperados ${totalFound}.`,
          totalFound > 0 ? 'ok' : 'warn'
        );
        await refreshStats();
        // Refresh the listing so newly-found PMIDs appear as the
        // "PMID ↗" chip without a manual reload.
        if (typeof loadArticles === 'function') loadArticles();
      } catch (e) {
        _appendLog(`Error: ${esc(e.message)}`, 'error');
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = orig;
      }
    }

    // Manual PMID-entry panel: lists every article still without a
    // PMID, with a one-click "Buscar en PubMed" link pre-filled with
    // the title and a tiny input for pasting the PMID found by hand.
    // The PATCH /api/articles/<id> endpoint already handles the
    // uniqueness check (409 on PMID already owned) and the new 422
    // for the VARCHAR(255) bug — we surface either cleanly.
    async function loadManual() {
      if (!manualPanel) return;
      manualPanel.style.display = 'block';
      manualList.innerHTML =
        '<div style="text-align:center;color:#9ca3af;padding:24px 12px;font-size:13px;">Cargando pendientes…</div>';
      try {
        const r = await api('/admin/pmid-missing?limit=500');
        manualCount.textContent = `· ${r.total} en total`;
        if (!r.items || !r.items.length) {
          manualList.innerHTML =
            '<div style="text-align:center;color:#15803d;padding:24px 12px;font-size:13px;">✓ Ningún artículo pendiente. Todos tienen PMID.</div>';
          return;
        }
        // Master "Marcar todos" + per-row checkboxes write into the
        // shared state.selectedIds so the operator can close the modal
        // and find their picks in the main listing via the bulk-bar's
        // "🔍 Ver sólo seleccionados" button.
        const masterHtml = `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;
                      background:#f3f4f6;border-bottom:1px solid #e5e7eb;
                      font-size:11.5px;color:#374151;font-weight:600;
                      position:sticky;top:0;z-index:1;">
            <input type="checkbox" id="pv-pmid-manual-master"
                   title="Marcar / desmarcar todos los visibles"
                   style="margin:0;cursor:pointer;width:14px;height:14px;">
            <label for="pv-pmid-manual-master" style="cursor:pointer;flex:1;">
              Marcar todos los <span id="pv-pmid-manual-master-count">${r.items.length}</span> visibles
              <span style="font-weight:normal;color:#6b7280;">
                — la selección queda disponible al cerrar el modal en el listado principal
              </span>
            </label>
          </div>`;
        manualList.innerHTML = masterHtml + r.items.map(it => _manualPmidRowHtml(it)).join('');

        // Wire per-row save + Enter
        manualList.querySelectorAll('.pv-pmid-manual-save').forEach(b => {
          b.addEventListener('click', () => saveManualPmid(b.dataset.aid));
        });
        manualList.querySelectorAll('.pv-pmid-manual-input').forEach(inp => {
          inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              saveManualPmid(inp.dataset.aid);
            }
          });
        });
        manualList.querySelectorAll('.pv-pmid-manual-nopmid').forEach(b => {
          b.addEventListener('click', () => markNoPmid(b.dataset.aid));
        });

        // Per-row "🗑 Borrar" — same flow as the listing's delete: hits
        // DELETE /api/articles/<id>, which clears the row + the Dropbox
        // PDF + any collection memberships. Confirm dialog because it's
        // irreversible from the UI.
        manualList.querySelectorAll('.pv-pmid-manual-delete').forEach(b => {
          b.addEventListener('click', () => deleteManualRow(b.dataset.aid));
        });

        // Per-row pick checkbox — keeps state.selectedIds in sync.
        const syncMaster = () => {
          const checks  = Array.from(manualList.querySelectorAll('.pv-pmid-manual-pick'));
          const master  = document.getElementById('pv-pmid-manual-master');
          if (!master) return;
          const total   = checks.length;
          const checked = checks.filter(c => c.checked).length;
          master.checked = total > 0 && checked === total;
          master.indeterminate = checked > 0 && checked < total;
        };
        manualList.querySelectorAll('.pv-pmid-manual-pick').forEach(cb => {
          cb.addEventListener('change', () => {
            if (cb.checked) state.selectedIds.add(cb.dataset.aid);
            else            state.selectedIds.delete(cb.dataset.aid);
            updateBulkBar();
            syncSelectAllHeader?.();
            syncMaster();
          });
        });

        // Master "marcar todos los visibles"
        const master = document.getElementById('pv-pmid-manual-master');
        if (master) {
          master.addEventListener('change', () => {
            manualList.querySelectorAll('.pv-pmid-manual-pick').forEach(cb => {
              cb.checked = master.checked;
              if (cb.checked) state.selectedIds.add(cb.dataset.aid);
              else            state.selectedIds.delete(cb.dataset.aid);
            });
            updateBulkBar();
            syncSelectAllHeader?.();
          });
          syncMaster();
        }
      } catch (e) {
        manualList.innerHTML =
          `<div style="color:#b91c1c;padding:14px;font-size:13px;">Error: ${esc(e.message)}</div>`;
      }
    }

    async function deleteManualRow(aid) {
      const row = manualList.querySelector(`[data-row-aid="${CSS.escape(aid)}"]`);
      if (!row) return;
      const status = row.querySelector('.pv-pmid-manual-status');
      const btn    = row.querySelector('.pv-pmid-manual-delete');
      if (!confirm(
        'Borrar este artículo de PrionVault?\n\n' +
        '• La fila se borra de la base de datos.\n' +
        '• El PDF de Dropbox también (queda en el historial ~30 días).\n' +
        '• Desaparece de PrionRead, PrionPacks, asignaciones y ratings.\n\n' +
        'No se puede deshacer. ¿Continuar?'
      )) return;
      const orig = btn.textContent;
      btn.disabled    = true;
      btn.textContent = '⏳';
      status.textContent = '';
      try {
        await api(`/articles/${aid}`, { method: 'DELETE' });
        // Drop from selection if it was picked, then fade the row.
        state.selectedIds.delete(aid);
        updateBulkBar();
        row.style.transition = 'opacity 0.4s';
        row.style.opacity = '0.25';
        setTimeout(() => {
          row.remove();
          if (!manualList.querySelector('[data-row-aid]')) {
            manualList.innerHTML =
              '<div style="text-align:center;color:#15803d;padding:24px 12px;font-size:13px;">✓ Ya está. Todos los pendientes resueltos.</div>';
          }
          refreshStats();
          if (typeof loadArticles === 'function') loadArticles();
        }, 400);
      } catch (e) {
        status.style.color = '#b91c1c';
        status.textContent = `✗ ${e.message || 'error'}`;
        btn.disabled    = false;
        btn.textContent = orig;
      }
    }

    async function saveManualPmid(aid) {
      const row = manualList.querySelector(`[data-row-aid="${CSS.escape(aid)}"]`);
      if (!row) return;
      const input = row.querySelector('.pv-pmid-manual-input');
      const saveBtn = row.querySelector('.pv-pmid-manual-save');
      const status  = row.querySelector('.pv-pmid-manual-status');
      const raw = (input.value || '').trim();
      // Accept "12345678", "PMID 12345678", "PMID:12345678", or even
      // a copy-pasted PubMed URL — strip down to the trailing digits.
      const m = raw.match(/(\d{4,})/);
      if (!m) {
        status.textContent = 'PMID inválido (esperaba dígitos).';
        status.style.color = '#b91c1c';
        return;
      }
      const pmid = m[1];
      saveBtn.disabled    = true;
      const origLabel     = saveBtn.textContent;
      saveBtn.textContent = '⏳';
      status.textContent  = '';
      try {
        await api(`/articles/${aid}`, {
          method: 'PATCH',
          body:   JSON.stringify({ pubmed_id: pmid }),
        });
        // Fade out the row on success and update the running tally.
        row.style.transition = 'opacity 0.4s, max-height 0.4s';
        row.style.opacity = '0.3';
        status.style.color = '#15803d';
        status.textContent = `✓ PMID ${pmid} guardado.`;
        // Refresh the global stats panel and the main listing's
        // "PMID ↗" chips after a moment so the change is visible.
        setTimeout(() => {
          row.remove();
          refreshStats();
          if (typeof loadArticles === 'function') loadArticles();
          // If the list is now empty, replace with success message.
          if (!manualList.querySelector('[data-row-aid]')) {
            manualList.innerHTML =
              '<div style="text-align:center;color:#15803d;padding:24px 12px;font-size:13px;">✓ Ya está. Todos los pendientes resueltos.</div>';
          }
        }, 600);
      } catch (e) {
        const body = e.body || {};
        let msg = e.message || 'error';
        if (e.status === 409 && body.duplicate_of) {
          msg = `Ese PMID ya pertenece a otro artículo. Ver: ${body.duplicate_of}`;
        }
        status.style.color = '#b91c1c';
        status.textContent = `✗ ${msg}`;
        saveBtn.disabled    = false;
        saveBtn.textContent = origLabel;
      }
    }

    // "✗ No existe PMID" — flag the paper as confirmed-not-in-PubMed
    // so the auto-backfill stops trying it and the manual list stops
    // showing it. Reversible via the same endpoint with {value:false}
    // if the admin changes their mind.
    async function markNoPmid(aid) {
      const row    = manualList.querySelector(`[data-row-aid="${CSS.escape(aid)}"]`);
      if (!row) return;
      const btn    = row.querySelector('.pv-pmid-manual-nopmid');
      const status = row.querySelector('.pv-pmid-manual-status');
      if (!confirm('Marcar este artículo como confirmado-sin-PMID?\n\n' +
                   '• La búsqueda automática lo saltará en futuros lotes.\n' +
                   '• Desaparece de esta lista de pendientes.\n' +
                   '• Se puede deshacer luego desde Editar → vaciar campo y guardar.\n\n' +
                   '¿Continuar?')) return;
      const orig = btn.textContent;
      btn.disabled    = true;
      btn.textContent = '⏳';
      status.textContent = '';
      try {
        await api(`/articles/${aid}/mark-no-pmid`, {
          method: 'POST',
          body:   JSON.stringify({ value: true }),
        });
        status.style.color = '#6b7280';
        status.textContent = 'Marcado sin PMID.';
        row.style.transition = 'opacity 0.4s';
        row.style.opacity = '0.3';
        setTimeout(() => {
          row.remove();
          refreshStats();
          if (!manualList.querySelector('[data-row-aid]')) {
            manualList.innerHTML =
              '<div style="text-align:center;color:#15803d;padding:24px 12px;font-size:13px;">✓ Ya está. Todos los pendientes resueltos.</div>';
          }
        }, 500);
      } catch (e) {
        status.style.color = '#b91c1c';
        status.textContent = `✗ ${e.message || 'error'}`;
        btn.disabled    = false;
        btn.textContent = orig;
      }
    }
  }

  function _manualPmidRowHtml(it) {
    const escAttr = (v) => esc(String(v || ''));
    const title   = it.title || '(sin título)';
    const yearTxt = it.year ? ` · ${it.year}` : '';
    const journal = it.journal ? ` · ${esc(it.journal)}` : '';
    const doiLink = it.doi
      ? `<a href="https://doi.org/${escAttr(it.doi)}" target="_blank" rel="noopener" style="color:#3730a3;text-decoration:none;font-weight:600;">DOI</a>`
      : '';
    // PubMed best-match search pre-filled with the title — clicking
    // takes the admin straight to the candidate list; usually the
    // first hit is the paper they're looking at.
    const pubmedUrl =
      'https://pubmed.ncbi.nlm.nih.gov/?term=' + encodeURIComponent(title);
    // Authors string can be quite long (collaborator lists) — trim.
    const authors = (it.authors || '').slice(0, 80) +
                    ((it.authors || '').length > 80 ? '…' : '');
    // Persist selection across renders / refreshes by reading the
    // shared state.selectedIds Set every time we paint a row.
    const checked = state.selectedIds.has(it.id) ? 'checked' : '';
    return `
      <div data-row-aid="${escAttr(it.id)}"
           style="border-bottom:1px solid #e5e7eb;padding:8px 10px;background:white;">
        <div style="display:flex;gap:10px;align-items:flex-start;">
          <input type="checkbox" class="pv-pmid-manual-pick" data-aid="${escAttr(it.id)}" ${checked}
                 title="Seleccionar para encontrarlo después en el listado principal"
                 style="margin-top:4px;flex-shrink:0;cursor:pointer;width:14px;height:14px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:12.5px;font-weight:600;color:#111827;line-height:1.35;
                        overflow:hidden;text-overflow:ellipsis;display:-webkit-box;
                        -webkit-line-clamp:2;-webkit-box-orient:vertical;"
                 title="${escAttr(title)}">${esc(title)}</div>
            <div style="font-size:11.5px;color:#6b7280;margin-top:2px;">
              ${esc(authors)}${yearTxt}${journal}
            </div>
            <div style="margin-top:5px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              <a href="${escAttr(pubmedUrl)}" target="_blank" rel="noopener"
                 style="font-size:11.5px;padding:2px 8px;border-radius:4px;background:#dbeafe;color:#1d4ed8;
                        font-weight:600;text-decoration:none;">🔍 Buscar en PubMed ↗</a>
              ${doiLink ? `<span style="font-size:11.5px;">${doiLink}</span>` : ''}
            </div>
          </div>
          <div style="flex-shrink:0;display:flex;flex-direction:column;gap:4px;align-items:flex-end;min-width:200px;">
            <div style="display:flex;gap:5px;">
              <input type="text" class="pv-pmid-manual-input" data-aid="${escAttr(it.id)}"
                     placeholder="Pega el PMID"
                     inputmode="numeric"
                     style="width:130px;padding:5px 8px;border:1px solid #d1d5db;border-radius:5px;font-size:12.5px;font-family:ui-monospace,monospace;">
              <button type="button" class="pv-pmid-manual-save" data-aid="${escAttr(it.id)}"
                      style="padding:5px 12px;border-radius:5px;border:none;background:#0F3460;color:white;font-size:12px;font-weight:600;cursor:pointer;">
                Guardar
              </button>
            </div>
            <div style="display:flex;gap:5px;align-self:flex-end;">
              <button type="button" class="pv-pmid-manual-nopmid" data-aid="${escAttr(it.id)}"
                      title="Marca este artículo como confirmado-sin-PMID. La búsqueda automática y la lista manual lo dejarán en paz."
                      style="padding:3px 10px;border-radius:4px;border:1px solid #fecaca;background:white;color:#b91c1c;font-size:11px;font-weight:600;cursor:pointer;">
                ✗ No existe PMID
              </button>
              <button type="button" class="pv-pmid-manual-delete" data-aid="${escAttr(it.id)}"
                      title="Borrar el artículo de PrionVault (también borra el PDF de Dropbox)."
                      style="padding:3px 10px;border-radius:4px;border:1px solid #fca5a5;background:white;color:#b91c1c;font-size:11px;font-weight:600;cursor:pointer;">
                🗑 Borrar
              </button>
            </div>
            <div class="pv-pmid-manual-status" style="font-size:11px;color:#6b7280;text-align:right;min-height:14px;"></div>
          </div>
        </div>
      </div>
    `;
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
        const dis = r.dismissed_count || 0;
        meta.textContent =
          `${r.total} par${r.total === 1 ? '' : 'es'} sospechoso${r.total === 1 ? '' : 's'} ` +
          `encontrado${r.total === 1 ? '' : 's'} (ordenados por score)` +
          (dis ? ` · ${dis} pareja${dis === 1 ? '' : 's'} marcada${dis === 1 ? '' : 's'} previamente como no-duplicado` : '') +
          '.';
        list.innerHTML = r.pairs.map(p => `
          <div class="pv-dup-pair" data-a="${esc(p.a.id)}" data-b="${esc(p.b.id)}"
               style="border:1px solid #e5e7eb;border-radius:8px;padding:10px;margin-bottom:8px;background:#fafafa;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;flex-wrap:wrap;">
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                ${p.reasons.map(r => `<span style="font-size:11px;padding:2px 7px;border-radius:5px;background:#fef3c7;color:#92400e;font-weight:600;">${esc(r)}</span>`).join('')}
              </div>
              <span style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:11px;color:#6b7280;font-variant-numeric:tabular-nums;">score ${(p.score * 100).toFixed(0)}%</span>
                <button class="pv-dup-dismiss"
                        title="Marcar como NO duplicados. La pareja no volverá a aparecer en futuros escaneos hasta que un artículo sea borrado o lo re-actives manualmente."
                        style="padding:3px 9px;border-radius:5px;border:1px solid #d1d5db;background:white;color:#374151;font-size:11px;font-weight:600;cursor:pointer;">
                  ✗ No son duplicados
                </button>
              </span>
            </div>
            ${[p.a, p.b].map(x => `
              <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;padding:6px 0;border-top:1px solid #f3f4f6;">
                <input type="checkbox" class="pv-dup-select" data-aid="${esc(x.id)}"
                       ${state.selectedIds.has(x.id) ? 'checked' : ''}
                       title="Seleccionar — para verlo luego en el listado general"
                       style="cursor:pointer;width:14px;height:14px;margin-top:4px;flex-shrink:0;">
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

        list.querySelectorAll('.pv-dup-dismiss').forEach(b => {
          b.addEventListener('click', async () => {
            const card = b.closest('.pv-dup-pair');
            if (!card) return;
            const reason = prompt(
              'Confirmar que NO son duplicados.\n\n' +
              'La pareja no volverá a aparecer en futuros escaneos. ' +
              'Si quieres, escribe una nota corta para tu propio registro ' +
              '(opcional — pulsa Aceptar sin escribir nada para descartar sin nota):',
              ''
            );
            if (reason === null) return;   // user cancelled
            b.disabled = true;
            const orig = b.textContent;
            b.textContent = '…';
            try {
              await api('/duplicates/dismiss', {
                method: 'POST',
                body: JSON.stringify({
                  a: card.dataset.a,
                  b: card.dataset.b,
                  reason: reason || null,
                }),
              });
              card.style.transition = 'opacity 0.4s, max-height 0.4s';
              card.style.opacity = '0.35';
              setTimeout(() => card.remove(), 400);
            } catch (e) {
              b.disabled = false;
              b.textContent = orig;
              alert('Error: ' + e.message);
            }
          });
        });

        // Selecting here uses the exact same state.selectedIds as the
        // main listing's row checkboxes — check one and it shows up
        // selected there too (see the cart/JC-modal checkboxes for the
        // same pattern), so "seleccionar aquí, revisar allí" works.
        list.querySelectorAll('.pv-dup-select').forEach(cb => {
          cb.addEventListener('change', () => {
            if (cb.checked) state.selectedIds.add(cb.dataset.aid);
            else state.selectedIds.delete(cb.dataset.aid);
            updateBulkBar();
          });
        });
      } catch (e) {
        meta.textContent = 'Error: ' + e.message;
      }
    });

    // Reflect any selection made here on the main listing's already-
    // rendered checkboxes/bulk-bar as soon as the modal closes.
    closeBtn.addEventListener('click', () => {
      document.querySelectorAll('.pv-row-select').forEach(cb => {
        cb.checked = state.selectedIds.has(cb.dataset.aid);
      });
      updateBulkBar();
      syncSelectAllHeader();
    });
  }

