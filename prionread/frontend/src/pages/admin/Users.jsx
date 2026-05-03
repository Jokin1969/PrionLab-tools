import { useState, useEffect } from 'react';
import { adminService } from '../../services/admin.service';
import { UserModal } from '../../components/admin/UserModal';
import { Card, Button, Input, Loader } from '../../components/common';

const AdminUsers = () => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [msg, setMsg] = useState('');
  const [passwordBanner, setPasswordBanner] = useState(null);

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
    await loadUsers();
    if (userData.password) {
      setPasswordBanner({ email: userData.email, password: userData.password });
    }
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
    try {
      await adminService.deleteUser(userId);
      await loadUsers();
      flash('Usuario eliminado');
    } catch {
      flash('Error eliminando usuario');
    }
  };

  const handleResetPassword = async (userId, userEmail) => {
    const newPassword = window.prompt(
      `Nueva contraseña para ${userEmail}:\n(dejar vacío para generar automáticamente)`
    );
    if (newPassword === null) return; // cancelado
    try {
      const data = await adminService.resetUserPassword(userId, newPassword || undefined);
      setPasswordBanner({ email: userEmail, password: data.tempPassword });
      flash(data.email_sent ? 'Contraseña reseteada y enviada por email' : 'Contraseña reseteada');
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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">👥 Usuarios</h1>
          <p className="text-gray-600 mt-1">Gestiona estudiantes y administradores</p>
        </div>
        <Button onClick={() => { setEditingUser(null); setShowModal(true); }}>
          + Nuevo Usuario
        </Button>
      </div>

      {/* Password banner — persists until dismissed */}
      {passwordBanner && (
        <div className="rounded-lg bg-amber-50 border border-amber-300 px-4 py-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-amber-900">
                Contraseña de acceso para {passwordBanner.email}
              </p>
              <p className="font-mono text-xl text-amber-800 mt-1 select-all tracking-wider">
                {passwordBanner.password}
              </p>
              <p className="text-xs text-amber-700 mt-1">
                Copia esta contraseña ahora — no se volverá a mostrar.
              </p>
            </div>
            <button
              onClick={() => setPasswordBanner(null)}
              className="text-amber-600 hover:text-amber-900 text-2xl font-bold leading-none mt-0.5"
              aria-label="Cerrar"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {msg && (
        <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">
          {msg}
        </div>
      )}

      {/* Filters */}
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

      {/* Users Table */}
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
                ) : filteredUsers.map((user) => {
                  const totalAssigned = user.total_assigned ?? user.stats?.total_assigned;
                  const totalEvaluated = user.total_evaluated ?? user.stats?.evaluated;
                  return (
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
                        {totalAssigned != null && totalAssigned > 0 ? (
                          <div className="text-sm">
                            <p className="text-gray-900">
                              {totalEvaluated ?? 0}/{totalAssigned}
                            </p>
                            <p className="text-xs text-gray-500">
                              {(((totalEvaluated ?? 0) / totalAssigned) * 100).toFixed(0)}%
                            </p>
                          </div>
                        ) : (
                          <span className="text-sm text-gray-400">—</span>
                        )}
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
                  );
                })}
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
