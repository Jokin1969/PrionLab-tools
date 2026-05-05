import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { studentService } from '../../services/student.service';
import { StatCard } from '../../components/student/StatCard';
import { ProgressChart } from '../../components/charts/ProgressChart';
import { Card, Button, Loader } from '../../components/common';
import { useAuth } from '../../hooks/useAuth';

const StudentDashboard = () => {
  const { user } = useAuth();
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDashboard();
  }, []);

  const loadDashboard = async () => {
    try {
      const data = await studentService.getDashboard();
      setDashboard(data);
    } catch (error) {
      console.error('Error loading dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <Loader fullScreen />;
  if (!dashboard) return <div>Error cargando datos</div>;

  const { stats, recent_activity, next_recommended, progress_by_month } = dashboard;
  const totalAssigned = stats.total_assigned || 1;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900">
          ¡Hola, {user.name}! 👋
        </h1>
        <p className="text-gray-600 mt-1">
          Tu progreso de lectura científica
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          icon="📚"
          label="Artículos Asignados"
          value={stats.total_assigned}
          color="indigo"
        />
        <StatCard
          icon="📖"
          label="Pendientes"
          value={stats.pending}
          subtext={`${((stats.pending / totalAssigned) * 100).toFixed(0)}% del total`}
          color="amber"
        />
        <StatCard
          icon="✅"
          label="Evaluados"
          value={stats.evaluated}
          subtext={`${((stats.evaluated / totalAssigned) * 100).toFixed(0)}% completado`}
          color="green"
        />
        <StatCard
          icon="🎯"
          label="Puntuación Media"
          value={stats.avg_score?.toFixed(1) || '—'}
          subtext={
            stats.avg_score
              ? stats.avg_score >= 7 ? '¡Excelente!' : 'Sigue mejorando'
              : 'Sin evaluaciones'
          }
          color={stats.avg_score >= 7 ? 'green' : 'amber'}
        />
      </div>

      {/* Progress Chart */}
      <Card title="Progreso Mensual">
        <ProgressChart data={progress_by_month} />
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Next Recommended */}
        <Card
          title="🎯 Próximas Lecturas Recomendadas"
          actions={
            <Link to="/my-articles">
              <Button variant="ghost" size="sm">Ver todas</Button>
            </Link>
          }
        >
          <div className="space-y-3">
            {next_recommended.slice(0, 5).map((article) => (
              <Link
                key={article.id}
                to={`/my-articles/${article.id}`}
                className="block p-4 border border-gray-200 rounded-lg hover:border-prion-primary hover:shadow-md transition-all"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h4 className="font-semibold text-gray-900 mb-1">
                      {article.title}
                    </h4>
                    <p className="text-sm text-gray-600">
                      {article.authors} • {article.year}
                    </p>
                    <div className="flex gap-2 mt-2 flex-wrap">
                      {article.is_milestone && (
                        <span className="px-2 py-1 text-xs font-medium bg-amber-100 text-amber-600 rounded">
                          ⭐ Milestone
                        </span>
                      )}
                      {article.tags?.slice(0, 2).map((tag) => (
                        <span key={tag} className="px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="ml-4 text-right shrink-0">
                    <span className={`px-2 py-1 text-xs font-medium rounded ${
                      article.priority >= 4
                        ? 'bg-red-100 text-red-600'
                        : 'bg-blue-100 text-blue-600'
                    }`}>
                      P{article.priority}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </Card>

        {/* Recent Activity */}
        <Card title="📝 Actividad Reciente">
          <div className="space-y-3">
            {recent_activity.slice(0, 5).map((activity, idx) => (
              <div key={idx} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                  activity.type === 'evaluated' ? 'bg-green-100' :
                  activity.type === 'summarized' ? 'bg-blue-100' :
                  'bg-indigo-100'
                }`}>
                  {activity.type === 'evaluated' ? '✅' :
                   activity.type === 'summarized' ? '📝' :
                   '📖'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">
                    {activity.type === 'evaluated' ? 'Evaluaste' :
                     activity.type === 'summarized' ? 'Resumiste' :
                     'Leíste'}
                  </p>
                  <p className="text-xs text-gray-600 truncate">
                    {activity.article_title}
                  </p>
                  {activity.score != null && (
                    <p className="text-xs text-green-600 font-medium">
                      Puntuación: {activity.score}/10
                    </p>
                  )}
                  {activity.user_rating != null && (
                    <p className="text-xs text-amber-500">
                      {'⭐'.repeat(activity.user_rating)}{'☆'.repeat(5 - activity.user_rating)}
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
      </div>
    </div>
  );
};

export default StudentDashboard;
