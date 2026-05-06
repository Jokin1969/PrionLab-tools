import { useState, useEffect } from 'react';
import { adminService } from '../../services/admin.service';
import PageHeader from '../../components/layout/PageHeader';
import Spinner from '../../components/ui/Spinner';

const PRIONVAULT_BASE = 'https://web-production-5517e.up.railway.app/prionvault';

// ── ArticleRow ────────────────────────────────────────────────────────────────
function ArticleRow({ article, showAssignBtn, showVaultBtn, onAssignAll, assigningId, onSendToVault, sendingToVaultId }) {
  const isAssigning = assigningId === article.id;
  const isSending   = sendingToVaultId === article.id;
  const isAssigned  = article.student_count > 0;

  return (
    <div className="flex items-start gap-3 py-3 border-b border-gray-100 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-0.5">
          <p className="font-medium text-gray-900 text-sm leading-snug">{article.title}</p>
          {article.year && <span className="text-xs text-gray-400 shrink-0">{article.year}</span>}
        </div>
        <p className="text-xs text-gray-500 mt-0.5 truncate">
          {Array.isArray(article.authors)
            ? article.authors.slice(0, 2).join(', ') + (article.authors.length > 2 ? '…' : '')
            : (article.authors || '').split(',').slice(0, 2).join(', ')}
          {article.journal ? ` · ${article.journal}` : ''}
        </p>
        <div className="flex flex-wrap gap-1.5 mt-1.5 items-center">
          {article.doi ? (
            <a href={`https://doi.org/${article.doi}`} target="_blank" rel="noopener noreferrer"
               className="text-[11px] text-prion-primary hover:underline">
              DOI: {article.doi}
            </a>
          ) : article.pubmed_id ? (
            <a href={`https://pubmed.ncbi.nlm.nih.gov/${article.pubmed_id}/`} target="_blank" rel="noopener noreferrer"
               className="text-[11px] text-blue-600 hover:underline">
              PMID: {article.pubmed_id}
            </a>
          ) : null}
          {article.is_milestone && (
            <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-600 rounded">
              ⭐ Milestone
            </span>
          )}
          {isAssigned ? (
            <span className="text-[11px] text-emerald-600 font-medium">
              ✓ {article.student_count} estudiante{article.student_count !== 1 ? 's' : ''}
            </span>
          ) : (
            <span className="text-[11px] text-gray-400">Sin asignar</span>
          )}
        </div>
      </div>

      <div className="shrink-0 flex flex-col gap-1.5 items-end">
        {showAssignBtn && (
          <button
            onClick={() => onAssignAll(article.id)}
            disabled={isAssigning}
            className="px-2.5 py-1 text-xs font-medium rounded-lg bg-prion-primary text-white hover:opacity-80 disabled:opacity-50 transition-opacity flex items-center gap-1"
          >
            {isAssigning ? <Spinner size="sm" /> : '👥'} Asignar a todos
          </button>
        )}
        {showVaultBtn && (
          <button
            onClick={() => onSendToVault(article.id)}
            disabled={isSending}
            className="px-2.5 py-1 text-xs font-medium rounded-lg border border-[#0F3460] text-[#0F3460] hover:bg-[#0F3460] hover:text-white disabled:opacity-50 transition-colors flex items-center gap-1"
          >
            {isSending ? <Spinner size="sm" /> : (
              <svg viewBox="0 0 14 14" width="11" height="11" fill="none">
                <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2"/>
                <circle cx="7" cy="7" r="2.5" stroke="currentColor" strokeWidth="1"/>
                <line x1="7" y1="1.5" x2="7" y2="12.5" stroke="currentColor" strokeWidth="1"/>
                <line x1="1.5" y1="7" x2="12.5" y2="7" stroke="currentColor" strokeWidth="1"/>
              </svg>
            )} Enviar a PrionVault
          </button>
        )}
        {(article.in_prionvault || article.in_both) && (
          <a
            href={`${PRIONVAULT_BASE}?open=${article.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-gray-400 hover:text-[#0F3460] hover:underline"
          >
            Ver en PrionVault ↗
          </a>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function SyncStatus() {
  const [data, setData]                   = useState(null);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState('');
  const [activeTab, setActiveTab]         = useState('not_in_vault');  // 'in_vault' | 'not_in_vault'
  const [search, setSearch]               = useState('');
  const [assigningId, setAssigningId]     = useState(null);
  const [sendingToVaultId, setSendingToVaultId] = useState(null);
  const [flash, setFlash]                 = useState('');
  const [migrating, setMigrating]         = useState(false);
  const [markingPending, setMarkingPending] = useState(false);

  useEffect(() => { loadSync(); }, []);

  const loadSync = async () => {
    setLoading(true);
    setError('');
    try {
      const d = await adminService.getSyncStatus();
      setData(d);
    } catch (err) {
      setError(err?.response?.data?.error || 'Error cargando datos de sincronización');
    } finally {
      setLoading(false);
    }
  };

  const handleRunMigration = async () => {
    setMigrating(true);
    try {
      await adminService.runPrionVaultMigration();
      setFlash('Migración ejecutada. Recargando datos…');
      setTimeout(() => setFlash(''), 5000);
      await loadSync();
    } catch (err) {
      setFlash('❌ ' + (err?.response?.data?.error || 'Error ejecutando migración'));
      setTimeout(() => setFlash(''), 5000);
    } finally {
      setMigrating(false);
    }
  };

  const handleMarkPending = async () => {
    setMarkingPending(true);
    try {
      const r = await adminService.markPendingForPrionVault();
      const parts = [`${r.updated ?? 0} artículo${r.updated !== 1 ? 's' : ''} enviado${r.updated !== 1 ? 's' : ''} al pipeline`];
      if (r.pdfs_linked > 0) parts.push(`${r.pdfs_linked} PDF${r.pdfs_linked !== 1 ? 's' : ''} reasociado${r.pdfs_linked !== 1 ? 's' : ''} de Dropbox`);
      if (r.needs_pdf > 0)   parts.push(`${r.needs_pdf} aún ${r.needs_pdf !== 1 ? 'necesitan' : 'necesita'} PDF`);
      setFlash('✅ ' + parts.join(' · '));
      setTimeout(() => setFlash(''), 6000);
      await loadSync();
    } catch (err) {
      setFlash('❌ ' + (err?.response?.data?.error || 'Error marcando artículos'));
      setTimeout(() => setFlash(''), 5000);
    } finally {
      setMarkingPending(false);
    }
  };

  const handleAssignAll = async (articleId) => {
    setAssigningId(articleId);
    try {
      const result = await adminService.assignArticleToAll(articleId);
      setFlash(`Artículo asignado a ${result.assigned ?? result.count ?? 'todos los'} estudiantes`);
      setTimeout(() => setFlash(''), 4000);
      loadSync();
    } catch (err) {
      setFlash('❌ ' + (err?.response?.data?.error || 'Error al asignar'));
      setTimeout(() => setFlash(''), 4000);
    } finally {
      setAssigningId(null);
    }
  };

  const handleSendOneToVault = async (articleId) => {
    setSendingToVaultId(articleId);
    try {
      await adminService.markPendingForPrionVault();   // sends all; per-article would need a separate endpoint
      setFlash('✅ Artículo enviado al pipeline de PrionVault');
      setTimeout(() => setFlash(''), 4000);
      loadSync();
    } catch (err) {
      setFlash('❌ ' + (err?.response?.data?.error || 'Error al enviar'));
      setTimeout(() => setFlash(''), 4000);
    } finally {
      setSendingToVaultId(null);
    }
  };

  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  // ── Derived lists from raw categories ─────────────────────────────────────
  const inVaultList    = data ? [...(data.articles.in_both || []), ...(data.articles.only_in_prionvault || [])] : [];
  const notInVaultList = data ? [...(data.articles.only_in_prionread || []), ...(data.articles.in_neither || [])] : [];

  // Annotate with in_prionread flag
  const tag = (list, inVault, inPrionread) =>
    list.map((a) => ({ ...a, _in_vault: inVault, _in_prionread: inPrionread }));

  const inVaultTagged = [
    ...tag(data?.articles.in_both || [],            true,  true),
    ...tag(data?.articles.only_in_prionvault || [], true,  false),
  ];
  const notInVaultTagged = [
    ...tag(data?.articles.only_in_prionread || [], false, true),
    ...tag(data?.articles.in_neither || [],        false, false),
  ];

  const currentList = activeTab === 'in_vault' ? inVaultTagged : notInVaultTagged;

  const filteredArticles = () => {
    const q = norm(search.trim());
    if (!q) return currentList;
    return currentList.filter((a) => {
      const authors = Array.isArray(a.authors) ? a.authors.join(' ') : (a.authors || '');
      return [a.title, authors, a.journal, a.doi, a.pubmed_id, String(a.year || '')]
        .some((f) => norm(f).includes(q));
    });
  };

  // Stats
  const assignedCount    = data ? (data.summary.only_in_prionread + data.summary.in_both) : 0;
  const notAssignedCount = data ? (data.summary.only_in_prionvault + data.summary.in_neither) : 0;
  const inVaultCount     = data ? (data.summary.in_both + data.summary.only_in_prionvault) : 0;
  const notInVaultCount  = data ? (data.summary.only_in_prionread + data.summary.in_neither) : 0;
  // Articles in "not in vault" that ARE assigned (= only_in_prionread) — these are the ones the pipeline can process
  const sendableCount = data?.summary.only_in_prionread ?? 0;

  return (
    <div>
      <PageHeader
        title="🔄 Sincronización PrionVault ↔ PrionRead"
        subtitle="Compara qué publicaciones están en cada sistema y detecta inconsistencias"
        action={
          <button onClick={loadSync} disabled={loading} className="btn-primary flex items-center gap-2">
            {loading ? <Spinner size="sm" /> : '↺'} Actualizar
          </button>
        }
      />

      {flash && (
        <div className={`mb-4 px-4 py-3 rounded-lg text-sm font-medium ${
          flash.startsWith('❌') ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-green-50 text-green-700 border border-green-200'
        }`}>
          {flash}
        </div>
      )}
      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 text-red-700 border border-red-200 text-sm">{error}</div>
      )}

      {loading && !data ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : data ? (
        <>
          {!data.has_prionvault_columns && (
            <div className="mb-4 px-4 py-3 rounded-lg bg-amber-50 text-amber-800 border border-amber-200 text-sm flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1">
                ⚠️ Las columnas de PrionVault (<code>pdf_md5</code>, <code>extraction_status</code>) no existen todavía.
                Pulsa el botón para ejecutar la migración.
              </div>
              <button
                onClick={handleRunMigration}
                disabled={migrating}
                className="shrink-0 px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-700 text-white hover:bg-amber-800 disabled:opacity-50 flex items-center gap-1.5"
              >
                {migrating ? <Spinner size="sm" /> : '⚙️'} Aplicar migración
              </button>
            </div>
          )}

          {/* ── Stats: asignación a estudiantes ── */}
          <div className="flex flex-wrap gap-3 mb-5">
            <div className="flex-1 min-w-[140px] rounded-lg border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-3xl font-bold text-emerald-700">{assignedCount}</p>
              <p className="text-sm mt-1 font-medium text-emerald-700">✓ Asignados a estudiantes</p>
              <p className="text-xs text-emerald-600 mt-0.5 opacity-70">tienen al menos un estudiante asignado</p>
            </div>
            <div className="flex-1 min-w-[140px] rounded-lg border border-gray-200 bg-gray-50 p-4">
              <p className="text-3xl font-bold text-gray-500">{notAssignedCount}</p>
              <p className="text-sm mt-1 font-medium text-gray-600">Sin asignar</p>
              <p className="text-xs text-gray-500 mt-0.5 opacity-70">no aparecen en ningún plan lector</p>
            </div>
          </div>

          {/* ── Tabs: PrionVault status ── */}
          <div className="flex gap-3 mb-4">
            <button
              onClick={() => setActiveTab('in_vault')}
              className={`flex-1 min-w-[160px] rounded-xl border-2 p-4 text-left transition-all ${
                activeTab === 'in_vault'
                  ? 'border-[#0F3460] bg-[#0F3460] text-white'
                  : 'border-gray-200 bg-white text-gray-700 hover:border-[#0F3460] hover:shadow-sm'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                  activeTab === 'in_vault' ? 'bg-white/20' : 'bg-[#0F3460]/10'
                }`}>
                  <svg viewBox="0 0 16 16" width="18" height="18" fill="none">
                    <circle cx="8" cy="8" r="6.5" stroke={activeTab === 'in_vault' ? 'white' : '#0F3460'} strokeWidth="1.4"/>
                    <circle cx="8" cy="8" r="3"   stroke={activeTab === 'in_vault' ? 'white' : '#0F3460'} strokeWidth="1.1"/>
                    <line x1="8" y1="1.5" x2="8" y2="14.5" stroke={activeTab === 'in_vault' ? 'white' : '#0F3460'} strokeWidth="1.1"/>
                    <line x1="1.5" y1="8" x2="14.5" y2="8" stroke={activeTab === 'in_vault' ? 'white' : '#0F3460'} strokeWidth="1.1"/>
                    <line x1="3.2" y1="3.2" x2="12.8" y2="12.8" stroke={activeTab === 'in_vault' ? 'white' : '#0F3460'} strokeWidth="1.1"/>
                    <line x1="12.8" y1="3.2" x2="3.2" y2="12.8" stroke={activeTab === 'in_vault' ? 'white' : '#0F3460'} strokeWidth="1.1"/>
                  </svg>
                </div>
                <div>
                  <p className="text-2xl font-bold">{inVaultCount}</p>
                  <p className="text-sm font-semibold">En PrionVault</p>
                  <p className={`text-xs mt-0.5 ${activeTab === 'in_vault' ? 'text-white/70' : 'text-gray-400'}`}>
                    con PDF procesado o en pipeline
                  </p>
                </div>
              </div>
            </button>

            <button
              onClick={() => setActiveTab('not_in_vault')}
              className={`flex-1 min-w-[160px] rounded-xl border-2 p-4 text-left transition-all ${
                activeTab === 'not_in_vault'
                  ? 'border-amber-500 bg-amber-500 text-white'
                  : 'border-gray-200 bg-white text-gray-700 hover:border-amber-400 hover:shadow-sm'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 text-xl ${
                  activeTab === 'not_in_vault' ? 'bg-white/20' : 'bg-amber-50'
                }`}>
                  📄
                </div>
                <div>
                  <p className="text-2xl font-bold">{notInVaultCount}</p>
                  <p className="text-sm font-semibold">No en PrionVault</p>
                  <p className={`text-xs mt-0.5 ${activeTab === 'not_in_vault' ? 'text-white/70' : 'text-gray-400'}`}>
                    sin PDF ni datos de PrionVault
                  </p>
                </div>
              </div>
            </button>
          </div>

          {/* ── Bulk action (only for "not in vault" tab) ── */}
          {activeTab === 'not_in_vault' && sendableCount > 0 && data.has_prionvault_columns && (
            <div className="mb-4 flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200">
              <div className="flex-1 text-sm text-amber-800">
                <strong>{sendableCount}</strong> artículo{sendableCount !== 1 ? 's' : ''} asignado{sendableCount !== 1 ? 's' : ''} a estudiantes aún no están en PrionVault.
                Los PDFs se reasociarán automáticamente si ya existen en Dropbox.
              </div>
              <button
                onClick={handleMarkPending}
                disabled={markingPending}
                className="shrink-0 px-4 py-2 text-sm font-semibold rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 flex items-center gap-2 transition-colors"
              >
                {markingPending ? <Spinner size="sm" /> : (
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
                    <circle cx="8" cy="8" r="6.5" stroke="white" strokeWidth="1.4"/>
                    <circle cx="8" cy="8" r="3" stroke="white" strokeWidth="1.1"/>
                    <line x1="8" y1="1.5" x2="8" y2="14.5" stroke="white" strokeWidth="1.1"/>
                    <line x1="1.5" y1="8" x2="14.5" y2="8" stroke="white" strokeWidth="1.1"/>
                  </svg>
                )}
                Enviar {sendableCount} a PrionVault
              </button>
            </div>
          )}

          {/* ── Search + count ── */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <input
              type="text"
              placeholder="Buscar por título, autores, DOI…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input w-full max-w-md"
            />
            <span className="text-sm text-gray-400">
              {filteredArticles().length}{search ? ` / ${currentList.length}` : ''} artículos
            </span>
          </div>

          {/* ── Article list ── */}
          <div className="card p-4 md:p-6">
            <h2 className="font-semibold text-gray-800 mb-3">
              {activeTab === 'in_vault' ? '🗄️ Artículos en PrionVault' : '📄 Artículos sin datos en PrionVault'}
            </h2>
            {filteredArticles().length === 0 ? (
              <p className="text-gray-400 text-sm py-8 text-center">
                {search ? 'No hay resultados para esta búsqueda' : 'No hay artículos en esta categoría'}
              </p>
            ) : (
              <div>
                {filteredArticles().map((article) => (
                  <ArticleRow
                    key={article.id}
                    article={article}
                    showAssignBtn={!article._in_prionread}
                    showVaultBtn={!article._in_vault && article._in_prionread}
                    onAssignAll={handleAssignAll}
                    assigningId={assigningId}
                    onSendToVault={handleSendOneToVault}
                    sendingToVaultId={sendingToVaultId}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
