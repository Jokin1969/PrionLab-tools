import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { adminService } from '../../services/admin.service';
import { ArticleModal } from '../../components/admin/ArticleModal';
import { BatchImportModal } from '../../components/admin/BatchImportModal';
import { Card, Button, Input, Loader } from '../../components/common';

function articleCompleteness(article) {
  const authorStr = Array.isArray(article.authors)
    ? article.authors.join(', ')
    : (article.authors ?? '');
  const error = [];
  if (!authorStr.trim()) error.push('autores');
  if (!article.doi && !article.pubmed_id) error.push('DOI/PubMed');
  if (!article.journal) error.push('revista');
  if (!article.dropbox_path) error.push('PDF');
  const warn = [];
  if (!article.abstract) warn.push('abstract');
  return { error, warn };
}

const PRIORITY_COLORS = {
  1: 'bg-gray-100 text-gray-500',
  2: 'bg-blue-100 text-blue-600',
  3: 'bg-yellow-100 text-yellow-700',
  4: 'bg-orange-100 text-orange-600',
  5: 'bg-red-100 text-red-600',
};

const AdminArticles = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const [articles, setArticles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [editingArticle, setEditingArticle] = useState(null);
  const [search, setSearch] = useState('');
  const [filterNoPdf, setFilterNoPdf] = useState(false);
  const [filterNoAbstract, setFilterNoAbstract] = useState(false);
  const [savingInline, setSavingInline] = useState(null);
  const [uploadingPdf, setUploadingPdf] = useState(null);
  const [filters, setFilters] = useState({
    is_milestone: '',
    year: '',
    sort_by: 'year',
    order: 'desc',
  });
  const [msg, setMsg] = useState('');

  const filterUser = location.state?.filterUser ?? null;
  const filterStatuses = location.state?.filterStatuses ?? null;

  useEffect(() => {
    loadArticles();
  }, [filters]);

  const loadArticles = async () => {
    setLoading(true);
    try {
      const data = await adminService.getArticles(filters);
      setArticles(data.articles || []);
    } catch (error) {
      console.error('Error loading articles:', error);
    } finally {
      setLoading(false);
    }
  };

  const clearUserFilter = () => {
    navigate('/admin/articles', { replace: true, state: null });
  };

  const flash = (text) => {
    setMsg(text);
    setTimeout(() => setMsg(''), 3000);
  };

  const handleCreateArticle = async (formData) => {
    await adminService.createArticle(formData);
    await loadArticles();
    flash('Artículo creado correctamente');
  };

  const handleUpdateArticle = async (formData) => {
    await adminService.updateArticle(editingArticle.id, formData);
    await loadArticles();
    setEditingArticle(null);
    flash('Artículo actualizado correctamente');
  };

  const handleDeleteArticle = async (articleId, title) => {
    if (!window.confirm(`¿Eliminar artículo "${title}"?`)) return;
    try {
      await adminService.deleteArticle(articleId);
      await loadArticles();
      flash('Artículo eliminado');
    } catch {
      flash('Error eliminando artículo');
    }
  };

  const handleAssignToAll = async (articleId, title) => {
    if (!window.confirm(`¿Asignar "${title}" a TODOS los estudiantes?`)) return;
    try {
      const data = await adminService.assignArticleToAll(articleId);
      flash(`Asignado a ${data.assigned_to ?? data.count ?? 'todos los'} estudiantes`);
    } catch {
      flash('Error asignando artículo');
    }
  };

  const handleInlineUpdate = async (article, patch) => {
    setSavingInline(article.id);
    try {
      const fd = new FormData();
      fd.append('title', article.title);
      if (article.doi) fd.append('doi', article.doi);
      if (article.pubmed_id) fd.append('pubmed_id', article.pubmed_id);
      Object.entries(patch).forEach(([k, v]) => fd.append(k, String(v)));
      await adminService.updateArticle(article.id, fd);
      setArticles((prev) =>
        prev.map((a) => (a.id === article.id ? { ...a, ...patch } : a))
      );
    } catch (err) {
      flash(err?.response?.data?.error || err?.message || 'Error guardando cambio');
    } finally {
      setSavingInline(null);
    }
  };

  const handlePdfUpload = async (article, file) => {
    setUploadingPdf(article.id);
    try {
      const fd = new FormData();
      fd.append('title', article.title);
      if (article.doi) fd.append('doi', article.doi);
      if (article.pubmed_id) fd.append('pubmed_id', article.pubmed_id);
      fd.append('pdf', file);
      const updated = await adminService.updateArticle(article.id, fd);
      const newPath =
        updated.dropbox_path ??
        updated.article?.dropbox_path ??
        updated.pdf_url ??
        'uploaded';
      setArticles((prev) =>
        prev.map((a) => (a.id === article.id ? { ...a, dropbox_path: newPath } : a))
      );
      flash('PDF subido correctamente');
    } catch (err) {
      flash(err?.response?.data?.error || err?.message || 'Error subiendo PDF');
    } finally {
      setUploadingPdf(null);
    }
  };

  const authorsText = (authors) =>
    Array.isArray(authors) ? authors.join(', ') : (authors ?? '');

  let filteredArticles = articles.filter((article) => {
    const q = search.toLowerCase();
    const matchesSearch =
      article.title?.toLowerCase().includes(q) ||
      authorsText(article.authors).toLowerCase().includes(q);
    const matchesUser =
      !filterUser ||
      article.assignments?.some((a) => a.user_id === filterUser.id);
    const matchesStatus =
      !filterStatuses ||
      article.assignments?.some(
        (a) => a.user_id === filterUser?.id && filterStatuses.includes(a.status)
      );
    return matchesSearch && matchesUser && matchesStatus;
  });

  if (filterNoPdf) filteredArticles = filteredArticles.filter((a) => !a.dropbox_path);
  if (filterNoAbstract) filteredArticles = filteredArticles.filter((a) => !a.abstract);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">📚 Artículos</h1>
          <p className="text-gray-600 mt-1">Gestiona la biblioteca del laboratorio</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setShowBatchModal(true)}>
            📋 Importar DOI/PMID
          </Button>
          <Button onClick={() => { setEditingArticle(null); setShowModal(true); }}>
            + Nuevo Artículo
          </Button>
        </div>
      </div>

      {msg && (
        <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">
          {msg}
        </div>
      )}

      {/* User filter banner */}
      {filterUser && (
        <div className="flex items-center gap-3 px-4 py-3 bg-indigo-50 border border-indigo-200 rounded-lg text-sm text-indigo-800">
          <span>
            Filtrando artículos de <strong>{filterUser.name}</strong>
            {filterStatuses && ` · estados: ${filterStatuses.join(', ')}`}
          </span>
          <button
            onClick={clearUserFilter}
            className="ml-auto text-indigo-500 hover:text-indigo-700 font-medium"
          >
            × Quitar filtro
          </button>
        </div>
      )}

      {/* Filters */}
      <Card>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="md:col-span-2">
            <Input
              placeholder="Buscar por título o autor..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <select
            value={filters.is_milestone}
            onChange={(e) => setFilters((prev) => ({ ...prev, is_milestone: e.target.value }))}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-prion-primary"
          >
            <option value="">Todos</option>
            <option value="true">Solo Milestones</option>
            <option value="false">Solo Regulares</option>
          </select>

          <select
            value={filters.sort_by}
            onChange={(e) => setFilters((prev) => ({ ...prev, sort_by: e.target.value }))}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-prion-primary"
          >
            <option value="year">Año</option>
            <option value="title">Título</option>
            <option value="priority">Prioridad</option>
          </select>
        </div>

        <div className="mt-4 pt-4 border-t border-gray-200 flex items-center flex-wrap gap-3">
          <p className="text-sm text-gray-600">
            Mostrando <span className="font-semibold">{filteredArticles.length}</span> artículos
          </p>
          <div className="flex gap-2 ml-auto">
            <button
              onClick={() => setFilterNoPdf((v) => !v)}
              className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
                filterNoPdf
                  ? 'bg-red-500 text-white border-red-500'
                  : 'bg-white text-red-600 border-red-300 hover:bg-red-50'
              }`}
            >
              Sin PDF
            </button>
            <button
              onClick={() => setFilterNoAbstract((v) => !v)}
              className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
                filterNoAbstract
                  ? 'bg-orange-500 text-white border-orange-500'
                  : 'bg-white text-orange-600 border-orange-300 hover:bg-orange-50'
              }`}
            >
              Sin Abstract
            </button>
          </div>
        </div>
      </Card>

      {/* Articles Table */}
      {loading ? (
        <Loader />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Artículo</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Año</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">P / ★</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Links</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredArticles.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-10 text-center text-sm text-gray-400">
                      No se encontraron artículos
                    </td>
                  </tr>
                ) : filteredArticles.map((article) => {
                  const { error, warn } = articleCompleteness(article);
                  const isSaving = savingInline === article.id;
                  const isUploadingPdf = uploadingPdf === article.id;
                  return (
                    <tr key={article.id} className={`hover:bg-gray-50 ${isSaving ? 'opacity-60' : ''}`}>
                      <td className="px-4 py-4 max-w-sm">
                        <div className="flex items-start gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold text-gray-900 truncate">{article.title}</p>
                            <p className="text-sm text-gray-600 truncate">{authorsText(article.authors)}</p>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {article.is_milestone && (
                                <span className="px-2 py-0.5 text-xs bg-amber-100 text-amber-600 rounded">
                                  ⭐ Milestone
                                </span>
                              )}
                              {article.tags?.slice(0, 2).map((tag) => (
                                <span key={tag} className="px-2 py-0.5 text-xs bg-gray-100 text-gray-600 rounded">
                                  {tag}
                                </span>
                              ))}
                            </div>
                          </div>
                          {error.length > 0 && (
                            <span
                              title={`Falta: ${error.join(', ')}`}
                              className="flex-shrink-0 text-red-500 font-bold text-sm cursor-pointer select-none"
                            >
                              !
                            </span>
                          )}
                          {error.length === 0 && warn.length > 0 && (
                            <span
                              title={`Falta: ${warn.join(', ')}`}
                              className="flex-shrink-0 text-sm cursor-pointer select-none"
                            >
                              ⚠️
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-4 text-sm text-gray-600">{article.year}</td>
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-1">
                          <select
                            value={article.priority ?? 3}
                            disabled={isSaving}
                            onChange={(e) =>
                              handleInlineUpdate(article, { priority: parseInt(e.target.value) })
                            }
                            className={`text-xs px-1 py-0.5 rounded border-0 cursor-pointer focus:outline-none focus:ring-1 focus:ring-gray-400 ${
                              PRIORITY_COLORS[article.priority ?? 3] ?? PRIORITY_COLORS[3]
                            }`}
                          >
                            {[1, 2, 3, 4, 5].map((p) => (
                              <option key={p} value={p}>P{p}</option>
                            ))}
                          </select>
                          <button
                            disabled={isSaving}
                            onClick={() =>
                              handleInlineUpdate(article, {
                                is_milestone: !article.is_milestone,
                                ...(!article.is_milestone && { priority: 5 }),
                              })
                            }
                            className="text-lg leading-none hover:scale-110 transition-transform disabled:opacity-40"
                            title={article.is_milestone ? 'Quitar milestone' : 'Marcar milestone'}
                          >
                            {article.is_milestone ? '⭐' : '☆'}
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex gap-1 flex-wrap items-center">
                          {/* PDF button: grey=no pdf, spinner=uploading, rose=has pdf */}
                          {article.dropbox_path ? (
                            <a
                              href={article.dropbox_path}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="px-2 py-1 text-xs bg-rose-100 text-rose-700 rounded hover:bg-rose-200"
                              title="Abrir PDF"
                            >
                              PDF
                            </a>
                          ) : isUploadingPdf ? (
                            <span className="px-2 py-1 text-xs bg-gray-100 text-gray-400 rounded flex items-center gap-1">
                              <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                              </svg>
                              PDF
                            </span>
                          ) : (
                            <label
                              className="px-2 py-1 text-xs bg-gray-200 text-gray-500 rounded hover:bg-gray-300 cursor-pointer select-none"
                              title="Sin PDF — haz clic para subir"
                            >
                              <input
                                type="file"
                                accept=".pdf"
                                className="hidden"
                                onChange={(e) => {
                                  const file = e.target.files[0];
                                  if (file) handlePdfUpload(article, file);
                                  e.target.value = '';
                                }}
                              />
                              PDF
                            </label>
                          )}
                          {article.doi && (
                            <a
                              href={`https://doi.org/${article.doi}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="px-2 py-1 text-xs bg-green-100 text-green-700 rounded hover:bg-green-200"
                              title={`DOI: ${article.doi}`}
                            >
                              DOI
                            </a>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex gap-2 flex-wrap">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => { setEditingArticle(article); setShowModal(true); }}
                          >
                            Editar
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleAssignToAll(article.id, article.title)}
                          >
                            Asignar a Todos
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => handleDeleteArticle(article.id, article.title)}
                          >
                            Eliminar
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <ArticleModal
        isOpen={showModal}
        onClose={() => { setShowModal(false); setEditingArticle(null); }}
        onSave={editingArticle ? handleUpdateArticle : handleCreateArticle}
        article={editingArticle}
      />

      <BatchImportModal
        isOpen={showBatchModal}
        onClose={() => setShowBatchModal(false)}
        onImported={loadArticles}
      />
    </div>
  );
};

export default AdminArticles;
