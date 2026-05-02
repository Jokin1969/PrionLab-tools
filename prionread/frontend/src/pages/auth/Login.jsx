import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { RiFlaskLine, RiEyeLine, RiEyeOffLine } from 'react-icons/ri';
import { useAuth } from '../../hooks/useAuth';
import Spinner from '../../components/ui/Spinner';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const { login, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from?.pathname || '/dashboard';

  // Already logged in
  if (user) {
    navigate(user.role === 'admin' ? '/admin/dashboard' : '/dashboard', { replace: true });
    return null;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await login(email.trim(), password);
      navigate(data.user.role === 'admin' ? '/admin/dashboard' : from, { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Credenciales incorrectas');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-indigo-50 to-white px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center gap-2">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-prion-primary shadow-lg">
            <RiFlaskLine className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">PrionRead</h1>
          <p className="text-sm text-gray-500">Lectura crítica para tu doctorado</p>
        </div>

        <form onSubmit={handleSubmit} className="card p-6 space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="usuario@lab.com"
              className="input"
              autoComplete="email"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">
              Contraseña
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="input pr-10"
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute inset-y-0 right-3 flex items-center text-gray-400 hover:text-gray-600"
              >
                {showPassword ? <RiEyeOffLine className="h-4 w-4" /> : <RiEyeLine className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
          )}

          <button type="submit" disabled={loading} className="btn-primary w-full justify-center">
            {loading ? <><Spinner size="sm" /> Entrando...</> : 'Iniciar sesión'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-gray-400">
          Laboratorio de Priones · Acceso restringido
        </p>
      </div>
    </div>
  );
}
