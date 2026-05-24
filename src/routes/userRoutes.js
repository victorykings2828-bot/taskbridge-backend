const express = require('express');
const router = express.Router();
const { createUser, getUsers, getUserById, updateUser, getDashboardStats } = require('../controllers/userController');
const { authenticate, authorize, requirePasswordChanged } = require('../middleware/auth');

router.use(authenticate, requirePasswordChanged);

router.get('/stats', getDashboardStats);
router.post('/', authorize('super_admin', 'manager'), createUser);
router.get('/', authorize('super_admin', 'manager'), getUsers);
router.get('/:id', getUserById);
router.put('/:id', authorize('super_admin', 'manager'), updateUser);

module.exports = router;
