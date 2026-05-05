import { NavLink } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';

const studentLinks = [
  { to: '/dashboard',   icon: '📊', label: 'Dashboard' },
  { to: '/my-articles', icon: '📚', label: 'Mis Artículos' },
  { to: '/profile',     icon: '⚙️', label: 'Configuración' },
];

const adminLinks = [
  { to: '/admin/dashboard',     icon: '📈', label: 'Dashboard' },
  { to: '/admin/users',         icon: '👥', label: 'Usuarios' },
  { to: '/admin/articles',      icon: '📄', label: 'Artículos' },
  { to: '/admin/reports',       icon: '📊', label: 'Reportes' },
  { to: '/admin/notifications', icon: '🔔', label: 'Notificaciones' },
];

const PRIONVAULT_URL = 'https://web-production-5517e.up.railway.app/prionvault/';

export const Sidebar = () => {
  const { isAdmin } = useAuth();
  const links = isAdmin ? adminLinks : studentLinks;

  return (
    <aside className="w-64 bg-white shadow-md min-h-screen flex flex-col">
      <nav className="p-4 flex-1">
        <ul className="space-y-2">
          {links.map((link) => (
            <li key={link.to}>
              <NavLink
                to={link.to}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                    isActive
                      ? 'bg-prion-primary text-white'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`
                }
              >
                <span className="text-xl">{link.icon}</span>
                <span className="font-medium">{link.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>

        {isAdmin && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <a
              href={PRIONVAULT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-4 py-3 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors"
            >
              <span className="text-xl">🗄️</span>
              <span className="font-medium">PrionVault</span>
              <span className="ml-auto text-gray-400 text-xs">↗</span>
            </a>
          </div>
        )}
      </nav>
    </aside>
  );
};

export default Sidebar;
