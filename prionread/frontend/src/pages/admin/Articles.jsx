import { useState, useEffect, useCallback, Fragment } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { adminService } from '../../services/admin.service';
import { ArticleModal } from '../../components/admin/ArticleModal';
import { BatchImportModal } from '../../components/admin/BatchImportModal';
import { PdfUploadModal } from '../../components/admin/PdfUploadModal';
import { PdfVerifyModal } from '../../components/admin/PdfVerifyModal';
import { DuplicatesModal } from '../../components/admin/DuplicatesModal';
import { Card, Button, Input, Loader } from '../../components/common';

const DOT_CLS = {
  none:       'bg-gray-200 hover:bg-gray-400 cursor-pointer',
  pending:    'bg-amber-400  cursor-default',
  read:       'bg-blue-400   cursor-default',
  summarized: 'bg-purple-400 cursor-default',
  evaluated:  'bg-green-400  cursor-default',
};

const STATUS_LABELS = { read: 'leídos', summarized: 'resumidos', evaluated: 'evaluados' };

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
  const [total, setTotal]               = useState(null);
  const [loading, setLoading]           = useState(true);
  const [showModal, setShowModal]       = useState(false);
  const [showBatchModal, setShowBatchModal]   = useState(false);
  const [showVerifyModal, setShowVerifyModal]       = useState(false);
  const [showDuplicatesModal, setShowDuplicatesModal] = useState(false);
  const [editingArticle, setEditingArticle]   = useState(null);
  const [pdfUploadTarget, setPdfUploadTarget] = useState(null);
  const [search, setSearch]             = useState('');
  const [filterNoPdf, setFilterNoPdf]         = useState(false);
  const [filterNoAbstract, setFilterNoAbstract] = useState(false);
  const [filterMilestone, setFilterMilestone]   = useState(false);
  const [filters, setFilters]           = useState({ is_milestone: '', year: '', sort_by: 'year', order: 'desc' });
  const [msg, setMsg]                   = useState('');
  const [errMsg, setErrMsg]             = useState('');
  const [students, setStudents]         = useState([]);
  const [matrix, setMatrix]             = useState({});
  const [loadingPdf, setLoadingPdf]     = useState(null);
  const [uploadingPdf, setUploadingPdf] = useState(null);
  const [savingInline, setSavingInline] = useState(null);
  const [fetchingAbstract, setFetchingAbstract] = useState(null);
  const [abstractPreview, setAbstractPreview]   = useState(null);

  const loadArticles = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminService.getArticles(filters);
      setArticles(data.articles || []);
      if (data.total != null) setTotal(data.total);
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

  const flash      = (text) => { setMsg(text);    setTimeout(() => setMsg(''),    3000); };
  const errorFlash = (text) => { setErrMsg(text); setTimeout(() => setErrMsg(''), 4000); };

  const clearUserFilter = () => {
    setUserFilter(null);
    setStatusFilter(null);
    navigate('/admin/articles', { replace: true, state: null });
  };

  const handleStudentCountClick = (student, count) => {
    if (count === 0) return;
    if (userFilter?.id === student.id && statusFilter === null) {
      clearUserFilter();
    } else {
      setUserFilter(student);
      setStatusFilter(null);
    }
  };

  const handleInlineUpdate = async (article, patch) => {
    setSavingInline(article.id);
    try {
      const fd = new FormData();
      fd.append('title',        article.title || '');
      fd.append('authors',      Array.isArray(article.authors) ? article.authors.join(', ') : (article.authors || ''));
      fd.append('year',         article.year);
      fd.append('journal',      article.journal || '');
      if (article.doi)       fd.append('doi',       article.doi);
      if (article.pubmed_id) fd.append('pubmed_id', article.pubmed_id);
      fd.append('abstract',     patch.abstract !== undefined ? patch.abstract : (article.abstract || ''));
      fd.append('is_milestone', String(patch.is_milestone ?? article.is_milestone));
      fd.append('priority',     String(patch.priority     ?? article.priority));
      await adminService.updateArticle(article.id, fd);
      setArticles((prev) => prev.map((a) => a.id === article.id ? { ...a, ...patch } : a));
    } catch (err) {
      errorFlash(err?.response?.data?.error || err?.message || 'Error guardando cambio');
    } finally { setSavingInline(null); }
  };

  const handleCreateArticle = async (formData) => {
    const data = await adminService.createArticle(formData);
    await loadArticles();
    if (data?.article?.dropbox_path) {
      flash('Artículo creado y PDF enlazado automáticamente desde Dropbox ✓');
    } else {
      flash('Artículo creado correctamente');
    }
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
    catch { errorFlash('Error eliminando artículo'); }
  };

  const handleAssignToAll = async (articleId, title) => {
    if (!window.confirm(`¿Asignar "${title}" a TODOS los estudiantes?`)) return;
    try {
      const data = await adminService.assignArticleToAll(articleId);
      await loadMatrix();
      flash(`Asignado a ${data.assigned_to ?? data.count ?? 'todos los'} estudiantes`);
    } catch { errorFlash('Error asignando artículo'); }
  };

  const handleOpenPdf = async (article) => {
    if (!article.dropbox_path) return;
    setLoadingPdf(article.id);
    try {
      const data = await adminService.getArticlePdfLink(article.id);
      const resp = await fetch(data.url);
      if (!resp.ok) throw new Error('No se pudo descargar el PDF desde Dropbox');
      const blob = await resp.blob();
      const objUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
      window.open(objUrl, '_blank');
      setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
    } catch (err) { errorFlash(err?.message || 'Error obteniendo enlace PDF'); }
    finally { setLoadingPdf(null); }
  };

  const handlePdfUpload = async (article, file) => {
    setUploadingPdf(article.id);
    try {
      const fd = new FormData();
      fd.append('title', article.title || '');
      if (article.doi)       fd.append('doi',       article.doi);
      if (article.pubmed_id) fd.append('pubmed_id', article.pubmed_id);
      fd.append('pdf', file);
      const updated = await adminService.updateArticle(article.id, fd);
      const newPath = updated.dropbox_path ?? updated.article?.dropbox_path ?? 'uploaded';
      setArticles((prev) => prev.map((a) => a.id === article.id ? { ...a, dropbox_path: newPath } : a));
      flash('PDF subido correctamente');
    } catch (err) {
      errorFlash(err?.response?.data?.error || err?.message || 'Error subiendo PDF');
    } finally { setUploadingPdf(null); }
  };

  const handleFetchAbstract = async (article) => {
    if (!article.doi && !article.pubmed_id) {
      errorFlash('Este artículo necesita DOI o PubMed ID para buscar el abstract');
      return;
    }
    setFetchingAbstract(article.id);
    setAbstractPreview(null);
    try {
      const data = await adminService.fetchMetadata(article.doi, article.pubmed_id);
      const m = data.metadata ?? data;
      if (!m.abstract) {
        errorFlash('No se encontró abstract en CrossRef ni PubMed para este artículo');
        return;
      }
      setAbstractPreview({ id: article.id, text: m.abstract });
    } catch (err) {
      errorFlash(err?.response?.data?.error || err?.message || 'Error buscando abstract');
    } finally { setFetchingAbstract(null); }
  };

  const handleSaveAbstract = async (article) => {
    if (!abstractPreview) return;
    await handleInlineUpdate(article, { abstract: abstractPreview.text });
    setAbstractPreview(null);
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
      errorFlash('Error asignando artículo');
    }
  };

  const authorsText = (authors) => Array.isArray(authors) ? authors.join(', ') : (authors ?? '');

  const downloadArticleXlsx = (article) => {
    const row = {
      DOI:       article.doi        || '',
      PMID:      article.pubmed_id  || '',
      Título:    article.title      || '',
      Autores:   authorsText(article.authors),
      Año:       article.year       || '',
      Revista:   article.journal    || '',
      Tags:      (article.tags || []).join(', '),
      Prioridad: article.priority   || '',
      Milestone: article.is_milestone ? 'Sí' : 'No',
      PDF:       article.dropbox_path ? 'Sí' : 'No',
    };
    const ws = XLSX.utils.json_to_sheet([row]);
    ws['!cols'] = [16, 12, 60, 40, 6, 30, 20, 10, 10, 6].map((w) => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Artículo');
    const safeName = (article.title || 'articulo').slice(0, 50).replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_');
    XLSX.writeFile(wb, `${safeName}.xlsx`);
  };

  let filteredArticles = articles.filter((a) => {
    const q = search.toLowerCase();
    if (!a.title?.toLowerCase().includes(q) && !authorsText(a.authors).toLowerCase().includes(q)) return false;
    if (userFilter) {
      const asgn = matrix[a.id]?.[userFilter.id];
      if (!asgn) return false;
      if (statusFilter && !statusFilter.includes(asgn.status)) return false;
    }
    return true;
  });
  if (filterNoPdf)      filteredArticles = filteredArticles.filter((a) => !a.dropbox_path);
  if (filterNoAbstract) filteredArticles = filteredArticles.filter((a) => !a.abstract);
  if (filterMilestone)  filteredArticles = filteredArticles.filter((a) => a.is_milestone);

  const filterLabel = statusFilter
    ? statusFilter.map((s) => STATUS_LABELS[s] ?? s).join(' / ')
    : 'todos los asignados';

  const totalCols = 6 + students.length + (students.length > 0 ? 1 : 0);

  const isFiltered = search || filterNoPdf || filterNoAbstract || filterMilestone || userFilter ||
    filters.is_milestone || (filters.year && filters.year !== '');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">📚 Artículos</h1>
          <p className="text-gray-600 mt-1">Gestiona la biblioteca del laboratorio</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setShowDuplicatesModal(true)} title="Detectar artículos duplicados o muy similares">
            🔍 Buscar duplicados
          </Button>
          <Button variant="ghost" onClick={() => setShowVerifyModal(true)} title="Verificar y sincronizar PDFs con Dropbox">
            📎 Verificar y Sync PDFs
          </Button>
          <Button variant="secondary" onClick={() => setShowBatchModal(true)}>Importar por DOI</Button>
          <Button onClick={() => { setEditingArticle(null); setShowModal(true); }}>+ Nuevo Artículo</Button>
        </div>
      </div>

      {msg    && <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">{msg}</div>}
      {errMsg && <div className="rounded-lg bg-red-50   border border-red-200   px-4 py-3 text-sm text-red-700">{errMsg}</div>}

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
        <div className="mt-4 pt-4 border-t border-gray-200 flex items-center flex-wrap gap-3">
          <p className="text-sm text-gray-600">
            Mostrando{' '}
            <span className="font-semibold">{filteredArticles.length}</span>
            {isFiltered && total != null && filteredArticles.length !== total && (
              <> de <span className="font-semibold">{total}</span> en total</>
            )}
            {!isFiltered && total != null && (
              <> de <span className="font-semibold">{total}</span> en total</>
            )}{' '}
            artículos
          </p>
          {students.length > 0 && (
            <p className="text-xs text-gray-400">
              • gris = no asignado (clic para asignar) • ● pendiente • leído • resumido • evaluado
            </p>
          )}
          <div className="flex gap-2 ml-auto">
            <button onClick={() => setFilterNoPdf((v) => !v)}
              className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
                filterNoPdf ? 'bg-red-500 text-white border-red-500' : 'bg-white text-red-600 border-red-300 hover:bg-red-50'
              }`}>Sin PDF</button>
            <button onClick={() => setFilterNoAbstract((v) => !v)}
              className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
                filterNoAbstract ? 'bg-orange-500 text-white border-orange-500' : 'bg-white text-orange-600 border-orange-300 hover:bg-orange-50'
              }`}>Sin Abstract</button>
          </div>
        </div>
      </Card>

      {loading ? <Loader /> : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    <button
                      onClick={() => setFilterMilestone((v) => !v)}
                      title={filterMilestone ? 'Mostrar todos los artículos' : 'Mostrar solo milestones'}
                      className="mr-1 text-base leading-none hover:scale-125 transition-transform align-middle">
                      {filterMilestone ? '⭐' : '☆'}
                    </button>
                    Artículo
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Año</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Prio</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Links</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Stats</th>
                  {students.length > 0 && (
                    <th className="w-6 px-1 py-3 text-center" title={userFilter ? 'Quitar filtro de estudiante' : 'Sin filtro activo'}>
                      <button onClick={clearUserFilter} disabled={!userFilter}
                        className={`text-base leading-none transition-colors ${
                          userFilter ? 'text-indigo-500 hover:text-indigo-700 cursor-pointer' : 'text-gray-300 cursor-default'
                        }`}>↺</button>
                    </th>
                  )}
                  {students.map((s) => {
                    const count    = articles.filter((a) => matrix[a.id]?.[s.id]).length;
                    const isActive = userFilter?.id === s.id && statusFilter === null;
                    return (
                      <th key={s.id} className="px-2 py-3 text-center text-xs font-medium text-gray-500" title={s.name}>
                        <div>{initials(s.name)}</div>
                        <button onClick={() => handleStudentCountClick(s, count)} disabled={count === 0}
                          title={count > 0 ? `Filtrar por ${s.name} (${count} asignados)` : 'Sin artículos asignados'}
                          className={`text-xs font-normal leading-tight rounded px-1 transition-colors ${
                            count === 0 ? 'text-gray-300 cursor-default'
                              : isActive ? 'bg-indigo-600 text-white cursor-pointer'
                              : 'text-indigo-500 hover:bg-indigo-100 cursor-pointer'
                          }`}>{count}</button>
                      </th>
                    );
                  })}
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredArticles.length === 0 ? (
                  <tr><td colSpan={totalCols} className="px-6 py-10 text-center text-sm text-gray-400">No se encontraron artículos</td></tr>
                ) : filteredArticles.map((article) => {
                  const { level, missing } = articleCompleteness(article);
                  const saving         = savingInline === article.id;
                  const isUploadingPdf = uploadingPdf === article.id;
                  const isFetchingAbs  = fetchingAbstract === article.id;
                  const showAbsPreview = abstractPreview?.id === article.id;
                  return (
                    <Fragment key={article.id}>
                      <tr className={`hover:bg-gray-50 ${showAbsPreview ? 'bg-violet-50' : ''} ${saving ? 'opacity-60' : ''}`}>
                        <td className="px-6 py-4 max-w-xs">
                          <div className="flex items-start gap-2">
                            <button title={article.is_milestone ? 'Quitar milestone' : 'Marcar como milestone'}
                              disabled={saving}
                              onClick={() => handleInlineUpdate(article, { is_milestone: !article.is_milestone, priority: !article.is_milestone ? 5 : article.priority })}
                              className="shrink-0 mt-0.5 text-base leading-none hover:scale-125 transition-transform disabled:opacity-40">
                              {article.is_milestone ? '⭐' : '☆'}
                            </button>
                            <div className="min-w-0 flex-1">
                              <p className="font-semibold text-gray-900 truncate">{article.title}</p>
                              <p className="text-sm text-gray-600 truncate">{authorsText(article.authors)}</p>
                              {!article.abstract && !showAbsPreview && (
                                <button onClick={() => handleFetchAbstract(article)} disabled={isFetchingAbs}
                                  className="mt-1 flex items-center gap-1 px-2 py-0.5 text-xs bg-violet-100 text-violet-700 rounded hover:bg-violet-200 disabled:opacity-50 disabled:cursor-wait transition-colors"
                                  title="Obtener abstract desde DOI / PubMed">
                                  {isFetchingAbs ? (
                                    <><svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Buscando…</>
                                  ) : '⬇️ Abstract'}
                                </button>
                              )}
                            </div>
                            {level !== 'ok' && (
                              <span title={`Faltan: ${missing.join(', ')}`}
                                className={`shrink-0 mt-0.5 px-1.5 py-0.5 text-xs font-bold rounded cursor-pointer select-none ${
                                  level === 'warn' ? 'bg-amber-100 text-amber-600' : 'bg-red-100 text-red-600'
                                }`}>{level === 'warn' ? '⚠️' : '!'}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">{article.year}</td>
                        <td className="px-4 py-4">
                          <select value={article.priority ?? 3} disabled={saving}
                            onChange={(e) => handleInlineUpdate(article, { priority: parseInt(e.target.value) })}
                            className={`px-1.5 py-1 text-xs font-semibold rounded cursor-pointer border-0 focus:ring-2 focus:ring-prion-primary disabled:opacity-40 ${
                              article.priority >= 4 ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600'
                            }`}>
                            {[1,2,3,4,5].map((n) => <option key={n} value={n}>P{n}</option>)}
                          </select>
                        </td>
                        <td className="px-4 py-4">
                          <div className="flex gap-1">
                            {article.dropbox_path ? (
                              <button title="Abrir PDF" disabled={loadingPdf === article.id} onClick={() => handleOpenPdf(article)}
                                className="px-2 py-1 text-xs font-bold rounded bg-red-100 text-red-700 hover:bg-red-200 disabled:opacity-50">
                                {loadingPdf === article.id ? '…' : 'PDF'}
                              </button>
                            ) : isUploadingPdf ? (
                              <span className="px-2 py-1 text-xs bg-gray-100 text-gray-400 rounded flex items-center gap-1">
                                <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>PDF
                              </span>
                            ) : (
                              <button onClick={() => setPdfUploadTarget(article)} title="Sin PDF — haz clic para subir"
                                className="px-2 py-1 text-xs font-bold rounded bg-gray-100 text-gray-400 hover:bg-gray-200 cursor-pointer">PDF</button>
                            )}
                            {article.doi ? (
                              <a href={`https://doi.org/${article.doi}`} target="_blank" rel="noopener noreferrer"
                                title={`Ver en web — doi.org/${article.doi}`}
                                className="px-2 py-1 text-xs font-bold rounded bg-indigo-100 text-indigo-700 hover:bg-indigo-200">DOI</a>
                            ) : article.pubmed_id ? (
                              <a href={`https://pubmed.ncbi.nlm.nih.gov/${article.pubmed_id}/`} target="_blank" rel="noopener noreferrer"
                                title={`Ver en PubMed — PMID ${article.pubmed_id}`}
                                className="px-2 py-1 text-xs font-bold rounded bg-teal-100 text-teal-700 hover:bg-teal-200">PMID</a>
                            ) : (
                              <span title="Sin DOI ni PubMed ID" className="px-2 py-1 text-xs font-bold rounded bg-gray-100 text-gray-400">DOI</span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {article.times_read != null && <p>{article.times_read} lecturas</p>}
                          {article.avg_rating  != null && <p className="text-xs">⭐ {Number(article.avg_rating).toFixed(1)}</p>}
                        </td>
                        {students.length > 0 && <td className="w-6" />}
                        {students.map((s) => {
                          const asgn = matrix[article.id]?.[s.id];
                          const cls  = DOT_CLS[asgn?.status ?? 'none'] ?? DOT_CLS.none;
                          return (
                            <td key={s.id} className="px-2 py-4 text-center">
                              <button title={asgn ? `${s.name}: ${asgn.status}` : `Asignar a ${s.name}`}
                                onClick={() => handleDotClick(article.id, s)} disabled={!!asgn}
                                className={`w-4 h-4 rounded-full inline-block transition-colors ${cls}`} />
                            </td>
                          );
                        })}
                        <td className="px-6 py-4">
                          <div className="flex gap-2 flex-wrap">
                            <Button variant="ghost" size="sm" onClick={() => { setEditingArticle(article); setShowModal(true); }}>Editar</Button>
                            <button
                              onClick={() => downloadArticleXlsx(article)}
                              title="Descargar datos en Excel"
                              className="px-2 py-1 text-xs font-bold rounded bg-green-100 text-green-700 hover:bg-green-200 transition-colors">
                              📊 XLS
                            </button>
                            <Button variant="secondary" size="sm" onClick={() => handleAssignToAll(article.id, article.title)}>Asignar a Todos</Button>
                            <Button variant="danger" size="sm" onClick={() => handleDeleteArticle(article.id, article.title)}>Eliminar</Button>
                          </div>
                        </td>
                      </tr>
                      {showAbsPreview && (
                        <tr className="bg-violet-50">
                          <td colSpan={totalCols} className="px-8 pb-5 pt-0">
                            <div className="rounded-lg border border-violet-200 bg-white shadow-sm p-4">
                              <p className="text-xs font-semibold text-violet-700 uppercase tracking-wide mb-2">
                                Abstract obtenido — verifica y confirma
                              </p>
                              <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{abstractPreview.text}</p>
                              <div className="flex gap-2 mt-4">
                                <button onClick={() => setAbstractPreview(null)} className="px-4 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">Cancelar</button>
                                <button onClick={() => handleSaveAbstract(article)} disabled={savingInline === article.id}
                                  className="px-4 py-1.5 text-sm bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-50">
                                  {savingInline === article.id ? 'Guardando…' : 'Introducir'}
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <ArticleModal isOpen={showModal} onClose={() => { setShowModal(false); setEditingArticle(null); }}
        onSave={editingArticle ? handleUpdateArticle : handleCreateArticle} article={editingArticle} />
      <BatchImportModal isOpen={showBatchModal} onClose={() => setShowBatchModal(false)}
        onImported={() => { loadArticles(); flash('Importación completada'); }} />
      <PdfUploadModal isOpen={Boolean(pdfUploadTarget)} onClose={() => setPdfUploadTarget(null)}
        article={pdfUploadTarget} onUpload={handlePdfUpload} />
      <PdfVerifyModal isOpen={showVerifyModal} onClose={() => setShowVerifyModal(false)} onFixed={loadArticles} />
      <DuplicatesModal isOpen={showDuplicatesModal} onClose={() => setShowDuplicatesModal(false)} onDeleted={loadArticles} />
    </div>
  );
};

export default AdminArticles;
