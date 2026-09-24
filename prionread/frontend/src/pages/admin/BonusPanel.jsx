import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminService } from '../../services/admin.service';
import { Card, Button, Modal, Loader } from '../../components/common';

const TASK_TYPES = [
  { value: 'meeting',     icon: '🤝', label: 'Reunión' },
  { value: 'review',      icon: '📝', label: 'Revisión' },
  { value: 'guidance',    icon: '💡', label: 'Orientación' },
  { value: 'reply',       icon: '📧', label: 'Respuesta' },
  { value: 'other',       icon: '✨', label: 'Otro' },
];

const MINUTE_PRESETS = [30, 60, 90, 120];

const DEBT_THRESHOLD = -120;

function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
}

function balanceColor(balance) {
  if (balance >= 0) return { bg: 'bg-emerald-500', text: 'text-emerald-600', badge: 'bg-emerald-100 text-emerald-700' };
  if (balance >= DEBT_THRESHOLD) return { bg: 'bg-amber-500', text: 'text-amber-600', badge: 'bg-amber-100 text-amber-700' };
  return { bg: 'bg-red-500', text: 'text-red-600', badge: 'bg-red-100 text-red-700' };
}

function fmtMin(minutes) {
  const abs = Math.abs(minutes);
  const h   = Math.floor(abs / 60);
  const m   = abs % 60;
  const sign = minutes < 0 ? '−' : '+';
  if (h === 0) return `${sign}${m}min`;
  return `${sign}${h}h${m > 0 ? ` ${m}min` : ''}`;
}

function fmtDate(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleDateString('es-ES', {
      day: '2-digit', month: '2-digit', year: 'numeric',
    });
  } catch { return ''; }
}

const TASK_TYPE_MAP = {
  meeting:  { icon: '🤝', label: 'Reunión' },
  review:   { icon: '📝', label: 'Revisión' },
  guidance: { icon: '💡', label: 'Orientación' },
  reply:    { icon: '📧', label: 'Respuesta' },
  other:    { icon: '✨', label: 'Otro' },
};

const BonusPanel = () => {
  const navigate = useNavigate();
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form state
  const [selectedStudent, setSelectedStudent] = useState('');
  const [taskType, setTaskType]               = useState('other');
  const [description, setDescription]         = useState('');
  const [minutes, setMinutes]                 = useState('');
  const [formError, setFormError]             = useState('');

  // Per-student breakdown (lazy-loaded on first expand, cached afterwards).
  const [expandedId, setExpandedId]         = useState(null);
  const [details, setDetails]               = useState({});
  const [detailsLoading, setDetailsLoading] = useState({});

  const toggleExpand = useCallback(async (studentId) => {
    if (expandedId === studentId) { setExpandedId(null); return; }
    setExpandedId(studentId);
    if (details[studentId]) return;
    setDetailsLoading((prev) => ({ ...prev, [studentId]: true }));
    try {
      const d = await adminService.getStudentBonusDetail(studentId);
      setDetails((prev) => ({ ...prev, [studentId]: d }));
    } catch (e) {
      setDetails((prev) => ({ ...prev, [studentId]: { error: e?.response?.data?.error || 'Error cargando detalle' } }));
    } finally {
      setDetailsLoading((prev) => ({ ...prev, [studentId]: false }));
    }
  }, [expandedId, details]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await adminService.getAdminBonus();
      setData(res);
    } catch (err) {
      setError('Error cargando datos de PrionBonus');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openModal = (studentId = '') => {
    setSelectedStudent(studentId);
    setTaskType('other');
    setDescription('');
    setMinutes('');
    setFormError('');
    setModalOpen(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');

    const mins = parseInt(minutes, 10);
    if (!selectedStudent) { setFormError('Selecciona un estudiante'); return; }
    if (!description.trim()) { setFormError('La descripción es obligatoria'); return; }
    if (!minutes || isNaN(mins) || mins <= 0) { setFormError('Los minutos deben ser un número positivo'); return; }

    try {
      setSubmitting(true);
      await adminService.addBonusAllocation({
        user_id: selectedStudent,
        task_type: taskType,
        description: description.trim(),
        minutes: mins,
      });
      setModalOpen(false);
      // The cached breakdown for this student is now stale — drop it
      // so the next expand re-fetches from the server.
      setDetails((prev) => {
        const next = { ...prev };
        delete next[selectedStudent];
        return next;
      });
      await load();
    } catch (err) {
      setFormError(err?.response?.data?.error || 'Error guardando la asignación');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Loader fullScreen />;
  if (error)   return <div className="p-8 text-red-600">{error}</div>;

  const students = data?.students ?? [];
  const totalEarned    = students.reduce((s, st) => s + st.earned, 0);
  const totalAllocated = students.reduce((s, st) => s + st.spent, 0);
  const totalBalance   = totalEarned - totalAllocated;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">⚡ PrionBonus</h1>
          <p className="text-gray-600 mt-1">Sistema de créditos de tiempo para estudiantes</p>
        </div>
        <Button onClick={() => openModal('')}>
          ➕ Asignar tiempo
        </Button>
      </div>

      {/* Global stats bar */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 text-center">
          <p className="text-3xl font-bold text-emerald-600">{fmtMin(totalEarned).replace('+', '')}</p>
          <p className="text-sm text-gray-500 mt-1">Total ganado</p>
        </div>
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 text-center">
          <p className="text-3xl font-bold text-indigo-600">{fmtMin(-totalAllocated).replace('−', '')}</p>
          <p className="text-sm text-gray-500 mt-1">Total asignado</p>
        </div>
        <div className={`rounded-lg shadow-sm border p-5 text-center ${totalBalance >= 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
          <p className={`text-3xl font-bold ${totalBalance >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
            {fmtMin(totalBalance)}
          </p>
          <p className="text-sm text-gray-500 mt-1">Balance global</p>
        </div>
      </div>

      {/* Student cards grid */}
      {students.length === 0 ? (
        <Card>
          <p className="text-center text-gray-500 py-8">No hay estudiantes con datos de PrionBonus aún.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {students.map((student) => {
            const colors = balanceColor(student.balance);
            const isOpen = expandedId === student.id;
            return (
              <div key={student.id} className={`bg-white rounded-xl shadow-sm border overflow-hidden transition-shadow ${isOpen ? 'border-indigo-300 shadow-md' : 'border-gray-200'}`}>
                {/* Card top bar */}
                <div className={`h-1.5 w-full ${colors.bg}`} />

                <div
                  onClick={() => toggleExpand(student.id)}
                  className="p-5 cursor-pointer"
                  title={isOpen ? 'Plegar detalle' : 'Ver detalle de bonus ganados / gastados'}
                >
                  <div className="flex items-center gap-3 mb-4">
                    {/* Initials circle */}
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0 ${colors.bg}`}>
                      {initials(student.name)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-gray-900 truncate">{student.name}</p>
                      <p className="text-xs text-gray-500 truncate">{student.email}</p>
                    </div>
                    <span className="text-gray-400 text-xs flex-shrink-0" aria-hidden="true">
                      {isOpen ? '▾' : '▸'}
                    </span>
                  </div>

                  {/* Stats row */}
                  <div className="grid grid-cols-3 gap-2 mb-4 text-center">
                    <div>
                      <p className="text-sm font-semibold text-emerald-600">{student.earned}min</p>
                      <p className="text-xs text-gray-400">Ganado</p>
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-indigo-600">{student.spent}min</p>
                      <p className="text-xs text-gray-400">Gastado</p>
                    </div>
                    <div>
                      <p className={`text-sm font-bold ${colors.text}`}>{fmtMin(student.balance)}</p>
                      <p className="text-xs text-gray-400">Balance</p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {student.credits_count > 0 ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); navigate('/admin/articles', {
                            state: {
                              filterUser: { id: student.id, name: student.name },
                              filterStatuses: ['evaluated'],
                            },
                          }); }}
                          className={`text-xs px-2 py-1 rounded-full font-medium ${colors.badge} hover:opacity-80 transition-opacity cursor-pointer`}
                          title="Artículos completados con bonus — clic para ver"
                        >
                          ⚡ {student.credits_count} art.
                        </button>
                      ) : (
                        <span className="text-xs px-2 py-1 rounded-full font-medium bg-gray-100 text-gray-400">
                          Sin artículos aún
                        </span>
                      )}
                    </div>
                    <Button
                      size="sm"
                      onClick={(e) => { e.stopPropagation(); openModal(student.id); }}
                    >
                      ➕ Asignar
                    </Button>
                  </div>
                </div>

                {isOpen && (
                  <BonusBreakdown
                    detail={details[student.id]}
                    loading={!!detailsLoading[student.id]}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Allocation modal */}
      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Asignar tiempo de Jokin"
        size="md"
      >
        <form onSubmit={handleSubmit} className="space-y-5">

          {/* Student select */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Estudiante</label>
            <select
              value={selectedStudent}
              onChange={(e) => setSelectedStudent(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              required
            >
              <option value="">— Seleccionar estudiante —</option>
              {students.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          {/* Task type radio */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Tipo de tarea</label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {TASK_TYPES.map((t) => (
                <label
                  key={t.value}
                  className={`flex items-center gap-2 p-3 border rounded-lg cursor-pointer text-sm transition-colors ${
                    taskType === t.value
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700 font-medium'
                      : 'border-gray-200 hover:border-gray-300 text-gray-700'
                  }`}
                >
                  <input
                    type="radio"
                    name="task_type"
                    value={t.value}
                    checked={taskType === t.value}
                    onChange={(e) => setTaskType(e.target.value)}
                    className="sr-only"
                  />
                  <span>{t.icon}</span>
                  <span>{t.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Descripción</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Ej: Reunión de seguimiento de tesis – 45 min"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              required
            />
          </div>

          {/* Minutes */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Minutos a asignar</label>
            <div className="flex gap-2 mb-2">
              {MINUTE_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setMinutes(String(p))}
                  className={`flex-1 py-2 text-sm font-medium border rounded-lg transition-colors ${
                    minutes === String(p)
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'border-gray-300 text-gray-700 hover:border-indigo-400'
                  }`}
                >
                  {p}min
                </button>
              ))}
            </div>
            <input
              type="number"
              min="1"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              placeholder="O introduce un número personalizado"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          {formError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {formError}
            </p>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setModalOpen(false)} type="button">
              Cancelar
            </Button>
            <Button type="submit" loading={submitting}>
              ⚡ Asignar tiempo
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

/**
 * Per-student bonus breakdown shown below an expanded student card.
 * Receives the raw `getStudentBonusDetail` response and renders two
 * columns:
 *   • Ganados   = BonusCredit rows (article reads + admin-gifted notes)
 *   • Gastados  = BonusAllocation rows (admin-assigned tasks)
 */
function BonusBreakdown({ detail, loading }) {
  if (loading) {
    return (
      <div className="border-t border-gray-100 px-5 py-4 text-sm text-gray-500 text-center">
        Cargando detalle…
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="border-t border-gray-100 px-5 py-4 text-sm text-gray-400 text-center">
        Sin datos.
      </div>
    );
  }
  if (detail.error) {
    return (
      <div className="border-t border-gray-100 px-5 py-4 text-sm text-red-600">
        {detail.error}
      </div>
    );
  }

  const credits     = (detail.transactions || []).filter((t) => t.type === 'credit');
  const allocations = (detail.transactions || []).filter((t) => t.type === 'allocation');
  const earned      = detail.earned ?? 0;
  const spent       = detail.spent  ?? 0;

  return (
    <div className="border-t border-gray-100 bg-gray-50 px-5 py-4 space-y-4 text-sm">
      {/* ── Ganados ────────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h4 className="font-semibold text-emerald-700">⚡ Bonus ganados</h4>
          <span className="text-xs font-medium text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">
            {credits.length} mov. · {fmtMin(earned).replace('+', '')}
          </span>
        </div>
        {credits.length === 0 ? (
          <p className="text-xs text-gray-400 italic">Aún no ha ganado bonus.</p>
        ) : (
          <ul className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
            {credits.map((c) => {
              const isGift = !c.article;
              const label  = isGift ? (c.note || 'Bonus otorgado') : c.article.title;
              const meta   = isGift
                ? null
                : `${c.pages ?? '—'} pág.`;
              return (
                <li key={c.id} className="flex items-start gap-2 text-xs bg-white border border-gray-100 rounded-md px-2.5 py-1.5">
                  <span className="text-base leading-none flex-shrink-0">
                    {isGift ? '🎁' : '📄'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-800 truncate" title={label}>{label}</p>
                    <p className="text-[11px] text-gray-500">
                      {fmtDate(c.created_at)}{meta ? ` · ${meta}` : ''}
                    </p>
                  </div>
                  <span className="text-emerald-700 font-semibold whitespace-nowrap">
                    {fmtMin(c.minutes)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Gastados ───────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h4 className="font-semibold text-indigo-700">⏱ Bonus gastados</h4>
          <span className="text-xs font-medium text-indigo-700 bg-indigo-100 px-2 py-0.5 rounded-full">
            {allocations.length} mov. · {fmtMin(-spent).replace('−', '')}
          </span>
        </div>
        {allocations.length === 0 ? (
          <p className="text-xs text-gray-400 italic">Sin gastos asignados.</p>
        ) : (
          <ul className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
            {allocations.map((a) => {
              const tt = TASK_TYPE_MAP[a.task_type] || TASK_TYPE_MAP.other;
              return (
                <li key={a.id} className="flex items-start gap-2 text-xs bg-white border border-gray-100 rounded-md px-2.5 py-1.5">
                  <span className="text-base leading-none flex-shrink-0">{tt.icon}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-800 truncate" title={a.description}>
                      <span className="text-gray-500">{tt.label}</span>
                      {a.description ? ` · ${a.description}` : ''}
                    </p>
                    <p className="text-[11px] text-gray-500">{fmtDate(a.created_at)}</p>
                  </div>
                  <span className="text-indigo-700 font-semibold whitespace-nowrap">
                    {fmtMin(a.minutes)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

export default BonusPanel;
