const express = require('express');
const router = express.Router({ mergeParams: true }); // mergeParams to access :taskId
const { getComments, addComment, deleteComment } = require('../controllers/commentController');
const { authenticate, requirePasswordChanged } = require('../middleware/auth');

router.use(authenticate, requirePasswordChanged);

router.get('/', getComments);
router.post('/', addComment);
router.delete('/:commentId', deleteComment);

module.exports = router;
