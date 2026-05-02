const { Router } = require('express');
const router = Router();

router.use('/auth', require('./auth'));
router.use('/users', require('./users'));

router.get('/', (_req, res) => res.json({ message: 'PrionRead API v1' }));

module.exports = router;
