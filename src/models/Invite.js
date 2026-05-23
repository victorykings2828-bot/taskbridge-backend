const mongoose = require('mongoose');
const crypto = require('crypto');

const inviteSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    role: {
      type: String,
      enum: ['manager', 'employee'],
      default: 'employee',
    },
    // The invite code — cryptographically random, single-use
    code: {
      type: String,
      unique: true,
      required: true,
    },
    codeHash: {
      type: String, // SHA-256 of the code — stored instead of plaintext
      unique: true,
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'expired', 'revoked'],
      default: 'pending',
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
    acceptedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // How many times someone attempted an invalid code (brute-force guard)
    attempts: {
      type: Number,
      default: 0,
    },
    maxAttempts: {
      type: Number,
      default: 5,
    },
  },
  { timestamps: true }
);

// Index for fast lookups
inviteSchema.index({ organizationId: 1, status: 1 });
inviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index

// Generate a crypto-secure invite code before save
inviteSchema.pre('validate', function (next) {
  if (!this.code) {
    const raw = crypto.randomBytes(24).toString('base64url').slice(0, 24);
    this.code = raw;
    this.codeHash = crypto.createHash('sha256').update(raw).digest('hex');
  }
  next();
});

// Check if invite is still valid
inviteSchema.methods.isValid = function () {
  return (
    this.status === 'pending' &&
    this.expiresAt > new Date() &&
    this.attempts < this.maxAttempts
  );
};

// Static: find by raw code
inviteSchema.statics.findByCode = function (rawCode) {
  const hash = crypto.createHash('sha256').update(rawCode).digest('hex');
  return this.findOne({ codeHash: hash });
};

module.exports = mongoose.model('Invite', inviteSchema);
