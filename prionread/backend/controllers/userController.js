const { Op } = require('sequelize');
const { User, UserArticle, sequelize } = require('../models');
const { generatePassword } = require('../utils/generatePassword');
const { calculateRecentActivity } = require('../utils/userStats');

const SAFE_ATTRS = ['id', 'name', 'email', 'role', 'photo_url', 'year_started', 'welcome_email_sent_at', 'created_at', 'updated_at'];

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// GET /api/users
async function getUsers(req, res) {
  try {
    const where = {};
    if (req.query.role) {
      if (!['admin', 'student'].includes(req.query.role)) {
        return res.status(400).json({ error: 'Role must be admin or student' });
      }
      where.role = req.query.role;
    }

    const users = await User.findAll({ where, attributes: SAFE_ATTRS, order: [['name', 'ASC']] });
    const userIds = users.map((u) => u.id);

    const statusRows = userIds.length
      ? await UserArticle.findAll({
          where: { user_id: { [Op.in]: userIds } },
          attributes: [
            'user_id',
            'status',
            [sequelize.literal('COUNT(*)'), 'count'],
          ],
          group: ['user_id', 'status'],
          raw: true,
        })
      : [];

    const statsMap = {};
    for (const row of statusRows) {
      if (!statsMap[row.user_id]) statsMap[row.user_id] = {};
      statsMap[row.user_id][row.status] = parseInt(row.count, 10);
    }

    const usersWithStats = users.map((u) => {
      const s = statsMap[u.id] || {};
      return {
        ...u.toJSON(),
        stats: {
          total_assigned: (s.pending || 0) + (s.read || 0) + (s.summarized || 0) + (s.evaluated || 0),
          total_pending:    s.pending    || 0,
          total_read:      (s.read || 0) + (s.summarized || 0) + (s.evaluated || 0),
          total_summarized:(s.summarized || 0) + (s.evaluated || 0),
          total_evaluated:  s.evaluated  || 0,
        },
      };
    });

    return res.json({ users: usersWithStats });
  } catch (err) {
    console.error('[getUsers]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/users/:id
async function getUserById(req, res) {
  try {
    const user = await User.findByPk(req.params.id, { attributes: SAFE_ATTRS });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const s = {};
    const rows = await UserArticle.findAll({
      where: { user_id: user.id },
      attributes: ['status', [sequelize.literal('COUNT(*)'), 'count']],
      group: ['status'],
      raw: true,
    });
    for (const r of rows) s[r.status] = parseInt(r.count, 10);
    const stats = {
      total_assigned:   (s.pending || 0) + (s.read || 0) + (s.summarized || 0) + (s.evaluated || 0),
      total_pending:     s.pending    || 0,
      total_read:       (s.read || 0) + (s.summarized || 0) + (s.evaluated || 0),
      total_summarized: (s.summarized || 0) + (s.evaluated || 0),
      total_evaluated:   s.evaluated  || 0,
    };

    const recentActivity = await calculateRecentActivity(user.id, 10);
    return res.json({ user, stats, recentActivity });
  } catch (err) {
    console.error('[getUserById]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// PUT /api/users/:id
async function updateUser(req, res) {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { name, email, role, year_started, photo_url } = req.body;

    if (email !== undefined) {
      if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email address' });
      const conflict = await User.findOne({ where: { email: email.toLowerCase() } });
      if (conflict && conflict.id !== user.id) {
        return res.status(400).json({ error: 'Email already in use' });
      }
    }

    if (role !== undefined && !['admin', 'student'].includes(role)) {
      return res.status(400).json({ error: 'Role must be admin or student' });
    }

    if (name        !== undefined) user.name        = name.trim();
    if (email       !== undefined) user.email       = email.toLowerCase();
    if (role        !== undefined) user.role        = role;
    if (year_started !== undefined) user.year_started = year_started;
    if (photo_url   !== undefined) user.photo_url   = photo_url;

    await user.save();
    return res.json({ user: SAFE_ATTRS.reduce((acc, k) => ({ ...acc, [k]: user[k] }), {}) });
  } catch (err) {
    console.error('[updateUser]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// DELETE /api/users/:id
async function deleteUser(req, res) {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (req.user.id === user.id) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }
    if (user.role === 'admin') {
      const adminCount = await User.count({ where: { role: 'admin' } });
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last admin account' });
      }
    }
    await user.destroy();
    return res.json({ success: true });
  } catch (err) {
    console.error('[deleteUser]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/users/bulk-create
async function bulkCreateUsers(req, res) {
  try {
    const { users } = req.body;
    if (!Array.isArray(users) || users.length === 0) {
      return res.status(400).json({ error: 'users must be a non-empty array' });
    }
    const created = [];
    const errors  = [];
    for (let i = 0; i < users.length; i++) {
      const { name, email, role = 'student', year_started } = users[i];
      if (!name || !name.trim())            { errors.push({ index: i, email, reason: 'Name is required' });      continue; }
      if (!email || !isValidEmail(email))   { errors.push({ index: i, email, reason: 'Invalid or missing email' }); continue; }
      if (!['admin','student'].includes(role)) { errors.push({ index: i, email, reason: 'Invalid role' }); continue; }
      const existing = await User.findOne({ where: { email: email.toLowerCase() } });
      if (existing) { errors.push({ index: i, email, reason: 'Email already registered' }); continue; }
      try {
        const tempPassword = generatePassword(10);
        const user = await User.create({ name: name.trim(), email: email.toLowerCase(), password: tempPassword, role, year_started: year_started || null });
        console.log(`[BULK] Created ${user.email} — temp password: ${tempPassword}`);
        created.push({ id: user.id, name: user.name, email: user.email, role: user.role, tempPassword });
      } catch { errors.push({ index: i, email, reason: 'Creation failed' }); }
    }
    return res.status(207).json({ created, errors });
  } catch (err) {
    console.error('[bulkCreateUsers]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { getUsers, getUserById, updateUser, deleteUser, bulkCreateUsers };
