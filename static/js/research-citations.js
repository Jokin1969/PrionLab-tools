/* Research Citations Manager — standalone JS module */
class CitationManager {
  constructor() {
    this.selectedPublications = new Map(); // pub_id -> pub object
    this.currentStyle = 'Vancouver';
    this._ensureModal();
    this._bindEvents();
  }

  _ensureModal() {
    if (document.getElementById('citationModal')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div id="citationModal" class="modal-overlay" style="display:none">
        <div class="modal-box modal-box--large">
          <div class="modal-header">
            <h3>Citation Manager</h3>
            <button class="modal-close" id="citationModalClose">&times;</button>
          </div>
          <div class="modal-body">
            <div class="cite-controls" style="display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1rem">
              <div class="form-group" style="flex:0 0 auto">
                <label>Citation Style</label>
                <select id="citationStyleSelect" class="form-control">
                  <option value="Vancouver">Vancouver [1]</option>
                  <option value="Nature">Nature 1</option>
                  <option value="PLoS">PLoS [1]</option>
                  <option value="APA">APA (Author, Year)</option>
                  <option value="Acta_Neuropathol">Acta Neuropathol [1]</option>
                </select>
              </div>
              <div class="form-group" style="flex:1;min-width:200px">
                <label>Search Publications</label>
                <div style="display:flex;gap:.5rem">
                  <input type="text" id="citationSearchInput" class="form-control"
                         placeholder="Search title, abstract, keywords…" />
                  <button class="btn btn-secondary" id="citationSearchBtn">Search</button>
                </div>
              </div>
            </div>
            <div style="display:flex;gap:.75rem;margin-bottom:.75rem;font-size:.85rem">
              <label><input type="checkbox" id="citationRecentOnly"> Recent (2020+)</label>
            </div>
            <div id="citationSearchResults" class="citation-results" style="margin-bottom:1rem"></div>
            <div style="margin-bottom:1rem">
              <strong>Selected (<span id="citationSelectedCount">0</span>)</strong>
              <div id="citationSelectedList" class="selected-publications"></div>
            </div>
            <div class="cite-bibliography">
              <h4>Bibliography Preview</h4>
              <div id="citationBibPreview" class="bibliography-output">
                Select publications above to preview bibliography…
              </div>
              <div class="cite-actions" style="margin-top:.75rem">
                <button class="btn btn-secondary" id="citationCopyBtn">Copy to Clipboard</button>
                <button class="btn btn-primary" id="citationDownloadBtn">Download .txt</button>
                <button class="btn btn-primary" id="citationExportMFBtn">Export to ManuscriptForge</button>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="citationModalCloseFooter">Close</button>
          </div>
        </div>
      </div>`);
  }

  _bindEvents() {
    document.getElementById('citationModalClose')?.addEventListener('click', () => this.close());
    document.getElementById('citationModalCloseFooter')?.addEventListener('click', () => this.close());
    document.getElementById('citationSearchBtn')?.addEventListener('click', () => this._search());
    document.getElementById('citationSearchInput')?.addEventListener('keypress', e => {
      if (e.key === 'Enter') this._search();
    });
    document.getElementById('citationStyleSelect')?.addEventListener('change', e => {
      this.currentStyle = e.target.value;
      this._refreshPreview();
    });
    document.getElementById('citationCopyBtn')?.addEventListener('click', () => {
      const text = document.getElementById('citationBibPreview').textContent;
      navigator.clipboard.writeText(text).then(() => this._flash('Copied to clipboard.'));
    });
    document.getElementById('citationDownloadBtn')?.addEventListener('click', () => this._downloadBib());
    document.getElementById('citationExportMFBtn')?.addEventListener('click', () => this._exportToMF());
    // Close on overlay click
    document.getElementById('citationModal')?.addEventListener('click', e => {
      if (e.target.id === 'citationModal') this.close();
    });
  }

  open() {
    document.getElementById('citationModal').style.display = 'flex';
    this._search();
  }

  close() {
    document.getElementById('citationModal').style.display = 'none';
  }

  async _search() {
    const q = document.getElementById('citationSearchInput').value;
    const recentOnly = document.getElementById('citationRecentOnly').checked;
    const filters = recentOnly ? {year_from: 2020} : {};
    const el = document.getElementById('citationSearchResults');
    el.innerHTML = '<p>Searching…</p>';
    try {
      const r = await fetch('/research/search-citations', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({query: q, filters})
      });
      const d = await r.json();
      if (d.success) this._renderResults(d.publications || []);
      else el.innerHTML = `<p class="alert alert--danger">${d.error || 'Search failed.'}</p>`;
    } catch(e) {
      el.innerHTML = '<p class="alert alert--danger">Network error.</p>';
    }
  }

  _renderResults(pubs) {
    const el = document.getElementById('citationSearchResults');
    if (!pubs.length) { el.innerHTML = '<p class="no-results">No publications found.</p>'; return; }
    el.innerHTML = pubs.map(p => `
      <div class="pub-card" style="cursor:default;margin-bottom:.5rem" data-pub='${JSON.stringify({
        publication_id: p.publication_id, title: p.title, authors: p.authors,
        journal: p.journal, year: p.year
      }).replace(/'/g,"&#39;")}'>
        <div style="display:flex;align-items:flex-start;gap:.75rem">
          <input type="checkbox" class="cite-check" data-id="${p.publication_id}"
                 ${this.selectedPublications.has(p.publication_id) ? 'checked' : ''}
                 style="margin-top:.25rem">
          <div>
            <strong style="font-size:.9rem">${p.title}</strong>
            <div style="font-size:.8rem;color:#555">${p.authors} — <em>${p.journal}</em> (${p.year})</div>
            ${p.is_lab_publication ? '<span class="badge badge--published" style="font-size:.7rem">Lab</span>' : ''}
          </div>
        </div>
      </div>`).join('');
    el.querySelectorAll('.cite-check').forEach(cb => {
      cb.addEventListener('change', e => {
        const card = e.target.closest('[data-pub]');
        const pub = JSON.parse(card.dataset.pub.replace(/&#39;/g,"'"));
        if (e.target.checked) this._addPub(pub);
        else this._removePub(pub.publication_id);
      });
    });
  }

  _addPub(pub) {
    this.selectedPublications.set(pub.publication_id, pub);
    this._renderSelected();
    this._refreshPreview();
  }

  _removePub(id) {
    this.selectedPublications.delete(id);
    // uncheck in results
    const cb = document.querySelector(`.cite-check[data-id="${id}"]`);
    if (cb) cb.checked = false;
    this._renderSelected();
    this._refreshPreview();
  }

  _renderSelected() {
    const el = document.getElementById('citationSelectedList');
    document.getElementById('citationSelectedCount').textContent = this.selectedPublications.size;
    if (!this.selectedPublications.size) { el.innerHTML = ''; return; }
    el.innerHTML = [...this.selectedPublications.values()].map(p => `
      <div class="selected-publication-item">
        <div class="selected-content">
          <span class="selected-title">${p.title}</span>
          <span class="selected-meta">${p.journal} (${p.year})</span>
        </div>
        <button class="remove-selected-btn" data-id="${p.publication_id}">×</button>
      </div>`).join('');
    el.querySelectorAll('.remove-selected-btn').forEach(btn => {
      btn.addEventListener('click', e => this._removePub(e.target.dataset.id));
    });
  }

  async _refreshPreview() {
    const el = document.getElementById('citationBibPreview');
    if (!this.selectedPublications.size) {
      el.textContent = 'Select publications above to preview bibliography…';
      return;
    }
    try {
      const r = await fetch('/research/preview-bibliography', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({publication_ids: [...this.selectedPublications.keys()], style: this.currentStyle})
      });
      const d = await r.json();
      if (d.success) {
        el.textContent = d.bibliography.map((b, i) => `${i+1}. ${b.citation}`).join('\n');
      }
    } catch(e) { console.error('Preview error', e); }
  }

  async _downloadBib() {
    try {
      const r = await fetch('/research/generate-bibliography', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({publication_ids: [...this.selectedPublications.keys()], style: this.currentStyle})
      });
      const d = await r.json();
      if (!d.success) { this._flash(d.error || 'Error.', true); return; }
      const blob = new Blob([d.bibliography_text], {type: 'text/plain'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `bibliography_${this.currentStyle}_${new Date().toISOString().slice(0,10)}.txt`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch(e) { this._flash('Download failed.', true); }
  }

  async _exportToMF() {
    const bib = document.getElementById('citationBibPreview').textContent;
    sessionStorage.setItem('generated_references', JSON.stringify({
      bibliography: bib, pub_ids: [...this.selectedPublications.keys()],
      style: this.currentStyle, ts: Date.now()
    }));
    this._flash('Redirecting to ManuscriptForge…');
    setTimeout(() => { window.location.href = '/tools/manuscriptforge/'; }, 800);
  }

  _flash(msg, isError = false) {
    const d = document.createElement('div');
    d.className = 'alert alert--' + (isError ? 'danger' : 'success');
    d.style.cssText = 'position:fixed;top:1rem;right:1rem;z-index:9999;min-width:200px';
    d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 3000);
  }
}

// Bootstrap
document.addEventListener('DOMContentLoaded', () => {
  window.citationManagerInstance = new CitationManager();
  document.querySelectorAll('.open-citation-modal').forEach(btn => {
    btn.addEventListener('click', () => window.citationManagerInstance.open());
  });
});
