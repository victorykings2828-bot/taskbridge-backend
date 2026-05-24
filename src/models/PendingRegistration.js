const mongoose = require('mongoose');

// A short-lived record holding a company-registration request that is awaiting
// email OTP verification. Auto-expires via a TTL index so unverified attempts
// clean themselves up.
const pendingRegistrationSchema = new mongoose.Schema(
  {
    email:       { type: String, required: true, lowercase: true, trim: true, index: true },
    companyName: { type: String, required: true, trim: true },
    industry:    { type: String, default: '' },
    adminName:   { type: String, required: true, trim: true },
    passwordHash:{ type: String, required: true }, // bcrypt hash of the chosen password
    otpHash:     { type: String, required: true }, // sha256 of the 6-digit code
    attempts:    { type: Number, default: 0 },     // failed verification attempts
    expiresAt:   { type: Date, required: true },
  },
  { timestamps: true }
);

// TTL index — MongoDB removes the document once expiresAt passes.
pendingRegistrationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PendingRegistration', pendingRegistrationSchema);
