import { useState, useRef } from 'react';
import { Modal, Button } from '../common';

export const PdfUploadModal = ({ isOpen, onClose, article, onUpload }) => {
  const [file, setFile]       = useState(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef();

  if (!article) return null;

  const acceptFile = (f) => {
    if (f && f.type === 'application/pdf') setFile(f);
  };

  const handleDrop      = (e) => { e.preventDefault(); setDragging(false); acceptFile(e.dataTransfer.files[0]); };
  const handleDragOver  = (e) => { e.preventDefault(); setDragging(true); };
  const handleDragLeave = ()  => setDragging(false);
  const handleChange    = (e) => acceptFile(e.target.files[0]);

  const handleUpload = () => {
    if (!file) return;
    onUpload(article, file);
    setFile(null);
    onClose();
  };

  const handleClose = () => { setFile(null); onClose(); };

  const authors = Array.isArray(article.authors)
    ? article.authors.join(', ')
    : (article.authors ?? '');

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="" size="md">
      {/* Header: title + identifiers */}
      <div className="mb-5">
        <h2 className="text-xl font-bold text-gray-900 leading-snug">{article.title}</h2>
        {authors && (
          <p className="text-sm text-gray-500 mt-1 truncate">{authors}{article.year ? ` · ${article.year}` : ''}</p>
        )}
        <div className="flex flex-wrap gap-2 mt-3">
          {article.doi && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono font-semibold bg-indigo-50 text-indigo-700 rounded-lg border border-indigo-200 select-all">
              DOI&nbsp;&nbsp;{article.doi}
            </span>
          )}
          {article.pubmed_id && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono font-semibold bg-teal-50 text-teal-700 rounded-lg border border-teal-200 select-all">
              PMID&nbsp;&nbsp;{article.pubmed_id}
            </span>
          )}
          {!article.doi && !article.pubmed_id && (
            <span className="text-xs text-gray-400 italic">Sin DOI ni PMID</span>
          )}
        </div>
      </div>

      {/* Drop zone */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => { if (!file) inputRef.current?.click(); }}
        className={`border-2 border-dashed rounded-2xl py-10 px-6 text-center transition-all select-none ${
          dragging
            ? 'border-indigo-400 bg-indigo-50 scale-[1.01]'
            : file
            ? 'border-green-400 bg-green-50 cursor-default'
            : 'border-gray-300 hover:border-indigo-300 hover:bg-gray-50 cursor-pointer'
        }`}
      >
        <input ref={inputRef} type="file" accept=".pdf" className="hidden" onChange={handleChange} />

        {file ? (
          <div>
            <div className="text-5xl mb-3">📄</div>
            <p className="font-semibold text-green-800 break-all">{file.name}</p>
            <p className="text-sm text-green-600 mt-0.5">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
            <button
              onClick={(e) => { e.stopPropagation(); setFile(null); }}
              className="mt-3 text-xs text-gray-400 hover:text-red-500 underline underline-offset-2"
            >
              Cambiar archivo
            </button>
          </div>
        ) : (
          <div>
            <div className="text-5xl mb-3">{dragging ? '📂' : '📁'}</div>
            <p className="font-semibold text-gray-700">
              {dragging ? 'Suelta el PDF aquí' : 'Arrastra el PDF aquí'}
            </p>
            <p className="text-sm text-gray-400 mt-1">o haz clic para abrir el explorador</p>
          </div>
        )}
      </div>

      <div className="flex gap-2 justify-end mt-5">
        <Button variant="ghost" onClick={handleClose} type="button">Cancelar</Button>
        <Button onClick={handleUpload} disabled={!file}>Subir PDF</Button>
      </div>
    </Modal>
  );
};
