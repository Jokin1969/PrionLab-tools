import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { RiSearchLine, RiArrowRightLine, RiBookOpenLine } from 'react-icons/ri';
import api from '../../services/api';
import PageHeader from '../../components/layout/PageHeader';
import { StatusBadge } from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';

const STATUS_OPTIONS = [
  { value: '', label: 'Todos' },
  { value: 'pending', label: 'Pendiente' },
  { value: 'read', label: 'Leído' },
  { value: 'summarized', label: 'Resumido' },
  { value: 'evaluated', label: 'Evaluado' },
];

export default function MyArticles() {
  const [articles, setArticles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const fetchArticles = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ page, limit: 20 });
    if (search) params.set('search', search);
    if (status) params.set('status', status);

    api.get(`/my-articles?${params}`)
      .then((res) => {
        setArticles(res.data.articles ?? res.data);
        if (res.data.pagination) {
          setTotalPages(res.data.pagination.totalPages ?? 1);
        }
      })
      .catch(() => setArticles([]))
      .finally(() => setLoading(false));
  }, [search, status, page]);

  useEffect(() => { fetchArticles(); }, [fetchArticles]);

  function handleSearch(e) {
    e.preventDefault();
    setPage(1);
    fetchArticles();
  }

  return (
    <div>
      <PageHeader title="Mis Artículos" subtitle="Artículos asignados para lectura crítica" />

      <div className="p-6 space-y-4">
        {/* Filters */}
        <form onSubmit={handleSearch} className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-48">
            <RiSearchLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Buscar por título o autor..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input pl-9"
            />
          </div>
          <select
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            className="input w-auto"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button type="submit" className="btn-primary">Buscar</button>
        </form>

        {/* List */}
        {loading ? (
          <div className="flex justify-center py-12"><Spinner size="lg" /></div>
        ) : articles.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-gray-400">
            <RiBookOpenLine className="h-10 w-10" />
            <p className="text-sm">No hay artículos que mostrar</p>
          </div>
        ) : (
          <div className="space-y-2">
            {articles.map((a) => (
              <Link
                key={a.id}
                to={`/my-articles/${a.id}`}
                className="card flex items-center gap-4 p-4 hover:shadow-md transition-shadow"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-gray-900">{a.title}</p>
                  <p className="mt-0.5 truncate text-sm text-gray-500">
                    {Array.isArray(a.authors) ? a.authors.slice(0, 3).join(', ') : a.authors}
                    {a.year && ` · ${a.year}`}
                  </p>
                </div>
                <StatusBadge status={a.status ?? a.UserArticle?.status ?? 'pending'} />
                <RiArrowRightLine className="h-4 w-4 shrink-0 text-gray-400" />
              </Link>
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 pt-4">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="btn-secondary disabled:opacity-40"
            >
              Anterior
            </button>
            <span className="text-sm text-gray-500">{page} / {totalPages}</span>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="btn-secondary disabled:opacity-40"
            >
              Siguiente
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
