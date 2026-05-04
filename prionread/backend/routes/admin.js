const { Router } = require('express');
const crypto = require('crypto');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { getGlobalDashboard } = require('../controllers/adminDashboardController');
const { getUserDetailedStats, exportUsersCSV, resetUserPassword, sendReminderToUser } = require('../controllers/adminUserController');
const { getArticlesAnalytics, getAssignmentsMatrix, getArticleEngagement, assignArticleToAll } = require('../controllers/adminArticleController');
const { verifyArticlePDFs, syncDropboxPDFs } = require('../controllers/articleController');
const { findDuplicateArticles } = require('../controllers/adminArticleController');
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
