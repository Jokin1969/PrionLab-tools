import { useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { adminService } from '../../services/admin.service';
import { ArticleModal } from '../../components/admin/ArticleModal';
import { BatchImportModal } from '../../components/admin/BatchImportModal';
import { Card, Button, Input, Loader } from '../../components/common';

const DOT_CLS = {
  none:       'bg-gray-200 hover:bg-gray-400 cursor-pointer',
  pending:    'bg-amber-400  cursor-default',
  read:       'bg-blue-400   cursor-default',
  summarized: 'bg-purple-400 cursor-default',
  evaluated:  'bg-green-400  cursor-default',
};

const STATUS_LABELS = {
  read: 'leídos',
  summarized: 'resumidos',
  evaluated: 'evaluados',
};

function initials(name) {
  const p = name.trim().split(/\s+/);
  return p.length >= 2 ? (p[0][0] + p[p.length - 1][0]).toUpperCase() : p[0].slice(0, 2).toUpperCase();
}

function articleCompleteness(article) {
  const missing = [];
  const authors = Array.isArray(article.authors) ? article.authors.join('') : (article.authors ?? '');
  if (!authors.trim())                    missing.push('autores');
  if (!article.doi && !article.pubmed_id) missing.push('DOI/PubMed');
  if (!article.journal)                   missing.push('revista');
  if (!article.abstract)                  missing.push('resumen');
  if (!article.dropbox_path)              missing.push('PDF');
  if (missing.length === 0)               return { level: 'ok' };
  if (missing.length === 1 && missing[0] === 'resumen') return { level: 'warn', missing };
  return { level: 'error', missing };
}

const AdminArticles = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const [userFilter, setUserFilter]     = useState(location.state?.filterUser ?? null);
  const [statusFilter, setStatusFilter] = useState(location.state?.filterStatuses ?? null);

  const [articles, setArticles]         = useState([]);
  const [loading, setLoading]           = useState(true);
  const [showModal, setShowModal]       = useState(false);
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [editingArticle, setEditingArticle] = useState(null);
  const [search, setSearch]             = useState('');
  const [filters, setFilters]           = useState({ is_milestone: '', year: '', sort_by: 'year', order: 'desc' });
  const [msg, setMsg]                   = useState('');
  const [students, setStudents]         = useState([]);
  const [matrix, setMatrix]             = useState({});
  const [loadingPdf, setLoadingPdf]     = useState(null);
  const [savingInline, setSavingInline] = useState(null); // article id being saved

  const loadArticles = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminService.getArticles(filters);
      setArticles(data.articles || []);
    } catch (err) { console.error('Error loading articles:', err); }
    finally { setLoading(false); }
  }, [filters]);

  const loadMatrix = useCallback(async () => {
    try {
      const data = await adminService.getAssignmentsMatrix();
      setStudents(data.students || []);
      setMatrix(data.matrix   || {});
    } catch (err) { console.error('Error loading matrix:', err); }
  }, []);

  useEffect(() => { loadArticles(); }, [loadArticles]);
  useEffect(() => { loadMatrix(); },  [loadMatrix]);

  const flash = (text) => { setMsg(text); setTimeout(() => setMsg(''), 3000); };

  const clearUserFilter = () => {
    setUserFilter(null);
    setStatusFilter(null);
    navigate('/admin/articles', { replace: true, state: null });
  };

  const handleInlineUpdate = async (article, patch) => {
    setSavingInline(article.id);
    try {
      const fd = new FormData();
      fd.append('title',        article.title || '');
      fd.append('authors',      Array.isArray(article.authors) ? article.authors.join(', ') : (article.authors || ''));
      fd.append('year',         article.year);
      fd.append('journal',      article.journal || '');
      fd.append('doi',          article.doi || '');
      fd.append('pubmed_id',    article.pubmed_id || '');
      fd.append('abstract',     article.abstract || '');
      fd.append('is_milestone', String(patch.is_milestone ?? article.is_milestone));
      fd.append('priority',     String(patch.priority ?? article.priority));
      await adminService.updateArticle(article.id, fd);
      // Optimistic local update to avoid full reload flicker
      setArticles((prev) => prev.map((a) => a.id === article.id ? { ...a, ...patch } : a));
    } catch { flash('Error guardando cambio'); }
    finally { setSavingInline(null); }
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
    try { await adminService.deleteArticle(articleId); await loadArticles(); flash('Artículo eliminado'); }
    catch { flash('Error eliminando artículo'); }
  };

  const handleAssignToAll = async (articleId, title) => {
    if (!window.confirm(`¿Asignar "${title}" a TODOS los estudiantes?`)) return;
    try {
      const data = await adminService.assignArticleToAll(articleId);
      await loadMatrix();
      flash(`Asignado a ${data.assigned_to ?? data.count ?? 'todos los'} estudiantes`);
    } catch { flash('Error asignando artículo'); }
  };

  const handleOpenPdf = async (article) => {
    if (!article.dropbox_path) return;
    setLoadingPdf(article.id);
    try {
      const data = await adminService.getArticlePdfLink(article.id);
      window.open(data.url, '_blank');
    } catch { flash('Error obteniendo enlace PDF'); }
    finally { setLoadingPdf(null); }
  };

  const handleDotClick = async (articleId, student) => {
    if (matrix[articleId]?.[student.id]) return;
    if (!window.confirm(`¿Asignar este artículo a ${student.name}?`)) return;
    setMatrix((prev) => ({
      ...prev,
      [articleId]: { ...(prev[articleId] || {}), [student.id]: { id: null, status: 'pending' } },
    }));
    try {
      await adminService.assignArticles(student.id, [articleId]);
      await loadMatrix();
    } catch {
      setMatrix((prev) => {
        const next = { ...prev, [articleId]: { ...(prev[articleId] || {}) } };
        delete next[articleId][student.id];
        return next;
      });
      flash('Error asignando artículo');
    }
  };

  const authorsText = (authors) => Array.isArray(authors) ? authors.join(', ') : (authors ?? '');

  const filteredArticles = articles.filter((a) => {
    const q = search.toLowerCase();
    if (!a.title?.toLowerCase().includes(q) && !authorsText(a.authors).toLowerCase().includes(q)) return false;
    if (userFilter) {
      const asgn = matrix[a.id]?.[userFilter.id];
      if (!asgn) return false;
      if (statusFilter && !statusFilter.includes(asgn.status)) return false;
    }
    return true;
  });

  const filterLabel = statusFilter
    ? statusFilter.map((s) => STATUS_LABELS[s] ?? s).join(' / ')
    : 'todos los asignados';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">📚 Artículos</h1>
          <p className="text-gray-600 mt-1">Gestiona la biblioteca del laboratorio</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setShowBatchModal(true)}>Importar por DOI</Button>
          <Button onClick={() => { setEditingArticle(null); setShowModal(true); }}>+ Nuevo Artículo</Button>
        </div>
      </div>

      {msg && <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">{msg}</div>}

      {userFilter && (
        <div className="rounded-lg bg-indigo-50 border border-indigo-200 px-4 py-3 flex items-center justify-between">
          <p className="text-sm text-indigo-800">
            Mostrando <strong>{filterLabel}</strong> de <strong>{userFilter.name}</strong>
          </p>
          <button onClick={clearUserFilter} className="text-indigo-400 hover:text-indigo-700 text-xl font-bold leading-none ml-4">×</button>
        </div>
      )}

      <Card>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="md:col-span-2">
            <Input placeholder="Buscar por título o autor..." value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <select value={filters.is_milestone} onChange={(e) => setFilters((p) => ({ ...p, is_milestone: e.target.value }))} className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-prion-primary">
            <option value="">Todos</option>
            <option value="true">Solo Milestones</option>
            <option value="false">Solo Regulares</option>
          </select>
          <select value={filters.sort_by} onChange={(e) => setFilters((p) => ({ ...p, sort_by: e.target.value }))} className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-prion-primary">
            <option value="year">Año</option>
            <option value="title">Título</option>
            <option value="priority">Prioridad</option>
          </select>
        </div>
        <div className="mt-4 pt-4 border-t border-gray-200">
          <p className="text-sm text-gray-600">Mostrando <span className="font-semibold">{filteredArticles.length}</span> artículos</p>
          {students.length > 0 && (
            <p className="text-xs text-gray-400 mt-1">
              Columnas de asignación: • gris = no asignado (clic para asignar) • ● pendiente • leído • resumido • evaluado
            </p>
          )}
        </div>
      </Card>

      {loading ? <Loader /> : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Artículo</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Año</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Prio</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">PDF</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Stats</th>
                  {students.map((s) => (
                    <th key={s.id} className="px-2 py-3 text-center text-xs font-medium text-gray-500" title={s.name}>
                      {initials(s.name)}
                    </th>
                  ))}
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredArticles.length === 0 ? (
                  <tr><td colSpan={6 + students.length} className="px-6 py-10 text-center text-sm text-gray-400">No se encontraron artículos</td></tr>
                ) : filteredArticles.map((article) => {
                  const { level, missing } = articleCompleteness(article);
                  const saving = savingInline === article.id;
                  return (
                    <tr key={article.id} className={`hover:bg-gray-50 ${saving ? 'opacity-60' : ''}`}>

                      {/* Title + milestone toggle + completeness */}
                      <td className="px-6 py-4 max-w-xs">
                        <div className="flex items-start gap-2">
                          <button
                            title={article.is_milestone ? 'Quitar milestone' : 'Marcar como milestone'}
                            disabled={saving}
                            onClick={() => handleInlineUpdate(article, {
                              is_milestone: !article.is_milestone,
                              priority: !article.is_milestone ? 5 : article.priority,
                            })}
                            className="shrink-0 mt-0.5 text-base leading-none hover:scale-125 transition-transform disabled:opacity-40"
                          >
                            {article.is_milestone ? '⭐' : '☆'}
                          </button>
                          <div className="min-w-0">
                            <p className="font-semibold text-gray-900 truncate">{article.title}</p>
                            <p className="text-sm text-gray-600 truncate">{authorsText(article.authors)}</p>
                          </div>
                          {level !== 'ok' && (
                            <span
                              title={`Faltan: ${missing.join(', ')}`}
                              className={`shrink-0 mt-0.5 px-1.5 py-0.5 text-xs font-bold rounded ${
                                level === 'warn' ? 'bg-amber-100 text-amber-600' : 'bg-red-100 text-red-600'
                              }`}
                            >
                              {level === 'warn' ? '⚠️' : '!'}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Year */}
                      <td className="px-6 py-4 text-sm text-gray-600">{article.year}</td>

                      {/* Priority inline select */}
                      <td className="px-4 py-4">
                        <select
                          value={article.priority ?? 3}
                          disabled={saving}
                          onChange={(e) => handleInlineUpdate(article, { priority: parseInt(e.target.value) })}
                          className={`px-1.5 py-1 text-xs font-semibold rounded cursor-pointer border-0 focus:ring-2 focus:ring-prion-primary disabled:opacity-40 ${
                            article.priority >= 4 ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600'
                          }`}
                        >
                          {[1, 2, 3, 4, 5].map((n) => (
                            <option key={n} value={n}>P{n}</option>
                          ))}
                        </select>
                      </td>

                      {/* PDF */}
                      <td className="px-4 py-4">
                        <button
                          title={article.dropbox_path ? 'Abrir PDF' : 'Sin PDF'}
                          disabled={!article.dropbox_path || loadingPdf === article.id}
                          onClick={() => handleOpenPdf(article)}
                          className={`px-2 py-1 text-xs font-bold rounded ${
                            article.dropbox_path
                              ? 'bg-red-100 text-red-700 hover:bg-red-200'
                              : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                          }`}
                        >
                          {loadingPdf === article.id ? '…' : 'PDF'}
                        </button>
                      </td>

                      {/* Stats */}
                      <td className="px-6 py-4 text-sm text-gray-600">
                        {article.times_read != null && <p>{article.times_read} lecturas</p>}
                        {article.avg_rating  != null && <p className="text-xs">⭐ {Number(article.avg_rating).toFixed(1)}</p>}
                      </td>

                      {/* User dots */}
                      {students.map((s) => {
                        const asgn   = matrix[article.id]?.[s.id];
                        const status = asgn?.status ?? 'none';
                        const cls    = DOT_CLS[status] ?? DOT_CLS.none;
                        const tip    = asgn ? `${s.name}: ${status}` : `Asignar a ${s.name}`;
                        return (
                          <td key={s.id} className="px-2 py-4 text-center">
                            <button
                              title={tip}
                              onClick={() => handleDotClick(article.id, s)}
                              disabled={!!asgn}
                              className={`w-4 h-4 rounded-full inline-block transition-colors ${cls}`}
                            />
                          </td>
                        );
                      })}

                      {/* Actions */}
                      <td className="px-6 py-4">
                        <div className="flex gap-2 flex-wrap">
                          <Button variant="ghost" size="sm" onClick={() => { setEditingArticle(article); setShowModal(true); }}>Editar</Button>
                          <Button variant="secondary" size="sm" onClick={() => handleAssignToAll(article.id, article.title)}>Asignar a Todos</Button>
                          <Button variant="danger" size="sm" onClick={() => handleDeleteArticle(article.id, article.title)}>Eliminar</Button>
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
        onImported={() => { loadArticles(); flash('Importación completada'); }}
      />
    </div>
  );
};

export default AdminArticles;
