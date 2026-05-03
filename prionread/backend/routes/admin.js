const { Router } = require('express');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { getGlobalDashboard } = require('../controllers/adminDashboardController');
const { getUserDetailedStats, exportUsersCSV, resetUserPassword, sendReminderToUser } = require('../controllers/adminUserController');
const { getArticlesAnalytics, getAssignmentsMatrix, getArticleEngagement, assignArticleToAll } = require('../controllers/adminArticleController');
const notificationService = require('../services/notificationService');

const router = Router();
router.use(authenticate, requireAdmin);

// Dashboard
router.get('/dashboard', getGlobalDashboard);

// User management
router.get('/users/export',                    exportUsersCSV);
router.get('/users/:userId/detailed-stats',    getUserDetailedStats);
router.post('/users/:userId/reset-password',   resetUserPassword);
router.post('/users/:userId/send-reminder',    sendReminderToUser);

// Article analytics — static routes BEFORE /:articleId
router.get('/articles/analytics',           getArticlesAnalytics);
router.get('/articles/assignments-matrix',  getAssignmentsMatrix);

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
