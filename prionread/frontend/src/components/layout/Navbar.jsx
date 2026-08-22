import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { Button } from '../common';

export const Navbar = ({ onMenuClick }) => {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <nav className="bg-white shadow-md sticky top-0 z-10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-14 md:h-16">

          {/* Left: hamburger (mobile) + logo */}
          <div className="flex items-center gap-2">
            <button
              onClick={onMenuClick}
              className="md:hidden p-2 rounded-lg text-gray-500 hover:bg-gray-100 -ml-1"
              aria-label="Abrir menú"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <h1 className="text-xl md:text-2xl font-bold text-prion-primary">
              📚 PrionRead
            </h1>
          </div>

          {/* Right: user info + logout */}
          {user && (
            <div className="flex items-center gap-2 md:gap-4">
              <div className="flex items-center gap-2">
                {user.photo_url && (
                  <img
                    src={user.photo_url}
                    alt={user.name}
                    className="w-8 h-8 rounded-full"
                  />
                )}
                <span className="hidden sm:inline text-sm font-medium text-gray-700">
                  {user.name}
                </span>
                {isAdmin && (
                  <span className="px-2 py-1 text-xs font-medium text-white bg-prion-accent rounded">
                    Admin
                  </span>
                )}
              </div>

              <Button variant="ghost" size="sm" onClick={handleLogout}>
                <span className="hidden sm:inline">Cerrar sesión</span>
                <span className="sm:hidden text-base leading-none">✕</span>
              </Button>
            </div>
          )}

        </div>
      </div>
    </nav>
  );
};
