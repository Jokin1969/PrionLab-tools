import { useState, useEffect, useCallback } from 'react';
import {
  RiSearchLine, RiAddLine, RiDeleteBin6Line,
  RiUploadLine, RiGroupLine, RiExternalLinkLine,
} from 'react-icons/ri';
import api from '../../services/api';
import PageHeader from '../../components/layout/PageHeader';
import { StatusBadge } from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';

function CreateArticleModal({ onClose, onCreated }) {
  const [doi, setDoi] = useState('');
  const [pmid, setPmid] = useState('');
  const [title, setTitle] = useState('');
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function fetchMeta() {
    if (!doi && !pmid) return;
    setFetching(true);
    setErr('');
    try {
      const params = doi ? `?doi=${encodeURIComponent(doi)}` : `?pmid=${encodeURIComponent(pmid)}`;
      const res = await api.get(`/articles/fetch-metadata${params}`);
      const m = res.data.metadata ?? res.data;
      if (m.title) setTitle(m.title);
    } catch {
      setErr('No se encontraron metadatos');
    } finally {
      setFetching(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErr('');
    setSaving(true);
    try {
      await api.post('/articles', { doi: doi || undefined, pmid_id: pmid || undefined, title });
      onCreated();
      onClose();
    } catch (error) {
      setErr(error.response?.data?.error || 'Error al crear artículo');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
      <div className="card w-full max-w-md p-6 space-y-4">
        <h2 className="font-semibold text-gray-900">Nuevo artículo</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">DOI</label>
              <input value={doi} onChange={(e) => setDoi(e.target.value)} placeholder="10.1234/..." className="input" />
            </div>
            <div className="flex-1">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">PubMed ID</label>
              <input value={pmid} onChange={(e) => setPmid(e.target.value)} placeholder="12345678" className="input" />
            </div>
          </div>
          <button type="button" onClick={fetchMeta} disabled={fetching || (!doi && !pmid)} className="btn-secondary text-sm flex items-center gap-2">
            {fetching ? <Spinner size="sm" /> : null}
            Buscar metadatos
          </button>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">Título *</label>
            <input required value={title} onChange={(e) => setTitle(e.target.value)} className="input" />
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
            <button type="submit" disabled={saving} className="btn-primary flex-1">
              {saving ? <Spinner size="sm" /> : 'Crear'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function UploadPDFModal({ article, onClose, onUploaded }) {
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    if (!file) return;
    setSaving(true);
    const formData = new FormData();
    formData.append('pdf', file);
    try {
      await api.post(`/articles/${article.id}/pdf`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      onUploaded();
      onClose();
    } catch (error) {
      setErr(error.response?.data?.error || 'Error al subir PDF');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
      <div className="card w-full max-w-sm p-6 space-y-4">
        <h2 className="font-semibold text-gray-900">Subir PDF</h2>
        <p className="text-sm text-gray-500 truncate">{article.title}</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="file"
            accept="application/pdf"
            required
            onChange={(e) => setFile(e.target.files[0])}
            className="block w-full text-sm text-gray-500 file:mr-4 file:rounded file:border-0 file:bg-indigo-50 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-indigo-700"
          />
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
            <button type="submit" disabled={saving || !file} className="btn-primary flex-1">
              {saving ? <Spinner size="sm" /> : 'Subir'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function AdminArticles() {
  const [articles, setArticles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [uploadTarget, setUploadTarget] = useState(null);
  const [msg, setMsg] = useState('');

  const fetchArticles = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ page, limit: 20 });
    if (search) params.set('search', search);
    api.get(`/articles?${params}`)
      .then((res) => {
        setArticles(res.data.articles ?? res.data);
        if (res.data.pagination) setTotalPages(res.data.pagination.totalPages ?? 1);
      })
      .catch(() => setArticles([]))
      .finally(() => setLoading(false));
  }, [search, page]);

  useEffect(() => { fetchArticles(); }, [fetchArticles]);

  async function assignAll(articleId) {
    try {
      await api.post(`/admin/articles/${articleId}/assign-all`);
      setMsg('Artículo asignado a todos los estudiantes');
    } catch (err) {
      setMsg(err.response?.data?.error || 'Error al asignar');
    }
    setTimeout(() => setMsg(''), 3000);
  }

  async function deleteArticle(articleId) {
    if (!window.confirm('¿Eliminar este artículo?')) return;
    try {
      await api.delete(`/articles/${articleId}`);
      setArticles((prev) => prev.filter((a) => a.id !== articleId));
      setMsg('Artículo eliminado');
    } catch (err) {
      setMsg(err.response?.data?.error || 'Error al eliminar');
    }
    setTimeout(() => setMsg(''), 3000);
  }

  return (
    <div>
      <PageHeader
        title="Artículos"
        subtitle="Biblioteca de artículos científicos"
        action={
          <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-2 text-sm">
            <RiAddLine className="h-4 w-4" />
            Nuevo artículo
          </button>
        }
      />

      <div className="p-6 space-y-4">
        {msg && <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{msg}</p>}

        <div className="flex gap-3">
          <div className="relative flex-1">
            <RiSearchLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Buscar artículo..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { setPage(1); fetchArticles(); } }}
              className="input pl-9"
            />
          </div>
          <button onClick={() => { setPage(1); fetchArticles(); }} className="btn-secondary">Buscar</button>
        </div>

        {loading ? (
          <div className="flex justify-center py-12"><Spinner size="lg" /></div>
        ) : (
          <div className="space-y-2">
            {articles.length === 0 ? (
              <p className="py-10 text-center text-sm text-gray-400">No hay artículos</p>
            ) : articles.map((a) => (
              <div key={a.id} className="card flex items-start gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-2">
                    <p className="font-medium text-gray-900 leading-snug">{a.title}</p>
                    {a.is_milestone && (
                      <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">HITO</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {Array.isArray(a.authors) ? a.authors.slice(0, 2).join(', ') : a.authors}
                    {a.year && ` · ${a.year}`}
                    {a.journal && ` · ${a.journal}`}
                  </p>
                  {Array.isArray(a.tags) && a.tags.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {a.tags.map((t) => (
                        <span key={t} className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-700">{t}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {a.doi && (
                    <a
                      href={`https://doi.org/${a.doi}`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded p-1.5 text-gray-400 hover:text-prion-primary"
                      title="Ver en DOI"
                    >
                      <RiExternalLinkLine className="h-4 w-4" />
                    </a>
                  )}
                  <button
                    onClick={() => setUploadTarget(a)}
                    title="Subir PDF"
                    className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                  >
                    <RiUploadLine className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => assignAll(a.id)}
                    title="Asignar a todos"
                    className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                  >
                    <RiGroupLine className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => deleteArticle(a.id)}
                    title="Eliminar"
                    className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600"
                  >
                    <RiDeleteBin6Line className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 pt-4">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="btn-secondary disabled:opacity-40">Anterior</button>
            <span className="text-sm text-gray-500">{page} / {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="btn-secondary disabled:opacity-40">Siguiente</button>
          </div>
        )}
      </div>

      {showCreate && (
        <CreateArticleModal onClose={() => setShowCreate(false)} onCreated={fetchArticles} />
      )}
      {uploadTarget && (
        <UploadPDFModal article={uploadTarget} onClose={() => setUploadTarget(null)} onUploaded={fetchArticles} />
      )}
    </div>
  );
}
