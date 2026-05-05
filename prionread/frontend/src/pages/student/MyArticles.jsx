import { useState, useEffect } from 'react';
import { studentService } from '../../services/student.service';
import { ArticleCard } from '../../components/student/ArticleCard';
import { Loader, Input } from '../../components/common';

const STATUS_BTNS = [
  { value: '',           label: 'Todos' },
  { value: 'pending',    label: '⏳ Pendientes' },
  { value: 'read',       label: '📖 Leídos' },
  { value: 'summarized', label: '📝 Resumidos' },
  { value: 'evaluated',  label: '✅ Evaluados' },
];

const SORT_BTNS = [
  { value: 'priority',  label: '🎯 Prioridad' },
  { value: 'year',      label: '📅 Año' },
  { value: 'title',     label: '🔤 Título' },
  { value: 'read_date', label: '✓ Leídos' },
];

const FilterBtn = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
      active
        ? 'bg-prion-primary text-white border-prion-primary'
        : 'bg-white text-gray-600 border-gray-200 hover:border-prion-primary hover:text-prion-primary'
    }`}
  >
    {children}
  </button>
);

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
        summary_date: assignment?.summary_date,
        evaluation_date: assignment?.evaluation_date,
        has_user_rating: assignment?.has_user_rating,
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

  const handleUnmarkAsRead = async (articleId) => {
    try {
      await studentService.unmarkAsRead(articleId);
      loadArticles();
    } catch (error) {
      console.error('Error unmarking as read:', error);
    }
  };

  const set = (key, value) => setFilters((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900">📚 Mis Artículos</h1>
        <p className="text-gray-600 mt-1">Gestiona tu biblioteca personal de lectura científica</p>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow-md p-4 space-y-3">
        {/* Search — full width */}
        <Input
          placeholder="Buscar por título, autor..."
          value={filters.search}
          onChange={(e) => set('search', e.target.value)}
        />

        {/* Status filter */}
        <div className="flex flex-wrap gap-2">
          {STATUS_BTNS.map(({ value, label }) => (
            <FilterBtn key={value} active={filters.status === value} onClick={() => set('status', value)}>
              {label}
            </FilterBtn>
          ))}
        </div>

        {/* Sort */}
        <div className="flex flex-wrap gap-2 pt-1 border-t border-gray-100 items-center">
          <span className="text-xs text-gray-400 mr-1">Ordenar:</span>
          {SORT_BTNS.map(({ value, label }) => (
            <FilterBtn key={value} active={filters.sort_by === value} onClick={() => set('sort_by', value)}>
              {label}
            </FilterBtn>
          ))}
          <button
            onClick={() => set('order', filters.order === 'asc' ? 'desc' : 'asc')}
            className="px-2 py-1.5 text-xs font-medium rounded-lg border border-gray-200 bg-white text-gray-500 hover:border-prion-primary hover:text-prion-primary transition-colors"
            title="Invertir orden"
          >
            {filters.order === 'asc' ? '↑' : '↓'}
          </button>
          <span className="ml-auto text-xs text-gray-500">
            <span className="font-semibold">{articles.length}</span> artículos
          </span>
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
              onUnmarkAsRead={handleUnmarkAsRead}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default MyArticles;
