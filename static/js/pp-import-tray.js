/**
 * PPImportTray — PrionPacks' own staging list for articles about to be
 * imported into a pack. Separate on purpose from window.PPCart (the
 * persistent, server-backed PrionVault "carrito"): they used to be the
 * same object, which meant "Vaciar carrito" from inside PrionPacks
 * emptied the PrionVault cart too — surprising, since conceptually
 * PrionPacks was only ever supposed to borrow a COPY of what's in the
 * cart to stage an import, not share the one true list.
 *
 * Deliberately NOT server-backed — this is a short-lived, per-browser
 * staging area, not a research asset worth persisting across devices.
 * localStorage is enough, and it's what lets PrionVault's "Enviar a
 * PrionPacks" cart action populate the tray before opening a NEW TAB to
 * /prionpacks (same-origin localStorage is visible to it immediately).
 *
 * Public API mirrors PPCart's shape (getAll/has/count/add/remove/clear)
 * so existing call sites in prionpacks.js only needed a name swap.
 * Fires window CustomEvent 'pp-tray-changed' on every change, and also
 * re-syncs from a 'storage' event so two tabs open at once (e.g. the
 * PrionVault tab that populated it, and the PrionPacks tab reading it)
 * stay in sync without a reload.
 */
window.PPImportTray = (() => {
  const KEY = 'pv-import-tray-items';
  let _cache = [];

  const _load = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
      _cache = Array.isArray(raw) ? raw.map(a => ({ ...a, id: String(a.id) })) : [];
    } catch (e) {
      _cache = [];
    }
  };
  const _save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(_cache)); } catch (e) { /* storage full/disabled — keep in-memory only */ }
  };
  const _emit = () =>
    window.dispatchEvent(new CustomEvent('pp-tray-changed', { detail: { items: _cache } }));

  _load();

  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    _load();
    _emit();
  });

  return {
    getAll() { return _cache.slice(); },
    has(id)  { return _cache.some(a => a.id === String(id)); },
    count()  { return _cache.length; },

    add(article) {
      if (!article || article.id == null) return;
      const id = String(article.id);
      if (_cache.some(a => a.id === id)) return;
      const item = {
        id, title: article.title || '', authors: article.authors || '',
        year: article.year ?? null, journal: article.journal || '',
        doi: article.doi || '', pubmed_id: article.pubmed_id || '',
        has_pdf: !!article.has_pdf,
      };
      _cache = [item, ..._cache];
      _save();
      _emit();
    },

    remove(id) {
      const sid = String(id);
      _cache = _cache.filter(a => a.id !== sid);
      _save();
      _emit();
    },

    clear() {
      _cache = [];
      _save();
      _emit();
    },
  };
})();
