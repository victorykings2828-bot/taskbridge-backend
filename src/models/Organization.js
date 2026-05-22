const mongoose = require('mongoose');
const crypto = require('crypto');

// Storage limits in bytes
const STORAGE_LIMITS = {
  free:       500  * 1024 * 1024,        // 500 MB
  pro:        10   * 1024 * 1024 * 1024, // 10 GB
  enterprise: 80   * 1024 * 1024 * 1024, // 80 GB
};

const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    slug: { type: String, unique: true, lowercase: true, trim: true },

    // Join code — regenerated each time it is used so it stays one-time
    joinCode:          { type: String, unique: true, uppercase: true },
    joinCodeUsedAt:    { type: Date, default: null },
    joinCodeExpiresAt: { type: Date, default: null }, // null = never expires until used

    industry: { type: String, trim: true, default: '' },
    website:  { type: String, trim: true, default: '' },
    logo:     { type: String, default: '' },

    subscriptionTier: {
      type: String,
      enum: ['free', 'pro', 'enterprise'],
      default: 'free',
    },
    subscriptionStatus: {
      type: String,
      enum: ['active', 'cancelled', 'past_due', 'trialing'],
      default: 'active',
    },
    subscriptionExpiresAt: { type: Date, default: null },

    // ── Limits ────────────────────────────────────────────────────────────
    limits: {
      managers:           { type: Number, default: 1  },
      employeesPerManager:{ type: Number, default: 5  },
      totalEmployees:     { type: Number, default: 5  },
      storageLimitBytes:  { type: Number, default: 500 * 1024 * 1024 },
    },

    // ── Storage tracking ──────────────────────────────────────────────────
    storage: {
      usedBytes:      { type: Number, default: 0 },
      extraGBPurchased:{ type: Number, default: 0 }, // extra GB purchased on top of plan
    },

    ownerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isActive: { type: Boolean, default: true },

    // ── Razorpay ──────────────────────────────────────────────────────────
    razorpayPaymentId:    { type: String, default: null },
    razorpaySubscriptionId: { type: String, default: null },
  },
  { timestamps: true }
);

// ── Pre-save: generate join code + slug ────────────────────────────────────
organizationSchema.pre('save', async function (next) {
  if (!this.joinCode) {
    this.joinCode = _genCode();
    this.joinCodeExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7-day window
  }
  if (!this.slug) {
    const base = this.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    this.slug = `${base}-${crypto.randomBytes(3).toString('hex')}`;
  }
  next();
});

function _genCode() {
  // 8-char alphanumeric code, crypto-random, no ambiguous chars (0/O/I/l)
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(8))
    .map(b => chars[b % chars.length])
    .join('');
}

// ── Instance methods ───────────────────────────────────────────────────────
organizationSchema.methods.applyTierLimits = function () {
  const limits = {
    free:       { managers: 1,   employeesPerManager: 5,   totalEmployees: 5,    storageLimitBytes: STORAGE_LIMITS.free       },
    pro:        { managers: 5,   employeesPerManager: 100, totalEmployees: 500,  storageLimitBytes: STORAGE_LIMITS.pro        },
    enterprise: { managers: 9999,employeesPerManager: 9999,totalEmployees: 9999, storageLimitBytes: STORAGE_LIMITS.enterprise },
  };
  const base = limits[this.subscriptionTier] || limits.free;
  const extraBytes = (this.storage?.extraGBPurchased || 0) * 1024 * 1024 * 1024;
  this.limits = { ...base, storageLimitBytes: base.storageLimitBytes + extraBytes };
};

organizationSchema.methods.rotateJoinCode = function () {
  this.joinCode          = _genCode();
  this.joinCodeUsedAt    = new Date();
  this.joinCodeExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
};

organizationSchema.methods.storageAvailableBytes = function () {
  return Math.max(0, this.limits.storageLimitBytes - (this.storage?.usedBytes || 0));
};

// ── Static helper ──────────────────────────────────────────────────────────
organizationSchema.statics.STORAGE_LIMITS = STORAGE_LIMITS;

module.exports = mongoose.model('Organization', organizationSchema);
