import { useState } from 'react';
import {
  RiDownloadLine, RiFileChartLine, RiUser3Line,
  RiBookmarkLine, RiCalendarLine,
} from 'react-icons/ri';
import api from '../../services/api';
import PageHeader from '../../components/layout/PageHeader';
import Spinner from '../../components/ui/Spinner';

const FORMATS = ['json', 'csv', 'pdf'];

function ReportCard({ title, description, icon: Icon, color, onDownload, loading }) {
  const [format, setFormat] = useState('pdf');

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${color}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <h3 className="font-semibold text-gray-900">{title}</h3>
          <p className="mt-0.5 text-sm text-gray-500">{description}</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <select
          value={format}
          onChange={(e) => setFormat(e.target.value)}
          className="input w-auto text-sm"
        >
          {FORMATS.map((f) => (
            <option key={f} value={f}>{f.toUpperCase()}</option>
          ))}
        </select>
        <button
          onClick={() => onDownload(format)}
          disabled={loading}
          className="btn-primary flex items-center gap-2 text-sm"
        >
          {loading ? <Spinner size="sm" /> : <RiDownloadLine className="h-4 w-4" />}
          Descargar
        </button>
      </div>
    </div>
  );
}

export default function AdminReports() {
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [studentId, setStudentId] = useState('');
  const [loadingMap, setLoadingMap] = useState({});
  const [msg, setMsg] = useState('');

  function setLoading(key, val) {
    setLoadingMap((prev) => ({ ...prev, [key]: val }));
  }

  function buildDateParams() {
    const params = new URLSearchParams();
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    return params.toString();
  }

  async function downloadReport(endpoint, filename, format) {
    const dateParams = buildDateParams();
    const sep = dateParams ? '&' : '';
    const url = `${endpoint}?format=${format}${dateParams ? `&${dateParams}` : ''}`;
    try {
      const res = await api.get(url, {
        responseType: format === 'json' ? 'json' : 'blob',
      });
      if (format === 'json') {
        const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${filename}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
      } else {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(res.data);
        link.download = `${filename}.${format}`;
        link.click();
        URL.revokeObjectURL(link.href);
      }
      setMsg('Reporte descargado');
    } catch {
      setMsg('Error al generar el reporte');
    }
    setTimeout(() => setMsg(''), 3000);
  }

  async function handleGlobalSummary(format) {
    setLoading('global', true);
    await downloadReport('/admin/reports/global-summary', 'resumen-global', format);
    setLoading('global', false);
  }

  async function handleStudentProgress(format) {
    if (!studentId.trim()) {
      setMsg('Introduce el ID del estudiante');
      setTimeout(() => setMsg(''), 3000);
      return;
    }
    setLoading('student', true);
    const dateParams = buildDateParams();
    const url = `/admin/reports/student-progress?format=${format}&userId=${studentId}${dateParams ? `&${dateParams}` : ''}`;
    try {
      const res = await api.get(url, { responseType: format === 'json' ? 'json' : 'blob' });
      if (format === 'json') {
        const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'progreso-estudiante.json';
        link.click();
        URL.revokeObjectURL(link.href);
      } else {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(res.data);
        link.download = `progreso-estudiante.${format}`;
        link.click();
        URL.revokeObjectURL(link.href);
      }
      setMsg('Reporte descargado');
    } catch {
      setMsg('Error al generar el reporte');
    }
    setLoading('student', false);
    setTimeout(() => setMsg(''), 3000);
  }

  async function handleRecommendations(format) {
    setLoading('rec', true);
    await downloadReport('/admin/reports/reading-recommendations', 'recomendaciones', format);
    setLoading('rec', false);
  }

  return (
    <div>
      <PageHeader title="Reportes" subtitle="Genera y descarga informes del laboratorio" />

      <div className="p-6 space-y-6">
        {msg && <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{msg}</p>}

        {/* Date range filter */}
        <div className="card p-4">
          <div className="flex flex-wrap items-end gap-4">
            <RiCalendarLine className="h-5 w-5 text-gray-400 shrink-0 self-center" />
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Desde</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="input text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Hasta</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="input text-sm"
              />
            </div>
            <p className="text-xs text-gray-400 self-end pb-2">Opcional — filtra datos por rango de fechas</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ReportCard
            title="Resumen global"
            description="Métricas globales del laboratorio: lecturas, evaluaciones, progreso mensual."
            icon={RiFileChartLine}
            color="bg-indigo-50 text-indigo-600"
            onDownload={handleGlobalSummary}
            loading={loadingMap.global}
          />

          <ReportCard
            title="Recomendaciones de lectura"
            description="Artículos recomendados por estudiante según su progreso y etiquetas."
            icon={RiBookmarkLine}
            color="bg-green-50 text-green-600"
            onDownload={handleRecommendations}
            loading={loadingMap.rec}
          />
        </div>

        {/* Student progress — requires userId */}
        <div className="card p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-purple-50 text-purple-600">
              <RiUser3Line className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900">Progreso de estudiante</h3>
              <p className="mt-0.5 text-sm text-gray-500">Informe detallado de un estudiante específico.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-48">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">ID del estudiante</label>
              <input
                type="text"
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
                placeholder="UUID del usuario"
                className="input"
              />
            </div>
            {FORMATS.map((f) => (
              <button
                key={f}
                onClick={() => handleStudentProgress(f)}
                disabled={loadingMap.student}
                className="btn-secondary flex items-center gap-2 text-sm"
              >
                {loadingMap.student ? <Spinner size="sm" /> : <RiDownloadLine className="h-4 w-4" />}
                {f.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
