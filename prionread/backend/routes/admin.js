const { Router } = require('express');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { getGlobalDashboard } = require('../controllers/adminDashboardController');
const {
  getUserDetailedStats,
  exportUsersCSV,
  resetUserPassword,
  sendReminderToUser,
} = require('../controllers/adminUserController');

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

module.exports = router;
