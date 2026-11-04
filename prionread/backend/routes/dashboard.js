const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { getStudentDashboard } = require('../controllers/dashboardController');

const router = Router();

router.get('/', authenticate, getStudentDashboard);

module.exports = router;
