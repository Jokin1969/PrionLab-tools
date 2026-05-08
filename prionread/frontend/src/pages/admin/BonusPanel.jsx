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
            return (
              <div key={student.id} className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                {/* Card top bar */}
                <div className={`h-1.5 w-full ${colors.bg}`} />

                <div className="p-5">
                  <div className="flex items-center gap-3 mb-4">
                    {/* Initials circle */}
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0 ${colors.bg}`}>
                      {initials(student.name)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-gray-900 truncate">{student.name}</p>
                      <p className="text-xs text-gray-500 truncate">{student.email}</p>
                    </div>
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
                          onClick={() => navigate('/admin/articles', {
                            state: {
                              filterUser: { id: student.id, name: student.name },
                              filterStatuses: ['evaluated'],
                            },
                          })}
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
                    <Button size="sm" onClick={() => openModal(student.id)}>
                      ➕ Asignar
                    </Button>
                  </div>
                </div>
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

export default BonusPanel;
