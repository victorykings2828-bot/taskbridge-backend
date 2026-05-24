const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Organization = require('../models/Organization');
const User = require('../models/User');
const PendingRegistration = require('../models/PendingRegistration');
const AuditLog = require('../models/AuditLog');
const { generateAccessToken, generateRefreshToken, setRefreshTokenCookie } = require('../utils/jwt');
const { sendOtpEmail } = require('../utils/email');

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

// ── Shared helpers ──────────────────────────────────────────────────────────
const validateRegistration = ({ companyName, adminName, adminEmail, adminPassword }) => {
  if (!companyName || !adminName || !adminEmail || !adminPassword) return 'All fields are required';
  if (!EMAIL_RE.test(adminEmail)) return 'Enter a valid email address';
  if (adminPassword.length < 8 || !/[A-Z]/.test(adminPassword) || !/[a-z]/.test(adminPassword) || !/\d/.test(adminPassword))
    return 'Password must be 8+ chars with uppercase, lowercase, and a number';
  return null;
};

// Creates the Organization + super_admin user. `password` may be a plaintext
// string, an already-bcrypt-hashed string, or null (Google signup — no password).
const createOrganizationWithAdmin = async ({ companyName, industry, adminName, email, password }) => {
  const org = new Organization({ name: companyName.trim(), industry: (industry || '').trim() });
  org.applyTierLimits();
  await org.save();

  const admin = new User({
    name: adminName.trim(),
    email: email.toLowerCase().trim(),
    password: password || null,
    role: 'super_admin',
    organizationId: org._id,
    subscriptionTier: 'free',
    isRegistered: true,
    isFirstLogin: false,
  });
  await admin.save();

  org.ownerId = admin._id;
  await org.save();

  await AuditLog.create({ performedBy: admin._id, action: 'ORG_REGISTERED', targetModel: 'Organization', targetId: org._id });
  return { org, admin };
};

// Issues access + refresh tokens, stores the hashed refresh token, sets the cookie.
const issueAuthTokens = async (res, user) => {
  const accessToken = generateAccessToken(user._id, user.role);
  const refreshToken = generateRefreshToken(user._id);
  user.refreshTokens.push({ token: hashToken(refreshToken) });
  if (user.refreshTokens.length > 5) user.refreshTokens = user.refreshTokens.slice(-5);
  user.lastLogin = new Date();
  await user.save();
  setRefreshTokenCookie(res, refreshToken);
  return accessToken;
};

const authPayload = (admin, org, accessToken) => ({
  success: true,
  message: `Welcome to TaskBridge, ${admin.name.split(' ')[0]}!`,
  accessToken,
  user: { id: admin._id, name: admin.name, email: admin.email, role: admin.role, organizationId: org._id, subscriptionTier: 'free', isFirstLogin: false },
  organization: { id: org._id, name: org.name, subscriptionTier: 'free', limits: org.limits },
  requirePasswordChange: false,
});

const PLANS = [
  {
    id: 'free', name: 'Starter', price: 0, priceLabel: 'Free forever',
    description: 'Perfect for one manager with a small team',
    badge: null, highlighted: false,
    limits: { managers: 1, employeesPerManager: 5, totalEmployees: 5, storageLimitBytes: 500*1024*1024 },
    storageLabel: '500 MB',
    features: [
      { text: '1 Manager account', included: true },
      { text: 'Up to 5 employees', included: true },
      { text: 'Task creation & assignment', included: true },
      { text: 'Task status tracking (5 stages)', included: true },
      { text: 'In-app notifications', included: true },
      { text: 'Employee & manager dashboards', included: true },
      { text: '500 MB file storage', included: true },
      { text: 'Email support', included: true },
      { text: 'Task priority levels', included: false },
      { text: 'Performance analytics', included: false },
      { text: 'Team workload view', included: false },
      { text: 'Feedback & ratings', included: false },
      { text: 'Audit logs & compliance', included: false },
      { text: 'Deadline extension workflow', included: false },
    ],
    cta: 'Get started free', extraStorage: null,
  },
  {
    id: 'pro', name: 'Pro', price: 1249, priceLabel: '₹1,249/mo',
    description: 'Everything a growing team needs, at a price that makes sense',
    badge: 'Most Popular', highlighted: true,
    limits: { managers: 5, employeesPerManager: 20, totalEmployees: 100, storageLimitBytes: 10*1024*1024*1024 },
    storageLabel: '10 GB',
    features: [
      { text: 'Up to 5 Manager accounts', included: true },
      { text: 'Up to 20 employees per manager', included: true },
      { text: 'Everything in Starter', included: true },
      { text: 'Task priority (High / Medium / Low)', included: true },
      { text: 'File attachments & deliverables (10 GB)', included: true },
      { text: 'Extra storage (+5 GB for ₹125/mo)', included: true },
      { text: 'Team workload overview', included: true },
      { text: 'Feedback & 5-star ratings', included: true },
      { text: 'Manager & employee performance dashboards', included: true },
      { text: 'Deadline overdue alerts', included: true },
      { text: 'Task revision & re-submit workflow', included: true },
      { text: 'Employee performance history', included: true },
      { text: 'Audit logs & compliance', included: false },
      { text: 'Dedicated account manager', included: false },
    ],
    cta: 'Start 14-day free trial', extraStorage: { perGB: 5, priceINR: 125 },
  },
  {
    id: 'enterprise', name: 'Enterprise', price: null, priceLabel: 'Custom',
    description: 'A custom plan built around your requirements',
    badge: null, highlighted: false,
    limits: { managers: 9999, employeesPerManager: 9999, totalEmployees: 9999, storageLimitBytes: 80*1024*1024*1024 },
    storageLabel: '80 GB',
    features: [
      { text: 'Unlimited managers', included: true },
      { text: 'Unlimited employees', included: true },
      { text: 'Everything in Pro', included: true },
      { text: '80 GB file storage', included: true },
      { text: 'Extra storage (+5 GB for ₹125/mo)', included: true },
      { text: 'Full audit log with export', included: true },
      { text: 'Cross-team workload balancing', included: true },
      { text: 'Task completion rate & trend reports', included: true },
      { text: 'Manager performance benchmarking', included: true },
      { text: 'Deadline escalation workflow', included: true },
      { text: 'Role-based data visibility controls', included: true },
      { text: 'Custom company branding', included: true },
      { text: 'Priority email & chat support', included: true },
      { text: 'Onboarding assistance', included: true },
    ],
    cta: 'Contact us', contactEmail: 'taskbridge111@gmail.com', extraStorage: { perGB: 5, priceINR: 125 },
  },
];

const fmtBytes = (b) => {
  if (!b) return '0 B';
  if (b < 1024**2) return `${(b/1024).toFixed(1)} KB`;
  if (b < 1024**3) return `${(b/1024**2).toFixed(1)} MB`;
  return `${(b/1024**3).toFixed(2)} GB`;
};

const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

// POST /api/org/register/request-otp  — step 1 of email signup
// Validates the details, then emails a 6-digit code. No account is created yet.
const registerRequestOtp = async (req, res) => {
  try {
    const { companyName, industry, adminName, adminEmail, adminPassword } = req.body;

    const validationError = validateRegistration({ companyName, adminName, adminEmail, adminPassword });
    if (validationError) return res.status(400).json({ success: false, message: validationError });

    const email = adminEmail.toLowerCase().trim();
    // NOTE: we intentionally do NOT block emails that already exist in other
    // companies — the same person can own/join multiple workspaces. Email is
    // unique per organization, enforced at creation time.

    // Generate a 6-digit OTP and store the pending registration (password hashed).
    const otp = ('' + crypto.randomInt(0, 1000000)).padStart(6, '0');
    const passwordHash = await bcrypt.hash(adminPassword, 12);

    await PendingRegistration.findOneAndUpdate(
      { email },
      {
        email,
        companyName: companyName.trim(),
        industry: (industry || '').trim(),
        adminName: adminName.trim(),
        passwordHash,
        otpHash: hashToken(otp),
        attempts: 0,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const result = await sendOtpEmail(email, adminName.trim(), otp);
    if (!result.success) {
      // Surface a clear error instead of pretending it sent.
      // `emailErrorCode` is a non-sensitive diagnostic (e.g. EAUTH, ETIMEDOUT).
      return res.status(502).json({
        success: false,
        message: 'Could not send the verification email. Please try again shortly.',
        emailErrorCode: result.code || 'UNKNOWN',
      });
    }

    // In dev (mock email), log the code so it can be tested without real email.
    if (process.env.NODE_ENV !== 'production' && !process.env.EMAIL_USER) {
      console.log(`🔑 Signup OTP for ${email}: ${otp}`);
    }

    res.json({ success: true, message: `We sent a 6-digit code to ${email}. Enter it to finish signing up.` });
  } catch (err) {
    console.error('registerRequestOtp:', err);
    res.status(500).json({ success: false, message: 'Could not start registration. Please try again.' });
  }
};

// POST /api/org/register/verify  — step 2 of email signup
// Verifies the OTP, then creates the organization + super admin and logs in.
const registerVerify = async (req, res) => {
  try {
    const { adminEmail, otp } = req.body;
    if (!adminEmail || !otp) return res.status(400).json({ success: false, message: 'Email and code are required' });

    const email = adminEmail.toLowerCase().trim();
    const pending = await PendingRegistration.findOne({ email });
    if (!pending) {
      return res.status(404).json({ success: false, message: 'No pending signup found. Please start again.' });
    }
    if (pending.expiresAt < new Date()) {
      await PendingRegistration.deleteOne({ _id: pending._id });
      return res.status(410).json({ success: false, message: 'Your code expired. Please start again.' });
    }
    if (pending.attempts >= 5) {
      await PendingRegistration.deleteOne({ _id: pending._id });
      return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please start again.' });
    }
    if (hashToken(('' + otp).trim()) !== pending.otpHash) {
      pending.attempts += 1;
      await pending.save();
      return res.status(400).json({ success: false, message: 'Incorrect code. Please check and try again.' });
    }

    const { org, admin } = await createOrganizationWithAdmin({
      companyName: pending.companyName,
      industry: pending.industry,
      adminName: pending.adminName,
      email: pending.email,
      password: pending.passwordHash, // already a bcrypt hash — stored as-is
    });
    await PendingRegistration.deleteOne({ _id: pending._id });

    const accessToken = await issueAuthTokens(res, admin);
    res.status(201).json(authPayload(admin, org, accessToken));
  } catch (err) {
    console.error('registerVerify:', err);
    res.status(500).json({ success: false, message: 'Registration failed. Please try again.' });
  }
};

// POST /api/org/register/google  — completes Google signup for a new workspace.
// Requires a short-lived signup token issued by the Google OAuth callback.
const googleCompleteSignup = async (req, res) => {
  try {
    const jwt = require('jsonwebtoken');
    const { signupToken, companyName, industry } = req.body;
    if (!signupToken || !companyName) {
      return res.status(400).json({ success: false, message: 'Company name is required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(signupToken, process.env.JWT_ACCESS_SECRET);
    } catch {
      return res.status(401).json({ success: false, message: 'Your signup session expired. Please sign in with Google again.' });
    }
    if (decoded.purpose !== 'google_signup' || !decoded.email) {
      return res.status(400).json({ success: false, message: 'Invalid signup session' });
    }

    const email = decoded.email.toLowerCase().trim();
    if (await User.findOne({ email })) {
      return res.status(409).json({ success: false, message: 'An account with this email already exists. Please sign in.' });
    }

    const { org, admin } = await createOrganizationWithAdmin({
      companyName,
      industry,
      adminName: decoded.name || email.split('@')[0],
      email,
      password: null, // Google accounts sign in via Google (or set a password later)
    });

    const accessToken = await issueAuthTokens(res, admin);
    res.status(201).json(authPayload(admin, org, accessToken));
  } catch (err) {
    console.error('googleCompleteSignup:', err);
    res.status(500).json({ success: false, message: 'Could not complete signup. Please try again.' });
  }
};

// GET /api/org/me
const getMyOrganization = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user.organizationId) return res.status(404).json({ success: false, message: 'No organisation found' });
    const org = await Organization.findById(user.organizationId);
    if (!org) return res.status(404).json({ success: false, message: 'Organisation not found' });
    // Downgrade to Free if a paid plan has expired.
    if (org.checkAndApplyExpiry()) {
      await org.save();
      await User.updateMany({ organizationId: org._id }, { subscriptionTier: 'free' });
    }
    const [managerCount, employeeCount] = await Promise.all([
      User.countDocuments({ organizationId: org._id, role: 'manager', isActive: true }),
      User.countDocuments({ organizationId: org._id, role: 'employee', isActive: true }),
    ]);
    const usedBytes = org.storage?.usedBytes || 0;
    const limitBytes = org.limits.storageLimitBytes;
    res.json({ success: true, organization: { id: org._id, name: org.name, industry: org.industry, logo: org.logo, subscriptionTier: org.subscriptionTier, subscriptionStatus: org.subscriptionStatus, subscriptionExpiresAt: org.subscriptionExpiresAt, limits: org.limits, storage: { usedBytes, usedFormatted: fmtBytes(usedBytes), limitBytes, limitFormatted: fmtBytes(limitBytes), usedPct: limitBytes > 0 ? Math.min(100, Math.round((usedBytes/limitBytes)*100)) : 0, extraGBPurchased: org.storage?.extraGBPurchased || 0 }, usage: { managers: managerCount, employees: employeeCount } } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch organisation' });
  }
};

// POST /api/org/upgrade
const upgradePlan = async (req, res) => {
  try {
    res.status(410).json({
      success: false,
      message: 'Direct plan upgrades are disabled. Use the verified payment flow.',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Upgrade failed' });
  }
};

// POST /api/org/storage/extra
const purchaseExtraStorage = async (req, res) => {
  try {
    const gb = parseInt(req.body.extraGB, 10);
    if (!gb || gb < 5 || gb % 5 !== 0 || gb > 500) return res.status(400).json({ success: false, message: 'Must be a multiple of 5 GB (5–500 GB)' });
    const user = await User.findById(req.user._id);
    if (user.role !== 'super_admin') return res.status(403).json({ success: false, message: 'Admins only' });
    const org = await Organization.findById(user.organizationId);
    if (!org) return res.status(404).json({ success: false, message: 'Organisation not found' });
    if (org.subscriptionTier === 'free') return res.status(403).json({ success: false, message: 'Extra storage requires Pro or Enterprise plan' });
    org.storage.extraGBPurchased = (org.storage.extraGBPurchased||0) + gb;
    org.applyTierLimits();
    await org.save();
    const cost = (gb/5)*1.50;
    res.json({ success: true, message: `Added ${gb} GB storage. +$${cost.toFixed(2)}/month.`, newLimitFormatted: fmtBytes(org.limits.storageLimitBytes) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to purchase storage' });
  }
};

// DELETE /api/org/storage/clean
const cleanStorage = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (user.role !== 'super_admin') return res.status(403).json({ success: false, message: 'Admins only' });
    const Task = require('../models/Task');
    const org = await Organization.findById(user.organizationId);
    if (!org) return res.status(404).json({ success: false, message: 'Organisation not found' });
    const cutoff = new Date(Date.now() - 90*24*3600*1000);
    const tasks = await Task.find({ organizationId: user.organizationId, status: 'completed', updatedAt: { $lt: cutoff }, $or: [{ 'attachment.url': { $exists: true, $ne: '' } }, { 'deliverable.url': { $exists: true, $ne: '' } }] });
    let freed = 0;
    for (const t of tasks) {
      freed += (t.attachment?.size||0) + (t.deliverable?.size||0);
      await Task.updateOne({ _id: t._id }, { $unset: { attachment: '', deliverable: '' } });
    }
    org.storage.usedBytes = Math.max(0, (org.storage.usedBytes||0) - freed);
    await org.save();
    await AuditLog.create({ performedBy: req.user._id, action: 'STORAGE_CLEANED', targetModel: 'Organization', targetId: org._id, details: { freedBytes: freed, tasksAffected: tasks.length } });
    res.json({ success: true, message: `Freed ${fmtBytes(freed)} from ${tasks.length} archived tasks.`, freedFormatted: fmtBytes(freed), tasksAffected: tasks.length });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Cleanup failed' });
  }
};

// GET /api/org/plans  (public)
const getPlans = (req, res) => res.json({ success: true, plans: PLANS });

module.exports = { registerRequestOtp, registerVerify, googleCompleteSignup, getMyOrganization, upgradePlan, purchaseExtraStorage, cleanStorage, getPlans };
