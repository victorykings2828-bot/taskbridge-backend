const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      maxlength: [100, 'Name cannot exceed 100 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'],
    },
    password: {
      type: String,
      minlength: [8, 'Password must be at least 8 characters'],
      select: false,
      default: null, // null until the user completes account setup
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
    },
    subscriptionTier: {
      type: String,
      enum: ['free', 'pro', 'enterprise'],
      default: 'free',
    },
    role: {
      type: String,
      enum: ['super_admin', 'manager', 'employee'],
      required: true,
    },
    isFirstLogin: {
      type: Boolean,
      default: true,
    },
    // True once the user has set their own password via the setup-account flow.
    // Super admins (who register with a password) are registered immediately.
    isRegistered: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    managerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null, // For employees: their manager
    },
    department: {
      type: String,
      trim: true,
      default: '',
    },
    phone: {
      type: String,
      trim: true,
      default: '',
    },
    avatar: {
      type: String,
      default: '',
    },
    lastLogin: {
      type: Date,
      default: null,
    },
    refreshTokens: [
      {
        token: String, // stored as SHA-256 hash
        createdAt: { type: Date, default: Date.now },
      },
    ],
    loginAttempts: { type: Number, default: 0, select: false },
    lockUntil:     { type: Date,   default: null, select: false },

    // ── Password reset ─────────────────────────────────────────────────────
    passwordResetToken:   { type: String, default: null, select: false },
    passwordResetExpires: { type: Date,   default: null, select: false },

    // ── Account-setup email verification (proves the invitee owns the email) ──
    setupOtpHash:    { type: String, default: null, select: false },
    setupOtpExpires: { type: Date,   default: null, select: false },
  },
  { timestamps: true }
);

// Hash password before saving (skip when password is null — user not set up yet)
userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  // Already a bcrypt hash (e.g. carried over from a verified-registration record)
  // — don't double-hash.
  if (/^\$2[aby]\$/.test(this.password)) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password (returns false if no password set yet)
userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) return false;
  return await bcrypt.compare(candidatePassword, this.password);
};

// Remove sensitive fields from JSON output
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.refreshTokens;
  return obj;
};

// Email is unique PER organization (not globally) — the same person can belong
// to more than one company. organizationId is null only transiently, so the
// partial filter keeps the index valid for real members.
userSchema.index(
  { email: 1, organizationId: 1 },
  { unique: true, partialFilterExpression: { organizationId: { $type: 'objectId' } } }
);

module.exports = mongoose.model('User', userSchema);
