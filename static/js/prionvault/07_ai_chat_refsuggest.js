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

  // ── Article AI chat ──────────────────────────────────────────────────
  // A per-article Q&A modal. The prompt behind each question bundles the
  // article (vectorized text), its AI summary and the prior turns of the
  // conversation. Provider fallback (Claude → GPT → Gemini) is handled
  // server-side; the UI just flags when a switch happened. Conversations
  // are persisted so the user can revisit them later.
  const PVChat = (() => {
    let _article = null;   // { id, title }
    let _chatId  = null;   // active conversation id (null until first send)
    let _sending = false;
    let _groupArticleIds = null;  // set when this is the cart-wide chat (several articles)

    const $ = id => document.getElementById(id);

    function providerLabel(key) {
      return ({ anthropic: 'Claude', openai: 'GPT', gemini: 'Gemini' })[key] || key || '';
    }

    async function populateProviders() {
      const sel = $('pv-chat-provider');
      if (!sel) return;
      let providers = {};
      try {
        const r = await api('/chat-providers');
        providers = r.providers || {};
      } catch (e) { /* fall through to a bare default */ }
      const keys = Object.keys(providers);
      if (!keys.length) {
        sel.innerHTML =
          '<option value="anthropic">Claude</option>' +
          '<option value="openai">GPT</option>' +
          '<option value="gemini">Gemini</option>';
      } else {
        sel.innerHTML = keys.map(k => {
          const p = providers[k];
          const off = !p.configured;
          return `<option value="${esc(k)}" ${off ? 'disabled' : ''}>${esc(p.label)}${off ? ' (sin API key)' : ''}</option>`;
        }).join('');
      }
      const stored = localStorage.getItem('pv-chat-provider') || 'anthropic';
      const ok = !providers[stored] || providers[stored].configured;
      sel.value = ok ? stored
                     : (keys.find(k => providers[k].configured) || 'anthropic');
      sel.onchange = () => { if (sel.value) localStorage.setItem('pv-chat-provider', sel.value); };
    }

    function scrollToBottom() {
      const m = $('pv-chat-messages');
      if (m) m.scrollTop = m.scrollHeight;
    }

    function bubbleUser(text) {
      return `<div style="display:flex;justify-content:flex-end;margin:0 0 12px;">
        <div style="max-width:82%;background:#0F3460;color:#fff;border-radius:12px 12px 3px 12px;
                    padding:9px 13px;font-size:13.5px;line-height:1.55;white-space:pre-wrap;">${esc(text)}</div>
      </div>`;
    }

    function bubbleAssistant(text, meta) {
      const m = meta || {};
      const label = m.provider_label || providerLabel(m.provider);
      const badge = label
        ? `<span style="display:inline-block;background:#eef2ff;color:#4f46e5;font-size:10.5px;
                   font-weight:700;padding:1px 7px;border-radius:10px;margin-bottom:5px;">${esc(label)}</span>`
        : '';
      return `<div style="display:flex;justify-content:flex-start;margin:0 0 12px;">
        <div style="max-width:88%;">
          ${badge}
          <div style="background:#f9fafb;border:1px solid #e5e7eb;color:#374151;
                      border-radius:12px 12px 12px 3px;padding:10px 13px;font-size:13.5px;
                      line-height:1.6;white-space:pre-wrap;">${markdownLite(text)}</div>
        </div>
      </div>`;
    }

    function renderMessages(messages) {
      const m = $('pv-chat-messages');
      if (!m) return;
      if (!messages || !messages.length) {
        m.innerHTML = `<div style="text-align:center;color:#9ca3af;font-size:13px;padding:36px 12px;">
          Hazle a la IA cualquier pregunta sobre este artículo.<br>
          <span style="font-size:11.5px;">Metodología, resultados, limitaciones, comparación con otros trabajos…</span>
        </div>`;
        return;
      }
      m.innerHTML = messages.map(msg =>
        msg.role === 'user'
          ? bubbleUser(msg.content)
          : bubbleAssistant(msg.content, msg)
      ).join('');
      scrollToBottom();
    }

    function showSwitchNote(result) {
      const note = $('pv-chat-switch-note');
      if (!note) return;
      if (result && result.switched) {
        const from = providerLabel(result.requested_provider);
        const to   = result.provider_label || providerLabel(result.actual_provider);
        note.style.display = 'block';
        note.innerHTML = `⚠ <strong>${esc(from)}</strong> no pudo responder — te contesté con <strong>${esc(to)}</strong>.`;
      } else {
        note.style.display = 'none';
        note.innerHTML = '';
      }
    }

    async function rememberNote() {
      if (!_chatId) {
        alert('Escribe al menos una pregunta antes de crear una nota-recuerdo.');
        return;
      }
      const btn = $('pv-chat-remember-btn');
      const orig = btn ? btn.innerHTML : '';
      if (btn) { btn.disabled = true; btn.innerHTML = '⏳ <span>Pensando…</span>'; }
      try {
        const r = await api(`/chats/${_chatId}/remember-note`, { method: 'POST' });
        if (btn) { btn.innerHTML = '✓ <span>Guardada</span>'; }
        // Refresh every notes cluster showing for this article (listing
        // row + detail modal nav bar) so the new note appears right away.
        if (_article) {
          try {
            const notesResp = await api(`/articles/${_article.id}/notes`);
            _refreshNoteClusters(_article.id, notesResp.notes || [], _article);
          } catch (_) { /* best-effort refresh */ }
        }
        alert(`✓ Nota-recuerdo guardada:\n\n"${r.note.body}"`);
      } catch (e) {
        if (e.status === 409) {
          const noteText = (e.body && e.body.note_text) || '';
          if (noteText && confirm(
            `Ya tienes las 5 notas máximas en este artículo, así que no se pudo guardar.\n\n` +
            `Nota generada:\n"${noteText}"\n\n¿Copiarla al portapapeles?`
          )) {
            navigator.clipboard.writeText(noteText).catch(() => {});
          }
        } else {
          alert('Error al crear la nota-recuerdo: ' + e.message);
        }
      } finally {
        if (btn) {
          setTimeout(() => { btn.disabled = false; btn.innerHTML = orig; }, 1500);
        }
      }
    }

    async function ensureConversation() {
      if (_chatId) return _chatId;
      const provider = ($('pv-chat-provider') || {}).value || 'anthropic';
      if (_groupArticleIds && _groupArticleIds.length) {
        const r = await api('/cart/chats', {
          method: 'POST',
          body: JSON.stringify({ article_ids: _groupArticleIds, provider }),
        });
        _chatId = r.chat_id;
        return _chatId;
      }
      const r = await api(`/articles/${_article.id}/chats`, {
        method: 'POST',
        body: JSON.stringify({ provider }),
      });
      _chatId = r.chat_id;
      return _chatId;
    }

    async function send() {
      if (_sending) return;
      const input = $('pv-chat-input');
      const question = (input.value || '').trim();
      if (!question) return;
      _sending = true;
      const sendBtn = $('pv-chat-send');
      if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '…'; }

      const m = $('pv-chat-messages');
      // Clear the placeholder if this is the first message.
      if (m && m.querySelector('div[style*="text-align:center"]')) m.innerHTML = '';
      if (m) m.insertAdjacentHTML('beforeend', bubbleUser(question));
      input.value = '';
      const thinkingId = 'pv-chat-thinking';
      if (m) {
        m.insertAdjacentHTML('beforeend',
          `<div id="${thinkingId}" style="display:flex;justify-content:flex-start;margin:0 0 12px;">
             <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;
                         padding:10px 13px;font-size:13px;color:#9ca3af;">
               <i class="fas fa-spinner fa-spin"></i> Pensando…
             </div>
           </div>`);
      }
      scrollToBottom();

      try {
        await ensureConversation();
        const provider = ($('pv-chat-provider') || {}).value || undefined;
        const r = await api(`/chats/${_chatId}/ask`, {
          method: 'POST',
          body: JSON.stringify({ question, provider }),
        });
        $(thinkingId)?.remove();
        if (m) m.insertAdjacentHTML('beforeend', bubbleAssistant(r.answer, r));
        showSwitchNote(r);
        scrollToBottom();
        updateLauncherCount(_article);
      } catch (e) {
        $(thinkingId)?.remove();
        let detail = e.message || 'Error desconocido';
        if (e.body && e.body.attempts && e.body.attempts.length) {
          detail += ' — ' + e.body.attempts
            .map(a => `${providerLabel(a.provider)}: ${a.reason}`).join('; ');
        }
        if (m) m.insertAdjacentHTML('beforeend',
          `<div style="margin:0 0 12px;font-size:12.5px;color:#b91c1c;background:#fef2f2;
                       border:1px solid #fecaca;border-radius:10px;padding:9px 12px;">
             No se pudo obtener respuesta: ${esc(detail)}
           </div>`);
        scrollToBottom();
      } finally {
        _sending = false;
        if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Enviar'; }
      }
    }

    function newConversation() {
      _chatId = null;
      showSwitchNote(null);
      renderMessages([]);
      const panel = $('pv-chat-history-panel');
      if (panel) panel.style.display = 'none';
      const input = $('pv-chat-input');
      if (input) input.focus();
    }

    async function loadHistory() {
      const panel = $('pv-chat-history-panel');
      const list  = $('pv-chat-history-list');
      if (!panel || !list) return;
      panel.style.display = 'block';
      list.innerHTML = '<div style="color:#9ca3af;font-size:12.5px;padding:6px;">Cargando…</div>';
      try {
        const r = await api(`/articles/${_article.id}/chats`);
        const chats = r.chats || [];
        if (!chats.length) {
          list.innerHTML = '<div style="color:#9ca3af;font-size:12.5px;padding:6px;">Aún no hay conversaciones sobre este artículo.</div>';
          return;
        }
        list.innerHTML = chats.map(c => {
          const when = c.updated_at ? new Date(c.updated_at).toLocaleString() : '';
          const label = c.provider_label || providerLabel(c.requested_provider);
          return `<div class="pv-chat-hist-item" data-cid="${esc(c.id)}"
                       style="border:1px solid #e5e7eb;border-radius:8px;padding:9px 11px;margin-bottom:7px;
                              cursor:pointer;background:#fff;display:flex;gap:10px;align-items:center;">
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;color:#111827;font-weight:600;white-space:nowrap;
                          overflow:hidden;text-overflow:ellipsis;">${esc(c.title || 'Conversación')}</div>
              <div style="font-size:11px;color:#9ca3af;margin-top:2px;">
                ${esc(when)} · ${c.message_count || 0} mensaje${(c.message_count||0) === 1 ? '' : 's'}
              </div>
            </div>
            <span style="background:#eef2ff;color:#4f46e5;font-size:10.5px;font-weight:700;
                         padding:1px 7px;border-radius:10px;flex-shrink:0;">${esc(label)}</span>
            <button class="pv-chat-hist-del" data-cid="${esc(c.id)}" title="Eliminar conversación"
                    style="flex-shrink:0;background:none;border:none;color:#b91c1c;cursor:pointer;font-size:13px;">🗑</button>
          </div>`;
        }).join('');
        list.querySelectorAll('.pv-chat-hist-item').forEach(el => {
          el.addEventListener('click', ev => {
            if (ev.target.closest('.pv-chat-hist-del')) return;
            openConversation(el.dataset.cid);
          });
        });
        list.querySelectorAll('.pv-chat-hist-del').forEach(btn => {
          btn.addEventListener('click', async ev => {
            ev.stopPropagation();
            if (!confirm('¿Eliminar esta conversación? No se puede deshacer.')) return;
            try {
              await api(`/chats/${btn.dataset.cid}`, { method: 'DELETE' });
              if (_chatId === btn.dataset.cid) newConversation();
              loadHistory();
              updateLauncherCount(_article);
            } catch (e) { alert('No se pudo eliminar: ' + e.message); }
          });
        });
      } catch (e) {
        list.innerHTML = `<div style="color:#b91c1c;font-size:12.5px;padding:6px;">Error: ${esc(e.message)}</div>`;
      }
    }

    async function openConversation(chatId) {
      const m = $('pv-chat-messages');
      if (m) m.innerHTML = '<div style="text-align:center;color:#9ca3af;padding:30px;font-size:13px;">Cargando…</div>';
      const panel = $('pv-chat-history-panel');
      if (panel) panel.style.display = 'none';
      showSwitchNote(null);
      try {
        const chat = await api(`/chats/${chatId}`);
        _chatId = chat.id;
        const sel = $('pv-chat-provider');
        if (sel && chat.requested_provider) sel.value = chat.requested_provider;
        renderMessages(chat.messages || []);
      } catch (e) {
        if (m) m.innerHTML = `<div style="color:#b91c1c;padding:16px;font-size:13px;">Error: ${esc(e.message)}</div>`;
      }
    }

    function _paintHistoryBtn(hasChats) {
      const btn = $('pv-chat-history-btn');
      if (!btn) return;
      if (hasChats) {
        btn.style.background = '#15803d';
        btn.style.borderColor = '#15803d';
        btn.style.color = '#fff';
      } else {
        btn.style.background = 'white';
        btn.style.borderColor = '#d1d5db';
        btn.style.color = '#374151';
      }
    }

    async function updateLauncherCount(article) {
      const badge = document.getElementById('pv-detail-chat-count');
      if (!article || _groupArticleIds) return;
      try {
        const r = await api(`/articles/${article.id}/chats`);
        const n = (r.chats || []).length;
        if (badge) {
          if (n > 0) { badge.style.display = 'inline-block'; badge.textContent = n; }
          else       { badge.style.display = 'none'; }
        }
        // Only paint the in-modal "Chats anteriores" button if this
        // count is for the article currently open in the chat modal —
        // updateLauncherCount is also called from the listing/detail
        // page for the launcher badge, well before the modal opens.
        if (_article && _article.id === article.id) _paintHistoryBtn(n > 0);
      } catch (e) { /* silent */ }
    }

    let _wired = false;
    function wireOnce() {
      if (_wired) return;
      _wired = true;
      $('pv-chat-close')?.addEventListener('click', close);
      document.querySelector('#pv-chat-modal .pv-modal-backdrop')?.addEventListener('click', close);
      $('pv-chat-send')?.addEventListener('click', send);
      $('pv-chat-new-btn')?.addEventListener('click', newConversation);
      $('pv-chat-history-btn')?.addEventListener('click', loadHistory);
      $('pv-chat-remember-btn')?.addEventListener('click', rememberNote);
      $('pv-chat-overview-btn')?.addEventListener('click', () => window.openChatsOverview?.());
      $('pv-chat-report-btn')?.addEventListener('click', () => {
        if (!_chatId) { alert('Escribe al menos una pregunta antes de generar un informe.'); return; }
        PVChatReport.open(_chatId);
      });
      const input = $('pv-chat-input');
      if (input) input.addEventListener('keydown', ev => {
        // Enter sends, Shift+Enter makes a newline.
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
      });
    }

    function open(article, opts = {}) {
      _article = article;
      _chatId = null;
      _groupArticleIds = opts.groupArticleIds || null;
      wireOnce();
      const modal = document.getElementById('pv-chat-modal');
      if (!modal) return;
      const titleEl = document.getElementById('pv-chat-article-title');
      if (titleEl) titleEl.innerHTML = supHtml(article.title || '(sin título)');
      const metaEl = document.getElementById('pv-chat-article-meta');
      if (metaEl) {
        const bits = [];
        if (article.authors) bits.push(esc(article.authors));
        const line2 = [];
        if (article.journal) line2.push(esc(article.journal));
        if (article.year)    line2.push(String(article.year));
        if (line2.length) bits.push(line2.join(' · '));
        if (article.doi) {
          bits.push(`<a href="https://doi.org/${esc(article.doi)}" target="_blank" rel="noopener"
                        style="color:#0F3460;text-decoration:none;">${esc(article.doi)}</a>`);
        } else if (article.pubmed_id) {
          bits.push(`PMID ${esc(article.pubmed_id)}`);
        }
        metaEl.innerHTML = bits.join('<br>');
      }
      showSwitchNote(null);
      renderMessages([]);
      modal.style.display = 'flex';
      populateProviders();
      const historyBtn = $('pv-chat-history-btn');
      if (historyBtn) historyBtn.style.display = _groupArticleIds ? 'none' : '';
      if (_groupArticleIds) {
        const panel = $('pv-chat-history-panel');
        if (panel) panel.style.display = 'none';
        $('pv-chat-input')?.focus();
      } else {
        _paintHistoryBtn(false);   // reset to the default colour until the count for THIS article lands
        updateLauncherCount(article);
        if (opts.showHistory) loadHistory();
        else {
          const panel = $('pv-chat-history-panel');
          if (panel) panel.style.display = 'none';
          $('pv-chat-input')?.focus();
        }
      }
    }

    function close() {
      const modal = document.getElementById('pv-chat-modal');
      if (modal) modal.style.display = 'none';
    }

    return { open, close, updateLauncherCount };
  })();

  // ── Article chat report — intermediate format/destination modal ──────────
  // Reuses the download-via-window.open pattern from the library chat's
  // per-pair report button, plus a small email flow (send_email_with_
  // attachments on the backend, same as the cart's bulk email).
  const PVChatReport = (() => {
    const $ = id => document.getElementById(id);
    let _chatId = null;

    function selectedFormat() {
      const el = document.querySelector('input[name="pv-chat-report-format"]:checked');
      return el ? el.value : 'pdf';
    }

    function syncMode() {
      const emailOn = $('pv-chat-report-email-toggle')?.checked;
      const controls = $('pv-chat-report-email-controls');
      if (controls) controls.style.display = emailOn ? 'block' : 'none';
      const label = $('pv-chat-report-go-label');
      const icon = document.querySelector('#pv-chat-report-go i');
      if (label) label.textContent = emailOn ? 'Enviar' : 'Descargar';
      if (icon) icon.className = emailOn ? 'fas fa-paper-plane' : 'fas fa-download';
    }

    function setStatus(msg, isError) {
      const el = $('pv-chat-report-status');
      if (!el) return;
      el.style.color = isError ? '#b91c1c' : '#15803d';
      el.textContent = msg || '';
    }

    async function go() {
      if (!_chatId) return;
      const fmt = selectedFormat();
      const emailOn = $('pv-chat-report-email-toggle')?.checked;
      const btn = $('pv-chat-report-go');
      if (!emailOn) {
        window.open(`${API}/chats/${_chatId}/report?format=${fmt}`, '_blank');
        close();
        return;
      }
      const to = ($('pv-chat-report-to')?.value || '').trim();
      if (!to) { setStatus('Escribe un destinatario.', true); return; }
      btn.disabled = true;
      setStatus('Enviando…', false);
      try {
        await api(`/chats/${_chatId}/report/email`, {
          method: 'POST',
          body: JSON.stringify({
            to, format: fmt,
            comment: ($('pv-chat-report-comment')?.value || '').trim(),
          }),
        });
        setStatus('✓ Enviado', false);
        setTimeout(close, 1400);
        setTimeout(() => { btn.disabled = false; }, 1600);  // no double send before close
      } catch (e) {
        setStatus('Error: ' + (e.message || e), true);
        btn.disabled = false;
      }
    }

    function close() { const m = $('pv-chat-report-modal'); if (m) m.style.display = 'none'; }

    let _wired = false;
    function wireOnce() {
      if (_wired) return;
      _wired = true;
      $('pv-chat-report-close')?.addEventListener('click', close);
      document.querySelector('#pv-chat-report-modal .pv-modal-backdrop')?.addEventListener('click', close);
      $('pv-chat-report-email-toggle')?.addEventListener('change', syncMode);
      $('pv-chat-report-go')?.addEventListener('click', go);
    }

    function open(chatId) {
      _chatId = chatId;
      wireOnce();
      const modal = $('pv-chat-report-modal');
      if (!modal) return;
      setStatus('', false);
      const emailToggle = $('pv-chat-report-email-toggle');
      if (emailToggle) emailToggle.checked = false;
      const to = $('pv-chat-report-to'); if (to) to.value = '';
      const comment = $('pv-chat-report-comment'); if (comment) comment.value = '';
      syncMode();
      modal.style.display = 'flex';
    }

    return { open };
  })();

  function wireChatLauncher(a) {
    const btn     = document.getElementById('pv-detail-chat-btn');
    const histBtn = document.getElementById('pv-detail-chat-history-btn');
    if (btn)     btn.addEventListener('click', () => PVChat.open(a, { showHistory: false }));
    if (histBtn) histBtn.addEventListener('click', () => PVChat.open(a, { showHistory: true }));
    PVChat.updateLauncherCount(a);
  }

  // ── Chats con IA — library-wide overview ──────────────────────────────
  // Reachable from the chat modal's "📊 Ver todos" button and from the
  // "Chats con IA" panel in Salud biblioteca. Self-contained: fetches
  // /api/chats/overview and renders its own modal, so either caller can
  // just invoke it with no setup.
  window.openChatsOverview = async function openChatsOverview() {
    const modal = document.getElementById('pv-chats-overview-modal');
    const body  = document.getElementById('pv-chats-overview-body');
    if (!modal || !body) return;

    if (!modal.dataset.wired) {
      modal.dataset.wired = '1';
      const close = () => { modal.style.display = 'none'; };
      document.getElementById('pv-chats-overview-close')?.addEventListener('click', close);
      modal.querySelector('.pv-modal-backdrop')?.addEventListener('click', close);
    }

    modal.style.display = 'flex';
    body.innerHTML = '<p style="color:#9ca3af;text-align:center;padding:2rem;">Cargando…</p>';

    let d;
    try {
      d = await api('/chats/overview');
    } catch (e) {
      body.innerHTML = `<p style="color:#ef4444;text-align:center;padding:2rem;">Error al cargar: ${esc(e.message)}</p>`;
      return;
    }

    const total = d.total_articles || 0;
    const withChat = d.articles_with_chat || 0;
    const pct = total > 0 ? Math.round(withChat / total * 100) : 0;
    const items = d.items || [];

    const hero = `
      <div style="text-align:center;background:#f0f4ff;border:1px solid #c7d2fe;border-radius:12px;
                  padding:16px 24px;margin-bottom:18px;">
        <div style="font-size:32px;font-weight:800;color:#3730a3;line-height:1;">
          ${withChat.toLocaleString()} <span style="font-size:18px;font-weight:600;color:#6366f1;">/ ${total.toLocaleString()}</span>
        </div>
        <div style="font-size:13px;color:#6b7280;margin-top:4px;">
          artículos con al menos un chat iniciado (${pct}%)
        </div>
      </div>`;

    if (!items.length) {
      body.innerHTML = hero + `
        <p style="text-align:center;color:#9ca3af;padding:24px;font-size:13px;">
          Todavía no se ha usado el chat de IA en ningún artículo.
        </p>`;
      return;
    }

    const rowHtml = (it) => {
      const meta = [
        it.authors ? it.authors.split(';')[0] + (it.authors.includes(';') ? ' et al.' : '') : '',
        it.year || '',
      ].filter(Boolean).join(' · ');
      const when = it.last_activity
        ? new Date(it.last_activity).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' })
        : '';
      return `
        <div class="pv-chats-ov-row" data-aid="${esc(it.article_id)}"
             data-title="${esc(it.title || '')}" data-authors="${esc(it.authors || '')}" data-year="${esc(it.year || '')}"
             style="display:flex;align-items:center;gap:12px;padding:11px 12px;border-radius:8px;cursor:pointer;
                    border:1px solid #e5e7eb;margin-bottom:6px;transition:box-shadow 0.15s,border-color 0.15s;"
             onmouseenter="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.08)';this.style.borderColor='#c7d2fe';"
             onmouseleave="this.style.boxShadow='none';this.style.borderColor='#e5e7eb';">
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              ${esc(it.title || '(sin título)')}
            </div>
            <div style="font-size:11.5px;color:#9ca3af;margin-top:2px;">${esc(meta)}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex-shrink:0;">
            <span style="font-size:11px;font-weight:700;color:#0F3460;background:#eff6ff;padding:2px 8px;border-radius:20px;">
              💬 ${it.chat_count} chat${it.chat_count === 1 ? '' : 's'} · ${it.message_count} msj.
            </span>
            <span style="font-size:10.5px;color:#9ca3af;">
              ${it.users > 1 ? `${it.users} usuarios · ` : ''}${esc(when)}
            </span>
          </div>
        </div>`;
    };

    body.innerHTML = hero +
      `<div>${items.map(rowHtml).join('')}</div>` +
      (items.length >= 300
        ? '<p style="text-align:center;color:#9ca3af;font-size:11.5px;margin-top:10px;">Mostrando los 300 más recientes.</p>'
        : '');

    body.querySelectorAll('.pv-chats-ov-row').forEach(row => {
      row.addEventListener('click', () => {
        modal.style.display = 'none';
        PVChat.open({
          id: row.dataset.aid,
          title: row.dataset.title,
          authors: row.dataset.authors,
          year: row.dataset.year || null,
        }, { showHistory: true });
      });
    });
  };

  // ── Library chat — persistent, memory-capable AI chat over the whole
  // library (replaces the old strict-grounding "AI search" modal). ──────
  const PVLibChat = (() => {
    const $ = id => document.getElementById(id);
    let _wired = false;
    let _currentChatId = null;
    let _currentChatTitle = '';
    let _currentMessages = [];
    let _chats = [];
    let _citeBuffer = [];   // [{question, answer, source_title}] — "usar aquí" picks
    let _provider = localStorage.getItem('pv-libchat-provider') || 'anthropic';

    const PROVIDER_COLORS = { anthropic: '#CC785C', openai: '#10A37F', gemini: '#8b5cf6' };

    function paintProvider() {
      document.querySelectorAll('.pv-libchat-provider-btn').forEach(b => {
        const active = b.dataset.provider === _provider;
        const color = PROVIDER_COLORS[b.dataset.provider];
        b.style.borderColor = active ? color : '#e5e7eb';
        b.style.background  = active ? color + '14' : '#fff';
      });
    }

    function fmtDate(iso) {
      if (!iso) return '';
      return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
    }

    // ── Answer rendering: light markdown (headers/bold/lists/paragraphs)
    // + [N] citation tokens turned into navy hover chips. ─────────────────
    function _mdToHtml(text) {
      const lines = esc(text || '').split('\n');
      const out = [];
      let listType = null;   // 'ul' | 'ol' | null
      const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
      for (let raw of lines) {
        const line = raw.trim();
        if (!line) { closeList(); continue; }
        let m;
        if ((m = line.match(/^#{2,3}\s+(.+)$/))) {
          closeList();
          out.push(`<div style="font-size:12.5px;font-weight:700;color:#065f46;` +
            `text-transform:uppercase;letter-spacing:0.04em;margin:12px 0 4px;">${m[1]}</div>`);
        } else if ((m = line.match(/^[-*]\s+(.+)$/))) {
          if (listType !== 'ul') { closeList(); out.push('<ul style="margin:4px 0 8px;padding-left:20px;">'); listType = 'ul'; }
          out.push(`<li style="margin-bottom:2px;">${m[1]}</li>`);
        } else if ((m = line.match(/^\d+\.\s+(.+)$/))) {
          if (listType !== 'ol') { closeList(); out.push('<ol style="margin:4px 0 8px;padding-left:20px;">'); listType = 'ol'; }
          out.push(`<li style="margin-bottom:2px;">${m[1]}</li>`);
        } else {
          closeList();
          out.push(`<p style="margin:0 0 8px;">${line}</p>`);
        }
      }
      closeList();
      let html = out.join('');
      html = html.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
      return html;
    }

    // Turns every "[N]" token into a clickable, hoverable navy chip.
    // The hover card shows the full reference (authors/year/journal,
    // DOI/PMID/PDF links) and a cart button — resolved from the
    // message's own `citations` list (persisted on the message, so
    // this works identically for a fresh answer and a reloaded one).
    //
    // Click, not hover: the chip lives inside #pv-libchat-thread, which
    // scrolls (overflow-y:auto) — an absolutely-positioned hover card
    // anchored to the chip gets clipped by that scroll box even though
    // it's visually "above" it, so hover silently did nothing. A single
    // shared popup element appended to <body> (see _citePopupEl) and
    // positioned with fixed coordinates from the chip's own
    // getBoundingClientRect sidesteps that entirely.
    const _citeRegistry = new Map();   // chip element id -> citation dict
    let _citeSeq = 0;

    function _linkCitations(html, citations) {
      if (!citations || !citations.length) return html;
      const byN = new Map(citations.map(c => [c.n, c]));
      return html.replace(/\[(\d{1,3})\]/g, (full, nStr) => {
        const n = parseInt(nStr, 10);
        const c = byN.get(n);
        if (!c) return full;
        const chipId = `pv-cite-${++_citeSeq}`;
        _citeRegistry.set(chipId, c);
        // Navy "tag" pill, per request — a badge, not underlined text.
        return `<span id="${chipId}" class="pv-cite"
                 style="display:inline-flex;align-items:center;justify-content:center;
                        min-width:16px;height:16px;padding:0 4px;margin:0 1px;border-radius:4px;
                        background:#1e3a8a;color:#fff;font-size:9.5px;font-weight:700;
                        cursor:pointer;vertical-align:2px;">${n}</span>`;
      });
    }

    function _closeCitePopup() {
      document.getElementById('pv-cite-popup')?.remove();
      document.removeEventListener('click', _citePopupOutsideClick, true);
    }
    function _citePopupOutsideClick(e) {
      const pop = document.getElementById('pv-cite-popup');
      if (pop && !pop.contains(e.target) && !e.target.classList.contains('pv-cite')) _closeCitePopup();
    }

    function _openCitePopup(chip, c) {
      _closeCitePopup();
      const meta = [c.authors, c.year, c.journal].filter(Boolean).join(' · ');
      const doiLink = c.doi
        ? `<a href="https://doi.org/${encodeURIComponent(c.doi)}" target="_blank" rel="noopener"
              style="color:#1e3a8a;text-decoration:none;">DOI ↗</a>` : '';
      const pmidLink = c.pubmed_id
        ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${esc(c.pubmed_id)}/" target="_blank" rel="noopener"
              style="color:#1e3a8a;text-decoration:none;">PMID ↗</a>` : '';
      const pdfLink = c.has_pdf
        ? `<a href="${API}/articles/${esc(c.article_id)}/pdf-view" target="_blank" rel="noopener"
              style="color:#b91c1c;text-decoration:none;"><i class="fas fa-file-pdf"></i> PDF</a>` : '';
      const links = [doiLink, pmidLink, pdfLink].filter(Boolean).join(' &nbsp;·&nbsp; ');

      const pop = document.createElement('div');
      pop.id = 'pv-cite-popup';
      pop.style.cssText = 'position:fixed;width:280px;background:#fff;border:1px solid #d1d5db;' +
        'border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,0.2);padding:12px 13px;' +
        'z-index:99999;font-size:12px;line-height:1.4;';
      pop.innerHTML =
        `<div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px;">` +
          `<span style="display:inline-flex;align-items:center;justify-content:center;min-width:16px;
                        height:16px;padding:0 4px;border-radius:4px;background:#1e3a8a;color:#fff;
                        font-size:9.5px;font-weight:700;flex-shrink:0;">${esc(c.n)}</span>` +
          `<button type="button" id="pv-cite-popup-close" style="all:unset;cursor:pointer;
                   color:#9ca3af;font-size:13px;line-height:1;">×</button>` +
        `</div>` +
        `<div style="font-weight:700;color:#111827;margin-bottom:3px;cursor:pointer;" data-open-aid="${esc(c.article_id)}">
           ${esc(c.title || '')}
         </div>` +
        (meta ? `<div style="color:#6b7280;margin-bottom:6px;">${esc(meta)}</div>` : '') +
        (links ? `<div style="margin-bottom:8px;">${links}</div>` : '') +
        `<button type="button" class="pv-cite-cart-btn" data-aid="${esc(c.article_id)}"
                 data-title="${esc(c.title || '')}" data-authors="${esc(c.authors || '')}"
                 data-year="${esc(c.year || '')}" data-journal="${esc(c.journal || '')}"
                 data-doi="${esc(c.doi || '')}" data-pmid="${esc(c.pubmed_id || '')}"
                 data-haspdf="${c.has_pdf ? '1' : '0'}"
                 style="width:100%;padding:5px 8px;border-radius:6px;border:1px solid #d1d5db;
                        background:#f9fafb;color:#374151;font-size:11.5px;font-weight:600;cursor:pointer;">
           🛒 Añadir al carrito
         </button>`;
      document.body.appendChild(pop);

      // Position under the chip, flipped above if it would overflow the
      // viewport bottom; clamped horizontally so it never runs off-screen.
      const r = chip.getBoundingClientRect();
      const popRect = pop.getBoundingClientRect();
      let top = r.bottom + 6;
      if (top + popRect.height > window.innerHeight - 8) top = r.top - popRect.height - 6;
      let left = Math.min(r.left, window.innerWidth - popRect.width - 8);
      left = Math.max(8, left);
      pop.style.top = `${Math.max(8, top)}px`;
      pop.style.left = `${left}px`;

      pop.querySelector('#pv-cite-popup-close')?.addEventListener('click', _closeCitePopup);
      pop.querySelector('[data-open-aid]')?.addEventListener('click', () => {
        _closeCitePopup();
        openDetail(c.article_id);
      });
      pop.querySelector('.pv-cite-cart-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        window.PPCart?.add({
          id: c.article_id, title: c.title, authors: c.authors, year: c.year || null,
          journal: c.journal, doi: c.doi, pubmed_id: c.pubmed_id, has_pdf: !!c.has_pdf,
        });
        const btn = e.currentTarget;
        btn.textContent = '✓ En el carrito';
        btn.disabled = true;
      });

      setTimeout(() => document.addEventListener('click', _citePopupOutsideClick, true), 0);
    }

    function bubbleHtml(m) {
      const isUser = m.role === 'user';
      const bodyHtml = isUser
        ? esc(m.content || '').replace(/\n/g, '<br>')
        : _linkCitations(_mdToHtml(m.content), m.citations);
      return `
        <div style="display:flex;${isUser ? 'justify-content:flex-end;' : ''}">
          <div style="max-width:78%;padding:10px 14px;border-radius:12px;font-size:13.5px;line-height:1.55;
                      ${isUser
                        ? 'background:#059669;color:#fff;border-bottom-right-radius:3px;'
                        : 'background:#ecfdf5;color:#111827;border:1px solid #d1fae5;border-bottom-left-radius:3px;'}">
            ${bodyHtml}
            ${!isUser && m.provider_label
              ? `<div style="margin-top:6px;font-size:10px;color:#6b7280;">
                   ${esc(m.provider_label)}${m.switched ? ' (proveedor sustituido)' : ''}
                 </div>` : ''}
          </div>
        </div>`;
    }

    // A "pair" is one user question + its assistant answer (may be
    // missing if the question is still pending or was never answered).
    // Rendered together with a small toolbar under the question:
    //   📌 cite it into the active conversation elsewhere
    //   🚀 start a brand-new conversation from this question
    //   🗑 delete the question + its answer (asks for confirmation)
    function pairHtml(userMsg, assistantMsg) {
      const mid = userMsg.id;
      return `
        <div class="pv-libchat-pair" data-mid="${mid}" style="margin-bottom:16px;">
          ${bubbleHtml(userMsg)}
          <div style="display:flex;justify-content:flex-end;gap:4px;margin:3px 2px 0;">
            <button type="button" class="pv-pair-cite" data-mid="${mid}" title="Citar esta pregunta y su respuesta en otra conversación"
                    style="border:none;background:none;color:#9ca3af;cursor:pointer;font-size:11px;padding:2px 4px;">📌</button>
            <button type="button" class="pv-pair-fork" data-mid="${mid}" title="Empezar una conversación nueva con esta pregunta"
                    style="border:none;background:none;color:#9ca3af;cursor:pointer;font-size:11px;padding:2px 4px;">🚀</button>
            <span style="position:relative;display:inline-block;">
              <button type="button" class="pv-pair-report" data-mid="${mid}"
                      title="Generar informe de la conversación hasta aquí (PDF o Word)"
                      style="border:none;background:none;color:#9ca3af;cursor:pointer;font-size:11px;padding:2px 4px;">📄</button>
              <span class="pv-pair-report-menu" style="display:none;position:absolute;right:0;top:100%;z-index:20;
                    background:white;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.14);
                    padding:4px;white-space:nowrap;">
                <button type="button" class="pv-pair-report-fmt" data-mid="${mid}" data-fmt="pdf"
                        style="display:block;width:100%;text-align:left;border:none;background:none;
                               padding:6px 12px;font-size:12px;color:#374151;cursor:pointer;border-radius:5px;">📄 Informe en PDF</button>
                <button type="button" class="pv-pair-report-fmt" data-mid="${mid}" data-fmt="docx"
                        style="display:block;width:100%;text-align:left;border:none;background:none;
                               padding:6px 12px;font-size:12px;color:#374151;cursor:pointer;border-radius:5px;">📝 Informe en Word</button>
              </span>
            </span>
            <button type="button" class="pv-pair-delete" data-mid="${mid}" title="Borrar esta pregunta y su respuesta"
                    style="border:none;background:none;color:#9ca3af;cursor:pointer;font-size:11px;padding:2px 4px;">🗑</button>
          </div>
          ${assistantMsg ? `<div style="margin-top:6px;">${bubbleHtml(assistantMsg)}</div>` : ''}
        </div>`;
    }

    function _wireThreadInteractions(el) {
      el.querySelectorAll('.pv-cite').forEach(chip => {
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          const c = _citeRegistry.get(chip.id);
          if (c) _openCitePopup(chip, c);
        });
      });
      el.querySelectorAll('.pv-pair-delete').forEach(btn => {
        btn.addEventListener('click', () => deletePair(parseInt(btn.dataset.mid, 10)));
      });
      el.querySelectorAll('.pv-pair-fork').forEach(btn => {
        btn.addEventListener('click', () => forkFromPair(parseInt(btn.dataset.mid, 10)));
      });
      el.querySelectorAll('.pv-pair-cite').forEach(btn => {
        btn.addEventListener('click', () => citePair(parseInt(btn.dataset.mid, 10), btn));
      });
      el.querySelectorAll('.pv-pair-report').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const menu = btn.nextElementSibling;
          if (!menu) return;
          const wasOpen = menu.style.display === 'block';
          el.querySelectorAll('.pv-pair-report-menu').forEach(m => { m.style.display = 'none'; });
          menu.style.display = wasOpen ? 'none' : 'block';
        });
      });
      el.querySelectorAll('.pv-pair-report-fmt').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const mid = btn.dataset.mid;
          const fmt = btn.dataset.fmt;
          window.open(`${API}/library-chats/${_currentChatId}/report?format=${fmt}&up_to=${mid}`, '_blank');
          btn.closest('.pv-pair-report-menu').style.display = 'none';
        });
      });
    }

    // Close any open "Informe" menu when clicking outside it.
    document.addEventListener('click', () => {
      document.querySelectorAll('.pv-pair-report-menu').forEach(m => { m.style.display = 'none'; });
    });

    function renderThread(chat) {
      const el = $('pv-libchat-thread');
      _currentMessages = (chat && chat.messages) || [];
      if (!_currentMessages.length) {
        el.innerHTML = `<div style="height:100%;display:flex;align-items:center;justify-content:center;
                    color:#9ca3af;font-size:13px;text-align:center;padding:24px;">
          Pregunta lo que quieras — la IA combinará lo que encuentre en PrionVault<br>
          con su propio conocimiento, dejando claro de dónde viene cada cosa.</div>`;
        return;
      }
      // Only the most recent messages load by default (see get_chat's
      // limit_pairs) — a conversation used for months can otherwise take
      // several seconds just to fetch + render every time it's opened.
      const truncatedBanner = chat && chat.truncated
        ? `<div style="text-align:center;margin-bottom:12px;">
             <button type="button" id="pv-libchat-load-full"
                     style="border:1px solid #d1d5db;background:white;color:#374151;font-size:11.5px;
                            font-weight:600;padding:5px 12px;border-radius:20px;cursor:pointer;">
               ↑ Mostrando las últimas ${esc(_currentMessages.length)} de ${esc(chat.total_messages)} — cargar conversación completa
             </button>
           </div>`
        : '';
      const html = [];
      for (let i = 0; i < _currentMessages.length; i++) {
        const m = _currentMessages[i];
        if (m.role !== 'user') continue;   // assistant turns are consumed alongside their question
        const next = _currentMessages[i + 1];
        html.push(pairHtml(m, next && next.role === 'assistant' ? next : null));
      }
      el.innerHTML = truncatedBanner + html.join('');
      $('pv-libchat-load-full')?.addEventListener('click', () => openChat(_currentChatId, { full: true }));
      _wireThreadInteractions(el);
      el.scrollTop = truncatedBanner ? 0 : el.scrollHeight;
    }

    function renderList() {
      const el = $('pv-libchat-list');
      if (!_chats.length) {
        el.innerHTML = `<div style="padding:16px 10px;text-align:center;color:#9ca3af;font-size:11.5px;">
          Sin conversaciones todavía.</div>`;
        return;
      }
      el.innerHTML = _chats.map(c => `
        <div class="pv-libchat-item" data-id="${esc(c.id)}"
             style="padding:9px 10px;border-bottom:1px solid #f3f4f6;cursor:pointer;
                    display:flex;align-items:flex-start;gap:6px;
                    ${c.id === _currentChatId ? 'background:#d1fae5;' : ''}">
          <div style="flex:1;min-width:0;">
            <div title="${esc(c.title || 'Nueva conversación')}"
                 style="font-size:12px;font-weight:600;color:#111827;white-space:nowrap;
                        overflow:hidden;text-overflow:ellipsis;">${esc(c.title || 'Nueva conversación')}</div>
            <div style="font-size:10.5px;color:#9ca3af;margin-top:1px;">
              ${fmtDate(c.updated_at)} · ${c.message_count} msj.
            </div>
          </div>
          <button type="button" class="pv-libchat-delete" data-id="${esc(c.id)}"
                  title="Borrar esta conversación entera"
                  style="border:none;background:none;color:#9ca3af;cursor:pointer;
                         font-size:11px;padding:2px 4px;flex-shrink:0;">🗑</button>
        </div>`).join('');
      el.querySelectorAll('.pv-libchat-item').forEach(row => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('.pv-libchat-delete')) return;
          openChat(row.dataset.id);
        });
      });
      el.querySelectorAll('.pv-libchat-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          const chat = _chats.find(c => c.id === id);
          if (!confirm(`¿Borrar la conversación "${chat ? (chat.title || 'Nueva conversación') : ''}" entera? No se puede deshacer.`)) return;
          try {
            await api(`/library-chats/${id}`, { method: 'DELETE' });
            _chats = _chats.filter(c => c.id !== id);
            if (_currentChatId === id) {
              _currentChatId = null;
              if (_chats.length) await openChat(_chats[0].id);
              else renderThread(null);
            }
            renderList();
          } catch (err) {
            alert('Error al borrar: ' + err.message);
          }
        });
      });
    }

    async function loadChats() {
      try {
        const r = await api('/library-chats');
        _chats = r.chats || [];
        renderList();
      } catch (e) { /* silent — list stays empty */ }
    }

    async function openChat(chatId, opts = {}) {
      _currentChatId = chatId;
      renderList();
      $('pv-libchat-thread').innerHTML =
        '<div style="text-align:center;color:#9ca3af;padding:30px;">Cargando…</div>';
      try {
        const chat = await api(`/library-chats/${chatId}${opts.full ? '?full=1' : ''}`);
        _provider = chat.requested_provider || _provider;
        _currentChatTitle = chat.title || '';
        paintProvider();
        renderThread(chat);
      } catch (e) {
        $('pv-libchat-thread').innerHTML =
          `<div style="text-align:center;color:#b91c1c;padding:30px;">Error: ${esc(e.message)}</div>`;
      }
    }

    async function newChat() {
      try {
        const r = await api('/library-chats', { method: 'POST', body: JSON.stringify({ provider: _provider }) });
        await loadChats();
        await openChat(r.chat_id);
        $('pv-libchat-input')?.focus();
      } catch (e) { alert('Error al crear la conversación: ' + e.message); }
    }

    async function send() {
      const input = $('pv-libchat-input');
      const question = (input.value || '').trim();
      if (!question) return;
      if (!_currentChatId) await newChat();
      if (!_currentChatId) return;

      input.value = '';
      const sendBtn = $('pv-libchat-send');
      sendBtn.disabled = true;

      // Optimistic user bubble while waiting for the answer.
      const el = $('pv-libchat-thread');
      const wasEmpty = el.querySelector('div[style*="height:100%"]');
      if (wasEmpty) el.innerHTML = '';
      el.insertAdjacentHTML('beforeend', bubbleHtml({ role: 'user', content: question }));
      el.insertAdjacentHTML('beforeend',
        `<div id="pv-libchat-pending" style="display:flex;margin-bottom:14px;">
           <div style="padding:10px 14px;border-radius:12px;background:#ecfdf5;border:1px solid #d1fae5;
                       font-size:13px;color:#065f46;">
             <i class="fas fa-spinner fa-spin"></i> Pensando…
           </div>
         </div>`);
      el.scrollTop = el.scrollHeight;

      const citedNow = _citeBuffer.slice();
      try {
        await api(`/library-chats/${_currentChatId}/ask`, {
          method: 'POST',
          body: JSON.stringify({ question, provider: _provider, cited_context: citedNow }),
        });
        // Re-fetch + re-render the whole thread rather than patching the
        // DOM in place — the new pair needs its 📌/🚀/🗑 toolbar wired
        // the same as every other pair, and this keeps that logic in
        // one place (renderThread) instead of duplicated here.
        clearCiteBuffer();
        await openChat(_currentChatId);
        await loadChats();
        renderList();
      } catch (e) {
        $('pv-libchat-pending')?.remove();
        el.insertAdjacentHTML('beforeend', `
          <div style="text-align:center;color:#b91c1c;font-size:12.5px;padding:8px;">
            Error: ${esc(e.message)}
          </div>`);
      } finally {
        sendBtn.disabled = false;
      }
    }

    // ── Delete a Q&A pair ──────────────────────────────────────────────────
    async function deletePair(userMsgId) {
      if (!confirm('¿Borrar esta pregunta y su respuesta? No se puede deshacer.')) return;
      try {
        await api(`/library-chats/${_currentChatId}/messages/${userMsgId}`, { method: 'DELETE' });
        await openChat(_currentChatId);
        await loadChats();
        renderList();
      } catch (e) { alert('Error al borrar: ' + e.message); }
    }

    // ── Fork: re-ask this question as the start of a brand-new chat ────────
    async function forkFromPair(userMsgId) {
      const msg = _currentMessages.find(m => m.id === userMsgId);
      if (!msg) return;
      try {
        const r = await api('/library-chats', { method: 'POST', body: JSON.stringify({ provider: _provider }) });
        await api(`/library-chats/${r.chat_id}/ask`, {
          method: 'POST', body: JSON.stringify({ question: msg.content, provider: _provider }),
        });
        await loadChats();
        await openChat(r.chat_id);
      } catch (e) { alert('Error al iniciar la conversación: ' + e.message); }
    }

    // ── Cite a pair into whatever conversation is active when the next
    // question gets sent (see send()'s cited_context). ─────────────────────
    function citePair(userMsgId, btn) {
      const idx = _currentMessages.findIndex(m => m.id === userMsgId);
      if (idx === -1) return;
      const userMsg = _currentMessages[idx];
      const answerMsg = _currentMessages[idx + 1];
      if (_citeBuffer.some(c => c._mid === userMsgId)) return;   // already added
      _citeBuffer.push({
        _mid: userMsgId,
        question: userMsg.content,
        answer: (answerMsg && answerMsg.role === 'assistant') ? answerMsg.content : '',
        source_title: _currentChatTitle,
      });
      btn.textContent = '✓';
      btn.title = 'Citado — se incluirá en tu próxima pregunta';
      renderCiteStrip();
    }

    function clearCiteBuffer() {
      _citeBuffer = [];
      renderCiteStrip();
    }

    function renderCiteStrip() {
      const strip = $('pv-libchat-cite-strip');
      if (!strip) return;
      if (!_citeBuffer.length) { strip.style.display = 'none'; strip.innerHTML = ''; return; }
      strip.style.display = 'flex';
      strip.innerHTML =
        `<span style="font-size:11px;color:#065f46;font-weight:600;flex-shrink:0;">📌 Citando:</span>` +
        _citeBuffer.map((c, i) => `
          <span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:20px;
                       background:#d1fae5;color:#065f46;font-size:11px;max-width:180px;">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(c.question.slice(0, 40))}</span>
            <span class="pv-cite-strip-remove" data-idx="${i}" style="cursor:pointer;font-weight:700;">×</span>
          </span>`).join('') +
        `<button type="button" id="pv-libchat-cite-clear" style="margin-left:auto;flex-shrink:0;
                 border:none;background:none;color:#9ca3af;font-size:11px;cursor:pointer;">Vaciar</button>`;
      strip.querySelectorAll('.pv-cite-strip-remove').forEach(x => {
        x.addEventListener('click', () => {
          _citeBuffer.splice(parseInt(x.dataset.idx, 10), 1);
          renderCiteStrip();
        });
      });
      strip.querySelector('#pv-libchat-cite-clear')?.addEventListener('click', clearCiteBuffer);
    }

    let _searchTimer = null;
    function wireSearch() {
      $('pv-libchat-search')?.addEventListener('input', (e) => {
        clearTimeout(_searchTimer);
        const q = e.target.value.trim();
        _searchTimer = setTimeout(async () => {
          if (!q) { renderList(); return; }
          try {
            const r = await api('/library-chats/search?q=' + encodeURIComponent(q));
            const el = $('pv-libchat-list');
            const results = r.results || [];
            el.innerHTML = results.length ? results.map(res => `
              <div class="pv-libchat-search-hit" data-id="${esc(res.chat_id)}"
                   style="padding:9px 10px;border-bottom:1px solid #f3f4f6;cursor:pointer;">
                <div style="font-size:12px;font-weight:600;color:#111827;">${esc(res.chat_title)}</div>
                <div style="font-size:11px;color:#6b7280;margin-top:2px;">${esc(res.excerpt)}</div>
              </div>`).join('') : `<div style="padding:16px 10px;text-align:center;color:#9ca3af;font-size:11.5px;">
                Sin resultados.</div>`;
            el.querySelectorAll('.pv-libchat-search-hit').forEach(row => {
              row.addEventListener('click', () => openChat(row.dataset.id));
            });
          } catch (e) { /* silent */ }
        }, 300);
      });
    }

    function wireOnce() {
      if (_wired) return;
      _wired = true;
      const modal = $('pv-libchat-modal');
      $('pv-libchat-close')?.addEventListener('click', close);
      modal.querySelector('.pv-modal-backdrop')?.addEventListener('click', close);
      $('pv-libchat-new')?.addEventListener('click', newChat);
      $('pv-libchat-send')?.addEventListener('click', send);
      $('pv-libchat-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
      });
      document.querySelectorAll('.pv-libchat-provider-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          _provider = btn.dataset.provider;
          localStorage.setItem('pv-libchat-provider', _provider);
          paintProvider();
        });
      });
      wireSearch();
    }

    function close() { $('pv-libchat-modal').style.display = 'none'; _closeCitePopup(); }

    async function open() {
      wireOnce();
      $('pv-libchat-modal').style.display = 'flex';
      paintProvider();
      $('pv-libchat-thread').innerHTML =
        '<div style="text-align:center;color:#9ca3af;padding:30px;">Cargando…</div>';
      try {
        // One request for both the sidebar list AND the target chat's
        // messages — used to be two sequential round trips (list, then
        // fetch), and each network round trip (auth, routing, DB
        // connection) costs real wall-clock time on top of the queries
        // themselves, doubled for no reason.
        const params = _currentChatId ? `?chat_id=${_currentChatId}` : '';
        const view = await api(`/library-chats/open${params}`);
        _chats = view.chats || [];
        if (view.current) {
          _currentChatId = view.current.id;
          _provider = view.current.requested_provider || _provider;
          _currentChatTitle = view.current.title || '';
          paintProvider();
          renderThread(view.current);
        } else {
          _currentChatId = null;
          renderThread(null);
        }
        renderList();
      } catch (e) {
        $('pv-libchat-thread').innerHTML =
          `<div style="text-align:center;color:#b91c1c;padding:30px;">Error: ${esc(e.message)}</div>`;
      }
      setTimeout(() => $('pv-libchat-input')?.focus(), 50);
    }

    return { open };
  })();

  // ── Reference suggestion modal ("Sugerir referencias") ───────────────
  const PVRefSuggest = (() => {
    const $ = id => document.getElementById(id);
    let _wired = false;
    let _mode = 'marked';
    let _provider = localStorage.getItem('pv-refsuggest-provider') || 'anthropic';
    let _style = { color: '#dc2626', bold: false, italic: false, underline: false };
    let _result = null;      // last /ref-suggest response
    let _choice = {};        // n -> {label, title, ...}
    let _moreShown = new Set();

    const PROVIDER_COLORS = { anthropic: '#CC785C', openai: '#10A37F', gemini: '#8b5cf6' };

    function paintMode() {
      document.querySelectorAll('.pv-refsuggest-mode-btn').forEach(b => {
        const active = b.dataset.mode === _mode;
        b.style.border = active ? '2px solid #0F3460' : '1px solid #d1d5db';
        b.style.background = active ? '#eef2ff' : '#fff';
        b.style.color = active ? '#0F3460' : '#374151';
      });
    }
    function paintProvider() {
      document.querySelectorAll('.pv-refsuggest-provider-btn').forEach(b => {
        const active = b.dataset.provider === _provider;
        const color = PROVIDER_COLORS[b.dataset.provider];
        b.style.borderColor = active ? color : '#d1d5db';
        b.style.background  = active ? color + '18' : '#fff';
        b.style.color       = active ? color : '#374151';
      });
    }
    function paintColors() {
      document.querySelectorAll('.pv-refsuggest-color-btn').forEach(b => {
        b.style.borderColor = b.dataset.color === _style.color ? '#111827' : 'transparent';
      });
    }
    function paintStyleToggles() {
      document.querySelectorAll('.pv-refsuggest-style-toggle').forEach(b => {
        const on = !!_style[b.dataset.style];
        b.style.background = on ? '#0F3460' : '#fff';
        b.style.color = on ? '#fff' : '#111827';
        b.style.borderColor = on ? '#0F3460' : '#d1d5db';
      });
    }
    function _styleCss() {
      let css = `color:${_style.color};`;
      if (_style.bold) css += 'font-weight:700;';
      if (_style.italic) css += 'font-style:italic;';
      if (_style.underline) css += 'text-decoration:underline;';
      return css;
    }
    function updateStylePreview() {
      const el = $('pv-refsuggest-style-preview');
      if (el) el.style.cssText = _styleCss() + 'font-size:12.5px;';
    }

    function _citeLabel(cand) {
      if (cand.doi) return `DOI: ${cand.doi}`;
      if (cand.pubmed_id) return `PMID: ${cand.pubmed_id}`;
      return `[${(cand.title || '').slice(0, 40)}]`;
    }

    function _candidateLinksHtml(c) {
      const links = [
        c.has_pdf ? `<a href="${API}/articles/${esc(c.article_id)}/pdf-view" target="_blank" rel="noopener"
              style="color:#b91c1c;text-decoration:none;font-weight:600;"><i class="fas fa-file-pdf"></i> PDF</a>` : '',
        c.has_pdf ? `<a href="${API}/articles/${esc(c.article_id)}/pdf?download=1" download
              title="Descargar el PDF" style="color:#6b7280;text-decoration:none;"><i class="fas fa-download"></i></a>` : '',
        c.doi ? `<a href="https://doi.org/${encodeURIComponent(c.doi)}" target="_blank" rel="noopener"
              style="color:#0F3460;text-decoration:none;">DOI: ${esc(c.doi)}</a>` : '',
        c.pubmed_id ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${esc(c.pubmed_id)}/" target="_blank" rel="noopener"
              style="color:#0F3460;text-decoration:none;">PMID: ${esc(c.pubmed_id)}</a>` : '',
      ].filter(Boolean).join(' &nbsp;·&nbsp; ');
      return links;
    }

    function _quartileBadgeHtml(c) {
      if (!c.quartile) return '';
      const colors = { Q1: '#15803d', Q2: '#1d4ed8', Q3: '#b45309', Q4: '#6b7280' };
      const col = colors[c.quartile] || '#6b7280';
      return `<span title="Cuartil de calidad de la revista (SCImago)"
                    style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:10.5px;
                           font-weight:700;background:${col}1a;color:${col};margin-right:5px;">${esc(c.quartile)}</span>`;
    }
    function _fitScoreBadgeHtml(c) {
      if (c.fit_score == null) return '';
      const col = c.fit_score >= 70 ? '#15803d' : (c.fit_score >= 50 ? '#b45309' : '#6b7280');
      return `<span title="Puntuación de encaje según la IA (0-100)"
                    style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:10.5px;
                           font-weight:700;background:${col}1a;color:${col};margin-right:5px;">${c.fit_score}/100</span>`;
    }

    function _suggestionCardHtml(point, c, idx) {
      const picks = _choice[point.n] || [];
      const chosen = picks.some(x => x.article_id === c.article_id);
      const journalYear = [c.journal, c.year].filter(Boolean).join(' · ');
      return `
        <div class="pv-refsuggest-card" data-n="${point.n}" data-aid="${esc(c.article_id)}"
             style="border:1.5px solid ${chosen ? '#0F3460' : '#e5e7eb'};border-radius:10px;
                    padding:12px 14px;background:${chosen ? '#eef2ff' : '#fff'};">
          <div style="font-size:13px;font-weight:600;color:#111827;line-height:1.35;">
            ${idx + 1}. ${esc(c.title)}
          </div>
          <div style="margin-top:2px;font-size:11.5px;color:#6b7280;">
            ${c.authors ? esc((c.authors || '').split(';')[0].trim()) + (c.authors.includes(';') ? ' et al.' : '') : '—'}
            ${journalYear ? ' · ' + esc(journalYear) : ''}
          </div>
          <div style="margin-top:5px;">${_fitScoreBadgeHtml(c)}${_quartileBadgeHtml(c)}</div>
          <div style="margin-top:4px;font-size:11px;">${_candidateLinksHtml(c)}</div>
          ${c.explanation ? `
          <div style="margin-top:8px;padding:8px 10px;background:#f9fafb;border-radius:7px;
                      font-size:12.5px;color:#374151;line-height:1.5;">
            <i class="fas fa-lightbulb" style="color:#d97706;margin-right:5px;"></i>${esc(c.explanation)}
          </div>` : ''}
          <div style="margin-top:9px;display:flex;align-items:center;gap:8px;">
            <button type="button" class="pv-refsuggest-pick-btn" data-n="${point.n}" data-aid="${esc(c.article_id)}"
                    style="padding:6px 12px;border-radius:7px;border:none;cursor:pointer;font-size:12px;font-weight:600;
                           background:${chosen ? '#b91c1c' : '#0F3460'};color:#fff;">
              ${chosen ? '✕ Quitar' : '✓ Insertar aquí'}
            </button>
            <span style="font-size:11px;color:#9ca3af;">${_citeLabel(c)}</span>
          </div>
        </div>`;
    }

    function _pointHtml(point) {
      const picks = _choice[point.n] || [];
      const chosenLabel = picks.length
        ? `<span style="font-size:11.5px;font-weight:700;color:#15803d;">✓ ${picks.length} insertada${picks.length === 1 ? '' : 's'}</span>`
        : '';
      const claimShort = point.claim.length > 260 ? '…' + point.claim.slice(-260) : point.claim;
      const shown = point.suggestions || [];
      const more = point.more_suggestions || [];
      const moreVisible = _moreShown.has(point.n);
      const total = point.total_candidate_articles || 0;
      const considered = point.candidates_considered || 0;
      const countLine = considered
        ? `<div style="font-size:10.5px;color:#9ca3af;margin:2px 0 6px;">
             ${shown.length + more.length} sugerencia${(shown.length + more.length) === 1 ? '' : 's'} de ${considered}
             candidato${considered === 1 ? '' : 's'} analizado${considered === 1 ? '' : 's'}
             ${total > considered ? ` (hay ${total} artículos relacionados en total en PrionVault; se analizaron los ${considered} más afines)` : ''}
           </div>` : '';
      return `
        <div class="pv-refsuggest-point" data-n="${point.n}">
          <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:2px;">
            <div style="font-size:12.5px;color:#111827;">
              <span style="display:inline-block;padding:1px 7px;border-radius:5px;background:#0F3460;color:#fff;
                           font-size:11px;font-weight:700;margin-right:6px;">${point.n}</span>
              <span class="pv-refsuggest-claim-hover" data-n="${point.n}"
                    style="color:#6b7280;border-bottom:1px dotted #9ca3af;cursor:help;">${esc(claimShort)}</span>
            </div>
            ${chosenLabel}
          </div>
          ${picks.length ? `
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 0 4px;
                      padding:7px 10px;background:#fff;border:1px solid #c7d2fe;border-radius:8px;">
            <span style="font-size:10.5px;font-weight:700;color:#6b7280;text-transform:uppercase;
                         letter-spacing:0.04em;">Sustituye a "Ref" por:</span>
            <span style="font-size:13px;">${_citationHtml(picks)}</span>
            <button type="button" class="pv-refsuggest-copy-cite" data-n="${point.n}"
                    title="Copiar solo esta cita, con el formato elegido, para pegarla sobre &quot;Ref&quot; en tu texto"
                    style="margin-left:auto;padding:4px 10px;border-radius:6px;border:1px solid #c7d2fe;
                           background:#eef2ff;color:#3730a3;font-size:11.5px;font-weight:600;cursor:pointer;">
              <i class="fas fa-copy"></i> Copiar cita
            </button>
          </div>` : ''}
          ${countLine}
          ${shown.length ? `
          <div style="display:flex;flex-direction:column;gap:8px;">
            ${shown.map((c, i) => _suggestionCardHtml(point, c, i)).join('')}
            ${more.length ? `
              <button type="button" class="pv-refsuggest-more-btn" data-n="${point.n}"
                      style="align-self:flex-start;padding:5px 10px;border-radius:7px;border:1px dashed #d1d5db;
                             background:#fff;color:#6b7280;font-size:11.5px;cursor:pointer;">
                ${moreVisible ? 'Ocultar' : `Ver ${more.length} más`}
              </button>
              ${moreVisible ? `<div style="display:flex;flex-direction:column;gap:8px;">
                ${more.map((c, i) => _suggestionCardHtml(point, c, shown.length + i)).join('')}
              </div>` : ''}
            ` : ''}
          </div>` : `
          <div style="font-size:12px;color:#6b7280;padding:10px 12px;background:#f9fafb;
                      border:1px dashed #e5e7eb;border-radius:8px;line-height:1.5;">
            <i class="fas fa-circle-info" style="color:#9ca3af;margin-right:5px;"></i>
            ${esc(point.diagnostic || 'No he encontrado ninguna referencia de PrionVault que encaje bien aquí.')}
          </div>`}
        </div>`;
    }

    // ── Hover popup showing full surrounding context for a point's claim ──
    let _hoverPopup = null;
    function _ensureHoverPopup() {
      if (_hoverPopup) return _hoverPopup;
      _hoverPopup = document.createElement('div');
      _hoverPopup.style.cssText = `position:fixed;z-index:10000;max-width:420px;display:none;
        background:#111827;color:#f3f4f6;font-size:12px;line-height:1.5;padding:10px 12px;
        border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.3);pointer-events:none;`;
      document.body.appendChild(_hoverPopup);
      return _hoverPopup;
    }
    function _wireClaimHover() {
      document.querySelectorAll('.pv-refsuggest-claim-hover').forEach(el => {
        el.addEventListener('mouseenter', e => {
          const n = parseInt(el.dataset.n, 10);
          const point = _result?.points.find(p => p.n === n);
          if (!point) return;
          const popup = _ensureHoverPopup();
          popup.innerHTML = `${esc(point.context?.before || '')}` +
            `<mark style="background:#facc15;color:#111827;padding:0 2px;">${esc(point.claim.slice(-260))}</mark>` +
            `${esc(point.context?.after || '')}`;
          popup.style.display = 'block';
          const rect = el.getBoundingClientRect();
          const top = Math.max(8, rect.top - 10);
          popup.style.left = Math.min(rect.left, window.innerWidth - 440) + 'px';
          popup.style.top = (top > 200 ? top - popup.offsetHeight - 10 : rect.bottom + 10) + 'px';
        });
        el.addEventListener('mouseleave', () => { if (_hoverPopup) _hoverPopup.style.display = 'none'; });
      });
    }

    function renderPoints() {
      const box = $('pv-refsuggest-points');
      if (!box || !_result) return;
      box.innerHTML = _result.points.map(_pointHtml).join('');
      box.querySelectorAll('.pv-refsuggest-pick-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const n = parseInt(btn.dataset.n, 10);
          const point = _result.points.find(p => p.n === n);
          const all = [...(point.suggestions || []), ...(point.more_suggestions || [])];
          const cand = all.find(c => c.article_id === btn.dataset.aid);
          if (!cand) return;
          const picks = _choice[n] || (_choice[n] = []);
          const idx = picks.findIndex(x => x.article_id === cand.article_id);
          if (idx >= 0) {
            picks.splice(idx, 1);
            if (!picks.length) delete _choice[n];
          } else {
            picks.push({ article_id: cand.article_id, title: cand.title, label: _citeLabel(cand) });
          }
          renderPoints();
          renderPreview();
        });
      });
      box.querySelectorAll('.pv-refsuggest-copy-cite').forEach(btn => {
        btn.addEventListener('click', async () => {
          const picks = _choice[parseInt(btn.dataset.n, 10)] || [];
          if (!picks.length) return;
          try {
            await _copyRich(_citationHtml(picks), _citationText(picks));
            _flashCopied(btn, 'Copiada');
          } catch (e) { alert('No se pudo copiar: ' + e.message); }
        });
      });
      box.querySelectorAll('.pv-refsuggest-more-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const n = parseInt(btn.dataset.n, 10);
          if (_moreShown.has(n)) _moreShown.delete(n); else _moreShown.add(n);
          renderPoints();
        });
      });
      _wireClaimHover();
    }

    function _assembleFinal() {
      if (!_result) return { text: '', html: '' };
      const base = _result.text;
      // A point can now have MULTIPLE chosen references — join their
      // labels so inserting several at once is just as easy as one.
      const chosen = _result.points
        .filter(p => _choice[p.n] && _choice[p.n].length)
        .map(p => ({
          start: p.replace_start, end: p.replace_end,
          picks: _choice[p.n],
          label: _citationText(_choice[p.n]),
        }));
      // HTML: walk forward, ascending by start.
      const asc = [...chosen].sort((a, b) => a.start - b.start);
      let html = '';
      let cursor = 0;
      for (const s of asc) {
        html += esc(base.slice(cursor, s.start)).replace(/\n/g, '<br>');
        html += _citationHtml(s.picks);
        cursor = s.end;
      }
      html += esc(base.slice(cursor)).replace(/\n/g, '<br>');
      // Plain text: splice descending so earlier offsets stay valid.
      let text = base;
      for (const s of [...chosen].sort((a, b) => b.start - a.start)) {
        text = text.slice(0, s.start) + s.label + text.slice(s.end);
      }
      return { text, html };
    }

    function _refreshStyled() {
      if (_result) { renderPoints(); renderPreview(); }
    }

    function renderPreview() {
      const box = $('pv-refsuggest-preview');
      if (!box) return;
      const { html } = _assembleFinal();
      box.innerHTML = html || '<span style="color:#9ca3af;">El texto con las referencias insertadas aparecerá aquí a medida que las elijas.</span>';
    }

    // Copies RICH text (keeps color/bold/italic/underline) in a way
    // Word, Google Docs and Gmail all honour. A bare HTML fragment
    // written via ClipboardItem was losing the color in some paste
    // targets; copying an actually-rendered selection makes the browser
    // build the clipboard HTML itself (computed styles included), which
    // is what those apps read. ClipboardItem stays as a fallback.
    async function _copyRich(html, text) {
      const holder = document.createElement('div');
      holder.setAttribute('contenteditable', 'true');
      holder.style.cssText = 'position:fixed;left:-9999px;top:0;white-space:pre-wrap;' +
        'font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#000;background:#fff;';
      holder.innerHTML = html;
      document.body.appendChild(holder);
      let ok = false;
      try {
        const range = document.createRange();
        range.selectNodeContents(holder);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        ok = document.execCommand('copy');
        sel.removeAllRanges();
      } catch (e) { ok = false; }
      holder.remove();
      if (ok) return;
      const doc = `<html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html':  new Blob([doc], { type: 'text/html' }),
        })]);
      } else {
        await navigator.clipboard.writeText(text);
      }
    }

    function _flashCopied(btn, label) {
      if (!btn) return;
      const orig = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-check"></i>' + (label ? ' ' + label : '');
      setTimeout(() => { btn.innerHTML = orig; }, 1500);
    }

    // The citation exactly as it will appear in the text: always in
    // parentheses, several references joined with "; ".
    function _citationText(picks) {
      return '(' + picks.map(c => c.label).join('; ') + ')';
    }
    function _citationHtml(picks) {
      const st = _styleCss();
      const fontOpen = `<font color="${_style.color}">`;
      return `${fontOpen}<span style="${st}">${esc(_citationText(picks))}</span></font>`;
    }

    async function copyFinal() {
      const { text, html } = _assembleFinal();
      try {
        await _copyRich(html, text);
        _flashCopied($('pv-refsuggest-copy'), 'Copiado');
      } catch (e) {
        alert('No se pudo copiar: ' + e.message);
      }
    }

    function showInput() {
      $('pv-refsuggest-input').style.display = 'flex';
      $('pv-refsuggest-results').style.display = 'none';
    }
    function showResults() {
      $('pv-refsuggest-input').style.display = 'none';
      $('pv-refsuggest-results').style.display = 'flex';
    }

    async function go() {
      const textarea = $('pv-refsuggest-textarea');
      const text = (textarea?.value || '').trim();
      const status = $('pv-refsuggest-status');
      const btn = $('pv-refsuggest-go');
      if (!text) { if (status) { status.style.color = '#b91c1c'; status.textContent = 'Pega un texto primero.'; } return; }
      btn.disabled = true;
      if (status) { status.style.color = '#6b7280'; status.textContent = 'Analizando — esto puede tardar unos segundos…'; }
      try {
        const r = await api('/ref-suggest', {
          method: 'POST',
          body: JSON.stringify({ text, mode: _mode, provider: _provider }),
        });
        _result = r;
        _choice = {};
        _moreShown = new Set();
        renderPoints();
        renderPreview();
        showResults();
      } catch (e) {
        if (status) { status.style.color = '#b91c1c'; status.textContent = 'Error: ' + e.message; }
      } finally {
        btn.disabled = false;
        if (status && status.textContent.startsWith('Analizando')) status.textContent = '';
      }
    }

    function toggleExpand() {
      const ta = $('pv-refsuggest-textarea');
      if (!ta) return;
      if (ta.style.height && ta.style.height !== '') {
        ta.style.height = '';
        ta.rows = 7;
      } else {
        ta.style.height = Math.min(ta.scrollHeight + 4, 600) + 'px';
      }
    }

    function wireOnce() {
      if (_wired) return;
      _wired = true;
      $('pv-refsuggest-close')?.addEventListener('click', close);
      document.querySelector('#pv-refsuggest-modal .pv-modal-backdrop')?.addEventListener('click', close);
      document.querySelectorAll('.pv-refsuggest-mode-btn').forEach(b => {
        b.addEventListener('click', () => { _mode = b.dataset.mode; paintMode(); });
      });
      document.querySelectorAll('.pv-refsuggest-provider-btn').forEach(b => {
        b.addEventListener('click', () => {
          _provider = b.dataset.provider;
          localStorage.setItem('pv-refsuggest-provider', _provider);
          paintProvider();
        });
      });
      document.querySelectorAll('.pv-refsuggest-color-btn').forEach(b => {
        b.addEventListener('click', () => { _style.color = b.dataset.color; paintColors(); updateStylePreview(); _refreshStyled(); });
      });
      $('pv-refsuggest-color-custom')?.addEventListener('input', e => {
        _style.color = e.target.value; paintColors(); updateStylePreview(); _refreshStyled();
      });
      document.querySelectorAll('.pv-refsuggest-style-toggle').forEach(b => {
        b.addEventListener('click', () => {
          _style[b.dataset.style] = !_style[b.dataset.style];
          paintStyleToggles(); updateStylePreview(); _refreshStyled();
        });
      });
      $('pv-refsuggest-expand')?.addEventListener('click', toggleExpand);
      $('pv-refsuggest-go')?.addEventListener('click', go);
      $('pv-refsuggest-back')?.addEventListener('click', showInput);
      $('pv-refsuggest-copy')?.addEventListener('click', copyFinal);
      $('pv-refsuggest-preview-expand')?.addEventListener('click', () => {
        const box = $('pv-refsuggest-preview');
        const btn = $('pv-refsuggest-preview-expand');
        const expanded = box.style.maxHeight === 'none';
        box.style.maxHeight = expanded ? '110px' : 'none';
        btn.innerHTML = expanded ? '<i class="fas fa-expand"></i>' : '<i class="fas fa-compress"></i>';
        btn.title = expanded ? 'Mostrar todo el texto' : 'Reducir';
      });
      paintMode(); paintProvider(); paintColors(); paintStyleToggles(); updateStylePreview();
    }

    function close() { $('pv-refsuggest-modal').style.display = 'none'; }

    function open() {
      wireOnce();
      $('pv-refsuggest-modal').style.display = 'flex';
      showInput();
    }

    return { open };
  })();

