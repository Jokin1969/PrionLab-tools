import { useState, useEffect, useMemo } from 'react';
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

const FilterBtn = ({ active, count, onClick, children }) => (
  <button
    onClick={onClick}
    className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap flex items-center gap-1.5 ${
      active
        ? 'bg-prion-primary text-white border-prion-primary'
        : 'bg-white text-gray-600 border-gray-200 hover:border-prion-primary hover:text-prion-primary'
    }`}
  >
    {children}
    {count != null && (
      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none ${
        active ? 'bg-white/25 text-white' : 'bg-gray-100 text-gray-500'
      }`}>
        {count}
      </span>
    )}
  </button>
);

const MyArticles = () => {
  const [allArticles, setAllArticles]   = useState([]);
  const [loading, setLoading]           = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch]             = useState('');
  const [searchAbstract, setSearchAbstract] = useState(false);
  const [sortBy, setSortBy]             = useState('priority');
  const [order, setOrder]               = useState('desc');

  useEffect(() => { loadArticles(); }, [sortBy, order]);

  const loadArticles = async () => {
    setLoading(true);
    try {
      // Fetch all — status filtering is done client-side so counts are always available
      const data = await studentService.getMyArticles({ sort_by: sortBy, order });
      setAllArticles((data.articles || []).map(({ assignment, article }) => ({
        ...article,
        status:          assignment?.status,
        read_date:       assignment?.read_date,
        summary_date:    assignment?.summary_date,
        evaluation_date: assignment?.evaluation_date,
        has_user_rating: assignment?.has_user_rating,
        assignment_id:   assignment?.id,
      })));
    } catch (error) {
      console.error('Error loading articles:', error);
    } finally {
      setLoading(false);
    }
  };

  // Counts per status (always from full list, ignoring current search)
  const counts = useMemo(() => {
    const c = { '': allArticles.length };
    for (const a of allArticles) c[a.status] = (c[a.status] || 0) + 1;
    return c;
  }, [allArticles]);

  // eslint-disable-next-line no-misleading-character-class
  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Apply status + search filters in the client
  const articles = useMemo(() => {
    const q = norm(search.trim());
    return allArticles.filter((a) => {
      if (statusFilter && a.status !== statusFilter) return false;
      if (q) {
        const fields = [
          a.title,
          Array.isArray(a.authors) ? a.authors.join(' ') : a.authors,
          a.journal,
          a.year != null ? String(a.year) : '',
          a.doi,
          a.pubmed_id,
          Array.isArray(a.tags) ? a.tags.join(' ') : '',
          searchAbstract ? a.abstract : '',
        ].map((f) => norm(f));
        if (!fields.some((f) => f.includes(q))) return false;
      }
      return true;
    });
  }, [allArticles, statusFilter, search, searchAbstract]);

  const handleMarkAsRead = async (articleId) => {
    try { await studentService.markAsRead(articleId); loadArticles(); } catch { /* silent */ }
  };

  const handleUnmarkAsRead = async (articleId) => {
    try { await studentService.unmarkAsRead(articleId); loadArticles(); } catch { /* silent */ }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-gray-900">📚 Mis Artículos</h1>
        <p className="text-gray-600 mt-1">Gestiona tu biblioteca personal de lectura científica</p>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow-md p-4 space-y-3">
        {/* Search row */}
        <div className="flex gap-2 items-center">
          <Input
            placeholder="Buscar por título, autores, revista, año, DOI…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1"
          />
          <button
            onClick={() => setSearchAbstract((v) => !v)}
            title={searchAbstract ? 'Buscar también en el abstract (activo)' : 'Activar búsqueda en el abstract'}
            className={`shrink-0 px-3 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
              searchAbstract
                ? 'bg-prion-primary text-white border-prion-primary'
                : 'bg-white text-gray-500 border-gray-200 hover:border-prion-primary hover:text-prion-primary'
            }`}
          >
            Abstract
          </button>
        </div>

        {/* Status filter with counts */}
        <div className="flex flex-wrap gap-2">
          {STATUS_BTNS.map(({ value, label }) => (
            <FilterBtn
              key={value}
              active={statusFilter === value}
              count={counts[value] ?? 0}
              onClick={() => setStatusFilter(value)}
            >
              {label}
            </FilterBtn>
          ))}
        </div>

        {/* Sort */}
        <div className="flex flex-wrap gap-2 pt-1 border-t border-gray-100 items-center">
          <span className="text-xs text-gray-400 mr-1">Ordenar:</span>
          {SORT_BTNS.map(({ value, label }) => (
            <FilterBtn key={value} active={sortBy === value} onClick={() => setSortBy(value)}>
              {label}
            </FilterBtn>
          ))}
          <button
            onClick={() => setOrder((o) => o === 'asc' ? 'desc' : 'asc')}
            className="px-2 py-1.5 text-xs font-medium rounded-lg border border-gray-200 bg-white text-gray-500 hover:border-prion-primary hover:text-prion-primary transition-colors"
            title="Invertir orden"
          >
            {order === 'asc' ? '↑' : '↓'}
          </button>
          <span className="ml-auto text-xs text-gray-500">
            <span className="font-semibold">
              {articles.length < allArticles.length
                ? `${articles.length}/${allArticles.length}`
                : articles.length}
            </span>{' '}artículos
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
