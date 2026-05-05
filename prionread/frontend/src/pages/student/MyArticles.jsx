import { useState, useEffect } from 'react';
import { studentService } from '../../services/student.service';
import { ArticleCard } from '../../components/student/ArticleCard';
import { Loader, Button, Input } from '../../components/common';

const MyArticles = () => {
  const [articles, setArticles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    status: '',
    search: '',
    sort_by: 'priority',
    order: 'desc',
  });

  useEffect(() => {
    loadArticles();
  }, [filters]);

  const loadArticles = async () => {
    setLoading(true);
    try {
      const data = await studentService.getMyArticles(filters);
      const flat = (data.articles || []).map(({ assignment, article }) => ({
        ...article,
        status: assignment?.status,
        read_date: assignment?.read_date,
        assignment_id: assignment?.id,
      }));
      setArticles(flat);
    } catch (error) {
      console.error('Error loading articles:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleMarkAsRead = async (articleId) => {
    try {
      await studentService.markAsRead(articleId);
      loadArticles();
    } catch (error) {
      console.error('Error marking as read:', error);
    }
  };

  const handleFilterChange = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900">📚 Mis Artículos</h1>
        <p className="text-gray-600 mt-1">
          Gestiona tu biblioteca personal de lectura científica
        </p>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow-md p-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Search */}
          <div className="md:col-span-2">
            <Input
              placeholder="Buscar por título, autor..."
              value={filters.search}
              onChange={(e) => handleFilterChange('search', e.target.value)}
            />
          </div>

          {/* Status filter */}
          <select
            value={filters.status}
            onChange={(e) => handleFilterChange('status', e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-prion-primary"
          >
            <option value="">Todos los estados</option>
            <option value="pending">Pendientes</option>
            <option value="read">Leídos</option>
            <option value="summarized">Resumidos</option>
            <option value="evaluated">Evaluados</option>
          </select>

          {/* Sort */}
          <select
            value={filters.sort_by}
            onChange={(e) => handleFilterChange('sort_by', e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-prion-primary"
          >
            <option value="priority">Prioridad</option>
            <option value="year">Año</option>
            <option value="title">Título</option>
            <option value="read_date">Fecha lectura</option>
          </select>
        </div>

        {/* Stats row */}
        <div className="mt-4 pt-4 border-t border-gray-200">
          <p className="text-sm text-gray-600">
            Mostrando <span className="font-semibold">{articles.length}</span> artículos
          </p>
        </div>
      </div>

      {/* Articles List */}
      {loading ? (
        <Loader />
      ) : articles.length === 0 ? (
        <div className="bg-white rounded-lg shadow-md p-12 text-center">
          <p className="text-gray-500 text-lg">No hay artículos con estos filtros</p>
        </div>
      ) : (
        <div className="space-y-4">
          {articles.map((article) => (
            <ArticleCard
              key={article.id}
              article={article}
              onMarkAsRead={handleMarkAsRead}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default MyArticles;
