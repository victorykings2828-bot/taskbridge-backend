const express = require('express');
const router = express.Router();
const { getAuditLogs } = require('../controllers/auditController');
const { authenticate, authorize, requirePasswordChanged } = require('../middleware/auth');

router.use(authenticate, requirePasswordChanged);
router.get('/', authorize('super_admin'), getAuditLogs);

module.exports = router;
