import { useState, useEffect } from 'react';
import { Modal, Button, Loader } from '../common';
import { adminService } from '../../services/admin.service';

const STATUS = {
  pending:    { label: 'Pendiente',  cls: 'bg-gray-100 text-gray-600' },
  read:       { label: 'Leído',      cls: 'bg-blue-100 text-blue-700' },
  summarized: { label: 'Resumido',   cls: 'bg-purple-100 text-purple-700' },
  evaluated:  { label: 'Evaluado',   cls: 'bg-green-100 text-green-700' },
};

const FILTER_LABELS = {
  read:       'Leídos',
  summarized: 'Resumidos',
  evaluated:  'Evaluados',
};

export const UserAssignmentsModal = ({ isOpen, onClose, user, statusFilter = null }) => {
  const [assignments, setAssignments]     = useState([]);
  const [allArticles, setAllArticles]     = useState([]);
  const [loading, setLoading]             = useState(false);
  const [search, setSearch]               = useState('');
  const [selected, setSelected]           = useState([]);
  const [assigning, setAssigning]         = useState(false);
  const [removingId, setRemovingId]       = useState(null);

  useEffect(() => {
    if (!isOpen || !user) return;
    setSearch('');
    setSelected([]);
    loadData();
  }, [isOpen, user]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [asgn, arts] = await Promise.all([
        adminService.getUserAssignments(user.id),
        adminService.getArticles({ limit: 100, sort_by: 'title', order: 'asc' }),
      ]);
      setAssignments(asgn.assignments || []);
      setAllArticles(arts.articles || []);
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async (asgnId) => {
    if (!window.confirm('¿Quitar este artículo de las asignaciones del usuario?')) return;
    setRemovingId(asgnId);
    try {
      await adminService.removeAssignment(asgnId);
      setAssignments((prev) => prev.filter((a) => a.id !== asgnId));
    } finally {
      setRemovingId(null);
    }
  };

  const handleAssign = async () => {
    if (!selected.length) return;
    setAssigning(true);
    try {
      await adminService.assignArticles(user.id, selected);
      setSelected([]);
      const data = await adminService.getUserAssignments(user.id);
      setAssignments(data.assignments || []);
    } finally {
      setAssigning(false);
    }
  };

  const toggleSelect = (id) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const assignedIds = new Set(assignments.map((a) => a.article?.id).filter(Boolean));

  const visibleAssignments = statusFilter
    ? assignments.filter((a) => statusFilter.includes(a.status))
    : assignments;

  const filterLabel = statusFilter
    ? statusFilter.map((s) => FILTER_LABELS[s] ?? s).join(' / ')
    : null;

  const unassigned = allArticles.filter(
    (a) =>
      !assignedIds.has(a.id) &&
      (a.title?.toLowerCase().includes(search.toLowerCase()) ||
        (typeof a.authors === 'string' ? a.authors : (a.authors || []).join(', '))
          .toLowerCase()
          .includes(search.toLowerCase()))
  );

  const unassignedMilestones = allArticles.filter(
    (a) => !assignedIds.has(a.id) && a.is_milestone
  );

  const allUnassignedSelected = unassigned.length > 0 && unassigned.every((a) => selected.includes(a.id));
  const allMilestonesSelected = unassignedMilestones.length > 0 && unassignedMilestones.every((a) => selected.includes(a.id));

  const handleToggleSelectAll = () => {
    if (allUnassignedSelected) {
      setSelected([]);
    } else {
      setSelected(unassigned.map((a) => a.id));
    }
  };

  const handleToggleMilestones = () => {
    if (allMilestonesSelected) {
      setSelected((prev) => prev.filter((id) => !unassignedMilestones.some((a) => a.id === id)));
    } else {
      const milestoneIds = unassignedMilestones.map((a) => a.id);
      setSelected((prev) => [...new Set([...prev, ...milestoneIds])]);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Asignaciones — ${user?.name ?? ''}`}
      size="lg"
    >
      <div className="space-y-6">

        {/* ── Assigned articles ── */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-sm font-semibold text-gray-700">
              Artículos asignados{' '}
              <span className="font-normal text-gray-400">
                ({visibleAssignments.length}{statusFilter ? ` de ${assignments.length}` : ''})
              </span>
            </h3>
            {filterLabel && (
              <span className="px-2 py-0.5 text-xs rounded-full bg-blue-50 text-blue-600 border border-blue-200">
                Filtro: {filterLabel}
              </span>
            )}
          </div>

          {loading ? (
            <Loader />
          ) : visibleAssignments.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">
              {statusFilter
                ? 'No hay artículos con este estado.'
                : 'Este usuario no tiene artículos asignados todavía.'}
            </p>
          ) : (
            <div className="max-h-64 overflow-y-auto space-y-1 pr-1">
              {visibleAssignments.map((a) => {
                const st = STATUS[a.status] ?? STATUS.pending;
                const authorsText =
                  typeof a.article?.authors === 'string'
                    ? a.article.authors
                    : (a.article?.authors || []).join(', ');
                return (
                  <div
                    key={a.id}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-50 hover:bg-gray-100"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {a.article?.title ?? '—'}
                      </p>
                      <p className="text-xs text-gray-500 truncate">
                        {a.article?.year}{authorsText ? ` · ${authorsText.substring(0, 60)}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`px-2 py-0.5 text-xs font-medium rounded ${st.cls}`}>
                        {st.label}
                      </span>
                      {a.read_date && (
                        <span className="text-xs text-gray-400">
                          {String(a.read_date).substring(0, 10)}
                        </span>
                      )}
                      <button
                        onClick={() => handleRemove(a.id)}
                        disabled={removingId === a.id}
                        className="text-xs text-red-400 hover:text-red-600 disabled:opacity-40"
                      >
                        {removingId === a.id ? '...' : 'Quitar'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Assign new articles ── */}
        <section className="border-t pt-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-gray-700">Asignar artículos</h3>
            <div className="flex items-center gap-3">
              {unassignedMilestones.length > 0 && (
                <button
                  onClick={handleToggleMilestones}
                  className="text-xs font-medium text-amber-600 hover:text-amber-800 underline underline-offset-2"
                >
                  {allMilestonesSelected
                    ? `Deseleccionar milestones`
                    : `⭐ Milestones (${unassignedMilestones.length})`}
                </button>
              )}
              {unassigned.length > 0 && (
                <button
                  onClick={handleToggleSelectAll}
                  className="text-xs font-medium text-indigo-600 hover:text-indigo-800 underline underline-offset-2"
                >
                  {allUnassignedSelected ? 'Deseleccionar todos' : `Seleccionar todos (${unassigned.length})`}
                </button>
              )}
            </div>
          </div>
          <input
            type="text"
            placeholder="Buscar por título o autor..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-prion-primary"
          />

          <div className="max-h-48 overflow-y-auto space-y-0.5 mb-3">
            {unassigned.length === 0 ? (
              <p className="text-sm text-gray-400 py-4 text-center">
                {search ? 'Sin resultados' : 'Todos los artículos ya están asignados'}
              </p>
            ) : (
              unassigned.map((article) => (
                <label
                  key={article.id}
                  className="flex items-center gap-2 px-2 py-1.5 hover:bg-gray-50 rounded cursor-pointer"
                >
                  <input
                    type="checkbox"
                    className="w-4 h-4 text-prion-primary"
                    checked={selected.includes(article.id)}
                    onChange={() => toggleSelect(article.id)}
                  />
                  <span className="text-sm text-gray-800 truncate flex items-center gap-1">
                    {article.is_milestone && <span title="Milestone">⭐</span>}
                    {article.title}
                    <span className="text-gray-400 ml-1">({article.year})</span>
                  </span>
                </label>
              ))
            )}
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">
              {selected.length > 0 ? `${selected.length} seleccionado${selected.length > 1 ? 's' : ''}` : ''}
            </span>
            <Button
              size="sm"
              onClick={handleAssign}
              disabled={selected.length === 0}
              loading={assigning}
            >
              Asignar seleccionados
            </Button>
          </div>
        </section>

      </div>
    </Modal>
  );
};
