const express = require('express');
const router = express.Router();
const { authenticate, authorize, requirePasswordChanged } = require('../middleware/auth');
const {
  registerOrganization, joinOrganization, joinWithCode,
  createInvite, acceptInvite, listInvites, revokeInvite,
  getMyOrganization, upgradePlan,
  purchaseExtraStorage, cleanStorage, rotateJoinCode,
  getPlans,
} = require('../controllers/orgController');

// Public
router.post('/register',       registerOrganization);
router.get('/plans',           getPlans);
router.post('/invite/accept',  acceptInvite);  // accept invite (creates account)
router.post('/join-with-code', joinWithCode);  // employee self-registration with company code

// Authenticated
router.post('/join',           authenticate, joinOrganization);
router.get('/me',              authenticate, requirePasswordChanged, getMyOrganization);
router.post('/upgrade',        authenticate, requirePasswordChanged, authorize('super_admin'), upgradePlan);
router.post('/storage/extra',  authenticate, requirePasswordChanged, authorize('super_admin'), purchaseExtraStorage);
router.delete('/storage/clean',authenticate, requirePasswordChanged, authorize('super_admin'), cleanStorage);
router.post('/joincode/rotate',authenticate, requirePasswordChanged, authorize('super_admin'), rotateJoinCode);
router.post('/invite',         authenticate, requirePasswordChanged, authorize('super_admin'), createInvite);
router.get('/invites',         authenticate, requirePasswordChanged, authorize('super_admin'), listInvites);
router.delete('/invites/:id',  authenticate, requirePasswordChanged, authorize('super_admin'), revokeInvite);

module.exports = router;
