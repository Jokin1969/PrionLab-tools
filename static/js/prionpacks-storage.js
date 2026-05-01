/* PrionPacks – Server-side storage via REST API */

const PPStorage = (() => {
  const BASE = '/prionpacks/api/packages';
  const API_KEY_KEY = 'prionpacks_api_key';

  async function _req(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(BASE + path, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  async function loadAll() {
    return _req('GET', '');
  }

  async function get(id) {
    const all = await loadAll();
    return all.find(p => p.id === id) || null;
  }

  async function create(data) {
    return _req('POST', '', data);
  }

  async function update(id, data) {
    return _req('PUT', '/' + id, data);
  }

  async function remove(id) {
    return _req('DELETE', '/' + id);
  }

  function getApiKey() {
    return localStorage.getItem(API_KEY_KEY) || '';
  }

  function saveApiKey(key) {
    localStorage.setItem(API_KEY_KEY, key.trim());
  }

  return { loadAll, get, create, update, remove, getApiKey, saveApiKey };
})();
