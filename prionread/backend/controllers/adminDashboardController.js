const { Op } = require('sequelize');
const NodeCache = require('node-cache');
const { sequelize, UserArticle, User, Article, Evaluation } = require('../models');

const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL
const CACHE_KEY = 'admin_dashboard';

// ─── Individual stat fetchers ─────────────────────────────────────────────────

async function computeGlobalStats() {
  const [userRoles, articleCounts, readCount, completionData, evalData] = await Promise.all([
    sequelize.query(
      `SELECT role, COUNT(*)::int AS count FROM users GROUP BY role`,
      { type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT
         COUNT(*)::int                                    AS total,
         COUNT(*) FILTER (WHERE is_milestone)::int        AS milestones
       FROM articles`,
      { type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT COUNT(*)::int AS count
       FROM user_articles
       WHERE status IN ('read','summarized','evaluated')`,
      { type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT ROUND(
         AVG(
           CASE WHEN total > 0
             THEN read_count::numeric / total
             ELSE 0
           END
         )::numeric, 4
       ) AS avg_completion
       FROM (
         SELECT
           user_id,
           COUNT(*)                                                    AS total,
           COUNT(*) FILTER (WHERE status IN ('read','summarized','evaluated')) AS read_count
         FROM user_articles
         GROUP BY user_id
       ) sub`,
      { type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT ROUND(AVG(score)::numeric, 2) AS avg_score
       FROM evaluations
       WHERE score IS NOT NULL`,
      { type: sequelize.QueryTypes.SELECT }
    ),
  ]);

  const byRole = Object.fromEntries(userRoles.map((r) => [r.role, r.count]));
  const art = articleCounts[0];

  return {
    total_users: Object.values(byRole).reduce((s, n) => s + n, 0),
    total_students: byRole.student || 0,
    total_admins: byRole.admin || 0,
    total_articles: art.total,
    total_milestones: art.milestones,
    total_reads: readCount[0].count,
    avg_completion_rate: parseFloat(completionData[0].avg_completion || 0),
    avg_evaluation_score: parseFloat(evalData[0].avg_score || 0),
  };
}

async function computeTopPerformers() {
  const rows = await sequelize.query(
    `SELECT
       u.id            AS user_id,
       u.name,
       u.photo_url,
       COUNT(ua.id) FILTER (WHERE ua.status IN ('read','summarized','evaluated'))::int
                       AS articles_read,
       COUNT(ua.id)::int
                       AS total_assigned,
       ROUND(AVG(e.score)::numeric, 2)
                       AS avg_score,
       ROUND(
         CASE WHEN COUNT(ua.id) > 0
           THEN COUNT(ua.id) FILTER (WHERE ua.status IN ('read','summarized','evaluated'))::numeric
                / COUNT(ua.id)
           ELSE 0
         END, 2
       )               AS completion_rate
     FROM users u
     LEFT JOIN user_articles ua ON ua.user_id = u.id
     LEFT JOIN evaluations e
       ON e.user_article_id = ua.id AND e.score IS NOT NULL
     WHERE u.role = 'student'
     GROUP BY u.id, u.name, u.photo_url
     ORDER BY articles_read DESC, avg_score DESC NULLS LAST
     LIMIT 5`,
    { type: sequelize.QueryTypes.SELECT }
  );

  return rows.map((r) => ({
    user_id: r.user_id,
    name: r.name,
    photo_url: r.photo_url,
    articles_read: r.articles_read,
    total_assigned: r.total_assigned,
    avg_score: r.avg_score ? parseFloat(r.avg_score) : null,
    completion_rate: parseFloat(r.completion_rate),
  }));
}

async function computeRecentActivityGlobal() {
  // Fetch recent UserArticles that have at least one activity date
  const rows = await UserArticle.findAll({
    where: {
      [Op.or]: [
        { read_date: { [Op.ne]: null } },
        { summary_date: { [Op.ne]: null } },
        { evaluation_date: { [Op.ne]: null } },
      ],
    },
    attributes: ['id', 'read_date', 'summary_date', 'evaluation_date', 'updated_at'],
    include: [
      { model: User, as: 'user', attributes: ['name', 'photo_url'] },
      { model: Article, as: 'article', attributes: ['id', 'title'] },
      {
        model: Evaluation,
        as: 'evaluations',
        attributes: ['score', 'created_at'],
        required: false,
      },
    ],
    order: [['updated_at', 'DESC']],
    limit: 80, // Overfetch to compensate for fan-out when flattening
  });

  const events = [];
  for (const ua of rows) {
    const base = {
      user_name: ua.user?.name || 'Unknown',
      user_photo: ua.user?.photo_url || null,
      article_id: ua.article?.id || null,
      article_title: ua.article?.title || 'Unknown article',
    };

    if (ua.read_date) {
      events.push({ ...base, action: 'read', score: null, date: ua.read_date });
    }
    if (ua.summary_date) {
      events.push({ ...base, action: 'summarized', score: null, date: ua.summary_date });
    }
    if (ua.evaluation_date) {
      const best = (ua.evaluations || [])
        .filter((e) => e.score != null)
        .sort((a, b) => b.score - a.score)[0];
      events.push({
        ...base,
        action: 'evaluated',
        score: best ? parseFloat(best.score) : null,
        date: ua.evaluation_date,
      });
    }
  }

  return events
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 20);
}

async function computeArticleReadStats() {
  const rows = await sequelize.query(
    `SELECT
       a.id                                                           AS article_id,
       a.title,
       COUNT(DISTINCT ua.id) FILTER (WHERE ua.status IN ('read','summarized','evaluated'))::int
                                                                      AS times_read,
       ROUND(AVG(ar.rating)::numeric, 2)                             AS avg_rating
     FROM articles a
     LEFT JOIN user_articles ua ON ua.article_id = a.id
     LEFT JOIN article_ratings ar ON ar.article_id = a.id
     GROUP BY a.id, a.title`,
    { type: sequelize.QueryTypes.SELECT }
  );

  const formatted = rows.map((r) => ({
    article_id: r.article_id,
    title: r.title,
    times_read: r.times_read,
    avg_rating: r.avg_rating ? parseFloat(r.avg_rating) : null,
  }));

  // Sort twice: most-read and least-read from the same dataset
  const byReads = [...formatted].sort((a, b) => b.times_read - a.times_read);
  return {
    most: byReads.filter((a) => a.times_read > 0).slice(0, 10),
    least: byReads.slice(-10).reverse(),
  };
}

async function computeMonthlyProgress() {
  const rows = await sequelize.query(
    `WITH months AS (
       SELECT generate_series(
         DATE_TRUNC('month', NOW() - INTERVAL '11 months'),
         DATE_TRUNC('month', NOW()),
         '1 month'
       )::date AS month
     ),
     reads AS (
       SELECT DATE_TRUNC('month',
                COALESCE(read_date, evaluation_date, summary_date, updated_at)
              )::date AS month,
              COUNT(*)::int AS cnt
       FROM user_articles
       WHERE status IN ('read','summarized','evaluated')
       GROUP BY 1
     ),
     evals AS (
       SELECT
         DATE_TRUNC('month',
           COALESCE(ua.evaluation_date, ua.updated_at)
         )::date AS month,
         COUNT(*)::int                                  AS cnt,
         ROUND(AVG(e.score)::numeric, 2)               AS avg_score
       FROM user_articles ua
       LEFT JOIN evaluations e
         ON e.user_article_id = ua.id AND e.score IS NOT NULL
       WHERE ua.status = 'evaluated'
       GROUP BY 1
     )
     SELECT
       TO_CHAR(m.month, 'YYYY-MM') AS month,
       COALESCE(r.cnt,   0)        AS total_reads,
       COALESCE(ev.cnt,  0)        AS total_evaluations,
       ev.avg_score
     FROM months m
     LEFT JOIN reads r  ON r.month  = m.month
     LEFT JOIN evals ev ON ev.month = m.month
     ORDER BY m.month ASC`,
    { type: sequelize.QueryTypes.SELECT }
  );

  return rows.map((r) => ({
    month: r.month,
    total_reads: r.total_reads,
    total_evaluations: r.total_evaluations,
    avg_score: r.avg_score ? parseFloat(r.avg_score) : null,
  }));
}

// ─── GET /api/admin/dashboard ─────────────────────────────────────────────────

async function getGlobalDashboard(req, res) {
  try {
    const forceRefresh = req.query.refresh === 'true';

    if (!forceRefresh) {
      const cached = cache.get(CACHE_KEY);
      if (cached) return res.json({ ...cached, _cached: true });
    }

    const [globalStats, topPerformers, recentActivity, articleStats, monthlyProgress] =
      await Promise.all([
        computeGlobalStats(),
        computeTopPerformers(),
        computeRecentActivityGlobal(),
        computeArticleReadStats(),
        computeMonthlyProgress(),
      ]);

    const result = {
      global_stats: globalStats,
      top_performers: topPerformers,
      recent_activity_global: recentActivity,
      articles_most_read: articleStats.most,
      articles_least_read: articleStats.least,
      monthly_progress: monthlyProgress,
    };

    cache.set(CACHE_KEY, result);
    return res.json(result);
  } catch (err) {
    console.error('[getGlobalDashboard]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { getGlobalDashboard };
