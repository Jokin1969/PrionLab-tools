import { useState } from 'react';
import { Modal, Button } from '../common';
import { adminService } from '../../services/admin.service';

const ScoreBadge = ({ score }) => {
  const pct = Math.round(score * 100);
  const color = score >= 1.0
    ? 'bg-red-100 text-red-700'
    : score >= 0.9
    ? 'bg-orange-100 text-orange-700'
    : 'bg-yellow-100 text-yellow-700';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${color}`}>
      {pct}%
    </span>
  );
};

const ArticleCell = ({ article }) => (
  <div className="min-w-0">
    <p className="font-medium text-gray-900 text-sm leading-snug">{article.title}</p>
    <p className="text-xs text-gray-500 mt-0.5 truncate">{article.authors}</p>
    <div className="flex flex-wrap gap-2 mt-1">
      {article.year && <span className="text-xs text-gray-400">{article.year}</span>}
      {article.journal && <span className="text-xs text-gray-400 italic truncate max-w-[140px]">{article.journal}</span>}
      {article.doi && <span className="text-xs text-blue-500 font-mono truncate max-w-[180px]">{article.doi}</span>}
      {!article.doi && article.pubmed_id && <span className="text-xs text-purple-500 font-mono">PMID {article.pubmed_id}</span>}
    </div>
  </div>
);

export const DuplicatesModal = ({ isOpen, onClose, onDeleted }) => {
  const [loading, setLoading]   = useState(false);
  const [results, setResults]   = useState(null);
  const [error, setError]       = useState('');
  const [deleting, setDeleting] = useState(null);
  const [dismissed, setDismissed] = useState(new Set());

  const runFind = async () => {
    setLoading(true);
    setResults(null);
    setError('');
    setDismissed(new Set());
    try {
      const data = await adminService.findDuplicates();
      setResults(data);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Error buscando duplicados');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (articleId, pairKey) => {
    setDeleting(articleId);
    try {
      await adminService.deleteArticle(articleId);
      setDismissed((prev) => new Set([...prev, pairKey]));
      if (onDeleted) onDeleted();
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Error eliminando artículo');
    } finally {
      setDeleting(null);
    }
  };

  const handleDismiss = (pairKey) => {
    setDismissed((prev) => new Set([...prev, pairKey]));
  };

  const handleClose = () => { setResults(null); setError(''); setDismissed(new Set()); onClose(); };

  const visiblePairs = (results?.pairs ?? []).filter((p) => !dismissed.has(`${p.a.id}:${p.b.id}`));

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Buscar artículos duplicados" size="xl">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Detecta artículos que puedan ser duplicados mediante coincidencia exacta de DOI/PMID
          y similitud difusa de título (Jaccard ≥ 75%). Los resultados se ordenan por
          probabilidad de duplicado.
        </p>

        <div className="flex gap-2">
          <Button onClick={runFind} loading={loading}>
            {results ? 'Volver a analizar' : 'Analizar duplicados'}
          </Button>
          {results && <Button variant="secondary" onClick={handleClose}>Cerrar</Button>}
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-sm text-red-700">{error}</div>
        )}

        {results && (
          <>
            <div className="flex gap-2 flex-wrap">
              {visiblePairs.length === 0 ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium rounded-full bg-green-100 text-green-700">
                  ✓ Sin duplicados detectados
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium rounded-full bg-amber-100 text-amber-700">
                  ⚠ {visiblePairs.length} par{visiblePairs.length !== 1 ? 'es' : ''} sospechoso{visiblePairs.length !== 1 ? 's' : ''}
                </span>
              )}
              <span className="inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium rounded-full bg-gray-100 text-gray-500">
                {results.total} pares analizados
              </span>
            </div>

            {visiblePairs.length > 0 && (
              <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
                {visiblePairs.map((pair) => {
                  const pairKey = `${pair.a.id}:${pair.b.id}`;
                  return (
                    <div key={pairKey} className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                      <div className="flex items-start justify-between gap-2 mb-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <ScoreBadge score={pair.score} />
                          {pair.reasons.map((r) => (
                            <span key={r} className="text-xs px-2 py-0.5 rounded bg-white border border-amber-200 text-amber-800">
                              {r}
                            </span>
                          ))}
                        </div>
                        <button
                          onClick={() => handleDismiss(pairKey)}
                          className="text-gray-400 hover:text-gray-600 text-lg leading-none flex-shrink-0"
                          title="Ignorar este par"
                        >
                          ×
                        </button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {[pair.a, pair.b].map((article, idx) => (
                          <div key={article.id} className="bg-white rounded-lg border border-gray-200 p-3 flex flex-col gap-2">
                            <ArticleCell article={article} />
                            <button
                              onClick={() => handleDelete(article.id, pairKey)}
                              disabled={!!deleting}
                              className="mt-auto self-start px-3 py-1 text-xs font-medium bg-red-100 text-red-700 rounded hover:bg-red-200 disabled:opacity-50 transition-colors"
                            >
                              {deleting === article.id ? 'Eliminando…' : `Eliminar ${idx === 0 ? 'este' : 'este'}`}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};
