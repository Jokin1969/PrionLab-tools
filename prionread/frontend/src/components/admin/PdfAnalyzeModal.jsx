import { useState, useRef } from 'react';
import { Modal, Button } from '../common';
import { adminService } from '../../services/admin.service';

const Field = ({ label, value, onChange }) => (
  <div>
    <label className="block text-xs font-medium text-gray-500 mb-0.5">{label}</label>
    {onChange
      ? <input
          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-prion-primary"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
        />
      : <p className="text-sm text-gray-800">{value || <span className="text-gray-400 italic">—</span>}</p>}
  </div>
);

export const PdfAnalyzeModal = ({ isOpen, onClose, onImported }) => {
  const [dragging, setDragging]   = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult]       = useState(null);
  const [error, setError]         = useState('');
  const [meta, setMeta]           = useState(null);
  const [saving, setSaving]       = useState(false);
  const inputRef = useRef();

  const reset = () => { setResult(null); setError(''); setMeta(null); };
  const handleClose = () => { reset(); onClose(); };

  const analyze = async (file) => {
    if (!file || file.type !== 'application/pdf') {
      setError('Solo se aceptan archivos PDF'); return;
    }
    setAnalyzing(true); setResult(null); setError(''); setMeta(null);
    try {
      const data = await adminService.analyzePdf(file);
      setResult(data);
      setMeta(data.metadata ? { ...data.metadata } : null);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Error analizando el PDF');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) analyze(file);
  };

  const handleCreate = async () => {
    if (!meta) return;
    setSaving(true);
    try {
      const fd = new FormData();
      Object.entries(meta).forEach(([k, v]) => {
        if (v != null) fd.append(k, Array.isArray(v) ? JSON.stringify(v) : String(v));
      });
      await adminService.createArticle(fd);
      if (onImported) onImported();
      handleClose();
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Error creando el artículo');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Importar artículo desde PDF" size="lg">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Arrastra un PDF o selecciónalo. Se extrae el DOI, se consulta CrossRef / PubMed
          y se rellena el formulario automáticamente.
        </p>

        {/* Drop zone */}
        {!result && !analyzing && (
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            className={`cursor-pointer rounded-xl border-2 border-dashed transition-colors flex flex-col items-center justify-center gap-2 py-12 ${
              dragging ? 'border-prion-primary bg-indigo-50' : 'border-gray-300 hover:border-prion-primary hover:bg-gray-50'
            }`}
          >
            <span className="text-4xl">📄</span>
            <p className="text-sm font-medium text-gray-600">Arrastra el PDF aquí o haz clic para seleccionar</p>
            <input ref={inputRef} type="file" accept="application/pdf" className="hidden"
              onChange={(e) => { if (e.target.files[0]) analyze(e.target.files[0]); }} />
          </div>
        )}

        {/* Spinner */}
        {analyzing && (
          <div className="flex flex-col items-center gap-3 py-10">
            <svg className="animate-spin h-8 w-8 text-prion-primary" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            <p className="text-sm text-gray-500">Extrayendo DOI y consultando metadatos…</p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-4">
            {/* DOI found */}
            <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-2 flex items-center gap-2">
              <span className="text-green-600 font-bold">✓</span>
              <span className="text-sm text-green-800">DOI encontrado: <code className="font-mono">{result.doi}</code></span>
            </div>

            {/* Dropbox filename */}
            <div className="rounded-lg bg-blue-50 border border-blue-200 px-4 py-2">
              <p className="text-xs font-semibold text-blue-700 mb-0.5">Nombre del fichero en Dropbox</p>
              <code className="text-sm text-blue-900 break-all">{result.dropbox_filename}</code>
              <p className="text-xs text-blue-500 mt-0.5">Carpeta: /PrionLab tools/PrionRead/</p>
            </div>

            {meta ? (
              <>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Metadatos obtenidos — revisa y confirma
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="sm:col-span-2">
                    <Field label="Título" value={meta.title} onChange={(v) => setMeta((p) => ({ ...p, title: v }))} />
                  </div>
                  <div className="sm:col-span-2">
                    <Field label="Autores" value={meta.authors} onChange={(v) => setMeta((p) => ({ ...p, authors: v }))} />
                  </div>
                  <Field label="Año" value={meta.year} onChange={(v) => setMeta((p) => ({ ...p, year: v }))} />
                  <Field label="Revista" value={meta.journal} onChange={(v) => setMeta((p) => ({ ...p, journal: v }))} />
                  <Field label="DOI" value={meta.doi} />
                  <Field label="PMID" value={meta.pubmed_id} />
                  {meta.abstract && (
                    <div className="sm:col-span-2">
                      <p className="text-xs font-medium text-gray-500 mb-0.5">Abstract</p>
                      <p className="text-xs text-gray-700 leading-relaxed line-clamp-4">{meta.abstract}</p>
                    </div>
                  )}
                </div>
                <div className="flex gap-2 justify-between pt-2 border-t border-gray-100">
                  <button onClick={reset} className="text-sm text-gray-500 hover:text-gray-700 underline underline-offset-2">
                    Analizar otro PDF
                  </button>
                  <Button onClick={handleCreate} loading={saving} disabled={!meta.title}>
                    Crear artículo
                  </Button>
                </div>
              </>
            ) : (
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
                DOI encontrado pero no se pudieron obtener metadatos de CrossRef / PubMed.
                Puedes crear el artículo manualmente usando el DOI <code className="font-mono">{result.doi}</code>.
                <div className="mt-2">
                  <button onClick={reset} className="text-sm text-amber-700 hover:text-amber-900 underline underline-offset-2">
                    Analizar otro PDF
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};
