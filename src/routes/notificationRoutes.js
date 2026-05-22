const express = require('express');
const router = express.Router();
const { getNotifications, markAsRead, markAllAsRead } = require('../controllers/notificationController');
const { authenticate, requirePasswordChanged } = require('../middleware/auth');

router.use(authenticate, requirePasswordChanged);
router.get('/', getNotifications);
router.put('/read-all', markAllAsRead);
router.put('/:id/read', markAsRead);

module.exports = router;
