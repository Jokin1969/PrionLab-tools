import { NavLink } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';

const studentLinks = [
  { to: '/dashboard',   icon: '📊', label: 'Dashboard' },
  { to: '/my-articles', icon: '📚', label: 'Mis Artículos' },
  { to: '/profile',     icon: '⚙️', label: 'Configuración' },
];

const adminLinks = [
  { to: '/admin/dashboard', icon: '📈', label: 'Dashboard' },
  { to: '/admin/users',     icon: '👥', label: 'Usuarios' },
  { to: '/admin/articles',  icon: '📄', label: 'Artículos' },
  { to: '/admin/reports',   icon: '📊', label: 'Reportes' },
];

export const Sidebar = () => {
  const { isAdmin } = useAuth();
  const links = isAdmin ? adminLinks : studentLinks;

  return (
    <aside className="w-64 bg-white shadow-md min-h-screen">
      <nav className="p-4">
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
      </nav>
    </aside>
  );
};

export default Sidebar;
