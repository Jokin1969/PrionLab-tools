const { UserArticle, Article, ArticleRating, ArticleSummary, Evaluation } = require('../models');
const { generateSummary: aiGenerateSummary, generateEvaluation: aiGenerateEvaluation } = require('../services/openai');

const ARTICLE_SORT_FIELDS = new Set(['priority', 'year', 'title', 'created_at']);
const VALID_STATUSES = new Set(['pending', 'read', 'summarized', 'evaluated']);

// Status progression order — a status can only advance, never regress
const STATUS_ORDER = ['pending', 'read', 'summarized', 'evaluated'];

function statusRank(s) {
  return STATUS_ORDER.indexOf(s);
}

const AI_HTTP_STATUS = {
  NOT_CONFIGURED: 503,
  INVALID_KEY: 503,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  EMPTY_RESPONSE: 502,
};

// ─── Shared helpers ───────────────────────────────────────────────────────────

function avgRating(ratings = []) {
  if (!ratings.length) return null;
  return Math.round((ratings.reduce((s, r) => s + r.rating, 0) / ratings.length) * 100) / 100;
}

function formatUserArticle(ua) {
  const ratingsArr = ua.article?.ratings || [];
  const articleJson = ua.article ? ua.article.toJSON() : null;
  const hasUserRating = ratingsArr.some((r) => r.user_id === ua.user_id);
  if (articleJson) delete articleJson.ratings;

  return {
    assignment: {
      id: ua.id,
      status: ua.status,
      read_date: ua.read_date,
      summary_date: ua.summary_date,
      evaluation_date: ua.evaluation_date,
      has_user_rating: hasUserRating,
      updated_at: ua.updated_at,
    },
    article: articleJson ? { ...articleJson, avg_rating: avgRating(ratingsArr) } : null,
  };
}

function buildStudentOrder(sortBy, order) {
  const dir = order?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  const field = ARTICLE_SORT_FIELDS.has(sortBy) ? sortBy : 'priority';
  if (field === 'priority' || field === 'year' || field === 'title') {
    return [[{ model: Article, as: 'article' }, field, dir]];
  }
  return [['created_at', dir]];
}

/**
 * Finds the UserArticle for the authenticated user + given articleId.
 * Returns null if not found or not assigned to this user.
 */
async function findUserArticle(userId, articleId, includeArticle = false) {
  const options = {
    where: { user_id: userId, article_id: articleId },
  };
  if (includeArticle) {
    options.include = [{ model: Article, as: 'article' }];
  }
  return UserArticle.findOne(options);
}

// ─── GET /api/my-articles ─────────────────────────────────────────────────────

async function getMyArticles(req, res) {
  try {
    const where = { user_id: req.user.id };

    if (req.query.status) {
      if (!VALID_STATUSES.has(req.query.status)) {
        return res.status(400).json({ error: `status must be one of: ${[...VALID_STATUSES].join(', ')}` });
      }
      where.status = req.query.status;
    }

    const order = buildStudentOrder(req.query.sort_by, req.query.order);

    const userArticles = await UserArticle.findAll({
      where,
      include: [
        {
          model: Article,
          as: 'article',
          include: [{ model: ArticleRating, as: 'ratings', attributes: ['rating', 'user_id'], required: false }],
        },
      ],
      order,
    });

    return res.json({ articles: userArticles.map(formatUserArticle) });
  } catch (err) {
    console.error('[getMyArticles]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── GET /api/my-articles/:articleId ─────────────────────────────────────────

async function getMyArticleDetail(req, res) {
  try {
    const ua = await UserArticle.findOne({
      where: { user_id: req.user.id, article_id: req.params.articleId },
      include: [
        {
          model: Article,
          as: 'article',
          include: [{ model: ArticleRating, as: 'ratings', attributes: ['rating', 'user_id'], required: false }],
        },
      ],
    });

    if (!ua) return res.status(404).json({ error: 'Article not assigned to you' });
    return res.json(formatUserArticle(ua));
  } catch (err) {
    console.error('[getMyArticleDetail]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── PUT /api/my-articles/:articleId/mark-as-read ────────────────────────────

async function markAsRead(req, res) {
  try {
    const ua = await findUserArticle(req.user.id, req.params.articleId);
    if (!ua) return res.status(404).json({ error: 'Article not assigned to you' });

    if (ua.status !== 'pending') {
      return res.json({ updated: false, current_status: ua.status });
    }

    await ua.update({ status: 'read', read_date: new Date() });
    return res.json({ updated: true, current_status: 'read' });
  } catch (err) {
    console.error('[markAsRead]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── PUT /api/my-articles/:articleId/unmark-as-read ──────────────────────────

async function unmarkAsRead(req, res) {
  try {
    const ua = await findUserArticle(req.user.id, req.params.articleId);
    if (!ua) return res.status(404).json({ error: 'Article not assigned to you' });
    // Delete all progress data for this assignment
    await Promise.all([
      ArticleRating.destroy({ where: { user_id: req.user.id, article_id: req.params.articleId } }),
      Evaluation.destroy({ where: { user_article_id: ua.id } }),
      ArticleSummary.destroy({ where: { user_article_id: ua.id } }),
    ]);
    await ua.update({ status: 'pending', read_date: null, summary_date: null, evaluation_date: null });
    return res.json({ updated: true, current_status: 'pending' });
  } catch (err) {
    console.error('[unmarkAsRead]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── POST /api/my-articles/:articleId/summary ────────────────────────────────

async function createOrUpdateSummary(req, res) {
  try {
    const { content, is_ai_generated = false } = req.body;

    if (!content || typeof content !== 'string' || content.trim().length < 50) {
      return res.status(400).json({ error: 'Summary content must be at least 50 characters' });
    }

    const ua = await findUserArticle(req.user.id, req.params.articleId);
    if (!ua) return res.status(404).json({ error: 'Article not assigned to you' });

    // Upsert: one summary per user-article pair
    const [summary] = await ArticleSummary.findOrCreate({
      where: { user_article_id: ua.id },
      defaults: {
        content: content.trim(),
        is_ai_generated: Boolean(is_ai_generated),
      },
    });

    // If it already existed, update it
    if (summary.content !== content.trim()) {
      await summary.update({
        content: content.trim(),
        is_ai_generated: Boolean(is_ai_generated),
      });
    }

    // Record when the summary was first saved (don't change status — that happens on rating)
    if (!ua.summary_date) {
      await ua.update({ summary_date: new Date() });
    }

    return res.status(201).json({ summary });
  } catch (err) {
    console.error('[createOrUpdateSummary]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── GET /api/my-articles/:articleId/summary ─────────────────────────────────

async function getSummary(req, res) {
  try {
    const ua = await findUserArticle(req.user.id, req.params.articleId);
    if (!ua) return res.status(404).json({ error: 'Article not assigned to you' });

    const summary = await ArticleSummary.findOne({
      where: { user_article_id: ua.id },
    });

    if (!summary) return res.status(404).json({ error: 'No summary found for this article' });

    return res.json({ summary });
  } catch (err) {
    console.error('[getSummary]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── POST /api/my-articles/:articleId/generate-ai-summary ────────────────────

async function generateAISummary(req, res) {
  try {
    const ua = await findUserArticle(req.user.id, req.params.articleId, true);
    if (!ua) return res.status(404).json({ error: 'Article not assigned to you' });

    const article = ua.article;
    if (!article) return res.status(404).json({ error: 'Article data not found' });

    if (!article.abstract && !article.title) {
      return res.status(422).json({
        error: 'Article has insufficient data for AI summary (no title or abstract)',
      });
    }

    let ai_summary;
    try {
      ai_summary = await aiGenerateSummary({
        title: article.title,
        authors: article.authors,
        year: article.year,
        journal: article.journal,
        abstract: article.abstract,
      });
    } catch (err) {
      const status = AI_HTTP_STATUS[err.code] || 500;
      return res.status(status).json({ error: err.message });
    }

    // Return without saving — the student decides whether to keep it
    return res.json({ ai_summary });
  } catch (err) {
    console.error('[generateAISummary]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── POST /api/my-articles/:articleId/generate-evaluation ────────────────────

async function generateEvaluation(req, res) {
  try {
    const ua = await findUserArticle(req.user.id, req.params.articleId, true);
    if (!ua) return res.status(404).json({ error: 'Article not assigned to you' });

    const article = ua.article;
    if (!article) return res.status(404).json({ error: 'Article data not found' });

    // If an evaluation already exists, reuse its questions so the student sees
    // the same test and can review / improve their answers.
    const existing = await Evaluation.findOne({
      where: { user_article_id: ua.id },
      order: [['created_at', 'DESC']],
    });

    if (existing) {
      const questionsForClient = existing.questions.map(({ question, options }) => ({ question, options }));
      return res.json({ questions: questionsForClient, previous_answers: existing.answers });
    }

    if (!article.abstract && !article.title) {
      return res.status(422).json({ error: 'Article has insufficient data for evaluation generation' });
    }

    let questions;
    try {
      questions = await aiGenerateEvaluation({
        title: article.title,
        authors: article.authors,
        year: article.year,
        journal: article.journal,
        abstract: article.abstract,
      });
    } catch (err) {
      const status = AI_HTTP_STATUS[err.code] || 500;
      return res.status(status).json({ error: err.message });
    }

    // Persist questions (with correct answers) — never expose `correct` to client
    await Evaluation.create({ user_article_id: ua.id, questions, answers: [] });

    const questionsForClient = questions.map(({ question, options }) => ({ question, options }));
    return res.json({ questions: questionsForClient, previous_answers: [] });
  } catch (err) {
    console.error('[generateEvaluation]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── POST /api/my-articles/:articleId/submit-evaluation ──────────────────────

async function submitEvaluation(req, res) {
  try {
    const { answers } = req.body;

    if (!Array.isArray(answers)) {
      return res.status(400).json({ error: 'answers must be an array' });
    }

    const ua = await findUserArticle(req.user.id, req.params.articleId);
    if (!ua) return res.status(404).json({ error: 'Article not assigned to you' });

    const evaluation = await Evaluation.findOne({
      where: { user_article_id: ua.id },
      order: [['created_at', 'DESC']],
    });

    if (!evaluation) {
      return res.status(404).json({ error: 'No evaluation generated yet' });
    }

    const questions = evaluation.questions;
    if (answers.length !== questions.length) {
      return res.status(400).json({ error: `Expected ${questions.length} answers, received ${answers.length}` });
    }

    const correctCount = answers.filter((ans, i) => ans === questions[i].correct).length;
    const score = Math.round((correctCount / questions.length) * 10 * 100) / 100;
    const passed = score >= 5;

    await evaluation.update({ answers, score, passed });

    // Record when evaluation was first completed (don't change status — that happens on rating)
    if (!ua.evaluation_date) {
      await ua.update({ evaluation_date: new Date() });
    }

    return res.json({ score, passed, correct: correctCount, total: questions.length });
  } catch (err) {
    console.error('[submitEvaluation]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── GET /api/my-articles/:articleId/evaluation ──────────────────────────────

async function getEvaluation(req, res) {
  try {
    const ua = await findUserArticle(req.user.id, req.params.articleId);
    if (!ua) return res.status(404).json({ error: 'Article not assigned to you' });

    const evaluation = await Evaluation.findOne({
      where: { user_article_id: ua.id },
      order: [['created_at', 'DESC']],
    });

    if (!evaluation || evaluation.score == null) {
      return res.status(404).json({ error: 'No submitted evaluation found' });
    }

    const correctCount = evaluation.answers.filter(
      (ans, i) => ans === evaluation.questions[i].correct
    ).length;

    return res.json({
      evaluation: {
        id: evaluation.id,
        score: evaluation.score,
        passed: evaluation.passed,
        correct: correctCount,
        total: evaluation.questions.length,
        created_at: evaluation.createdAt,
      },
    });
  } catch (err) {
    console.error('[getEvaluation]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  getMyArticles,
  getMyArticleDetail,
  markAsRead,
  unmarkAsRead,
  createOrUpdateSummary,
  getSummary,
  generateAISummary,
  generateEvaluation,
  submitEvaluation,
  getEvaluation,
};
