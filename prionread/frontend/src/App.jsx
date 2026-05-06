import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { MainLayout } from './components/layout/MainLayout';
import { ProtectedRoute } from './components/ProtectedRoute';

import Login from './pages/auth/Login';
import StudentDashboard from './pages/student/Dashboard';
import MyArticles from './pages/student/MyArticles';
import ArticleDetail from './pages/student/ArticleDetail';
import Profile from './pages/student/Profile';
import AdminDashboard from './pages/admin/Dashboard';
import AdminUsers from './pages/admin/Users';
import AdminArticles from './pages/admin/Articles';
import AdminReports from './pages/admin/Reports';
import AdminNotifications from './pages/admin/Notifications';
import AdminSyncStatus from './pages/admin/SyncStatus';
import NotFound from './pages/NotFound';

function App() {
  const { user } = useAuth();

  return (
    <Routes>
      {/* Public */}
      <Route
        path="/login"
        element={
          user
            ? <Navigate to={user.role === 'admin' ? '/admin/dashboard' : '/dashboard'} replace />
            : <Login />
        }
      />

      {/* Student routes */}
      <Route path="/dashboard" element={
        <ProtectedRoute>
          <MainLayout><StudentDashboard /></MainLayout>
        </ProtectedRoute>
      } />
      <Route path="/my-articles" element={
        <ProtectedRoute>
          <MainLayout><MyArticles /></MainLayout>
        </ProtectedRoute>
      } />
      <Route path="/my-articles/:articleId" element={
        <ProtectedRoute>
          <MainLayout><ArticleDetail /></MainLayout>
        </ProtectedRoute>
      } />
      <Route path="/profile" element={
        <ProtectedRoute>
          <MainLayout><Profile /></MainLayout>
        </ProtectedRoute>
      } />

      {/* Admin routes */}
      <Route path="/admin/dashboard" element={
        <ProtectedRoute requireAdmin>
          <MainLayout><AdminDashboard /></MainLayout>
        </ProtectedRoute>
      } />
      <Route path="/admin/users" element={
        <ProtectedRoute requireAdmin>
          <MainLayout><AdminUsers /></MainLayout>
        </ProtectedRoute>
      } />
      <Route path="/admin/articles" element={
        <ProtectedRoute requireAdmin>
          <MainLayout><AdminArticles /></MainLayout>
        </ProtectedRoute>
      } />
      <Route path="/admin/reports" element={
        <ProtectedRoute requireAdmin>
          <MainLayout><AdminReports /></MainLayout>
        </ProtectedRoute>
      } />
      <Route path="/admin/notifications" element={
        <ProtectedRoute requireAdmin>
          <MainLayout><AdminNotifications /></MainLayout>
        </ProtectedRoute>
      } />
      <Route path="/admin/sync" element={
        <ProtectedRoute requireAdmin>
          <MainLayout><AdminSyncStatus /></MainLayout>
        </ProtectedRoute>
      } />

      {/* Default redirect */}
      <Route
        path="/"
        element={
          <Navigate to={user ? (user.role === 'admin' ? '/admin/dashboard' : '/dashboard') : '/login'} replace />
        }
      />

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default App;
