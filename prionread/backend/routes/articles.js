const { Router } = require('express');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { fetchMetadata } = require('../controllers/articleController');

const router = Router();

// Metadata lookup — admin only, does not persist anything
router.post('/fetch-metadata', authenticate, requireAdmin, fetchMetadata);

module.exports = router;
