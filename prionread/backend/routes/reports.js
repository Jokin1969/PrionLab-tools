const { Router } = require('express');
const {
  generateGlobalSummary,
  generateStudentProgress,
  generateReadingRecommendations,
} = require('../controllers/reportsController');

const router = Router();
// Auth is applied by the parent admin router

router.get('/global-summary', generateGlobalSummary);
router.get('/student-progress', generateStudentProgress);
router.get('/reading-recommendations', generateReadingRecommendations);

module.exports = router;
