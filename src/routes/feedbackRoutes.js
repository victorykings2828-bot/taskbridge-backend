const express = require('express');
const router = express.Router();
const { giveFeedback, getFeedback } = require('../controllers/feedbackController');
const { authenticate, requirePasswordChanged } = require('../middleware/auth');

router.use(authenticate, requirePasswordChanged);
router.post('/', giveFeedback);
router.get('/', getFeedback);

module.exports = router;
