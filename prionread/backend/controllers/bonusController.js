const { Op } = require('sequelize');
const { BonusCredit, BonusAllocation, User, Article } = require('../models');
const emailService = require('../services/emailService');

const MINUTES_PER_PAGE = 5;
const DEFAULT_PAGES    = 10;
const DEBT_THRESHOLD   = -120;

// ─── Helper: award a bonus credit for completing an article ──────────────────

async function awardBonusCredit(userId, articleId) {
  const article = await Article.findByPk(articleId, {
    attributes: ['id', 'title', 'pdf_pages'],
  });
  if (!article) throw new Error(`Article ${articleId} not found`);

  const pages   = article.pdf_pages || DEFAULT_PAGES;
  const minutes = pages * MINUTES_PER_PAGE;

  const [credit, created] = await BonusCredit.findOrCreate({
    where:    { user_id: userId, article_id: articleId },
    defaults: { pages, minutes_earned: minutes },
  });

  if (created) {
    const user = await User.findByPk(userId, { attributes: ['id', 'name', 'email'] });
    if (user) {
      const earned = await BonusCredit.sum('minutes_earned', { where: { user_id: userId } });
      const spent  = await BonusAllocation.sum('minutes', { where: { user_id: userId } });
      const totalBalance = (earned || 0) - (spent || 0);

      await BonusCredit.update({ notified_at: new Date() }, { where: { id: credit.id } });

      emailService.sendBonusEarnedEmail(user, {
        minutes,
        articleTitle: article.title,
        totalBalance,
      }).catch((e) => console.error('[bonus] sendBonusEarnedEmail failed:', e));
    }
  }

  return { credit, created, minutes };
}

// ─── GET /api/my-bonus ───────────────────────────────────────────────────────

async function getMyBonus(req, res) {
  try {
    const userId = req.user.id;

    const [credits, allocations, earned, spent] = await Promise.all([
      BonusCredit.findAll({
        where:   { user_id: userId },
        include: [{ model: Article, as: 'article', attributes: ['id', 'title'] }],
        order:   [['created_at', 'DESC']],
        limit:   10,
      }),
      BonusAllocation.findAll({
        where: { user_id: userId },
        order: [['created_at', 'DESC']],
        limit: 10,
      }),
      BonusCredit.sum('minutes_earned', { where: { user_id: userId } }),
      BonusAllocation.sum('minutes', { where: { user_id: userId } }),
    ]);

    const earnedTotal = earned || 0;
    const spentTotal  = spent  || 0;

    return res.json({
      earned:      earnedTotal,
      spent:       spentTotal,
      balance:     earnedTotal - spentTotal,
      credits,
      allocations,
    });
  } catch (err) {
    console.error('[getMyBonus]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── GET /api/admin/bonus ────────────────────────────────────────────────────

async function getAdminBonusOverview(req, res) {
  try {
    const students = await User.findAll({
      where:      { role: 'student' },
      attributes: ['id', 'name', 'email'],
    });

    const rows = await Promise.all(students.map(async (student) => {
      const [earned, spent, creditsCount, lastCredit] = await Promise.all([
        BonusCredit.sum('minutes_earned', { where: { user_id: student.id } }),
        BonusAllocation.sum('minutes', { where: { user_id: student.id } }),
        BonusCredit.count({ where: { user_id: student.id } }),
        BonusCredit.findOne({
          where:      { user_id: student.id },
          order:      [['created_at', 'DESC']],
          attributes: ['created_at'],
        }),
      ]);

      const earnedTotal = earned || 0;
      const spentTotal  = spent  || 0;

      return {
        id:             student.id,
        name:           student.name,
        email:          student.email,
        earned:         earnedTotal,
        spent:          spentTotal,
        balance:        earnedTotal - spentTotal,
        credits_count:  creditsCount,
        last_credit_at: lastCredit?.created_at ?? null,
      };
    }));

    rows.sort((a, b) => a.balance - b.balance);

    return res.json({ students: rows });
  } catch (err) {
    console.error('[getAdminBonusOverview]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── GET /api/admin/bonus/:userId ────────────────────────────────────────────

async function getStudentBonusDetail(req, res) {
  try {
    const { userId } = req.params;

    const student = await User.findByPk(userId, { attributes: ['id', 'name', 'email'] });
    if (!student) return res.status(404).json({ error: 'User not found' });

    const [credits, allocations, earned, spent] = await Promise.all([
      BonusCredit.findAll({
        where:   { user_id: userId },
        include: [{ model: Article, as: 'article', attributes: ['id', 'title'] }],
        order:   [['created_at', 'DESC']],
      }),
      BonusAllocation.findAll({
        where: { user_id: userId },
        order: [['created_at', 'DESC']],
      }),
      BonusCredit.sum('minutes_earned', { where: { user_id: userId } }),
      BonusAllocation.sum('minutes', { where: { user_id: userId } }),
    ]);

    const earnedTotal = earned || 0;
    const spentTotal  = spent  || 0;

    // Merge and sort transactions by date DESC
    const transactions = [
      ...credits.map((c) => ({
        type:       'credit',
        id:         c.id,
        minutes:    c.minutes_earned,
        pages:      c.pages,
        article:    c.article,
        note:       c.note,
        created_at: c.created_at,
      })),
      ...allocations.map((a) => ({
        type:        'allocation',
        id:          a.id,
        minutes:     -a.minutes,
        task_type:   a.task_type,
        description: a.description,
        created_by:  a.created_by,
        created_at:  a.created_at,
      })),
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return res.json({
      student,
      earned:       earnedTotal,
      spent:        spentTotal,
      balance:      earnedTotal - spentTotal,
      transactions,
    });
  } catch (err) {
    console.error('[getStudentBonusDetail]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── POST /api/admin/bonus/allocations ───────────────────────────────────────

async function addAllocation(req, res) {
  try {
    const { user_id, task_type, description, minutes } = req.body;

    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    if (!description || !description.trim()) return res.status(400).json({ error: 'description is required' });

    const mins = parseInt(minutes, 10);
    if (!minutes || Number.isNaN(mins) || mins <= 0) {
      return res.status(400).json({ error: 'minutes must be a positive integer' });
    }

    const user = await User.findByPk(user_id, { attributes: ['id'] });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const allocation = await BonusAllocation.create({
      user_id,
      task_type: task_type || 'other',
      description: description.trim(),
      minutes: mins,
      created_by: req.user.id,
    });

    return res.status(201).json({ allocation });
  } catch (err) {
    console.error('[addAllocation]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── DELETE /api/admin/bonus/allocations/:id ─────────────────────────────────

async function deleteAllocation(req, res) {
  try {
    const allocation = await BonusAllocation.findByPk(req.params.id);
    if (!allocation) return res.status(404).json({ error: 'Allocation not found' });

    await allocation.destroy();
    return res.json({ deleted: true });
  } catch (err) {
    console.error('[deleteAllocation]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  awardBonusCredit,
  getMyBonus,
  getAdminBonusOverview,
  getStudentBonusDetail,
  addAllocation,
  deleteAllocation,
};
