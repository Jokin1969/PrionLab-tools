import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  RiArrowLeftLine, RiCheckLine, RiRobot2Line, RiSaveLine,
  RiStarLine, RiStarFill, RiExternalLinkLine,
} from 'react-icons/ri';
import api from '../../services/api';
import { StatusBadge } from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';

function StarRating({ value, onChange }) {
  const [hover, setHover] = useState(0);
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= (hover || value);
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(0)}
            className="text-amber-400 hover:scale-110 transition-transform"
          >
            {filled ? <RiStarFill className="h-6 w-6" /> : <RiStarLine className="h-6 w-6" />}
          </button>
        );
      })}
    </div>
  );
}

export default function ArticleDetail() {
  const { articleId } = useParams();
  const navigate = useNavigate();

  const [article, setArticle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const [summaryText, setSummaryText] = useState('');
  const [aiLoading, setAiLoading] = useState(false);

  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [ratingMsg, setRatingMsg] = useState('');

  useEffect(() => {
    api.get(`/my-articles/${articleId}`)
      .then((res) => {
        const a = res.data.article ?? res.data;
        setArticle(a);
        if (a.summary?.content) setSummaryText(a.summary.content);
        if (a.myRating) {
          setRating(a.myRating.rating ?? 0);
          setComment(a.myRating.comment ?? '');
        }
      })
      .catch(() => setError('No se pudo cargar el artículo'))
      .finally(() => setLoading(false));
  }, [articleId]);

  async function markAsRead() {
    setSaving(true);
    try {
      await api.post(`/my-articles/${articleId}/read`);
      setArticle((prev) => ({ ...prev, status: 'read', UserArticle: { ...prev.UserArticle, status: 'read' } }));
      setMsg('Marcado como leído');
    } catch (err) {
      setMsg(err.response?.data?.error || 'Error al marcar como leído');
    } finally {
      setSaving(false);
    }
  }

  async function saveSummary() {
    setSaving(true);
    try {
      await api.post(`/my-articles/${articleId}/summary`, { content: summaryText });
      setArticle((prev) => ({ ...prev, status: 'summarized' }));
      setMsg('Resumen guardado');
    } catch (err) {
      setMsg(err.response?.data?.error || 'Error al guardar resumen');
    } finally {
      setSaving(false);
    }
  }

  async function generateAI() {
    setAiLoading(true);
    try {
      const res = await api.post(`/my-articles/${articleId}/summary/ai`);
      setSummaryText(res.data.content ?? res.data.summary ?? '');
    } catch (err) {
      setMsg(err.response?.data?.error || 'Error generando resumen IA');
    } finally {
      setAiLoading(false);
    }
  }

  async function submitRating() {
    if (!rating) return;
    setSaving(true);
    try {
      await api.post(`/articles/${articleId}/ratings`, { rating, comment });
      setRatingMsg('Valoración guardada');
    } catch (err) {
      setRatingMsg(err.response?.data?.error || 'Error al guardar valoración');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-12">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error || !article) {
    return (
      <div className="p-6">
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error || 'Artículo no encontrado'}</p>
      </div>
    );
  }

  const status = article.UserArticle?.status ?? article.status ?? 'pending';
  const canSummarize = ['read', 'summarized', 'evaluated'].includes(status);
  const canRate = canSummarize;

  return (
    <div className="mx-auto max-w-3xl p-6 space-y-6">
      {/* Back */}
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
      >
        <RiArrowLeftLine className="h-4 w-4" />
        Volver
      </button>

      {/* Header */}
      <div className="card p-6 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-xl font-bold text-gray-900 leading-snug">{article.title}</h1>
          <StatusBadge status={status} />
        </div>
        <p className="text-sm text-gray-600">
          {Array.isArray(article.authors) ? article.authors.join(', ') : article.authors}
          {article.year && <span className="ml-2 text-gray-400">({article.year})</span>}
        </p>
        {article.journal && <p className="text-sm italic text-gray-500">{article.journal}</p>}
        {article.abstract && (
          <p className="text-sm text-gray-700 leading-relaxed border-t border-gray-100 pt-3">{article.abstract}</p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          {article.doi && (
            <a
              href={`https://doi.org/${article.doi}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-prion-primary hover:underline"
            >
              DOI <RiExternalLinkLine className="h-3 w-3" />
            </a>
          )}
          {Array.isArray(article.tags) && article.tags.map((t) => (
            <span key={t} className="rounded bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700">{t}</span>
          ))}
        </div>

        {msg && <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{msg}</p>}

        {status === 'pending' && (
          <button onClick={markAsRead} disabled={saving} className="btn-primary flex items-center gap-2">
            {saving ? <Spinner size="sm" /> : <RiCheckLine className="h-4 w-4" />}
            Marcar como leído
          </button>
        )}
      </div>

      {/* Summary */}
      {canSummarize && (
        <div className="card p-6 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-gray-800">Resumen crítico</h2>
            <button
              onClick={generateAI}
              disabled={aiLoading}
              className="btn-secondary flex items-center gap-2 text-xs"
            >
              {aiLoading ? <Spinner size="sm" /> : <RiRobot2Line className="h-4 w-4" />}
              Generar con IA
            </button>
          </div>
          <textarea
            rows={8}
            value={summaryText}
            onChange={(e) => setSummaryText(e.target.value)}
            placeholder="Escribe aquí tu resumen crítico del artículo..."
            className="input resize-y"
          />
          <button
            onClick={saveSummary}
            disabled={saving || !summaryText.trim()}
            className="btn-primary flex items-center gap-2"
          >
            {saving ? <Spinner size="sm" /> : <RiSaveLine className="h-4 w-4" />}
            Guardar resumen
          </button>
        </div>
      )}

      {/* Rating */}
      {canRate && (
        <div className="card p-6 space-y-3">
          <h2 className="font-semibold text-gray-800">Tu valoración</h2>
          <StarRating value={rating} onChange={setRating} />
          <textarea
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Comentario opcional..."
            className="input resize-y"
          />
          {ratingMsg && <p className="text-sm text-green-700">{ratingMsg}</p>}
          <button
            onClick={submitRating}
            disabled={saving || !rating}
            className="btn-primary"
          >
            Guardar valoración
          </button>
        </div>
      )}
    </div>
  );
}
