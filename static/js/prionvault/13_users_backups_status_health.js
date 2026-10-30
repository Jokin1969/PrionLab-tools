  // ── Backups panel ──────────────────────────────────────────────────────
  // ── PrionVault's own user-management mini-panel ("Administración") ───────
  // Independent from the main PrionLab admin panel — reachable by a real
  // global admin OR anyone flagged is_prionvault_admin. Backed by
  // tools/prionvault/routes_user_admin.py, which enforces the same
  // guardrails server-side (never trust the UI alone): a flag-only
  // (non-global-admin) user-admin can't touch another admin account, set
  // anyone's global role, or deactivate themselves.
  function wirePvUserAdmin() {
    const openBtn = document.getElementById('btn-pv-user-admin');
    const modal   = document.getElementById('pv-user-admin-modal');
    const body    = document.getElementById('pv-user-admin-body');
    if (!openBtn || !modal || !body) return;

    let _users = [];
    let _formMode = null;   // 'new' | 'edit' | null

    function roleBadge(role) {
      const colors = { admin: '#1A5A9A', editor: '#1A7A4A', reader: '#555' };
      const bg     = { admin: '#E6F0FF', editor: '#E6F9F0', reader: '#F0F0F0' };
      return `<span style="display:inline-block;font-size:10.5px;font-weight:700;text-transform:uppercase;
                    letter-spacing:0.04em;padding:1px 7px;border-radius:99px;
                    background:${bg[role] || '#F0F0F0'};color:${colors[role] || '#555'};">${esc(role || '?')}</span>`;
    }

    function canFullyEdit(u) { return IS_ADMIN || u.role !== 'admin'; }

    function userRowHtml(u) {
      const editable = canFullyEdit(u);
      return `
        <tr data-username="${esc(u.username)}" style="border-bottom:1px solid #f3f4f6;${u.active ? '' : 'opacity:0.5;'}">
          <td style="padding:7px 8px;"><code>${esc(u.username)}</code></td>
          <td style="padding:7px 8px;">${esc(u.full_name || '')}</td>
          <td style="padding:7px 8px;font-size:12px;color:#6b7280;">${esc(u.email || '')}</td>
          <td style="padding:7px 8px;">${roleBadge(u.role)}</td>
          <td style="padding:7px 8px;text-align:center;">${u.is_prionvault_admin ? '✓' : ''}</td>
          <td style="padding:7px 8px;text-align:center;" title="${u.is_jc_responsible ? 'Responsable de Journal Club' : ''}">${u.is_jc_responsible ? '📖' : ''}</td>
          <td style="padding:7px 8px;text-align:center;">${u.active ? '✓' : '✗'}</td>
          <td style="padding:7px 8px;white-space:nowrap;">
            <button type="button" class="pv-ua-edit-btn" data-username="${esc(u.username)}"
                    title="Editar" ${editable ? '' : 'disabled'}
                    style="border:none;background:#f3f4f6;color:#374151;border-radius:5px;
                           padding:3px 7px;cursor:pointer;font-size:11px;${editable ? '' : 'opacity:0.4;cursor:not-allowed;'}">✏</button>
            <button type="button" class="pv-ua-toggle-btn" data-username="${esc(u.username)}"
                    title="${u.active ? 'Desactivar' : 'Activar'}" ${editable ? '' : 'disabled'}
                    style="border:none;background:#f3f4f6;color:#374151;border-radius:5px;
                           padding:3px 7px;cursor:pointer;font-size:11px;${editable ? '' : 'opacity:0.4;cursor:not-allowed;'}">${u.active ? '⏸' : '▶'}</button>
            <button type="button" class="pv-ua-reset-btn" data-username="${esc(u.username)}"
                    title="Resetear contraseña" ${editable ? '' : 'disabled'}
                    style="border:none;background:#fef3c7;color:#92400e;border-radius:5px;
                           padding:3px 7px;cursor:pointer;font-size:11px;${editable ? '' : 'opacity:0.4;cursor:not-allowed;'}">🔑</button>
          </td>
        </tr>`;
    }

    function formHtml(mode, u) {
      const isEdit = mode === 'edit';
      return `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          ${isEdit
            ? `<input type="hidden" id="pv-ua-f-username" value="${esc(u.username)}">`
            : `<label style="font-size:11.5px;color:#6b7280;font-weight:600;">Usuario
                 <input type="text" id="pv-ua-f-username" autocomplete="off"
                        style="width:100%;box-sizing:border-box;margin-top:3px;padding:6px 9px;
                               border:1px solid #d1d5db;border-radius:6px;font-size:13px;">
               </label>
               <label style="font-size:11.5px;color:#6b7280;font-weight:600;">Contraseña
                 <input type="password" id="pv-ua-f-password" autocomplete="new-password"
                        style="width:100%;box-sizing:border-box;margin-top:3px;padding:6px 9px;
                               border:1px solid #d1d5db;border-radius:6px;font-size:13px;">
               </label>`}
          <label style="font-size:11.5px;color:#6b7280;font-weight:600;">Nombre completo
            <input type="text" id="pv-ua-f-fullname" value="${esc(u.full_name || '')}"
                   style="width:100%;box-sizing:border-box;margin-top:3px;padding:6px 9px;
                          border:1px solid #d1d5db;border-radius:6px;font-size:13px;">
          </label>
          <label style="font-size:11.5px;color:#6b7280;font-weight:600;">Email
            <input type="email" id="pv-ua-f-email" value="${esc(u.email || '')}"
                   style="width:100%;box-sizing:border-box;margin-top:3px;padding:6px 9px;
                          border:1px solid #d1d5db;border-radius:6px;font-size:13px;">
          </label>
          <label style="font-size:11.5px;color:#6b7280;font-weight:600;">Idioma
            <select id="pv-ua-f-language"
                    style="width:100%;box-sizing:border-box;margin-top:3px;padding:6px 9px;
                           border:1px solid #d1d5db;border-radius:6px;font-size:13px;">
              <option value="es" ${(u.language || 'es') === 'es' ? 'selected' : ''}>Español</option>
              <option value="en" ${u.language === 'en' ? 'selected' : ''}>English</option>
            </select>
          </label>
          ${IS_ADMIN ? `<label style="font-size:11.5px;color:#6b7280;font-weight:600;">Rol general
            <select id="pv-ua-f-role"
                    style="width:100%;box-sizing:border-box;margin-top:3px;padding:6px 9px;
                           border:1px solid #d1d5db;border-radius:6px;font-size:13px;">
              <option value="reader" ${(u.role || 'reader') === 'reader' ? 'selected' : ''}>Reader</option>
              <option value="editor" ${u.role === 'editor' ? 'selected' : ''}>Editor</option>
              <option value="admin"  ${u.role === 'admin'  ? 'selected' : ''}>Admin</option>
            </select>
          </label>` : ''}
          <label style="grid-column:1/-1;display:flex;align-items:center;gap:7px;
                        font-size:12.5px;color:#374151;font-weight:600;margin-top:4px;">
            <input type="checkbox" id="pv-ua-f-pvadmin" ${u.is_prionvault_admin ? 'checked' : ''}>
            Administrador de usuarios de PrionVault
          </label>
          <label style="grid-column:1/-1;display:flex;align-items:center;gap:7px;
                        font-size:12.5px;color:#374151;font-weight:600;margin-top:-2px;">
            <input type="checkbox" id="pv-ua-f-jc" ${u.is_jc_responsible ? 'checked' : ''}>
            Responsable de Journal Club
          </label>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:12px;">
          <button type="button" id="pv-ua-f-save"
                  style="padding:7px 16px;border-radius:7px;border:none;background:#0F3460;
                         color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;">Guardar</button>
          <button type="button" id="pv-ua-f-cancel"
                  style="padding:7px 16px;border-radius:7px;border:1px solid #d1d5db;background:#fff;
                         color:#374151;font-size:12.5px;font-weight:600;cursor:pointer;">Cancelar</button>
          <span id="pv-ua-f-status" style="font-size:12px;color:#6b7280;"></span>
        </div>`;
    }

    function setStatus(msg, color) {
      const el = document.getElementById('pv-ua-status');
      if (el) { el.style.color = color || '#6b7280'; el.textContent = msg || ''; }
    }

    function openForm(mode, u) {
      _formMode = mode;
      const wrap = document.getElementById('pv-ua-new-form');
      if (!wrap) return;
      wrap.innerHTML = formHtml(mode, u || {});
      wrap.style.display = 'block';
      document.getElementById('pv-ua-f-cancel').addEventListener('click', closeForm);
      document.getElementById('pv-ua-f-save').addEventListener('click', () => saveForm(mode, u));
    }

    function closeForm() {
      _formMode = null;
      const wrap = document.getElementById('pv-ua-new-form');
      if (wrap) { wrap.style.display = 'none'; wrap.innerHTML = ''; }
    }

    async function saveForm(mode, original) {
      const fstatus = document.getElementById('pv-ua-f-status');
      const saveBtn = document.getElementById('pv-ua-f-save');
      const username  = document.getElementById('pv-ua-f-username').value.trim().toLowerCase();
      const fullName  = document.getElementById('pv-ua-f-fullname').value.trim();
      const email     = document.getElementById('pv-ua-f-email').value.trim();
      const language  = document.getElementById('pv-ua-f-language').value;
      const pvAdmin   = document.getElementById('pv-ua-f-pvadmin').checked;
      const jcResp    = document.getElementById('pv-ua-f-jc').checked;
      const roleEl    = document.getElementById('pv-ua-f-role');

      if (!username) { fstatus.style.color = '#b91c1c'; fstatus.textContent = 'Falta el usuario.'; return; }

      saveBtn.disabled = true;
      fstatus.style.color = '#6b7280';
      fstatus.textContent = 'Guardando…';
      try {
        if (mode === 'new') {
          const password = document.getElementById('pv-ua-f-password').value;
          if (!password) { throw new Error('Falta la contraseña.'); }
          const payload = { username, password, full_name: fullName, email, language, is_prionvault_admin: pvAdmin, is_jc_responsible: jcResp };
          if (roleEl) payload.role = roleEl.value;
          await api('/admin/pv-users', { method: 'POST', body: JSON.stringify(payload) });
        } else {
          const payload = { full_name: fullName, email, language, is_prionvault_admin: pvAdmin, is_jc_responsible: jcResp };
          if (roleEl) payload.role = roleEl.value;
          await api(`/admin/pv-users/${encodeURIComponent(username)}`, { method: 'PATCH', body: JSON.stringify(payload) });
        }
        closeForm();
        setStatus('✓ Guardado.', '#15803d');
        await load();
      } catch (e) {
        fstatus.style.color = '#b91c1c';
        fstatus.textContent = 'Error: ' + e.message;
      } finally {
        saveBtn.disabled = false;
      }
    }

    function wireRowButtons() {
      document.querySelectorAll('.pv-ua-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const u = _users.find(x => x.username === btn.dataset.username);
          if (u) openForm('edit', u);
        });
      });
      document.querySelectorAll('.pv-ua-toggle-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await api(`/admin/pv-users/${encodeURIComponent(btn.dataset.username)}/toggle`, { method: 'POST' });
            await load();
          } catch (e) {
            setStatus('Error: ' + e.message, '#b91c1c');
          } finally {
            btn.disabled = false;
          }
        });
      });
      document.querySelectorAll('.pv-ua-reset-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm(`¿Resetear la contraseña de ${btn.dataset.username}?`)) return;
          btn.disabled = true;
          try {
            const r = await api(`/admin/pv-users/${encodeURIComponent(btn.dataset.username)}/reset-password`, { method: 'POST' });
            alert(`Nueva contraseña para ${btn.dataset.username}:\n\n${r.password}\n\nCópiala ahora — no se volverá a mostrar.`);
          } catch (e) {
            setStatus('Error: ' + e.message, '#b91c1c');
          } finally {
            btn.disabled = false;
          }
        });
      });
    }

    function render() {
      body.innerHTML = `
        <div style="display:flex;justify-content:flex-end;margin-bottom:10px;">
          <button type="button" id="pv-ua-new-btn"
                  style="padding:7px 14px;border-radius:7px;border:none;background:#0F3460;
                         color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;">
            + Nuevo usuario
          </button>
        </div>
        <div id="pv-ua-new-form" style="display:none;background:#f9fafb;border:1px solid #e5e7eb;
                    border-radius:8px;padding:12px 14px;margin-bottom:14px;"></div>
        <div id="pv-ua-status" style="font-size:12.5px;margin-bottom:8px;min-height:16px;"></div>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
            <thead>
              <tr style="border-bottom:1px solid #e5e7eb;color:#6b7280;text-align:left;">
                <th style="padding:6px 8px;">Usuario</th>
                <th style="padding:6px 8px;">Nombre</th>
                <th style="padding:6px 8px;">Email</th>
                <th style="padding:6px 8px;">Rol</th>
                <th style="padding:6px 8px;text-align:center;" title="Administrador de usuarios de PrionVault">PV-Admin</th>
                <th style="padding:6px 8px;text-align:center;" title="Responsable de Journal Club">JC</th>
                <th style="padding:6px 8px;text-align:center;">Activo</th>
                <th style="padding:6px 8px;">Acciones</th>
              </tr>
            </thead>
            <tbody id="pv-ua-tbody">${_users.map(userRowHtml).join('')}</tbody>
          </table>
        </div>`;
      document.getElementById('pv-ua-new-btn').addEventListener('click', () => openForm('new'));
      wireRowButtons();
    }

    async function load() {
      setStatus('Cargando…', '#9ca3af');
      try {
        const r = await api('/admin/pv-users');
        _users = r.users || [];
        render();
        setStatus('', '#6b7280');
      } catch (e) {
        body.innerHTML = `<div style="color:#b91c1c;font-size:13px;">Error: ${esc(e.message)}</div>`;
      }
    }

    openBtn.addEventListener('click', () => {
      modal.style.display = 'flex';
      load();
    });
  }

  // "Ver como" — PrionVault-side entry point into the existing PrionLab
  // impersonation feature (tools/admin impersonate_user), so a real admin
  // can jump straight into "what does this user see in PrionVault"
  // without leaving PrionVault first. True global-admin only.
  function wirePvViewAs() {
    const openBtn = document.getElementById('btn-pv-view-as');
    const modal   = document.getElementById('pv-view-as-modal');
    const body    = document.getElementById('pv-view-as-body');
    if (!openBtn || !modal || !body) return;

    async function load() {
      body.innerHTML = '<p style="color:#9ca3af;font-size:12.5px;">Cargando…</p>';
      let users;
      try {
        const r = await api('/admin/pv-users');
        users = (r.users || []).filter(u => u.role !== 'admin' && u.active);
      } catch (e) {
        body.innerHTML = `<p style="color:#b91c1c;font-size:12.5px;">Error: ${esc(e.message)}</p>`;
        return;
      }
      if (!users.length) {
        body.innerHTML = '<p style="color:#9ca3af;font-size:12.5px;">No hay usuarios no-administradores activos.</p>';
        return;
      }
      body.innerHTML = users.map(u => `
        <form method="POST" action="/admin/users/${encodeURIComponent(u.username)}/impersonate"
              style="display:flex;align-items:center;justify-content:space-between;gap:10px;
                     padding:9px 4px;border-bottom:1px solid #f3f4f6;">
          <input type="hidden" name="next" value="/prionvault">
          <span style="font-size:13px;color:#111827;">
            <strong>${esc(u.full_name || u.username)}</strong>
            <span style="color:#9ca3af;font-size:11.5px;"> · ${esc(u.username)} · ${esc(u.role)}</span>
          </span>
          <button type="submit"
                  style="padding:5px 12px;border-radius:7px;border:none;background:#0F3460;
                         color:#fff;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;">
            👁 Ver como
          </button>
        </form>`).join('');
    }

    openBtn.addEventListener('click', () => {
      modal.style.display = 'flex';
      load();
    });
  }

  function wireBackups() {
    const openBtn = document.getElementById('btn-backups');
    const modal   = document.getElementById('pv-backups-modal');
    if (!openBtn || !modal) return;

    const tabList     = document.getElementById('pv-bk-tab-list');
    const tabSettings = document.getElementById('pv-bk-tab-settings');
    const paneList     = document.getElementById('pv-bk-pane-list');
    const paneSettings = document.getElementById('pv-bk-pane-settings');
    const listEl        = document.getElementById('pv-bk-list');
    const createBtn      = document.getElementById('pv-bk-create-now');
    const createStatusEl = document.getElementById('pv-bk-create-status');
    const refreshBtn     = document.getElementById('pv-bk-refresh');
    const verifyPanel  = document.getElementById('pv-bk-verify-panel');
    const restorePanel = document.getElementById('pv-bk-restore-panel');

    async function adminApi(path, opts = {}) {
      const res = await fetch('/admin' + path, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        ...opts,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) {
        throw new Error(body.error || ('HTTP ' + res.status));
      }
      return body;
    }

    function fmtDate(iso) {
      if (!iso) return '—';
      try {
        return new Date(iso).toLocaleString('es-ES', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });
      } catch { return iso; }
    }

    // Poll a background job (create/verify/restore) until it reaches a
    // terminal status. Calls onTick(job) on every poll, resolves with
    // the final job payload.
    function pollJob(jobId, { intervalMs = 2000, onTick } = {}) {
      return new Promise((resolve, reject) => {
        const tick = async () => {
          let job;
          try {
            job = await adminApi(`/api/db/jobs/status/${jobId}`);
          } catch (e) {
            reject(e);
            return;
          }
          if (onTick) onTick(job);
          if (job.status === 'running') {
            setTimeout(tick, intervalMs);
          } else {
            resolve(job);
          }
        };
        tick();
      });
    }

    function stageLabel(stage) {
      const labels = {
        starting: 'Iniciando…',
        listing_dropbox_backups: 'Listando copias en Dropbox…',
        downloading: 'Descargando desde Dropbox…',
        creating_backup: 'Creando backup…',
        verifying: 'Verificando…',
        restoring: 'Restaurando…',
      };
      return labels[stage] || stage || '…';
    }

    // ── Tabs ──────────────────────────────────────────────────────────
    function showTab(which) {
      const isList = which === 'list';
      paneList.style.display = isList ? '' : 'none';
      paneSettings.style.display = isList ? 'none' : '';
      tabList.classList.toggle('pv-bk-tab-active', isList);
      tabSettings.classList.toggle('pv-bk-tab-active', !isList);
    }
    tabList.addEventListener('click', () => showTab('list'));
    tabSettings.addEventListener('click', () => showTab('settings'));

    // ── List backups ──────────────────────────────────────────────────
    async function loadList() {
      listEl.innerHTML = '<p style="color:#9ca3af;text-align:center;padding:24px;font-size:13px;">Cargando…</p>';
      let data;
      try {
        data = await adminApi('/api/db/backups/list');
      } catch (e) {
        listEl.innerHTML = `<div style="color:#b91c1c;padding:16px;font-size:12.5px;">Error: ${esc(e.message)}</div>`;
        return;
      }
      const backups = data.backups || [];
      const locationEl = document.getElementById('pv-bk-location');
      if (locationEl && backups[0]?.path) {
        locationEl.textContent = backups[0].path.replace(/\/[^/]+$/, '') || backups[0].path;
      }
      if (!backups.length) {
        listEl.innerHTML = '<p style="color:#9ca3af;text-align:center;padding:24px;font-size:13px;">No hay backups en Dropbox todavía.</p>';
        return;
      }
      listEl.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
          <thead style="background:#f9fafb;">
            <tr>
              <th style="text-align:left;padding:8px 12px;color:#6b7280;font-weight:600;">Archivo</th>
              <th style="text-align:left;padding:8px 12px;color:#6b7280;font-weight:600;">Fecha</th>
              <th style="text-align:right;padding:8px 12px;color:#6b7280;font-weight:600;">Tamaño</th>
              <th style="text-align:left;padding:8px 12px;color:#6b7280;font-weight:600;">Tipo</th>
              <th style="text-align:right;padding:8px 12px;color:#6b7280;font-weight:600;"></th>
            </tr>
          </thead>
          <tbody>
            ${backups.map((b, i) => `
              <tr style="border-top:1px solid #f3f4f6;">
                <td style="padding:8px 12px;font-family:ui-monospace,monospace;font-size:11.5px;color:#111827;">
                  ${esc(b.filename)}
                  ${b.cached_locally ? '<span title="Ya descargado en el servidor" style="margin-left:6px;font-size:10px;color:#15803d;">●</span>' : ''}
                </td>
                <td style="padding:8px 12px;color:#374151;white-space:nowrap;">${esc(fmtDate(b.created_at))}</td>
                <td style="padding:8px 12px;color:#374151;text-align:right;white-space:nowrap;">${b.size_mb} MB</td>
                <td style="padding:8px 12px;color:#6b7280;">${esc(b.type)}</td>
                <td style="padding:8px 12px;text-align:right;white-space:nowrap;">
                  <button class="pv-bk-verify-btn" data-filename="${escAttrJs(b.filename)}"
                          style="padding:4px 10px;border-radius:6px;border:1px solid #d1d5db;background:white;
                                 color:#374151;font-size:11.5px;cursor:pointer;margin-right:4px;">
                    🔍 Verificar
                  </button>
                  <button class="pv-bk-restore-btn" data-filename="${escAttrJs(b.filename)}"
                          style="padding:4px 10px;border-radius:6px;border:1px solid #fca5a5;background:#fff5f5;
                                 color:#b91c1c;font-size:11.5px;font-weight:600;cursor:pointer;margin-right:4px;">
                    ♻ Restaurar
                  </button>
                  <button class="pv-bk-delete-btn" data-filename="${escAttrJs(b.filename)}"
                          title="Borrar este backup (de Dropbox y de la caché local)"
                          style="padding:4px 8px;border-radius:6px;border:1px solid #d1d5db;background:white;
                                 color:#6b7280;font-size:11.5px;cursor:pointer;">
                    🗑️
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
      listEl.querySelectorAll('.pv-bk-verify-btn').forEach(b =>
        b.addEventListener('click', () => runVerify(b.dataset.filename)));
      listEl.querySelectorAll('.pv-bk-restore-btn').forEach(b =>
        b.addEventListener('click', () => openRestoreFlow(b.dataset.filename)));
      listEl.querySelectorAll('.pv-bk-delete-btn').forEach(b =>
        b.addEventListener('click', () => deleteBackup(b.dataset.filename)));
    }

    async function deleteBackup(filename) {
      if (!confirm(`¿Borrar el backup "${filename}"? Esta acción no se puede deshacer.`)) return;
      try {
        await adminApi(`/api/db/backups/${encodeURIComponent(filename)}/delete`, { method: 'POST' });
        loadList();
      } catch (e) {
        alert('Error al borrar el backup: ' + e.message);
      }
    }
    function escAttrJs(s) { return esc(String(s || '')).replace(/"/g, '&quot;'); }

    refreshBtn.addEventListener('click', loadList);

    createBtn.addEventListener('click', async () => {
      createBtn.disabled = true;
      createStatusEl.textContent = 'Creando…';
      try {
        const { job_id } = await adminApi('/api/db/backups/create', { method: 'POST' });
        const job = await pollJob(job_id, {
          onTick: j => { createStatusEl.textContent = stageLabel(j.stage); },
        });
        if (job.status === 'success') {
          if (job.result?.dropbox_error) {
            createStatusEl.textContent = `⚠ Backup creado localmente (${job.result?.size_mb ?? '?'} MB) `
              + `pero NO se pudo subir a Dropbox — por eso no aparece en esta lista`
              + (job.result?.dropbox_error ? `: ${job.result.dropbox_error}` : '.')
              + ' Revisa el espacio disponible en Dropbox.';
          } else {
            createStatusEl.textContent = `✓ Backup creado (${job.result?.size_mb ?? '?'} MB)`;
          }
          loadList();
          loadHealth();
        } else {
          createStatusEl.textContent = '✗ ' + (job.error || 'Error desconocido');
          loadHealth();
        }
      } catch (e) {
        createStatusEl.textContent = '✗ ' + e.message;
      } finally {
        createBtn.disabled = false;
      }
    });

    // ── Verify flow ───────────────────────────────────────────────────
    async function runVerify(filename) {
      restorePanel.style.display = 'none';
      verifyPanel.style.display = '';
      verifyPanel.innerHTML = `
        <div style="border:1px solid #bfdbfe;background:#eff6ff;border-radius:10px;padding:14px 16px;">
          <div style="font-weight:700;color:#1e40af;font-size:13px;margin-bottom:6px;">
            🔍 Verificando ${esc(filename)}…
          </div>
          <div id="pv-bk-verify-status" style="font-size:12.5px;color:#1e40af;">Iniciando…</div>
        </div>
      `;
      const statusEl = document.getElementById('pv-bk-verify-status');
      try {
        const { job_id } = await adminApi('/api/db/backups/verify', {
          method: 'POST', body: JSON.stringify({ filename }),
        });
        const job = await pollJob(job_id, {
          onTick: j => { statusEl.textContent = stageLabel(j.stage); },
        });
        renderVerifyResult(filename, job);
      } catch (e) {
        verifyPanel.innerHTML = `<div style="color:#b91c1c;font-size:12.5px;padding:12px;">Error: ${esc(e.message)}</div>`;
      }
    }

    function renderVerifyResult(filename, job) {
      if (job.status !== 'success') {
        verifyPanel.innerHTML = `
          <div style="border:1px solid #fecaca;background:#fef2f2;border-radius:10px;padding:14px 16px;">
            <div style="font-weight:700;color:#991b1b;font-size:13px;margin-bottom:6px;">✗ Verificación fallida</div>
            <div style="font-size:12.5px;color:#7f1d1d;">${esc(job.error || 'Error desconocido')}</div>
          </div>`;
        return;
      }
      const r = job.result || {};
      const tables = (r.tables || []).slice().sort((a, b) => b.rows - a.rows);
      const blockRows = r.would_block || [];
      const repair = r.unrepairable_json_array_cells || {};
      const repairEntries = Object.entries(repair);
      verifyPanel.innerHTML = `
        <div style="border:1px solid #bbf7d0;background:#f0fdf4;border-radius:10px;padding:14px 16px;">
          <div style="font-weight:700;color:#166534;font-size:13px;margin-bottom:8px;">
            ✓ ${esc(filename)} es restaurable — ${r.tables_found} tablas, ${r.total_rows.toLocaleString('es-ES')} filas, ${r.size_mb} MB
          </div>
          ${blockRows.length ? `
            <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:12px;color:#92400e;">
              ⚠ Restaurar TODAS las tablas de este backup vaciaría, sin datos para recargar:
              <strong>${blockRows.map(esc).join(', ')}</strong>. Si restauras solo un subconjunto de tablas,
              esto puede no aplicar — se recalcula en el momento de restaurar.
            </div>` : ''}
          ${repairEntries.length ? `
            <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:12px;color:#92400e;">
              ⚠ Celdas JSON/array con formato antiguo que se repararán automáticamente:
              ${repairEntries.map(([t, n]) => `${esc(t)} (${n})`).join(', ')}
            </div>` : ''}
          <details>
            <summary style="cursor:pointer;font-size:12px;color:#166534;font-weight:600;">Ver ${tables.length} tablas</summary>
            <div style="max-height:220px;overflow-y:auto;margin-top:8px;">
              <table style="width:100%;font-size:11.5px;border-collapse:collapse;">
                ${tables.map(t => `
                  <tr style="border-top:1px solid #dcfce7;">
                    <td style="padding:3px 8px;font-family:ui-monospace,monospace;">${esc(t.table)}</td>
                    <td style="padding:3px 8px;text-align:right;color:#374151;">${t.rows.toLocaleString('es-ES')} filas</td>
                  </tr>`).join('')}
              </table>
            </div>
          </details>
          <div style="margin-top:10px;">
            <button class="pv-bk-restore-from-verify" style="padding:6px 14px;border-radius:7px;border:1px solid #fca5a5;
                    background:#fff5f5;color:#b91c1c;font-size:12px;font-weight:600;cursor:pointer;">
              ♻ Restaurar desde aquí
            </button>
          </div>
        </div>
      `;
      verifyPanel.querySelector('.pv-bk-restore-from-verify')
        .addEventListener('click', () => openRestoreFlow(filename, tables.map(t => t.table)));
    }

    // ── Restore flow ──────────────────────────────────────────────────
    // Tables that are almost always safe to include (article-domain
    // PrionVault data) — pre-checked by default. Foundational/shared
    // tables (users, labs, sessions, publications, notification_logs,
    // system_logs, ...) are deliberately left OUT of the default
    // selection: restoring them rolls back *current* unrelated data to
    // the backup's point in time, which is almost never what an
    // emergency restore should do.
    const SAFE_DEFAULT_PREFIXES = ['article', 'evaluations', 'user_articles',
      'prionvault_article', 'prionvault_query_expansion', 'prionvault_collection_article',
      'prionvault_dismissed_duplicates', 'prionvault_user_selection', 'prionvault_user_state',
      'prionvault_jc_', 'prionvault_scheduled_email', 'citation_references'];
    const KNOWN_REGENERABLE = ['article_chunk'];

    function openRestoreFlow(filename, knownTables) {
      verifyPanel.style.display = 'none';
      restorePanel.style.display = '';
      const tables = knownTables || [];
      const checklistHtml = tables.length ? tables.sort().map(t => {
        const checked = SAFE_DEFAULT_PREFIXES.some(p => t.startsWith(p));
        return `
          <label style="display:flex;align-items:center;gap:6px;padding:2px 0;font-size:11.5px;
                        font-family:ui-monospace,monospace;color:#374151;">
            <input type="checkbox" class="pv-bk-table-cb" value="${escAttrJs(t)}" ${checked ? 'checked' : ''}>
            ${esc(t)}
          </label>`;
      }).join('') : '<p style="font-size:12px;color:#9ca3af;">Verifica el backup primero para ver la lista de tablas disponibles.</p>';

      restorePanel.innerHTML = `
        <div style="border:2px solid #fca5a5;background:#fff5f5;border-radius:10px;padding:16px 18px;">
          <div style="font-weight:700;color:#991b1b;font-size:14px;margin-bottom:4px;">
            ♻ Restaurar desde ${esc(filename)}
          </div>
          <p style="font-size:12px;color:#7f1d1d;margin:0 0 10px;line-height:1.5;">
            Solo se tocan las tablas marcadas — todo lo demás en la base de datos actual
            se queda como está. Revisa la selección antes de continuar.
          </p>
          <div style="display:flex;gap:8px;margin-bottom:8px;">
            <button id="pv-bk-select-safe" type="button" style="padding:4px 10px;border-radius:6px;
                    border:1px solid #d1d5db;background:white;color:#374151;font-size:11px;cursor:pointer;">
              Selección recomendada
            </button>
            <button id="pv-bk-select-none" type="button" style="padding:4px 10px;border-radius:6px;
                    border:1px solid #d1d5db;background:white;color:#374151;font-size:11px;cursor:pointer;">
              Ninguna
            </button>
          </div>
          <div style="max-height:220px;overflow-y:auto;background:white;border:1px solid #fecaca;
                      border-radius:8px;padding:10px 14px;margin-bottom:12px;">
            ${checklistHtml}
          </div>
          <div id="pv-bk-restore-ack-wrap" style="display:none;margin-bottom:12px;"></div>
          <div style="display:flex;align-items:center;gap:10px;">
            <button id="pv-bk-restore-go" type="button" style="padding:8px 18px;border-radius:8px;border:none;
                    background:#b91c1c;color:white;font-size:13px;font-weight:700;cursor:pointer;">
              Restaurar tablas seleccionadas
            </button>
            <button id="pv-bk-restore-cancel" type="button" style="padding:8px 14px;border-radius:8px;
                    border:1px solid #d1d5db;background:white;color:#374151;font-size:12.5px;cursor:pointer;">
              Cancelar
            </button>
            <span id="pv-bk-restore-status" style="font-size:12px;color:#7f1d1d;"></span>
          </div>
          <div id="pv-bk-restore-progress" style="display:none;margin-top:10px;">
            <div style="height:8px;background:#fecaca;border-radius:4px;overflow:hidden;">
              <div id="pv-bk-restore-bar" style="height:100%;width:30%;background:#b91c1c;
                   animation:pv-bk-indeterminate 1.4s infinite;"></div>
            </div>
          </div>
        </div>
      `;

      const ackWrap = document.getElementById('pv-bk-restore-ack-wrap');
      let acknowledged = new Set(KNOWN_REGENERABLE);

      document.getElementById('pv-bk-select-safe').addEventListener('click', () => {
        restorePanel.querySelectorAll('.pv-bk-table-cb').forEach(cb => {
          cb.checked = SAFE_DEFAULT_PREFIXES.some(p => cb.value.startsWith(p));
        });
      });
      document.getElementById('pv-bk-select-none').addEventListener('click', () => {
        restorePanel.querySelectorAll('.pv-bk-table-cb').forEach(cb => { cb.checked = false; });
      });
      document.getElementById('pv-bk-restore-cancel').addEventListener('click', () => {
        restorePanel.style.display = 'none';
      });

      async function attemptRestore() {
        const selected = Array.from(restorePanel.querySelectorAll('.pv-bk-table-cb:checked')).map(cb => cb.value);
        if (!selected.length) {
          document.getElementById('pv-bk-restore-status').textContent = 'Selecciona al menos una tabla.';
          return;
        }
        const goBtn = document.getElementById('pv-bk-restore-go');
        const statusEl = document.getElementById('pv-bk-restore-status');
        const progressEl = document.getElementById('pv-bk-restore-progress');
        goBtn.disabled = true;
        progressEl.style.display = '';
        statusEl.textContent = 'Iniciando…';
        try {
          const { job_id } = await adminApi('/api/db/emergency-restore', {
            method: 'POST',
            body: JSON.stringify({
              filename, tables: selected,
              acknowledge_data_loss: Array.from(acknowledged),
            }),
          });
          const job = await pollJob(job_id, {
            onTick: j => { statusEl.textContent = stageLabel(j.stage); },
          });
          progressEl.style.display = 'none';
          if (job.status === 'success') {
            const r = job.result || {};
            statusEl.textContent = '';
            restorePanel.querySelector('div').insertAdjacentHTML('beforeend', `
              <div style="margin-top:10px;padding:10px 12px;background:#f0fdf4;border:1px solid #bbf7d0;
                          border-radius:8px;font-size:12.5px;color:#166534;">
                ✓ Restaurado: ${r.tables_restored} tablas, ${r.rows_restored?.toLocaleString('es-ES')} filas.
                ${r.warnings?.length ? `<br>⚠ ${r.warnings.length} aviso(s) — revisa los logs.` : ''}
              </div>`);
            loadList();
            return;
          }
          // Detect the CASCADE-would-empty message and offer one-click
          // acknowledge + retry, instead of making the admin re-type
          // the table list by hand like we had to do by chat this week.
          const m = /would also empty \[(.*?)\]/.exec(job.error || '');
          if (m) {
            const extra = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
            ackWrap.style.display = '';
            ackWrap.innerHTML = `
              <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 12px;">
                <div style="font-size:12px;color:#92400e;margin-bottom:6px;">
                  Restaurar esto vaciaría estas tablas sin datos para recargarlas: <strong>${extra.map(esc).join(', ')}</strong>.
                  Añádelas a la selección si quieres restaurarlas, o acepta perderlas para continuar.
                </div>
                <button id="pv-bk-ack-and-retry" type="button" style="padding:5px 12px;border-radius:6px;
                        border:1px solid #fbbf24;background:white;color:#92400e;font-size:11.5px;font-weight:600;cursor:pointer;">
                  Aceptar pérdida de estas tablas y reintentar
                </button>
              </div>`;
            document.getElementById('pv-bk-ack-and-retry').addEventListener('click', () => {
              extra.forEach(t => acknowledged.add(t));
              attemptRestore();
            });
            statusEl.textContent = '';
          } else {
            statusEl.textContent = '✗ ' + (job.error || 'Error desconocido');
          }
        } catch (e) {
          progressEl.style.display = 'none';
          statusEl.textContent = '✗ ' + e.message;
        } finally {
          goBtn.disabled = false;
        }
      }
      document.getElementById('pv-bk-restore-go').addEventListener('click', attemptRestore);
    }

    // ── Settings ──────────────────────────────────────────────────────
    async function loadSettings() {
      let data;
      try {
        data = await adminApi('/api/db/backups/settings');
      } catch (e) {
        document.getElementById('pv-bk-settings-status').textContent = 'Error: ' + e.message;
        return;
      }
      const s = data.settings || {};
      document.getElementById('pv-bk-frequency').value = s.frequency || 'weekly';
      document.getElementById('pv-bk-hour').value = s.hour_utc ?? 3;
      document.getElementById('pv-bk-dow').value = s.day_of_week || 'sun';
      document.getElementById('pv-bk-dom').value = s.day_of_month ?? 1;
      document.getElementById('pv-bk-retain-count').value = s.retain_count ?? 12;
      document.getElementById('pv-bk-retain-monthly').value = s.retain_monthly ?? 24;
      updateFrequencyFields();
    }
    function updateFrequencyFields() {
      const freq = document.getElementById('pv-bk-frequency').value;
      document.getElementById('pv-bk-dow-wrap').style.display = freq === 'weekly' ? '' : 'none';
      document.getElementById('pv-bk-dom-wrap').style.display = freq === 'monthly' ? '' : 'none';
    }
    document.getElementById('pv-bk-frequency').addEventListener('change', updateFrequencyFields);
    document.getElementById('pv-bk-save-settings').addEventListener('click', async () => {
      const statusEl = document.getElementById('pv-bk-settings-status');
      statusEl.textContent = 'Guardando…';
      try {
        const payload = {
          frequency: document.getElementById('pv-bk-frequency').value,
          day_of_week: document.getElementById('pv-bk-dow').value,
          day_of_month: parseInt(document.getElementById('pv-bk-dom').value, 10) || 1,
          hour_utc: parseInt(document.getElementById('pv-bk-hour').value, 10) || 0,
          retain_count: parseInt(document.getElementById('pv-bk-retain-count').value, 10) || 1,
          retain_monthly: parseInt(document.getElementById('pv-bk-retain-monthly').value, 10) || 0,
        };
        const res = await adminApi('/api/db/backups/settings', {
          method: 'POST', body: JSON.stringify(payload),
        });
        statusEl.textContent = res.rescheduled
          ? '✓ Guardado y aplicado de inmediato.'
          : '✓ Guardado (se aplicará en el próximo reinicio).';
      } catch (e) {
        statusEl.textContent = '✗ ' + e.message;
      }
    });

    // ── Backup health ("¿se están haciendo bien las copias?") ─────────
    const _BK_TRIGGER = { scheduled: 'Programada', manual: 'Manual', catchup: 'Recuperación' };
    const _BK_STATUS = {
      success: ['✓ Correcta', '#15803d'],
      partial: ['⚠ Sin subir a Dropbox', '#b45309'],
      failed:  ['✗ Falló', '#b91c1c'],
      running: ['… En curso', '#1d4ed8'],
      skipped: ['Omitida', '#6b7280'],
    };
    function _fmtAge(h) {
      if (h == null) return '—';
      if (h < 1) return 'hace menos de 1 hora';
      if (h < 48) return `hace ${Math.round(h)} h`;
      return `hace ${Math.round(h / 24)} días`;
    }
    async function loadHealth() {
      const box = document.getElementById('pv-bk-health');
      if (!box) return;
      box.innerHTML = '<div style="font-size:12.5px;color:#9ca3af;">Comprobando el estado de las copias…</div>';
      let h;
      try { h = await adminApi('/api/db/backups/health'); }
      catch (e) {
        box.innerHTML = `<div style="font-size:12.5px;color:#b91c1c;">No se pudo comprobar el estado: ${esc(e.message)}</div>`;
        return;
      }
      _paintBackupNavDot(h.level);
      const theme = {
        ok:      ['#f0fdf4', '#86efac', '#15803d', '✓ Las copias de seguridad se están haciendo bien'],
        warning: ['#fffbeb', '#fcd34d', '#b45309', '⚠ Las copias se hacen, pero hay algo que revisar'],
        error:   ['#fef2f2', '#fca5a5', '#b91c1c', '✗ Las copias de seguridad NO se están haciendo bien'],
      }[h.level] || ['#f9fafb', '#e5e7eb', '#6b7280', 'Estado desconocido'];
      const freq = { daily: 'diaria', weekly: 'semanal', monthly: 'mensual' }[h.settings?.frequency] || '—';
      const runs = h.runs || [];
      box.innerHTML = `
        <div style="background:${theme[0]};border:1px solid ${theme[1]};border-radius:10px;padding:12px 14px;">
          <div style="font-weight:700;font-size:13.5px;color:${theme[2]};">${theme[3]}</div>
          ${(h.problems || []).length ? `<ul style="margin:6px 0 0;padding-left:18px;font-size:12.5px;color:${theme[2]};">
            ${h.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
          <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:9px;font-size:12px;color:#374151;">
            <span><strong>Última copia correcta:</strong> ${h.last_success_at ? esc(fmtDate(h.last_success_at)) + ' (' + _fmtAge(h.age_hours) + ')' : 'ninguna registrada'}</span>
            <span><strong>Frecuencia:</strong> ${esc(freq)}</span>
            <span><strong>Próxima programada:</strong> ${h.next_scheduled ? esc(fmtDate(h.next_scheduled)) : '—'}</span>
            ${h.running ? '<span style="color:#1d4ed8;"><strong>Hay una copia en curso ahora mismo</strong></span>' : ''}
          </div>
          <div style="font-size:11px;color:#6b7280;margin-top:6px;">
            Se comprueba cada hora: si falta una copia, se hace sola; si una falla o no llega a Dropbox, se avisa por email a los administradores.
          </div>
          <details style="margin-top:8px;">
            <summary style="cursor:pointer;font-size:12px;font-weight:600;color:#374151;">Historial de copias (${runs.length})</summary>
            ${runs.length ? `<table style="width:100%;border-collapse:collapse;font-size:11.5px;margin-top:6px;background:#fff;">
              <thead><tr style="text-align:left;color:#6b7280;border-bottom:1px solid #e5e7eb;">
                <th style="padding:4px 6px;">Fecha</th><th style="padding:4px 6px;">Tipo</th>
                <th style="padding:4px 6px;">Resultado</th><th style="padding:4px 6px;text-align:right;">Tamaño</th>
                <th style="padding:4px 6px;">Detalle</th></tr></thead>
              <tbody>${runs.map(r => {
                const st = _BK_STATUS[r.status] || [r.status, '#6b7280'];
                const detail = r.error || r.dropbox_error || r.warning || r.filename || '';
                return `<tr style="border-bottom:1px solid #f3f4f6;">
                  <td style="padding:4px 6px;white-space:nowrap;">${esc(fmtDate(r.started_at))}</td>
                  <td style="padding:4px 6px;">${esc(_BK_TRIGGER[r.trigger] || r.trigger)}</td>
                  <td style="padding:4px 6px;color:${st[1]};font-weight:600;white-space:nowrap;">${esc(st[0])}</td>
                  <td style="padding:4px 6px;text-align:right;white-space:nowrap;">${r.size_mb != null ? esc(r.size_mb + ' MB') : ''}</td>
                  <td style="padding:4px 6px;color:#6b7280;">${esc(detail)}</td></tr>`;
              }).join('')}</tbody></table>`
              : '<div style="font-size:12px;color:#9ca3af;margin-top:6px;">Aún no hay copias registradas (el registro empieza con esta versión).</div>'}
          </details>
        </div>`;
    }
    refreshBtn?.addEventListener('click', loadHealth);

    // ── 🩺 Step-by-step diagnosis ──────────────────────────────────────
    document.getElementById('pv-bk-diagnose')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const out = document.getElementById('pv-bk-diagnose-result');
      btn.disabled = true;
      out.innerHTML = '<div style="font-size:12.5px;color:#6b7280;">Comprobando (Dropbox puede tardar unos segundos)…</div>';
      try {
        const r = await adminApi('/api/db/backups/diagnose', { method: 'POST' });
        const icon = { ok: ['✓', '#15803d'], warn: ['⚠', '#b45309'], fail: ['✗', '#b91c1c'], info: ['ℹ', '#1d4ed8'] };
        out.innerHTML = `<div style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
          ${(r.checks || []).map(c => {
            const [ic, col] = icon[c.status] || ['•', '#6b7280'];
            return `<div style="display:flex;gap:10px;padding:8px 12px;border-bottom:1px solid #f3f4f6;font-size:12.5px;
                                ${c.status === 'fail' ? 'background:#fef2f2;' : c.status === 'warn' ? 'background:#fffbeb;' : ''}">
              <span style="color:${col};font-weight:800;width:14px;flex-shrink:0;">${ic}</span>
              <div style="flex:1;min-width:0;">
                <div style="font-weight:700;color:#111827;">${esc(c.name)}</div>
                <div style="color:#374151;line-height:1.5;word-break:break-word;">${esc(c.detail || '')}</div>
                ${c.hint ? `<div style="color:${col};margin-top:2px;">→ ${esc(c.hint)}</div>` : ''}
              </div></div>`;
          }).join('')}</div>`;
        loadHealth();
      } catch (e) {
        out.innerHTML = `<div style="font-size:12.5px;color:#b91c1c;">No se pudo hacer el diagnóstico: ${esc(e.message)}</div>`;
      } finally {
        btn.disabled = false;
      }
    });
    createBtn?.addEventListener('click', () => setTimeout(loadHealth, 1500));

    openBtn.addEventListener('click', () => {
      modal.style.display = '';
      verifyPanel.style.display = 'none';
      restorePanel.style.display = 'none';
      showTab('list');
      loadHealth();
      loadList();
      loadSettings();
    });

    // Sidebar indicator: a coloured dot on the Backups button when the
    // last backup failed or is overdue, so it's noticed without opening it.
    (async () => {
      try {
        const res = await fetch('/admin/api/db/backups/health', { credentials: 'same-origin' });
        if (res.ok) _paintBackupNavDot((await res.json()).level);
      } catch (e) { /* silent */ }
    })();
  }

  function _paintBackupNavDot(level) {
    const btn = document.getElementById('btn-backups');
    if (!btn) return;
    let dot = btn.querySelector('.pv-bk-nav-dot');
    if (level !== 'error' && level !== 'warning') { dot?.remove(); return; }
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'pv-bk-nav-dot';
      dot.style.cssText = 'display:inline-block;width:8px;height:8px;border-radius:50%;margin-left:6px;vertical-align:middle;';
      btn.appendChild(dot);
    }
    dot.style.background = level === 'error' ? '#ef4444' : '#f59e0b';
    dot.title = level === 'error' ? 'Las copias de seguridad no se están haciendo bien' : 'Hay algo que revisar en las copias de seguridad';
  }

  function wireQueryExpansion() {
    const escAttr = (v) => esc(String(v || ''));
    const btn   = document.getElementById('btn-query-expansion');
    const modal = document.getElementById('pv-qx-modal');
    if (!btn || !modal) return;
    const closeBtn = document.getElementById('pv-qx-close');
    const listEl   = document.getElementById('pv-qx-list');
    const filtEl   = document.getElementById('pv-qx-filter');
    const cntEl    = document.getElementById('pv-qx-counts');
    const termEl   = document.getElementById('pv-qx-new-term');
    const expEl    = document.getElementById('pv-qx-new-expansions');
    const kindEl   = document.getElementById('pv-qx-new-kind');
    const addBtn   = document.getElementById('pv-qx-add');
    let items = [];

    function open()  { modal.style.display = 'flex'; refresh(); }
    function close() { modal.style.display = 'none'; }
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', close);

    async function refresh() {
      listEl.innerHTML =
        '<div style="text-align:center;color:#9ca3af;padding:30px;font-size:13px;">Cargando…</div>';
      try {
        const r = await api('/admin/query-expansion/list');
        items = r.items || [];
        render();
      } catch (e) {
        listEl.innerHTML =
          `<div style="color:#b91c1c;padding:14px;font-size:13px;">Error: ${esc(e.message)}</div>`;
      }
    }

    function render() {
      const filter = (filtEl.value || '').trim().toLowerCase();
      const matches = items.filter(it =>
        !filter ||
        it.term.includes(filter) ||
        it.expansions.includes(filter) ||
        it.kind.includes(filter)
      );
      const seedN  = items.filter(it => it.source === 'seed').length;
      const adminN = items.filter(it => it.source === 'admin').length;
      cntEl.textContent =
        `${items.length} entradas · ${seedN} seed · ${adminN} admin` +
        (filter ? ` · ${matches.length} mostradas` : '');
      if (!matches.length) {
        listEl.innerHTML =
          `<div style="text-align:center;color:#9ca3af;padding:24px;font-size:13px;">
             ${filter ? 'Sin coincidencias.' : 'Diccionario vacío.'}
           </div>`;
        return;
      }
      // Single table-like grid for tight scanning.
      listEl.innerHTML = matches.map(it => {
        const srcChip = it.source === 'admin'
          ? `<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:#dcfce7;color:#166534;font-weight:600;">admin</span>`
          : `<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:#e5e7eb;color:#374151;font-weight:600;">seed</span>`;
        const kindChip =
          `<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:#eef2ff;color:#3730a3;font-weight:600;">${esc(it.kind)}</span>`;
        return `
          <div data-term="${escAttr(it.term)}" data-kind="${escAttr(it.kind)}"
               style="display:grid;grid-template-columns:1.5fr 4fr auto auto auto;gap:8px;
                      align-items:center;padding:7px 10px;border-bottom:1px solid #f3f4f6;
                      font-size:12.5px;">
            <div style="font-family:'JetBrains Mono',monospace;font-weight:600;color:#111827;
                        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              ${esc(it.term)}
            </div>
            <div style="color:#4b5563;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
                 title="${escAttr(it.expansions)}">${esc(it.expansions)}</div>
            ${kindChip}
            ${srcChip}
            <button class="pv-qx-row-actions" type="button"
                    title="Editar o borrar"
                    style="background:transparent;border:none;color:#6b7280;cursor:pointer;
                           padding:3px 6px;border-radius:4px;font-size:12px;">⋯</button>
          </div>`;
      }).join('');
      listEl.querySelectorAll('.pv-qx-row-actions').forEach(b => {
        b.addEventListener('click', (ev) => {
          const row = ev.target.closest('[data-term]');
          if (!row) return;
          openRowMenu(row);
        });
      });
    }

    function openRowMenu(row) {
      const term = row.dataset.term;
      const kind = row.dataset.kind;
      const it = items.find(i => i.term === term && i.kind === kind);
      if (!it) return;
      const action = prompt(
        `Entrada: ${term}  (${kind})\n` +
        `Expansiones actuales:\n  ${it.expansions}\n\n` +
        `• Escribe NUEVAS expansiones (coma) para reemplazar.\n` +
        `• Escribe "BORRAR" para eliminar.\n` +
        `• Vacío para cancelar.`,
        it.expansions
      );
      if (action == null || action === '') return;
      if (action.trim().toUpperCase() === 'BORRAR') {
        doDelete(term, kind);
        return;
      }
      doUpsert(term, action.trim(), kind);
    }

    async function doUpsert(term, expansions, kind) {
      try {
        await api('/admin/query-expansion', {
          method: 'POST',
          body: JSON.stringify({term, expansions, kind}),
        });
        refresh();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    async function doDelete(term, kind) {
      if (!confirm(`Borrar "${term}" (${kind})?`)) return;
      try {
        await api('/admin/query-expansion', {
          method: 'DELETE',
          body: JSON.stringify({term, kind}),
        });
        refresh();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    addBtn.addEventListener('click', () => {
      const term = termEl.value.trim();
      const expansions = expEl.value.trim();
      const kind = kindEl.value;
      if (!term || !expansions) {
        alert('Faltan término o expansiones.');
        return;
      }
      doUpsert(term, expansions, kind).then(() => {
        termEl.value = '';
        expEl.value  = '';
        termEl.focus();
      });
    });
    [termEl, expEl].forEach(el => {
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') addBtn.click();
      });
    });
    filtEl.addEventListener('input', render);
  }

  // Opening the modal switches to a tighter 30 s poll so the operator
  // can see status changes nearly in real time.
  function wireAIStatus() {
    const sidebarBtn = document.getElementById('btn-ai-status');
    const modal      = document.getElementById('pv-ai-status-modal');
    const closeBtn   = document.getElementById('pv-ai-status-close');
    const grid       = document.getElementById('pv-ai-status-grid');
    const refreshBtn = document.getElementById('pv-ai-status-refresh');
    const resetBtn   = document.getElementById('pv-ai-status-reset');
    const banner     = document.getElementById('pv-ai-banner');
    const bannerTxt  = document.getElementById('pv-ai-banner-text');

    if (!sidebarBtn || !modal || !banner) return;

    const PROVIDERS = ['anthropic', 'openai', 'gemini', 'voyage', 'unpaywall'];
    const PROVIDER_LABELS = {
      anthropic: 'Anthropic — Claude',
      openai:    'OpenAI — GPT',
      gemini:    'Google — Gemini',
      voyage:    'Voyage — Embeddings',
      unpaywall: 'Unpaywall — Open Access',
    };
    const STATUS_STYLES = {
      ok:               { bg: '#dcfce7', fg: '#166534', label: '✓ Operativo' },
      quota_exhausted:  { bg: '#fee2e2', fg: '#991b1b', label: '✗ Crédito agotado' },
      invalid_key:      { bg: '#fee2e2', fg: '#991b1b', label: '⛔ API key inválida' },
      rate_limited:     { bg: '#fef3c7', fg: '#92400e', label: '⚠ Rate-limited' },
      transient:        { bg: '#fef3c7', fg: '#92400e', label: '⚠ Error transitorio' },
      unknown:          { bg: '#f3f4f6', fg: '#374151', label: '• Sin datos' },
    };

    let bgPoll = null;
    let openPoll = null;

    async function refresh() {
      let snap;
      try {
        snap = await api('/admin/ai-providers-status');
      } catch (e) {
        // Not authenticated as admin, network down — don't spam.
        return null;
      }
      paintBanner(snap);
      if (modal.style.display === 'flex') paintModal(snap);
      return snap;
    }

    function paintBanner(snap) {
      const alerting = (snap.alerting || []);
      if (!alerting.length) {
        banner.style.display = 'none';
        return;
      }
      banner.style.display = 'flex';
      const names = alerting.map(p => PROVIDER_LABELS[p] || p).join(', ');
      bannerTxt.textContent =
        `⚠ ${names} — crédito agotado o API key inválida. Pulsa para ver detalles.`;
    }

    function paintModal(snap) {
      const provs = snap.providers || {};
      grid.innerHTML = PROVIDERS.map(p => {
        const v = provs[p] || {};
        const st = STATUS_STYLES[v.status || 'unknown'] || STATUS_STYLES.unknown;
        const lastOk  = v.last_success_at ? new Date(v.last_success_at).toLocaleString() : '—';
        const lastErr = v.last_error_at   ? new Date(v.last_error_at  ).toLocaleString() : '—';
        const errMsg  = v.last_error
          ? `<div style="margin-top:5px;font-size:11px;color:#7f1d1d;font-family:ui-monospace,monospace;
                         max-height:60px;overflow:auto;background:#fef2f2;
                         padding:5px 7px;border-radius:4px;border:1px solid #fecaca;">${esc(v.last_error)}</div>`
          : '';
        return `
          <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;padding:10px;">
            <div style="font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.04em;font-weight:600;">
              ${esc(PROVIDER_LABELS[p] || p)}
            </div>
            <div style="margin-top:4px;display:inline-flex;padding:3px 9px;border-radius:14px;
                         font-size:11.5px;font-weight:700;background:${st.bg};color:${st.fg};">
              ${esc(st.label)}
            </div>
            <div style="margin-top:8px;font-size:11.5px;color:#374151;line-height:1.5;">
              <div><span style="color:#9ca3af;">Último OK:</span> ${esc(lastOk)}
                ${v.success_count ? `<span style="color:#9ca3af;">(${v.success_count})</span>` : ''}</div>
              <div><span style="color:#9ca3af;">Último error:</span> ${esc(lastErr)}
                ${v.error_count ? `<span style="color:#9ca3af;">(${v.error_count})</span>` : ''}</div>
            </div>
            ${errMsg}
          </div>`;
      }).join('');
    }

    function openModal() {
      modal.style.display = 'flex';
      refresh();
      if (openPoll) clearInterval(openPoll);
      openPoll = setInterval(refresh, 30_000);
    }
    function closeModal() {
      modal.style.display = 'none';
      if (openPoll) { clearInterval(openPoll); openPoll = null; }
    }
    sidebarBtn.addEventListener('click', openModal);
    closeBtn  .addEventListener('click', closeModal);
    modal.querySelector('.pv-modal-backdrop').addEventListener('click', closeModal);
    banner.addEventListener('click', openModal);
    refreshBtn.addEventListener('click', refresh);
    resetBtn.addEventListener('click', async () => {
      if (!confirm('Borrar el historial de éxitos/errores de todos los proveedores?')) return;
      try {
        await api('/admin/ai-providers-status/reset', {
          method: 'POST', body: JSON.stringify({}),
        });
        await refresh();
      } catch (e) { alert('Error: ' + e.message); }
    });

    // Background poll (always running, regardless of modal). 60 s is
    // enough to surface a crédit-exhausted state within ~1 min.
    refresh();
    bgPoll = setInterval(refresh, 60_000);
  }

  // ── Mobile drawer (≤800 px) ────────────────────────────────────────
  // On phones the sidebar lives off-screen as a slide-in drawer; the
  // hamburger button toggles a body class that the CSS media query
  // converts into a translateX. All the open/close affordances stay
  // wired regardless of viewport — they're cheap and don't conflict
  // with anything desktop. On a wide screen the drawer state is
  // simply ignored because the sidebar's mobile rules don't fire.
  function wireMobileDrawer() {
    const btn     = document.getElementById('pv-mobile-menu-btn');
    const sidebar = document.getElementById('pv-sidebar');
    if (!btn || !sidebar) return;
    const KLS = 'pv-mobile-drawer-open';

    const open  = () => document.body.classList.add(KLS);
    const close = () => document.body.classList.remove(KLS);
    const toggle = () => document.body.classList.toggle(KLS);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });

    // Tapping the dark backdrop (outside the sidebar) closes the drawer.
    document.addEventListener('click', (e) => {
      if (!document.body.classList.contains(KLS)) return;
      if (e.target === btn || btn.contains(e.target))     return;
      if (sidebar.contains(e.target))                     return;
      close();
    });

    // Tapping any sidebar nav-button closes the drawer so navigation
    // (e.g. opening a modal) doesn't leave the drawer hovering over
    // the new content. Delay 80 ms so the button's own handler fires
    // first and the drawer slide-out doesn't beat the modal opening.
    sidebar.addEventListener('click', (e) => {
      if (e.target.closest('.pv-nav-btn')) setTimeout(close, 80);
    });

    // ESC closes too — handy on tablets with keyboards.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains(KLS)) close();
    });
  }

  // ── Library Health ──────────────────────────────────────────────────────
  // Global so the sidebar button's inline onclick can call it.
  window.openLibraryHealth = async function openLibraryHealth() {
    const modal = document.getElementById('pv-health-modal');
    const body  = document.getElementById('pv-health-body');
    if (!modal || !body) return;
    modal.style.display = 'flex';
    body.innerHTML = '<p style="color:#6b7280;text-align:center;padding:2rem;">Cargando…</p>';

    let d, chatStats = null;
    try {
      const res = await fetch('/prionvault/api/articles/health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      d = await res.json();
    } catch (err) {
      body.innerHTML = `<p style="color:#ef4444;text-align:center;padding:2rem;">Error al cargar: ${esc(String(err))}</p>`;
      return;
    }
    // Best-effort — the panel still renders fine without the chat stat if this fails.
    try { chatStats = await api('/chats/overview'); } catch (e) { /* ignore */ }

    const total = d.total || 0;
    const pct   = (n) => total > 0 ? ` (${Math.round(n / total * 100)}%)` : '';

    // Close modal and apply filter to main listing
    function applyHealthFilter(params) {
      modal.style.display = 'none';
      // Reset state to avoid stale filters from previous searches
      state.q = ''; state.yearMin = null; state.yearMax = null;
      state.journal = ''; state.authors = ''; state.tagId = null;
      state.hasSummary = null; state.inPrionread = null;
      state.isFlagged = null; state.isMilestone = null;
      state.colorLabel = null; state.priorityEq = null;
      state.extraction = null; state.isFavorite = null; state.isRead = null;
      state.collectionId = null; state.collectionGroup = null; state.collectionSubgroup = null;
      state.hasJc = null; state.jcPresenter = ''; state.jcYear = null;
      state.hasPp = null; state.ppId = ''; state.abstractStatus = ''; state.indexedStatus = '';
      state.hasPdf = null; state.hasDoi = null; state.isJc = null;
      syncMarkFilterButtons();
      state.page = 1;
      // Apply health-specific params by temporarily augmenting buildListParams
      // We do this by storing them in state as _health_ properties (cleaned after fetch).
      state._healthParams = params;
      loadArticles();
    }

    // ── Health modal layout helpers ────────────────────────────────────────
    // card(): single stat tile
    function card(label, value, showPct, filterParams, accent) {
      const num = value ?? 0;
      const pctStr = showPct ? ` <span style="font-size:11px;color:#9ca3af;">${pct(num)}</span>` : '';
      const fp = filterParams ? JSON.stringify(filterParams) : null;
      const bg = accent === 'good'   ? '#f0fdf4'
               : accent === 'warn'   ? '#fff7ed'
               : accent === 'bad'    ? '#fef2f2'
               : accent === 'purple' ? '#f5f3ff'
               : '#f9fafb';
      const numColor = accent === 'good'   ? '#15803d'
                     : accent === 'warn'   ? '#c2410c'
                     : accent === 'bad'    ? '#dc2626'
                     : accent === 'purple' ? '#6d28d9'
                     : '#111827';
      const border = accent === 'good'   ? '#bbf7d0'
                   : accent === 'warn'   ? '#fde68a'
                   : accent === 'bad'    ? '#fecaca'
                   : accent === 'purple' ? '#ddd6fe'
                   : '#e5e7eb';
      const interactive = fp ? `onclick='window._pvHealthFilter(${fp})'
        onmouseenter="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.12)';this.style.transform='translateY(-1px)'"
        onmouseleave="this.style.boxShadow='none';this.style.transform=''"` : '';
      return `<div ${interactive}
               style="background:${bg};border:1px solid ${border};border-radius:10px;
                      padding:12px 14px;display:flex;flex-direction:column;gap:3px;
                      transition:box-shadow 0.15s,transform 0.15s;
                      ${fp ? 'cursor:pointer;' : ''}">
        <span style="font-size:21px;font-weight:700;color:${numColor};line-height:1.1;">${num.toLocaleString()}${pctStr}</span>
        <span style="font-size:11.5px;color:#6b7280;line-height:1.3;">${label}</span>
      </div>`;
    }

    // row(cols): a grid row with a fixed number of columns
    function row(cols, items) {
      return `<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:8px;margin-bottom:8px;">${items.join('')}</div>`;
    }

    // section(): titled block, no forced column count (caller uses row())
    function section(title, inner) {
      return `<div style="margin-bottom:20px;">
        <h3 style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;
                   color:#9ca3af;margin:0 0 8px;padding-bottom:6px;border-bottom:1px solid #f3f4f6;">${title}</h3>
        ${inner}
      </div>`;
    }

    // Total hero
    const heroCard = `<div style="text-align:center;background:#f0f4ff;border:1px solid #c7d2fe;
                          border-radius:12px;padding:16px 24px;margin-bottom:20px;">
      <div style="font-size:36px;font-weight:800;color:#3730a3;line-height:1;">${(d.total??0).toLocaleString()}</div>
      <div style="font-size:13px;color:#6b7280;margin-top:4px;">artículos en la biblioteca</div>
    </div>`;

    // Provider badge helper for summary section labels
    const provLabels = {
      anthropic: '✦ Claude',
      openai:    '⬡ GPT',
      gemini:    '◈ Gemini',
    };
    const provColors = {
      anthropic: { bg:'#ede9fe', color:'#5b21b6', border:'#ddd6fe' },
      openai:    { bg:'#dcfce7', color:'#15803d', border:'#bbf7d0' },
      gemini:    { bg:'#dbeafe', color:'#1d4ed8', border:'#bfdbfe' },
    };
    // Pricing per 1M tokens (input / output) in USD
    const provPricing = {
      anthropic: { in: 3.0,  out: 15.0  },
      openai:    { in: 2.0,  out: 8.0   },
      gemini:    { in: 1.25, out: 10.0  },
    };
    const provTokenKeys = {
      anthropic: ['tokens_claude_in',  'tokens_claude_out'],
      openai:    ['tokens_gpt_in',     'tokens_gpt_out'],
      gemini:    ['tokens_gemini_in',  'tokens_gemini_out'],
    };
    function provCard(prov, count, filterVal) {
      const c = provColors[prov] || { bg:'#f3f4f6', color:'#374151', border:'#e5e7eb' };
      const lbl = provLabels[prov] || prov;
      const fp = JSON.stringify({ summary_ai_provider: filterVal });
      const pctStr = `<span style="font-size:11px;color:#9ca3af;"> ${pct(count)}</span>`;

      let tokenLine = '';
      const tk = provTokenKeys[prov];
      const pr = provPricing[prov];
      if (tk && pr) {
        const tin  = d[tk[0]] || 0;
        const tout = d[tk[1]] || 0;
        if (tin || tout) {
          const total = tin + tout;
          const cost  = (tin * pr.in + tout * pr.out) / 1_000_000;
          const fmtTk = total >= 1_000_000
            ? (total / 1_000_000).toFixed(2) + 'M tk'
            : total >= 1000
              ? (total / 1000).toFixed(1) + 'k tk'
              : total + ' tk';
          tokenLine = `<span style="font-size:10.5px;color:${c.color};opacity:0.75;margin-top:1px;">
            ${fmtTk} · $${cost.toFixed(3)}</span>`;
        }
      }

      return `<div onclick='window._pvHealthFilter(${fp})'
               onmouseenter="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.12)';this.style.transform='translateY(-1px)'"
               onmouseleave="this.style.boxShadow='none';this.style.transform=''"
               style="background:${c.bg};border:1px solid ${c.border};border-radius:10px;
                      padding:12px 14px;cursor:pointer;transition:box-shadow 0.15s,transform 0.15s;
                      display:flex;flex-direction:column;gap:3px;">
        <span style="font-size:21px;font-weight:700;color:${c.color};line-height:1.1;">${(count??0).toLocaleString()}${pctStr}</span>
        <span style="font-size:11.5px;color:${c.color};font-weight:600;">${lbl}</span>
        ${tokenLine}
      </div>`;
    }

    const completenessBtn = `<div id="pv-completeness-btn" onclick="window._pvShowCompleteness()"
      onmouseenter="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.12)';this.style.transform='translateY(-1px)'"
      onmouseleave="this.style.boxShadow='none';this.style.transform=''"
      style="display:flex;align-items:center;justify-content:space-between;
             background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;
             padding:14px 18px;margin-bottom:16px;cursor:pointer;
             transition:box-shadow 0.15s,transform 0.15s;">
      <span style="font-size:13.5px;font-weight:600;color:#1d4ed8;">🗂 Completitud de metadatos</span>
      <span style="font-size:18px;color:#3b82f6;font-weight:700;">→</span>
    </div>`;

    const chatsBtn = chatStats ? `<div onclick="window.openChatsOverview()"
      onmouseenter="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.12)';this.style.transform='translateY(-1px)'"
      onmouseleave="this.style.boxShadow='none';this.style.transform=''"
      style="display:flex;align-items:center;justify-content:space-between;
             background:#f5f3ff;border:1px solid #ddd6fe;border-radius:10px;
             padding:14px 18px;margin-bottom:16px;cursor:pointer;
             transition:box-shadow 0.15s,transform 0.15s;">
      <span style="font-size:13.5px;font-weight:600;color:#6d28d9;">
        💬 Chats con IA por artículo
        <span style="font-weight:700;">— ${(chatStats.articles_with_chat||0).toLocaleString()} / ${(chatStats.total_articles||0).toLocaleString()}</span>
      </span>
      <span style="font-size:18px;color:#7c3aed;font-weight:700;">→</span>
    </div>` : '';

    body.style.position = 'relative';

    body.innerHTML =
      heroCard +
      completenessBtn +
      chatsBtn +

      section('Contenido', [
        row(2, [card('Con PDF',    d.with_pdf,    true, {has_pdf:'true'},  'good'),
                card('Sin PDF',    d.without_pdf, true, {has_pdf:'false'}, 'warn')]),
        row(2, [card('Con DOI',    d.with_doi,    true, {has_doi:'true'},  'good'),
                card('Sin DOI',    d.without_doi, true, {has_doi:'false'}, 'purple')]),
        row(2, [card('Con PMID',   d.with_pmid,   true, {has_pmid:'true'}, 'good'),
                card('Sin PMID',   d.without_pmid,true, {has_pmid:'false'},'purple')]),
        row(2, [card('Con abstract',    d.with_abstract,    true, {abstract_status:'has'},     'good'),
                card('Sin abstract',    d.without_abstract, true, {abstract_status:'pending'}, 'warn')]),
      ].join('')) +

      section('PDF & OCR', [
        row(3, [card('PDFs escaneados (OCR)',  d.pdf_ocr,              true, {pdf_is_scan:'true'},    ''),
                card('PDFs buscables',         d.pdf_searchable,       true, {pdf_searchable:'true'}, 'good'),
                card('Necesitan buscable',     d.pdf_needs_searchable, true, {pdf_searchable:'needs'},'warn')]),
        row(2, [card('Con nº de páginas', d.with_page_count,    true, null, ''),
                card('Sin nº de páginas', d.missing_page_count, true, null, 'warn')]),
        row(2, [card('Fuente: PubMed Inventory', d.from_inventory, true, {source:'pubmed_inventory'}, ''),
                card('Fuente: manual',           d.from_manual,    true, {source:'manual'}, '')]),
      ].join('')) +

      section('Procesamiento & Indexación', [
        row(3, [card('Texto extraído',       d.text_extracted, true, {extraction_status:'extracted'}, 'good'),
                card('Extracción pendiente', d.text_pending,   true, {extraction_status:'pending'},   'warn'),
                card('Extracción fallida',   d.text_failed,    true, {extraction_status:'failed'},    'bad')]),
        row(2, [card(`Indexados (${d.embed_model || 'IA'})`, d.indexed,       true, {indexed_status:'yes'},  'good'),
                card('Necesitan indexación',                  d.needs_indexing,true, {needs_indexing:'true'}, 'warn')]),
      ].join('')) +

      section('Resúmenes IA', (() => {
        // Always show total pair
        let html = row(3, [card('Con resumen IA',  d.with_summary_ai, true, {has_summary:'ai'}, 'good'),
                           card('Sin resumen IA',  Math.max(0, (d.total||0) - (d.with_summary_ai||0)), true, {has_summary_ai:'false'}, 'warn'),
                           card('Con resumen humano', d.with_summary_human, true, {has_summary_human:'true'}, 'good')]);
        // Per-provider breakdown (only if at least one has data)
        const provRows = [];
        if (d.summary_by_claude > 0) provRows.push(provCard('anthropic', d.summary_by_claude, 'anthropic'));
        if (d.summary_by_gpt    > 0) provRows.push(provCard('openai',    d.summary_by_gpt,    'openai'));
        if (d.summary_by_gemini > 0) provRows.push(provCard('gemini',    d.summary_by_gemini, 'gemini'));
        if (d.summary_by_unknown > 0) {
          const fp = JSON.stringify({ summary_ai_provider: 'unknown' });
          provRows.push(`<div onclick='window._pvHealthFilter(${fp})'
            onmouseenter="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.12)'"
            onmouseleave="this.style.boxShadow='none'"
            style="background:#f3f4f6;border:1px solid #e5e7eb;border-radius:10px;
                   padding:12px 14px;cursor:pointer;transition:box-shadow 0.15s;
                   display:flex;flex-direction:column;gap:3px;">
            <span style="font-size:21px;font-weight:700;color:#374151;line-height:1.1;">${(d.summary_by_unknown??0).toLocaleString()}</span>
            <span style="font-size:11.5px;color:#6b7280;">Sin proveedor registrado</span>
          </div>`);
        }
        if (provRows.length) html += row(Math.min(provRows.length, 3), provRows);
        if (d.with_summary_notes > 0) {
          html += row(1, [card('⚠ Con errores/notas en resumen', d.with_summary_notes, true, {has_summary_notes:'true'}, 'bad')]);
        }
        return html;
      })()) +

      section('🔍 Verificación PDF ↔ metadatos', [
        row(2, [card('✗ Mismatches',  d.verify_mismatch, true, {pdf_verify_status:'mismatch'}, 'bad'),
                card('⚠ Sospechosos', d.verify_suspect,  true, {pdf_verify_status:'suspect'},  'warn')]),
        row(2, [card('✓ Match OK',                d.verify_ok,      true, {pdf_verify_status:'ok_any'},     'good'),
                card('Sin verificar (con PDF)',    d.verify_pending, true, {pdf_verify_status:'unverified'}, '')]),
      ].join(''));

    // Sub-panel: completeness breakdown
    window._pvShowCompleteness = function() {
      const existing = document.getElementById('pv-completeness-panel');
      if (existing) existing.remove();

      const fields = [
        { label: 'Título',    key: 'missing_title',    filter: {has_title:'false'},           accent: d.missing_title   > 0 ? 'warn'   : 'good' },
        { label: 'Autores',   key: 'missing_authors',  filter: {has_authors:'false'},         accent: d.missing_authors > 0 ? 'warn'   : 'good' },
        { label: 'Revista',   key: 'missing_journal',  filter: {has_journal:'false'},         accent: d.missing_journal > 0 ? 'warn'   : 'good' },
        { label: 'Año',       key: 'missing_year',     filter: {has_year:'false'},            accent: d.missing_year    > 0 ? 'warn'   : 'good' },
        { label: 'Abstract',  key: 'missing_abstract', filter: {abstract_status:'pending'},   accent: d.missing_abstract > 0 ? 'warn'  : 'good' },
        { label: 'DOI',       key: 'missing_doi',      filter: {has_doi:'false'},             accent: d.missing_doi     > 0 ? 'purple' : 'good' },
        { label: 'PMID',      key: 'missing_pmid',     filter: {has_pmid:'false'},            accent: d.missing_pmid    > 0 ? 'purple' : 'good' },
      ];

      const fieldCards = fields.map(f => card('Sin ' + f.label, d[f.key] ?? 0, true, f.filter, f.accent)).join('');
      const gridRows = [];
      for (let i = 0; i < fields.length; i += 2) {
        const pair = fields.slice(i, i + 2);
        gridRows.push(`<div style="display:grid;grid-template-columns:repeat(${pair.length},1fr);gap:8px;margin-bottom:8px;">${
          pair.map(f => card('Sin ' + f.label, d[f.key] ?? 0, true, f.filter, f.accent)).join('')
        }</div>`);
      }

      const panel = document.createElement('div');
      panel.id = 'pv-completeness-panel';
      panel.style.cssText = 'position:absolute;inset:0;background:#fff;z-index:10;border-radius:inherit;display:flex;flex-direction:column;overflow:hidden;';
      panel.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid #f3f4f6;flex-shrink:0;">
          <button onclick="document.getElementById('pv-completeness-panel').remove()"
            style="background:none;border:1px solid #e5e7eb;border-radius:8px;padding:5px 12px;
                   cursor:pointer;font-size:13px;color:#374151;font-weight:600;">← Atrás</button>
          <div>
            <div style="font-size:14px;font-weight:700;color:#111827;">Artículos con metadatos incompletos</div>
            <div style="font-size:11.5px;color:#9ca3af;">Haz clic en un campo para ver los artículos afectados</div>
          </div>
        </div>
        <div style="flex:1;overflow-y:auto;padding:18px;">
          <div style="text-align:center;background:#f0f4ff;border:1px solid #c7d2fe;border-radius:12px;
                      padding:14px 24px;margin-bottom:16px;">
            <div style="font-size:32px;font-weight:800;color:#3730a3;line-height:1;">${(d.total??0).toLocaleString()}</div>
            <div style="font-size:12px;color:#6b7280;margin-top:3px;">artículos totales</div>
          </div>
          ${gridRows.join('')}
        </div>
      `;
      body.appendChild(panel);
    };

    // Wire up click handler for health filters
    window._pvHealthFilter = function(params) {
      modal.style.display = 'none';
      // Reset state
      Object.assign(state, {
        q: '', yearMin: null, yearMax: null, journal: '', authors: '',
        tagId: null, hasSummary: null, inPrionread: null, isFlagged: null,
        isMilestone: null, colorLabel: null, priorityEq: null, extraction: null,
        isFavorite: null, isRead: null, isJc: null, collectionId: null, collectionGroup: null,
        collectionSubgroup: null, hasJc: null, jcPresenter: '', jcYear: null,
        hasPp: null, ppId: '', abstractStatus: '', indexedStatus: '', hasPdf: null, hasDoi: null, page: 1,
      });

      // Apply known filter params that map to state fields
      if (params.has_summary)       state.hasSummary    = params.has_summary;
      if (params.abstract_status)   state.abstractStatus = params.abstract_status;
      if (params.indexed_status)    state.indexedStatus  = params.indexed_status;
      if (params.extraction_status) state.extraction     = params.extraction_status;

      // For params the state doesn't have native slots for, store as _healthExtra
      // and patch buildListParams temporarily
      const extra = {};
      for (const k of ['has_pdf','has_doi','has_pmid','has_title','has_authors','has_journal','has_year',
                        'pdf_is_scan','pdf_searchable',
                        'source','needs_indexing','has_summary_ai','has_summary_human','has_summary_notes',
                        'pdf_verify_status','summary_ai_provider']) {
        if (params[k] !== undefined) extra[k] = params[k];
      }
      state._healthExtra = Object.keys(extra).length ? extra : null;

      syncMarkFilterButtons();
      loadArticles();
    };

  };

  document.addEventListener('DOMContentLoaded', init);
})();

// Cart badge for PrionVault (pp-cart.js loaded before this script)
