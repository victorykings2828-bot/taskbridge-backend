const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../src/models/User');

// Only register Google OAuth strategy if credentials are configured
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID:     process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL:  process.env.GOOGLE_CALLBACK_URL || 'http://localhost:5000/api/auth/google/callback',
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value?.toLowerCase();
          if (!email) return done(null, false, { message: 'No email from Google' });

          const user = await User.findOne({ email });

          // New Google email → allow signup. Carry the verified identity to the
          // callback, which will route them to "name your workspace".
          if (!user) {
            return done(null, { isNewGoogleUser: true, email, name: profile.displayName || '' });
          }
          if (!user.isActive) {
            return done(null, false, { message: 'Your account has been deactivated.' });
          }

          // Existing user → log in
          user.lastLogin = new Date();
          await user.save();
          return done(null, user);
        } catch (err) {
          return done(err, null);
        }
      }
    )
  );
  console.log('✅ Google OAuth strategy registered');
} else {
  console.log('ℹ️  Google OAuth not configured (GOOGLE_CLIENT_ID missing) — skipping');
}

module.exports = passport;
