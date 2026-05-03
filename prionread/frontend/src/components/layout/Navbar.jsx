import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { Button } from '../common';

export const Navbar = () => {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <nav className="bg-white shadow-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16">
          {/* Logo */}
          <div className="flex items-center">
            <h1 className="text-2xl font-bold text-prion-primary">
              📚 PrionRead
            </h1>
          </div>

          {/* Navigation */}
          {user && (
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                {user.photo_url && (
                  <img
                    src={user.photo_url}
                    alt={user.name}
                    className="w-8 h-8 rounded-full"
                  />
                )}
                <span className="text-sm font-medium text-gray-700">
                  {user.name}
                </span>
                {isAdmin && (
                  <span className="px-2 py-1 text-xs font-medium text-white bg-prion-accent rounded">
                    Admin
                  </span>
                )}
              </div>

              <Button variant="ghost" size="sm" onClick={handleLogout}>
                Cerrar sesión
              </Button>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
};
