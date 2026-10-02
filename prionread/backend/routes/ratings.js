const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { createOrUpdateRating, getRatings, deleteRating } = require('../controllers/ratingController');

// mergeParams: true allows access to :articleId defined in the parent articles router
const router = Router({ mergeParams: true });

router.get('/', authenticate, getRatings);
router.post('/', authenticate, createOrUpdateRating);
router.delete('/', authenticate, deleteRating);

module.exports = router;
