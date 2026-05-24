const express = require('express');
const router = express.Router();
const { authenticate, authorize, requirePasswordChanged } = require('../middleware/auth');
const {
  registerOrganization,
  getMyOrganization, upgradePlan,
  purchaseExtraStorage, cleanStorage,
  getPlans,
} = require('../controllers/orgController');

// Public — super admin creates a new company/workspace
router.post('/register',       registerOrganization);
router.get('/plans',           getPlans);

// Authenticated
router.get('/me',              authenticate, requirePasswordChanged, getMyOrganization);
router.post('/upgrade',        authenticate, requirePasswordChanged, authorize('super_admin'), upgradePlan);
router.post('/storage/extra',  authenticate, requirePasswordChanged, authorize('super_admin'), purchaseExtraStorage);
router.delete('/storage/clean',authenticate, requirePasswordChanged, authorize('super_admin'), cleanStorage);

module.exports = router;
