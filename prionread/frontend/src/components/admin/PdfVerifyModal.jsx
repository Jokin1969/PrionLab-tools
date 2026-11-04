import { useState } from 'react';
import { Modal, Button } from '../common';
import { adminService } from '../../services/admin.service';

const STATUS_CONFIG = {
  ok:            { color: 'text-green-600',  bg: '',               icon: '✓', label: 'Verificado' },
  linked:        { color: 'text-blue-700',   bg: 'bg-blue-50',    icon: '⟳', label: 'Enlazado automáticamente' },
  stale_fixed:   { color: 'text-teal-700',   bg: 'bg-teal-50',    icon: '⇒', label: 'Ruta antigua corregida a PrionVault' },
  stale_path:    { color: 'text-orange-700', bg: 'bg-orange-50',  icon: '⚠', label: 'Ruta apunta fuera de PrionVault' },
  missing:       { color: 'text-red-600',    bg: 'bg-red-50',     icon: '✗', label: 'Archivo no encontrado en Dropbox' },
  no_pdf:        { color: 'text-gray-400',   bg: '',              icon: '—', label: 'Sin PDF' },
  no_identifier: { color: 'text-gray-400',   bg: '',              icon: '—', label: 'Sin DOI ni PMID' },
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
      if ((data.summary.linked > 0 || data.summary.stale_fixed > 0) && onFixed) onFixed();
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Error verificando PDFs');
    } finally {
      setLoading(false);
    }
  };

  const handleClear = async (articleId) => {
    setClearing(articleId);
    try {
      const target = results.results.find((r) => r.id === articleId);
      await adminService.clearPdfLink(articleId);
      setResults((prev) => ({
        ...prev,
        summary: {
          ...prev.summary,
          [target?.status]: Math.max(0, (prev.summary[target?.status] || 0) - 1),
        },
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

  const visibleResults = results?.results.filter(
    (r) => r.status !== 'ok' && r.status !== 'no_identifier' && r.status !== 'no_pdf'
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
          {results && <Button variant="secondary" onClick={handleClose}>Cerrar</Button>}
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-sm text-red-700">{error}</div>
        )}

        {results && (
          <>
            <div className="flex gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium rounded-full bg-green-100 text-green-700">
                ✓ {results.summary.ok} correctos
              </span>
              {results.summary.linked > 0 && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium rounded-full bg-blue-100 text-blue-700">
                  ⟳ {results.summary.linked} enlazados ahora
                </span>
              )}
              {results.summary.stale_fixed > 0 && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium rounded-full bg-teal-100 text-teal-700">
                  ⇒ {results.summary.stale_fixed} rutas antiguas corregidas
                </span>
              )}
              {results.summary.stale_path > 0 && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium rounded-full bg-orange-100 text-orange-700">
                  ⚠ {results.summary.stale_path} rutas fuera de PrionVault
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

            {results.summary.linked > 0 && (
              <div className="rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800">
                Se han enlazado automáticamente{' '}
                <strong>{results.summary.linked} PDF{results.summary.linked > 1 ? 's' : ''}</strong>{' '}
                encontrados en Dropbox. La tabla de artículos se ha actualizado.
              </div>
            )}
            {results.summary.stale_fixed > 0 && (
              <div className="rounded-lg bg-teal-50 border border-teal-200 px-4 py-3 text-sm text-teal-800">
                Se han corregido automáticamente{' '}
                <strong>{results.summary.stale_fixed} ruta{results.summary.stale_fixed > 1 ? 's' : ''}</strong>{' '}
                que apuntaban fuera de PrionVault. Ahora apuntan a la ubicación correcta.
              </div>
            )}
            {results.summary.stale_path > 0 && (
              <div className="rounded-lg bg-orange-50 border border-orange-200 px-4 py-3 text-sm text-orange-800">
                <strong>{results.summary.stale_path} artículo{results.summary.stale_path > 1 ? 's' : ''}</strong>{' '}
                tiene rutas fuera de PrionVault que no se pudieron corregir automáticamente.
                Revísalos manualmente o usa "Sincronizar desde Dropbox" para actualizarlos.
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
                            {r.status === 'stale_fixed' && r.old_path && (
                              <p className="text-xs text-gray-400 line-through break-all mb-1">{r.old_path}</p>
                            )}
                            {r.dropbox_path
                              ? <code className="text-xs text-gray-600 break-all">{r.dropbox_path}</code>
                              : <span className="text-xs text-gray-400 italic">sin ruta</span>}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className={`font-bold ${cfg.color}`} title={cfg.label}>{cfg.icon}</span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            {(r.status === 'missing' || r.status === 'stale_path') && (
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
