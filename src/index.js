// Render's network has no outbound IPv6. Force Node to resolve hostnames to
// IPv4 first so SMTP (Gmail) and other outbound connections don't fail with
// "connect ENETUNREACH <ipv6>:587". Must run before any outbound connection.
const dns = require('dns');
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();
const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit    = require('express-rate-limit');
const sanitize     = require('mongo-sanitize');
const sanitizeHtml = require('sanitize-html');
const passport     = require('../config/passport');
const connectDB    = require('../config/database');
const errorHandler = require('./middleware/errorHandler');

// ── Validate critical env vars ─────────────────────────────────────────────
const REQUIRED_ENV = ['MONGODB_URI', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`❌ Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

// Warn when Razorpay is partially configured — partial config silently disables
// webhook signature verification or breaks payment flows.
if (process.env.RAZORPAY_KEY_ID && !process.env.RAZORPAY_WEBHOOK_SECRET) {
  console.warn('⚠️  RAZORPAY_KEY_ID is set but RAZORPAY_WEBHOOK_SECRET is missing — all webhook requests will be rejected');
}
if (process.env.RAZORPAY_KEY_ID && !process.env.RAZORPAY_KEY_SECRET) {
  console.warn('⚠️  RAZORPAY_KEY_ID is set but RAZORPAY_KEY_SECRET is missing — payment flows will fail');
}

const app    = express();
const isProd = process.env.NODE_ENV === 'production';

connectDB();

// ── Helmet ─────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // handled by Vercel frontend
  crossOriginEmbedderPolicy: false,
}));

// ── CORS ───────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    // Allow no-origin requests (curl, mobile) in dev
    if (!origin) return cb(null, !isProd);
    // Allow any vercel.app subdomain + configured origins
    if (
      allowedOrigins.includes(origin) ||
      origin.endsWith('.vercel.app') ||
      origin === 'http://localhost:3000' ||
      origin === 'http://localhost:5173'
    ) return cb(null, true);
    cb(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  maxAge: 600,
}));

// ── Rate limiting ──────────────────────────────────────────────────────────
const skip = (req) => req.method === 'OPTIONS';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 200,
  message: { success: false, message: 'Too many requests' },
  skip: (req) => req.path === '/health' || req.method === 'OPTIONS',
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { success: false, message: 'Too many login attempts' }, skip,
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,
  message: { success: false, message: 'Too many registration attempts' }, skip,
});
const strictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  message: { success: false, message: 'Too many requests' }, skip,
});
// Tight limit for payment order creation and verification — prevents brute-forcing
// payment IDs or flooding Razorpay with fraudulent order requests.
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { success: false, message: 'Too many payment requests. Please try again later.' }, skip,
});

app.set('trust proxy', 1);
app.use('/api/', limiter);
app.use('/api/auth/login',              authLimiter);
app.use('/api/auth/setup-account',      strictLimiter);
app.use('/api/auth/forgot-password',    authLimiter);
app.use('/api/auth/reset-password',     strictLimiter);
app.use('/api/auth/change-password',    strictLimiter);
app.use('/api/org/register',            registerLimiter);
app.use('/api/payments/create-order',   paymentLimiter);
app.use('/api/payments/verify',         paymentLimiter);

// ── Body parsing ───────────────────────────────────────────────────────────
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser(process.env.COOKIE_SECRET || process.env.JWT_ACCESS_SECRET));
app.use(passport.initialize());

// ── Input sanitization ─────────────────────────────────────────────────────
const SENSITIVE_FIELDS = new Set(['password', 'currentPassword', 'newPassword', 'confirmPassword', 'token']);

const deepSanitize = (obj) => {
  if (typeof obj !== 'object' || obj === null) return sanitize(obj);
  for (const key of Object.keys(obj)) obj[key] = deepSanitize(obj[key]);
  return obj;
};

const sanitizeStrings = (obj, parentKey = '') => {
  if (typeof obj === 'string') {
    if (SENSITIVE_FIELDS.has(parentKey)) return obj;
    return sanitizeHtml(obj, { allowedTags: [], allowedAttributes: {} });
  }
  if (typeof obj === 'object' && obj !== null) {
    for (const key of Object.keys(obj)) obj[key] = sanitizeStrings(obj[key], key);
  }
  return obj;
};

app.use((req, res, next) => {
  if (req.body && !(req.body instanceof Buffer)) {
    req.body   = sanitizeStrings(deepSanitize(req.body));
  }
  if (req.query)  req.query  = deepSanitize(req.query);
  if (req.params) req.params = deepSanitize(req.params);
  next();
});

// ── Security headers ───────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// ── Routes ─────────────────────────────────────────────────────────────────
app.use('/api/auth',          require('./routes/authRoutes'));
app.use('/api/payments',      require('./routes/paymentRoutes'));
app.use('/api/analytics',     require('./routes/analyticsRoutes'));
app.use('/api/org',           require('./routes/orgRoutes'));
app.use('/api/users',         require('./routes/userRoutes'));
app.use('/api/tasks',         require('./routes/taskRoutes'));
app.use('/api/tasks/:taskId/comments', require('./routes/commentRoutes'));
app.use('/api/notifications', require('./routes/notificationRoutes'));
app.use('/api/audit-logs',    require('./routes/auditRoutes'));
app.use('/api/feedback',      require('./routes/feedbackRoutes'));
app.use('/api/admin',         require('./routes/adminRoutes'));

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── 404 ────────────────────────────────────────────────────────────────────
app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

app.use(errorHandler);

const PORT   = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`🚀 TaskBridge API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});

process.on('unhandledRejection', (reason) => { console.error('Unhandled rejection:', reason); });
process.on('uncaughtException',  (err)    => { console.error('Uncaught exception:', err); server.close(() => process.exit(1)); });
process.on('SIGTERM',            ()       => { server.close(() => process.exit(0)); });

module.exports = app;
