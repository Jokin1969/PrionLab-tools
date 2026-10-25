  // ── Notifications / Email Digest Modal ────────────────────────────────────
  async function _notifApi(path, opts = {}) {
    const r = await fetch('/prionvault/api' + path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (!r.ok) { const t = await r.text(); throw new Error(t || r.statusText); }
    return r.json();
  }

  // ── Timezones cache ───────────────────────────────────────────────────────
  let _tzOptions = null;
  async function _loadTzOptions() {
    if (_tzOptions) return _tzOptions;
    try {
      _tzOptions = await _notifApi('/notifications/timezones');
    } catch (_) {
      _tzOptions = ['UTC','Europe/Madrid','Europe/London','America/New_York','Asia/Tokyo'];
    }
    return _tzOptions;
  }

  document.addEventListener('DOMContentLoaded', function initNotificationsModal() {
    const modal    = document.getElementById('pv-notifications-modal');
    const openBtn  = document.getElementById('btn-notifications');
    if (!modal || !openBtn) return;

    const closeBtn  = document.getElementById('pv-notif-close');
    const addBtn    = document.getElementById('pv-notif-add');
    const tableWrap = document.getElementById('pv-notif-table-wrap');
    const statusEl  = document.getElementById('pv-notif-status');
    const backdrop  = modal.querySelector('.pv-modal-backdrop');

    const TOPICS = {
      prion:      { label: 'Prion',             color: '#0F3460', bg: '#e0e7ff' },
      prion_like: { label: 'Prion-like',         color: '#7c3aed', bg: '#ede9fe' },
      aav:        { label: 'AAV / Gene therapy', color: '#065f46', bg: '#d1fae5' },
    };
    const FREQ_LABELS = { weekly: 'Semanal', biweekly: 'Quincenal', monthly: 'Mensual' };
    const DOW_LABELS  = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];

    function _showStatus(type, msg, autohide = true) {
      statusEl.innerHTML = msg;
      statusEl.style.display = 'block';
      const info = type === 'info';
      statusEl.style.background = info ? '#eff6ff' : type === 'ok' ? '#f0fdf4' : '#fef2f2';
      statusEl.style.color      = info ? '#1d4ed8' : type === 'ok' ? '#15803d' : '#b91c1c';
      statusEl.style.border     = `1px solid ${info ? '#bfdbfe' : type === 'ok' ? '#bbf7d0' : '#fecaca'}`;
      if (autohide && !info) setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
    }

    function _editFormHtml(sub, tzOptions) {
      const h = String(sub.send_hour  ?? 15).padStart(2,'0');
      const m = String(sub.send_minute ?? 0).padStart(2,'0');
      const tzOpts = tzOptions.map(z =>
        `<option value="${z}"${z === (sub.user_timezone||'UTC') ? ' selected' : ''}>${z.replace(/_/g,' ')}</option>`
      ).join('');
      const topicChips = Object.entries(TOPICS).map(([k, info]) => {
        const on = (sub.topics || ['prion']).includes(k);
        return `<label style="display:inline-flex;align-items:center;gap:5px;padding:4px 11px;
          border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;
          border:2px solid ${on ? info.color : '#d1d5db'};
          background:${on ? info.bg : '#fff'};color:${on ? info.color : '#9ca3af'};">
          <input type="checkbox" name="topic" value="${k}" ${on ? 'checked' : ''}
                 style="display:none;">
          ${info.label}
        </label>`;
      }).join('');
      const isPubmed = (sub.source || 'pubmed') === 'pubmed';
      return `
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;
                  padding:16px;margin-top:4px;display:flex;flex-direction:column;gap:14px;">
        <div style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end;">
          <div>
            <label style="font-size:11px;font-weight:600;color:#6b7280;display:block;margin-bottom:3px;">NOMBRE</label>
            <input name="name" value="${(sub.name||'Mi suscripción').replace(/"/g,'&quot;')}"
                   style="width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid #d1d5db;
                          border-radius:7px;font-size:13px;">
          </div>
          <div>
            <label style="font-size:11px;font-weight:600;color:#6b7280;display:block;margin-bottom:3px;">TIPO</label>
            <select name="source" style="padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;">
              <option value="pubmed" ${isPubmed ? 'selected' : ''}>📡 PubMed digest</option>
              <option value="flagged" ${!isPubmed ? 'selected' : ''}>⚑ PrionVault Picks</option>
            </select>
          </div>
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;color:#6b7280;display:block;margin-bottom:3px;">EMAIL</label>
          <input type="email" name="email" value="${(sub.email||'').replace(/"/g,'&quot;')}"
                 style="width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid #d1d5db;
                        border-radius:7px;font-size:13px;">
        </div>
        <div class="pv-pubmed-fields" style="display:${isPubmed ? 'flex' : 'none'};flex-direction:column;gap:12px;">
          <div>
            <label style="font-size:11px;font-weight:600;color:#6b7280;display:block;margin-bottom:5px;">TEMAS</label>
            <div style="display:flex;flex-wrap:wrap;gap:6px;">${topicChips}</div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <div>
              <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:3px;">Período de búsqueda</label>
              <select name="lookback_days" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;">
                <option value="7" ${(sub.lookback_days||7)==7?'selected':''}>7 días</option>
                <option value="14" ${sub.lookback_days==14?'selected':''}>14 días</option>
                <option value="30" ${sub.lookback_days==30?'selected':''}>30 días</option>
              </select>
            </div>
            <div style="display:flex;align-items:center;gap:8px;padding-top:18px;">
              <input type="checkbox" name="include_oa_only" ${sub.include_oa_only?'checked':''}
                     style="width:15px;height:15px;accent-color:#0F3460;">
              <label style="font-size:12.5px;color:#374151;cursor:pointer;">Solo Open Access</label>
            </div>
          </div>
        </div>
        <div class="pv-flagged-fields" style="display:${!isPubmed ? 'flex' : 'none'};flex-direction:column;gap:10px;">
          <div>
            <label style="font-size:11px;font-weight:600;color:#6b7280;display:block;margin-bottom:3px;">ARTÍCULOS POR EMAIL</label>
            <input type="number" name="articles_per_email" min="1" max="50"
                   value="${sub.articles_per_email || 5}"
                   style="width:80px;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;">
            <span style="font-size:12px;color:#6b7280;margin-left:6px;">artículos aleatorios por email</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <input type="checkbox" name="include_pdfs" ${sub.include_pdfs !== false ? 'checked' : ''}
                   style="width:15px;height:15px;accent-color:#0F3460;">
            <label style="font-size:12.5px;color:#374151;cursor:pointer;">Adjuntar PDFs al email</label>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <input type="checkbox" name="include_ai_summary" ${sub.include_ai_summary !== false ? 'checked' : ''}
                   style="width:15px;height:15px;accent-color:#0F3460;">
            <label style="font-size:12.5px;color:#374151;cursor:pointer;">Enviar el resumen IA en el email
              <span style="color:#9ca3af;">(si el artículo lo tiene)</span></label>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div>
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:3px;">Frecuencia</label>
            <select name="frequency" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;">
              <option value="weekly"   ${(sub.frequency||'weekly')==='weekly'?'selected':''}>Semanal</option>
              <option value="biweekly" ${sub.frequency==='biweekly'?'selected':''}>Quincenal</option>
              <option value="monthly"  ${sub.frequency==='monthly'?'selected':''}>Mensual</option>
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:3px;">Hora</label>
            <input type="time" name="time" value="${h}:${m}"
                   style="width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;">
          </div>
        </div>
        <div>
          <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:5px;">Días</label>
          <div style="display:flex;gap:5px;flex-wrap:wrap;">
            ${DOW_LABELS.map((d,i)=>{
              const activeDays = Array.isArray(sub.days_of_week) ? sub.days_of_week
                : [sub.day_of_week ?? 4];
              const chk = activeDays.includes(i) ? 'checked' : '';
              return `<label style="display:flex;align-items:center;gap:3px;padding:5px 9px;border:1px solid #d1d5db;border-radius:20px;font-size:12px;cursor:pointer;user-select:none;">
                <input type="checkbox" name="days_of_week" value="${i}" ${chk} style="accent-color:#0F3460;">${d}
              </label>`;
            }).join('')}
          </div>
        </div>
        <div>
          <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:3px;">Zona horaria</label>
          <select name="user_timezone" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;">${tzOpts}</select>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px;">
          <button type="button" class="pv-notif-save-btn"
                  style="padding:7px 18px;border-radius:7px;border:none;background:#0F3460;
                         color:#fff;font-size:13px;font-weight:700;cursor:pointer;">
            <i class="fas fa-save" style="margin-right:5px;"></i>Guardar
          </button>
          <button type="button" class="pv-notif-test-btn"
                  style="padding:7px 14px;border-radius:7px;border:1px solid #d1d5db;
                         background:#f9fafb;color:#374151;font-size:13px;cursor:pointer;">
            <i class="fas fa-paper-plane"></i> Prueba
          </button>
          <button type="button" class="pv-notif-preview-btn"
                  style="padding:7px 14px;border-radius:7px;border:1px solid #d1d5db;
                         background:#f9fafb;color:#374151;font-size:13px;cursor:pointer;"
                  title="Ver qué artículos se enviarían sin mandar el email">
            <i class="fas fa-search"></i> Diagnóstico
          </button>
          <button type="button" class="pv-notif-cancel-edit-btn"
                  style="margin-left:auto;padding:7px 14px;border-radius:7px;border:1px solid #d1d5db;
                         background:#fff;color:#374151;font-size:13px;cursor:pointer;">
            Cancelar
          </button>
        </div>
      </div>`;
    }

    function _readForm(formEl) {
      const _val = (sel, def = '') => (formEl.querySelector(sel) || { value: def }).value;
      const _chk = (sel, def = false) => formEl.querySelector(sel) ? formEl.querySelector(sel).checked : def;
      const topics = [...formEl.querySelectorAll('input[name="topic"]:checked')].map(c => c.value);
      const [hh, mm] = (_val('[name="time"]', '15:00') || '15:00').split(':');
      return {
        name:               _val('[name="name"]') .trim() || 'Mi suscripción',
        source:             _val('[name="source"]'),
        email:              _val('[name="email"]').trim(),
        topics:             topics.length ? topics : ['prion'],
        frequency:          _val('[name="frequency"]', 'weekly'),
        days_of_week:       (d => d.length ? d : [4])(Array.from(formEl.querySelectorAll('[name="days_of_week"]:checked')).map(cb=>parseInt(cb.value))),
        send_hour:          parseInt(hh || 15),
        send_minute:        parseInt(mm || 0),
        user_timezone:      _val('[name="user_timezone"]', 'UTC'),
        lookback_days:      parseInt(_val('[name="lookback_days"]', '7')),
        include_oa_only:    _chk('[name="include_oa_only"]'),
        articles_per_email: parseInt(_val('[name="articles_per_email"]', '5') || 5),
        include_pdfs:       _chk('[name="include_pdfs"]', true),
        include_ai_summary: _chk('[name="include_ai_summary"]', true),
        enabled:            true,
      };
    }

    let _expandedId = null, _lastSubs = [], _lastTz = [];

    function _renderTable(subs, tzOptions) {
      if (!subs.length) {
        tableWrap.innerHTML = `<p style="text-align:center;color:#9ca3af;font-size:13px;padding:24px 0;">
          No tienes suscripciones. Crea una nueva abajo.</p>`;
        return;
      }
      const rows = subs.map(sub => {
        const srcChip = sub.source === 'flagged'
          ? `<span style="background:#fef3c7;color:#92400e;font-size:11px;font-weight:600;padding:2px 7px;border-radius:20px;">⚑ Picks</span>`
          : `<span style="background:#e0e7ff;color:#0F3460;font-size:11px;font-weight:600;padding:2px 7px;border-radius:20px;">📡 PubMed</span>`;
        const freqTxt = FREQ_LABELS[sub.frequency] || sub.frequency;
        const DOW_SHORT = ['L','M','X','J','V','S','D'];
        const activeDays = Array.isArray(sub.days_of_week) && sub.days_of_week.length
          ? sub.days_of_week : [sub.day_of_week ?? 4];
        const dow = activeDays.map(d => DOW_SHORT[d] ?? d).join(' ');
        const nextTxt = !sub.enabled
          ? '<span style="color:#92400e;font-weight:600;">⏸ Pausada</span>'
          : (sub.next_send_at
              ? new Date(sub.next_send_at).toLocaleDateString('es-ES',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})
              : '—');
        const dot = sub.enabled
          ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#16a34a;vertical-align:middle;margin-right:4px;"></span>`
          : `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#d1d5db;vertical-align:middle;margin-right:4px;"></span>`;
        const isOpen = _expandedId === sub.id;
        const editFormHtml = isOpen ? _editFormHtml(sub, tzOptions) : '';
        return `
        <tr data-sub-id="${sub.id}" style="border-bottom:1px solid #f3f4f6;">
          <td style="padding:10px 8px;font-size:13px;font-weight:600;color:#111827;max-width:160px;
                     white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${dot}${esc(sub.name || 'Sin nombre')}
          </td>
          <td style="padding:10px 6px;">${srcChip}</td>
          <td style="padding:10px 6px;font-size:12px;color:#6b7280;">${freqTxt} · ${dow}</td>
          <td style="padding:10px 6px;font-size:12px;color:#6b7280;">${nextTxt}</td>
          <td style="padding:10px 6px;white-space:nowrap;">
            <button class="pv-toggle-btn" data-id="${sub.id}" data-enabled="${sub.enabled ? '1' : '0'}"
                    title="${sub.enabled ? 'Pausar estas notificaciones (indefinidamente)' : 'Reanudar estas notificaciones'}"
                    style="padding:4px 10px;border-radius:6px;border:1px solid ${sub.enabled ? '#fde68a' : '#bbf7d0'};
                           background:${sub.enabled ? '#fffbeb' : '#f0fdf4'};color:${sub.enabled ? '#92400e' : '#15803d'};
                           font-size:12px;cursor:pointer;margin-right:4px;">
              <i class="fas fa-${sub.enabled ? 'pause' : 'play'}"></i>
            </button>
            <button class="pv-edit-btn" data-id="${sub.id}"
                    style="padding:4px 10px;border-radius:6px;border:1px solid #d1d5db;
                           background:${isOpen ? '#e0e7ff' : '#fff'};font-size:12px;cursor:pointer;margin-right:4px;">
              <i class="fas fa-pen"></i>
            </button>
            <button class="pv-del-btn" data-id="${sub.id}"
                    style="padding:4px 10px;border-radius:6px;border:1px solid #fecaca;
                           background:#fff;font-size:12px;cursor:pointer;color:#b91c1c;">
              <i class="fas fa-trash"></i>
            </button>
          </td>
        </tr>
        ${isOpen ? `<tr data-edit-row="${sub.id}"><td colspan="5">${editFormHtml}</td></tr>` : ''}`;
      }).join('');

      tableWrap.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid #e5e7eb;">
              <th style="text-align:left;padding:6px 8px;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;">Nombre</th>
              <th style="text-align:left;padding:6px 6px;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;">Tipo</th>
              <th style="text-align:left;padding:6px 6px;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;">Frecuencia</th>
              <th style="text-align:left;padding:6px 6px;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;">Próximo envío</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;

      tableWrap.querySelectorAll('.pv-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          _expandedId = _expandedId === btn.dataset.id ? null : btn.dataset.id;
          _renderTable(_lastSubs, _lastTz);
        });
      });
      tableWrap.querySelectorAll('.pv-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => _toggleSub(btn.dataset.id, btn.dataset.enabled !== '1'));
      });
      tableWrap.querySelectorAll('.pv-del-btn').forEach(btn => {
        btn.addEventListener('click', () => _deleteSub(btn.dataset.id));
      });
      tableWrap.querySelectorAll('.pv-notif-save-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const editRow = btn.closest('[data-edit-row]');
          if (editRow) _saveEdit(editRow.dataset.editRow, btn.closest('div[style*="flex-direction:column"]'));
        });
      });
      tableWrap.querySelectorAll('.pv-notif-test-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const editRow = btn.closest('[data-edit-row]');
          if (editRow) _testSub(editRow.dataset.editRow, btn);
        });
      });
      tableWrap.querySelectorAll('.pv-notif-preview-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const editRow = btn.closest('[data-edit-row]');
          if (editRow) _previewSub(editRow.dataset.editRow, btn);
        });
      });
      tableWrap.querySelectorAll('.pv-notif-cancel-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => { _expandedId = null; _renderTable(_lastSubs, _lastTz); });
      });
      tableWrap.querySelectorAll('[name="source"]').forEach(sel => {
        sel.addEventListener('change', function() {
          const wrap = this.closest('div[style*="flex-direction:column"]');
          if (!wrap) return;
          const pf = wrap.querySelector('.pv-pubmed-fields');
          const ff = wrap.querySelector('.pv-flagged-fields');
          const isPubmed = this.value === 'pubmed';
          if (pf) pf.style.display = isPubmed ? 'flex' : 'none';
          if (ff) ff.style.display = isPubmed ? 'none' : 'block';
        });
      });
      tableWrap.querySelectorAll('input[name="topic"]').forEach(cb => {
        cb.addEventListener('change', () => {
          const lbl = cb.closest('label');
          const info = TOPICS[cb.value];
          if (!info || !lbl) return;
          const on = cb.checked;
          lbl.style.borderColor = on ? info.color : '#d1d5db';
          lbl.style.background  = on ? info.bg    : '#fff';
          lbl.style.color       = on ? info.color : '#9ca3af';
        });
      });
    }

    async function _saveEdit(subId, formEl) {
      if (!formEl) return;
      const data = _readForm(formEl);
      // Preserve the paused/active state across edits — the pause toggle owns
      // it, so editing other settings must not silently re-enable a paused sub.
      const _cur = (_lastSubs || []).find(s => String(s.id) === String(subId));
      if (_cur) data.enabled = _cur.enabled !== false;
      const saveBtn = formEl.querySelector('.pv-notif-save-btn');
      if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
      try {
        await _notifApi(`/notifications/subscriptions/${subId}`, { method: 'PUT', body: JSON.stringify(data) });
        _showStatus('ok', '✓ Guardado.');
        _expandedId = null;
        await _loadAll();
      } catch (e) {
        _showStatus('error', 'Error al guardar: ' + e.message);
        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-save" style="margin-right:5px;"></i>Guardar'; }
      }
    }

    async function _toggleSub(subId, enable) {
      try {
        await _notifApi(`/notifications/subscriptions/${subId}/enabled`,
                        { method: 'POST', body: JSON.stringify({ enabled: enable }) });
        _showStatus('ok', enable ? '✓ Notificaciones reanudadas.' : '⏸ Notificaciones pausadas.');
        await _loadAll();
      } catch (e) {
        _showStatus('error', 'Error al cambiar el estado: ' + e.message);
      }
    }

    async function _deleteSub(subId) {
      if (!confirm('¿Eliminar esta suscripción?')) return;
      try {
        await _notifApi(`/notifications/subscriptions/${subId}`, { method: 'DELETE' });
        _showStatus('ok', '✓ Eliminada.');
        if (_expandedId === subId) _expandedId = null;
        await _loadAll();
      } catch (e) {
        _showStatus('error', 'Error al eliminar: ' + e.message);
      }
    }

    async function _testSub(subId, btn) {
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
      try {
        const r = await _notifApi(`/notifications/subscriptions/${subId}/test`, { method: 'POST' });
        _showStatus('ok', '✓ ' + (r.detail || 'Email de prueba enviado.'));
      } catch (e) {
        _showStatus('error', 'Error: ' + e.message);
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Prueba'; }
      }
    }

    async function _previewSub(subId, btn) {
      const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Consultando…'; }

      // Remove any existing preview panel in the same edit row
      const editRow = btn?.closest('[data-edit-row]');
      editRow?.querySelector('.pv-notif-preview-panel')?.remove();

      try {
        const d = await _notifApi(`/notifications/subscriptions/${subId}/preview`);
        const panelEl = document.createElement('div');
        panelEl.className = 'pv-notif-preview-panel';
        panelEl.style.cssText = 'margin-top:12px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:14px;font-size:12.5px;';

        const fmtDate = iso => iso ? new Date(iso).toLocaleString('es-ES', {day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';

        let html = '';
        if (d.source === 'pubmed') {
          const topicLabels = { prion:'Prion', prion_like:'Prion-like', aav:'AAV / Gene therapy' };
          const topics = (d.topics || []).map(t => topicLabels[t] || t).join(', ');
          const oaWarn = d.oa_only && d.count === 0 && d.count_without_oa_filter > 0
            ? `<div style="margin-top:6px;padding:6px 10px;background:#fef3c7;border-radius:6px;color:#92400e;">
                ⚠ Hay <strong>${d.count_without_oa_filter}</strong> artículos si se desactiva el filtro "Solo OA". Están ocultos porque la suscripción tiene activado <em>Solo Open Access</em>.
               </div>` : '';

          html = `
            <div style="font-weight:700;color:#0369a1;margin-bottom:10px;">
              🔍 Diagnóstico del digest — simulación sin enviar email
            </div>
            <table style="border-collapse:collapse;width:100%;font-size:12px;">
              <tr><td style="color:#6b7280;padding:2px 8px 2px 0;white-space:nowrap;">Temas</td><td><strong>${esc(topics)}</strong></td></tr>
              <tr><td style="color:#6b7280;padding:2px 8px 2px 0;">Período</td><td>${fmtDate(d.since)} → ${fmtDate(d.now)}</td></tr>
              <tr><td style="color:#6b7280;padding:2px 8px 2px 0;">Solo OA</td><td>${d.oa_only ? '✓ Sí' : 'No'}</td></tr>
              <tr><td style="color:#6b7280;padding:2px 8px 2px 0;">Último envío</td><td>${fmtDate(d.last_sent_at)}</td></tr>
              <tr><td style="color:#6b7280;padding:2px 8px 2px 0;">Próximo envío</td><td>${fmtDate(d.next_send_at)}</td></tr>
            </table>
            <div style="margin-top:10px;padding:8px 12px;border-radius:6px;font-weight:700;
                        background:${d.count > 0 ? '#dcfce7' : '#fef2f2'};
                        color:${d.count > 0 ? '#15803d' : '#b91c1c'};">
              ${d.count > 0
                ? `✓ Se enviarían <strong>${d.count} artículo${d.count !== 1 ? 's' : ''}</strong>`
                : '✗ No hay artículos nuevos para este período con los filtros actuales'}
            </div>
            ${oaWarn}`;

          if (d.articles && d.articles.length > 0) {
            html += `<div style="margin-top:10px;"><div style="font-weight:600;color:#374151;margin-bottom:6px;">Artículos (hasta 20):</div>`;
            d.articles.forEach((a, i) => {
              const topic = topicLabels[a.topic] || a.topic || '';
              html += `<div style="padding:6px 0;border-bottom:1px solid #e0f2fe;display:flex;gap:8px;align-items:baseline;">
                <span style="min-width:20px;color:#94a3b8;font-size:11px;">${i+1}.</span>
                <span>
                  <span style="font-weight:600;color:#1e293b;">${esc(a.title || '—')}</span>
                  <span style="color:#64748b;"> · ${a.year || '—'} · ${esc(a.journal || '—')}</span>
                  ${a.doi ? `<a href="https://doi.org/${esc(a.doi)}" target="_blank" style="color:#0F3460;margin-left:6px;">DOI ↗</a>` : ''}
                  ${a.oa ? '<span style="margin-left:6px;font-size:10px;background:#d1fae5;color:#065f46;padding:1px 5px;border-radius:10px;">OA</span>' : ''}
                  ${topic ? `<span style="margin-left:4px;font-size:10px;background:#eff6ff;color:#1e40af;padding:1px 5px;border-radius:10px;">${esc(topic)}</span>` : ''}
                </span>
              </div>`;
            });
            html += '</div>';
          }
        } else {
          // flagged / Picks
          html = `
            <div style="font-weight:700;color:#0369a1;margin-bottom:10px;">
              🔍 Diagnóstico PrionVault Picks — simulación sin enviar email
            </div>
            <div style="padding:8px 12px;border-radius:6px;font-weight:700;
                        background:${d.count > 0 ? '#dcfce7' : '#fef2f2'};
                        color:${d.count > 0 ? '#15803d' : '#b91c1c'};">
              ${d.count > 0
                ? `✓ <strong>${d.count} artículo${d.count !== 1 ? 's' : ''}</strong> marcado${d.count !== 1 ? 's' : ''} se enviarían`
                : '✗ No hay artículos marcados con ⚑ en la biblioteca'}
            </div>`;
          if (d.articles && d.articles.length > 0) {
            html += `<div style="margin-top:10px;"><div style="font-weight:600;color:#374151;margin-bottom:6px;">Artículos seleccionados:</div>`;
            d.articles.forEach((a, i) => {
              html += `<div style="padding:6px 0;border-bottom:1px solid #e0f2fe;display:flex;gap:8px;align-items:baseline;">
                <span style="min-width:20px;color:#94a3b8;font-size:11px;">${i+1}.</span>
                <span>
                  <span style="font-weight:600;color:#1e293b;">${esc(a.title || '—')}</span>
                  <span style="color:#64748b;"> · ${a.year || '—'}</span>
                  ${a.has_pdf ? '<span style="margin-left:6px;font-size:10px;background:#d1fae5;color:#065f46;padding:1px 5px;border-radius:10px;">PDF</span>' : ''}
                </span>
              </div>`;
            });
            html += '</div>';
          }
        }

        html += `<div style="margin-top:10px;text-align:right;">
          <button type="button" onclick="this.closest('.pv-notif-preview-panel').remove()"
                  style="font-size:11px;color:#6b7280;background:none;border:none;cursor:pointer;">✕ Cerrar</button>
        </div>`;

        panelEl.innerHTML = html;
        const formWrap = btn?.closest('div[style*="flex-direction:column"]');
        if (formWrap) formWrap.appendChild(panelEl);

      } catch (e) {
        _showStatus('error', 'Error en diagnóstico: ' + e.message);
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-search"></i> Diagnóstico'; }
      }
    }

    async function _loadAll() {
      _showStatus('info', '<i class="fas fa-spinner fa-spin" style="margin-right:6px;"></i>Cargando…', false);
      addBtn.disabled = true;
      try {
        const [subs, tzOptions] = await Promise.all([
          _notifApi('/notifications/subscriptions'),
          _loadTzOptions(),
        ]);
        _lastSubs = subs; _lastTz = tzOptions;
        statusEl.style.display = 'none';
        _renderTable(subs, tzOptions);
      } catch (e) {
        _showStatus('error', 'Error al cargar: ' + e.message);
      } finally {
        addBtn.disabled = false;
      }
    }

    function _open()  { modal.style.display = 'flex'; _expandedId = null; _loadAll(); }
    function _close() { modal.style.display = 'none'; statusEl.style.display = 'none'; }
    openBtn.addEventListener('click', _open);
    closeBtn.addEventListener('click', _close);
    backdrop.addEventListener('click', _close);
    addBtn.addEventListener('click', async () => {
      const defaults = {
        name: 'Nueva suscripción', source: 'pubmed', email: '', topics: ['prion'],
        frequency: 'weekly', days_of_week: [4], send_hour: 15, send_minute: 0,
        user_timezone: 'UTC', lookback_days: 7, include_oa_only: false,
        articles_per_email: 5, enabled: true,
      };
      try {
        const r = await _notifApi('/notifications/subscriptions', { method: 'POST', body: JSON.stringify(defaults) });
        _expandedId = r.id;
        await _loadAll();
      } catch (e) {
        _showStatus('error', 'Error al crear: ' + e.message);
      }
    });

    // ── Tabs: "PrionVault picks" (above) vs. "Recordatorios" (below) ────
    const tabPicks     = document.getElementById('pv-notif-tab-picks');
    const tabReminders = document.getElementById('pv-notif-tab-reminders');
    modal.querySelectorAll('.pv-notif-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const on = btn.dataset.tab === 'reminders';
        modal.querySelectorAll('.pv-notif-tab').forEach(b => {
          const active = b === btn;
          b.style.color = active ? '#0F3460' : '#9ca3af';
          b.style.borderBottomColor = active ? '#0F3460' : 'transparent';
        });
        tabPicks.style.display     = on ? 'none' : '';
        tabReminders.style.display = on ? '' : 'none';
        if (on) _loadReminders();
      });
    });

    // ── Recordatorios (one-time reminders) ───────────────────────────────
    const remStatusEl = document.getElementById('pv-reminders-status');
    const remListEl   = document.getElementById('pv-reminders-list');
    const remAddBtn    = document.getElementById('pv-reminders-add');
    const remForm      = document.getElementById('pv-reminder-form');
    const remFormId     = document.getElementById('pv-reminder-form-id');
    const remFormWhen   = document.getElementById('pv-reminder-form-when');
    const remFormTo     = document.getElementById('pv-reminder-form-to');
    const remFormJc      = document.getElementById('pv-reminder-form-jc');
    const remFormSubject = document.getElementById('pv-reminder-form-subject');
    const remFormMessage = document.getElementById('pv-reminder-form-message');
    const remFormStatus  = document.getElementById('pv-reminder-form-status');
    const remFormSave    = document.getElementById('pv-reminder-form-save');
    const remFormCancel  = document.getElementById('pv-reminder-form-cancel');

    const REMINDER_DEFAULT_MESSAGE =
      'Hola, [Usuario]:\n\n' +
      'Sirva este mensaje para recordarte que debes adjuntar la presentación ' +
      'del Journal Club que has realizado recientemente, al artículo ' +
      '[datos del artículo adjunto].\n\n' +
      'Gracias y un saludo.';

    let _jcOptionsLoaded = false;
    async function _loadJcOptions() {
      if (_jcOptionsLoaded) return;
      _jcOptionsLoaded = true;
      try {
        const r = await _notifApi('/reminders/jc-picker');
        const items = r.items || [];
        remFormJc.innerHTML = '<option value="">— Sin adjunto —</option>' +
          items.flatMap(x => (x.files || []).map(f =>
            `<option value="${f.id}" data-article-id="${x.article_id}"
                     data-article-title="${esc(x.article_title || '')}">
               ${esc(x.article_title || '(sin título)')} — ${esc(f.filename)}
             </option>`
          )).join('');
      } catch (e) { /* silent — attachment stays optional */ }
    }

    function _remFmtDate(iso) {
      if (!iso) return '—';
      return new Date(iso).toLocaleString('es-ES', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    }

    function _openReminderForm(rem) {
      remForm.style.display = 'block';
      remFormStatus.textContent = '';
      _loadJcOptions();
      if (rem) {
        remFormId.value = rem.id;
        remFormWhen.value = rem.scheduled_at ? rem.scheduled_at.slice(0, 16) : '';
        remFormTo.value = rem.to_email || '';
        remFormSubject.value = rem.subject || '';
        remFormMessage.value = rem.message || '';
        setTimeout(() => { remFormJc.value = rem.jc_file_id || ''; }, 0);
      } else {
        remFormId.value = '';
        remFormWhen.value = '';
        remFormTo.value = '';
        remFormSubject.value = 'Recordatorio — PrionVault';
        remFormMessage.value = REMINDER_DEFAULT_MESSAGE;
        remFormJc.value = '';
      }
      remForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    function _closeReminderForm() { remForm.style.display = 'none'; }

    function _renderReminders(items) {
      if (!items.length) {
        remListEl.innerHTML = `<p style="color:#9ca3af;text-align:center;padding:20px;font-size:13px;">
          Sin recordatorios todavía.</p>`;
        return;
      }
      remListEl.innerHTML = items.map(r => {
        const sent = !!r.sent_at;
        return `
        <div class="pv-reminder-row" data-id="${r.id}"
             style="display:flex;align-items:flex-start;gap:10px;padding:10px 4px;border-bottom:1px solid #f3f4f6;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:#111827;">
              ${esc(r.subject || '(sin asunto)')}
              ${sent
                ? '<span style="margin-left:6px;font-size:10.5px;font-weight:700;color:#15803d;">✓ enviado</span>'
                : r.error_msg
                  ? '<span style="margin-left:6px;font-size:10.5px;font-weight:700;color:#b91c1c;">✗ error</span>'
                  : ''}
            </div>
            <div style="font-size:11.5px;color:#6b7280;margin-top:2px;">
              Para ${esc(r.to_email)} · ${sent ? 'enviado el ' + _remFmtDate(r.sent_at) : _remFmtDate(r.scheduled_at)}
              ${r.jc_filename ? ` · 📎 ${esc(r.jc_filename)}` : ''}
            </div>
            ${r.article_title ? `<div style="font-size:11px;color:#9ca3af;margin-top:1px;">${esc(r.article_title)}</div>` : ''}
          </div>
          <div style="display:flex;gap:5px;flex-shrink:0;">
            ${!sent ? `
              <button class="pv-rem-edit" data-id="${r.id}" title="Editar"
                      style="padding:4px 8px;border-radius:6px;border:1px solid #d1d5db;background:white;font-size:11px;cursor:pointer;">✏</button>
              <button class="pv-rem-send" data-id="${r.id}" title="Enviar ahora"
                      style="padding:4px 8px;border-radius:6px;border:1px solid #bfdbfe;background:#eff6ff;color:#1d4ed8;font-size:11px;cursor:pointer;">▶</button>` : ''}
            <button class="pv-rem-delete" data-id="${r.id}" title="Borrar"
                    style="padding:4px 8px;border-radius:6px;border:1px solid #fca5a5;background:white;color:#b91c1c;font-size:11px;cursor:pointer;">🗑</button>
          </div>
        </div>`;
      }).join('');

      remListEl.querySelectorAll('.pv-rem-edit').forEach(b => {
        b.addEventListener('click', () => {
          const rem = _lastReminders.find(x => x.id === b.dataset.id);
          if (rem) _openReminderForm(rem);
        });
      });
      remListEl.querySelectorAll('.pv-rem-send').forEach(b => {
        b.addEventListener('click', async () => {
          if (!confirm('¿Enviar este recordatorio ahora?')) return;
          b.disabled = true;
          try {
            await _notifApi(`/reminders/${b.dataset.id}/send-now`, { method: 'POST' });
            await _loadReminders();
          } catch (e) {
            alert('Error al enviar: ' + e.message);
            b.disabled = false;
          }
        });
      });
      remListEl.querySelectorAll('.pv-rem-delete').forEach(b => {
        b.addEventListener('click', async () => {
          if (!confirm('¿Borrar este recordatorio?')) return;
          try {
            await _notifApi(`/reminders/${b.dataset.id}`, { method: 'DELETE' });
            await _loadReminders();
          } catch (e) {
            alert('Error al borrar: ' + e.message);
          }
        });
      });
    }

    let _lastReminders = [];
    async function _loadReminders() {
      try {
        const r = await _notifApi('/reminders');
        _lastReminders = r.items || [];
        remStatusEl.style.display = 'none';
        _renderReminders(_lastReminders);
      } catch (e) {
        remStatusEl.style.display = 'block';
        remStatusEl.style.background = '#fef2f2';
        remStatusEl.style.color = '#b91c1c';
        remStatusEl.style.border = '1px solid #fecaca';
        remStatusEl.textContent = 'Error al cargar: ' + e.message;
      }
    }

    remAddBtn?.addEventListener('click', () => _openReminderForm(null));
    remFormCancel?.addEventListener('click', _closeReminderForm);
    remFormSave?.addEventListener('click', async () => {
      const when = remFormWhen.value;
      const to = (remFormTo.value || '').trim();
      if (!when || !to) {
        remFormStatus.style.color = '#b91c1c';
        remFormStatus.textContent = 'Rellena la fecha/hora y el destinatario.';
        return;
      }
      const opt = remFormJc.selectedOptions[0];
      const payload = {
        scheduled_at: new Date(when).toISOString(),
        to_email: to,
        subject: (remFormSubject.value || '').trim() || 'Recordatorio — PrionVault',
        message: (remFormMessage.value || '').trim() || REMINDER_DEFAULT_MESSAGE,
        jc_file_id: remFormJc.value || null,
        article_id: (opt && opt.dataset.articleId) || null,
      };
      remFormSave.disabled = true;
      remFormStatus.style.color = '#9ca3af';
      remFormStatus.textContent = 'Guardando…';
      try {
        const id = remFormId.value;
        if (id) {
          await _notifApi(`/reminders/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        } else {
          await _notifApi('/reminders', { method: 'POST', body: JSON.stringify(payload) });
        }
        _closeReminderForm();
        await _loadReminders();
      } catch (e) {
        remFormStatus.style.color = '#b91c1c';
        remFormStatus.textContent = 'Error: ' + e.message;
      } finally {
        remFormSave.disabled = false;
      }
    });
  });


