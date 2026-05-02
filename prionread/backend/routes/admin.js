const { Router } = require('express');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { getGlobalDashboard } = require('../controllers/adminDashboardController');
const {
  getUserDetailedStats,
  exportUsersCSV,
  resetUserPassword,
  sendReminderToUser,
} = require('../controllers/adminUserController');
const {
  getArticlesAnalytics,
  getArticleEngagement,
  assignArticleToAll,
} = require('../controllers/adminArticleController');

const router = Router();

router.use(authenticate, requireAdmin);

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/dashboard', getGlobalDashboard);

// ── User management ───────────────────────────────────────────────────────────
// Static routes before /:userId to avoid shadowing
router.get('/users/export', exportUsersCSV);

router.get('/users/:userId/detailed-stats', getUserDetailedStats);
router.post('/users/:userId/reset-password', resetUserPassword);
router.post('/users/:userId/send-reminder', sendReminderToUser);

// ── Article analytics ─────────────────────────────────────────────────────────
// Static routes before /:articleId
router.get('/articles/analytics', getArticlesAnalytics);

router.get('/articles/:articleId/engagement', getArticleEngagement);
router.post('/articles/:articleId/assign-to-all', assignArticleToAll);

module.exports = router;
