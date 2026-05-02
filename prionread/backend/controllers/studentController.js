const { UserArticle, Article, ArticleRating } = require('../models');

const ARTICLE_SORT_FIELDS = new Set(['priority', 'year', 'title', 'created_at']);
const VALID_STATUSES = new Set(['pending', 'read', 'summarized', 'evaluated']);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Computes avg_rating from a nested ratings array and returns a clean article object.
 */
function formatUserArticle(ua) {
  const ratingsArr = ua.article?.ratings || [];
  const avg_rating =
    ratingsArr.length
      ? Math.round((ratingsArr.reduce((s, r) => s + r.rating, 0) / ratingsArr.length) * 100) / 100
      : null;

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
    article: articleJson
      ? { ...articleJson, avg_rating }
      : null,
  };
}

function buildStudentOrder(sortBy, order) {
  const dir = order?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  const field = ARTICLE_SORT_FIELDS.has(sortBy) ? sortBy : 'priority';

  // Fields on the Article association need a model reference
  if (field === 'priority' || field === 'year' || field === 'title') {
    return [[{ model: Article, as: 'article' }, field, dir]];
  }
  // created_at lives on UserArticle
  return [['created_at', dir]];
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

// ─── PUT /api/my-articles/:articleId/mark-as-read ────────────────────────────

async function markAsRead(req, res) {
  try {
    const ua = await UserArticle.findOne({
      where: { user_id: req.user.id, article_id: req.params.articleId },
    });

    if (!ua) {
      return res.status(404).json({ error: 'Article not assigned to you' });
    }

    // Only advance from 'pending'; never downgrade a further status
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

module.exports = { getMyArticles, markAsRead, getMyArticleDetail };
