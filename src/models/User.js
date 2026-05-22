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
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false,
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
  },
  { timestamps: true }
);

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password
userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Remove sensitive fields from JSON output
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.refreshTokens;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
