import { useState, useEffect } from 'react';
import { Modal, Input, Button } from '../common';

export const UserModal = ({ isOpen, onClose, onSave, user = null }) => {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    role: 'student',
    year_started: new Date().getFullYear(),
    photo_url: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user) {
      setFormData({
        name: user.name || '',
        email: user.email || '',
        password: '',
        role: user.role || 'student',
        year_started: user.year_started || new Date().getFullYear(),
        photo_url: user.photo_url || '',
      });
    } else {
      setFormData({
        name: '',
        email: '',
        password: '',
        role: 'student',
        year_started: new Date().getFullYear(),
        photo_url: '',
      });
    }
    setShowPassword(false);
  }, [user]);

  const handleChange = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave(formData);
      onClose();
    } catch {
      // error surfaced by parent
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={user ? 'Editar Usuario' : 'Nuevo Usuario'}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Nombre"
          value={formData.name}
          onChange={(e) => handleChange('name', e.target.value)}
          required
        />

        <Input
          label="Email"
          type="email"
          value={formData.email}
          onChange={(e) => handleChange('email', e.target.value)}
          required
        />

        {/* Password */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {user ? 'Nueva contraseña' : 'Contraseña'}
            {user && <span className="text-gray-400 font-normal"> (dejar vacío para no cambiar)</span>}
          </label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={formData.password}
              onChange={(e) => handleChange('password', e.target.value)}
              required={!user}
              placeholder={user ? '••••••••' : 'Contraseña de acceso'}
              className="w-full px-3 py-2 pr-16 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-prion-primary"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-800"
            >
              {showPassword ? 'Ocultar' : 'Ver'}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Rol</label>
          <select
            value={formData.role}
            onChange={(e) => handleChange('role', e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-prion-primary"
          >
            <option value="student">Estudiante</option>
            <option value="admin">Administrador</option>
          </select>
        </div>

        <Input
          label="Año de Inicio"
          type="number"
          value={formData.year_started}
          onChange={(e) => handleChange('year_started', parseInt(e.target.value))}
        />

        <Input
          label="URL de Foto (opcional)"
          value={formData.photo_url}
          onChange={(e) => handleChange('photo_url', e.target.value)}
          placeholder="https://..."
        />

        <div className="flex gap-2 justify-end pt-4 border-t">
          <Button variant="ghost" onClick={onClose} type="button">
            Cancelar
          </Button>
          <Button type="submit" loading={saving}>
            {user ? 'Actualizar' : 'Crear Usuario'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
