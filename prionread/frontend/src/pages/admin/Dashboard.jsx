import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { adminService } from '../../services/admin.service';
import { Card, Loader } from '../../components/common';
import { ProgressChart } from '../../components/charts/ProgressChart';

const AdminDashboard = () => {
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDashboard();
  }, []);

  const loadDashboard = async () => {
    try {
      const data = await adminService.getDashboard();
      setDashboard(data);
    } catch (error) {
      console.error('Error loading dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <Loader fullScreen />;
  if (!dashboard) return <div className="p-8 text-gray-500">Error cargando datos</div>;

  const {
    summary,
    top_performers,
    recent_activity,
    article_stats,
    monthly_progress,
  } = dashboard;

  // Normalise — backend may return summary or global_stats at top level
  const stats = summary ?? dashboard;
  const mostRead = article_stats?.most_read ?? [];
  const recentActivity = recent_activity ?? [];
  const topPerformers = top_performers ?? [];
  const monthlyData = monthly_progress ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900">📊 Dashboard Admin</h1>
        <p className="text-gray-600 mt-1">Vista general del laboratorio</p>
      </div>

      {/* Global Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card>
          <div className="text-center">
            <p className="text-4xl font-bold text-prion-primary mb-2">
              {stats.total_students ?? '—'}
            </p>
            <p className="text-sm text-gray-600">Estudiantes Activos</p>
          </div>
        </Card>

        <Card>
          <div className="text-center">
            <p className="text-4xl font-bold text-indigo-600 mb-2">
              {stats.total_articles ?? '—'}
            </p>
            <p className="text-sm text-gray-600">Artículos en Biblioteca</p>
            {stats.total_milestones != null && (
              <p className="text-xs text-gray-500 mt-1">
                {stats.total_milestones} milestones
              </p>
            )}
          </div>
        </Card>

        <Card>
          <div className="text-center">
            <p className="text-4xl font-bold text-green-600 mb-2">
              {stats.total_reads ?? '—'}
            </p>
            <p className="text-sm text-gray-600">Lecturas Totales</p>
          </div>
        </Card>

        <Card>
          <div className="text-center">
            <p className="text-4xl font-bold text-amber-600 mb-2">
              {stats.completion_rate != null
                ? `${Number(stats.completion_rate).toFixed(0)}%`
                : '—'}
            </p>
            <p className="text-sm text-gray-600">Tasa de Completitud</p>
            {stats.avg_evaluation_score != null && (
              <p className="text-xs text-gray-500 mt-1">
                Puntuación media: {Number(stats.avg_evaluation_score).toFixed(1)}/10
              </p>
            )}
          </div>
        </Card>
      </div>

      {/* Monthly Chart */}
      {monthlyData.length > 0 && (
        <Card title="📈 Progreso Mensual del Laboratorio">
          <ProgressChart data={monthlyData} />
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top Performers */}
        <Card title="🏆 Mejores Estudiantes">
          {topPerformers.length === 0 ? (
            <p className="text-sm text-gray-400">Sin datos disponibles</p>
          ) : (
            <div className="space-y-4">
              {topPerformers.map((student, idx) => (
                <Link
                  key={student.user_id ?? student.id ?? idx}
                  to="/admin/users"
                  className="flex items-center gap-4 p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-amber-100 text-amber-600 font-bold shrink-0">
                    {idx + 1}
                  </div>
                  {student.photo_url ? (
                    <img
                      src={student.photo_url}
                      alt={student.name}
                      className="w-12 h-12 rounded-full object-cover shrink-0"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-full bg-indigo-100 flex items-center justify-center text-lg font-bold text-prion-primary shrink-0">
                      {student.name?.[0]?.toUpperCase() ?? '?'}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-gray-900 truncate">{student.name}</p>
                    <p className="text-sm text-gray-600">
                      {student.articles_read ?? student.reads_count ?? 0} leídos
                      {student.avg_score != null && ` • Nota: ${Number(student.avg_score).toFixed(1)}/10`}
                    </p>
                  </div>
                  {student.completion_rate != null && (
                    <div className="text-right shrink-0">
                      <p className="text-sm font-medium text-green-600">
                        {(Number(student.completion_rate) * 100).toFixed(0)}%
                      </p>
                    </div>
                  )}
                </Link>
              ))}
            </div>
          )}
        </Card>

        {/* Most Read Articles */}
        <Card title="📚 Artículos Más Leídos">
          {mostRead.length === 0 ? (
            <p className="text-sm text-gray-400">Sin datos disponibles</p>
          ) : (
            <div className="space-y-3">
              {mostRead.slice(0, 5).map((article) => (
                <div
                  key={article.article_id ?? article.id}
                  className="block p-3 bg-gray-50 rounded-lg"
                >
                  <p className="font-semibold text-gray-900 text-sm mb-1 truncate">
                    {article.title}
                  </p>
                  <div className="flex items-center justify-between text-xs text-gray-600">
                    <span>{article.times_read ?? article.count ?? 0} lecturas</span>
                    {article.avg_rating != null && (
                      <span>
                        {'⭐'.repeat(Math.round(article.avg_rating))} ({Number(article.avg_rating).toFixed(1)})
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Recent Activity */}
      {recentActivity.length > 0 && (
        <Card title="📝 Actividad Reciente">
          <div className="space-y-3">
            {recentActivity.slice(0, 10).map((activity, idx) => (
              <div key={idx} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                {activity.user_photo ? (
                  <img
                    src={activity.user_photo}
                    alt={activity.user_name}
                    className="w-10 h-10 rounded-full object-cover shrink-0"
                  />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-sm font-bold text-prion-primary shrink-0">
                    {activity.user_name?.[0]?.toUpperCase() ?? '?'}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm">
                    <span className="font-semibold">{activity.user_name}</span>
                    {' '}
                    <span className="text-gray-600">
                      {activity.action === 'evaluated' ? 'evaluó' :
                       activity.action === 'summarized' ? 'resumió' :
                       'leyó'}
                    </span>
                  </p>
                  <p className="text-xs text-gray-600 truncate">{activity.article_title}</p>
                  {activity.score != null && (
                    <p className="text-xs text-green-600 font-medium">
                      Puntuación: {activity.score}/10
                    </p>
                  )}
                </div>
                <p className="text-xs text-gray-500 shrink-0">
                  {new Date(activity.date).toLocaleDateString('es-ES')}
                </p>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
};

export default AdminDashboard;
