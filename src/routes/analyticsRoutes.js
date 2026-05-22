const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getOrgAnalytics, getPlatformAnalytics } = require('../controllers/analyticsController');

router.get('/org',      authenticate, getOrgAnalytics);
router.get('/platform', getPlatformAnalytics); // protected by x-platform-key header

module.exports = router;
