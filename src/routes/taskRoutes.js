const express = require('express');
const router = express.Router();
const {
  createTask, getTasks, getTaskById,
  updateTaskStatus, acceptOrFlagTask, reviewTask,
  requestExtension, reviewExtension,
  editTask, cancelTask, getWorkload,
  uploadTaskFile, uploadDeliverable,
} = require('../controllers/taskController');
const { authenticate, authorize, requirePasswordChanged } = require('../middleware/auth');
const { upload } = require('../middleware/upload');

router.use(authenticate, requirePasswordChanged);

router.get('/workload', authorize('manager'), getWorkload);
router.get('/', getTasks);
router.get('/:id', getTaskById);
router.post('/', authorize('manager'), createTask);
router.put('/:id', authorize('manager'), editTask);
router.delete('/:id', authorize('manager'), cancelTask);
router.put('/:id/status', authorize('employee'), updateTaskStatus);
router.put('/:id/accept', authorize('employee'), acceptOrFlagTask);
router.put('/:id/review', authorize('manager'), reviewTask);
router.put('/:id/extension', authorize('employee'), requestExtension);
router.put('/:id/extension/review', authorize('manager'), reviewExtension);
router.post('/:id/upload', authorize('manager'), upload.single('file'), uploadTaskFile);
router.post('/:id/deliverables', authorize('employee'), upload.single('file'), uploadDeliverable);

module.exports = router;
