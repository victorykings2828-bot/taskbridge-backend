const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
} = require('../utils/jwt');
const { sendPasswordChangedEmail, sendPasswordResetEmail, sendOtpEmail } = require('../utils/email');

// ── Password complexity validator ──────────────────────────────────────────
const validatePasswordComplexity = (password) => {
  if (!password || password.length < 8)           return 'Password must be at least 8 characters';
  if (password.length > 128)                      return 'Password cannot exceed 128 characters';
  if (!/[A-Z]/.test(password))                    return 'Password must contain at least one uppercase letter';
  if (!/[a-z]/.test(password))                    return 'Password must contain at least one lowercase letter';
  if (!/\d/.test(password))                       return 'Password must contain at least one number';
  return null; // null = valid
};

// ── Hash refresh token for DB storage ─────────────────────────────────────
const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

// Build the organization summary returned to the client.
const buildOrg = async (organizationId) => {
  if (!organizationId) return null;
  const Organization = require('../models/Organization');
  const org = await Organization.findById(organizationId).select('name subscriptionTier limits');
  return org ? { id: org._id, name: org.name, subscriptionTier: org.subscriptionTier, limits: org.limits } : null;
};

// Issue tokens for a verified user and send the standard auth response.
const issueLoginResponse = async (req, res, user) => {
  user.loginAttempts = 0;
  user.lockUntil = null;
  const accessToken  = generateAccessToken(user._id, user.role);
  const refreshToken = generateRefreshToken(user._id);
  user.refreshTokens.push({ token: hashToken(refreshToken) });
  if (user.refreshTokens.length > 5) user.refreshTokens = user.refreshTokens.slice(-5);
  user.lastLogin = new Date();
  await user.save();
  setRefreshTokenCookie(res, refreshToken);
  await AuditLog.create({
    performedBy: user._id, action: 'USER_LOGIN',
    targetModel: 'User', targetId: user._id,
    details: { email: user.email }, ipAddress: req.ip,
  });
  return res.json({
    success: true,
    message: 'Login successful',
    accessToken,
    user: user.toJSON(),
    organization: await buildOrg(user.organizationId),
    requirePasswordChange: user.isFirstLogin,
  });
};

// POST /api/auth/login
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }

    // Limit field lengths to prevent DoS
    if (email.length > 254 || password.length > 128) {
      return res.status(400).json({ success: false, message: 'Invalid credentials' });
    }

    const normEmail = email.toLowerCase().trim();
    const dummyHash = '$2a$12$dummyhashtopreventtimingattacksonnonexistentemails.xxx';

    // The same email may exist in multiple organizations (one account each).
    const accounts = await User.find({ email: normEmail }).select('+password +loginAttempts +lockUntil');

    if (accounts.length === 0) {
      await require('bcryptjs').compare(password, dummyHash).catch(() => {});
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    // ── Single account (the overwhelmingly common case) — original logic ──────
    if (accounts.length === 1) {
      const user = accounts[0];

      if (user.lockUntil && user.lockUntil > Date.now()) {
        const minutesLeft = Math.ceil((user.lockUntil - Date.now()) / 60000);
        return res.status(429).json({ success: false, message: `Account locked due to too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft > 1 ? 's' : ''}.` });
      }
      if (!user.isActive) {
        return res.status(403).json({ success: false, message: 'Your account has been deactivated. Contact your administrator.' });
      }
      // Created by an admin but password not set yet → go to setup.
      if (!user.password) {
        return res.json({ success: true, setupRequired: true, email: user.email });
      }

      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        user.loginAttempts = (user.loginAttempts || 0) + 1;
        if (user.loginAttempts >= 5) {
          user.lockUntil = new Date(Date.now() + 15 * 60 * 1000);
          user.loginAttempts = 0;
          await user.save();
          await AuditLog.create({ performedBy: user._id, action: 'ACCOUNT_LOCKED', targetModel: 'User', targetId: user._id, details: { reason: 'Too many failed login attempts' }, ipAddress: req.ip });
          return res.status(429).json({ success: false, message: 'Too many failed attempts. Account locked for 15 minutes.' });
        }
        await user.save();
        return res.status(401).json({ success: false, message: 'Invalid email or password' });
      }
      return issueLoginResponse(req, res, user);
    }

    // ── Multiple accounts share this email (member of multiple workspaces) ────
    const active = accounts.filter((u) => u.isActive);
    if (active.length === 0) {
      await require('bcryptjs').compare(password, dummyHash).catch(() => {});
      return res.status(403).json({ success: false, message: 'Your account has been deactivated. Contact your administrator.' });
    }

    // Registered (password-set) accounts for this email, and whether they're all locked.
    const registered = active.filter((u) => u.password);
    if (registered.length > 0 && registered.every((u) => u.lockUntil && u.lockUntil > Date.now())) {
      const soonest = Math.min(...registered.map((u) => u.lockUntil.getTime()));
      const minutesLeft = Math.ceil((soonest - Date.now()) / 60000);
      return res.status(429).json({ success: false, message: `Account locked due to too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft > 1 ? 's' : ''}.` });
    }

    // Match the password against each account that has one set.
    const matches = [];
    for (const u of active) {
      if (u.password && (await u.comparePassword(password))) matches.push(u);
    }

    if (matches.length >= 1) {
      // The user proved this password. Activate any still-pending accounts for
      // the same email (e.g. a second company that added them before they ever
      // set a password) using this same password, so every workspace they've
      // been added to becomes reachable and appears in the picker.
      const pendingNoPw = active.filter((u) => !u.password);
      if (pendingNoPw.length > 0) {
        const hash = matches[0].password; // bcrypt hash of the proven password
        await User.updateMany(
          { _id: { $in: pendingNoPw.map((u) => u._id) } },
          { password: hash, isRegistered: true, isFirstLogin: false }
        );
        for (const u of pendingNoPw) { u.password = hash; matches.push(u); }
      }

      if (matches.length === 1) {
        return issueLoginResponse(req, res, matches[0]);
      }

      // Belongs to multiple workspaces → let the user choose which to enter.
      const ids = matches.map((m) => m._id.toString());
      const selectionToken = jwt.sign({ purpose: 'workspace_select', ids }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
      const workspaces = await Promise.all(
        matches.map(async (m) => ({ userId: m._id, role: m.role, organization: await buildOrg(m.organizationId) }))
      );
      return res.json({
        success: true,
        chooseWorkspace: true,
        selectionToken,
        workspaces: workspaces.map((w) => ({ userId: w.userId, role: w.role, name: w.organization?.name || 'Workspace' })),
      });
    }

    // No password matched.
    // Only route to setup when there is NO registered account (all pending) —
    // a wrong password against an existing account must NOT leak into setup.
    if (registered.length === 0) {
      return res.json({ success: true, setupRequired: true, email: normEmail });
    }
    // Wrong password against existing account(s): count the failed attempt and lock.
    for (const u of registered) {
      u.loginAttempts = (u.loginAttempts || 0) + 1;
      if (u.loginAttempts >= 5) { u.lockUntil = new Date(Date.now() + 15 * 60 * 1000); u.loginAttempts = 0; }
      await u.save();
    }
    return res.status(401).json({ success: false, message: 'Invalid email or password' });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Server error during login' });
  }
};

// POST /api/auth/refresh
const refreshToken = async (req, res) => {
  try {
    const token = req.cookies.refreshToken;
    if (!token) {
      return res.status(401).json({ success: false, message: 'Refresh token not found' });
    }

    let decoded;
    try {
      decoded = verifyRefreshToken(token);
    } catch {
      clearRefreshTokenCookie(res);
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
    }

    const user = await User.findById(decoded.userId).select('+refreshTokens');
    if (!user || !user.isActive) {
      clearRefreshTokenCookie(res);
      return res.status(401).json({ success: false, message: 'User not found or deactivated' });
    }

    // Compare hashed token
    const hashedIncoming = hashToken(token);
    const tokenExists = user.refreshTokens.find((t) => t.token === hashedIncoming);

    if (!tokenExists) {
      // Token reuse detected — invalidate ALL tokens (token theft)
      user.refreshTokens = [];
      await user.save();
      clearRefreshTokenCookie(res);
      await AuditLog.create({
        performedBy: user._id, action: 'SUSPICIOUS_TOKEN_REUSE',
        targetModel: 'User', targetId: user._id,
        details: { ip: req.ip }, ipAddress: req.ip,
      });
      return res.status(401).json({ success: false, message: 'Session invalidated. Please log in again.' });
    }

    // Rotate token
    const newRefreshToken = generateRefreshToken(user._id);
    const hashedNew = hashToken(newRefreshToken);

    user.refreshTokens = user.refreshTokens.filter((t) => t.token !== hashedIncoming);
    user.refreshTokens.push({ token: hashedNew });
    await user.save();

    const newAccessToken = generateAccessToken(user._id, user.role);
    setRefreshTokenCookie(res, newRefreshToken);

    res.json({ success: true, accessToken: newAccessToken });
  } catch (error) {
    clearRefreshTokenCookie(res);
    res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
  }
};

// POST /api/auth/logout
const logout = async (req, res) => {
  try {
    const token = req.cookies.refreshToken;
    if (token) {
      const hashed = hashToken(token);
      // Try to find user by refresh token and remove it (no auth middleware needed)
      await User.updateOne(
        { 'refreshTokens.token': hashed },
        { $pull: { refreshTokens: { token: hashed } } }
      );
    }
    clearRefreshTokenCookie(res);
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    // Still clear cookie even on error
    clearRefreshTokenCookie(res);
    res.json({ success: true, message: 'Logged out successfully' });
  }
};

// POST /api/auth/change-password
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    // Both fields REQUIRED — no bypass possible
    if (!currentPassword) {
      return res.status(400).json({ success: false, message: 'Current password is required' });
    }

    // Enforce complexity on backend (not just frontend)
    const complexityError = validatePasswordComplexity(newPassword);
    if (complexityError) {
      return res.status(400).json({ success: false, message: complexityError });
    }

    const user = await User.findById(req.user._id).select('+password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }

    // Prevent reuse of same password
    const isSame = await user.comparePassword(newPassword);
    if (isSame) {
      return res.status(400).json({ success: false, message: 'New password must be different from your current password' });
    }

    user.password = newPassword;
    user.isFirstLogin = false;
    user.refreshTokens = []; // Invalidate ALL sessions
    await user.save();

    clearRefreshTokenCookie(res);
    sendPasswordChangedEmail(user).catch(() => {}); // Non-blocking

    await AuditLog.create({
      performedBy: user._id, action: 'PASSWORD_CHANGED',
      targetModel: 'User', targetId: user._id,
      details: { isFirstLogin: req.user.isFirstLogin }, ipAddress: req.ip,
    });

    res.json({ success: true, message: 'Password changed successfully. Please log in again.' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ success: false, message: 'Failed to change password' });
  }
};

// POST /api/auth/setup-account/request-otp
// Emails a 6-digit code to a pending (invited) account. Proves the person owns
// the email before they can set a password — prevents claiming someone's account.
const requestSetupOtp = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });
    const normEmail = email.toLowerCase().trim();

    // Generic response so we don't reveal which emails have a pending invite.
    const GENERIC = { success: true, message: 'If this email has a pending invitation, a code has been sent.' };

    const pending = await User.find({ email: normEmail, isRegistered: false, isActive: true });
    if (pending.length === 0) return res.json(GENERIC);

    const otp = ('' + crypto.randomInt(0, 1000000)).padStart(6, '0');
    await User.updateMany(
      { email: normEmail, isRegistered: false, isActive: true },
      { setupOtpHash: hashToken(otp), setupOtpExpires: new Date(Date.now() + 10 * 60 * 1000) }
    );

    if (process.env.NODE_ENV !== 'production' && !process.env.BREVO_API_KEY && !process.env.EMAIL_USER) {
      console.log(`🔑 Setup OTP for ${normEmail}: ${otp}`);
    }

    const result = await sendOtpEmail(normEmail, pending[0].name, otp);
    if (!result.success) {
      return res.status(502).json({ success: false, message: 'Could not send the verification code. Please try again shortly.', emailErrorCode: result.code });
    }
    return res.json(GENERIC);
  } catch (error) {
    console.error('requestSetupOtp:', error);
    res.status(500).json({ success: false, message: 'Failed to send code' });
  }
};

// POST /api/auth/setup-account
// First-time password creation for an admin-created account. Requires a valid
// emailed OTP (proof of email ownership) — no random signup, no account claiming.
const setupAccount = async (req, res) => {
  try {
    const { email, password, otp } = req.body;

    if (!email || !password || !otp) {
      return res.status(400).json({ success: false, message: 'Email, verification code, and password are required' });
    }

    const complexityError = validatePasswordComplexity(password);
    if (complexityError) {
      return res.status(400).json({ success: false, message: complexityError });
    }

    const normEmail = email.toLowerCase().trim();
    // Target the account that still needs setup (an email can also have a fully
    // set-up account in a different organization — we never touch that one).
    const user = await User.findOne({ email: normEmail, isRegistered: false })
      .select('+password +setupOtpHash +setupOtpExpires');

    if (!user) {
      // Either not invited anywhere, or every account for this email is already set up.
      const anyAccount = await User.findOne({ email: normEmail });
      if (anyAccount) {
        return res.status(409).json({ success: false, message: 'Account already set up. Please sign in instead.' });
      }
      return res.status(404).json({ success: false, message: 'You are not invited to this company. Contact your administrator.' });
    }
    if (!user.isActive) {
      return res.status(403).json({ success: false, message: 'Your account has been deactivated. Contact your administrator.' });
    }

    // Verify the emailed OTP — proves the person owns this email.
    if (!user.setupOtpHash || !user.setupOtpExpires || user.setupOtpExpires < new Date()) {
      return res.status(400).json({ success: false, message: 'Your code has expired. Please request a new one.' });
    }
    if (hashToken(('' + otp).trim()) !== user.setupOtpHash) {
      return res.status(400).json({ success: false, message: 'Incorrect code. Please check and try again.' });
    }

    // Set the password (hashed by pre-save hook) and mark as registered.
    user.password = password;
    user.isRegistered = true;
    user.isFirstLogin = false;
    user.setupOtpHash = null;
    user.setupOtpExpires = null;

    const accessToken  = generateAccessToken(user._id, user.role);
    const refreshToken = generateRefreshToken(user._id);
    user.refreshTokens.push({ token: hashToken(refreshToken) });
    if (user.refreshTokens.length > 5) user.refreshTokens = user.refreshTokens.slice(-5);
    user.lastLogin = new Date();
    await user.save();

    // Propagate this password to the person's other pending accounts (same email
    // in other companies) so they can reach all their workspaces with one
    // password. user.password is now the bcrypt hash; updateMany stores it as-is.
    await User.updateMany(
      { email: normEmail, _id: { $ne: user._id }, isRegistered: false },
      { password: user.password, isRegistered: true, isFirstLogin: false, setupOtpHash: null, setupOtpExpires: null }
    );

    setRefreshTokenCookie(res, refreshToken);

    await AuditLog.create({
      performedBy: user._id, action: 'ACCOUNT_SETUP_COMPLETED',
      targetModel: 'User', targetId: user._id,
      details: { email: user.email }, ipAddress: req.ip,
    });

    // Fetch org info for the client (same shape as login)
    let organization = null;
    if (user.organizationId) {
      const Organization = require('../models/Organization');
      const org = await Organization.findById(user.organizationId).select('name subscriptionTier limits');
      if (org) organization = { id: org._id, name: org.name, subscriptionTier: org.subscriptionTier, limits: org.limits };
    }

    res.json({
      success: true,
      message: 'Account set up successfully. Welcome to TaskBridge!',
      accessToken,
      user: user.toJSON(),
      organization,
      requirePasswordChange: false,
    });
  } catch (error) {
    console.error('Setup account error:', error);
    res.status(500).json({ success: false, message: 'Failed to set up account' });
  }
};

// POST /api/auth/select-workspace
// Completes login when one email+password matched multiple workspaces.
const selectWorkspace = async (req, res) => {
  try {
    const { selectionToken, userId } = req.body;
    if (!selectionToken || !userId) {
      return res.status(400).json({ success: false, message: 'Workspace selection is required' });
    }
    let decoded;
    try {
      decoded = jwt.verify(selectionToken, process.env.JWT_ACCESS_SECRET);
    } catch {
      return res.status(401).json({ success: false, message: 'Selection expired. Please sign in again.' });
    }
    if (decoded.purpose !== 'workspace_select' || !Array.isArray(decoded.ids) || !decoded.ids.includes(String(userId))) {
      return res.status(400).json({ success: false, message: 'Invalid workspace selection' });
    }
    const user = await User.findById(userId);
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: 'Account not available' });
    }
    return issueLoginResponse(req, res, user);
  } catch (error) {
    console.error('Select workspace error:', error);
    res.status(500).json({ success: false, message: 'Failed to select workspace' });
  }
};

// GET /api/auth/me
const getMe = async (req, res) => {
  res.json({ success: true, user: req.user });
};

// POST /api/auth/forgot-password
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

    // Always respond with the same message to prevent email enumeration
    const SAFE_MSG = 'If that email is registered, a reset link has been sent.';

    const normEmail = email.toLowerCase().trim();
    // The same email may have a registered account in multiple companies — issue
    // one reset token across all of them so the reset works regardless of which
    // workspace they meant.
    const users = await User.find({ email: normEmail, isActive: true, password: { $ne: null } });
    if (users.length === 0) {
      return res.json({ success: true, message: SAFE_MSG });
    }

    const rawToken   = crypto.randomBytes(32).toString('hex');
    const tokenHash  = crypto.createHash('sha256').update(rawToken).digest('hex');

    await User.updateMany(
      { email: normEmail, isActive: true, password: { $ne: null } },
      { passwordResetToken: tokenHash, passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000) }
    );

    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0];
    const resetUrl    = `${frontendUrl}/reset-password/${rawToken}`;

    await sendPasswordResetEmail(users[0], resetUrl);

    if (process.env.NODE_ENV !== 'production') {
      console.log(`🔑 Password reset URL (dev): ${resetUrl}`);
    }

    await AuditLog.create({ performedBy: users[0]._id, action: 'PASSWORD_RESET_REQUESTED', targetModel: 'User', targetId: users[0]._id, ipAddress: req.ip });

    res.json({ success: true, message: SAFE_MSG });
  } catch (error) {
    console.error('forgotPassword:', error);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

// POST /api/auth/reset-password/:token
const resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!token || !password)
      return res.status(400).json({ success: false, message: 'Token and password are required' });

    const passwordError = validatePasswordComplexity(password);
    if (passwordError) return res.status(400).json({ success: false, message: passwordError });

    // Hash the raw token to compare against stored hash
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // A single reset token may be set on several accounts (same email, multiple
    // companies) — update them all so the new password works everywhere.
    const users = await User.find({
      passwordResetToken:   hashedToken,
      passwordResetExpires: { $gt: Date.now() },
    }).select('+password +passwordResetToken +passwordResetExpires +loginAttempts +lockUntil');

    if (users.length === 0) {
      return res.status(400).json({ success: false, message: 'Reset link is invalid or has expired. Please request a new one.' });
    }

    for (const user of users) {
      user.password             = password;
      user.passwordResetToken   = null;
      user.passwordResetExpires = null;
      user.loginAttempts        = 0;
      user.lockUntil            = null;
      user.isFirstLogin         = false;
      user.isRegistered         = true;
      user.refreshTokens        = []; // force re-login on all devices
      await user.save();
    }

    await sendPasswordChangedEmail(users[0]);
    await AuditLog.create({ performedBy: users[0]._id, action: 'PASSWORD_RESET_COMPLETED', targetModel: 'User', targetId: users[0]._id, ipAddress: req.ip });

    res.json({ success: true, message: 'Password reset successful. You can now sign in with your new password.' });
  } catch (error) {
    console.error('resetPassword:', error);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

module.exports = { login, refreshToken, logout, changePassword, getMe, requestSetupOtp, setupAccount, selectWorkspace, forgotPassword, resetPassword };
