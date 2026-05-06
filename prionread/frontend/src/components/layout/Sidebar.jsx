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

const PRIONVAULT_URL  = 'https://web-production-5517e.up.railway.app/prionvault/';
const PRIONPACKS_URL  = 'https://web-production-5517e.up.railway.app/prionpacks/index';

export const Sidebar = ({ isOpen = false, onClose = () => {} }) => {
  const { isAdmin } = useAuth();
  const links = isAdmin ? adminLinks : studentLinks;

  // Shared nav content used by both desktop sidebar and mobile drawer
  const navContent = (
    <nav className="p-4 flex-1">
      <ul className="space-y-2">
        {links.map((link) => (
          <li key={link.to}>
            <NavLink
              to={link.to}
              onClick={onClose}
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
        <div className="mt-4 pt-4 border-t border-gray-100 space-y-1">
          <a
            href={PRIONVAULT_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
            className="flex items-center gap-3 px-4 py-3 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors"
          >
            <span className="text-xl">🗄️</span>
            <span className="font-medium">PrionVault</span>
            <span className="ml-auto text-gray-400 text-xs">↗</span>
          </a>
          <a
            href={PRIONPACKS_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
            className="flex items-center gap-3 px-4 py-3 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors"
          >
            <span className="text-xl">📦</span>
            <span className="font-medium">PrionPacks</span>
            <span className="ml-auto text-gray-400 text-xs">↗</span>
          </a>
        </div>
      )}
    </nav>
  );

  return (
    <>
      {/* ── Desktop sidebar: always in flex flow, unchanged ── */}
      <aside className="hidden md:flex flex-col w-64 bg-white shadow-md min-h-screen flex-shrink-0">
        {navContent}
      </aside>

      {/* ── Mobile drawer: fixed overlay, slides in/out ── */}
      <div
        className={`fixed inset-0 z-30 md:hidden transition-opacity duration-200 ${
          isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Backdrop */}
        <div className="absolute inset-0 bg-black/40" onClick={onClose} />

        {/* Drawer panel */}
        <aside
          className={`absolute inset-y-0 left-0 w-72 bg-white shadow-xl flex flex-col overflow-y-auto transition-transform duration-200 ease-in-out ${
            isOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          {/* Drawer header with close button */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 flex-shrink-0">
            <span className="font-bold text-prion-primary text-lg">📚 PrionRead</span>
            <button
              onClick={onClose}
              className="p-2 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              aria-label="Cerrar menú"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          {navContent}
        </aside>
      </div>
    </>
  );
};

export default Sidebar;
