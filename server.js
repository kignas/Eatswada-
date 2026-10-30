require('dotenv').config();

const express        = require('express');
const mongoose       = require('mongoose');
const helmet         = require('helmet');
const cors           = require('cors');
const rateLimit      = require('express-rate-limit');
const mongoSanitize  = require('express-mongo-sanitize');
const sanitizeInput  = require('./middleware/sanitizeInput');
const hpp            = require('hpp');
const compression    = require('compression');
const morgan         = require('morgan');

const connectDB      = require('./config/db');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');
const { requestLogger } = require('./middleware/requestLogger');
const perfDiagnostics = require('./utils/perfDiagnostics');

// ── Route & Model imports ─────────────────────────────────────
const userRoutes       = require('./routes/userRoutes');
const restaurantRoutes = require('./routes/restaurantRoutes');
const cartRoutes       = require('./routes/cartRoutes');
const orderRoutes      = require('./routes/orderRoutes');
const vendorRoutes     = require('./routes/vendorRoutes');
const vendorApplicationRoutes = require('./routes/vendorApplicationRoutes'); 
const adminRoutes      = require('./routes/adminRoutes');
const authRoutes       = require('./routes/authRoutes');
const uploadRoutes     = require('./routes/uploadRoutes');
const categoryRoutes   = require('./routes/categoryRoutes');
const menuRoutes       = require('./routes/menuRoutes');
const riderRoutes      = require('./routes/riderRoutes');
const adminRiderRoutes = require('./routes/adminRiderRoutes');
const riderApplicationRoutes = require('./routes/riderApplicationRoutes');
const platformRatingRoutes = require('./routes/platformRatingRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const settlementRoutes = require('./routes/settlementRoutes');
const couponRoutes = require('./routes/couponRoutes');
const platformRoutes = require('./routes/platformRoutes');
const pricingRoutes = require('./routes/pricingRoutes');
const adminPricingRoutes = require('./routes/adminPricingRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const firebaseAuthRoutes = require('./routes/firebaseAuthRoutes');
const homeBannerRoutes = require('./routes/homeBannerRoutes');
const privacyRoutes = require('./routes/privacyRoutes');
const customerSupportRoutes = require('./routes/customerSupportRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const { handleWebhook } = require('./controllers/paymentController');

// ── Connect to MongoDB ────────────────────────────────────────
// (connection is awaited below, right before the server starts listening)

// 🚨 APP IS CREATED HERE FIRST! 🚨
const app = express();

// Number of reverse proxies sitting in front of Node (nginx, ALB, Cloudflare...).
// The rate limiter keys on req.ip, so this MUST match your real proxy chain:
//   too LOW  -> every user looks like the proxy's IP and they all share one
//               rate-limit bucket (the classic "Too many requests" everywhere bug)
//   too HIGH -> clients can spoof their IP through X-Forwarded-For.
// Set TRUST_PROXY_HOPS in the EC2 .env to change it. Default is 1.
const trustProxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS, 10);
app.set(
  'trust proxy',
  Number.isInteger(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 1
);

// Opt-in performance diagnostics for controlled staging/load-test runs.
// Disabled by default; when enabled it records request latency, event-loop
// delay, CPU/cgroup throttling, MongoDB command timings and pool behavior.
if (perfDiagnostics.enabled) app.use(perfDiagnostics.middleware);

// ── Middleware ────────────────────────────────────────────────
app.use(compression());
app.use(helmet());

// ── CORS ────────────────────────────────────────────────────────
// Keep production origins explicit. Set CORS_ORIGINS in the server .env as a
// comma-separated list for any additional customer/admin/vendor origins.
// Example:
// CORS_ORIGINS=https://eatswada.com,https://www.eatswada.com,https://kignas.github.io
const configuredCorsOrigins = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const corsOrigins = [
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://eatswada.com',
  'https://www.eatswada.com',
  'https://eatswada-nextjs.vercel.app',
  'https://kignas.github.io',
  // Capacitor Android/iOS WebView origins for packaged apps.
  'https://localhost',
  'capacitor://localhost',
  ...configuredCorsOrigins
].filter((origin, index, list) => list.indexOf(origin) === index);

// The new Next.js preview is intentionally read-only at the browser CORS layer
// while it is being verified against the shared production database.
const nextPreviewOrigin = 'https://eatswada-nextjs.vercel.app';
const corsOptionsForRequest = (req) => ({
  origin(origin, callback) {
    // Non-browser/server-to-server requests have no Origin header.
    if (!origin) return callback(null, true);
    if (corsOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS origin not allowed: ${origin}`));
  },
  credentials: true,
  // Limit this preview origin to read-only browser methods during initial testing.
  // Other already-approved origins retain the existing method policy.
  methods: req.headers.origin === nextPreviewOrigin
    ? ['GET', 'HEAD', 'OPTIONS']
    : ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'x-setup-key']
});

app.use((req, res, next) => cors(corsOptionsForRequest(req))(req, res, next));
app.options('*', (req, res, next) => cors(corsOptionsForRequest(req))(req, res, next));

// Razorpay webhooks need the exact raw request bytes for HMAC verification.
// Both supported API prefixes must use the raw parser BEFORE express.json().
// Registered BEFORE the rate limiters on purpose: webhooks come from Razorpay's
// servers (shared IPs) and are authenticated by HMAC, so a 429 here would make
// Razorpay's payment confirmations fail.
const razorpayWebhookRawBody = express.raw({ type: 'application/json', limit: '1mb' });
app.post('/api/payments/webhook', razorpayWebhookRawBody, handleWebhook);
app.post('/api/v1/payments/webhook', razorpayWebhookRawBody, handleWebhook);

// ── TEMPORARY: client-IP diagnostic ───────────────────────────
// Only exists when IP_DEBUG_KEY is set in the server .env. Open it in a phone
// browser:  https://<your-api-domain>/api/_ip-debug?key=<IP_DEBUG_KEY>
// If "ip" is NOT your real public IP (or is the same on two different phones),
// TRUST_PROXY_HOPS is wrong. Remove IP_DEBUG_KEY from .env when you're done.
if (process.env.IP_DEBUG_KEY) {
  app.get('/api/_ip-debug', (req, res) => {
    if (req.query.key !== process.env.IP_DEBUG_KEY) return res.status(404).end();
    res.set('Cache-Control', 'no-store');
    res.json({
      ip: req.ip,
      ips: req.ips,
      forwardedFor: req.get('x-forwarded-for') || null,
      socketAddress: req.socket.remoteAddress,
      trustProxy: app.get('trust proxy')
    });
  });
}

// ── Rate limiting ─────────────────────────────────────────────
// Reads (GET/HEAD) and writes (POST/PUT/PATCH/DELETE) have separate buckets so
// browsing menus can never lock someone out of placing an order. Limits are
// generous on purpose: many Indian mobile users share one carrier-NAT IP, and a
// single restaurant page fires several API calls (plus polling).
// Brute-force protection for login/OTP lives in the route files' own limiters.
// Health checks and CORS preflights are never counted.
// Env overrides (new names, so old low RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS
// values left in .env no longer apply):
//   RATE_LIMIT_API_WINDOW_MS, RATE_LIMIT_READ_MAX, RATE_LIMIT_WRITE_MAX
const RATE_LIMIT_EXEMPT_PATHS = new Set(['/', '/live', '/ready', '/health']);
const isReadRequest      = (req) => req.method === 'GET' || req.method === 'HEAD';
const isRateLimitExempt  = (req) => req.method === 'OPTIONS' || RATE_LIMIT_EXEMPT_PATHS.has(req.path);
const rateLimitWindowMs  = Number(process.env.RATE_LIMIT_API_WINDOW_MS) || 15 * 60 * 1000;
const rateLimitMessage   = { success: false, message: 'Too many requests, please slow down.' };

const readLimiter = rateLimit({
  windowMs: rateLimitWindowMs,
  max:      Number(process.env.RATE_LIMIT_READ_MAX) || 5000,
  standardHeaders: true, legacyHeaders: false,
  message: rateLimitMessage,
  skip: (req) => isRateLimitExempt(req) || !isReadRequest(req),
});

const writeLimiter = rateLimit({
  windowMs: rateLimitWindowMs,
  max:      Number(process.env.RATE_LIMIT_WRITE_MAX) || 1500,
  standardHeaders: true, legacyHeaders: false,
  message: rateLimitMessage,
  skip: (req) => isRateLimitExempt(req) || isReadRequest(req),
});

app.use(readLimiter);
app.use(writeLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts. Try again in 15 minutes.' },
});

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(mongoSanitize());
app.use(sanitizeInput);
app.use(hpp({ whitelist: ['sort', 'category', 'cuisine'] }));

if (process.env.NODE_ENV === 'development') app.use(morgan('dev'));

// Foundation-1.1 — structured request logging in every environment.
// morgan('dev') above stays dev-only; this runs in production too and never
// logs bodies, tokens, or query strings. Placed after body parsing so req.user
// is not yet set here — actor is resolved at res 'finish', by which point auth
// middleware on the matched route has populated req.user.
app.use(requestLogger);

// Endpoint-specific password-reset diagnostics. Never logs passwords, tokens, or SMTP secrets.
app.use('/api/users/forgot-password/email', (req, res, next) => {
  console.log(`[PASSWORD-RESET-HTTP] request ${req.method} ${req.originalUrl} origin=${req.get('origin') || 'none'} email=${req.body?.email ? 'provided' : 'missing'}`);
  res.on('finish', () => {
    console.log(`[PASSWORD-RESET-HTTP] response status=${res.statusCode} success=${res.statusCode >= 200 && res.statusCode < 300}`);
  });
  next();
});

// ── Health & Welcome Routes ───────────────────────────────────
// Liveness answers only whether this Node process is running. It deliberately
// does not depend on MongoDB, so an orchestrator can distinguish a live process
// from a temporarily unavailable dependency.
app.get('/live', (req, res) => {
  res.status(200).json({ success: true, live: true, service: 'Eatswada API' });
});

// Readiness is dependency-aware: do not send production traffic until MongoDB
// is connected. Keep the response free of connection strings/internal details.
app.get('/ready', (req, res) => {
  const ready = mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({
    success: ready,
    ready,
    service: 'Eatswada API',
    version: '1.0.0',
    uptime: process.uptime().toFixed(2) + 's'
  });
});

// Backward-compatible health endpoint used by existing deployment checks.
app.get('/health', (req, res) => {
  const ready = mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({
    success: ready,
    ready,
    service: 'Eatswada API',
    version: '1.0.0',
    uptime: process.uptime().toFixed(2) + 's'
  });
});

app.get('/', (req, res) => {
  res.status(200).send('<h2>🍔 Nearbite Backend API is Live and Running! 🚀</h2>');
});

// Authentication endpoints have their own focused limiters in the route files.
// Do not blanket-rate-limit every authenticated /api/users request.
// Foundation-1.1 — API versioning, added non-destructively.
// Every router below is mounted under BOTH the original '/api/...' prefix
// (which all four existing frontends still use) AND a new '/api/v1/...'
// prefix. Same handlers, so behaviour is identical; new frontend code can
// migrate to /api/v1 gradually. No existing path is removed.
const apiMounts = [
  ['/users',                userRoutes],
  ['/auth',                 authRoutes],
  ['/restaurants',          restaurantRoutes],
  ['/cart',                 cartRoutes],
  ['/orders',               orderRoutes],
  ['/vendor',               vendorRoutes],
  ['/vendor-applications',  vendorApplicationRoutes],
  ['/admin',                adminRoutes],
  ['/home-banners', homeBannerRoutes],
  ['/upload',               uploadRoutes],
  ['/categories',           categoryRoutes],
  ['/menu',                 menuRoutes],
  ['/riders',               riderRoutes],
  ['/rider-applications',   riderApplicationRoutes],
  ['/admin/riders',         adminRiderRoutes],
  ['/ratings',              platformRatingRoutes],
  ['/payments',             paymentRoutes],
  ['/settlements',          settlementRoutes],
  ['/coupons',              couponRoutes],
  ['/platform',             platformRoutes],
  ['/pricing',              pricingRoutes],
  ['/admin/pricing',        adminPricingRoutes],
  ['/notifications',        notificationRoutes],
  ['/privacy',             privacyRoutes],
  ['/support',             customerSupportRoutes],
  ['/analytics',           analyticsRoutes],
  ['/auth',                 firebaseAuthRoutes],
];

for (const [path, router] of apiMounts) {
  app.use(`/api${path}`, router);      // legacy — unchanged
  app.use(`/api/v1${path}`, router);   // versioned — same handler
}

// ── Global Error Handlers ─────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── Start Server ──────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
let server;

const { startAssignmentRecovery } = require('./services/riderAssignmentService');
const { startRestaurantResponseRecovery } = require('./services/restaurantOrderTimeoutService');
const { startAbandonedCheckoutRecovery } = require('./services/abandonedCheckoutService');
const { startMenuStockScheduler } = require('./services/menuStockScheduler');

connectDB().then(() => {
  // Durable safety net for rider auto-assignment: an in-process setTimeout is
  // lost on restart/sleep, so on boot (and periodically) sweep for orders left
  // in 'assigned' past the accept window and reassign them.
  startAssignmentRecovery();
  // Durable safety net for the restaurant's 5-minute response window.
  startRestaurantResponseRecovery();
  // Expire unpaid online checkouts (after a Razorpay late-capture check) so
  // abandoned UPI orders do not hold reserved stock forever.
  startAbandonedCheckoutRecovery();
  // Recover scheduled automatic menu restocks after restarts and every minute.
  startMenuStockScheduler();

  if (perfDiagnostics.enabled) perfDiagnostics.start(mongoose.connection);

  server = app.listen(PORT, '0.0.0.0', () => {
    console.log('╔══════════════════════════════════════════════╗');
    console.log(`║  🍔  Nearbite API running on port ${PORT}       ║`);
    console.log('╚══════════════════════════════════════════════╝');
  });

  process.on('unhandledRejection', (err) => {
    console.error(`❌ Unhandled Rejection: ${err.message}`);
    server.close(() => process.exit(1));
  });
  process.on('SIGTERM', () => {
    server.close(async () => {
      try { await mongoose.connection.close(false); } catch (_) {}
      process.exit(0);
    });
  });
});

module.exports = app;
