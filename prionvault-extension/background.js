/**
 * PrionVault Extension — Background Service Worker
 *
 * Handles all API calls to the PrionVault server. Content scripts and
 * the panel page communicate with this worker via chrome.runtime.sendMessage.
 *
 * All fetch() calls originate from here so the extension's host_permissions
 * bypass CORS — no server-side CORS headers needed.
 */

async function getSettings() {
  return new Promise(resolve =>
    chrome.storage.sync.get({ serverUrl: '', apiKey: '' }, resolve)
  );
}

async function apiRequest(path, options = {}) {
  const { serverUrl, apiKey } = await getSettings();
  if (!serverUrl || !apiKey) {
    throw new Error(
      'PrionVault no está configurado. Haz clic en el icono de la extensión y ' +
      'rellena la URL del servidor y la API key.'
    );
  }

  const url = serverUrl.replace(/\/+$/, '') + path;
  const headers = {
    'X-PrionVault-Key': apiKey,
    ...(options.headers || {}),
  };

  const resp = await fetch(url, { ...options, headers });
  return resp;
}

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message || String(err) }));
  return true; // keep port open for async response
});

async function handleMessage(msg) {
  switch (msg.type) {

    // ── Lookup metadata for a DOI or PMID ─────────────────────────────────
    case 'LOOKUP': {
      const body = {};
      if (msg.doi)  body.doi       = msg.doi;
      if (msg.pmid) body.pubmed_id = msg.pmid;
      const resp = await apiRequest('/prionvault/api/articles/lookup', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      return data;
    }

    // ── Create article (metadata only) ─────────────────────────────────────
    case 'CREATE': {
      const resp = await apiRequest('/prionvault/api/articles/create', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(msg.metadata),
      });
      const data = await resp.json();
      if (!resp.ok) {
        if (resp.status === 409) return { duplicate: true, ...data };
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      return data;
    }

    // ── Create article + upload PDF (bytes passed from content script) ─────
    case 'CREATE_WITH_PDF': {
      // msg.pdfBytes is a plain Array (serialisable over postMessage)
      const blob     = new Blob([new Uint8Array(msg.pdfBytes)], { type: 'application/pdf' });
      const formData = new FormData();
      formData.append('pdf', blob, msg.filename || 'article.pdf');
      formData.append('metadata', JSON.stringify(msg.metadata));

      const resp = await apiRequest('/prionvault/api/articles/with-pdf', {
        method: 'POST',
        body:   formData,
      });
      const data = await resp.json();
      if (!resp.ok) {
        if (resp.status === 409) return { duplicate: true, ...data };
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      return data;
    }

    // ── Fetch PDF bytes from a URL (background can bypass CORS for OA PDFs) ─
    case 'FETCH_PDF': {
      const resp = await fetch(msg.url);
      if (!resp.ok) throw new Error(`No se pudo descargar el PDF (HTTP ${resp.status})`);
      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('pdf')) {
        throw new Error('La URL no devolvió un PDF válido.');
      }
      const arrayBuf = await resp.arrayBuffer();
      return { bytes: Array.from(new Uint8Array(arrayBuf)) };
    }

    // ── Settings ───────────────────────────────────────────────────────────
    case 'GET_SETTINGS':
      return getSettings();

    case 'SAVE_SETTINGS':
      return new Promise(resolve =>
        chrome.storage.sync.set({ serverUrl: msg.serverUrl, apiKey: msg.apiKey },
          () => resolve({ ok: true }))
      );

    default:
      throw new Error('Tipo de mensaje desconocido: ' + msg.type);
  }
}
