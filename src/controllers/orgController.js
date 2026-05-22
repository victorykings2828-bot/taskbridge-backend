const crypto = require('crypto');
const Organization = require('../models/Organization');
const User = require('../models/User');
const Invite = require('../models/Invite');
const AuditLog = require('../models/AuditLog');
const { generateAccessToken, generateRefreshToken, setRefreshTokenCookie } = require('../utils/jwt');

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

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
    id: 'pro', name: 'Pro', price: 15, priceLabel: '$15 / month',
    description: 'Everything a growing team needs, at a price that makes sense',
    badge: 'Most Popular', highlighted: true,
    limits: { managers: 5, employeesPerManager: 100, totalEmployees: 500, storageLimitBytes: 10*1024*1024*1024 },
    storageLabel: '10 GB',
    features: [
      { text: 'Up to 5 Manager accounts', included: true },
      { text: 'Up to 100 employees per manager', included: true },
      { text: 'Everything in Starter', included: true },
      { text: 'Task priority (High / Medium / Low)', included: true },
      { text: 'File attachments & deliverables (10 GB)', included: true },
      { text: 'Extra storage (+5 GB for $1.50/mo)', included: true },
      { text: 'Team workload overview', included: true },
      { text: 'Feedback & 5-star ratings', included: true },
      { text: 'Manager & employee performance dashboards', included: true },
      { text: 'Deadline overdue alerts', included: true },
      { text: 'Task revision & re-submit workflow', included: true },
      { text: 'Employee performance history', included: true },
      { text: 'Audit logs & compliance', included: false },
      { text: 'Dedicated account manager', included: false },
    ],
    cta: 'Start 14-day free trial', extraStorage: { perGB: 5, priceDollars: 1.50 },
  },
  {
    id: 'enterprise', name: 'Enterprise', price: 78, priceLabel: '$78 / month',
    description: 'Unlimited scale, complete visibility, full accountability',
    badge: null, highlighted: false,
    limits: { managers: 9999, employeesPerManager: 9999, totalEmployees: 9999, storageLimitBytes: 80*1024*1024*1024 },
    storageLabel: '80 GB',
    features: [
      { text: 'Unlimited managers', included: true },
      { text: 'Unlimited employees', included: true },
      { text: 'Everything in Pro', included: true },
      { text: '80 GB file storage', included: true },
      { text: 'Extra storage (+5 GB for $1.50/mo)', included: true },
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
    cta: 'Get started', extraStorage: { perGB: 5, priceDollars: 1.50 },
  },
];

const fmtBytes = (b) => {
  if (!b) return '0 B';
  if (b < 1024**2) return `${(b/1024).toFixed(1)} KB`;
  if (b < 1024**3) return `${(b/1024**2).toFixed(1)} MB`;
  return `${(b/1024**3).toFixed(2)} GB`;
};

const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

// POST /api/org/register
const registerOrganization = async (req, res) => {
  try {
    const { companyName, industry, adminName, adminEmail, adminPassword } = req.body;
    if (!companyName || !adminName || !adminEmail || !adminPassword)
      return res.status(400).json({ success: false, message: 'All fields are required' });
    if (!EMAIL_RE.test(adminEmail))
      return res.status(400).json({ success: false, message: 'Enter a valid email address' });
    if (await User.findOne({ email: adminEmail.toLowerCase().trim() }))
      return res.status(409).json({ success: false, message: 'An account with this email already exists' });
    if (adminPassword.length < 8 || !/[A-Z]/.test(adminPassword) || !/[a-z]/.test(adminPassword) || !/\d/.test(adminPassword))
      return res.status(400).json({ success: false, message: 'Password must be 8+ chars with uppercase, lowercase, and a number' });

    const org = new Organization({ name: companyName.trim(), industry: (industry||'').trim() });
    org.applyTierLimits();
    await org.save();

    const admin = new User({ name: adminName.trim(), email: adminEmail.toLowerCase().trim(), password: adminPassword, role: 'super_admin', organizationId: org._id, subscriptionTier: 'free', isFirstLogin: false });
    await admin.save();
    org.ownerId = admin._id;
    await org.save();

    const accessToken = generateAccessToken(admin._id, admin.role);
    const refreshToken = generateRefreshToken(admin._id);
    admin.refreshTokens.push({ token: hashToken(refreshToken) });
    await admin.save();
    setRefreshTokenCookie(res, refreshToken);

    await AuditLog.create({ performedBy: admin._id, action: 'ORG_REGISTERED', targetModel: 'Organization', targetId: org._id });
    res.status(201).json({ success: true, message: 'Organisation registered', accessToken, user: { id: admin._id, name: admin.name, email: admin.email, role: admin.role, organizationId: org._id, subscriptionTier: 'free', isFirstLogin: false }, organization: { id: org._id, name: org.name, joinCode: org.joinCode, subscriptionTier: 'free', limits: org.limits }, requirePasswordChange: false });
  } catch (err) {
    console.error('registerOrganization:', err);
    res.status(500).json({ success: false, message: 'Registration failed. Please try again.' });
  }
};

// POST /api/org/join  — join code rotates after each use
const joinOrganization = async (req, res) => {
  try {
    const { joinCode } = req.body;
    if (!joinCode) return res.status(400).json({ success: false, message: 'Join code is required' });
    const user = await User.findById(req.user._id);
    if (user.organizationId) return res.status(400).json({ success: false, message: 'You are already part of an organisation' });

    const org = await Organization.findOne({ joinCode: joinCode.toUpperCase().trim(), isActive: true });
    if (!org) return res.status(404).json({ success: false, message: 'Invalid join code. Check with your administrator.' });
    if (org.joinCodeExpiresAt && org.joinCodeExpiresAt < new Date())
      return res.status(410).json({ success: false, message: 'This join code has expired. Ask your admin to regenerate it.' });

    user.organizationId = org._id;
    user.subscriptionTier = org.subscriptionTier;
    await user.save();

    // Rotate immediately so nobody else can use it
    org.rotateJoinCode();
    await org.save();

    await AuditLog.create({ performedBy: req.user._id, action: 'USER_JOINED_ORG', targetModel: 'Organization', targetId: org._id });
    res.json({ success: true, message: `You have joined ${org.name}!`, organization: { id: org._id, name: org.name }, newJoinCode: org.joinCode });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to join organisation' });
  }
};

// POST /api/org/invite
const createInvite = async (req, res) => {
  try {
    const { email, role = 'employee', expiryHours = 48 } = req.body;
    if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ success: false, message: 'Valid email is required' });
    if (!req.user.organizationId) return res.status(400).json({ success: false, message: 'No organisation found' });

    await Invite.updateMany({ organizationId: req.user.organizationId, email: email.toLowerCase(), status: 'pending' }, { status: 'revoked' });

    const invite = new Invite({ organizationId: req.user.organizationId, createdBy: req.user._id, email: email.toLowerCase().trim(), role, expiresAt: new Date(Date.now() + Math.min(expiryHours, 168) * 3600000) });
    await invite.save();

    const org = await Organization.findById(req.user.organizationId).select('name');
    res.status(201).json({ success: true, invite: { id: invite._id, code: invite.code, email: invite.email, role: invite.role, expiresAt: invite.expiresAt }, shareText: `You've been invited to join ${org?.name} on TaskBridge. Code: ${invite.code} (expires ${invite.expiresAt.toLocaleDateString()})` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to create invite' });
  }
};

// POST /api/org/invite/accept
const acceptInvite = async (req, res) => {
  try {
    const { code, name, password } = req.body;
    if (!code || !name || !password) return res.status(400).json({ success: false, message: 'Code, name, and password required' });

    const invite = await Invite.findByCode(code).populate('organizationId');
    if (!invite) return res.status(404).json({ success: false, message: 'Invalid invite code' });
    if (!invite.isValid()) return res.status(410).json({ success: false, message: 'Invite has expired or already been used.' });

    const org = invite.organizationId;
    if (!org?.isActive) return res.status(404).json({ success: false, message: 'Organisation not found' });
    if (await User.findOne({ email: invite.email })) return res.status(409).json({ success: false, message: 'Account already exists for this email. Please sign in.' });
    if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password))
      return res.status(400).json({ success: false, message: 'Password must be 8+ chars with uppercase, lowercase, and a number' });

    const user = new User({ name: name.trim(), email: invite.email, password, role: invite.role, organizationId: org._id, subscriptionTier: org.subscriptionTier, isFirstLogin: false, createdBy: invite.createdBy });
    await user.save();

    invite.status = 'accepted';
    invite.acceptedAt = new Date();
    invite.acceptedBy = user._id;
    await invite.save();

    const accessToken = generateAccessToken(user._id, user.role);
    const refreshToken = generateRefreshToken(user._id);
    user.refreshTokens.push({ token: hashToken(refreshToken) });
    await user.save();
    setRefreshTokenCookie(res, refreshToken);

    res.status(201).json({ success: true, message: `Welcome to ${org.name}!`, accessToken, user: { id: user._id, name: user.name, email: user.email, role: user.role, organizationId: org._id, isFirstLogin: false }, organization: { id: org._id, name: org.name }, requirePasswordChange: false });
  } catch (err) {
    console.error('acceptInvite:', err);
    res.status(500).json({ success: false, message: 'Failed to accept invite' });
  }
};

// GET /api/org/invites
const listInvites = async (req, res) => {
  try {
    const invites = await Invite.find({ organizationId: req.user.organizationId }).select('email role status expiresAt createdAt').sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, invites });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch invites' });
  }
};

// DELETE /api/org/invites/:id
const revokeInvite = async (req, res) => {
  try {
    const invite = await Invite.findOne({ _id: req.params.id, organizationId: req.user.organizationId });
    if (!invite) return res.status(404).json({ success: false, message: 'Invite not found' });
    invite.status = 'revoked';
    await invite.save();
    res.json({ success: true, message: 'Invite revoked' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to revoke invite' });
  }
};

// GET /api/org/me
const getMyOrganization = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user.organizationId) return res.status(404).json({ success: false, message: 'No organisation found' });
    const org = await Organization.findById(user.organizationId);
    if (!org) return res.status(404).json({ success: false, message: 'Organisation not found' });
    const [managerCount, employeeCount] = await Promise.all([
      User.countDocuments({ organizationId: org._id, role: 'manager', isActive: true }),
      User.countDocuments({ organizationId: org._id, role: 'employee', isActive: true }),
    ]);
    const usedBytes = org.storage?.usedBytes || 0;
    const limitBytes = org.limits.storageLimitBytes;
    res.json({ success: true, organization: { id: org._id, name: org.name, joinCode: org.joinCode, joinCodeExpiresAt: org.joinCodeExpiresAt, industry: org.industry, logo: org.logo, subscriptionTier: org.subscriptionTier, subscriptionStatus: org.subscriptionStatus, subscriptionExpiresAt: org.subscriptionExpiresAt, limits: org.limits, storage: { usedBytes, usedFormatted: fmtBytes(usedBytes), limitBytes, limitFormatted: fmtBytes(limitBytes), usedPct: limitBytes > 0 ? Math.min(100, Math.round((usedBytes/limitBytes)*100)) : 0, extraGBPurchased: org.storage?.extraGBPurchased || 0 }, usage: { managers: managerCount, employees: employeeCount } } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch organisation' });
  }
};

// POST /api/org/upgrade
const upgradePlan = async (req, res) => {
  try {
    const { tier } = req.body;
    if (!['pro','enterprise'].includes(tier)) return res.status(400).json({ success: false, message: 'Invalid plan' });
    const user = await User.findById(req.user._id);
    if (user.role !== 'super_admin') return res.status(403).json({ success: false, message: 'Admins only' });
    const org = await Organization.findById(user.organizationId);
    if (!org) return res.status(404).json({ success: false, message: 'Organisation not found' });
    org.subscriptionTier = tier;
    org.subscriptionStatus = 'active';
    org.subscriptionExpiresAt = new Date(Date.now() + 30*24*3600*1000);
    org.applyTierLimits();
    await org.save();
    await User.updateMany({ organizationId: org._id }, { subscriptionTier: tier });
    await AuditLog.create({ performedBy: req.user._id, action: 'SUBSCRIPTION_UPGRADED', targetModel: 'Organization', targetId: org._id, details: { tier } });
    res.json({ success: true, message: `Upgraded to ${tier} plan!`, organization: { subscriptionTier: org.subscriptionTier, limits: org.limits, storageFormatted: fmtBytes(org.limits.storageLimitBytes) } });
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

// POST /api/org/joincode/rotate
const rotateJoinCode = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (user.role !== 'super_admin') return res.status(403).json({ success: false, message: 'Admins only' });
    const org = await Organization.findById(user.organizationId);
    if (!org) return res.status(404).json({ success: false, message: 'Organisation not found' });
    org.rotateJoinCode();
    await org.save();
    await AuditLog.create({ performedBy: req.user._id, action: 'JOIN_CODE_ROTATED', targetModel: 'Organization', targetId: org._id });
    res.json({ success: true, message: 'Join code regenerated.', joinCode: org.joinCode, expiresAt: org.joinCodeExpiresAt });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to rotate join code' });
  }
};

// GET /api/org/plans  (public)
const getPlans = (req, res) => res.json({ success: true, plans: PLANS });

module.exports = { registerOrganization, joinOrganization, createInvite, acceptInvite, listInvites, revokeInvite, getMyOrganization, upgradePlan, purchaseExtraStorage, cleanStorage, rotateJoinCode, getPlans };
