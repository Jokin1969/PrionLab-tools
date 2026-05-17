import { useState, useEffect } from 'react';
import { Modal, Input, Button } from '../common';
import { adminService } from '../../services/admin.service';

export const ArticleModal = ({ isOpen, onClose, onSave, article = null }) => {
  const [formData, setFormData] = useState({
    title: '', authors: '', year: new Date().getFullYear(),
    journal: '', doi: '', pubmed_id: '', abstract: '', tags: '',
    is_milestone: false, priority: 3,
  });
  const [pdfFile, setPdfFile]             = useState(null);
  const [saving, setSaving]               = useState(false);
  const [fetchingMetadata, setFetchingMetadata] = useState(false);
  const [identifyingPmid, setIdentifyingPmid]   = useState(false);
  const [aiHint, setAiHint]               = useState(null);
  const [openingPdf, setOpeningPdf]       = useState(false);
  const [error, setError]                 = useState('');

  useEffect(() => {
    setError('');
    setPdfFile(null);
    setAiHint(null);
    if (article) {
      setFormData({
        title:        article.title || '',
        authors:      Array.isArray(article.authors) ? article.authors.join(', ') : article.authors || '',
        year:         article.year || new Date().getFullYear(),
        journal:      article.journal || '',
        doi:          article.doi || '',
        pubmed_id:    article.pubmed_id || '',
        abstract:     article.abstract || '',
        tags:         Array.isArray(article.tags) ? article.tags.join(', ') : article.tags || '',
        is_milestone: article.is_milestone || false,
        priority:     article.priority || 3,
      });
    } else {
      setFormData({
        title: '', authors: '', year: new Date().getFullYear(),
        journal: '', doi: '', pubmed_id: '', abstract: '', tags: '',
        is_milestone: false, priority: 3,
      });
    }
  }, [article, isOpen]);

  const handleChange = (field, value) => {
    setFormData((prev) => {
      const next = { ...prev, [field]: value };
      if (field === 'is_milestone' && value === true) next.priority = 5;
      return next;
    });
  };

  // `overrides` lets callers (notably the AI PMID identifier) trigger a
  // fetch with a freshly resolved id without waiting for React state to
  // settle from the preceding setFormData call.
  const handleFetchMetadata = async (overrides = {}) => {
    const doi  = overrides.doi       ?? formData.doi;
    const pmid = overrides.pubmed_id ?? formData.pubmed_id;
    if (!doi && !pmid) return;
    setFetchingMetadata(true);
    try {
      const data = await adminService.fetchMetadata(doi, pmid);
      const m = data.metadata ?? data;
      setFormData((prev) => ({
        ...prev,
        title:     m.title     || prev.title,
        authors:   Array.isArray(m.authors) ? m.authors.join(', ') : m.authors || prev.authors,
        year:      m.year      || prev.year,
        journal:   m.journal   || prev.journal,
        abstract:  m.abstract  || prev.abstract,
        doi:       m.doi       || prev.doi,
        pubmed_id: m.pubmed_id || prev.pubmed_id,
      }));
    } catch { /* fields remain editable */ }
    finally { setFetchingMetadata(false); }
  };

  const handleIdentifyPmid = async () => {
    if (!article?.id) return;
    setIdentifyingPmid(true);
    setAiHint(null);
    setError('');
    try {
      const data = await adminService.identifyPmid(article.id);
      const pmid = String(data.pmid);
      setAiHint({ pmid, identified: data.identified || null });
      setFormData((prev) => ({ ...prev, pubmed_id: pmid }));
      // Chain straight into the existing metadata fetch — same path the
      // user runs manually after pasting a PMID.
      await handleFetchMetadata({ pubmed_id: pmid });
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || 'No se pudo identificar el PMID con IA';
      const identified = err?.response?.data?.identified;
      if (identified) setAiHint({ pmid: null, identified });
      setError(msg);
    } finally {
      setIdentifyingPmid(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('title',        formData.title);
      fd.append('authors',      formData.authors);
      fd.append('year',         formData.year);
      fd.append('journal',      formData.journal);
      fd.append('abstract',     formData.abstract);
      fd.append('is_milestone', formData.is_milestone);
      fd.append('priority',     formData.priority);
      const tagsArray = formData.tags.split(',').map((t) => t.trim()).filter(Boolean);
      fd.append('tags', JSON.stringify(tagsArray));

      // For updates, only send doi/pubmed_id if the user actually changed them.
      // The backend uniqueness check does not exclude the current article, so
      // sending back the article's own ids would cause a false 409 conflict.
      const isUpdate = Boolean(article);
      const originalDoi   = article?.doi       ?? '';
      const originalPmid  = article?.pubmed_id ?? '';
      if (!isUpdate || formData.doi !== originalDoi) {
        if (formData.doi) fd.append('doi', formData.doi);
      }
      if (!isUpdate || formData.pubmed_id !== originalPmid) {
        if (formData.pubmed_id) fd.append('pubmed_id', formData.pubmed_id);
      }

      if (pdfFile) fd.append('pdf', pdfFile);
      await onSave(fd);
      onClose();
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const hasPdf = Boolean(article?.dropbox_path);

  const handleOpenPdf = async () => {
    if (!article?.id) return;
    setOpeningPdf(true);
    try {
      const data = await adminService.getArticlePdfLink(article.id);
      const resp = await fetch(data.url);
      if (!resp.ok) throw new Error('No se pudo obtener el PDF');
      const blob = await resp.blob();
      const objUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
      window.open(objUrl, '_blank');
      setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
    } catch { setError('No se pudo abrir el PDF. Inténtalo de nuevo.'); }
    finally { setOpeningPdf(false); }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={article ? 'Editar Artículo' : 'Nuevo Artículo'} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">

        {/* DOI / PubMed */}
        <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
          <p className="text-sm font-medium text-blue-900 mb-3">Autocompletar desde DOI/PubMed</p>
          <div className="grid grid-cols-2 gap-3">
            <Input label="DOI" value={formData.doi} onChange={(e) => handleChange('doi', e.target.value)} placeholder="10.xxxx/xxxxx" />
            <Input label="PubMed ID" value={formData.pubmed_id} onChange={(e) => handleChange('pubmed_id', e.target.value)} placeholder="12345678" />
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => handleFetchMetadata()} loading={fetchingMetadata} disabled={!formData.doi && !formData.pubmed_id}>
              🔍 Obtener Metadatos
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleIdentifyPmid}
              loading={identifyingPmid}
              disabled={!hasPdf || identifyingPmid || fetchingMetadata}
              title={hasPdf ? 'La IA lee el PDF, identifica el artículo y busca su PMID en PubMed' : 'Guarda el artículo con un PDF para usar esta opción'}
            >
              🤖 Buscar PMID con IA
            </Button>
          </div>
          {aiHint && (
            <div className="mt-2 text-xs text-blue-800 bg-blue-100/60 border border-blue-200 rounded px-2 py-1.5 space-y-0.5">
              {aiHint.pmid && <div>PMID propuesto por IA: <span className="font-mono font-semibold">{aiHint.pmid}</span></div>}
              {aiHint.identified?.title && <div className="text-blue-700 italic truncate">«{aiHint.identified.title}»</div>}
              {(aiHint.identified?.first_author_lastname || aiHint.identified?.year) && (
                <div className="text-blue-700">
                  {aiHint.identified.first_author_lastname || '?'} · {aiHint.identified.year || '?'}
                </div>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <Input label="Título" value={formData.title} onChange={(e) => handleChange('title', e.target.value)} required />
        <Input label="Autores" value={formData.authors} onChange={(e) => handleChange('authors', e.target.value)} placeholder="Smith J, Doe A, ..." required />

        <div className="grid grid-cols-2 gap-4">
          <Input label="Año" type="number" value={formData.year} onChange={(e) => handleChange('year', parseInt(e.target.value))} required />
          <Input label="Revista" value={formData.journal} onChange={(e) => handleChange('journal', e.target.value)} />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Abstract</label>
          <textarea value={formData.abstract} onChange={(e) => handleChange('abstract', e.target.value)} rows={4} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-prion-primary resize-y" />
        </div>

        <Input label="Tags (separados por comas)" value={formData.tags} onChange={(e) => handleChange('tags', e.target.value)} placeholder="prion diseases, methodology, neuroscience" />

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Prioridad (1-5)</label>
            <input type="range" min="1" max="5" value={formData.priority} onChange={(e) => handleChange('priority', parseInt(e.target.value))} className="w-full" />
            <p className="text-center text-sm text-gray-600 mt-1">{formData.priority}</p>
          </div>
          <div className="flex items-center">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={formData.is_milestone} onChange={(e) => handleChange('is_milestone', e.target.checked)} className="w-4 h-4 text-prion-primary" />
              <span className="text-sm font-medium text-gray-700">⭐ Es Milestone</span>
            </label>
          </div>
        </div>

        {formData.is_milestone && (
          <p className="text-xs text-amber-600">⭐ Milestone → prioridad fijada a 5 automáticamente</p>
        )}

        {/* PDF */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            PDF{' '}
            {hasPdf ? (
              <span className="inline-flex items-center gap-1 ml-1 px-2 py-0.5 text-xs font-normal bg-green-100 text-green-700 rounded-full">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                PDF disponible
              </span>
            ) : (
              <span className="text-gray-400 font-normal">(opcional)</span>
            )}
          </label>

          {hasPdf && (
            <div className="flex items-center gap-3 mb-2 px-3 py-2 bg-green-50 border border-green-200 rounded-lg">
              <svg className="w-4 h-4 text-green-600 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" /></svg>
              <button
                type="button"
                onClick={handleOpenPdf}
                disabled={openingPdf}
                className="text-sm text-green-700 hover:text-green-900 hover:underline truncate flex-1 text-left disabled:opacity-50"
              >
                {openingPdf ? 'Abriendo PDF…' : 'Ver PDF actual'}
              </button>
            </div>
          )}

          <input type="file" accept=".pdf" onChange={(e) => setPdfFile(e.target.files[0])} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
          <p className="text-xs text-gray-400 mt-1">
            {hasPdf ? 'Selecciona un archivo solo si quieres sustituir el PDF actual' : 'Selecciona el PDF del artículo'}
          </p>
          {pdfFile && (
            <p className="text-xs text-green-700 mt-1 font-medium">
              Nuevo archivo: {pdfFile.name} ({(pdfFile.size / 1024 / 1024).toFixed(2)} MB)
            </p>
          )}
        </div>

        <div className="flex gap-2 justify-end pt-4 border-t">
          <Button variant="ghost" onClick={onClose} type="button">Cancelar</Button>
          <Button type="submit" loading={saving}>{article ? 'Actualizar' : 'Crear Artículo'}</Button>
        </div>
      </form>
    </Modal>
  );
};
