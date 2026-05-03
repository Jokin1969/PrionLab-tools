import { useState, useEffect } from 'react';
import { Modal, Input, Button } from '../common';
import { adminService } from '../../services/admin.service';

export const ArticleModal = ({ isOpen, onClose, onSave, article = null }) => {
  const [formData, setFormData] = useState({
    title: '',
    authors: '',
    year: new Date().getFullYear(),
    journal: '',
    doi: '',
    pubmed_id: '',
    abstract: '',
    tags: '',
    is_milestone: false,
    priority: 3,
  });
  const [pdfFile, setPdfFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [fetchingMetadata, setFetchingMetadata] = useState(false);

  useEffect(() => {
    if (article) {
      setFormData({
        title: article.title || '',
        authors: Array.isArray(article.authors)
          ? article.authors.join(', ')
          : article.authors || '',
        year: article.year || new Date().getFullYear(),
        journal: article.journal || '',
        doi: article.doi || '',
        pubmed_id: article.pubmed_id || '',
        abstract: article.abstract || '',
        tags: Array.isArray(article.tags) ? article.tags.join(', ') : article.tags || '',
        is_milestone: article.is_milestone || false,
        priority: article.priority || 3,
      });
    } else {
      setFormData({
        title: '',
        authors: '',
        year: new Date().getFullYear(),
        journal: '',
        doi: '',
        pubmed_id: '',
        abstract: '',
        tags: '',
        is_milestone: false,
        priority: 3,
      });
    }
    setPdfFile(null);
  }, [article]);

  const handleChange = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleFetchMetadata = async () => {
    if (!formData.doi && !formData.pubmed_id) return;
    setFetchingMetadata(true);
    try {
      const data = await adminService.fetchMetadata(formData.doi, formData.pubmed_id);
      const m = data.metadata ?? data;
      setFormData((prev) => ({
        ...prev,
        title: m.title || prev.title,
        authors: Array.isArray(m.authors) ? m.authors.join(', ') : m.authors || prev.authors,
        year: m.year || prev.year,
        journal: m.journal || prev.journal,
        abstract: m.abstract || prev.abstract,
        doi: m.doi || prev.doi,
        pubmed_id: m.pubmed_id || prev.pubmed_id,
      }));
    } catch {
      // error silently ignored — fields remain editable
    } finally {
      setFetchingMetadata(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('title', formData.title);
      fd.append('authors', formData.authors);
      fd.append('year', formData.year);
      fd.append('journal', formData.journal);
      fd.append('doi', formData.doi);
      fd.append('pubmed_id', formData.pubmed_id);
      fd.append('abstract', formData.abstract);
      fd.append('is_milestone', formData.is_milestone);
      fd.append('priority', formData.priority);

      const tagsArray = formData.tags
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      fd.append('tags', JSON.stringify(tagsArray));

      if (pdfFile) fd.append('pdf', pdfFile);

      await onSave(fd);
      onClose();
    } catch {
      // error surfaced by parent
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={article ? 'Editar Artículo' : 'Nuevo Artículo'}
      size="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* DOI/PubMed fetch */}
        <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
          <p className="text-sm font-medium text-blue-900 mb-3">
            Autocompletar desde DOI/PubMed
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="DOI"
              value={formData.doi}
              onChange={(e) => handleChange('doi', e.target.value)}
              placeholder="10.xxxx/xxxxx"
            />
            <Input
              label="PubMed ID"
              value={formData.pubmed_id}
              onChange={(e) => handleChange('pubmed_id', e.target.value)}
              placeholder="12345678"
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleFetchMetadata}
            loading={fetchingMetadata}
            disabled={!formData.doi && !formData.pubmed_id}
            className="mt-2"
          >
            🔍 Obtener Metadatos
          </Button>
        </div>

        <Input
          label="Título"
          value={formData.title}
          onChange={(e) => handleChange('title', e.target.value)}
          required
        />

        <Input
          label="Autores"
          value={formData.authors}
          onChange={(e) => handleChange('authors', e.target.value)}
          placeholder="Smith J, Doe A, ..."
          required
        />

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Año"
            type="number"
            value={formData.year}
            onChange={(e) => handleChange('year', parseInt(e.target.value))}
            required
          />
          <Input
            label="Revista"
            value={formData.journal}
            onChange={(e) => handleChange('journal', e.target.value)}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Abstract</label>
          <textarea
            value={formData.abstract}
            onChange={(e) => handleChange('abstract', e.target.value)}
            rows={4}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-prion-primary resize-y"
          />
        </div>

        <Input
          label="Tags (separados por comas)"
          value={formData.tags}
          onChange={(e) => handleChange('tags', e.target.value)}
          placeholder="prion diseases, methodology, neuroscience"
        />

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Prioridad (1-5)
            </label>
            <input
              type="range"
              min="1"
              max="5"
              value={formData.priority}
              onChange={(e) => handleChange('priority', parseInt(e.target.value))}
              className="w-full"
            />
            <p className="text-center text-sm text-gray-600 mt-1">{formData.priority}</p>
          </div>

          <div className="flex items-center">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.is_milestone}
                onChange={(e) => handleChange('is_milestone', e.target.checked)}
                className="w-4 h-4 text-prion-primary"
              />
              <span className="text-sm font-medium text-gray-700">⭐ Es Milestone</span>
            </label>
          </div>
        </div>

        {/* PDF Upload */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            PDF {!article && '(requerido)'}
          </label>
          <input
            type="file"
            accept=".pdf"
            onChange={(e) => setPdfFile(e.target.files[0])}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            required={!article}
          />
          {pdfFile && (
            <p className="text-xs text-gray-600 mt-1">
              Archivo: {pdfFile.name} ({(pdfFile.size / 1024 / 1024).toFixed(2)} MB)
            </p>
          )}
        </div>

        <div className="flex gap-2 justify-end pt-4 border-t">
          <Button variant="ghost" onClick={onClose} type="button">
            Cancelar
          </Button>
          <Button type="submit" loading={saving}>
            {article ? 'Actualizar' : 'Crear Artículo'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
