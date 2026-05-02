const { UserArticle, Article, ArticleRating, ArticleSummary } = require('../models');
const { generateSummary: aiGenerateSummary } = require('../services/openai');

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
  if (articleJson) delete articleJson.ratings;

  return {
    assignment: {
      id: ua.id,
      status: ua.status,
      read_date: ua.read_date,
      summary_date: ua.summary_date,
      evaluation_date: ua.evaluation_date,
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
          include: [{ model: ArticleRating, as: 'ratings', attributes: ['rating'], required: false }],
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
          include: [{ model: ArticleRating, as: 'ratings', attributes: ['rating'], required: false }],
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

    // Advance status to 'summarized' if it hasn't reached that level yet
    if (statusRank(ua.status) < statusRank('summarized')) {
      await ua.update({ status: 'summarized', summary_date: new Date() });
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

module.exports = {
  getMyArticles,
  getMyArticleDetail,
  markAsRead,
  createOrUpdateSummary,
  getSummary,
  generateAISummary,
};
