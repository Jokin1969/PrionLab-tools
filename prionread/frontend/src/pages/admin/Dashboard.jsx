import { useState, useEffect } from 'react';
import {
  RiGroupLine, RiArticleLine, RiCheckboxCircleLine,
  RiBarChartLine, RiTrophyLine,
} from 'react-icons/ri';
import api from '../../services/api';
import PageHeader from '../../components/layout/PageHeader';
import StatCard from '../../components/ui/StatCard';
import Spinner from '../../components/ui/Spinner';

function MonthlyChart({ data }) {
  if (!data?.length) return null;
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <div className="card p-5">
      <h2 className="mb-4 text-sm font-semibold text-gray-700">Progreso mensual (lecturas completadas)</h2>
      <div className="flex items-end gap-1 h-32">
        {data.map((d) => (
          <div key={d.month} className="flex flex-1 flex-col items-center gap-1">
            <div
              className="w-full rounded-t bg-prion-primary transition-all"
              style={{ height: `${(d.count / max) * 100}%`, minHeight: d.count ? '4px' : '0' }}
            />
            <span className="text-[10px] text-gray-400 rotate-45 origin-left translate-y-1">
              {d.month?.slice(5)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AdminDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/admin/dashboard')
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

  const { summary, top_performers, monthly_progress, article_stats } = data ?? {};

  return (
    <div>
      <PageHeader title="Dashboard Admin" subtitle="Vista general del laboratorio" />

      <div className="p-6 space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard
            label="Estudiantes"
            value={summary?.total_students}
            icon={RiGroupLine}
            color="indigo"
          />
          <StatCard
            label="Artículos"
            value={summary?.total_articles}
            icon={RiArticleLine}
            color="purple"
          />
          <StatCard
            label="Lecturas completadas"
            value={summary?.total_reads}
            icon={RiCheckboxCircleLine}
            color="green"
          />
          <StatCard
            label="Tasa de progreso"
            value={summary?.completion_rate != null ? `${Number(summary.completion_rate).toFixed(1)}%` : '—'}
            icon={RiBarChartLine}
            color="amber"
          />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Monthly chart */}
          <MonthlyChart data={monthly_progress} />

          {/* Top performers */}
          <div className="card p-5">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-700">
              <RiTrophyLine className="h-4 w-4 text-amber-500" />
              Top estudiantes
            </h2>
            {top_performers?.length ? (
              <ol className="space-y-2">
                {top_performers.map((s, i) => (
                  <li key={s.id} className="flex items-center gap-3">
                    <span className="w-5 text-center text-sm font-bold text-gray-400">#{i + 1}</span>
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-prion-primary">
                      {s.name?.[0]?.toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-gray-800">{s.name}</p>
                    </div>
                    <span className="text-sm font-semibold text-prion-primary">{s.reads_count} leídos</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-gray-400">Sin datos disponibles</p>
            )}
          </div>
        </div>

        {/* Article read stats */}
        {article_stats && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="card p-5">
              <h2 className="mb-3 text-sm font-semibold text-gray-700">Artículos más leídos</h2>
              {article_stats.most_read?.length ? (
                <ul className="space-y-2">
                  {article_stats.most_read.slice(0, 5).map((a) => (
                    <li key={a.id} className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-gray-800">{a.title}</p>
                      </div>
                      <span className="text-xs font-semibold text-prion-primary">{a.count}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-gray-400">Sin datos</p>}
            </div>
            <div className="card p-5">
              <h2 className="mb-3 text-sm font-semibold text-gray-700">Artículos pendientes</h2>
              {article_stats.least_read?.length ? (
                <ul className="space-y-2">
                  {article_stats.least_read.slice(0, 5).map((a) => (
                    <li key={a.id} className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-gray-800">{a.title}</p>
                      </div>
                      <span className="text-xs text-gray-400">{a.count} leídos</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-gray-400">Sin datos</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
