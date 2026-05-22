const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  createPlanOrder,
  createStorageOrder,
  verifyPayment,
  handleWebhook,
  getBillingStatus,
} = require('../controllers/paymentController');

// Webhook — no auth needed (Razorpay calls this directly)
router.post('/webhook', handleWebhook);

// Authenticated routes
router.post('/create-order/plan',    authenticate, createPlanOrder);
router.post('/create-order/storage', authenticate, createStorageOrder);
router.post('/verify',               authenticate, verifyPayment);
router.get('/status',                authenticate, getBillingStatus);

module.exports = router;
