const { Router } = require('express');
const { authenticate, requireAdmin } = require('../middleware/auth');
const {
  assignArticles,
  bulkAssign,
  getAssignmentsByUser,
  removeAssignment,
} = require('../controllers/assignmentController');

const router = Router();

// All assignment management is admin-only
router.use(authenticate, requireAdmin);

// Static routes before /:id
router.post('/bulk', bulkAssign);
router.get('/user/:userId', getAssignmentsByUser);

router.post('/', assignArticles);
router.delete('/:id', removeAssignment);

module.exports = router;
