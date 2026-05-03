import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminService } from '../../services/admin.service';
import { UserModal } from '../../components/admin/UserModal';
import { UserAssignmentsModal } from '../../components/admin/UserAssignmentsModal';
import { Card, Button, Input, Loader } from '../../components/common';

const STAT_BADGES = [
  { key: 'total_assigned',   label: 'Asig',   cls: 'bg-gray-100   text-gray-600',   filter: null },
  { key: 'total_read',       label: 'Leídos', cls: 'bg-blue-100   text-blue-700',   filter: ['read', 'summarized', 'evaluated'] },
  { key: 'total_summarized', label: 'Res',    cls: 'bg-purple-100 text-purple-700', filter: ['summarized', 'evaluated'] },
  { key: 'total_evaluated',  label: 'Eval',   cls: 'bg-green-100  text-green-700',  filter: ['evaluated'] },
];

function fmtDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}

const AdminUsers = () => {
  const navigate = useNavigate();
  const [users, setUsers]               = useState([]);
  const [loading, setLoading]           = useState(true);
  const [showModal, setShowModal]       = useState(false);
  const [editingUser, setEditingUser]   = useState(null);
  const [assignmentsUser, setAssignmentsUser] = useState(null);
  const [search, setSearch]             = useState('');
  const [roleFilter, setRoleFilter]     = useState('');
  const [msg, setMsg]                   = useState('');
  const [errMsg, setErrMsg]             = useState('');
  const [passwordBanner, setPasswordBanner] = useState(null);
  const [sendingWelcome, setSendingWelcome] = useState(null);

  useEffect(() => { loadUsers(); }, [roleFilter]);

  const loadUsers = async () => {
    setLoading(true);
    try {
      const filters = {};
      if (roleFilter) filters.role = roleFilter;
      const data = await adminService.getUsers(filters);
      setUsers(data.users || []);
    } catch (err) {
      console.error('Error loading users:', err);
    } finally {
      setLoading(false);
    }
  };

  const flash      = (text) => { setMsg(text);    setTimeout(() => setMsg(''),    3000); };
  const errorFlash = (text) => { setErrMsg(text); setTimeout(() => setErrMsg(''), 4000); };

  const handleCreateUser = async (userData) => {
    await adminService.createUser(userData);
    await loadUsers();
    if (userData.password) setPasswordBanner({ email: userData.email, password: userData.password });
    flash('Usuario creado correctamente');
  };

  const handleUpdateUser = async (userData) => {
    await adminService.updateUser(editingUser.id, userData);
    if (userData.password) {
      await adminService.resetUserPassword(editingUser.id, userData.password);
      setPasswordBanner({ email: editingUser.email, password: userData.password });
    }
    await loadUsers();
    setEditingUser(null);
    flash('Usuario actualizado correctamente');
  };

  const handleDeleteUser = async (userId, userName) => {
    if (!window.confirm(`¿Eliminar usuario ${userName}?`)) return;
    try { await adminService.deleteUser(userId); await loadUsers(); flash('Usuario eliminado'); }
    catch  { errorFlash('Error eliminando usuario'); }
  };

  const handleResetPassword = async (userId, userEmail) => {
    const newPassword = window.prompt(`Nueva contraseña para ${userEmail}:\n(vacío = generar automáticamente)`);
    if (newPassword === null) return;
    try {
      const data = await adminService.resetUserPassword(userId, newPassword || undefined);
      setPasswordBanner({ email: userEmail, password: data.tempPassword });
      flash(data.email_sent ? 'Contraseña reseteada y enviada por email' : 'Contraseña reseteada');
    } catch { errorFlash('Error reseteando contraseña'); }
  };

  const handleSendWelcome = async (user) => {
    const alreadySent = Boolean(user.welcome_email_sent_at);
    const confirmMsg = alreadySent
      ? `${user.name} ya recibió el email de bienvenida el ${fmtDate(user.welcome_email_sent_at)}.\n\n¿Reenviar? Esto generará una nueva contraseña temporal y la anterior dejará de funcionar.`
      : `¿Enviar email de bienvenida a ${user.name}?\n\nSe generará una nueva contraseña temporal. La contraseña actual dejará de funcionar.`;
    if (!window.confirm(confirmMsg)) return;

    setSendingWelcome(user.id);
    try {
      const data = await adminService.sendWelcomeEmail(user.id);
      setUsers((prev) => prev.map((u) =>
        u.id === user.id ? { ...u, welcome_email_sent_at: data.welcome_email_sent_at } : u
      ));
      setPasswordBanner({ email: user.email, password: data.tempPassword, welcome: true });
      flash(`Email de bienvenida enviado a ${user.email}`);
    } catch (err) {
      errorFlash(err?.response?.data?.error || 'Error enviando email de bienvenida');
    } finally {
      setSendingWelcome(null);
    }
  };

  const filteredUsers = users.filter(
    (u) => u.name?.toLowerCase().includes(search.toLowerCase()) ||
            u.email?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">👥 Usuarios</h1>
          <p className="text-gray-600 mt-1">Gestiona estudiantes y administradores</p>
        </div>
        <Button onClick={() => { setEditingUser(null); setShowModal(true); }}>+ Nuevo Usuario</Button>
      </div>

      {passwordBanner && (
        <div className="rounded-lg bg-amber-50 border border-amber-300 px-4 py-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              {passwordBanner.welcome && (
                <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1">✉️ Email de bienvenida enviado</p>
              )}
              <p className="text-sm font-semibold text-amber-900">Contraseña temporal para {passwordBanner.email}</p>
              <p className="font-mono text-xl text-amber-800 mt-1 select-all tracking-wider">{passwordBanner.password}</p>
              <p className="text-xs text-amber-700 mt-1">Copia esta contraseña ahora — no se volverá a mostrar.</p>
            </div>
            <button onClick={() => setPasswordBanner(null)} className="text-amber-600 hover:text-amber-900 text-2xl font-bold leading-none">×</button>
          </div>
        </div>
      )}

      {msg    && <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">{msg}</div>}
      {errMsg && <div className="rounded-lg bg-red-50   border border-red-200   px-4 py-3 text-sm text-red-700">{errMsg}</div>}

      <Card>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <Input placeholder="Buscar por nombre o email..." value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-prion-primary">
            <option value="">Todos los roles</option>
            <option value="student">Estudiantes</option>
            <option value="admin">Administradores</option>
          </select>
        </div>
      </Card>

      {loading ? <Loader /> : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Usuario</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Rol</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Año</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Artículos</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredUsers.length === 0 ? (
                  <tr><td colSpan={5} className="px-6 py-10 text-center text-sm text-gray-400">No se encontraron usuarios</td></tr>
                ) : filteredUsers.map((user) => (
                  <tr key={user.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        {user.photo_url
                          ? <img src={user.photo_url} alt={user.name} className="w-10 h-10 rounded-full object-cover" />
                          : <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center"><span className="text-prion-primary font-semibold">{user.name?.charAt(0)?.toUpperCase() ?? '?'}</span></div>}
                        <div>
                          <p className="font-semibold text-gray-900">{user.name}</p>
                          <p className="text-sm text-gray-600">{user.email}</p>
                          {user.welcome_email_sent_at ? (
                            <p className="text-xs text-green-600 mt-0.5">✔️ Bienvenida enviada {fmtDate(user.welcome_email_sent_at)}</p>
                          ) : (
                            <p className="text-xs text-amber-500 mt-0.5">⏳ Sin email de bienvenida</p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 text-xs font-medium rounded ${user.role === 'admin' ? 'bg-amber-100 text-amber-600' : 'bg-blue-100 text-blue-600'}`}>
                        {user.role === 'admin' ? 'Admin' : 'Estudiante'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600">{user.year_started || '—'}</td>
                    <td className="px-6 py-4">
                      <div className="grid grid-cols-4 gap-2">
                        {STAT_BADGES.map(({ key, label, cls, filter }) => {
                          const count = user.stats?.[key] ?? 0;
                          const active = count > 0;
                          return (
                            <div key={key} className="flex flex-col items-center gap-0.5">
                              <button
                                title={active ? `Ver artículos — ${label}` : undefined}
                                disabled={!active}
                                onClick={() => navigate('/admin/articles', { state: { filterUser: user, filterStatuses: filter } })}
                                className={`w-full text-center px-1 py-1 text-xs font-bold rounded transition-opacity ${cls} ${
                                  active ? 'hover:opacity-70 cursor-pointer' : 'opacity-40 cursor-default'
                                }`}
                              >
                                {count}
                              </button>
                              <span className="text-xs text-gray-400 leading-tight">{label}</span>
                            </div>
                          );
                        })}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex gap-2 flex-wrap">
                        <Button variant="secondary" size="sm" onClick={() => setAssignmentsUser(user)}>Asignaciones</Button>
                        <Button variant="ghost" size="sm" onClick={() => { setEditingUser(user); setShowModal(true); }}>Editar</Button>
                        <Button variant="ghost" size="sm" onClick={() => handleResetPassword(user.id, user.email)}>Reset Pass</Button>
                        {user.role === 'student' && (
                          <button
                            onClick={() => handleSendWelcome(user)}
                            disabled={sendingWelcome === user.id}
                            title={user.welcome_email_sent_at ? `Reenviar bienvenida (enviada ${fmtDate(user.welcome_email_sent_at)})` : 'Enviar email de bienvenida con credenciales y guía'}
                            className={`px-2 py-1 text-xs font-medium rounded border transition-colors disabled:opacity-50 ${
                              user.welcome_email_sent_at
                                ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100'
                                : 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100'
                            }`}
                          >
                            {sendingWelcome === user.id ? '…' : user.welcome_email_sent_at ? '✉️ Reenviar' : '✉️ Dar bienvenida'}
                          </button>
                        )}
                        {user.role !== 'admin' && (
                          <Button variant="danger" size="sm" onClick={() => handleDeleteUser(user.id, user.name)}>Eliminar</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <UserModal isOpen={showModal} onClose={() => { setShowModal(false); setEditingUser(null); }} onSave={editingUser ? handleUpdateUser : handleCreateUser} user={editingUser} />
      <UserAssignmentsModal isOpen={!!assignmentsUser} onClose={() => setAssignmentsUser(null)} user={assignmentsUser} />
    </div>
  );
};

export default AdminUsers;
