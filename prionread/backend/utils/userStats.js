const { Op, fn, col, literal } = require('sequelize');
const { UserArticle, Evaluation, Article } = require('../models');

const STATUSES = ['pending', 'read', 'summarized', 'evaluated'];

async function calculateUserStats(userId) {
  // All user-article rows for this user
  const userArticles = await UserArticle.findAll({
    where: { user_id: userId },
    attributes: ['id', 'status', 'read_date', 'summary_date', 'evaluation_date'],
    include: [
      {
        model: Evaluation,
        as: 'evaluations',
        attributes: ['score', 'passed', 'created_at'],
        required: false,
      },
    ],
  });

  // Count by status
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const ua of userArticles) {
    byStatus[ua.status] = (byStatus[ua.status] || 0) + 1;
  }

  // Flatten all evaluations that have a score
  const allEvals = userArticles.flatMap((ua) => ua.evaluations).filter((e) => e.score != null);

  const avgScore =
    allEvals.length > 0
      ? allEvals.reduce((sum, e) => sum + e.score, 0) / allEvals.length
      : null;

  const passedCount = allEvals.filter((e) => e.passed).length;

  return {
    total_assigned: userArticles.length,
    by_status: byStatus,
    // Convenience shorthands used in list view
    total_read: byStatus.read + byStatus.summarized + byStatus.evaluated,
    total_evaluated: byStatus.evaluated,
    avg_score: avgScore !== null ? Math.round(avgScore * 100) / 100 : null,
    total_evaluations: allEvals.length,
    total_passed: passedCount,
  };
}

async function calculateRecentActivity(userId, limit = 10) {
  const userArticles = await UserArticle.findAll({
    where: { user_id: userId },
    order: [['updated_at', 'DESC']],
    limit,
    include: [
      { model: Article, as: 'article', attributes: ['id', 'title', 'year', 'journal'] },
    ],
    attributes: ['id', 'status', 'read_date', 'summary_date', 'evaluation_date', 'updated_at'],
  });

  return userArticles.map((ua) => ({
    user_article_id: ua.id,
    article: ua.article,
    status: ua.status,
    updated_at: ua.updated_at,
  }));
}

module.exports = { calculateUserStats, calculateRecentActivity };
