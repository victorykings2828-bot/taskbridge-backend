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
router.post('/', authorize('super_admin', 'manager'), createTask);
router.put('/:id', authorize('super_admin', 'manager'), editTask);
router.delete('/:id', authorize('super_admin', 'manager'), cancelTask);
// Assignees act on their own tasks. A manager can be an assignee (assigned by
// super admin), so these allow both employee and manager roles; the controller
// enforces that the requester is the actual assignee.
router.put('/:id/status', authorize('employee', 'manager'), updateTaskStatus);
router.put('/:id/accept', authorize('employee', 'manager'), acceptOrFlagTask);
router.put('/:id/review', authorize('super_admin', 'manager'), reviewTask);
router.put('/:id/extension', authorize('employee', 'manager'), requestExtension);
router.put('/:id/extension/review', authorize('super_admin', 'manager'), reviewExtension);
router.post('/:id/upload', authorize('super_admin', 'manager'), upload.single('file'), uploadTaskFile);
router.post('/:id/deliverables', authorize('employee', 'manager'), upload.single('file'), uploadDeliverable);

module.exports = router;
