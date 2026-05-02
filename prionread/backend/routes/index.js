const { Router } = require('express');
const router = Router();

// Placeholder — feature routes will be mounted here
// e.g. router.use('/auth', require('./auth'));
//      router.use('/articles', require('./articles'));
//      router.use('/users', require('./users'));

router.get('/', (_req, res) => res.json({ message: 'PrionRead API v1' }));

module.exports = router;
