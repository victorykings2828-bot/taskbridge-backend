const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const passport = require('../../config/passport');
const { login, refreshToken, logout, changePassword, getMe, setupAccount, selectWorkspace, forgotPassword, resetPassword } = require('../controllers/authController');
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
      const user = req.user;

      // New Google user (no account yet) → issue a short-lived signup token and
      // send them to name their workspace before the account is created.
      if (user?.isNewGoogleUser) {
        const jwt = require('jsonwebtoken');
        const signupToken = jwt.sign(
          { purpose: 'google_signup', email: user.email, name: user.name },
          process.env.JWT_ACCESS_SECRET,
          { expiresIn: '15m' }
        );
        return res.redirect(`${frontendURL}/register/google?token=${signupToken}`);
      }

      // Existing user → log in. Google has verified the email, so finish
      // onboarding for an admin-created account that never set a password
      // (otherwise it would be stuck on the password-setup / change flow).
      if (!user.isRegistered || !user.password) {
        user.isRegistered = true;
        user.isFirstLogin = false;
      }

      const accessToken  = generateAccessToken(user._id, user.role);
      const newRefreshToken = generateRefreshToken(user._id);
      const hashedRefresh = hashToken(newRefreshToken);

      user.refreshTokens.push({ token: hashedRefresh });
      if (user.refreshTokens.length > 5) user.refreshTokens = user.refreshTokens.slice(-5);
      await user.save();

      setRefreshTokenCookie(res, newRefreshToken);

      if (user.isFirstLogin) {
        return res.redirect(`${frontendURL}/auth/google/success?token=${accessToken}&requirePasswordChange=true`);
      }
      res.redirect(`${frontendURL}/auth/google/success?token=${accessToken}`);
    } catch (err) {
      res.redirect(`${frontendURL}/login?error=google_failed`);
    }
  }
);

module.exports = router;

