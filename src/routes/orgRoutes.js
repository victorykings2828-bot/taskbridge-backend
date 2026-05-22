const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  registerOrganization, joinOrganization,
  createInvite, acceptInvite, listInvites, revokeInvite,
  getMyOrganization, upgradePlan,
  purchaseExtraStorage, cleanStorage, rotateJoinCode,
  getPlans,
} = require('../controllers/orgController');

// Public
router.post('/register',       registerOrganization);
router.get('/plans',           getPlans);
router.post('/invite/accept',  acceptInvite);  // accept invite (creates account)

// Authenticated
router.post('/join',           authenticate, joinOrganization);
router.get('/me',              authenticate, getMyOrganization);
router.post('/upgrade',        authenticate, upgradePlan);
router.post('/storage/extra',  authenticate, purchaseExtraStorage);
router.delete('/storage/clean',authenticate, cleanStorage);
router.post('/joincode/rotate',authenticate, rotateJoinCode);
router.post('/invite',         authenticate, createInvite);
router.get('/invites',         authenticate, listInvites);
router.delete('/invites/:id',  authenticate, revokeInvite);

module.exports = router;
