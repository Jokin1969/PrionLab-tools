import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../common';
import { studentService } from '../../services/student.service';

export const ArticleCard = ({ article, onMarkAsRead, onUnmarkAsRead }) => {
  const [fetchingPdf, setFetchingPdf]   = useState(false);
  const [showBlockMsg, setShowBlockMsg] = useState(false);

  const statusColors = {
    pending:   'bg-gray-100 text-gray-600',
    read:      'bg-blue-100 text-blue-600',
    summarized:'bg-indigo-100 text-indigo-600',
    evaluated: 'bg-green-100 text-green-600',
  };
  const statusLabels = {
    pending:   'Pendiente',
    read:      'Leído',
    summarized:'Resumido',
    evaluated: 'Evaluado',
  };

  const hasSummary    = !!article.summary_date;
  const hasEvaluation = !!article.evaluation_date;
  const hasRating     = !!article.has_user_rating;
  const canMarkAsRead = hasSummary && hasEvaluation && hasRating;

  const missing = [
    !hasSummary    && 'el resumen',
    !hasEvaluation && 'la autoevaluación',
    !hasRating     && 'la valoración',
  ].filter(Boolean);

  const handleDownloadPdf = async () => {
    setFetchingPdf(true);
    try {
      await studentService.openPdf(article.id);
    } catch {
      alert('No se pudo abrir el PDF.');
    } finally {
      setFetchingPdf(false);
    }
  };

  const handleBlockedClick = () => {
    setShowBlockMsg(true);
    setTimeout(() => setShowBlockMsg(false), 4000);
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <Link to={`/my-articles/${article.id}`}>
            <h3 className="text-lg font-semibold text-gray-900 hover:text-prion-primary mb-2">
              {article.title}
            </h3>
          </Link>
          <p className="text-sm text-gray-600 mb-3">
            {Array.isArray(article.authors) ? article.authors.join(', ') : article.authors}
          </p>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <span>{article.journal || 'Journal N/A'}</span>
            <span>•</span>
            <span>{article.year}</span>
          </div>
        </div>

        <div className="ml-4 flex flex-col items-end gap-2 shrink-0">
          <span className={`px-3 py-1 text-xs font-medium rounded-full ${statusColors[article.status] ?? statusColors.pending}`}>
            {statusLabels[article.status] ?? 'Pendiente'}
          </span>
          {article.is_milestone && (
            <span className="px-2 py-1 text-xs font-medium bg-amber-100 text-amber-600 rounded">
              ⭐ Milestone
            </span>
          )}
        </div>
      </div>

      {/* Tags */}
      {article.tags && article.tags.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {article.tags.map((tag) => (
            <span key={tag} className="px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded">
              #{tag}
            </span>
          ))}
        </div>
      )}

      {/* Rating */}
      {article.avg_rating && (
        <div className="mb-4 text-sm text-gray-600">
          Valoración media: {'⭐'.repeat(Math.round(article.avg_rating))} ({Number(article.avg_rating).toFixed(1)})
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 flex-wrap items-center">
        <Link to={`/my-articles/${article.id}`}>
          <Button variant="primary" size="sm">Ver Detalle</Button>
        </Link>

        {/* Mark / unmark as read */}
        {article.status === 'pending' ? (
          canMarkAsRead ? (
            <Button variant="secondary" size="sm" onClick={() => onMarkAsRead(article.id)}>
              ✓ Marcar como leído
            </Button>
          ) : (
            <button
              onClick={handleBlockedClick}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 bg-gray-50 text-gray-400 cursor-pointer select-none opacity-60 hover:opacity-80 transition-opacity"
            >
              ✓ Marcar como leído
            </button>
          )
        ) : (
          <Button variant="ghost" size="sm" onClick={() => onUnmarkAsRead(article.id)}>
            ↩ Desmarcar como leído
          </Button>
        )}

        {/* PDF */}
        {article.dropbox_path && (
          <Button variant="ghost" size="sm" onClick={handleDownloadPdf} loading={fetchingPdf} disabled={fetchingPdf}>
            📄 PDF
          </Button>
        )}
      </div>

      {/* Blocked message */}
      {showBlockMsg && (
        <p className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Para marcar como leído necesitas completar antes:{' '}
          <span className="font-semibold">{missing.join(', ')}</span>.
          Accede al detalle del artículo para completarlos.
        </p>
      )}
    </div>
  );
};
