const { Router } = require('express');
const router = Router();

router.use('/admin', require('./admin'));
router.use('/auth', require('./auth'));
router.use('/users', require('./users'));
router.use('/articles', require('./articles'));
router.use('/assignments', require('./assignments'));
router.use('/my-articles', require('./student'));
router.use('/my-dashboard', require('./dashboard'));
router.use('/my-bonus', require('./bonus'));

// Journal Club file URL lives at the API root so the URL stays
// /api/jc/files/:fileId/url rather than nested under /articles.
router.use('/jc', require('./jc').fileScoped);

router.get('/', (_req, res) => res.json({ message: 'PrionRead API v1' }));

module.exports = router;
