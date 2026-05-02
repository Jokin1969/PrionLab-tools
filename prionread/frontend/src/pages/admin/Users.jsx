import { useState, useEffect, useCallback } from 'react';
import {
  RiSearchLine, RiDownloadLine, RiUserAddLine,
  RiMoreLine, RiMailLine, RiDeleteBin6Line,
} from 'react-icons/ri';
import api from '../../services/api';
import PageHeader from '../../components/layout/PageHeader';
import Spinner from '../../components/ui/Spinner';

function CreateUserModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setErr('');
    setSaving(true);
    try {
      await api.post('/users', { name, email, role: 'student' });
      onCreated();
      onClose();
    } catch (error) {
      setErr(error.response?.data?.error || 'Error al crear usuario');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
      <div className="card w-full max-w-sm p-6 space-y-4">
        <h2 className="font-semibold text-gray-900">Nuevo estudiante</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">Nombre</label>
            <input required value={name} onChange={(e) => setName(e.target.value)} className="input" />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">Email</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="input" />
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
            <button type="submit" disabled={saving} className="btn-primary flex-1">
              {saving ? <Spinner size="sm" /> : 'Crear'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [actionMsg, setActionMsg] = useState('');

  const fetchUsers = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ role: 'student' });
    if (search) params.set('search', search);
    api.get(`/users?${params}`)
      .then((res) => setUsers(res.data.users ?? res.data))
      .catch(() => setUsers([]))
      .finally(() => setLoading(false));
  }, [search]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  async function exportCSV() {
    try {
      const res = await api.get('/admin/users/export', { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'estudiantes.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setActionMsg('Error al exportar CSV');
    }
  }

  async function sendReminder(userId) {
    try {
      await api.post(`/admin/users/${userId}/reminder`);
      setActionMsg('Recordatorio enviado');
    } catch {
      setActionMsg('Error al enviar recordatorio');
    }
    setTimeout(() => setActionMsg(''), 3000);
  }

  async function deleteUser(userId) {
    if (!window.confirm('¿Eliminar este estudiante?')) return;
    try {
      await api.delete(`/users/${userId}`);
      setUsers((prev) => prev.filter((u) => u.id !== userId));
      setActionMsg('Usuario eliminado');
    } catch (err) {
      setActionMsg(err.response?.data?.error || 'Error al eliminar usuario');
    }
    setTimeout(() => setActionMsg(''), 3000);
  }

  return (
    <div>
      <PageHeader
        title="Estudiantes"
        subtitle="Gestión de usuarios del laboratorio"
        action={
          <div className="flex gap-2">
            <button onClick={exportCSV} className="btn-secondary flex items-center gap-2 text-sm">
              <RiDownloadLine className="h-4 w-4" />
              CSV
            </button>
            <button onClick={() => setShowModal(true)} className="btn-primary flex items-center gap-2 text-sm">
              <RiUserAddLine className="h-4 w-4" />
              Nuevo
            </button>
          </div>
        }
      />

      <div className="p-6 space-y-4">
        {actionMsg && (
          <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{actionMsg}</p>
        )}

        <div className="flex gap-3">
          <div className="relative flex-1">
            <RiSearchLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Buscar estudiante..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && fetchUsers()}
              className="input pl-9"
            />
          </div>
          <button onClick={fetchUsers} className="btn-secondary">Buscar</button>
        </div>

        {loading ? (
          <div className="flex justify-center py-12"><Spinner size="lg" /></div>
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-3">Nombre</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3 text-center">Leídos</th>
                  <th className="px-4 py-3 text-center">Pendientes</th>
                  <th className="px-4 py-3 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-10 text-center text-gray-400">
                      No se encontraron estudiantes
                    </td>
                  </tr>
                ) : users.map((u) => (
                  <tr key={u.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">
                      <div className="flex items-center gap-2">
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-prion-primary">
                          {u.name?.[0]?.toUpperCase()}
                        </div>
                        {u.name}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{u.email}</td>
                    <td className="px-4 py-3 text-center">{u.stats?.reads_count ?? u.reads_count ?? '—'}</td>
                    <td className="px-4 py-3 text-center">{u.stats?.pending_count ?? u.pending_count ?? '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => sendReminder(u.id)}
                          title="Enviar recordatorio"
                          className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                        >
                          <RiMailLine className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => deleteUser(u.id)}
                          title="Eliminar"
                          className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600"
                        >
                          <RiDeleteBin6Line className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <CreateUserModal onClose={() => setShowModal(false)} onCreated={fetchUsers} />
      )}
    </div>
  );
}
