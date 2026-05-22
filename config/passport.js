const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../src/models/User');

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

        // Only allow login for existing users — no self-registration
        const user = await User.findOne({ email });
        if (!user) {
          return done(null, false, {
            message: 'No account found for this Google email. Contact your administrator.',
          });
        }
        if (!user.isActive) {
          return done(null, false, { message: 'Your account has been deactivated.' });
        }

        // Update last login
        user.lastLogin = new Date();
        await user.save();

        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }
  )
);

module.exports = passport;
