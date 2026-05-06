const { Router } = require('express');
const { Op } = require('sequelize');
const crypto = require('crypto');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { getGlobalDashboard } = require('../controllers/adminDashboardController');
const { getUserDetailedStats, exportUsersCSV, resetUserPassword, sendReminderToUser } = require('../controllers/adminUserController');
const { getArticlesAnalytics, getAssignmentsMatrix, getArticleEngagement, assignArticleToAll, findDuplicateArticles, getSyncStatus } = require('../controllers/adminArticleController');
const { verifyArticlePDFs, syncDropboxPDFs } = require('../controllers/articleController');
const notificationService = require('../services/notificationService');
const emailService = require('../services/emailService');
const { User, NotificationRule, NotificationLog } = require('../models');

const router = Router();
router.use(authenticate, requireAdmin);

// Dashboard
router.get('/dashboard', getGlobalDashboard);

// User management
router.get('/users/export',                    exportUsersCSV);
router.get('/users/:userId/detailed-stats',    getUserDetailedStats);
router.post('/users/:userId/reset-password',   resetUserPassword);
router.post('/users/:userId/send-reminder',    sendReminderToUser);

// Welcome email preview (no send, no password change)
router.get('/users/:userId/welcome-preview', async (req, res) => {
  try {
    const user = await User.findByPk(req.params.userId);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    const html = emailService.buildOnboardingHtml(user, 'ejemplo-contraseña');
    res.json({ html });
  } catch (err) {
    console.error('[GET /admin/users/:userId/welcome-preview]', err);
    res.status(500).json({ error: 'Error generando vista previa' });
  }
});

// Send welcome / onboarding email (generates new temp password)
router.post('/users/:userId/send-welcome', async (req, res) => {
  try {
    const user = await User.findByPk(req.params.userId);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const tempPassword = crypto.randomBytes(5).toString('hex');
    user.password = tempPassword;
    user.admin_set_password = tempPassword;
    user.welcome_email_sent_at = new Date();
    await user.save();

    // DB is updated regardless of email outcome — always return 200 so the
    // UI can reflect the new welcome_email_sent_at state.
    let emailSent = false;
    let emailError = null;
    try {
      await emailService.sendOnboardingEmail(user, tempPassword);
      emailSent = true;
    } catch (emailErr) {
      emailError = emailErr.message;
      console.error('[POST /admin/users/:userId/send-welcome] email failed:', emailErr);
    }

    res.json({
      ok: true,
      welcome_email_sent_at: user.welcome_email_sent_at,
      tempPassword,
      email_sent: emailSent,
      ...(emailError ? { email_error: emailError } : {}),
    });
  } catch (err) {
    console.error('[POST /admin/users/:userId/send-welcome]', err);
    res.status(500).json({ error: 'Error guardando usuario' });
  }
});

// Article analytics — static routes BEFORE /:articleId
router.get('/articles/analytics',           getArticlesAnalytics);
router.get('/articles/assignments-matrix',  getAssignmentsMatrix);

// PDF health check
router.post('/articles/verify-pdfs',  verifyArticlePDFs);
router.post('/articles/sync-dropbox', syncDropboxPDFs);

// Duplicate detection
router.get('/articles/find-duplicates', findDuplicateArticles);

// PrionVault ↔ PrionRead sync status
router.get('/sync/status', getSyncStatus);

// Apply PrionVault columns to the shared articles table (idempotent)
router.post('/sync/run-migration', async (_req, res) => {
  const { sequelize: sq } = require('../models');
  const statements = [
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS pdf_md5           CHAR(32)",
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS pdf_size_bytes    BIGINT",
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS pdf_pages         INTEGER",
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS extraction_status VARCHAR(20) DEFAULT 'pending'",
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS extraction_error  TEXT",
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS summary_ai        TEXT",
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS summary_human     TEXT",
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS indexed_at        TIMESTAMPTZ",
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS source            VARCHAR(40) DEFAULT 'manual'",
  ];
  const results = { ok: [], failed: [] };
  for (const stmt of statements) {
    try {
      await sq.query(stmt);
      results.ok.push(stmt.split('ADD COLUMN IF NOT EXISTS')[1]?.trim().split(' ')[0]);
    } catch (err) {
      results.failed.push({ column: stmt.split('ADD COLUMN IF NOT EXISTS')[1]?.trim().split(' ')[0], error: err.message });
    }
  }
  res.json({ applied: results.ok.length, errors: results.failed.length, results });
});

router.get('/articles/:articleId/engagement',       getArticleEngagement);
router.post('/articles/:articleId/assign-to-all',   assignArticleToAll);

// ─── Notification Rules CRUD ──────────────────────────────────────────────────

router.get('/notification-rules', async (_req, res) => {
  try {
    const rules = await NotificationRule.findAll({
      include: [
        { model: User, as: 'targetUser', attributes: ['id', 'name', 'email'], required: false },
      ],
      order: [['created_at', 'DESC']],
    });

    // Enrich each rule with last_sent and trigger_count (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const enriched = await Promise.all(rules.map(async (rule) => {
      const [lastLog, triggerCount] = await Promise.all([
        NotificationLog.findOne({
          where: { rule_id: rule.id },
          order: [['sent_date', 'DESC']],
          attributes: ['sent_date', 'user_id'],
          include: [{ model: User, as: 'user', attributes: ['name'] }],
        }),
        NotificationLog.count({ where: { rule_id: rule.id, sent_date: { [Op.gte]: thirtyDaysAgo } } }),
      ]);
      return {
        ...rule.toJSON(),
        last_sent: lastLog?.sent_date ?? null,
        last_sent_student: lastLog?.user?.name ?? null,
        trigger_count_30d: triggerCount,
      };
    }));

    res.json({ rules: enriched });
  } catch (err) {
    console.error('[GET /admin/notification-rules]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/notification-rules', async (req, res) => {
  try {
    const { type, threshold, target_user_id, label } = req.body;
    if (!['articles_remaining', 'articles_percentage'].includes(type)) {
      return res.status(400).json({ error: 'type must be articles_remaining or articles_percentage' });
    }
    const n = parseInt(threshold, 10);
    if (isNaN(n) || n < 1) return res.status(400).json({ error: 'threshold must be a positive integer' });
    if (type === 'articles_percentage' && n > 100) {
      return res.status(400).json({ error: 'percentage threshold cannot exceed 100' });
    }
    const rule = await NotificationRule.create({
      type,
      threshold: n,
      target_user_id: target_user_id || null,
      label: label?.trim() || null,
    });
    res.status(201).json({ rule });
  } catch (err) {
    console.error('[POST /admin/notification-rules]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/notification-rules/:id', async (req, res) => {
  try {
    const rule = await NotificationRule.findByPk(req.params.id);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    const allowed = ['is_active', 'threshold', 'label'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) rule[key] = req.body[key];
    }
    await rule.save();
    res.json({ rule });
  } catch (err) {
    console.error('[PATCH /admin/notification-rules/:id]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/notification-rules/:id', async (req, res) => {
  try {
    const rule = await NotificationRule.findByPk(req.params.id);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    await NotificationLog.destroy({ where: { rule_id: rule.id } });
    await rule.destroy();
    res.json({ deleted: true });
  } catch (err) {
    console.error('[DELETE /admin/notification-rules/:id]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/notification-rules/run', async (_req, res) => {
  try {
    const result = await notificationService.checkThresholdRules();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[POST /admin/notification-rules/run]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Legacy scheduled notifications ─────────────────────────────────────────

// Notifications
router.post('/notifications/weekly-reminders', async (_req, res) => {
  try { const r = await notificationService.sendWeeklyRemindersToAll(); res.json({ ok: true, ...r }); }
  catch (err) { console.error('[POST /notifications/weekly-reminders]', err); res.status(500).json({ error: 'Failed to send weekly reminders' }); }
});
router.post('/notifications/inactivity-reminders', async (_req, res) => {
  try { const r = await notificationService.sendInactivityReminders(); res.json({ ok: true, ...r }); }
  catch (err) { console.error('[POST /notifications/inactivity-reminders]', err); res.status(500).json({ error: 'Failed to send inactivity reminders' }); }
});

// Reports
router.use('/reports', require('./reports'));

module.exports = router;
