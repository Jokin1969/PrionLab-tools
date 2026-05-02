const { Router } = require('express');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { getGlobalDashboard } = require('../controllers/adminDashboardController');

const router = Router();

router.use(authenticate, requireAdmin);

router.get('/dashboard', getGlobalDashboard);

module.exports = router;
