const { Op } = require('sequelize');
const { Parser: CsvParser } = require('json2csv');
const { sequelize, User, UserArticle, Article, Evaluation, ArticleRating, ArticleSummary } = require('../models');
const { buildGlobalSummaryPDF, buildStudentProgressPDF } = require('../utils/pdfBuilder');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDateRange(query) {
  const start = query.start_date || null;
  const end = query.end_date || null;

  if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    throw Object.assign(new Error('start_date must be YYYY-MM-DD'), { status: 400 });
  }
  if (end && !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw Object.assign(new Error('end_date must be YYYY-MM-DD'), { status: 400 });
  }

  const label =
    start && end ? `${start} – ${end}` :
    start ? `From ${start}` :
    end ? `Until ${end}` : 'All time';

  return { start, end, label };
}

function dateFilter(start, end, col = 'read_date') {
  const parts = [];
  if (start) parts.push(`${col} >= :start`);
  if (end) parts.push(`${col} <= :end`);
  return parts.length ? `AND ${parts.join(' AND ')}` : '';
}

// ─── Data loaders ─────────────────────────────────────────────────────────────

async function loadGlobalData(start, end) {
  const df = dateFilter(start, end);
  const replacements = { start, end };

  const [globalStats, studentStats, topArticles] = await Promise.all([
    sequelize.query(
      `SELECT
         (SELECT COUNT(*)::int FROM users WHERE role = 'student')         AS total_students,
         (SELECT COUNT(*)::int FROM users WHERE role = 'admin')           AS total_admins,
         (SELECT COUNT(*)::int FROM articles)                             AS total_articles,
         (SELECT COUNT(*)::int FROM articles WHERE is_milestone)          AS total_milestones,
         (SELECT COUNT(*)::int FROM user_articles WHERE status != 'pending' ${df}) AS total_reads,
         (SELECT ROUND(AVG(score)::numeric,2)
          FROM evaluations e
          JOIN user_articles ua ON ua.id = e.user_article_id
          WHERE e.score IS NOT NULL ${df.replace(/read_date/g, 'ua.evaluation_date')})
                                                                          AS avg_evaluation_score,
         (SELECT ROUND(
            AVG(CASE WHEN total > 0 THEN read_count::numeric / total ELSE 0 END)::numeric, 4
          )
          FROM (
            SELECT user_id,
              COUNT(*)                                                     AS total,
              COUNT(*) FILTER (WHERE status != 'pending' ${df})           AS read_count
            FROM user_articles GROUP BY user_id
          ) sub)                                                           AS avg_completion_rate`,
      { replacements, type: sequelize.QueryTypes.SELECT }
    ),

    sequelize.query(
      `SELECT
         u.id, u.name, u.email,
         COUNT(ua.id)::int                                                 AS total_assigned,
         COUNT(ua.id) FILTER (WHERE ua.status != 'pending')::int          AS total_read,
         COUNT(ua.id) FILTER (WHERE ua.status = 'evaluated')::int         AS total_evaluated,
         ROUND(AVG(e.score)::numeric, 2)                                  AS avg_score,
         ROUND(
           CASE WHEN COUNT(ua.id) > 0
             THEN COUNT(ua.id) FILTER (WHERE ua.status != 'pending')::numeric / COUNT(ua.id)
             ELSE 0 END, 2)                                               AS completion_rate
       FROM users u
       LEFT JOIN user_articles ua ON ua.user_id = u.id
       LEFT JOIN evaluations e ON e.user_article_id = ua.id AND e.score IS NOT NULL
       WHERE u.role = 'student'
       GROUP BY u.id, u.name, u.email
       ORDER BY total_read DESC, avg_score DESC NULLS LAST`,
      { replacements, type: sequelize.QueryTypes.SELECT }
    ),

    sequelize.query(
      `SELECT
         a.id, a.title, a.year,
         COUNT(ua.id) FILTER (WHERE ua.status != 'pending' ${df})::int   AS times_read,
         ROUND(AVG(ar.rating)::numeric, 2)                               AS avg_rating
       FROM articles a
       LEFT JOIN user_articles ua ON ua.article_id = a.id
       LEFT JOIN article_ratings ar ON ar.article_id = a.id
       GROUP BY a.id, a.title, a.year
       ORDER BY times_read DESC
       LIMIT 20`,
      { replacements, type: sequelize.QueryTypes.SELECT }
    ),
  ]);

  const gs = globalStats[0];
  return {
    globalStats: {
      ...gs,
      avg_evaluation_score: gs.avg_evaluation_score ? parseFloat(gs.avg_evaluation_score) : null,
      avg_completion_rate: gs.avg_completion_rate ? parseFloat(gs.avg_completion_rate) : 0,
    },
    students: studentStats.map((s) => ({
      id: s.id, name: s.name, email: s.email,
      stats: {
        total_assigned: s.total_assigned,
        total_read: s.total_read,
        total_evaluated: s.total_evaluated,
        avg_score: s.avg_score ? parseFloat(s.avg_score) : null,
        completion_rate: parseFloat(s.completion_rate),
      },
    })),
    topArticles: topArticles.map((a) => ({
      ...a,
      times_read: a.times_read,
      avg_rating: a.avg_rating ? parseFloat(a.avg_rating) : null,
    })),
  };
}

async function loadStudentData(userId, start, end) {
  const user = await User.findByPk(userId, {
    attributes: ['id', 'name', 'email', 'photo_url', 'year_started'],
  });
  if (!user) return null;

  const where = { user_id: userId };
  if (start || end) {
    const dateConditions = [];
    if (start) dateConditions.push({ [Op.gte]: new Date(start) });
    if (end) dateConditions.push({ [Op.lte]: new Date(end) });
    if (dateConditions.length === 2) where.read_date = { [Op.and]: dateConditions };
    else if (dateConditions.length === 1) where.read_date = dateConditions[0];
  }

  const userArticles = await UserArticle.findAll({
    where: { user_id: userId },
    attributes: ['id', 'status', 'read_date', 'summary_date', 'evaluation_date', 'created_at'],
    include: [
      { model: Article, as: 'article', attributes: ['id', 'title', 'authors', 'year', 'tags'] },
      { model: Evaluation, as: 'evaluations', attributes: ['score'], required: false },
      { model: ArticleSummary, as: 'summary', attributes: ['id'], required: false },
    ],
  });

  const counts = { pending: 0, read: 0, summarized: 0, evaluated: 0 };
  const scores = [];
  for (const ua of userArticles) {
    counts[ua.status]++;
    for (const ev of ua.evaluations || []) {
      if (ev.score != null) scores.push(ev.score);
    }
  }
  const totalRead = counts.read + counts.summarized + counts.evaluated;

  const readingHistory = userArticles
    .filter((ua) => ua.read_date)
    .sort((a, b) => new Date(b.read_date) - new Date(a.read_date))
    .map((ua) => {
      const best = (ua.evaluations || [])
        .filter((e) => e.score != null).sort((a, b) => b.score - a.score)[0];
      const completed = ua.evaluation_date || ua.summary_date || ua.read_date;
      return {
        article: ua.article ? { id: ua.article.id, title: ua.article.title,
          authors: ua.article.authors, year: ua.article.year } : null,
        read_date: ua.read_date,
        summary_created: !!ua.summary,
        evaluation_score: best ? parseFloat(best.score) : null,
        time_to_complete_days: completed
          ? Math.round((new Date(completed) - new Date(ua.created_at)) / 86_400_000)
          : null,
      };
    });

  // Lab comparison
  const allRates = await sequelize.query(
    `SELECT user_id,
       CASE WHEN COUNT(*) > 0
         THEN COUNT(*) FILTER (WHERE status != 'pending')::numeric / COUNT(*)
         ELSE 0 END AS rate
     FROM user_articles ua
     JOIN users u ON u.id = ua.user_id AND u.role = 'student'
     GROUP BY user_id
     ORDER BY rate DESC`,
    { type: sequelize.QueryTypes.SELECT }
  );
  const myIdx = allRates.findIndex((r) => r.user_id === userId);
  const avgRate = allRates.length
    ? Math.round(allRates.reduce((s, r) => s + parseFloat(r.rate), 0) / allRates.length * 100)
    : 0;

  return {
    student: user.toJSON(),
    stats: {
      total_assigned: Object.values(counts).reduce((s, n) => s + n, 0),
      total_read: totalRead,
      total_evaluated: counts.evaluated,
      avg_score: scores.length ? Math.round(scores.reduce((s, n) => s + n, 0) / scores.length * 100) / 100 : null,
      completion_rate: Object.values(counts).reduce((s, n) => s + n, 0) > 0
        ? Math.round(totalRead / Object.values(counts).reduce((s, n) => s + n, 0) * 100) / 100 : 0,
    },
    readingHistory,
    labComparison: {
      rank: myIdx + 1,
      total_students: allRates.length,
      percentile: allRates.length > 1
        ? Math.round((1 - myIdx / (allRates.length - 1)) * 100) : 100,
      avg_lab_completion_rate: avgRate,
    },
  };
}

// ─── GET /api/admin/reports/global-summary ────────────────────────────────────

async function generateGlobalSummary(req, res) {
  try {
    let dateRange;
    try { dateRange = parseDateRange(req.query); } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const format = (req.query.format || 'json').toLowerCase();
    if (!['json', 'csv', 'pdf'].includes(format)) {
      return res.status(400).json({ error: 'format must be json, csv, or pdf' });
    }

    const data = await loadGlobalData(dateRange.start, dateRange.end);
    const date = new Date().toISOString().substring(0, 10);

    if (format === 'json') {
      return res.json({ date_range: dateRange.label, ...data });
    }

    if (format === 'csv') {
      const fields = [
        { label: 'Name', value: 'name' },
        { label: 'Email', value: 'email' },
        { label: 'Total Assigned', value: 'stats.total_assigned' },
        { label: 'Total Read', value: 'stats.total_read' },
        { label: 'Total Evaluated', value: 'stats.total_evaluated' },
        { label: 'Avg Score', value: 'stats.avg_score' },
        { label: 'Completion Rate', value: 'stats.completion_rate' },
      ];
      const rows = data.students.map((s) => ({ ...s, ...s.stats }));
      const csv = new CsvParser({ fields }).parse(rows);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition',
        `attachment; filename="prionread-global-summary-${date}.csv"`);
      return res.send(csv);
    }

    // pdf
    buildGlobalSummaryPDF(res, {
      dateRange: dateRange.label,
      globalStats: data.globalStats,
      students: data.students,
      topArticles: data.topArticles,
    });
  } catch (err) {
    console.error('[generateGlobalSummary]', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── GET /api/admin/reports/student-progress ─────────────────────────────────

async function generateStudentProgress(req, res) {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id query param is required' });

    let dateRange;
    try { dateRange = parseDateRange(req.query); } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const format = (req.query.format || 'json').toLowerCase();
    if (!['json', 'csv', 'pdf'].includes(format)) {
      return res.status(400).json({ error: 'format must be json, csv, or pdf' });
    }

    const data = await loadStudentData(user_id, dateRange.start, dateRange.end);
    if (!data) return res.status(404).json({ error: 'User not found' });

    const date = new Date().toISOString().substring(0, 10);
    const slug = data.student.name.replace(/\s+/g, '-').toLowerCase();

    if (format === 'json') {
      return res.json({ date_range: dateRange.label, ...data });
    }

    if (format === 'csv') {
      const fields = [
        { label: 'Article Title', value: 'article.title' },
        { label: 'Year', value: 'article.year' },
        { label: 'Read Date', value: 'read_date' },
        { label: 'Summary Created', value: 'summary_created' },
        { label: 'Evaluation Score', value: 'evaluation_score' },
        { label: 'Days to Complete', value: 'time_to_complete_days' },
      ];
      const csv = new CsvParser({ fields }).parse(data.readingHistory);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition',
        `attachment; filename="prionread-student-${slug}-${date}.csv"`);
      return res.send(csv);
    }

    // pdf
    buildStudentProgressPDF(res, data);
  } catch (err) {
    console.error('[generateStudentProgress]', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── GET /api/admin/reports/reading-recommendations ──────────────────────────

async function generateReadingRecommendations(req, res) {
  try {
    const [students, allAssignments, articles, ratingRows] = await Promise.all([
      User.findAll({ where: { role: 'student' }, attributes: ['id', 'name', 'email'] }),
      UserArticle.findAll({ attributes: ['user_id', 'article_id', 'status'] }),
      Article.findAll({
        attributes: ['id', 'title', 'authors', 'year', 'is_milestone', 'priority', 'tags'],
      }),
      sequelize.query(
        `SELECT article_id, ROUND(AVG(rating)::numeric, 2) AS avg_rating
         FROM article_ratings GROUP BY article_id`,
        { type: sequelize.QueryTypes.SELECT }
      ),
    ]);

    const ratingMap = Object.fromEntries(
      ratingRows.map((r) => [r.article_id, parseFloat(r.avg_rating)])
    );

    // Build per-user assignment + read sets
    const byUser = {};
    for (const ua of allAssignments) {
      if (!byUser[ua.user_id]) byUser[ua.user_id] = { assigned: new Set(), read: new Set() };
      byUser[ua.user_id].assigned.add(ua.article_id);
      if (ua.status !== 'pending') byUser[ua.user_id].read.add(ua.article_id);
    }

    // All tags that exist in the corpus
    const corpusTags = new Set(articles.flatMap((a) => a.tags));

    const recommendations = students.map((student) => {
      const ua = byUser[student.id] || { assigned: new Set(), read: new Set() };

      // Tags the student has already encountered through read articles
      const coveredTags = new Set(
        articles.filter((a) => ua.read.has(a.id)).flatMap((a) => a.tags)
      );
      const gapTags = [...corpusTags].filter((t) => !coveredTags.has(t));

      const seen = new Set();
      const ranked = [];

      function addRec(article, reason, bonusScore) {
        if (seen.has(article.id)) return;
        seen.add(article.id);
        ranked.push({
          id: article.id,
          title: article.title,
          authors: article.authors,
          year: article.year,
          is_milestone: article.is_milestone,
          priority: article.priority,
          tags: article.tags,
          avg_rating: ratingMap[article.id] || null,
          reason,
          priority_score: bonusScore,
        });
      }

      // 1. Milestone not yet assigned
      articles
        .filter((a) => a.is_milestone && !ua.assigned.has(a.id))
        .forEach((a) => addRec(a, 'unassigned_milestone', 10));

      // 2. Assigned but still pending (hasn't been read)
      articles
        .filter((a) => ua.assigned.has(a.id) && !ua.read.has(a.id))
        .sort((a, b) => b.priority - a.priority)
        .forEach((a) => addRec(a, 'pending_assignment', 8));

      // 3. Highly rated articles not yet assigned (avg ≥ 4.0)
      articles
        .filter((a) => !ua.assigned.has(a.id) && (ratingMap[a.id] || 0) >= 4.0)
        .sort((a, b) => (ratingMap[b.id] || 0) - (ratingMap[a.id] || 0))
        .forEach((a) => addRec(a, 'highly_rated', 7));

      // 4. Articles that cover gap tags, not yet assigned
      articles
        .filter((a) => !ua.assigned.has(a.id) && a.tags.some((t) => gapTags.includes(t)))
        .sort((a, b) => b.priority - a.priority)
        .forEach((a) => addRec(a, 'tag_gap', 5));

      return {
        user: { id: student.id, name: student.name, email: student.email },
        recommendations: ranked
          .sort((a, b) => b.priority_score - a.priority_score || b.priority - a.priority)
          .slice(0, 10),
        coverage_summary: {
          total_articles: articles.length,
          assigned: ua.assigned.size,
          read: ua.read.size,
          coverage_rate: articles.length > 0
            ? Math.round((ua.read.size / articles.length) * 100) / 100 : 0,
          tag_gaps: gapTags.slice(0, 10),
        },
      };
    });

    return res.json({ recommendations });
  } catch (err) {
    console.error('[generateReadingRecommendations]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { generateGlobalSummary, generateStudentProgress, generateReadingRecommendations };
