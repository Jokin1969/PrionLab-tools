import { useState } from 'react';
import { RiUser3Line, RiLockLine, RiSaveLine } from 'react-icons/ri';
import { useAuth } from '../../hooks/useAuth';
import { authService } from '../../services/auth.service';
import api from '../../services/api';
import PageHeader from '../../components/layout/PageHeader';
import Spinner from '../../components/ui/Spinner';

export default function Profile() {
  const { user, updateUser } = useAuth();

  const [name, setName] = useState(user?.name ?? '');
  const [profileMsg, setProfileMsg] = useState('');
  const [profileErr, setProfileErr] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwdMsg, setPwdMsg] = useState('');
  const [pwdErr, setPwdErr] = useState('');
  const [pwdSaving, setPwdSaving] = useState(false);

  async function saveProfile(e) {
    e.preventDefault();
    setProfileMsg('');
    setProfileErr('');
    setProfileSaving(true);
    try {
      const res = await api.put(`/users/${user.id}`, { name });
      updateUser({ name: res.data.user?.name ?? name });
      setProfileMsg('Perfil actualizado');
    } catch (err) {
      setProfileErr(err.response?.data?.error || 'Error al actualizar perfil');
    } finally {
      setProfileSaving(false);
    }
  }

  async function changePassword(e) {
    e.preventDefault();
    setPwdMsg('');
    setPwdErr('');
    if (newPassword !== confirmPassword) {
      setPwdErr('Las contraseñas no coinciden');
      return;
    }
    setPwdSaving(true);
    try {
      await authService.changePassword(currentPassword, newPassword);
      setPwdMsg('Contraseña cambiada correctamente');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setPwdErr(err.response?.data?.error || 'Error al cambiar contraseña');
    } finally {
      setPwdSaving(false);
    }
  }

  return (
    <div>
      <PageHeader title="Mi Perfil" subtitle="Gestiona tu información y contraseña" />

      <div className="mx-auto max-w-lg p-0 md:p-6 space-y-4 md:space-y-6">
        {/* Avatar */}
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-indigo-100 text-2xl font-bold text-prion-primary">
            {user?.name?.[0]?.toUpperCase() ?? '?'}
          </div>
          <div>
            <p className="font-semibold text-gray-900">{user?.name}</p>
            <p className="text-sm text-gray-500">{user?.email}</p>
            <span className="mt-1 inline-block rounded bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700 capitalize">
              {user?.role}
            </span>
          </div>
        </div>

        {/* Profile form */}
        <div className="card p-4 md:p-6 space-y-4">
          <h2 className="flex items-center gap-2 font-semibold text-gray-800">
            <RiUser3Line className="h-4 w-4" />
            Información personal
          </h2>
          <form onSubmit={saveProfile} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Nombre</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Email</label>
              <input type="email" value={user?.email ?? ''} disabled className="input opacity-60" />
            </div>
            {profileMsg && <p className="text-sm text-green-700">{profileMsg}</p>}
            {profileErr && <p className="text-sm text-red-600">{profileErr}</p>}
            <button type="submit" disabled={profileSaving} className="btn-primary flex items-center gap-2">
              {profileSaving ? <Spinner size="sm" /> : <RiSaveLine className="h-4 w-4" />}
              Guardar cambios
            </button>
          </form>
        </div>

        {/* Password form */}
        <div className="card p-4 md:p-6 space-y-4">
          <h2 className="flex items-center gap-2 font-semibold text-gray-800">
            <RiLockLine className="h-4 w-4" />
            Cambiar contraseña
          </h2>
          <form onSubmit={changePassword} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Contraseña actual</label>
              <input
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="input"
                autoComplete="current-password"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Nueva contraseña</label>
              <input
                type="password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="input"
                autoComplete="new-password"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Confirmar contraseña</label>
              <input
                type="password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="input"
                autoComplete="new-password"
              />
            </div>
            {pwdMsg && <p className="text-sm text-green-700">{pwdMsg}</p>}
            {pwdErr && <p className="text-sm text-red-600">{pwdErr}</p>}
            <button type="submit" disabled={pwdSaving} className="btn-primary flex items-center gap-2">
              {pwdSaving ? <Spinner size="sm" /> : <RiLockLine className="h-4 w-4" />}
              Cambiar contraseña
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
