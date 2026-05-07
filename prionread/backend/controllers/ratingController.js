const { Article, ArticleRating, User, UserArticle } = require('../models');

// ─── POST /api/articles/:articleId/rate ──────────────────────────────────────

async function createOrUpdateRating(req, res) {
  try {
    const { rating, comment } = req.body;

    // Validate rating
    const r = parseInt(rating, 10);
    if (!rating || Number.isNaN(r) || r < 1 || r > 5) {
      return res.status(400).json({ error: 'rating must be an integer between 1 and 5' });
    }

    // Validate comment length
    if (comment !== undefined && comment !== null) {
      if (typeof comment !== 'string' || comment.length > 500) {
        return res.status(400).json({ error: 'comment must be a string of at most 500 characters' });
      }
    }

    const article = await Article.findByPk(req.params.articleId, { attributes: ['id'] });
    if (!article) return res.status(404).json({ error: 'Article not found' });

    const [ratingRecord, created] = await ArticleRating.findOrCreate({
      where: { user_id: req.user.id, article_id: article.id },
      defaults: {
        rating: r,
        comment: comment?.trim() || null,
      },
    });

    if (!created) {
      await ratingRecord.update({
        rating: r,
        comment: comment !== undefined ? comment?.trim() || null : ratingRecord.comment,
      });
    }

    // Auto-mark the article as read once the student has completed all steps:
    // summary saved + evaluation done + this rating saved.
    const ua = await UserArticle.findOne({
      where: { user_id: req.user.id, article_id: article.id },
    });
    if (ua && ua.summary_date && ua.evaluation_date && ua.status !== 'read') {
      await ua.update({ status: 'read', read_date: new Date() });
      const { awardBonusCredit } = require('./bonusController');
      awardBonusCredit(req.user.id, article.id).catch((e) =>
        console.error('[bonus] awardBonusCredit failed:', e)
      );
    }

    return res.status(created ? 201 : 200).json({ rating: ratingRecord });
  } catch (err) {
    console.error('[createOrUpdateRating]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── GET /api/articles/:articleId/ratings ────────────────────────────────────

async function getRatings(req, res) {
  try {
    const article = await Article.findByPk(req.params.articleId, { attributes: ['id', 'title'] });
    if (!article) return res.status(404).json({ error: 'Article not found' });

    const ratings = await ArticleRating.findAll({
      where: { article_id: article.id },
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['id', 'name', 'photo_url'],
        },
      ],
      order: [['created_at', 'DESC']],
    });

    const avg_rating =
      ratings.length
        ? Math.round(
            (ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length) * 100
          ) / 100
        : null;

    return res.json({ ratings, avg_rating, total: ratings.length });
  } catch (err) {
    console.error('[getRatings]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── DELETE /api/articles/:articleId/rate ────────────────────────────────────

async function deleteRating(req, res) {
  try {
    const ratingRecord = await ArticleRating.findOne({
      where: { user_id: req.user.id, article_id: req.params.articleId },
    });

    if (!ratingRecord) {
      return res.status(404).json({ error: 'You have not rated this article' });
    }

    await ratingRecord.destroy();
    return res.json({ success: true });
  } catch (err) {
    console.error('[deleteRating]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { createOrUpdateRating, getRatings, deleteRating };
