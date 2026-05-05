const { UserArticle, Article, Evaluation, ArticleRating, User } = require('../models');
const recommendationEngine = require('../utils/recommendationEngine');

// ─── Constants ────────────────────────────────────────────────────────────────

const HOURS_PER_ARTICLE = 3;
const ACTIVITY_LIMIT = 10;
const RECOMMENDED_LIMIT = 8;

const ARTICLE_ATTRS = ['id', 'title', 'authors', 'year', 'priority', 'is_milestone', 'tags', 'journal'];

// ─── Data fetchers ────────────────────────────────────────────────────────────

/**
 * Single query that powers stats, recent_activity, progress_by_month and streak.
 * Evaluations are included to surface scores in activity feed.
 */
async function fetchUserArticles(userId) {
  const [rows, ratings] = await Promise.all([
    UserArticle.findAll({
      where: { user_id: userId },
      attributes: ['id', 'article_id', 'status', 'read_date', 'summary_date', 'evaluation_date', 'updated_at'],
      include: [
        { model: Article, as: 'article', attributes: ARTICLE_ATTRS },
        { model: Evaluation, as: 'evaluations', attributes: ['score', 'passed', 'created_at'], required: false },
      ],
    }),
    ArticleRating.findAll({ where: { user_id: userId }, attributes: ['article_id', 'rating'] }),
  ]);
  const ratingMap = new Map(ratings.map((r) => [r.article_id, r.rating]));
  for (const ua of rows) ua.user_rating = ratingMap.get(ua.article_id) ?? null;
  return rows;
}

/** Pending articles sorted by milestone → priority → recency — for recommendations. */
async function fetchRecommended(userId) {
  const rows = await UserArticle.findAll({
    where: { user_id: userId, status: 'pending' },
    include: [{ model: Article, as: 'article', attributes: ARTICLE_ATTRS }],
    order: [
      [{ model: Article, as: 'article' }, 'is_milestone', 'DESC'],
      [{ model: Article, as: 'article' }, 'priority', 'DESC'],
      [{ model: Article, as: 'article' }, 'year', 'DESC'],
    ],
    limit: RECOMMENDED_LIMIT,
  });
  return rows.map((ua) => ua.article).filter(Boolean);
}

/**
 * Computes lab-wide completion rates to give a student their relative rank.
 * Returns only aggregate figures — no individual user data is exposed.
 */
async function fetchLabComparison(userId) {
  const all = await UserArticle.findAll({
    attributes: ['user_id', 'status'],
    include: [
      {
        model: User,
        as: 'user',
        attributes: ['id', 'role'],
        where: { role: 'student' },
        required: true,
      },
    ],
  });

  // Group by user_id
  const byUser = {};
  for (const ua of all) {
    const uid = ua.user_id;
    if (!byUser[uid]) byUser[uid] = { total: 0, evaluated: 0 };
    byUser[uid].total++;
    if (ua.status === 'evaluated') byUser[uid].evaluated++;
  }

  const rates = Object.entries(byUser).map(([uid, s]) => ({
    user_id: uid,
    rate: s.total > 0 ? Math.round((s.evaluated / s.total) * 100) : 0,
  }));

  rates.sort((a, b) => b.rate - a.rate);

  const myEntry = rates.find((r) => r.user_id === userId);
  const rank = myEntry ? rates.indexOf(myEntry) + 1 : null;
  const n = rates.length;
  const avgRate = n > 0 ? Math.round(rates.reduce((s, r) => s + r.rate, 0) / n) : 0;

  return {
    rank,
    total_students: n,
    my_completion_rate: myEntry?.rate ?? 0,
    avg_lab_completion_rate: avgRate,
    percentile: n > 1 ? Math.round((1 - (rank - 1) / (n - 1)) * 100) : 100,
  };
}

// ─── Aggregation helpers ──────────────────────────────────────────────────────

function buildStats(userArticles) {
  const counts = { pending: 0, read: 0, summarized: 0, evaluated: 0 };
  const scores = [];

  for (const ua of userArticles) {
    counts[ua.status] = (counts[ua.status] || 0) + 1;
    for (const ev of ua.evaluations || []) {
      if (ev.score != null) scores.push(ev.score);
    }
  }

  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const avg_score = scores.length
    ? Math.round((scores.reduce((s, n) => s + n, 0) / scores.length) * 100) / 100
    : null;

  return {
    total_assigned: total,
    ...counts,
    avg_score,
    total_evaluations: scores.length,
    total_hours_estimated: total * HOURS_PER_ARTICLE,
  };
}

function buildRecentActivity(userArticles) {
  const events = [];

  for (const ua of userArticles) {
    const title = ua.article?.title || 'Unknown article';
    const article_id = ua.article?.id || null;

    if (ua.read_date) {
      events.push({ type: 'read', article_id, article_title: title, date: ua.read_date, user_rating: ua.user_rating ?? null });
    }
    if (ua.summary_date) {
      events.push({ type: 'summarized', article_id, article_title: title, date: ua.summary_date });
    }
    if (ua.evaluation_date) {
      // Pick the best score from all evaluations of this article
      const evals = ua.evaluations || [];
      const bestScore = evals.length
        ? Math.max(...evals.filter((e) => e.score != null).map((e) => e.score))
        : null;
      events.push({
        type: 'evaluated',
        article_id,
        article_title: title,
        score: bestScore,
        date: ua.evaluation_date,
      });
    }
  }

  return events
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, ACTIVITY_LIMIT);
}

function buildProgressByMonth(userArticles) {
  const map = {};

  function add(dateField, key) {
    for (const ua of userArticles) {
      if (!ua[dateField]) continue;
      const month = String(ua[dateField]).substring(0, 7); // YYYY-MM
      if (!map[month]) map[month] = { month, read: 0, summarized: 0, evaluated: 0 };
      map[month][key]++;
    }
  }

  add('read_date', 'read');
  add('summary_date', 'summarized');
  add('evaluation_date', 'evaluated');

  return Object.values(map).sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Counts consecutive days of activity ending today or yesterday.
 * Collects all unique dates where any action occurred.
 */
function calculateStreak(userArticles) {
  const activeDates = new Set();
  for (const ua of userArticles) {
    for (const field of ['read_date', 'summary_date', 'evaluation_date']) {
      if (ua[field]) activeDates.add(String(ua[field]).substring(0, 10));
    }
  }
  if (!activeDates.size) return 0;

  const todayStr = new Date().toISOString().substring(0, 10);
  const yesterdayStr = new Date(Date.now() - 86_400_000).toISOString().substring(0, 10);

  // Streak is alive only if there was activity today or yesterday
  const anchor = activeDates.has(todayStr)
    ? todayStr
    : activeDates.has(yesterdayStr)
    ? yesterdayStr
    : null;

  if (!anchor) return 0;

  let streak = 0;
  const cursor = new Date(anchor);
  while (activeDates.has(cursor.toISOString().substring(0, 10))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// ─── GET /api/my-dashboard ────────────────────────────────────────────────────

async function getStudentDashboard(req, res) {
  try {
    const userId = req.user.id;

    // Fire independent queries in parallel
    const [userArticles, nextRecommended, labComparison] = await Promise.all([
      fetchUserArticles(userId),
      recommendationEngine.generateRecommendations(userId, RECOMMENDED_LIMIT),
      fetchLabComparison(userId),
    ]);

    const stats = buildStats(userArticles);
    const streak = calculateStreak(userArticles);
    const recentActivity = buildRecentActivity(userArticles);
    const progressByMonth = buildProgressByMonth(userArticles);

    return res.json({
      stats: { ...stats, streak },
      recent_activity: recentActivity,
      next_recommended: nextRecommended,
      progress_by_month: progressByMonth,
      lab_comparison: labComparison,
    });
  } catch (err) {
    console.error('[getStudentDashboard]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { getStudentDashboard };
