import { useState, useEffect } from 'react';
import { adminService } from '../../services/admin.service';
import PageHeader from '../../components/layout/PageHeader';
import Spinner from '../../components/ui/Spinner';

const PRIONVAULT_BASE = 'https://web-production-5517e.up.railway.app/prionvault';

const TABS = [
  { key: 'only_in_prionread',  label: '📄 Solo en PrionRead',   color: 'amber'  },
  { key: 'only_in_prionvault', label: '🗄️ Solo en PrionVault',   color: 'blue'   },
  { key: 'in_both',            label: '✅ En ambos',             color: 'green'  },
  { key: 'in_neither',         label: '❓ Sin asignar',          color: 'gray'   },
];

const COLOR_BADGE = {
  amber: 'bg-amber-100 text-amber-700 border-amber-200',
  blue:  'bg-blue-100 text-blue-700 border-blue-200',
  green: 'bg-green-100 text-green-700 border-green-200',
  gray:  'bg-gray-100 text-gray-500 border-gray-200',
};

const COLOR_TAB_ACTIVE = {
  amber: 'bg-amber-600 text-white border-amber-600',
  blue:  'bg-blue-600 text-white border-blue-600',
  green: 'bg-green-600 text-white border-green-600',
  gray:  'bg-gray-600 text-white border-gray-600',
};

function SummaryCard({ label, count, color, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 min-w-[140px] rounded-lg border p-4 text-left transition-all hover:shadow-md ${
        active ? COLOR_TAB_ACTIVE[color] : `bg-white ${COLOR_BADGE[color]} hover:opacity-80`
      }`}
    >
      <p className="text-3xl font-bold">{count}</p>
      <p className="text-sm mt-1 font-medium">{label}</p>
    </button>
  );
}

function ArticleRow({ article, tab, onAssignAll, assigningId }) {
  const isAssigning = assigningId === article.id;
  return (
    <div className="flex items-start gap-3 py-3 border-b border-gray-100 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="font-medium text-gray-900 text-sm leading-snug">{article.title}</p>
        <p className="text-xs text-gray-500 mt-0.5">
          {Array.isArray(article.authors)
            ? article.authors.slice(0, 2).join(', ') + (article.authors.length > 2 ? '…' : '')
            : (article.authors || '').split(',').slice(0, 2).join(', ')}
          {article.year ? ` · ${article.year}` : ''}
          {article.journal ? ` · ${article.journal}` : ''}
        </p>
        <div className="flex flex-wrap gap-1.5 mt-1.5 items-center">
          {article.doi && (
            <a
              href={`https://doi.org/${article.doi}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-prion-primary hover:underline"
            >
              DOI: {article.doi}
            </a>
          )}
          {article.is_milestone && (
            <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-600 rounded">
              ⭐ Milestone
            </span>
          )}
          {article.student_count > 0 && (
            <span className="text-[11px] text-gray-500">
              {article.student_count} estudiante{article.student_count !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      <div className="shrink-0 flex flex-col gap-1.5 items-end">
        {/* Action: assign to all students (PrionVault-only or neither) */}
        {(tab === 'only_in_prionvault' || tab === 'in_neither') && (
          <button
            onClick={() => onAssignAll(article.id)}
            disabled={isAssigning}
            className="px-2.5 py-1 text-xs font-medium rounded-lg bg-prion-primary text-white hover:opacity-80 disabled:opacity-50 transition-opacity flex items-center gap-1"
          >
            {isAssigning ? <Spinner size="sm" /> : '👥'} Asignar a todos
          </button>
        )}
        {/* Link to PrionVault article (if has PrionVault entry) */}
        {(tab === 'only_in_prionvault' || tab === 'in_both') && (
          <a
            href={`${PRIONVAULT_BASE}/api/articles/${article.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="px-2.5 py-1 text-xs font-medium rounded-lg border border-blue-200 text-blue-600 hover:bg-blue-50 transition-colors"
          >
            🗄️ Ver en PrionVault ↗
          </a>
        )}
      </div>
    </div>
  );
}

export default function SyncStatus() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('only_in_prionread');
  const [search, setSearch] = useState('');
  const [assigningId, setAssigningId] = useState(null);
  const [flash, setFlash] = useState('');

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

  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  const filteredArticles = () => {
    if (!data) return [];
    const list = data.articles[activeTab] || [];
    const q = norm(search.trim());
    if (!q) return list;
    return list.filter((a) => {
      const authors = Array.isArray(a.authors) ? a.authors.join(' ') : (a.authors || '');
      return [a.title, authors, a.journal, a.doi, a.pubmed_id, String(a.year || '')]
        .some((f) => norm(f).includes(q));
    });
  };

  return (
    <div>
      <PageHeader
        title="🔄 Sincronización PrionVault ↔ PrionRead"
        subtitle="Compara qué publicaciones están en cada sistema y detecta inconsistencias"
        action={
          <button
            onClick={loadSync}
            disabled={loading}
            className="btn-primary flex items-center gap-2"
          >
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
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 text-red-700 border border-red-200 text-sm">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : data ? (
        <>
          {!data.has_prionvault_columns && (
            <div className="mb-4 px-4 py-3 rounded-lg bg-amber-50 text-amber-800 border border-amber-200 text-sm">
              ⚠️ Las columnas de PrionVault (<code>pdf_md5</code>, <code>extraction_status</code>) no se detectaron en la base de datos compartida.
              La columna "Solo en PrionVault" estará vacía hasta que PrionVault sincronice la base de datos.
            </div>
          )}

          {/* Summary cards */}
          <div className="flex flex-wrap gap-3 mb-6">
            {TABS.map(({ key, label, color }) => (
              <SummaryCard
                key={key}
                label={label}
                count={data.summary[key]}
                color={color}
                active={activeTab === key}
                onClick={() => setActiveTab(key)}
              />
            ))}
          </div>

          {/* Explanation banner */}
          <div className="mb-4 px-4 py-3 rounded-lg bg-gray-50 border border-gray-200 text-xs text-gray-600 space-y-1">
            {activeTab === 'only_in_prionread' && (
              <p>📄 <strong>Solo en PrionRead:</strong> Artículos añadidos manualmente a PrionRead sin pasar por el pipeline de ingesta de PrionVault (sin PDF procesado ni metadatos enriquecidos). Considera importarlos en PrionVault para tener el texto completo y resumen IA.</p>
            )}
            {activeTab === 'only_in_prionvault' && (
              <p>🗄️ <strong>Solo en PrionVault:</strong> Artículos procesados en PrionVault (tienen PDF/metadatos) pero no asignados a ningún estudiante en PrionRead. Usa "Asignar a todos" para incorporarlos al plan lector.</p>
            )}
            {activeTab === 'in_both' && (
              <p>✅ <strong>En ambos sistemas:</strong> Artículos correctamente procesados en PrionVault y asignados a estudiantes en PrionRead. Todo OK.</p>
            )}
            {activeTab === 'in_neither' && (
              <p>❓ <strong>Sin asignar en ninguno:</strong> Artículos que existen en la base de datos pero no tienen asignaciones de estudiantes ni datos de PrionVault. Pueden ser artículos recién añadidos o incompletos.</p>
            )}
          </div>

          {/* Search */}
          <div className="mb-4">
            <input
              type="text"
              placeholder="Buscar por título, autores, DOI…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input w-full max-w-md"
            />
          </div>

          {/* Article list */}
          <div className="card p-4 md:p-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-gray-800">
                {TABS.find((t) => t.key === activeTab)?.label}
              </h2>
              <span className="text-sm text-gray-500">
                {filteredArticles().length}
                {search && ` / ${(data.articles[activeTab] || []).length}`} artículos
              </span>
            </div>

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
                    tab={activeTab}
                    onAssignAll={handleAssignAll}
                    assigningId={assigningId}
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
