const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const passport = require('../../config/passport');
const { login, refreshToken, logout, changePassword, getMe, forgotPassword, resetPassword } = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const {
  generateAccessToken,
  generateRefreshToken,
  setRefreshTokenCookie,
} = require('../utils/jwt');

// Hash helper (same as authController)
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

router.post('/login', login);
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
  passport.authenticate('google', { session: false, failureRedirect: '/login?error=google_failed' }),
  async (req, res) => {
    try {
      const user = req.user;
      const accessToken  = generateAccessToken(user._id, user.role);
      const newRefreshToken = generateRefreshToken(user._id);
      const hashedRefresh = hashToken(newRefreshToken);

      user.refreshTokens.push({ token: hashedRefresh });
      if (user.refreshTokens.length > 5) user.refreshTokens = user.refreshTokens.slice(-5);
      await user.save();

      setRefreshTokenCookie(res, newRefreshToken);

      const frontendURL = process.env.FRONTEND_URL || 'http://localhost:3000';

      if (user.isFirstLogin) {
        // Pass token via query param so frontend can store it, then redirect to change-password
        return res.redirect(`${frontendURL}/auth/google/success?token=${accessToken}&requirePasswordChange=true`);
      }
      res.redirect(`${frontendURL}/auth/google/success?token=${accessToken}`);
    } catch (err) {
      res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/login?error=google_failed`);
    }
  }
);

module.exports = router;

