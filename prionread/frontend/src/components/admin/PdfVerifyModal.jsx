import { useState } from 'react';
import { Modal, Button } from '../common';
import { adminService } from '../../services/admin.service';

const STATUS_CONFIG = {
  ok:            { color: 'text-green-600', bg: '',             icon: '✓', label: 'Verificado' },
  linked:        { color: 'text-blue-700',  bg: 'bg-blue-50',  icon: '⟳', label: 'Enlazado automáticamente' },
  missing:       { color: 'text-red-600',   bg: 'bg-red-50',   icon: '✗', label: 'Archivo no encontrado en Dropbox' },
  no_pdf:        { color: 'text-gray-400',  bg: '',            icon: '—', label: 'Sin PDF' },
  no_identifier: { color: 'text-gray-400',  bg: '',            icon: '—', label: 'Sin DOI ni PMID' },
};

export const PdfVerifyModal = ({ isOpen, onClose, onFixed }) => {
  const [loading, setLoading]   = useState(false);
  const [results, setResults]   = useState(null);
  const [clearing, setClearing] = useState(null);
  const [error, setError]       = useState('');

  const runVerify = async () => {
    setLoading(true);
    setResults(null);
    setError('');
    try {
      const data = await adminService.verifyPdfs();
      setResults(data);
      if (data.summary.linked > 0 && onFixed) onFixed();
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Error verificando PDFs');
    } finally {
      setLoading(false);
    }
  };

  const handleClear = async (articleId) => {
    setClearing(articleId);
    try {
      await adminService.clearPdfLink(articleId);
      setResults((prev) => ({
        ...prev,
        summary: { ...prev.summary, missing: prev.summary.missing - 1 },
        results: prev.results.map((r) =>
          r.id === articleId ? { ...r, status: 'no_pdf', dropbox_path: null } : r
        ),
      }));
      if (onFixed) onFixed();
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Error limpiando ruta');
    } finally {
      setClearing(null);
    }
  };

  const handleClose = () => { setResults(null); setError(''); onClose(); };

  // Only show actionable rows (hide ok and no_identifier)
  const visibleResults = results?.results.filter(
    (r) => r.status !== 'ok' && r.status !== 'no_identifier'
  ) ?? [];

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Verificar y sincronizar PDFs" size="lg">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Revisa el estado del PDF de <strong>todos los artículos</strong>. Los artículos
          sin PDF enlazado serán comprobados en Dropbox — si el archivo existe con el nombre
          esperado, se enlazará automáticamente.
        </p>

        <div className="flex gap-2">
          <Button onClick={runVerify} loading={loading}>
            {results ? 'Volver a verificar' : 'Verificar y sincronizar'}
          </Button>
          {results && (
            <Button variant="secondary" onClick={handleClose}>Cerrar</Button>
          )}
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-sm text-red-700">{error}</div>
        )}

        {results && (
          <>
            {/* Summary badges */}
            <div className="flex gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium rounded-full bg-green-100 text-green-700">
                ✓ {results.summary.ok} correctos
              </span>
              {results.summary.linked > 0 && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium rounded-full bg-blue-100 text-blue-700">
                  ⟳ {results.summary.linked} enlazados ahora
                </span>
              )}
              {results.summary.missing > 0 && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium rounded-full bg-red-100 text-red-700">
                  ✗ {results.summary.missing} rotos
                </span>
              )}
              <span className="inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium rounded-full bg-gray-100 text-gray-500">
                {results.summary.total} artículos total
              </span>
            </div>

            {/* Auto-link confirmation banner */}
            {results.summary.linked > 0 && (
              <div className="rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800">
                Se han enlazado automáticamente{' '}
                <strong>{results.summary.linked} PDF{results.summary.linked > 1 ? 's' : ''}</strong>{' '}
                encontrados en Dropbox. La tabla de artículos se ha actualizado.
              </div>
            )}

            {visibleResults.length === 0 ? (
              <p className="text-sm text-gray-500 italic">
                {results.summary.ok > 0
                  ? `Todos los ${results.summary.ok} artículos con PDF están correctos.`
                  : 'No hay incidencias que mostrar.'}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Artículo</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Ruta en Dropbox</th>
                      <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 uppercase">Estado</th>
                      <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 uppercase">Acción</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {visibleResults.map((r) => {
                      const cfg = STATUS_CONFIG[r.status] ?? STATUS_CONFIG.ok;
                      return (
                        <tr key={r.id} className={cfg.bg}>
                          <td className="px-4 py-3">
                            <p className="font-medium text-gray-900 truncate max-w-xs">{r.title}</p>
                            {r.doi && <p className="text-xs text-gray-400 font-mono">{r.doi}</p>}
                            {!r.doi && r.pubmed_id && <p className="text-xs text-gray-400 font-mono">PMID {r.pubmed_id}</p>}
                          </td>
                          <td className="px-4 py-3">
                            {r.dropbox_path
                              ? <code className="text-xs text-gray-600 break-all">{r.dropbox_path}</code>
                              : <span className="text-xs text-gray-400 italic">sin ruta</span>}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className={`font-bold ${cfg.color}`} title={cfg.label}>{cfg.icon}</span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            {r.status === 'missing' && (
                              <button
                                onClick={() => handleClear(r.id)}
                                disabled={clearing === r.id}
                                className="px-2 py-1 text-xs font-medium bg-red-100 text-red-700 rounded hover:bg-red-200 disabled:opacity-50"
                              >
                                {clearing === r.id ? 'Limpiando…' : 'Limpiar ruta'}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};
