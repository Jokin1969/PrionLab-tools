const { Article, UserArticle, ArticleRating } = require('../models');

const recommendationEngine = {
  /**
   * Generates personalised recommendations for a user.
   *
   * Scoring weights:
   *   +40  is_milestone
   *   +5×  priority (1-5)
   *   +0-10 tag gap (low coverage → more points)
   *   +0-15 avg rating (×3, max 5 stars)
   *   +0-5  recency (articles ≤5 years old)
   */
  generateRecommendations: async (userId, limit = 10) => {
    const userArticles = await UserArticle.findAll({
      where: { user_id: userId },
      include: [{ model: Article, as: 'article' }],
    });

    const pendingArticles = userArticles
      .filter((ua) => ua.status === 'pending')
      .map((ua) => ua.article)
      .filter(Boolean);

    if (pendingArticles.length === 0) return [];

    // Build tag frequency map from already-read articles
    const readTags = {};
    userArticles
      .filter((ua) => ua.status !== 'pending' && ua.article)
      .forEach((ua) => {
        (ua.article.tags || []).forEach((tag) => {
          readTags[tag] = (readTags[tag] || 0) + 1;
        });
      });

    // Fetch all ratings in one query then group by article
    const ratingRows = await ArticleRating.findAll({
      where: { article_id: pendingArticles.map((a) => a.id) },
      attributes: ['article_id', 'rating'],
    });
    const ratingsByArticle = {};
    for (const r of ratingRows) {
      if (!ratingsByArticle[r.article_id]) ratingsByArticle[r.article_id] = [];
      ratingsByArticle[r.article_id].push(r.rating);
    }

    const currentYear = new Date().getFullYear();

    const scoredArticles = pendingArticles.map((article) => {
      let score = 0;

      // Factor 1: milestone
      if (article.is_milestone) score += 40;

      // Factor 2: priority (1-5)
      score += (article.priority || 1) * 5;

      // Factor 3: tag gap (less covered → higher score)
      const tags = article.tags || [];
      if (tags.length > 0) {
        const avgCoverage = tags.reduce((s, t) => s + (readTags[t] || 0), 0) / tags.length;
        score += Math.max(0, 10 - avgCoverage);
      }

      // Factor 4: avg rating
      const ratings = ratingsByArticle[article.id] || [];
      if (ratings.length > 0) {
        const avg = ratings.reduce((s, v) => s + v, 0) / ratings.length;
        score += avg * 3;
      }

      // Factor 5: recency (capped at 5 points)
      const yearDiff = currentYear - (article.year || currentYear);
      score += Math.max(0, 5 - yearDiff);

      return { ...article.toJSON(), recommendation_score: score };
    });

    return scoredArticles
      .sort((a, b) => b.recommendation_score - a.recommendation_score)
      .slice(0, limit);
  },

  /**
   * Analyses which tags and milestones a user still needs to cover.
   */
  analyzeReadingGaps: async (userId) => {
    const userArticles = await UserArticle.findAll({
      where: { user_id: userId },
      include: [{ model: Article, as: 'article' }],
    });

    const readArticles = userArticles
      .filter((ua) => ua.status !== 'pending' && ua.article)
      .map((ua) => ua.article);

    const pendingArticles = userArticles
      .filter((ua) => ua.status === 'pending' && ua.article)
      .map((ua) => ua.article);

    const allArticles = [...readArticles, ...pendingArticles];

    // Tag read counts
    const tagCoverage = {};
    readArticles.forEach((a) =>
      (a.tags || []).forEach((t) => { tagCoverage[t] = (tagCoverage[t] || 0) + 1; })
    );

    // All tags in assigned corpus
    const allTags = new Set(allArticles.flatMap((a) => a.tags || []));

    const underrepresentedTags = [];
    allTags.forEach((tag) => {
      const coverage = tagCoverage[tag] || 0;
      const total = allArticles.filter((a) => (a.tags || []).includes(tag)).length;
      const pct = total > 0 ? (coverage / total) * 100 : 0;
      if (pct < 50) {
        underrepresentedTags.push({ tag, coverage, total, coveragePercent: pct.toFixed(0) });
      }
    });

    return {
      totalRead: readArticles.length,
      totalPending: pendingArticles.length,
      underrepresentedTags: underrepresentedTags.sort((a, b) => a.coverage - b.coverage),
      unreadMilestones: pendingArticles.filter((a) => a.is_milestone).length,
      tagCoverage,
    };
  },

  /**
   * Generates recommendations for every student.
   * Returns a map: userId → { user, recommendations, gaps }
   */
  generateAllRecommendations: async () => {
    const { User } = require('../models');
    const students = await User.findAll({ where: { role: 'student' } });

    const result = {};
    for (const user of students) {
      const [recommendations, gaps] = await Promise.all([
        recommendationEngine.generateRecommendations(user.id, 10),
        recommendationEngine.analyzeReadingGaps(user.id),
      ]);
      result[user.id] = {
        user: { id: user.id, name: user.name, email: user.email },
        recommendations,
        gaps,
      };
    }
    return result;
  },
};

module.exports = recommendationEngine;
