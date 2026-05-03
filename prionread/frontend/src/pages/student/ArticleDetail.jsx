import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { studentService } from '../../services/student.service';
import { Card, Button, Input, Loader, Modal } from '../../components/common';

const ArticleDetail = () => {
  const { articleId } = useParams();
  const navigate = useNavigate();

  const [article, setArticle] = useState(null);
  const [summary, setSummary] = useState(null);
  const [evaluation, setEvaluation] = useState(null);
  const [ratings, setRatings] = useState([]);
  const [loading, setLoading] = useState(true);

  // Summary states
  const [summaryText, setSummaryText] = useState('');
  const [savingSummary, setSavingSummary] = useState(false);
  const [generatingAI, setGeneratingAI] = useState(false);

  // Evaluation states
  const [showEvalModal, setShowEvalModal] = useState(false);
  const [evalQuestions, setEvalQuestions] = useState(null);
  const [evalAnswers, setEvalAnswers] = useState([]);
  const [submittingEval, setSubmittingEval] = useState(false);

  // Rating states
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');

  useEffect(() => {
    loadArticleData();
  }, [articleId]);

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
      } catch {
        // No summary yet
      }

      try {
        const evalData = await studentService.getEvaluation(articleId);
        setEvaluation(evalData.evaluation);
      } catch {
        // No evaluation yet
      }
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
    } catch {
      // error handled silently; could add toast here
    } finally {
      setSavingSummary(false);
    }
  };

  const handleGenerateAISummary = async () => {
    setGeneratingAI(true);
    try {
      const data = await studentService.generateAISummary(articleId);
      setSummaryText(data.content ?? data.ai_summary ?? '');
    } catch {
      // error handled silently
    } finally {
      setGeneratingAI(false);
    }
  };

  const handleStartEvaluation = async () => {
    try {
      const data = await studentService.generateEvaluation(articleId);
      setEvalQuestions(data.questions);
      setEvalAnswers(new Array(data.questions.length).fill(null));
      setShowEvalModal(true);
    } catch {
      // error handled silently
    }
  };

  const handleSubmitEvaluation = async () => {
    if (evalAnswers.includes(null)) return;
    setSubmittingEval(true);
    try {
      await studentService.submitEvaluation(articleId, evalQuestions, evalAnswers);
      setShowEvalModal(false);
      loadArticleData();
    } catch {
      // error handled silently
    } finally {
      setSubmittingEval(false);
    }
  };

  const handleRateArticle = async () => {
    if (rating === 0) return;
    try {
      await studentService.rateArticle(articleId, rating, comment);
      loadArticleData();
      setRating(0);
      setComment('');
    } catch {
      // error handled silently
    }
  };

  if (loading) return <Loader fullScreen />;
  if (!article) return <div className="p-8 text-gray-500">Artículo no encontrado</div>;

  return (
    <div className="space-y-6">
      {/* Back button */}
      <Button variant="ghost" onClick={() => navigate(-1)}>
        ← Volver
      </Button>

      {/* Article Info */}
      <Card>
        <div className="flex items-start justify-between mb-4">
          <div className="flex-1">
            <h1 className="text-3xl font-bold text-gray-900 mb-4">
              {article.title}
            </h1>
            <p className="text-lg text-gray-700 mb-2">
              {Array.isArray(article.authors) ? article.authors.join(', ') : article.authors}
            </p>
            <div className="flex items-center gap-4 text-sm text-gray-600 flex-wrap">
              {article.journal && <span>{article.journal}</span>}
              {article.journal && article.year && <span>•</span>}
              {article.year && <span>{article.year}</span>}
              {article.doi && (
                <>
                  <span>•</span>
                  <a
                    href={`https://doi.org/${article.doi}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-prion-primary hover:underline"
                  >
                    DOI: {article.doi}
                  </a>
                </>
              )}
            </div>
          </div>
          {article.is_milestone && (
            <span className="shrink-0 px-4 py-2 bg-amber-100 text-amber-600 font-medium rounded ml-4">
              ⭐ Milestone
            </span>
          )}
        </div>

        {/* Tags */}
        {article.tags && article.tags.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            {article.tags.map((tag) => (
              <span key={tag} className="px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm">
                #{tag}
              </span>
            ))}
          </div>
        )}

        {/* Abstract */}
        {article.abstract && (
          <div className="mt-6 p-4 bg-gray-50 rounded-lg">
            <h3 className="font-semibold text-gray-900 mb-2">Abstract</h3>
            <p className="text-sm text-gray-700 leading-relaxed">{article.abstract}</p>
          </div>
        )}

        {/* Download PDF */}
        {article.dropbox_link && (
          <div className="mt-6">
            <a href={article.dropbox_link} target="_blank" rel="noopener noreferrer">
              <Button variant="primary">📥 Descargar PDF</Button>
            </a>
          </div>
        )}
      </Card>

      {/* Summary Section */}
      <Card title="📝 Tu Resumen">
        <textarea
          value={summaryText}
          onChange={(e) => setSummaryText(e.target.value)}
          placeholder="Escribe aquí tu resumen del artículo..."
          rows={8}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-prion-primary resize-y"
        />
        <div className="flex gap-2 mt-4 flex-wrap">
          <Button
            onClick={handleSaveSummary}
            loading={savingSummary}
            disabled={!summaryText.trim()}
          >
            💾 Guardar Resumen
          </Button>
          <Button
            variant="secondary"
            onClick={handleGenerateAISummary}
            loading={generatingAI}
          >
            ✨ Generar con IA
          </Button>
        </div>
        {summary?.is_ai_generated && (
          <p className="mt-2 text-xs text-gray-400">✨ Este resumen fue generado con IA</p>
        )}
      </Card>

      {/* Evaluation Section */}
      <Card title="✅ Autoevaluación">
        {evaluation ? (
          <div className="p-6 bg-green-50 rounded-lg border border-green-200">
            <p className="text-lg font-semibold text-green-800 mb-2">
              ✓ Evaluación completada
            </p>
            <p className="text-3xl font-bold text-green-600 mb-2">
              {evaluation.score}/10
            </p>
            <p className="text-sm text-gray-600">
              {evaluation.passed ? '¡Aprobado! 🎉' : 'No aprobado'}
            </p>
            <p className="text-xs text-gray-500 mt-2">
              Realizado el {new Date(evaluation.created_at).toLocaleDateString('es-ES')}
            </p>
          </div>
        ) : (
          <div>
            <p className="text-gray-600 mb-4">
              Realiza una autoevaluación de 5-10 preguntas tipo test para comprobar tu comprensión del artículo.
            </p>
            <Button onClick={handleStartEvaluation}>
              🎯 Iniciar Evaluación
            </Button>
          </div>
        )}
      </Card>

      {/* Rating Section */}
      <Card title="⭐ Tu Valoración">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Valoración (1-5 estrellas)
            </label>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  onClick={() => setRating(star)}
                  className="text-3xl hover:scale-110 transition-transform"
                >
                  {star <= rating ? '⭐' : '☆'}
                </button>
              ))}
            </div>
          </div>

          <Input
            label="Comentario (opcional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="¿Qué te pareció el artículo?"
          />

          <Button onClick={handleRateArticle} disabled={rating === 0}>
            Guardar Valoración
          </Button>
        </div>
      </Card>

      {/* Other Ratings */}
      {ratings.length > 0 && (
        <Card title="💬 Valoraciones del Laboratorio">
          <div className="space-y-4">
            {ratings.map((r) => (
              <div key={r.id} className="border-b border-gray-200 pb-4 last:border-0">
                <div className="flex items-center gap-3 mb-2">
                  {r.user?.photo_url ? (
                    <img
                      src={r.user.photo_url}
                      alt={r.user.name}
                      className="w-10 h-10 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-sm font-bold text-prion-primary">
                      {r.user?.name?.[0]?.toUpperCase() ?? '?'}
                    </div>
                  )}
                  <div>
                    <p className="font-semibold text-gray-900">{r.user?.name}</p>
                    <p className="text-sm text-gray-600">
                      {'⭐'.repeat(r.rating)} ({r.rating}/5)
                    </p>
                  </div>
                </div>
                {r.comment && (
                  <p className="text-sm text-gray-700 ml-13 pl-1">{r.comment}</p>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Evaluation Modal */}
      <Modal
        isOpen={showEvalModal}
        onClose={() => setShowEvalModal(false)}
        title="Autoevaluación"
        size="lg"
      >
        {evalQuestions && (
          <div className="space-y-6">
            {evalQuestions.map((q, idx) => (
              <div key={idx} className="p-4 bg-gray-50 rounded-lg">
                <p className="font-semibold text-gray-900 mb-3">
                  {idx + 1}. {q.question}
                </p>
                <div className="space-y-2">
                  {q.options.map((option, optIdx) => (
                    <label
                      key={optIdx}
                      className="flex items-center gap-3 p-2 hover:bg-white rounded cursor-pointer"
                    >
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
              <Button variant="ghost" onClick={() => setShowEvalModal(false)}>
                Cancelar
              </Button>
              <Button
                onClick={handleSubmitEvaluation}
                loading={submittingEval}
                disabled={evalAnswers.includes(null)}
              >
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
