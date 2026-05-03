const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const {
  getMyArticles,
  getMyArticleDetail,
  markAsRead,
  createOrUpdateSummary,
  getSummary,
  generateAISummary,
  generateEvaluation,
  submitEvaluation,
  getEvaluation,
} = require('../controllers/studentController');

const router = Router();

router.use(authenticate);

// ── Collection ────────────────────────────────────────────────────────────────
router.get('/', getMyArticles);

// ── Per-article: static sub-routes before /:articleId ────────────────────────
// (none currently needed at the collection level)

// ── Per-article ───────────────────────────────────────────────────────────────
router.get('/:articleId', getMyArticleDetail);
router.put('/:articleId/mark-as-read', markAsRead);

// ── Summary sub-resource ──────────────────────────────────────────────────────
router.post('/:articleId/summary', createOrUpdateSummary);
router.get('/:articleId/summary', getSummary);
router.post('/:articleId/generate-ai-summary', generateAISummary);

// ── Evaluation sub-resource ───────────────────────────────────────────────────
router.post('/:articleId/generate-evaluation', generateEvaluation);
router.post('/:articleId/submit-evaluation', submitEvaluation);
router.get('/:articleId/evaluation', getEvaluation);

module.exports = router;
