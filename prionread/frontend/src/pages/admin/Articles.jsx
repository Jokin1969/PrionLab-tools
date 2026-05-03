import { useState, useEffect } from 'react';
import { adminService } from '../../services/admin.service';
import { ArticleModal } from '../../components/admin/ArticleModal';
import { Card, Button, Input, Loader } from '../../components/common';

const AdminArticles = () => {
  const [articles, setArticles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingArticle, setEditingArticle] = useState(null);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({
    is_milestone: '',
    year: '',
    sort_by: 'year',
    order: 'desc',
  });
  const [msg, setMsg] = useState('');

  useEffect(() => {
    loadArticles();
  }, [filters]);

  const loadArticles = async () => {
    setLoading(true);
    try {
      const data = await adminService.getArticles(filters);
      setArticles(data.articles || []);
    } catch (error) {
      console.error('Error loading articles:', error);
    } finally {
      setLoading(false);
    }
  };

  const flash = (text) => {
    setMsg(text);
    setTimeout(() => setMsg(''), 3000);
  };

  const handleCreateArticle = async (formData) => {
    await adminService.createArticle(formData);
    loadArticles();
    flash('Artículo creado correctamente');
  };

  const handleUpdateArticle = async (formData) => {
    await adminService.updateArticle(editingArticle.id, formData);
    loadArticles();
    setEditingArticle(null);
    flash('Artículo actualizado correctamente');
  };

  const handleDeleteArticle = async (articleId, title) => {
    if (!window.confirm(`¿Eliminar artículo "${title}"?`)) return;
    try {
      await adminService.deleteArticle(articleId);
      loadArticles();
      flash('Artículo eliminado');
    } catch {
      flash('Error eliminando artículo');
    }
  };

  const handleAssignToAll = async (articleId, title) => {
    if (!window.confirm(`¿Asignar "${title}" a TODOS los estudiantes?`)) return;
    try {
      const data = await adminService.assignArticleToAll(articleId);
      flash(`Asignado a ${data.assigned_to ?? data.count ?? 'todos los'} estudiantes`);
    } catch {
      flash('Error asignando artículo');
    }
  };

  const authorsText = (authors) =>
    Array.isArray(authors) ? authors.join(', ') : (authors ?? '');

  const filteredArticles = articles.filter((article) => {
    const q = search.toLowerCase();
    return (
      article.title?.toLowerCase().includes(q) ||
      authorsText(article.authors).toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">📚 Artículos</h1>
          <p className="text-gray-600 mt-1">Gestiona la biblioteca del laboratorio</p>
        </div>
        <Button onClick={() => { setEditingArticle(null); setShowModal(true); }}>
          + Nuevo Artículo
        </Button>
      </div>

      {msg && (
        <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">
          {msg}
        </div>
      )}

      {/* Filters */}
      <Card>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="md:col-span-2">
            <Input
              placeholder="Buscar por título o autor..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <select
            value={filters.is_milestone}
            onChange={(e) => setFilters((prev) => ({ ...prev, is_milestone: e.target.value }))}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-prion-primary"
          >
            <option value="">Todos</option>
            <option value="true">Solo Milestones</option>
            <option value="false">Solo Regulares</option>
          </select>

          <select
            value={filters.sort_by}
            onChange={(e) => setFilters((prev) => ({ ...prev, sort_by: e.target.value }))}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-prion-primary"
          >
            <option value="year">Año</option>
            <option value="title">Título</option>
            <option value="priority">Prioridad</option>
          </select>
        </div>

        <div className="mt-4 pt-4 border-t border-gray-200">
          <p className="text-sm text-gray-600">
            Mostrando <span className="font-semibold">{filteredArticles.length}</span> artículos
          </p>
        </div>
      </Card>

      {/* Articles Table */}
      {loading ? (
        <Loader />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Artículo</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Año</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Prioridad</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Stats</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredArticles.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-10 text-center text-sm text-gray-400">
                      No se encontraron artículos
                    </td>
                  </tr>
                ) : filteredArticles.map((article) => (
                  <tr key={article.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 max-w-sm">
                      <p className="font-semibold text-gray-900 truncate">{article.title}</p>
                      <p className="text-sm text-gray-600 truncate">{authorsText(article.authors)}</p>
                      <div className="flex flex-wrap gap-1 mt-2">
                        {article.is_milestone && (
                          <span className="px-2 py-0.5 text-xs bg-amber-100 text-amber-600 rounded">
                            ⭐ Milestone
                          </span>
                        )}
                        {article.tags?.slice(0, 2).map((tag) => (
                          <span key={tag} className="px-2 py-0.5 text-xs bg-gray-100 text-gray-600 rounded">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600">{article.year}</td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 text-xs font-medium rounded ${
                        article.priority >= 4
                          ? 'bg-red-100 text-red-600'
                          : 'bg-blue-100 text-blue-600'
                      }`}>
                        P{article.priority ?? '—'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600">
                      {article.times_read != null && <p>{article.times_read} lecturas</p>}
                      {article.avg_rating != null && (
                        <p className="text-xs">⭐ {Number(article.avg_rating).toFixed(1)}</p>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex gap-2 flex-wrap">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { setEditingArticle(article); setShowModal(true); }}
                        >
                          Editar
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleAssignToAll(article.id, article.title)}
                        >
                          Asignar a Todos
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => handleDeleteArticle(article.id, article.title)}
                        >
                          Eliminar
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <ArticleModal
        isOpen={showModal}
        onClose={() => { setShowModal(false); setEditingArticle(null); }}
        onSave={editingArticle ? handleUpdateArticle : handleCreateArticle}
        article={editingArticle}
      />
    </div>
  );
};

export default AdminArticles;
