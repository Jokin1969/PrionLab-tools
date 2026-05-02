const { Router } = require('express');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { upload, handleUploadError } = require('../middleware/upload');
const {
  fetchMetadata,
  uploadArticlePDF,
  getDownloadLink,
  deleteArticlePDF,
  listDropboxFiles,
} = require('../controllers/articleController');

const router = Router();

// ── Metadata lookup (admin only, no DB write) ─────────────────────────────────
router.post('/fetch-metadata', authenticate, requireAdmin, fetchMetadata);

// ── Dropbox file browser (admin only) ────────────────────────────────────────
// Registered before /:id routes to avoid shadowing
router.get('/dropbox/files', authenticate, requireAdmin, listDropboxFiles);

// ── Per-article PDF management ────────────────────────────────────────────────
// Upload: admin only; multer runs first, then the error handler, then the controller
router.post(
  '/:id/pdf',
  authenticate,
  requireAdmin,
  upload.single('pdf'),
  handleUploadError,
  uploadArticlePDF
);

// Download link: any authenticated user can fetch a link for their own reading
router.get('/:id/pdf/link', authenticate, getDownloadLink);

// Delete PDF: admin only
router.delete('/:id/pdf', authenticate, requireAdmin, deleteArticlePDF);

module.exports = router;
