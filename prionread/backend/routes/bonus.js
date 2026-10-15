const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { getMyBonus } = require('../controllers/bonusController');

const router = Router();
router.use(authenticate);
router.get('/', getMyBonus);

module.exports = router;
