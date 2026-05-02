const { Op } = require('sequelize');
const { Parser: CsvParser } = require('json2csv');
const { User, UserArticle, Article, Evaluation, ArticleSummary } = require('../models');
const { generatePassword } = require('../utils/generatePassword');

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Counts consecutive days of activity ending on today (strict — streak = 0
 * if today has no recorded activity).
 */
function calcStreak(userArticles) {
  const active = new Set();
  for (const ua of userArticles) {
    for (const f of ['read_date', 'summary_date', 'evaluation_date']) {
      if (ua[f]) active.add(String(ua[f]).substring(0, 10));
    }
  }

  const todayStr = new Date().toISOString().substring(0, 10);
  if (!active.has(todayStr)) return 0;

  let streak = 0;
  const cursor = new Date(todayStr);
  while (active.has(cursor.toISOString().substring(0, 10))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/**
 * Returns top-5 tags from articles the student has progressed past pending.
 */
function calcFavoriteTopics(userArticles) {
  const counts = {};
  for (const ua of userArticles) {
    if (ua.status === 'pending') continue;
    for (const tag of ua.article?.tags || []) {
      counts[tag] = (counts[tag] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag, count]) => ({ tag, count }));
}

function msTodays(ms) {
  return Math.round(ms / 86_400_000);
}

// ─── GET /api/admin/users/:userId/detailed-stats ──────────────────────────────

async function getUserDetailedStats(req, res) {
  try {
    const user = await User.findByPk(req.params.userId, {
      attributes: ['id', 'name', 'email', 'photo_url', 'year_started', 'created_at'],
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const userArticles = await UserArticle.findAll({
      where: { user_id: user.id },
      attributes: [
        'id', 'status', 'read_date', 'summary_date', 'evaluation_date', 'created_at',
      ],
      include: [
        {
          model: Article,
          as: 'article',
          attributes: ['id', 'title', 'authors', 'year', 'tags'],
        },
        {
          model: Evaluation,
          as: 'evaluations',
          attributes: ['score', 'passed', 'created_at'],
          required: false,
        },
        {
          model: ArticleSummary,
          as: 'summary',
          attributes: ['id'],
          required: false,
        },
      ],
    });

    // ── Stats ──────────────────────────────────────────────────────────────────
    const counts = { pending: 0, read: 0, summarized: 0, evaluated: 0 };
    const allScores = [];
    let lastActivityDate = null;

    for (const ua of userArticles) {
      counts[ua.status] = (counts[ua.status] || 0) + 1;

      for (const f of ['read_date', 'summary_date', 'evaluation_date']) {
        if (ua[f]) {
          const d = new Date(ua[f]);
          if (!lastActivityDate || d > lastActivityDate) lastActivityDate = d;
        }
      }

      for (const ev of ua.evaluations || []) {
        if (ev.score != null) allScores.push(ev.score);
      }
    }

    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    const totalRead = counts.read + counts.summarized + counts.evaluated;
    const avg_score = allScores.length
      ? Math.round((allScores.reduce((s, n) => s + n, 0) / allScores.length) * 100) / 100
      : null;

    const stats = {
      total_assigned: total,
      total_read: totalRead,
      total_summarized: counts.summarized + counts.evaluated,
      total_evaluated: counts.evaluated,
      avg_score,
      completion_rate: total > 0 ? Math.round((totalRead / total) * 100) / 100 : 0,
      last_activity_date: lastActivityDate ? lastActivityDate.toISOString().substring(0, 10) : null,
      active_streak_days: calcStreak(userArticles),
      favorite_topics: calcFavoriteTopics(userArticles),
    };

    // ── Reading history ────────────────────────────────────────────────────────
    const reading_history = userArticles
      .filter((ua) => ua.read_date)
      .sort((a, b) => new Date(b.read_date) - new Date(a.read_date))
      .map((ua) => {
        const bestEval = (ua.evaluations || [])
          .filter((e) => e.score != null)
          .sort((a, b) => b.score - a.score)[0];

        const completedAt = ua.evaluation_date || ua.summary_date || ua.read_date;
        const time_to_complete_days = completedAt
          ? msTodays(new Date(completedAt) - new Date(ua.created_at))
          : null;

        return {
          article: ua.article
            ? { id: ua.article.id, title: ua.article.title,
                authors: ua.article.authors, year: ua.article.year }
            : null,
          read_date: ua.read_date,
          summary_created: !!ua.summary,
          evaluation_score: bestEval ? parseFloat(bestEval.score) : null,
          time_to_complete_days,
        };
      });

    // ── Performance over time ──────────────────────────────────────────────────
    const monthMap = {};
    for (const ua of userArticles) {
      if (!ua.read_date) continue;
      const month = String(ua.read_date).substring(0, 7);
      if (!monthMap[month]) monthMap[month] = { month, articles_read: 0, scores: [] };
      monthMap[month].articles_read++;

      for (const ev of ua.evaluations || []) {
        if (ev.score != null) monthMap[month].scores.push(ev.score);
      }
    }

    const performance_over_time = Object.values(monthMap)
      .sort((a, b) => a.month.localeCompare(b.month))
      .map(({ month, articles_read, scores }) => ({
        month,
        articles_read,
        avg_score: scores.length
          ? Math.round((scores.reduce((s, n) => s + n, 0) / scores.length) * 100) / 100
          : null,
      }));

    return res.json({ user, stats, reading_history, performance_over_time });
  } catch (err) {
    console.error('[getUserDetailedStats]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── GET /api/admin/users/export ─────────────────────────────────────────────

async function exportUsersCSV(req, res) {
  try {
    const students = await User.findAll({
      where: { role: 'student' },
      attributes: ['id', 'name', 'email', 'year_started', 'created_at'],
      order: [['name', 'ASC']],
    });

    // Aggregate stats per student in one query
    const statsRows = await UserArticle.findAll({
      attributes: [
        'user_id',
        ['status', 'status'],
      ],
      include: [
        {
          model: Evaluation,
          as: 'evaluations',
          attributes: ['score'],
          required: false,
        },
      ],
    });

    // Build per-user stat maps
    const byUser = {};
    for (const ua of statsRows) {
      const uid = ua.user_id;
      if (!byUser[uid]) byUser[uid] = { total: 0, read: 0, evaluated: 0, scores: [] };
      byUser[uid].total++;
      if (['read', 'summarized', 'evaluated'].includes(ua.status)) byUser[uid].read++;
      if (ua.status === 'evaluated') byUser[uid].evaluated++;
      for (const ev of ua.evaluations || []) {
        if (ev.score != null) byUser[uid].scores.push(ev.score);
      }
    }

    const rows = students.map((u) => {
      const s = byUser[u.id] || { total: 0, read: 0, evaluated: 0, scores: [] };
      const avg = s.scores.length
        ? Math.round((s.scores.reduce((a, b) => a + b, 0) / s.scores.length) * 100) / 100
        : '';
      return {
        name: u.name,
        email: u.email,
        year_started: u.year_started || '',
        total_assigned: s.total,
        total_read: s.read,
        total_evaluated: s.evaluated,
        avg_score: avg,
        completion_rate: s.total > 0 ? Math.round((s.read / s.total) * 100) / 100 : 0,
      };
    });

    const fields = [
      { label: 'Name', value: 'name' },
      { label: 'Email', value: 'email' },
      { label: 'PhD Start Year', value: 'year_started' },
      { label: 'Total Assigned', value: 'total_assigned' },
      { label: 'Total Read', value: 'total_read' },
      { label: 'Total Evaluated', value: 'total_evaluated' },
      { label: 'Avg Score', value: 'avg_score' },
      { label: 'Completion Rate', value: 'completion_rate' },
    ];

    const csv = new CsvParser({ fields }).parse(rows);
    const date = new Date().toISOString().substring(0, 10);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="prionread-users-${date}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error('[exportUsersCSV]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── POST /api/admin/users/:userId/reset-password ────────────────────────────

async function resetUserPassword(req, res) {
  try {
    if (req.user.id === req.params.userId) {
      return res.status(400).json({
        error: 'Use /auth/change-password to update your own password',
      });
    }

    const user = await User.findByPk(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const tempPassword = generatePassword(10);
    user.password = tempPassword; // bcrypt hook fires on save
    await user.save();

    // TODO: replace with real email service
    console.log('[RESET] Password reset — email would be sent:');
    console.log(`  To:   ${user.email}`);
    console.log(`  Pass: ${tempPassword}`);

    return res.json({ tempPassword, email_sent: false });
  } catch (err) {
    console.error('[resetUserPassword]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── POST /api/admin/users/:userId/send-reminder ─────────────────────────────

async function sendReminderToUser(req, res) {
  try {
    const user = await User.findByPk(req.params.userId, {
      attributes: ['id', 'name', 'email'],
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const pendingCount = await UserArticle.count({
      where: { user_id: user.id, status: 'pending' },
    });

    const customMessage = req.body?.message?.trim() || null;

    // TODO: replace with real email service
    console.log('[REMINDER] Email would be sent:');
    console.log(`  To:      ${user.email}`);
    console.log(`  Pending: ${pendingCount} article(s)`);
    if (customMessage) console.log(`  Message: ${customMessage}`);

    return res.json({ email_sent: false, pending_articles: pendingCount });
  } catch (err) {
    console.error('[sendReminderToUser]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  getUserDetailedStats,
  exportUsersCSV,
  resetUserPassword,
  sendReminderToUser,
};
