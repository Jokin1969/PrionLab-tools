const { Router } = require('express');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { upload, handleUploadError } = require('../middleware/upload');
const {
  createArticle,
  getArticles,
  getArticleById,
  updateArticle,
  deleteArticle,
  generateDownloadLinkHandler,
  fetchMetadata,
  uploadArticlePDF,
  getDownloadLink,
  deleteArticlePDF,
  listDropboxFiles,
} = require('../controllers/articleController');

const router = Router();

// ── Static routes first (must come before /:id) ───────────────────────────────

router.post('/fetch-metadata', authenticate, requireAdmin, fetchMetadata);
router.get('/dropbox/files', authenticate, requireAdmin, listDropboxFiles);

// ── Collection routes ─────────────────────────────────────────────────────────

// Create: may include PDF — multer runs then error handler then controller
router.post(
  '/',
  authenticate,
  requireAdmin,
  upload.single('pdf'),
  handleUploadError,
  createArticle
);

router.get('/', authenticate, getArticles);

// ── Per-article routes ────────────────────────────────────────────────────────

router.get('/:id', authenticate, getArticleById);

// Update: may include replacement PDF
router.put(
  '/:id',
  authenticate,
  requireAdmin,
  upload.single('pdf'),
  handleUploadError,
  updateArticle
);

router.delete('/:id', authenticate, requireAdmin, deleteArticle);

// Download link (POST so it's not cached by browsers/proxies)
router.post('/:id/download-link', authenticate, generateDownloadLinkHandler);

// ── Ratings sub-resource ──────────────────────────────────────────────────────
// Mounts GET|POST|DELETE /api/articles/:articleId/rate(s)
// The ratings router uses mergeParams:true to inherit :id as :articleId
router.use('/:articleId/ratings', require('./ratings'));
router.use('/:articleId/rate', require('./ratings'));

// ── PDF-specific sub-routes ───────────────────────────────────────────────────

router.post(
  '/:id/pdf',
  authenticate,
  requireAdmin,
  upload.single('pdf'),
  handleUploadError,
  uploadArticlePDF
);

router.get('/:id/pdf/link', authenticate, getDownloadLink);
router.delete('/:id/pdf', authenticate, requireAdmin, deleteArticlePDF);

module.exports = router;
