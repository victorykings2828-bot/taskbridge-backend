const express = require('express');
const router = express.Router();
const {
  getSystemOverview,
  getAllManagers,
  getManagerProfile,
  getAllEmployees,
  getEmployeeProfile,
  adminGiveFeedback,
  notifyAll,
} = require('../controllers/adminController');
const { authenticate, authorize, requirePasswordChanged } = require('../middleware/auth');

router.use(authenticate, requirePasswordChanged, authorize('super_admin'));

router.get('/overview',              getSystemOverview);
router.get('/managers',              getAllManagers);
router.get('/managers/:id/profile',  getManagerProfile);
router.get('/employees',             getAllEmployees);
router.get('/employees/:id/profile', getEmployeeProfile);
router.post('/feedback',             adminGiveFeedback);
router.post('/notify-all',           notifyAll);

module.exports = router;
