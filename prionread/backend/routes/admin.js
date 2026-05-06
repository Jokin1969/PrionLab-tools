const { Router } = require('express');
const crypto = require('crypto');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { getGlobalDashboard } = require('../controllers/adminDashboardController');
const { getUserDetailedStats, exportUsersCSV, resetUserPassword, sendReminderToUser } = require('../controllers/adminUserController');
const { getArticlesAnalytics, getAssignmentsMatrix, getArticleEngagement, assignArticleToAll, findDuplicateArticles, getSyncStatus } = require('../controllers/adminArticleController');
const { verifyArticlePDFs, syncDropboxPDFs } = require('../controllers/articleController');
const notificationService = require('../services/notificationService');
const emailService = require('../services/emailService');
const { User } = require('../models');

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
    user.welcome_email_sent_at = new Date();
    await user.save();

    await emailService.sendOnboardingEmail(user, tempPassword);

    res.json({ ok: true, welcome_email_sent_at: user.welcome_email_sent_at, tempPassword });
  } catch (err) {
    console.error('[POST /admin/users/:userId/send-welcome]', err);
    res.status(500).json({ error: 'Error enviando email de bienvenida' });
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

// Mark "only in PrionRead" articles as pending in PrionVault pipeline,
// auto-linking Dropbox PDFs that already exist at the expected path.
router.post('/sync/mark-pending', async (_req, res) => {
  const { sequelize: sq } = require('../models');
  const { dropboxPath, listFiles } = require('../services/dropbox');

  // Verify PrionVault columns exist
  try {
    await sq.query("SELECT extraction_status, source FROM articles LIMIT 0");
  } catch {
    return res.status(409).json({ error: 'PrionVault columns not yet migrated. Run the migration first.' });
  }

  try {
    // Find qualifying articles: assigned to students, no PDF processed yet
    const rows = await sq.query(
      `SELECT id, doi, pubmed_id, dropbox_path, source FROM articles
       WHERE id IN (SELECT DISTINCT article_id FROM user_articles)
         AND (pdf_md5 IS NULL)
         AND (extraction_status IS NULL OR extraction_status = 'pending')`,
      { type: sq.QueryTypes.SELECT }
    );

    if (!rows.length) return res.json({ ok: true, updated: 0, pdfs_linked: 0, needs_pdf: 0 });

    // Scan Dropbox once — build a lowercase-path → real-path map
    let fileMap = new Map();
    try {
      const files = await listFiles();
      for (const f of files) fileMap.set(f.path.toLowerCase(), f.path);
    } catch {
      // Dropbox unavailable — continue without PDF auto-linking
    }

    let pdfsLinked = 0;
    let needsPdf = 0;

    for (const row of rows) {
      let newDropboxPath = null;

      if (!row.dropbox_path) {
        const expected = dropboxPath(row);
        if (fileMap.has(expected.toLowerCase())) {
          newDropboxPath = expected;
          pdfsLinked++;
        } else {
          needsPdf++;
        }
      }

      await sq.query(
        `UPDATE articles
         SET extraction_status = 'pending',
             source = COALESCE(NULLIF(source, ''), 'prionread')
             ${newDropboxPath ? ", dropbox_path = :dp, dropbox_link = NULL" : ""}
         WHERE id = :id`,
        {
          replacements: { id: row.id, ...(newDropboxPath ? { dp: newDropboxPath } : {}) },
          type: sq.QueryTypes.UPDATE,
        }
      );
    }

    res.json({ ok: true, updated: rows.length, pdfs_linked: pdfsLinked, needs_pdf: needsPdf });
  } catch (err) {
    console.error('[POST /admin/sync/mark-pending]', err);
    res.status(500).json({ error: 'Error marking articles as pending' });
  }
});

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
