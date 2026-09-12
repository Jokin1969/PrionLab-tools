import { Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from './ProtectedRoute';
import Layout from '../components/layout/Layout';

// Auth
import Login from '../pages/auth/Login';

// Student
import StudentDashboard from '../pages/student/Dashboard';
import MyArticles from '../pages/student/MyArticles';
import ArticleDetail from '../pages/student/ArticleDetail';
import Profile from '../pages/student/Profile';

// Admin
import AdminDashboard from '../pages/admin/Dashboard';
import AdminUsers from '../pages/admin/Users';
import AdminArticles from '../pages/admin/Articles';
import AdminReports from '../pages/admin/Reports';

import NotFound from '../pages/NotFound';

export default function AppRouter() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<Login />} />

      {/* Protected: student + admin */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<StudentDashboard />} />
        <Route path="my-articles" element={<MyArticles />} />
        <Route path="my-articles/:articleId" element={<ArticleDetail />} />
        <Route path="profile" element={<Profile />} />

        {/* Protected: admin only */}
        <Route
          path="admin"
          element={<ProtectedRoute requireAdmin><Navigate to="/admin/dashboard" replace /></ProtectedRoute>}
        />
        <Route
          path="admin/dashboard"
          element={<ProtectedRoute requireAdmin><AdminDashboard /></ProtectedRoute>}
        />
        <Route
          path="admin/users"
          element={<ProtectedRoute requireAdmin><AdminUsers /></ProtectedRoute>}
        />
        <Route
          path="admin/articles"
          element={<ProtectedRoute requireAdmin><AdminArticles /></ProtectedRoute>}
        />
        <Route
          path="admin/reports"
          element={<ProtectedRoute requireAdmin><AdminReports /></ProtectedRoute>}
        />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
