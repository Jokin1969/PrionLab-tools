/**
 * PrionVault Extension — Panel UI
 *
 * Runs inside panel.html which is loaded as an iframe by content.js.
 * Since panel.html is served from chrome-extension://, chrome.runtime
 * is fully available here.
 */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  doi:       null,
  pmid:      null,
  pdfUrl:    null,
  pageTitle: null,
  meta:      null,      // resolved metadata from server
  serverId:  null,      // article id if already in library
  serverUrl: null,      // base URL of the PrionVault instance
};

// ── DOM helpers ───────────────────────────────────────────────────────────────

const body = document.getElementById('pv-body');

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, resp => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (resp && resp.error) return reject(new Error(resp.error));
      resolve(resp);
    });
  });
}

function postToParent(msg) {
  window.parent.postMessage({ source: 'prionvault-panel', ...msg }, '*');
}

// ── Render helpers ────────────────────────────────────────────────────────────

function renderLoading(msg = 'Buscando metadatos…') {
  body.innerHTML = `
    <div class="pv-state">
      <div class="pv-spinner"></div>
      <p>${esc(msg)}</p>
    </div>`;
}

function renderNoArticle() {
  body.innerHTML = `
    <div class="pv-state">
      <div class="pv-icon">📄</div>
      <p><strong>No se detectó ningún artículo</strong></p>
      <p>Navega hasta la página de un artículo científico con DOI o PMID para poder añadirlo.</p>
    </div>`;
}

function renderError(msg) {
  body.innerHTML = `
    <div class="pv-state">
      <div class="pv-icon">⚠️</div>
      <p><strong>Error</strong></p>
      <div class="pv-error">${esc(msg)}</div>
    </div>`;
}

function renderNotConfigured() {
  body.innerHTML = `
    <div class="pv-state">
      <div class="pv-icon">⚙️</div>
      <p><strong>Extensión no configurada</strong></p>
      <p>Haz clic en el icono de PrionVault en la barra del navegador y rellena la URL del servidor y la API key.</p>
    </div>`;
}

function renderArticle(meta, duplicateOf) {
  const authors = formatAuthors(meta.authors);
  const hasPdf  = Boolean(state.pdfUrl);

  const alreadyIn = duplicateOf ? `
    <div class="pv-already-in">
      <span class="pv-badge pv-badge-green">✓ Ya está en la biblioteca</span>
      ${state.serverUrl ? `<a class="pv-view-link" href="${esc(state.serverUrl)}/prionvault/?open=${esc(duplicateOf)}" target="_blank">Ver en PrionVault →</a>` : ''}
    </div>` : '';

  const actions = duplicateOf ? '' : `
    <div class="pv-actions" id="pv-actions">
      <button class="pv-btn pv-btn-primary" id="pv-add">
        + Añadir a PrionVault
      </button>
      ${hasPdf ? `
        <button class="pv-btn pv-btn-secondary" id="pv-add-pdf">
          📄 Añadir con PDF
        </button>
        <p class="pv-pdf-hint">Solo funciona con PDFs de acceso abierto o si tienes acceso institucional.</p>
      ` : ''}
    </div>`;

  const abstractHtml = meta.abstract ? `
    <div class="pv-abstract-section">
      <div class="pv-abstract-label">ABSTRACT</div>
      <div class="pv-abstract-text" id="pv-abstract">
        ${esc(meta.abstract)}
        <div class="pv-abstract-fade"></div>
      </div>
      <button class="pv-abstract-toggle" id="pv-abstract-toggle">Ver más ▾</button>
    </div>` : '';

  body.innerHTML = `
    <div class="pv-card">
      <div class="pv-card-body">
        <p class="pv-article-title">${esc(meta.title)}</p>

        ${authors ? `<div class="pv-meta-row">
          <span class="pv-meta-label">Autores</span>
          <span class="pv-meta-value">${esc(authors)}</span>
        </div>` : ''}

        ${(meta.year || meta.journal) ? `<div class="pv-meta-row">
          <span class="pv-meta-label">Revista</span>
          <span class="pv-meta-value">${esc([meta.year, meta.journal].filter(Boolean).join(' · '))}</span>
        </div>` : ''}

        ${meta.doi ? `<div class="pv-meta-row">
          <span class="pv-meta-label">DOI</span>
          <span class="pv-meta-value">
            <a href="https://doi.org/${esc(meta.doi)}" target="_blank">${esc(meta.doi)}</a>
          </span>
        </div>` : ''}

        ${meta.pubmed_id ? `<div class="pv-meta-row">
          <span class="pv-meta-label">PMID</span>
          <span class="pv-meta-value">
            <a href="https://pubmed.ncbi.nlm.nih.gov/${esc(meta.pubmed_id)}/" target="_blank">${esc(meta.pubmed_id)}</a>
          </span>
        </div>` : ''}

        ${abstractHtml}

        ${meta.source ? `<div class="pv-source-tag">Fuente: ${esc(meta.source)}</div>` : ''}
      </div>
    </div>

    ${alreadyIn}
    ${actions}
    <div id="pv-action-result"></div>
  `;

  // Abstract toggle
  const abstractEl = document.getElementById('pv-abstract');
  const toggleEl   = document.getElementById('pv-abstract-toggle');
  if (abstractEl && toggleEl) {
    // Only show toggle if text overflows
    if (abstractEl.scrollHeight <= 120) {
      toggleEl.style.display = 'none';
      const fade = abstractEl.querySelector('.pv-abstract-fade');
      if (fade) fade.style.display = 'none';
    }
    toggleEl.addEventListener('click', () => {
      abstractEl.classList.toggle('expanded');
      toggleEl.textContent = abstractEl.classList.contains('expanded') ? 'Ver menos ▴' : 'Ver más ▾';
    });
  }

  // Add buttons
  document.getElementById('pv-add')?.addEventListener('click', () => addArticle(false));
  document.getElementById('pv-add-pdf')?.addEventListener('click', () => addArticle(true));
}

function renderSuccess(articleId, withPdf) {
  const viewUrl = state.serverUrl
    ? `${state.serverUrl}/prionvault/?open=${encodeURIComponent(articleId)}`
    : null;

  document.getElementById('pv-action-result').innerHTML = `
    <div class="pv-success">
      <div class="pv-checkmark">✓</div>
      <h3>¡Añadido correctamente!</h3>
      <p>${withPdf ? 'Artículo y PDF guardados.' : 'Artículo añadido con metadatos.'}</p>
      ${viewUrl ? `<a href="${esc(viewUrl)}" target="_blank">Ver en PrionVault →</a>` : ''}
    </div>`;

  document.getElementById('pv-actions')?.remove();
}

// ── Article add logic ─────────────────────────────────────────────────────────

async function addArticle(withPdf) {
  const meta = state.meta;
  if (!meta) return;

  const addBtn    = document.getElementById('pv-add');
  const pdfBtn    = document.getElementById('pv-add-pdf');
  const resultEl  = document.getElementById('pv-action-result');

  [addBtn, pdfBtn].forEach(b => b && (b.disabled = true));
  resultEl.innerHTML = '';

  const metadata = {
    title:     meta.title,
    authors:   meta.authors,
    year:      meta.year,
    journal:   meta.journal,
    doi:       meta.doi,
    pubmed_id: meta.pubmed_id,
    abstract:  meta.abstract,
    source:    'extension',
  };

  try {
    if (withPdf && state.pdfUrl) {
      // Try to get PDF bytes: first via background (OA PDFs),
      // then via content script (publisher-gated PDFs with session cookies).
      let pdfBytes = null;
      let filename  = (state.pdfUrl.split('/').pop() || 'article.pdf').split('?')[0];
      if (!filename.endsWith('.pdf')) filename += '.pdf';

      try {
        // Background fetch (works for OA — no auth cookies)
        const bkg = await send({ type: 'FETCH_PDF', url: state.pdfUrl });
        pdfBytes = bkg.bytes;
      } catch (_) {
        // Fallback: ask the content script to fetch with page credentials
        pdfBytes = await fetchPdfViaPage(state.pdfUrl);
      }

      if (!pdfBytes || pdfBytes.length < 100) {
        throw new Error('No se pudo descargar el PDF. Prueba a añadirlo sin PDF.');
      }

      const result = await send({ type: 'CREATE_WITH_PDF', metadata, pdfBytes, filename });
      if (result.duplicate) {
        resultEl.innerHTML = `<div class="pv-already-in"><span class="pv-badge pv-badge-orange">⚠ Artículo ya existente</span></div>`;
        return;
      }
      renderSuccess(result.id, true);

    } else {
      const result = await send({ type: 'CREATE', metadata });
      if (result.duplicate) {
        resultEl.innerHTML = `<div class="pv-already-in"><span class="pv-badge pv-badge-orange">⚠ Artículo ya existente</span></div>`;
        return;
      }
      renderSuccess(result.id, false);
    }
  } catch (err) {
    resultEl.innerHTML = `<div class="pv-error">Error: ${esc(err.message)}</div>`;
    [addBtn, pdfBtn].forEach(b => b && (b.disabled = false));
  }
}

// Ask the content script (which has page credentials) to fetch the PDF.
function fetchPdfViaPage(url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Tiempo de espera agotado al descargar PDF.')), 30000);

    function onMsg(e) {
      if (!e.data || e.data.source !== 'prionvault-content') return;
      if (e.data.type === 'PDF_BYTES') {
        clearTimeout(timeout);
        window.removeEventListener('message', onMsg);
        resolve(e.data.bytes);
      } else if (e.data.type === 'PDF_ERROR') {
        clearTimeout(timeout);
        window.removeEventListener('message', onMsg);
        reject(new Error(e.data.error));
      }
    }
    window.addEventListener('message', onMsg);
    postToParent({ type: 'FETCH_PDF_PAGE', url });
  });
}

// ── Format helpers ────────────────────────────────────────────────────────────

function formatAuthors(authors) {
  if (!authors) return '';
  if (typeof authors === 'string') return authors;
  if (Array.isArray(authors)) {
    const names = authors.slice(0, 3).map(a => {
      if (typeof a === 'string') return a;
      const given  = (a.given  || a.first  || '').trim();
      const family = (a.family || a.last   || '').trim();
      return (given ? given.charAt(0) + '. ' : '') + family || a.name || '';
    }).filter(Boolean);
    return names.join(', ') + (authors.length > 3 ? ' et al.' : '');
  }
  return String(authors);
}

// ── Init: listen for INIT message from content script ────────────────────────

window.addEventListener('message', async (e) => {
  if (!e.data || e.data.source !== 'prionvault-content') return;
  if (e.data.type !== 'INIT') return;

  state.doi       = e.data.doi   || null;
  state.pmid      = e.data.pmid  || null;
  state.pdfUrl    = e.data.pdfUrl || null;
  state.pageTitle = e.data.pageTitle || null;

  // Load server URL for "View in PrionVault" links
  try {
    const settings = await send({ type: 'GET_SETTINGS' });
    state.serverUrl = (settings.serverUrl || '').replace(/\/+$/, '');
    if (!settings.serverUrl || !settings.apiKey) {
      renderNotConfigured();
      return;
    }
  } catch (_) {
    renderNotConfigured();
    return;
  }

  if (!state.doi && !state.pmid) {
    renderNoArticle();
    return;
  }

  renderLoading('Consultando CrossRef y PubMed…');

  try {
    const resp = await send({ type: 'LOOKUP', doi: state.doi, pmid: state.pmid });

    if (!resp.found || !resp.metadata || !resp.metadata.title) {
      // Not found in CrossRef/PubMed — offer manual add with minimal data
      const fallback = {
        title:     state.pageTitle || 'Artículo sin título',
        doi:       state.doi,
        pubmed_id: state.pmid,
      };
      state.meta = fallback;
      renderArticle(fallback, null);
      return;
    }

    state.meta     = resp.metadata;
    state.serverId = resp.duplicate_of || null;
    renderArticle(resp.metadata, resp.duplicate_of || null);

  } catch (err) {
    if (err.message.includes('configurado')) {
      renderNotConfigured();
    } else {
      renderError(err.message);
    }
  }
});

// Close button
document.getElementById('pv-close').addEventListener('click', () => {
  postToParent({ type: 'CLOSE' });
});
