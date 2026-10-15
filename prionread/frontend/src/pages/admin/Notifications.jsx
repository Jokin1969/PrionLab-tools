import { useState, useEffect } from 'react';
import { adminService } from '../../services/admin.service';
import { Card, Button, Loader } from '../../components/common';

const TYPE_LABELS = {
  articles_remaining:  { label: 'Artículos restantes', icon: '📚', unit: 'artículos pendientes', color: 'blue' },
  articles_percentage: { label: 'Porcentaje pendiente', icon: '📊', unit: '% de artículos pendientes', color: 'purple' },
};

const COLOR = {
  blue:   { badge: 'bg-blue-100 text-blue-700', ring: 'border-blue-200' },
  purple: { badge: 'bg-purple-100 text-purple-700', ring: 'border-purple-200' },
};

function RuleCard({ rule, students, onToggle, onDelete }) {
  const [deleting, setDeleting] = useState(false);
  const meta = TYPE_LABELS[rule.type] ?? TYPE_LABELS.articles_remaining;
  const c = COLOR[meta.color];

  const targetLabel = rule.target_user_id
    ? (rule.targetUser?.name ?? 'Usuario específico')
    : 'Todos los estudiantes';

  const handleDelete = async () => {
    if (!window.confirm('¿Eliminar esta regla de notificación?')) return;
    setDeleting(true);
    try { await onDelete(rule.id); } finally { setDeleting(false); }
  };

  return (
    <div className={`bg-white border rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow ${rule.is_active ? 'border-gray-200' : 'border-gray-100 opacity-60'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${c.badge}`}>
              {meta.icon} {meta.label}
            </span>
            {!rule.is_active && (
              <span className="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-500">Inactiva</span>
            )}
          </div>

          <p className="text-lg font-bold text-gray-900 mb-1">
            Alerta cuando queden ≤ <span className="text-prion-primary">{rule.threshold} {meta.unit}</span>
          </p>

          {rule.label && (
            <p className="text-sm text-gray-500 mb-2 italic">"{rule.label}"</p>
          )}

          <div className="flex items-center gap-2 text-sm text-gray-600 flex-wrap">
            <span>👤 {targetLabel}</span>
            {rule.last_sent && (
              <>
                <span>·</span>
                <span>Último envío: {new Date(rule.last_sent).toLocaleDateString('es-ES')}
                  {rule.last_sent_student && ` (${rule.last_sent_student})`}
                </span>
              </>
            )}
            {rule.trigger_count_30d > 0 && (
              <>
                <span>·</span>
                <span className="text-indigo-600 font-medium">{rule.trigger_count_30d} envíos en 30 días</span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => onToggle(rule)}
            title={rule.is_active ? 'Desactivar regla' : 'Activar regla'}
            className={`relative w-11 h-6 rounded-full transition-colors focus:outline-none ${
              rule.is_active ? 'bg-indigo-500' : 'bg-gray-300'
            }`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
              rule.is_active ? 'translate-x-5' : 'translate-x-0'
            }`} />
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="p-1.5 text-gray-400 hover:text-red-500 transition-colors disabled:opacity-50"
            title="Eliminar regla"
          >
            🗑
          </button>
        </div>
      </div>
    </div>
  );
}

const AdminNotifications = () => {
  const [rules, setRules]       = useState([]);
  const [students, setStudents] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [running, setRunning]   = useState(false);
  const [msg, setMsg]           = useState('');
  const [errMsg, setErrMsg]     = useState('');

  const [form, setForm] = useState({
    type: 'articles_remaining',
    threshold: '',
    target_user_id: '',
    label: '',
  });
  const [saving, setSaving] = useState(false);

  const flash      = (t) => { setMsg(t);    setTimeout(() => setMsg(''),    4000); };
  const errorFlash = (t) => { setErrMsg(t); setTimeout(() => setErrMsg(''), 5000); };

  const load = async () => {
    setLoading(true);
    try {
      const [rulesData, usersData] = await Promise.all([
        adminService.getNotificationRules(),
        adminService.getUsers({ role: 'student' }),
      ]);
      setRules(rulesData.rules || []);
      setStudents(usersData.users || []);
    } catch (err) {
      errorFlash('Error cargando las reglas');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    const n = parseInt(form.threshold, 10);
    if (!n || n < 1) return errorFlash('El umbral debe ser un número positivo');
    if (form.type === 'articles_percentage' && n > 100) return errorFlash('El porcentaje no puede superar 100');
    setSaving(true);
    try {
      await adminService.createNotificationRule(form);
      setForm({ type: 'articles_remaining', threshold: '', target_user_id: '', label: '' });
      await load();
      flash('Regla creada correctamente');
    } catch (err) {
      errorFlash(err?.response?.data?.error || 'Error creando regla');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (rule) => {
    try {
      await adminService.updateNotificationRule(rule.id, { is_active: !rule.is_active });
      setRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, is_active: !r.is_active } : r));
    } catch { errorFlash('Error actualizando la regla'); }
  };

  const handleDelete = async (ruleId) => {
    try {
      await adminService.deleteNotificationRule(ruleId);
      setRules((prev) => prev.filter((r) => r.id !== ruleId));
      flash('Regla eliminada');
    } catch { errorFlash('Error eliminando la regla'); }
  };

  const handleRunNow = async () => {
    setRunning(true);
    try {
      const result = await adminService.runNotificationRules();
      flash(`Comprobación completada: ${result.sent} email${result.sent !== 1 ? 's' : ''} enviado${result.sent !== 1 ? 's' : ''} de ${result.checked} regla${result.checked !== 1 ? 's' : ''} revisada${result.checked !== 1 ? 's' : ''}`);
    } catch { errorFlash('Error ejecutando la comprobación'); }
    finally { setRunning(false); }
  };

  const thresholdPlaceholder = form.type === 'articles_remaining' ? 'Ej: 5' : 'Ej: 20';
  const thresholdHelp = form.type === 'articles_remaining'
    ? 'Número de artículos pendientes (≤ N → alerta)'
    : 'Porcentaje de artículos pendientes (≤ N% → alerta)';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">🔔 Notificaciones</h1>
          <p className="text-gray-600 mt-1">Alertas automáticas de progreso de lectura</p>
        </div>
        <Button onClick={handleRunNow} loading={running} disabled={running} variant="secondary">
          ▶ Comprobar ahora
        </Button>
      </div>

      {msg    && <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">{msg}</div>}
      {errMsg && <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{errMsg}</div>}

      {/* How it works */}
      <Card>
        <div className="flex items-start gap-3">
          <span className="text-2xl">ℹ️</span>
          <div className="text-sm text-gray-600 space-y-1">
            <p>Las reglas de notificación envían un <strong>email diario al administrador</strong> cuando un estudiante cumple el umbral configurado.</p>
            <p>El email incluye el nombre del estudiante, su progreso actual y estadísticas. Se envía <strong>una sola vez al día</strong> por estudiante y regla mientras se mantenga la condición.</p>
            <p>La comprobación automática se realiza cada día a las <strong>08:00 (hora de Madrid)</strong>. Usa el botón "Comprobar ahora" para lanzarla manualmente.</p>
          </div>
        </div>
      </Card>

      {/* Create rule */}
      <Card title="➕ Nueva Regla de Notificación">
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Tipo de alerta</label>
              <select
                value={form.type}
                onChange={(e) => setForm((p) => ({ ...p, type: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-prion-primary"
              >
                <option value="articles_remaining">📚 Artículos pendientes (número absoluto)</option>
                <option value="articles_percentage">📊 Artículos pendientes (porcentaje)</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Umbral {form.type === 'articles_percentage' ? '(%)' : '(nº artículos)'}
              </label>
              <input
                type="number"
                min="1"
                max={form.type === 'articles_percentage' ? 100 : undefined}
                placeholder={thresholdPlaceholder}
                value={form.threshold}
                onChange={(e) => setForm((p) => ({ ...p, threshold: e.target.value }))}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-prion-primary"
              />
              <p className="mt-1 text-xs text-gray-400">{thresholdHelp}</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Destinatario</label>
              <select
                value={form.target_user_id}
                onChange={(e) => setForm((p) => ({ ...p, target_user_id: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-prion-primary"
              >
                <option value="">👥 Todos los estudiantes</option>
                {students.map((s) => (
                  <option key={s.id} value={s.id}>👤 {s.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Etiqueta (opcional)</label>
              <input
                type="text"
                placeholder="Ej: Alerta de fin de lista"
                value={form.label}
                onChange={(e) => setForm((p) => ({ ...p, label: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-prion-primary"
              />
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <Button type="submit" loading={saving} disabled={saving || !form.threshold}>
              Crear regla
            </Button>
            <p className="text-xs text-gray-400">
              {form.type === 'articles_remaining'
                ? `Se alertará cuando un estudiante tenga ≤ ${form.threshold || 'N'} artículos pendientes`
                : `Se alertará cuando un estudiante tenga ≤ ${form.threshold || 'N'}% de artículos pendientes`
              }
            </p>
          </div>
        </form>
      </Card>

      {/* Rules list */}
      <Card title={`📋 Reglas Activas${rules.length > 0 ? ` (${rules.length})` : ''}`}>
        {loading ? (
          <Loader />
        ) : rules.length === 0 ? (
          <div className="text-center py-8 text-gray-400">
            <p className="text-3xl mb-2">🔕</p>
            <p className="text-sm">No hay reglas de notificación configuradas.</p>
            <p className="text-sm">Crea una regla arriba para empezar.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {rules.map((rule) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                students={students}
                onToggle={handleToggle}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};

export default AdminNotifications;
