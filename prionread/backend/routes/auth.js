const { Router } = require('express');
const { register, login, getMe, changePassword } = require('../controllers/authController');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = Router();

router.post('/register', authenticate, requireAdmin, register);
router.post('/login', login);
router.get('/me', authenticate, getMe);
router.post('/change-password', authenticate, changePassword);

module.exports = router;
