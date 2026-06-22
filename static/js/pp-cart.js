/**
 * PPCart — shared article cart backed by localStorage.
 * Article shape: {id, title, authors, year, journal, doi, pubmed_id, has_pdf}
 * Fires window CustomEvent 'pp-cart-changed' whenever the cart changes.
 */
window.PPCart = (() => {
  const KEY = 'pp-article-cart';

  const _load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
  const _save = (items) => { localStorage.setItem(KEY, JSON.stringify(items)); window.dispatchEvent(new CustomEvent('pp-cart-changed', { detail: { items } })); };

  return {
    getAll() { return _load(); },
    has(id)  { return _load().some(a => a.id === String(id)); },
    add(article) {
      const items = _load();
      if (items.some(a => a.id === String(article.id))) return;
      items.unshift({ id: String(article.id), title: article.title || '', authors: article.authors || '',
        year: article.year || null, journal: article.journal || '', doi: article.doi || '',
        pubmed_id: article.pubmed_id || '', has_pdf: !!article.has_pdf });
      _save(items);
    },
    remove(id)  { _save(_load().filter(a => a.id !== String(id))); },
    clear()     { _save([]); },
    count()     { return _load().length; },
  };
})();
