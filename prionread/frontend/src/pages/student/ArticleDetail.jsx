import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { studentService } from '../../services/student.service';
import { Card, Button, Input, Loader, Modal } from '../../components/common';

const ArticleDetail = () => {
  const { articleId } = useParams();
  const navigate = useNavigate();

  const [article, setArticle]       = useState(null);
  const [summary, setSummary]       = useState(null);
  const [evaluation, setEvaluation] = useState(null);
  const [ratings, setRatings]       = useState([]);
  const [loading, setLoading]       = useState(true);

  const [summaryText, setSummaryText]     = useState('');
  const [savingSummary, setSavingSummary] = useState(false);
  const [generatingAI, setGeneratingAI]   = useState(false);

  const [showEvalModal, setShowEvalModal]   = useState(false);
  const [evalQuestions, setEvalQuestions]   = useState(null);
  const [evalAnswers, setEvalAnswers]       = useState([]);
  const [submittingEval, setSubmittingEval] = useState(false);
  const [generatingEval, setGeneratingEval] = useState(false);

  const [rating, setRating]         = useState(0);
  const [comment, setComment]       = useState('');
  const [fetchingPdf, setFetchingPdf] = useState(false);

  // Scroll to top whenever the article changes
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [articleId]);
  useEffect(() => { loadArticleData(); }, [articleId]);

  const loadArticleData = async () => {
    setLoading(true);
    try {
      const [articleData, ratingsData] = await Promise.all([
        studentService.getArticleDetail(articleId),
        studentService.getArticleRatings(articleId),
      ]);
      setArticle(articleData.article ?? articleData);
      setRatings(ratingsData.ratings || []);
      try {
        const summaryData = await studentService.getSummary(articleId);
        setSummary(summaryData.summary);
        setSummaryText(summaryData.summary?.content ?? '');
      } catch { /* no summary yet */ }
      try {
        const evalData = await studentService.getEvaluation(articleId);
        setEvaluation(evalData.evaluation);
      } catch { /* no evaluation yet */ }
    } catch (error) {
      console.error('Error loading article:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveSummary = async () => {
    if (!summaryText.trim()) return;
    setSavingSummary(true);
    try {
      await studentService.createSummary(articleId, summaryText);
      loadArticleData();
    } catch { /* silent */ }
    finally { setSavingSummary(false); }
  };

  const handleGenerateAISummary = async () => {
    setGeneratingAI(true);
    try {
      const data = await studentService.generateAISummary(articleId);
      setSummaryText(data.content ?? data.ai_summary ?? '');
    } catch { /* silent */ }
    finally { setGeneratingAI(false); }
  };

  const handleStartEvaluation = async () => {
    setGeneratingEval(true);
    try {
      const data = await studentService.generateEvaluation(articleId);
      setEvalQuestions(data.questions);
      // Pre-fill previous answers if redoing (null means unanswered)
      const prev = data.previous_answers ?? [];
      setEvalAnswers(data.questions.map((_, i) => prev[i] ?? null));
      setShowEvalModal(true);
    } catch { /* silent */ }
    finally { setGeneratingEval(false); }
  };

  const handleSubmitEvaluation = async () => {
    if (evalAnswers.includes(null)) return;
    setSubmittingEval(true);
    try {
      await studentService.submitEvaluation(articleId, evalQuestions, evalAnswers);
      setShowEvalModal(false);
      loadArticleData();
    } catch { /* silent */ }
    finally { setSubmittingEval(false); }
  };

  const handleDownloadPdf = async () => {
    setFetchingPdf(true);
    try {
      await studentService.openPdf(articleId);
    } catch {
      alert('No se pudo abrir el PDF. Inténtalo de nuevo.');
    } finally {
      setFetchingPdf(false);
    }
  };

  const handleRateArticle = async () => {
    if (rating === 0) return;
    try {
      await studentService.rateArticle(articleId, rating, comment);
      loadArticleData();
      setRating(0);
      setComment('');
    } catch { /* silent */ }
  };

  if (loading) return <Loader fullScreen />;
  if (!article) return <div className="p-8 text-gray-500">Artículo no encontrado</div>;

  const hasSummary    = !!summary;
  const hasEvaluation = !!evaluation;

  return (
    <div className="space-y-6">
      <Button variant="ghost" onClick={() => navigate(-1)}>← Volver</Button>

      {/* Article Info */}
      <Card>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between mb-4 gap-3">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl md:text-3xl font-bold text-gray-900 mb-3">{article.title}</h1>
            <p className="text-sm md:text-lg text-gray-700 mb-2">
              {Array.isArray(article.authors) ? article.authors.join(', ') : article.authors}
            </p>
            <div className="flex items-center gap-4 text-sm text-gray-600 flex-wrap">
              {article.journal && <span>{article.journal}</span>}
              {article.journal && article.year && <span>•</span>}
              {article.year && <span>{article.year}</span>}
              {article.doi && (
                <>
                  <span>•</span>
                  <a href={`https://doi.org/${article.doi}`} target="_blank" rel="noopener noreferrer" className="text-prion-primary hover:underline">
                    DOI: {article.doi}
                  </a>
                </>
              )}
              <>
                <span>•</span>
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                  article.pdf_pages ? 'bg-indigo-50 text-indigo-700' : 'bg-gray-100 text-gray-400'
                }`} title={article.pdf_pages ? `⚡ ${article.pdf_pages * 5} min PrionBonus al completar` : 'Número de páginas no disponible'}>
                  {article.pdf_pages ? `📄 ${article.pdf_pages} páginas · ⚡ ${article.pdf_pages * 5} min` : '📄 páginas desconocidas'}
                </span>
              </>
            </div>
          </div>
          {article.is_milestone && (
            <span className="shrink-0 self-start px-3 py-1 bg-amber-100 text-amber-600 font-medium rounded text-sm">⭐ Milestone</span>
          )}
        </div>

        {article.tags && article.tags.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            {article.tags.map((tag) => (
              <span key={tag} className="px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm">#{tag}</span>
            ))}
          </div>
        )}

        {article.abstract && (
          <div className="mt-6 p-4 bg-gray-50 rounded-lg">
            <h3 className="font-semibold text-gray-900 mb-2">Abstract</h3>
            <p className="text-sm text-gray-700 leading-relaxed">{article.abstract}</p>
          </div>
        )}

        {article.dropbox_path && (
          <div className="mt-6">
            <Button variant="primary" onClick={handleDownloadPdf} loading={fetchingPdf} disabled={fetchingPdf}>
              📥 Descargar PDF
            </Button>
          </div>
        )}
      </Card>

      {/* Summary */}
      <Card title="📝 Tu Resumen">
        <textarea
          value={summaryText}
          onChange={(e) => setSummaryText(e.target.value)}
          placeholder="Escribe aquí tu resumen del artículo..."
          rows={8}
          disabled={generatingAI}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-prion-primary resize-y disabled:opacity-50"
        />
        <div className="flex gap-2 mt-4 flex-wrap items-center">
          <Button onClick={handleSaveSummary} loading={savingSummary} disabled={!summaryText.trim() || generatingAI}>
            💾 Guardar Resumen
          </Button>
          <Button variant="secondary" onClick={handleGenerateAISummary} loading={generatingAI} disabled={generatingAI}>
            ✨ Generar con IA
          </Button>
          {generatingAI && (
            <span className="text-sm text-indigo-600 animate-pulse">
              Generando resumen con IA… puede tardar unos segundos
            </span>
          )}
        </div>
        {summary?.is_ai_generated && !generatingAI && (
          <p className="mt-2 text-xs text-gray-400">✨ Este resumen fue generado con IA</p>
        )}
      </Card>

      {/* Evaluation */}
      <Card title="✅ Autoevaluación">
        {!hasSummary ? (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
            Guarda primero tu resumen del artículo para poder acceder a la autoevaluación.
          </p>
        ) : (
          <div className="space-y-4">
            {evaluation && (
              <div className="p-4 bg-green-50 rounded-lg border border-green-200">
                <p className="text-base font-semibold text-green-800 mb-1">✓ Última evaluación</p>
                <p className="text-3xl font-bold text-green-600">{evaluation.score}/10</p>
                <p className="text-sm text-gray-600 mt-1">
                  {evaluation.passed ? '¡Aprobado! 🎉' : 'No aprobado'} · {evaluation.correct}/{evaluation.total} correctas
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  {new Date(evaluation.created_at).toLocaleDateString('es-ES')}
                </p>
              </div>
            )}
            <div className="flex gap-3 items-center flex-wrap">
              <Button onClick={handleStartEvaluation} loading={generatingEval} disabled={generatingEval}>
                {evaluation ? '🔄 Rehacer evaluación' : '🎯 Iniciar Evaluación'}
              </Button>
              {generatingEval && (
                <span className="text-sm text-indigo-600 animate-pulse">
                  {evaluation ? 'Cargando preguntas…' : 'La IA está preparando las preguntas… puede tardar unos segundos'}
                </span>
              )}
            </div>
            {!evaluation && (
              <p className="text-sm text-gray-500">
                La IA generará un test de comprensión basado en el título y abstract del artículo.
                Tendrás entre 5 y 10 preguntas tipo test con 4 opciones cada una.
              </p>
            )}
          </div>
        )}
      </Card>

      {/* Rating */}
      <Card title="⭐ Tu Valoración">
        {!hasEvaluation ? (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
            Completa primero la autoevaluación para poder valorar el artículo.
          </p>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Valoración (1-5 estrellas)</label>
              <div className="flex gap-2 items-center">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button key={star} onClick={() => setRating(rating === star ? 0 : star)} title={rating === star ? 'Quitar valoración' : `${star} estrella${star > 1 ? 's' : ''}`} className="text-3xl hover:scale-110 transition-transform">
                    {star <= rating ? '⭐' : '☆'}
                  </button>
                ))}
                {rating > 0 && (
                  <button onClick={() => setRating(0)} className="ml-1 text-xs text-gray-400 hover:text-red-500 underline underline-offset-2 transition-colors">
                    Quitar
                  </button>
                )}
              </div>
            </div>
            <Input label="Comentario (opcional)" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="¿Qué te pareció el artículo?" />
            <Button onClick={handleRateArticle} disabled={rating === 0}>Guardar Valoración</Button>
          </div>
        )}
      </Card>

      {/* Other ratings */}
      {ratings.length > 0 && (
        <Card title="💬 Valoraciones del Laboratorio">
          <div className="space-y-4">
            {ratings.map((r) => (
              <div key={r.id} className="border-b border-gray-200 pb-4 last:border-0">
                <div className="flex items-center gap-3 mb-2">
                  {r.user?.photo_url
                    ? <img src={r.user.photo_url} alt={r.user.name} className="w-10 h-10 rounded-full object-cover" />
                    : <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-sm font-bold text-prion-primary">{r.user?.name?.[0]?.toUpperCase() ?? '?'}</div>}
                  <div>
                    <p className="font-semibold text-gray-900">{r.user?.name}</p>
                    <p className="text-sm text-gray-600">{'⭐'.repeat(r.rating)} ({r.rating}/5)</p>
                  </div>
                </div>
                {r.comment && <p className="text-sm text-gray-700 pl-1">{r.comment}</p>}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Evaluation modal */}
      <Modal isOpen={showEvalModal} onClose={() => setShowEvalModal(false)} title="Autoevaluación" size="lg">
        {evalQuestions && (
          <div className="space-y-6">
            {evalQuestions.map((q, idx) => (
              <div key={idx} className="p-4 bg-gray-50 rounded-lg">
                <p className="font-semibold text-gray-900 mb-3">{idx + 1}. {q.question}</p>
                <div className="space-y-2">
                  {q.options.map((option, optIdx) => (
                    <label key={optIdx} className="flex items-center gap-3 p-2 hover:bg-white rounded cursor-pointer">
                      <input
                        type="radio"
                        name={`question-${idx}`}
                        checked={evalAnswers[idx] === optIdx}
                        onChange={() => {
                          const newAnswers = [...evalAnswers];
                          newAnswers[idx] = optIdx;
                          setEvalAnswers(newAnswers);
                        }}
                        className="w-4 h-4 text-prion-primary"
                      />
                      <span className="text-sm text-gray-700">{option}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <div className="flex gap-2 justify-end pt-4 border-t">
              <Button variant="ghost" onClick={() => setShowEvalModal(false)}>Cancelar</Button>
              <Button onClick={handleSubmitEvaluation} loading={submittingEval} disabled={evalAnswers.includes(null)}>
                Enviar Evaluación
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default ArticleDetail;
