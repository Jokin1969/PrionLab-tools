/**
 * PPCart — article cart for staging PrionVault → PrionPacks imports.
 *
 * Now server-backed and admin-only:
 *   - Persisted per user in the DB (`/prionvault/api/cart`), so the admin's
 *     cart follows them across devices.
 *   - Restricted to the admin role. For non-admins the cart is disabled: the
 *     API is a no-op, reads return empty, and the cart UI is hidden.
 *
 * The public API stays SYNCHRONOUS (getAll/has/count/add/remove/clear) so the
 * many existing call sites keep working: it reads an in-memory cache that is
 * hydrated from the server on load and reconciled after each mutation.
 *
 * Article shape: {id, title, authors, year, journal, doi, pubmed_id, has_pdf}
 * Fires window CustomEvent 'pp-cart-changed' whenever the cart changes.
 */
window.PPCart = (() => {
  const API  = '/prionvault/api/cart';
  const ROLE = (document.querySelector('meta[name="pv-user-role"]')?.content || '').trim();
  const IS_ADMIN = ROLE === 'admin';

  let _cache = [];

  const _emit = () =>
    window.dispatchEvent(new CustomEvent('pp-cart-changed', { detail: { items: _cache } }));

  const _setCache = (items) => {
    _cache = Array.isArray(items) ? items.map(a => ({ ...a, id: String(a.id) })) : [];
    _emit();
  };

  // Reconcile the cache with whatever the server reports after a mutation.
  const _sync = (promise) =>
    promise
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (j && Array.isArray(j.items)) _setCache(j.items); })
      .catch(() => { /* keep optimistic cache on network hiccup */ });

  // Hydrate from the server on load (admins only).
  if (IS_ADMIN) {
    fetch(API, { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (j && Array.isArray(j.items)) _setCache(j.items); })
      .catch(() => {});
  } else {
    // Hide every cart affordance for non-admins.
    const css = document.createElement('style');
    css.textContent =
      '.pv-cart-btn,.pv-rag-cart-btn,#pv-detail-cart-btn,#pv-edit-cart-btn,' +
      '#pv-cart-badge,.pp-cart-btn,.pp-btn-add-to-cart{display:none !important;}';
    (document.head || document.documentElement).appendChild(css);
  }

  return {
    isEnabled() { return IS_ADMIN; },
    getAll() { return _cache.slice(); },
    has(id)  { return _cache.some(a => a.id === String(id)); },
    count()  { return _cache.length; },

    add(article) {
      if (!IS_ADMIN || !article || article.id == null) return;
      const id = String(article.id);
      if (_cache.some(a => a.id === id)) return;
      // Optimistic local update, then persist + reconcile.
      const item = {
        id, title: article.title || '', authors: article.authors || '',
        year: article.year ?? null, journal: article.journal || '',
        doi: article.doi || '', pubmed_id: article.pubmed_id || '',
        has_pdf: !!article.has_pdf,
      };
      _cache = [item, ..._cache];
      _emit();
      _sync(fetch(API, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ article: item }),
      }));
    },

    remove(id) {
      if (!IS_ADMIN) return;
      const sid = String(id);
      _cache = _cache.filter(a => a.id !== sid);
      _emit();
      _sync(fetch(`${API}/${encodeURIComponent(sid)}`, {
        method: 'DELETE', credentials: 'same-origin',
      }));
    },

    clear() {
      if (!IS_ADMIN) return;
      _cache = [];
      _emit();
      _sync(fetch(`${API}/clear`, { method: 'POST', credentials: 'same-origin' }));
    },
  };
})();
