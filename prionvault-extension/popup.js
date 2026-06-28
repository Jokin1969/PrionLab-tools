'use strict';

const serverInput = document.getElementById('server-url');
const apiKeyInput = document.getElementById('api-key');
const saveBtn     = document.getElementById('save-btn');
const saveMsg     = document.getElementById('save-msg');
const statusEl    = document.getElementById('status-text');
const openBtn     = document.getElementById('open-panel-btn');
const toggleBtn   = document.getElementById('toggle-key');

// ── Load saved settings ───────────────────────────────────────────────────────

chrome.storage.sync.get({ serverUrl: '', apiKey: '' }, ({ serverUrl, apiKey }) => {
  serverInput.value = serverUrl;
  apiKeyInput.value = apiKey;
  if (serverUrl && apiKey) checkConnection(serverUrl, apiKey);
  else setStatus('not-configured', 'No configurado');
});

// ── Save settings ─────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', async () => {
  const serverUrl = serverInput.value.trim().replace(/\/+$/, '');
  const apiKey    = apiKeyInput.value.trim();

  if (!serverUrl) { showMsg('Introduce la URL del servidor.', true); return; }
  if (!apiKey)    { showMsg('Introduce la API key.',            true); return; }

  await new Promise(resolve =>
    chrome.storage.sync.set({ serverUrl, apiKey }, resolve)
  );
  showMsg('✓ Guardado');
  checkConnection(serverUrl, apiKey);
});

// ── Connection check ──────────────────────────────────────────────────────────

async function checkConnection(serverUrl, apiKey) {
  setStatus('checking', 'Comprobando conexión…');
  try {
    const url  = serverUrl.replace(/\/+$/, '') + '/prionvault/api/articles/lookup';
    const resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-PrionVault-Key': apiKey },
      body:    JSON.stringify({ doi: '10.0000/test' }),
    });
    // 400 = server understood us (bad DOI), 401/403 = wrong key, 200 = found somehow
    if (resp.status === 400 || resp.status === 200) {
      setStatus('ok', '✓ Conectado');
    } else if (resp.status === 401 || resp.status === 403) {
      setStatus('error', '✗ API key incorrecta');
    } else {
      setStatus('error', `✗ HTTP ${resp.status}`);
    }
  } catch (err) {
    setStatus('error', `✗ No se pudo conectar`);
  }
}

function setStatus(type, text) {
  statusEl.textContent = text;
  statusEl.className   = type === 'ok'       ? 'status-ok'
                       : type === 'error'    ? 'status-error'
                       : type === 'checking' ? 'status-checking'
                       : 'status-checking';
}

function showMsg(text, isError = false) {
  saveMsg.textContent = text;
  saveMsg.style.color = isError ? '#c53030' : '#276749';
  setTimeout(() => { saveMsg.textContent = ''; }, 3000);
}

// ── Toggle API key visibility ─────────────────────────────────────────────────

toggleBtn.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
});

// ── Open/close panel in current tab ──────────────────────────────────────────

openBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
  window.close();
});
