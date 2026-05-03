const { Op } = require('sequelize');
const { sequelize, Article, UserArticle, User, Evaluation, ArticleRating } = require('../models');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds an optional SQL WHERE clause and replacements array from query filters.
 * Returns { articleFilter, replacements } where articleFilter is a SQL snippet
 * that can be appended to queries on the `articles` table (aliased `a`).
 */
function buildArticleFilter(query) {
  const conditions = [];
  const replacements = [];

  if (query.year) {
    const y = parseInt(query.year, 10);
    if (!Number.isNaN(y)) {
      conditions.push(`a.year = ?`);
      replacements.push(y);
    }
  }

  if (query.tag) {
    conditions.push(`? = ANY(a.tags)`);
    replacements.push(query.tag.trim());
  }

  const articleFilter = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { articleFilter, replacements };
}

// ─── GET /api/admin/articles/analytics ───────────────────────────────────────

async function getArticlesAnalytics(req, res) {
  try {
    const { articleFilter, replacements } = buildArticleFilter(req.query);

    const [
      totals,
      byYear,
      byTag,
      completionByMilestone,
      ratingsByMilestone,
      unassigned,
      underperforming,
    ] = await Promise.all([

      // Total articles + milestones
      sequelize.query(
        `SELECT
           COUNT(*)::int                             AS total,
           COUNT(*) FILTER (WHERE is_milestone)::int AS milestones
         FROM articles a ${articleFilter}`,
        { replacements, type: sequelize.QueryTypes.SELECT }
      ),

      // Articles by year
      sequelize.query(
        `SELECT a.year, COUNT(*)::int AS count
         FROM articles a ${articleFilter}
         GROUP BY a.year
         ORDER BY a.year DESC`,
        { replacements, type: sequelize.QueryTypes.SELECT }
      ),

      // Articles by tag (PostgreSQL array unnest)
      sequelize.query(
        `SELECT tag, COUNT(*)::int AS count
         FROM articles a
         CROSS JOIN LATERAL UNNEST(a.tags) AS tag
         ${articleFilter ? articleFilter.replace(/\ba\./g, 'a.') : ''}
         GROUP BY tag
         ORDER BY count DESC
         LIMIT 30`,
        { replacements, type: sequelize.QueryTypes.SELECT }
      ),

      // Completion rates split by is_milestone
      sequelize.query(
        `SELECT
           a.is_milestone,
           COUNT(ua.id)::int                                                         AS total_assigned,
           COUNT(ua.id) FILTER (WHERE ua.status IN ('read','summarized','evaluated'))::int
                                                                                     AS total_read
         FROM articles a ${articleFilter}
         LEFT JOIN user_articles ua ON ua.article_id = a.id
         GROUP BY a.is_milestone`,
        { replacements, type: sequelize.QueryTypes.SELECT }
      ),

      // Avg ratings split by is_milestone
      sequelize.query(
        `SELECT
           a.is_milestone,
           ROUND(AVG(ar.rating)::numeric, 2) AS avg_rating
         FROM articles a ${articleFilter}
         LEFT JOIN article_ratings ar ON ar.article_id = a.id
         GROUP BY a.is_milestone`,
        { replacements, type: sequelize.QueryTypes.SELECT }
      ),

      // Articles with zero assignments
      sequelize.query(
        `SELECT a.id, a.title, a.authors, a.year, a.is_milestone, a.priority
         FROM articles a ${articleFilter}
         WHERE a.id NOT IN (SELECT DISTINCT article_id FROM user_articles)
         ORDER BY a.is_milestone DESC, a.priority DESC`,
        { replacements, type: sequelize.QueryTypes.SELECT }
      ),

      // Underperforming: low completion rate or poor ratings (assigned articles only)
      sequelize.query(
        `SELECT
           a.id,
           a.title,
           COUNT(ua.id)::int                                                         AS times_assigned,
           COUNT(ua.id) FILTER (WHERE ua.status IN ('read','summarized','evaluated'))::int
                                                                                     AS times_read,
           ROUND(
             CASE WHEN COUNT(ua.id) > 0
               THEN COUNT(ua.id) FILTER (WHERE ua.status IN ('read','summarized','evaluated'))::numeric
                    / COUNT(ua.id)
               ELSE 0
             END, 2
           )                                                                          AS completion_rate,
           ROUND(AVG(ar.rating)::numeric, 2)                                         AS avg_rating
         FROM articles a ${articleFilter}
         LEFT JOIN user_articles ua ON ua.article_id = a.id
         LEFT JOIN article_ratings ar ON ar.article_id = a.id
         GROUP BY a.id, a.title
         HAVING COUNT(ua.id) > 0   -- skip unassigned (already in unassigned_articles)
           AND (
             CASE WHEN COUNT(ua.id) > 0
               THEN COUNT(ua.id) FILTER (WHERE ua.status IN ('read','summarized','evaluated'))::numeric
                    / COUNT(ua.id)
               ELSE 0
             END < 0.3
             OR AVG(ar.rating) < 3.0
           )
         ORDER BY completion_rate ASC, avg_rating ASC NULLS LAST
         LIMIT 10`,
        { replacements, type: sequelize.QueryTypes.SELECT }
      ),
    ]);

    // ── Build completion_rates ─────────────────────────────────────────────────
    const compMap = Object.fromEntries(
      completionByMilestone.map((r) => [String(r.is_milestone), r])
    );
    const totalAssigned = completionByMilestone.reduce((s, r) => s + r.total_assigned, 0);
    const totalRead = completionByMilestone.reduce((s, r) => s + r.total_read, 0);

    const completion_rates = {
      overall: totalAssigned > 0 ? Math.round((totalRead / totalAssigned) * 100) / 100 : 0,
      milestones: (() => {
        const r = compMap['true'];
        return r && r.total_assigned > 0 ? Math.round((r.total_read / r.total_assigned) * 100) / 100 : 0;
      })(),
      regular: (() => {
        const r = compMap['false'];
        return r && r.total_assigned > 0 ? Math.round((r.total_read / r.total_assigned) * 100) / 100 : 0;
      })(),
    };

    // ── Build avg_ratings ──────────────────────────────────────────────────────
    const ratingMap = Object.fromEntries(
      ratingsByMilestone.map((r) => [String(r.is_milestone), parseFloat(r.avg_rating || 0)])
    );
    const allRatings = ratingsByMilestone.filter((r) => r.avg_rating);
    const overallRating = allRatings.length
      ? Math.round(
          (allRatings.reduce((s, r) => s + parseFloat(r.avg_rating), 0) / allRatings.length) * 100
        ) / 100
      : null;

    const avg_ratings = {
      overall: overallRating,
      milestones: ratingMap['true'] || null,
      regular: ratingMap['false'] || null,
    };

    return res.json({
      total_articles: totals[0].total,
      total_milestones: totals[0].milestones,
      articles_by_year: byYear,
      articles_by_tag: byTag,
      completion_rates,
      avg_ratings,
      unassigned_articles: unassigned,
      underperforming_articles: underperforming.map((r) => ({
        ...r,
        completion_rate: parseFloat(r.completion_rate),
        avg_rating: r.avg_rating ? parseFloat(r.avg_rating) : null,
      })),
    });
  } catch (err) {
    console.error('[getArticlesAnalytics]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── GET /api/admin/articles/:articleId/engagement ───────────────────────────

async function getArticleEngagement(req, res) {
  try {
    const { articleId } = req.params;

    const article = await Article.findByPk(articleId, {
      attributes: ['id', 'title', 'authors', 'year', 'is_milestone', 'priority', 'tags'],
    });
    if (!article) return res.status(404).json({ error: 'Article not found' });

    // Fetch all user assignments + their best evaluation score
    const [userArticles, ratings, timeToRead, evalAvg, ratingsDistrib] = await Promise.all([

      UserArticle.findAll({
        where: { article_id: articleId },
        attributes: ['id', 'user_id', 'status', 'read_date', 'created_at'],
        include: [
          { model: User, as: 'user', attributes: ['id', 'name', 'photo_url'] },
          {
            model: Evaluation,
            as: 'evaluations',
            attributes: ['score', 'created_at'],
            required: false,
          },
        ],
        order: [['created_at', 'DESC']],
      }),

      // Ratings keyed by user_id for the O(1) merge below
      ArticleRating.findAll({
        where: { article_id: articleId },
        attributes: ['user_id', 'rating', 'comment'],
      }),

      // Avg days from assignment to first read
      sequelize.query(
        `SELECT ROUND(
           AVG(
             EXTRACT(EPOCH FROM (read_date::timestamp - created_at)) / 86400
           )::numeric, 1
         ) AS avg_days
         FROM user_articles
         WHERE article_id = :articleId AND read_date IS NOT NULL`,
        { replacements: { articleId }, type: sequelize.QueryTypes.SELECT }
      ),

      // Overall avg evaluation score for this article
      sequelize.query(
        `SELECT ROUND(AVG(e.score)::numeric, 2) AS avg_score
         FROM evaluations e
         JOIN user_articles ua ON ua.id = e.user_article_id
         WHERE ua.article_id = :articleId AND e.score IS NOT NULL`,
        { replacements: { articleId }, type: sequelize.QueryTypes.SELECT }
      ),

      // Ratings distribution 1–5
      sequelize.query(
        `SELECT rating::int, COUNT(*)::int AS count
         FROM article_ratings
         WHERE article_id = :articleId
         GROUP BY rating
         ORDER BY rating DESC`,
        { replacements: { articleId }, type: sequelize.QueryTypes.SELECT }
      ),
    ]);

    // Index ratings by user_id
    const ratingByUser = Object.fromEntries(ratings.map((r) => [r.user_id, r]));

    // Build assignment stats
    const statusCounts = { read: 0, summarized: 0, evaluated: 0, pending: 0 };
    for (const ua of userArticles) statusCounts[ua.status] = (statusCounts[ua.status] || 0) + 1;
    const totalAssigned = userArticles.length;
    const totalRead = statusCounts.read + statusCounts.summarized + statusCounts.evaluated;

    // Build ratings_distribution with zero-fill for 1–5
    const distribMap = Object.fromEntries(ratingsDistrib.map((r) => [r.rating, r.count]));
    const ratings_distribution = Object.fromEntries(
      [5, 4, 3, 2, 1].map((n) => [n, distribMap[n] || 0])
    );

    // Build user_engagement
    const user_engagement = userArticles.map((ua) => {
      const bestEval = (ua.evaluations || [])
        .filter((e) => e.score != null)
        .sort((a, b) => b.score - a.score)[0];
      const userRating = ratingByUser[ua.user_id];

      return {
        user: ua.user,
        status: ua.status,
        read_date: ua.read_date,
        evaluation_score: bestEval ? parseFloat(bestEval.score) : null,
        rating: userRating?.rating || null,
        comment: userRating?.comment || null,
      };
    });

    return res.json({
      article,
      assignment_stats: {
        total_assigned: totalAssigned,
        total_read: totalRead,
        total_evaluated: statusCounts.evaluated,
        completion_rate: totalAssigned > 0 ? Math.round((totalRead / totalAssigned) * 100) / 100 : 0,
      },
      user_engagement,
      ratings_distribution,
      avg_time_to_read_days: timeToRead[0]?.avg_days ? parseFloat(timeToRead[0].avg_days) : null,
      avg_evaluation_score: evalAvg[0]?.avg_score ? parseFloat(evalAvg[0].avg_score) : null,
    });
  } catch (err) {
    console.error('[getArticleEngagement]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── POST /api/admin/articles/:articleId/assign-to-all ───────────────────────

async function assignArticleToAll(req, res) {
  try {
    const { articleId } = req.params;

    const article = await Article.findByPk(articleId, { attributes: ['id'] });
    if (!article) return res.status(404).json({ error: 'Article not found' });

    // All students
    const students = await User.findAll({
      where: { role: 'student' },
      attributes: ['id'],
    });
    const studentIds = students.map((u) => u.id);

    if (!studentIds.length) return res.json({ assigned_to: 0 });

    // Already assigned
    const existing = await UserArticle.findAll({
      where: { article_id: articleId, user_id: { [Op.in]: studentIds } },
      attributes: ['user_id'],
    });
    const assignedSet = new Set(existing.map((ua) => ua.user_id));

    const toCreate = studentIds
      .filter((uid) => !assignedSet.has(uid))
      .map((uid) => ({ user_id: uid, article_id: articleId, status: 'pending' }));

    if (toCreate.length) await UserArticle.bulkCreate(toCreate);

    return res.status(201).json({ assigned_to: toCreate.length, already_assigned: assignedSet.size });
  } catch (err) {
    console.error('[assignArticleToAll]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { getArticlesAnalytics, getArticleEngagement, assignArticleToAll };
