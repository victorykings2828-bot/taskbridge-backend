const crypto   = require('crypto');
const Razorpay = require('razorpay');
const Organization = require('../models/Organization');
const User         = require('../models/User');
const AuditLog     = require('../models/AuditLog');
const Notification = require('../models/Notification');

// Lazily create the Razorpay client. If keys aren't configured, return null so
// payment endpoints fail gracefully (503) instead of crashing the whole server
// at startup.
let _razorpay = null;
const getRazorpay = () => {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return null;
  if (!_razorpay) {
    _razorpay = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return _razorpay;
};
const PAYMENTS_DISABLED = { success: false, message: 'Payments are not configured yet. Please try again later.' };

const fmtBytes = (b) => {
  if (!b) return '0 B';
  if (b < 1024**3) return `${(b/1024**2).toFixed(0)} MB`;
  return `${(b/1024**3).toFixed(0)} GB`;
};

// Plan prices in paise (1 INR = 100 paise).
// Enterprise is a custom, sales-led plan (contact us) — not self-serve purchasable.
const PLAN_PRICES = {
  pro: { amount: 1249 * 100, name: 'TaskBridge Pro', tier: 'pro' }, // ₹1249/month
};

// Extra storage price
const STORAGE_PRICE_PER_5GB = 125 * 100; // ₹125 per 5 GB

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/create-order/plan
// Creates a Razorpay order for a plan upgrade
// ─────────────────────────────────────────────────────────────────────────────
const createPlanOrder = async (req, res) => {
  try {
    const razorpay = getRazorpay();
    if (!razorpay) return res.status(503).json(PAYMENTS_DISABLED);

    const { tier } = req.body;
    if (!PLAN_PRICES[tier])
      return res.status(400).json({ success: false, message: 'Invalid plan' });

    const user = await User.findById(req.user._id);
    if (user.role !== 'super_admin')
      return res.status(403).json({ success: false, message: 'Only admins can manage billing' });

    const org = await Organization.findById(user.organizationId);
    if (!org) return res.status(404).json({ success: false, message: 'Organisation not found' });

    const plan = PLAN_PRICES[tier];

    const order = await razorpay.orders.create({
      amount:   plan.amount,
      currency: 'INR',
      receipt:  `plan_${org._id}_${Date.now()}`,
      notes: {
        organizationId: org._id.toString(),
        userId:         user._id.toString(),
        type:           'plan_upgrade',
        tier,
        orgName:        org.name,
        userEmail:      user.email,
      },
    });

    res.json({
      success:  true,
      orderId:  order.id,
      amount:   plan.amount,
      currency: 'INR',
      name:     plan.name,
      description: `${tier === 'pro' ? '5 managers, 100 employees/manager' : 'Unlimited managers & employees'} — monthly`,
      keyId:    process.env.RAZORPAY_KEY_ID,
      prefill: { name: user.name, email: user.email },
    });
  } catch (err) {
    // Razorpay SDK errors carry the real reason in err.error.description.
    console.error('createPlanOrder FAILED:', err?.error?.description || err.message, '| statusCode:', err?.statusCode);
    res.status(502).json({ success: false, message: err?.error?.description || 'Could not start payment. Check Razorpay configuration.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/create-order/storage
// Creates a Razorpay order for extra storage
// ─────────────────────────────────────────────────────────────────────────────
const createStorageOrder = async (req, res) => {
  try {
    const razorpay = getRazorpay();
    if (!razorpay) return res.status(503).json(PAYMENTS_DISABLED);

    const extraGB = parseInt(req.body.extraGB, 10);
    if (!extraGB || extraGB < 5 || extraGB % 5 !== 0 || extraGB > 500)
      return res.status(400).json({ success: false, message: 'Must be a multiple of 5 GB (5–500 GB)' });

    const user = await User.findById(req.user._id);
    if (user.role !== 'super_admin')
      return res.status(403).json({ success: false, message: 'Only admins can manage billing' });

    const org = await Organization.findById(user.organizationId);
    if (!org) return res.status(404).json({ success: false, message: 'Organisation not found' });
    if (org.subscriptionTier === 'free')
      return res.status(403).json({ success: false, message: 'Extra storage requires Pro or Enterprise plan' });

    const units  = extraGB / 5;
    const amount = STORAGE_PRICE_PER_5GB * units;

    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt:  `storage_${org._id}_${Date.now()}`,
      notes: {
        organizationId: org._id.toString(),
        userId:         user._id.toString(),
        type:           'storage_purchase',
        extraGB:        extraGB.toString(),
      },
    });

    res.json({
      success:     true,
      orderId:     order.id,
      amount,
      currency:    'INR',
      name:        `TaskBridge Extra Storage`,
      description: `${extraGB} GB additional storage — monthly`,
      keyId:       process.env.RAZORPAY_KEY_ID,
      prefill:     { name: user.name, email: user.email },
    });
  } catch (err) {
    console.error('createStorageOrder FAILED:', err?.error?.description || err.message, '| statusCode:', err?.statusCode);
    res.status(502).json({ success: false, message: err?.error?.description || 'Could not start payment. Check Razorpay configuration.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/verify
// Called by frontend after Razorpay payment — verifies signature and upgrades
// ─────────────────────────────────────────────────────────────────────────────
const verifyPayment = async (req, res) => {
  try {
    const razorpay = getRazorpay();
    if (!razorpay) return res.status(503).json(PAYMENTS_DISABLED);

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ success: false, message: 'Missing payment details' });

    // Verify signature — HMAC SHA256
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature)
      return res.status(400).json({ success: false, message: 'Payment verification failed. Please contact support.' });

    // Fetch order details from Razorpay to get notes
    const order = await razorpay.orders.fetch(razorpay_order_id);
    const notes = order.notes || {};

    if (!notes.organizationId)
      return res.status(400).json({ success: false, message: 'Invalid order' });

    const org = await Organization.findById(notes.organizationId);
    if (!org) return res.status(404).json({ success: false, message: 'Organisation not found' });
    if (org._id.toString() !== req.user.organizationId?.toString() || notes.userId !== req.user._id.toString())
      return res.status(403).json({ success: false, message: 'Payment order does not belong to this account' });

    const alreadyApplied = await AuditLog.findOne({
      action: { $in: ['SUBSCRIPTION_UPGRADED', 'STORAGE_PURCHASED'] },
      'details.paymentId': razorpay_payment_id,
    });
    if (alreadyApplied)
      return res.status(409).json({ success: false, message: 'This payment has already been applied' });

    // ── Plan upgrade ──────────────────────────────────────────────────────
    if (notes.type === 'plan_upgrade' && notes.tier) {
      org.subscriptionTier     = notes.tier;
      org.subscriptionStatus   = 'active';
      org.subscriptionExpiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000); // 30 days
      org.razorpayPaymentId    = razorpay_payment_id;
      org.applyTierLimits();
      await org.save();

      await User.updateMany({ organizationId: org._id }, { subscriptionTier: notes.tier });
      await AuditLog.create({
        performedBy: notes.userId, action: 'SUBSCRIPTION_UPGRADED',
        targetModel: 'Organization', targetId: org._id,
        details: { tier: notes.tier, via: 'razorpay', paymentId: razorpay_payment_id },
      });
      await Notification.create({
        recipient: notes.userId, type: 'system',
        title: `Plan upgraded to ${notes.tier}! 🎉`,
        message: `Your workspace is now on the ${notes.tier} plan. Enjoy your new features!`,
      });

      console.log(`✅ Plan upgraded: org=${notes.organizationId} tier=${notes.tier}`);
      return res.json({ success: true, message: `Successfully upgraded to ${notes.tier} plan!`, type: 'plan_upgrade', tier: notes.tier });
    }

    // ── Storage purchase ──────────────────────────────────────────────────
    if (notes.type === 'storage_purchase' && notes.extraGB) {
      const gb = parseInt(notes.extraGB, 10);
      org.storage.extraGBPurchased = (org.storage.extraGBPurchased || 0) + gb;
      org.applyTierLimits();
      await org.save();

      await AuditLog.create({
        performedBy: notes.userId, action: 'STORAGE_PURCHASED',
        targetModel: 'Organization', targetId: org._id,
        details: { extraGB: gb, via: 'razorpay', paymentId: razorpay_payment_id },
      });
      await Notification.create({
        recipient: notes.userId, type: 'system',
        title: `${gb} GB storage added! 💾`,
        message: `Your storage limit is now ${fmtBytes(org.limits.storageLimitBytes)}.`,
      });

      console.log(`✅ Storage added: org=${notes.organizationId} +${gb}GB`);
      return res.json({ success: true, message: `${gb} GB storage added successfully!`, type: 'storage_purchase', extraGB: gb });
    }

    res.status(400).json({ success: false, message: 'Unknown payment type' });
  } catch (err) {
    console.error('verifyPayment:', err.message);
    res.status(500).json({ success: false, message: 'Payment verification failed' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/webhook  (Razorpay webhook for recurring/refunds)
// ─────────────────────────────────────────────────────────────────────────────
const handleWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const secret    = process.env.RAZORPAY_WEBHOOK_SECRET;
    const rawBody   = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));

    if (secret) {
      const expected = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');
      if (expected !== signature)
        return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    const body    = Buffer.isBuffer(req.body) ? JSON.parse(rawBody.toString('utf8')) : req.body;
    const event   = body.event;
    const payload = body.payload;

    console.log(`Razorpay webhook: ${event}`);

    if (event === 'payment.captured') {
      // Payment confirmed — already handled by /verify endpoint
      // This is just a backup confirmation
    }

    if (event === 'subscription.charged') {
      // Recurring subscription renewed
      const sub   = payload.subscription?.entity;
      const notes = sub?.notes || {};
      if (notes.organizationId) {
        await Organization.findByIdAndUpdate(notes.organizationId, {
          subscriptionStatus:    'active',
          subscriptionExpiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        });
      }
    }

    if (event === 'subscription.cancelled') {
      const sub   = payload.subscription?.entity;
      const notes = sub?.notes || {};
      if (notes.organizationId) {
        const org = await Organization.findById(notes.organizationId);
        if (org) {
          org.subscriptionTier   = 'free';
          org.subscriptionStatus = 'cancelled';
          org.applyTierLimits();
          await org.save();
          await User.updateMany({ organizationId: org._id }, { subscriptionTier: 'free' });
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Razorpay webhook error:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/status
// ─────────────────────────────────────────────────────────────────────────────
const getBillingStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const org  = await Organization.findById(user.organizationId)
      .select('subscriptionTier subscriptionStatus subscriptionExpiresAt storage limits');
    if (!org) return res.status(404).json({ success: false, message: 'Organisation not found' });
    if (org.checkAndApplyExpiry()) {
      await org.save();
      await User.updateMany({ organizationId: org._id }, { subscriptionTier: 'free' });
    }

    res.json({
      success: true,
      billing: {
        tier:             org.subscriptionTier,
        status:           org.subscriptionStatus,
        expiresAt:        org.subscriptionExpiresAt,
        storageUsed:      fmtBytes(org.storage?.usedBytes || 0),
        storageLimit:     fmtBytes(org.limits?.storageLimitBytes || 0),
        extraGBPurchased: org.storage?.extraGBPurchased || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch billing status' });
  }
};

module.exports = { createPlanOrder, createStorageOrder, verifyPayment, handleWebhook, getBillingStatus };
