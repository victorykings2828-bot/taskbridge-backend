const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const express = require('express');
const router = express.Router();
const passport = require('../../config/passport');
const User = require('../models/User');
const Organization = require('../models/Organization');
const { login, refreshToken, logout, changePassword, getMe, requestSetupOtp, setupAccount, selectWorkspace, forgotPassword, resetPassword } = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const {
  generateAccessToken,
  generateRefreshToken,
  setRefreshTokenCookie,
} = require('../utils/jwt');

// Hash helper (same as authController)
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

router.post('/login', login);
router.post('/select-workspace', selectWorkspace);
router.post('/setup-account/request-otp', requestSetupOtp);
router.post('/setup-account', setupAccount);
router.post('/refresh', refreshToken);
router.post('/logout', logout);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password/:token', resetPassword);
router.post('/change-password', authenticate, changePassword);
router.get('/me', authenticate, getMe);

// Google OAuth — only works if GOOGLE_CLIENT_ID is set in .env
router.get('/google',
  passport.authenticate('google', { scope: ['profile', 'email'], session: false })
);

router.get('/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: `${process.env.FRONTEND_URL}/login?error=google_failed` }),
  async (req, res) => {
    const frontendURL = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0];
    try {
      const email = req.user.googleEmail;
      const name  = req.user.googleName;

      const all    = await User.find({ email });
      const active = all.filter((u) => u.isActive);

      // Has account(s) but all are deactivated.
      if (all.length > 0 && active.length === 0) {
        return res.redirect(`${frontendURL}/login?error=deactivated`);
      }

      // Brand-new Google user → name-your-workspace signup.
      if (active.length === 0) {
        const signupToken = jwt.sign(
          { purpose: 'google_signup', email, name },
          process.env.JWT_ACCESS_SECRET,
          { expiresIn: '15m' }
        );
        return res.redirect(`${frontendURL}/register/google?token=${signupToken}`);
      }

      // Google verified the email → finish onboarding for any pending account.
      for (const u of active) {
        if (!u.isRegistered) { u.isRegistered = true; u.isFirstLogin = false; await u.save(); }
      }

      // Single workspace → log straight in.
      if (active.length === 1) {
        const user = active[0];
        const accessToken  = generateAccessToken(user._id, user.role);
        const refreshTok   = generateRefreshToken(user._id);
        user.refreshTokens.push({ token: hashToken(refreshTok) });
        if (user.refreshTokens.length > 5) user.refreshTokens = user.refreshTokens.slice(-5);
        user.lastLogin = new Date();
        await user.save();
        setRefreshTokenCookie(res, refreshTok);
        return res.redirect(`${frontendURL}/auth/google/success?token=${accessToken}`);
      }

      // Multiple workspaces → send a selection token; frontend shows the picker.
      const workspaces = await Promise.all(active.map(async (u) => {
        const org = await Organization.findById(u.organizationId).select('name');
        return { userId: u._id.toString(), role: u.role, name: org?.name || 'Workspace' };
      }));
      const selectToken = jwt.sign(
        { purpose: 'workspace_select', ids: active.map((u) => u._id.toString()), workspaces },
        process.env.JWT_ACCESS_SECRET,
        { expiresIn: '10m' }
      );
      return res.redirect(`${frontendURL}/auth/google/success?selectToken=${selectToken}`);
    } catch (err) {
      console.error('google/callback:', err);
      res.redirect(`${frontendURL}/login?error=google_failed`);
    }
  }
);

module.exports = router;

