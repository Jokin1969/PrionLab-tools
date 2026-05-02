import { useState, useEffect } from 'react';
import {
  RiBookOpenLine, RiCheckboxCircleLine, RiFireLine,
  RiBarChartLine, RiStarLine, RiArrowRightLine,
} from 'react-icons/ri';
import { Link } from 'react-router-dom';
import api from '../../services/api';
import PageHeader from '../../components/layout/PageHeader';
import StatCard from '../../components/ui/StatCard';
import { StatusBadge } from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';

export default function StudentDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/my-dashboard')
      .then((res) => setData(res.data))
      .catch(() => setError('No se pudo cargar el dashboard'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-12">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>
      </div>
    );
  }

  const { stats, streak, lab_comparison, recent_activity, recommendations } = data;

  return (
    <div>
      <PageHeader title="Mi Dashboard" subtitle="Tu progreso de lectura crítica" />

      <div className="p-6 space-y-6">
        {/* Stats grid */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard
            label="Artículos asignados"
            value={stats?.total_assigned ?? '—'}
            icon={RiBookOpenLine}
            color="indigo"
          />
          <StatCard
            label="Completados"
            value={stats?.completed ?? '—'}
            sub={`${stats?.completion_rate ?? 0}% del total`}
            icon={RiCheckboxCircleLine}
            color="green"
          />
          <StatCard
            label="Racha actual"
            value={streak?.current_streak ?? 0}
            sub="días consecutivos"
            icon={RiFireLine}
            color="amber"
          />
          <StatCard
            label="Puntuación media"
            value={stats?.avg_score != null ? Number(stats.avg_score).toFixed(1) : '—'}
            sub="en evaluaciones"
            icon={RiStarLine}
            color="purple"
          />
        </div>

        {/* Lab comparison */}
        {lab_comparison && (
          <div className="card p-5">
            <h2 className="mb-3 text-sm font-semibold text-gray-700">Posición en el laboratorio</h2>
            <div className="flex items-center gap-4">
              <div className="text-center">
                <p className="text-3xl font-bold text-prion-primary">#{lab_comparison.rank}</p>
                <p className="text-xs text-gray-500">de {lab_comparison.total_students}</p>
              </div>
              <div className="flex-1">
                <div className="mb-1 flex justify-between text-xs text-gray-500">
                  <span>Percentil</span>
                  <span>{lab_comparison.percentile}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                  <div
                    className="h-full rounded-full bg-prion-primary transition-all"
                    style={{ width: `${lab_comparison.percentile}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Recent activity */}
          <div className="card p-5">
            <h2 className="mb-3 text-sm font-semibold text-gray-700">Actividad reciente</h2>
            {recent_activity?.length ? (
              <ul className="space-y-2">
                {recent_activity.slice(0, 5).map((item) => (
                  <li key={item.id} className="flex items-center gap-3">
                    <RiBarChartLine className="h-4 w-4 shrink-0 text-gray-400" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-gray-800">{item.title}</p>
                      <p className="text-xs text-gray-400">{item.date}</p>
                    </div>
                    <StatusBadge status={item.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-400">Sin actividad reciente</p>
            )}
          </div>

          {/* Recommendations */}
          <div className="card p-5">
            <h2 className="mb-3 text-sm font-semibold text-gray-700">Artículos recomendados</h2>
            {recommendations?.length ? (
              <ul className="space-y-2">
                {recommendations.slice(0, 5).map((rec) => (
                  <li key={rec.id}>
                    <Link
                      to={`/my-articles/${rec.id}`}
                      className="flex items-center gap-3 rounded-lg p-2 hover:bg-gray-50"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-gray-800">{rec.title}</p>
                        <p className="text-xs text-gray-400">{rec.reason}</p>
                      </div>
                      <RiArrowRightLine className="h-4 w-4 shrink-0 text-gray-400" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-400">No hay recomendaciones disponibles</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
