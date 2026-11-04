const { Router } = require('express');
const { authenticate, requireAdmin } = require('../middleware/auth');
const {
  getUsers,
  getUserById,
  updateUser,
  deleteUser,
  bulkCreateUsers,
} = require('../controllers/userController');

const router = Router();

// All user management routes require authentication + admin role
router.use(authenticate, requireAdmin);

router.get('/', getUsers);
router.post('/bulk-create', bulkCreateUsers);
router.get('/:id', getUserById);
router.put('/:id', updateUser);
router.delete('/:id', deleteUser);

module.exports = router;
