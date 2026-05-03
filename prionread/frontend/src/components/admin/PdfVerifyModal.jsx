import { useState } from 'react';
import { Modal, Button } from '../common';
import { adminService } from '../../services/admin.service';

export const PdfVerifyModal = ({ isOpen, onClose, onFixed }) => {
  const [loading, setLoading]   = useState(false);
  const [results, setResults]   = useState(null);  // { results[], summary }
  const [clearing, setClearing] = useState(null);  // articleId being cleared
  const [error, setError]       = useState('');

  const runVerify = async () => {
    setLoading(true);
    setResults(null);
    setError('');
    try {
      const data = await adminService.verifyPdfs();
      setResults(data);
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
        summary: { ...prev.summary, missing: prev.summary.missing - 1, total: prev.summary.total - 1 },
        results: prev.results.filter((r) => r.id !== articleId),
      }));
      if (onFixed) onFixed();
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Error limpiando ruta');
    } finally {
      setClearing(null);
    }
  };

  const handleClose = () => { setResults(null); setError(''); onClose(); };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Verificar PDFs en Dropbox" size="lg">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Comprueba que los artículos marcados con PDF en la base de datos tienen
          realmente el archivo en Dropbox. Si la ruta está desactualizada puedes
          limpiarla para que el botón vuelva a aparecer en gris.
        </p>

        <div className="flex gap-2">
          <Button onClick={runVerify} loading={loading}>
            {results ? 'Volver a verificar' : 'Verificar ahora'}
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
            {/* Summary bar */}
            <div className="flex gap-3 flex-wrap">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium rounded-full bg-green-100 text-green-700">
                ✓ {results.summary.ok} correctos
              </span>
              <span className={`inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium rounded-full ${
                results.summary.missing > 0 ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'
              }`}>
                ✗ {results.summary.missing} no encontrados
              </span>
              <span className="inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium rounded-full bg-gray-100 text-gray-600">
                {results.summary.total} total
              </span>
            </div>

            {results.results.length === 0 ? (
              <p className="text-sm text-gray-400 italic">No hay artículos con PDF registrado.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Artículo</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Ruta en BD</th>
                      <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 uppercase">Estado</th>
                      <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 uppercase">Acción</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {results.results.map((r) => (
                      <tr key={r.id} className={r.exists ? '' : 'bg-red-50'}>
                        <td className="px-4 py-3">
                          <p className="font-medium text-gray-900 truncate max-w-xs">{r.title}</p>
                          {r.doi && <p className="text-xs text-gray-400 font-mono">{r.doi}</p>}
                          {!r.doi && r.pubmed_id && <p className="text-xs text-gray-400 font-mono">PMID {r.pubmed_id}</p>}
                        </td>
                        <td className="px-4 py-3">
                          <code className="text-xs text-gray-600 break-all">{r.dropbox_path}</code>
                        </td>
                        <td className="px-4 py-3 text-center">
                          {r.exists ? (
                            <span className="text-green-600 font-bold">✓</span>
                          ) : (
                            <span className="text-red-600 font-bold">✗</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {!r.exists && (
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
                    ))}
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
