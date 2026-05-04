import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminService } from '../../services/admin.service';

function SortBtn({ label, col, sortBy, dir, onSort }) {
  const active = sortBy === col;
  return (
    <button
      onClick={() => onSort(col)}
      className="inline-flex items-center gap-1 hover:text-gray-700 transition-colors group"
      title={active ? (dir === 'asc' ? 'Ordenar descendente' : 'Ordenar ascendente') : `Ordenar por ${label}`}
    >
      {label}
      <span className={`text-[10px] leading-none ${active ? 'text-prion-primary' : 'text-gray-300 group-hover:text-gray-400'}`}>
        {active ? (dir === 'asc' ? '▲' : '▼') : '⇅'}
      </span>
    </button>
  );
}
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

// ── Welcome email preview modal ───────────────────────────────────────────────
function WelcomePreviewModal({ user, onClose, onSend, sending }) {
  const [html, setHtml]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);

  useEffect(() => {
    adminService.getWelcomeEmailPreview(user.id)
      .then((data) => setHtml(data.html))
      .catch(() => setError('No se pudo cargar la vista previa'))
      .finally(() => setLoading(false));
  }, [user.id]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl flex flex-col" style={{ maxHeight: '90vh' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Vista previa del email de bienvenida</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              Para: <strong>{user.name}</strong> ({user.email})
              {user.welcome_email_sent_at && (
                <span className="ml-2 text-amber-600">⚠️ Ya enviado el {fmtDate(user.welcome_email_sent_at)}</span>
              )}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-2xl font-bold leading-none">×</button>
        </div>

        {/* Preview area */}
        <div className="flex-1 overflow-auto p-4 bg-gray-100">
          {loading && <p className="text-center text-gray-500 py-10">Cargando vista previa…</p>}
          {error   && <p className="text-center text-red-500 py-10">{error}</p>}
          {html && (
            <iframe
              title="email-preview"
              srcDoc={html}
              className="w-full rounded-lg shadow bg-white"
              style={{ minHeight: '520px', border: 'none' }}
              sandbox="allow-same-origin"
            />
          )}
        </div>

        {/* Note + actions */}
        <div className="px-5 py-4 border-t border-gray-200 shrink-0">
          <p className="text-xs text-gray-400 mb-3">
            La contraseña que verás es de ejemplo. Al enviar se generará una nueva contraseña aleatoria y la actual dejará de funcionar.
          </p>
          <div className="flex gap-3 justify-end">
            <button onClick={onClose} className="px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">
              Cancelar
            </button>
            <button
              onClick={onSend}
              disabled={sending}
              className="px-5 py-2 text-sm font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              {sending ? 'Enviando…' : user.welcome_email_sent_at ? '✉️ Reenviar bienvenida' : '✉️ Enviar bienvenida'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
const AdminUsers = () => {
  const navigate = useNavigate();
  const [users, setUsers]               = useState([]);
  const [loading, setLoading]           = useState(true);
  const [showModal, setShowModal]       = useState(false);
  const [editingUser, setEditingUser]   = useState(null);
  const [assignmentsUser, setAssignmentsUser] = useState(null);
  const [previewUser, setPreviewUser]   = useState(null);
  const [search, setSearch]             = useState('');
  const [roleFilter, setRoleFilter]     = useState('');
  const [userSort, setUserSort]         = useState({ by: 'name', dir: 'asc' });
  const [msg, setMsg]                   = useState('');
  const [errMsg, setErrMsg]             = useState('');
  const [passwordBanner, setPasswordBanner] = useState(null);
  const [sendingWelcome, setSendingWelcome] = useState(false);

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

  const handleSendWelcome = async () => {
    if (!previewUser) return;
    setSendingWelcome(true);
    try {
      const data = await adminService.sendWelcomeEmail(previewUser.id);
      setUsers((prev) => prev.map((u) =>
        u.id === previewUser.id ? { ...u, welcome_email_sent_at: data.welcome_email_sent_at } : u
      ));
      setPasswordBanner({ email: previewUser.email, password: data.tempPassword, welcome: true });
      setPreviewUser(null);
      flash(`Email de bienvenida enviado a ${previewUser.email}`);
    } catch (err) {
      errorFlash(err?.response?.data?.error || 'Error enviando email de bienvenida');
    } finally {
      setSendingWelcome(false);
    }
  };

  const handleUserSort = (col) => {
    setUserSort((p) => ({ by: col, dir: p.by === col && p.dir === 'asc' ? 'desc' : 'asc' }));
  };

  const filteredUsers = users
    .filter((u) =>
      u.name?.toLowerCase().includes(search.toLowerCase()) ||
      u.email?.toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => {
      const { by, dir } = userSort;
      let va, vb;
      if (by === 'name')  { va = (a.name  || '').toLowerCase(); vb = (b.name  || '').toLowerCase(); }
      if (by === 'role')  { va = (a.role  || '').toLowerCase(); vb = (b.role  || '').toLowerCase(); }
      if (by === 'year')  { va = a.year_started ?? 0;           vb = b.year_started ?? 0; }
      if (va < vb) return dir === 'asc' ? -1 :  1;
      if (va > vb) return dir === 'asc' ?  1 : -1;
      return 0;
    });

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
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    <SortBtn label="Usuario" col="name" sortBy={userSort.by} dir={userSort.dir} onSort={handleUserSort} />
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    <SortBtn label="Rol" col="role" sortBy={userSort.by} dir={userSort.dir} onSort={handleUserSort} />
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    <SortBtn label="Año" col="year" sortBy={userSort.by} dir={userSort.dir} onSort={handleUserSort} />
                  </th>
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
                          {user.role === 'student' && (
                            user.welcome_email_sent_at
                              ? <p className="text-xs text-green-600 mt-0.5">✔️ Bienvenida enviada {fmtDate(user.welcome_email_sent_at)}</p>
                              : <p className="text-xs text-amber-500 mt-0.5">⏳ Sin email de bienvenida</p>
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
                            onClick={() => setPreviewUser(user)}
                            title={user.welcome_email_sent_at ? `Reenviar bienvenida (enviada ${fmtDate(user.welcome_email_sent_at)})` : 'Ver y enviar email de bienvenida'}
                            className={`px-2 py-1 text-xs font-medium rounded border transition-colors ${
                              user.welcome_email_sent_at
                                ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100'
                                : 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100'
                            }`}
                          >
                            {user.welcome_email_sent_at ? '✉️ Reenviar' : '✉️ Dar bienvenida'}
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

      {previewUser && (
        <WelcomePreviewModal
          user={previewUser}
          onClose={() => setPreviewUser(null)}
          onSend={handleSendWelcome}
          sending={sendingWelcome}
        />
      )}
    </div>
  );
};

export default AdminUsers;
