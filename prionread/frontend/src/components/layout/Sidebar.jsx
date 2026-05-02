import { NavLink } from 'react-router-dom';
import {
  RiDashboardLine, RiBookOpenLine, RiUser3Line,
  RiGroupLine, RiArticleLine, RiBarChartLine, RiLogoutBoxLine,
  RiFlaskLine,
} from 'react-icons/ri';
import { useAuth } from '../../hooks/useAuth';

const studentLinks = [
  { to: '/dashboard',   label: 'Dashboard',   icon: RiDashboardLine },
  { to: '/my-articles', label: 'Mis Artículos',icon: RiBookOpenLine },
  { to: '/profile',     label: 'Mi Perfil',    icon: RiUser3Line },
];

const adminLinks = [
  { to: '/admin/dashboard', label: 'Dashboard',   icon: RiDashboardLine },
  { to: '/admin/users',     label: 'Estudiantes', icon: RiGroupLine },
  { to: '/admin/articles',  label: 'Artículos',   icon: RiArticleLine },
  { to: '/admin/reports',   label: 'Reportes',    icon: RiBarChartLine },
  // Also show student view for admins
  { to: '/my-articles',     label: 'Mis Lecturas',icon: RiBookOpenLine },
];

function NavItem({ to, label, icon: Icon }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
          isActive
            ? 'bg-indigo-50 text-prion-primary'
            : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
        }`
      }
    >
      <Icon className="h-4.5 w-4.5 shrink-0" />
      <span className="truncate">{label}</span>
    </NavLink>
  );
}

export default function Sidebar() {
  const { user, logout } = useAuth();
  const links = user?.role === 'admin' ? adminLinks : studentLinks;

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-gray-200 bg-white">
      {/* Logo */}
      <div className="flex h-14 items-center gap-2 border-b border-gray-200 px-4">
        <RiFlaskLine className="h-6 w-6 text-prion-primary" />
        <span className="text-base font-bold text-gray-900">PrionRead</span>
        {user?.role === 'admin' && (
          <span className="ml-auto rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
            ADMIN
          </span>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
        {links.map((l) => <NavItem key={l.to} {...l} />)}
      </nav>

      {/* User + logout */}
      <div className="border-t border-gray-200 p-3">
        <div className="flex items-center gap-3 rounded-lg px-2 py-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-prion-primary">
            {user?.name?.[0]?.toUpperCase() ?? '?'}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-gray-900">{user?.name}</p>
            <p className="truncate text-xs text-gray-500">{user?.email}</p>
          </div>
          <button
            onClick={logout}
            title="Cerrar sesión"
            className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <RiLogoutBoxLine className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
