const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { getMyArticles, markAsRead, getMyArticleDetail } = require('../controllers/studentController');

const router = Router();

// All student routes require authentication (any role)
router.use(authenticate);

router.get('/', getMyArticles);
router.get('/:articleId', getMyArticleDetail);
router.put('/:articleId/mark-as-read', markAsRead);

module.exports = router;
