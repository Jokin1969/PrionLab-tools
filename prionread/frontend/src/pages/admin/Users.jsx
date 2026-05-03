import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminService } from '../../services/admin.service';
import { UserModal } from '../../components/admin/UserModal';
import { Card, Button, Input, Loader } from '../../components/common';

const STAT_BADGES = [
  {
    label: 'Asig',
    getCount: (u) => u.stats?.total_assigned ?? u.total_assigned ?? 0,
    filter: null,
  },
  {
    label: 'Leídos',
    getCount: (u) => u.stats?.read ?? u.total_read ?? 0,
    filter: ['read', 'summarized', 'evaluated'],
  },
  {
    label: 'Res',
    getCount: (u) => u.stats?.summarized ?? u.total_summarized ?? 0,
    filter: ['summarized', 'evaluated'],
  },
  {
    label: 'Eval',
    getCount: (u) => u.stats?.evaluated ?? u.total_evaluated ?? 0,
    filter: ['evaluated'],
  },
];

const AdminUsers = () => {
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    loadUsers();
  }, [roleFilter]);

  const loadUsers = async () => {
    setLoading(true);
    try {
      const filters = {};
      if (roleFilter) filters.role = roleFilter;
      const data = await adminService.getUsers(filters);
      setUsers(data.users || []);
    } catch (error) {
      console.error('Error loading users:', error);
    } finally {
      setLoading(false);
    }
  };

  const flash = (text) => {
    setMsg(text);
    setTimeout(() => setMsg(''), 3000);
  };

  const handleCreateUser = async (userData) => {
    await adminService.createUser(userData);
    loadUsers();
    flash('Usuario creado correctamente');
  };

  const handleUpdateUser = async (userData) => {
    await adminService.updateUser(editingUser.id, userData);
    loadUsers();
    setEditingUser(null);
    flash('Usuario actualizado correctamente');
  };

  const handleDeleteUser = async (userId, userName) => {
    if (!window.confirm(`¿Eliminar usuario ${userName}?`)) return;
    try {
      await adminService.deleteUser(userId);
      loadUsers();
      flash('Usuario eliminado');
    } catch {
      flash('Error eliminando usuario');
    }
  };

  const handleResetPassword = async (userId, userEmail) => {
    if (!window.confirm(`¿Resetear contraseña para ${userEmail}?`)) return;
    try {
      const data = await adminService.resetUserPassword(userId);
      flash(
        `Nueva contraseña generada para ${userEmail}${
          data.temp_password ? `: ${data.temp_password}` : '. Se ha enviado por email.'
        }`
      );
    } catch {
      flash('Error reseteando contraseña');
    }
  };

  const filteredUsers = users.filter(
    (user) =>
      user.name?.toLowerCase().includes(search.toLowerCase()) ||
      user.email?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">👥 Usuarios</h1>
          <p className="text-gray-600 mt-1">Gestiona estudiantes y administradores</p>
        </div>
        <Button onClick={() => { setEditingUser(null); setShowModal(true); }}>
          + Nuevo Usuario
        </Button>
      </div>

      {msg && (
        <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">
          {msg}
        </div>
      )}

      <Card>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <Input
              placeholder="Buscar por nombre o email..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-prion-primary"
          >
            <option value="">Todos los roles</option>
            <option value="student">Estudiantes</option>
            <option value="admin">Administradores</option>
          </select>
        </div>
      </Card>

      {loading ? (
        <Loader />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Usuario</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Rol</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Año Inicio</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Progreso</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredUsers.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-10 text-center text-sm text-gray-400">
                      No se encontraron usuarios
                    </td>
                  </tr>
                ) : filteredUsers.map((user) => (
                  <tr key={user.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        {user.photo_url ? (
                          <img
                            src={user.photo_url}
                            alt={user.name}
                            className="w-10 h-10 rounded-full object-cover"
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center">
                            <span className="text-prion-primary font-semibold">
                              {user.name?.charAt(0)?.toUpperCase() ?? '?'}
                            </span>
                          </div>
                        )}
                        <div>
                          <p className="font-semibold text-gray-900">{user.name}</p>
                          <p className="text-sm text-gray-600">{user.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 text-xs font-medium rounded ${
                        user.role === 'admin'
                          ? 'bg-amber-100 text-amber-600'
                          : 'bg-blue-100 text-blue-600'
                      }`}>
                        {user.role === 'admin' ? 'Admin' : 'Estudiante'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600">
                      {user.year_started || '—'}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-1">
                        {STAT_BADGES.map(({ label, getCount, filter }) => {
                          const count = getCount(user);
                          const active = count > 0;
                          return (
                            <button
                              key={label}
                              disabled={!active}
                              onClick={() =>
                                active &&
                                navigate('/admin/articles', {
                                  state: { filterUser: user, filterStatuses: filter },
                                })
                              }
                              className={`px-2 py-0.5 text-xs rounded transition-opacity ${
                                active
                                  ? 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200 cursor-pointer'
                                  : 'bg-gray-100 text-gray-400 opacity-40 cursor-default'
                              }`}
                              title={active ? `Ver artículos (${label})` : `Sin artículos (${label})`}
                            >
                              {label}: {count}
                            </button>
                          );
                        })}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex gap-2 flex-wrap">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { setEditingUser(user); setShowModal(true); }}
                        >
                          Editar
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleResetPassword(user.id, user.email)}
                        >
                          Reset Pass
                        </Button>
                        {user.role !== 'admin' && (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => handleDeleteUser(user.id, user.name)}
                          >
                            Eliminar
                          </Button>
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

      <UserModal
        isOpen={showModal}
        onClose={() => { setShowModal(false); setEditingUser(null); }}
        onSave={editingUser ? handleUpdateUser : handleCreateUser}
        user={editingUser}
      />
    </div>
  );
};

export default AdminUsers;
