const crypto = require('crypto');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
} = require('../utils/jwt');
const { sendPasswordChangedEmail, sendPasswordResetEmail } = require('../utils/email');

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

    const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password +loginAttempts +lockUntil');
    
    // Always run bcrypt even if user not found (prevent timing attacks)
    const dummyHash = '$2a$12$dummyhashtopreventtimingattacksonnonexistentemails.xxx';
    
    if (!user) {
      await require('bcryptjs').compare(password, dummyHash).catch(() => {});
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    // Check account lock
    if (user.lockUntil && user.lockUntil > Date.now()) {
      const minutesLeft = Math.ceil((user.lockUntil - Date.now()) / 60000);
      return res.status(429).json({
        success: false,
        message: `Account locked due to too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft > 1 ? 's' : ''}.`,
      });
    }

    if (!user.isActive) {
      return res.status(403).json({ success: false, message: 'Your account has been deactivated. Contact your administrator.' });
    }

    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      // Increment failed attempts
      user.loginAttempts = (user.loginAttempts || 0) + 1;
      if (user.loginAttempts >= 5) {
        user.lockUntil = new Date(Date.now() + 15 * 60 * 1000); // Lock 15 min
        user.loginAttempts = 0;
        await user.save();
        await AuditLog.create({
          performedBy: user._id, action: 'ACCOUNT_LOCKED',
          targetModel: 'User', targetId: user._id,
          details: { reason: 'Too many failed login attempts' }, ipAddress: req.ip,
        });
        return res.status(429).json({ success: false, message: 'Too many failed attempts. Account locked for 15 minutes.' });
      }
      await user.save();
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    // Successful login — reset lockout
    user.loginAttempts = 0;
    user.lockUntil = null;

    const accessToken  = generateAccessToken(user._id, user.role);
    const refreshToken = generateRefreshToken(user._id);
    const hashedRefresh = hashToken(refreshToken);

    // Store HASHED refresh token
    user.refreshTokens.push({ token: hashedRefresh });
    if (user.refreshTokens.length > 5) user.refreshTokens = user.refreshTokens.slice(-5);
    user.lastLogin = new Date();
    await user.save();

    setRefreshTokenCookie(res, refreshToken);

    await AuditLog.create({
      performedBy: user._id, action: 'USER_LOGIN',
      targetModel: 'User', targetId: user._id,
      details: { email: user.email }, ipAddress: req.ip,
    });

    // Fetch org info if user belongs to one
    let organization = null;
    if (user.organizationId) {
      const Organization = require('../models/Organization');
      const org = await Organization.findById(user.organizationId).select('name joinCode subscriptionTier limits');
      if (org) organization = { id: org._id, name: org.name, joinCode: org.joinCode, subscriptionTier: org.subscriptionTier, limits: org.limits };
    }

    res.json({
      success: true,
      message: 'Login successful',
      accessToken,
      user: user.toJSON(),
      organization,
      requirePasswordChange: user.isFirstLogin,
    });
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

    const user = await User.findOne({ email: email.toLowerCase().trim() })
      .select('+passwordResetToken +passwordResetExpires');

    if (!user || !user.isActive) {
      return res.json({ success: true, message: SAFE_MSG });
    }

    // Generate a crypto-random 32-byte token
    const rawToken  = crypto.randomBytes(32).toString('hex');
    const hashToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    user.passwordResetToken   = hashToken;
    user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save();

    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0];
    const resetUrl    = `${frontendUrl}/reset-password/${rawToken}`;

    await sendPasswordResetEmail(user, resetUrl);

    // In dev, log the reset URL so you can test without email
    if (process.env.NODE_ENV !== 'production') {
      console.log(`🔑 Password reset URL (dev): ${resetUrl}`);
    }

    await AuditLog.create({ performedBy: user._id, action: 'PASSWORD_RESET_REQUESTED', targetModel: 'User', targetId: user._id, ipAddress: req.ip });

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

    const user = await User.findOne({
      passwordResetToken:   hashedToken,
      passwordResetExpires: { $gt: Date.now() },
    }).select('+password +passwordResetToken +passwordResetExpires +loginAttempts +lockUntil');

    if (!user) {
      return res.status(400).json({ success: false, message: 'Reset link is invalid or has expired. Please request a new one.' });
    }

    // Update password + clear reset fields + clear lockout
    user.password             = password;
    user.passwordResetToken   = null;
    user.passwordResetExpires = null;
    user.loginAttempts        = 0;
    user.lockUntil            = null;
    user.isFirstLogin         = false;
    // Invalidate all refresh tokens (security: force re-login on all devices)
    user.refreshTokens        = [];
    await user.save();

    await sendPasswordChangedEmail(user);
    await AuditLog.create({ performedBy: user._id, action: 'PASSWORD_RESET_COMPLETED', targetModel: 'User', targetId: user._id, ipAddress: req.ip });

    res.json({ success: true, message: 'Password reset successful. You can now sign in with your new password.' });
  } catch (error) {
    console.error('resetPassword:', error);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

module.exports = { login, refreshToken, logout, changePassword, getMe, forgotPassword, resetPassword };
