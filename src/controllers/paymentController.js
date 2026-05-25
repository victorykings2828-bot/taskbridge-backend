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

// Timing-safe hex string comparison — prevents signature oracle attacks.
// Returns false if lengths differ or content differs.
const safeEqual = (a, b) => {
  try {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
};

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

    // Prevent double-upgrade to same tier
    if (org.subscriptionTier === tier)
      return res.status(400).json({ success: false, message: `Already on the ${tier} plan` });

    const plan = PLAN_PRICES[tier];

    const order = await razorpay.orders.create({
      amount:   plan.amount,
      currency: 'INR',
      receipt:  `pl_${org._id.toString().slice(-8)}_${Date.now().toString().slice(-8)}`,
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
      receipt:  `stg_${org._id.toString().slice(-8)}_${Date.now().toString().slice(-8)}`,
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

    // Step 1 — Verify HMAC SHA256 signature using timing-safe comparison.
    // This proves Razorpay generated the response (not a forged frontend request).
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (!safeEqual(expectedSignature, razorpay_signature)) {
      console.warn(`verifyPayment: invalid signature | ip=${req.ip} order=${razorpay_order_id}`);
      return res.status(400).json({ success: false, message: 'Payment verification failed. Please contact support.' });
    }

    // Step 2 — Confirm with Razorpay API that payment is actually captured.
    // Signature verification alone doesn't prove funds were collected — an
    // authorized-but-not-captured payment could still have a valid signature.
    let payment;
    try {
      payment = await razorpay.payments.fetch(razorpay_payment_id);
    } catch (fetchErr) {
      console.error('verifyPayment: failed to fetch payment from Razorpay:', fetchErr?.error?.description || fetchErr.message);
      return res.status(502).json({ success: false, message: 'Could not confirm payment with Razorpay. Please contact support.' });
    }

    if (payment.status !== 'captured') {
      console.warn(`verifyPayment: payment not captured | id=${razorpay_payment_id} status=${payment.status}`);
      return res.status(400).json({ success: false, message: `Payment is not confirmed (status: ${payment.status}). Please contact support.` });
    }

    // Ensure the payment belongs to the order we issued — prevents cross-order replay
    if (payment.order_id !== razorpay_order_id) {
      console.warn(`verifyPayment: payment/order mismatch | payment=${razorpay_payment_id} expected order=${razorpay_order_id} got=${payment.order_id}`);
      return res.status(400).json({ success: false, message: 'Payment does not match the order. Please contact support.' });
    }

    // Step 3 — Fetch order notes and verify amount matches
    const order = await razorpay.orders.fetch(razorpay_order_id);
    const notes = order.notes || {};

    // Payment amount must match the order amount — prevents paying less than required
    if (payment.amount !== order.amount) {
      console.warn(`verifyPayment: amount mismatch | paid=${payment.amount} expected=${order.amount} order=${razorpay_order_id}`);
      return res.status(400).json({ success: false, message: 'Payment amount mismatch. Please contact support.' });
    }

    if (!notes.organizationId)
      return res.status(400).json({ success: false, message: 'Invalid order' });

    // Step 4 — Bind payment to the authenticated user's organisation
    const org = await Organization.findById(notes.organizationId);
    if (!org) return res.status(404).json({ success: false, message: 'Organisation not found' });
    if (org._id.toString() !== req.user.organizationId?.toString() || notes.userId !== req.user._id.toString())
      return res.status(403).json({ success: false, message: 'Payment order does not belong to this account' });

    // Step 5 — Idempotency: reject if this payment was already applied
    const alreadyApplied = await AuditLog.findOne({
      action: { $in: ['SUBSCRIPTION_UPGRADED', 'STORAGE_PURCHASED'] },
      'details.paymentId': razorpay_payment_id,
    });
    if (alreadyApplied)
      return res.status(409).json({ success: false, message: 'This payment has already been applied' });

    // ── Plan upgrade ──────────────────────────────────────────────────────
    if (notes.type === 'plan_upgrade' && notes.tier) {
      // Validate tier is still a known, purchasable plan
      if (!PLAN_PRICES[notes.tier])
        return res.status(400).json({ success: false, message: 'Unknown plan tier in order' });

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
        details: { tier: notes.tier, via: 'razorpay', paymentId: razorpay_payment_id, amountPaise: payment.amount },
      });
      await Notification.create({
        recipient: notes.userId, type: 'system',
        title: `Plan upgraded to ${notes.tier}!`,
        message: `Your workspace is now on the ${notes.tier} plan. Enjoy your new features!`,
      });

      console.log(`✅ Plan upgraded: org=${notes.organizationId} tier=${notes.tier} payment=${razorpay_payment_id}`);
      return res.json({ success: true, message: `Successfully upgraded to ${notes.tier} plan!`, type: 'plan_upgrade', tier: notes.tier });
    }

    // ── Storage purchase ──────────────────────────────────────────────────
    if (notes.type === 'storage_purchase' && notes.extraGB) {
      const gb = parseInt(notes.extraGB, 10);
      if (!gb || gb < 5 || gb % 5 !== 0 || gb > 500)
        return res.status(400).json({ success: false, message: 'Invalid storage amount in order' });

      // Verify the paid amount matches the expected price for this storage amount
      const expectedAmount = STORAGE_PRICE_PER_5GB * (gb / 5);
      if (payment.amount !== expectedAmount) {
        console.warn(`verifyPayment: storage amount mismatch | paid=${payment.amount} expected=${expectedAmount}`);
        return res.status(400).json({ success: false, message: 'Payment amount does not match storage price. Please contact support.' });
      }

      org.storage.extraGBPurchased = (org.storage.extraGBPurchased || 0) + gb;
      org.applyTierLimits();
      await org.save();

      await AuditLog.create({
        performedBy: notes.userId, action: 'STORAGE_PURCHASED',
        targetModel: 'Organization', targetId: org._id,
        details: { extraGB: gb, via: 'razorpay', paymentId: razorpay_payment_id, amountPaise: payment.amount },
      });
      await Notification.create({
        recipient: notes.userId, type: 'system',
        title: `${gb} GB storage added!`,
        message: `Your storage limit is now ${fmtBytes(org.limits.storageLimitBytes)}.`,
      });

      console.log(`✅ Storage added: org=${notes.organizationId} +${gb}GB payment=${razorpay_payment_id}`);
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
// Razorpay calls this directly — no session auth, but MUST have valid HMAC.
// RAZORPAY_WEBHOOK_SECRET is required; if unset all webhooks are rejected.
// ─────────────────────────────────────────────────────────────────────────────

// Only process events we actually handle; ignore everything else.
const KNOWN_WEBHOOK_EVENTS = new Set([
  'payment.captured',
  'payment.failed',
  'subscription.charged',
  'subscription.cancelled',
  'subscription.halted',
]);

const handleWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const secret    = process.env.RAZORPAY_WEBHOOK_SECRET;

    // Webhook secret MUST be configured — no secret → reject all requests.
    // An unconfigured secret would let any caller forge subscription events.
    if (!secret) {
      console.error('handleWebhook: RAZORPAY_WEBHOOK_SECRET not set — rejecting request');
      return res.status(503).json({ error: 'Webhook not configured' });
    }

    if (!signature) {
      console.warn(`handleWebhook: missing X-Razorpay-Signature | ip=${req.ip}`);
      return res.status(400).json({ error: 'Missing webhook signature' });
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));

    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    if (!safeEqual(expected, signature)) {
      console.warn(`handleWebhook: invalid signature | ip=${req.ip}`);
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    const body    = JSON.parse(rawBody.toString('utf8'));
    const event   = body.event;
    const payload = body.payload;

    // Ignore unknown events — respond 200 so Razorpay stops retrying
    if (!KNOWN_WEBHOOK_EVENTS.has(event)) {
      console.log(`handleWebhook: ignoring unknown event '${event}'`);
      return res.json({ received: true });
    }

    console.log(`handleWebhook: processing event '${event}'`);

    if (event === 'payment.captured') {
      // payment.captured is already handled by /verify; this is a safety net
      // for cases where the user closed the browser before /verify was called.
      const pay   = payload.payment?.entity;
      const ordId = pay?.order_id;
      if (ordId) {
        // Fetch order notes to resolve the org
        const razorpay = getRazorpay();
        if (razorpay) {
          try {
            const order = await razorpay.orders.fetch(ordId);
            const notes = order.notes || {};
            if (notes.organizationId && notes.type === 'plan_upgrade' && notes.tier && PLAN_PRICES[notes.tier]) {
              const already = await AuditLog.findOne({
                action: 'SUBSCRIPTION_UPGRADED',
                'details.paymentId': pay.id,
              });
              if (!already) {
                const org = await Organization.findById(notes.organizationId);
                if (org) {
                  org.subscriptionTier      = notes.tier;
                  org.subscriptionStatus    = 'active';
                  org.subscriptionExpiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000);
                  org.razorpayPaymentId     = pay.id;
                  org.applyTierLimits();
                  await org.save();
                  await User.updateMany({ organizationId: org._id }, { subscriptionTier: notes.tier });
                  await AuditLog.create({
                    performedBy: notes.userId, action: 'SUBSCRIPTION_UPGRADED',
                    targetModel: 'Organization', targetId: org._id,
                    details: { tier: notes.tier, via: 'razorpay_webhook', paymentId: pay.id, amountPaise: pay.amount },
                  });
                  console.log(`✅ Webhook fallback applied plan upgrade: org=${notes.organizationId} tier=${notes.tier}`);
                }
              }
            }
          } catch (e) {
            console.error('handleWebhook payment.captured fallback error:', e.message);
          }
        }
      }
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
        console.log(`✅ Subscription renewed: org=${notes.organizationId}`);
      }
    }

    if (event === 'subscription.cancelled' || event === 'subscription.halted') {
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
          console.log(`⚠️  Subscription ${event}: org=${notes.organizationId} downgraded to free`);
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('handleWebhook error:', err.message);
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
