const { Op } = require('sequelize');
const { User, Article, UserArticle } = require('../models');

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function findExistingPairs(user_id, article_ids) {
  const rows = await UserArticle.findAll({
    where: { user_id, article_id: { [Op.in]: article_ids } },
    attributes: ['article_id'],
  });
  return new Set(rows.map((r) => r.article_id));
}

function buildPairs(user_ids, article_ids, existingSet) {
  const pairs = [];
  for (const user_id of user_ids) {
    for (const article_id of article_ids) {
      if (!existingSet.has(`${user_id}:${article_id}`)) {
        pairs.push({ user_id, article_id, status: 'pending' });
      }
    }
  }
  return pairs;
}

// ─── POST /api/assignments ────────────────────────────────────────────────────

async function assignArticles(req, res) {
  try {
    const { user_id, article_ids } = req.body;

    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    if (!Array.isArray(article_ids) || !article_ids.length) {
      return res.status(400).json({ error: 'article_ids must be a non-empty array' });
    }

    const user = await User.findByPk(user_id, { attributes: ['id'] });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Only create assignments for articles that actually exist
    const existingArticles = await Article.findAll({
      where: { id: { [Op.in]: article_ids } },
      attributes: ['id'],
    });
    const validIds = existingArticles.map((a) => a.id);
    const notFound = article_ids.filter((id) => !validIds.includes(id));

    const alreadyAssigned = await findExistingPairs(user_id, validIds);

    const toCreate = validIds
      .filter((id) => !alreadyAssigned.has(id))
      .map((article_id) => ({ user_id, article_id, status: 'pending' }));

    if (toCreate.length) await UserArticle.bulkCreate(toCreate);

    return res.status(201).json({
      assigned: toCreate.length,
      skipped: alreadyAssigned.size,
      not_found: notFound,
    });
  } catch (err) {
    console.error('[assignArticles]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── POST /api/assignments/bulk ───────────────────────────────────────────────

async function bulkAssign(req, res) {
  try {
    const { user_ids, article_ids } = req.body;

    if (!Array.isArray(user_ids) || !user_ids.length) {
      return res.status(400).json({ error: 'user_ids must be a non-empty array' });
    }
    if (!Array.isArray(article_ids) || !article_ids.length) {
      return res.status(400).json({ error: 'article_ids must be a non-empty array' });
    }

    // Validate both sets exist in DB
    const [validUsers, validArticles] = await Promise.all([
      User.findAll({ where: { id: { [Op.in]: user_ids } }, attributes: ['id'] }),
      Article.findAll({ where: { id: { [Op.in]: article_ids } }, attributes: ['id'] }),
    ]);

    const validUserIds = validUsers.map((u) => u.id);
    const validArticleIds = validArticles.map((a) => a.id);

    // Fetch all existing assignments in one query using composite key check
    const existing = await UserArticle.findAll({
      where: {
        user_id: { [Op.in]: validUserIds },
        article_id: { [Op.in]: validArticleIds },
      },
      attributes: ['user_id', 'article_id'],
    });
    const existingSet = new Set(existing.map((e) => `${e.user_id}:${e.article_id}`));

    const pairs = buildPairs(validUserIds, validArticleIds, existingSet);

    if (pairs.length) await UserArticle.bulkCreate(pairs);

    return res.status(201).json({
      assigned: pairs.length,
      skipped: existing.length,
      invalid_users: user_ids.filter((id) => !validUserIds.includes(id)),
      invalid_articles: article_ids.filter((id) => !validArticleIds.includes(id)),
    });
  } catch (err) {
    console.error('[bulkAssign]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── GET /api/assignments/user/:userId ───────────────────────────────────────

async function getAssignmentsByUser(req, res) {
  try {
    const user = await User.findByPk(req.params.userId, {
      attributes: ['id', 'name', 'email', 'role', 'year_started'],
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const assignments = await UserArticle.findAll({
      where: { user_id: user.id },
      include: [
        {
          model: Article,
          as: 'article',
          include: [{ model: require('../models').ArticleRating, as: 'ratings', attributes: ['rating'], required: false }],
        },
      ],
      order: [['created_at', 'DESC']],
    });

    const formatted = assignments.map((ua) => {
      const ratingsArr = ua.article?.ratings || [];
      const avg_rating =
        ratingsArr.length
          ? Math.round((ratingsArr.reduce((s, r) => s + r.rating, 0) / ratingsArr.length) * 100) / 100
          : null;

      const article = ua.article ? { ...ua.article.toJSON(), ratings: undefined, avg_rating } : null;

      return {
        id: ua.id,
        status: ua.status,
        read_date: ua.read_date,
        summary_date: ua.summary_date,
        evaluation_date: ua.evaluation_date,
        assigned_at: ua.created_at,
        article,
      };
    });

    return res.json({ user, assignments: formatted });
  } catch (err) {
    console.error('[getAssignmentsByUser]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── DELETE /api/assignments/:id ─────────────────────────────────────────────

async function removeAssignment(req, res) {
  try {
    const ua = await UserArticle.findByPk(req.params.id);
    if (!ua) return res.status(404).json({ error: 'Assignment not found' });

    await ua.destroy();
    return res.json({ success: true });
  } catch (err) {
    console.error('[removeAssignment]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { assignArticles, bulkAssign, getAssignmentsByUser, removeAssignment };
