/**
 * PrionVault Extension — Content Script
 *
 * Injected into every page. Detects DOIs and PMIDs, injects the sidebar
 * panel as an <iframe>, and acts as a message relay between the panel and
 * the background service worker.
 */

(function () {
  'use strict';

  if (location.protocol === 'chrome-extension:' ||
      location.protocol === 'moz-extension:' ||
      location.protocol === 'about:') return;

  let panel = null;
  let detected = null;

  // ── DOI / PMID detection ──────────────────────────────────────────────────

  const DOI_RE = /\b(10\.\d{4,}[/\w.;()\-:+#]+[\w)])/;

  function fromMeta() {
    const result = { doi: null, pmid: null };

    const doiMeta = document.querySelector(
      'meta[name="citation_doi"], ' +
      'meta[name="DC.Identifier"][content*="10."], ' +
      'meta[name="dc.identifier"][content*="10."], ' +
      'meta[property="og:doi"]'
    );
    if (doiMeta) {
      const v = (doiMeta.content || doiMeta.getAttribute('content') || '');
      const m = v.match(DOI_RE);
      if (m) result.doi = m[1];
    }

    const pmidMeta = document.querySelector(
      'meta[name="citation_pmid"], meta[name="citation_medline_id"]'
    );
    if (pmidMeta) {
      const v = (pmidMeta.content || '').trim();
      if (/^\d{5,8}$/.test(v)) result.pmid = v;
    }

    return result;
  }

  function fromUrl() {
    const result = { doi: null, pmid: null };
    const url = location.href;

    const doiUrl = url.match(/doi\.org\/(10\.\d{4,}[^\s"'?#&]+)/);
    if (doiUrl) result.doi = decodeURIComponent(doiUrl[1]);

    const pubmed = url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{5,8})\b/);
    if (pubmed) result.pmid = pubmed[1];

    const europepmc = url.match(/europepmc\.org\/article\/MED\/(\d{5,8})\b/);
    if (europepmc) result.pmid = europepmc[1];

    return result;
  }

  function fromLinksAndText() {
    const result = { doi: null, pmid: null, pdfUrl: null };

    // DOI from <a href="https://doi.org/...">
    for (const a of document.querySelectorAll('a[href*="doi.org/10."]')) {
      const m = a.href.match(/doi\.org\/(10\.\d{4,}[^\s"'?#&]+)/);
      if (m) { result.doi = decodeURIComponent(m[1]); break; }
    }

    // PDF link: look for anchor text containing "PDF" or "Download"
    const pdfCandidates = document.querySelectorAll(
      'a[href$=".pdf"], a[href*="/pdf/"], a[href*="=pdf"], a[href*="type=pdf"]'
    );
    for (const a of pdfCandidates) {
      const text = (a.textContent || '').toLowerCase();
      if (text.includes('pdf') || text.includes('download') ||
          text.includes('full text') || text.includes('full-text')) {
        result.pdfUrl = a.href;
        break;
      }
    }
    // Fallback: any .pdf link
    if (!result.pdfUrl && pdfCandidates.length > 0) {
      result.pdfUrl = pdfCandidates[0].href;
    }

    // DOI from page text (first 6000 chars)
    if (!result.doi) {
      const text = (document.body && document.body.innerText || '').slice(0, 6000);
      const m = text.match(/\bDOI:?\s*(10\.\d{4,}[/\w.;()\-:+#]+[\w)])/i)
             || text.match(DOI_RE);
      if (m) result.doi = m[1];
    }

    return result;
  }

  function detect() {
    const meta  = fromMeta();
    const url   = fromUrl();
    const links = fromLinksAndText();

    return {
      doi:    meta.doi  || url.doi  || links.doi  || null,
      pmid:   meta.pmid || url.pmid || links.pmid || null,
      pdfUrl: links.pdfUrl || null,
    };
  }

  // ── Sidebar panel (iframe) ────────────────────────────────────────────────

  function openPanel(data) {
    if (panel) return;

    document.documentElement.style.transition = 'margin-right 0.25s ease';
    document.documentElement.style.marginRight = '380px';

    panel = document.createElement('iframe');
    panel.src = chrome.runtime.getURL('panel.html');
    Object.assign(panel.style, {
      position:  'fixed',
      top:       '0',
      right:     '0',
      width:     '370px',
      height:    '100vh',
      border:    'none',
      zIndex:    '2147483647',
      boxShadow: '-4px 0 24px rgba(0,0,0,0.28)',
    });

    document.body.appendChild(panel);

    panel.addEventListener('load', () => {
      panel.contentWindow.postMessage({
        source:   'prionvault-content',
        type:     'INIT',
        doi:      data.doi,
        pmid:     data.pmid,
        pdfUrl:   data.pdfUrl,
        pageTitle: document.title,
      }, '*');
    });
  }

  function closePanel() {
    if (!panel) return;
    panel.remove();
    panel = null;
    document.documentElement.style.marginRight = '';
    document.documentElement.style.transition  = '';
  }

  // ── Message bridge: panel ↔ content ↔ background ─────────────────────────

  // Messages FROM the panel iframe (postMessage, since iframe may be cross-origin)
  window.addEventListener('message', async (e) => {
    if (!e.data || e.data.source !== 'prionvault-panel') return;

    if (e.data.type === 'CLOSE') {
      closePanel();
      return;
    }

    // FETCH_PDF_PAGE: content script fetches with page credentials (session cookies)
    // so publisher-authenticated PDF downloads work.
    if (e.data.type === 'FETCH_PDF_PAGE') {
      try {
        const resp = await fetch(e.data.url, { credentials: 'include' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const ct = resp.headers.get('content-type') || '';
        if (!ct.includes('pdf') && !e.data.url.endsWith('.pdf')) {
          throw new Error('La URL no devolvió un PDF.');
        }
        const buf   = await resp.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buf));
        panel && panel.contentWindow.postMessage({
          source: 'prionvault-content',
          type:   'PDF_BYTES',
          bytes,
          filename: e.data.url.split('/').pop().split('?')[0] || 'article.pdf',
        }, '*');
      } catch (err) {
        panel && panel.contentWindow.postMessage({
          source: 'prionvault-content',
          type:   'PDF_ERROR',
          error:  err.message,
        }, '*');
      }
    }
  });

  // ── Extension icon click → toggle panel ──────────────────────────────────

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'TOGGLE_PANEL') return;
    if (panel) {
      closePanel();
    } else {
      detected = detect();
      openPanel(detected || { doi: null, pmid: null, pdfUrl: null });
    }
  });

  // ── Auto-open when DOI/PMID found ────────────────────────────────────────

  detected = detect();
  if (detected.doi || detected.pmid) {
    openPanel(detected);
  }

})();
