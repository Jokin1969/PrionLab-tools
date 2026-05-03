import { useState } from 'react';
import { Modal, Button } from '../common';
import { adminService } from '../../services/admin.service';

const STATUS = {
  pending:  { icon: '⏳', cls: 'text-gray-400' },
  loading:  { icon: '…',  cls: 'text-blue-500 animate-pulse' },
  ok:       { icon: '✓',  cls: 'text-green-600' },
  duplicate:{ icon: '△',  cls: 'text-amber-500' },
  error:    { icon: '✗',  cls: 'text-red-500' },
};

function parseEntry(raw) {
  const s = raw.trim();
  if (/^10\./.test(s))  return { doi: s,  pmid: '',  label: s };
  if (/^\d+$/.test(s))  return { doi: '',  pmid: s,  label: `PMID:${s}` };
  return                       { doi: s,  pmid: '',  label: s };
}

function parseEntries(text) {
  return text.split(/[\n\r\t,;]+/).map((s) => s.trim()).filter(Boolean).map(parseEntry);
}

export const BatchImportModal = ({ isOpen, onClose, onImported }) => {
  const [raw, setRaw]         = useState('');
  const [rows, setRows]       = useState([]);
  const [running, setRunning] = useState(false);
  const [done, setDone]       = useState(false);

  const reset = () => { setRaw(''); setRows([]); setDone(false); };
  const handleClose = () => { reset(); onClose(); };

  const entries = parseEntries(raw);

  const handleStart = async () => {
    if (!entries.length) return;
    setRows(entries.map((e) => ({ ...e, status: 'pending', title: '', error: '' })));
    setRunning(true);
    setDone(false);

    for (let i = 0; i < entries.length; i++) {
      const { doi, pmid, label } = entries[i];
      setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, status: 'loading' } : r));
      try {
        const meta = await adminService.fetchMetadata(doi, pmid);
        const m = meta.metadata ?? meta;
        const fd = new FormData();
        fd.append('title',        m.title     || label);
        fd.append('authors',      Array.isArray(m.authors) ? m.authors.join(', ') : (m.authors || ''));
        fd.append('year',         m.year       || new Date().getFullYear());
        fd.append('journal',      m.journal    || '');
        fd.append('doi',          m.doi        || doi);
        fd.append('pubmed_id',    m.pubmed_id  || pmid);
        fd.append('abstract',     m.abstract   || '');
        fd.append('is_milestone', 'false');
        fd.append('priority',     '3');
        await adminService.createArticle(fd);
        setRows((prev) => prev.map((r, idx) =>
          idx === i ? { ...r, status: 'ok', title: m.title || label } : r
        ));
      } catch (err) {
        const msg = err?.response?.data?.error || err?.message || 'Error desconocido';
        const isDupe = err?.response?.status === 409;
        setRows((prev) => prev.map((r, idx) =>
          idx === i ? { ...r, status: isDupe ? 'duplicate' : 'error', error: msg } : r
        ));
      }
    }
    setRunning(false);
    setDone(true);
    onImported();
  };

  const counts = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  const doiCount  = entries.filter((e) => e.doi  && !e.pmid).length;
  const pmidCount = entries.filter((e) => e.pmid && !e.doi).length;
  const countLabel = [
    entries.length ? `${entries.length} entrada${entries.length !== 1 ? 's' : ''}` : '',
    doiCount  ? `${doiCount} DOI`   : '',
    pmidCount ? `${pmidCount} PMID` : '',
  ].filter(Boolean).join(' · ');

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Importar artículos por DOI / PMID" size="lg">
      <div className="space-y-4">
        {rows.length === 0 ? (
          <>
            <p className="text-sm text-gray-600">
              Pega DOIs o PMIDs, mezclados o por separado. Se acepta uno por línea
              o separados por coma, punto y coma o tabulador (compatible con columna de Excel).
              Los metadatos se obtienen automáticamente desde CrossRef y PubMed.
            </p>
            <div className="grid grid-cols-2 gap-3 text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
              <div><span className="font-semibold">DOI</span> — empieza por <code>10.</code><br /><span className="text-gray-400">10.1038/s41586-023-06900-0</span></div>
              <div><span className="font-semibold">PMID</span> — solo números<br /><span className="text-gray-400">38234567</span></div>
            </div>
            <textarea
              rows={10}
              placeholder={`10.1016/j.cell.2023.01.001\n38234567\n10.1038/s41586-023-06900-0\n12345678`}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-prion-primary resize-y"
            />
            <p className="text-xs text-gray-400">{countLabel || 'Sin entradas detectadas'}</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={handleClose} type="button">Cancelar</Button>
              <Button onClick={handleStart} disabled={!entries.length}>
                Importar {entries.length > 0 ? entries.length : ''} artículos
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="max-h-96 overflow-y-auto space-y-1 pr-1">
              {rows.map((r, i) => {
                const s = STATUS[r.status];
                return (
                  <div key={i} className="flex items-start gap-3 px-3 py-2 rounded-lg bg-gray-50">
                    <span className={`mt-0.5 font-bold text-sm shrink-0 w-4 text-center ${s.cls}`}>{s.icon}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-800 truncate">{r.title || r.label}</p>
                      {r.title && r.title !== r.label && (
                        <p className="text-xs text-gray-400 truncate">{r.label}</p>
                      )}
                      {r.error && <p className="text-xs text-red-500 mt-0.5">{r.error}</p>}
                      {r.status === 'duplicate' && (
                        <p className="text-xs text-amber-500 mt-0.5">Ya existe en la biblioteca</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {done && (
              <div className="flex gap-3 text-sm pt-2 border-t">
                {counts.ok        > 0 && <span className="text-green-600">✓ {counts.ok} importado{counts.ok !== 1 ? 's' : ''}</span>}
                {counts.duplicate > 0 && <span className="text-amber-500">△ {counts.duplicate} duplicado{counts.duplicate !== 1 ? 's' : ''}</span>}
                {counts.error     > 0 && <span className="text-red-500">✗ {counts.error} error{counts.error !== 1 ? 'es' : ''}</span>}
              </div>
            )}
            <div className="flex justify-end gap-2">
              {!running && (
                <Button variant="ghost" onClick={reset} type="button">Nueva importación</Button>
              )}
              <Button variant={done ? 'primary' : 'ghost'} onClick={handleClose} disabled={running}>
                {running ? 'Importando…' : 'Cerrar'}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};
