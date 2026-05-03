import { useState } from 'react';
import { Modal, Button } from '../common';
import { adminService } from '../../services/admin.service';

function parseEntry(raw) {
  const s = raw.trim();
  if (/^10\./.test(s)) return { doi: s, pmid: '', label: s };
  if (/^\d+$/.test(s)) return { doi: '', pmid: s, label: `PMID:${s}` };
  return { doi: s, pmid: '', label: s };
}

function parseEntries(text) {
  return text
    .split(/[\n\r\t,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseEntry);
}

export const BatchImportModal = ({ isOpen, onClose, onImported }) => {
  const [text, setText] = useState('');
  const [results, setResults] = useState([]);
  const [running, setRunning] = useState(false);

  const handleClose = () => {
    if (running) return;
    setText('');
    setResults([]);
    onClose();
  };

  const handleImport = async () => {
    const entries = parseEntries(text);
    if (!entries.length) return;
    setRunning(true);
    setResults(entries.map((e) => ({ ...e, status: 'pending' })));

    for (let i = 0; i < entries.length; i++) {
      const { doi, pmid, label } = entries[i];
      try {
        const meta = await adminService.fetchMetadata(doi, pmid);
        const m = meta.metadata ?? meta;

        const fd = new FormData();
        fd.append('title', m.title || label);
        if (m.authors) {
          fd.append('authors', Array.isArray(m.authors) ? m.authors.join(', ') : m.authors);
        }
        if (m.year) fd.append('year', m.year);
        if (m.journal) fd.append('journal', m.journal);
        if (m.abstract) fd.append('abstract', m.abstract);
        const finalDoi = m.doi || doi;
        const finalPmid = m.pubmed_id || pmid;
        if (finalDoi) fd.append('doi', finalDoi);
        if (finalPmid) fd.append('pubmed_id', finalPmid);

        await adminService.createArticle(fd);
        setResults((prev) =>
          prev.map((r, idx) => (idx === i ? { ...r, status: 'ok' } : r))
        );
      } catch (err) {
        const isDuplicate = err?.response?.status === 409;
        setResults((prev) =>
          prev.map((r, idx) =>
            idx === i ? { ...r, status: isDuplicate ? 'duplicate' : 'error' } : r
          )
        );
      }
    }

    setRunning(false);
    if (onImported) onImported();
  };

  const statusIcon = (status) => {
    if (status === 'pending') return '⏳';
    if (status === 'ok') return '✓';
    if (status === 'duplicate') return '≈';
    return '✗';
  };

  const statusColor = (status) => {
    if (status === 'ok') return 'text-green-600';
    if (status === 'duplicate') return 'text-yellow-600';
    if (status === 'error') return 'text-red-600';
    return 'text-gray-400';
  };

  const done = results.length > 0 && !running;
  const ok = results.filter((r) => r.status === 'ok').length;
  const dup = results.filter((r) => r.status === 'duplicate').length;
  const err = results.filter((r) => r.status === 'error').length;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Importar DOIs / PMIDs" size="md">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Pega una lista de DOIs o PMIDs, uno por línea (o separados por coma / punto y coma).
          Compatible con pegado desde columna de Excel.
        </p>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={running}
          rows={6}
          placeholder={"10.1038/s41586-021-03819-2\n10.1016/j.cell.2021.01.014\n33574610"}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-prion-primary disabled:bg-gray-100 resize-y"
        />

        {results.length > 0 && (
          <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg divide-y">
            {results.map((r, i) => (
              <div
                key={i}
                className={`flex items-center gap-2 px-3 py-2 text-sm ${statusColor(r.status)}`}
              >
                <span className="w-4 text-center flex-shrink-0">{statusIcon(r.status)}</span>
                <span className="font-mono text-xs truncate flex-1">{r.label}</span>
              </div>
            ))}
          </div>
        )}

        {done && (
          <p className="text-sm font-medium text-gray-700">
            Resultado:{' '}
            <span className="text-green-600">{ok} importados</span>
            {dup > 0 && <span className="text-yellow-600"> · {dup} duplicados</span>}
            {err > 0 && <span className="text-red-600"> · {err} errores</span>}
          </p>
        )}

        <div className="flex gap-2 justify-end pt-2 border-t border-gray-100">
          <Button variant="ghost" onClick={handleClose} disabled={running}>
            {done ? 'Cerrar' : 'Cancelar'}
          </Button>
          {!done && (
            <Button
              onClick={handleImport}
              loading={running}
              disabled={!text.trim() || running}
            >
              Importar
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
};
