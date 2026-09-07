require('dotenv').config();

const express        = require('express');
const helmet         = require('helmet');
const cors           = require('cors');
const rateLimit      = require('express-rate-limit');
const mongoSanitize  = require('express-mongo-sanitize');
const xssClean       = require('xss-clean');
const hpp            = require('hpp');
const compression    = require('compression');
const morgan         = require('morgan');

const connectDB      = require('./config/db');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');

// ── Route & Model imports ─────────────────────────────────────
const userRoutes       = require('./routes/userRoutes');
const restaurantRoutes = require('./routes/restaurantRoutes');
const cartRoutes       = require('./routes/cartRoutes');
const orderRoutes      = require('./routes/orderRoutes');
const vendorRoutes     = require('./routes/vendorRoutes'); 
const adminRoutes      = require('./routes/adminRoutes');
const authRoutes       = require('./routes/authRoutes');
const uploadRoutes     = require('./routes/uploadRoutes');
const categoryRoutes   = require('./routes/categoryRoutes');
const menuRoutes       = require('./routes/menuRoutes');
const riderRoutes      = require('./routes/riderRoutes');
const adminRiderRoutes = require('./routes/adminRiderRoutes');
const platformRatingRoutes = require('./routes/platformRatingRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const { handleWebhook } = require('./controllers/paymentController');

// ── Connect to MongoDB ────────────────────────────────────────
// (connection is awaited below, right before the server starts listening)

// 🚨 APP IS CREATED HERE FIRST! 🚨
const app = express();

app.set("trust proxy", 1);

// ── Middleware ────────────────────────────────────────────────
app.use(compression());
app.use(helmet());

// ── CORS ────────────────────────────────────────────────────────
// Keep production origins explicit. Set CORS_ORIGINS in Render as a
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
  'https://nearbite-three.vercel.app',
  'https://kignas.github.io',
  ...configuredCorsOrigins
].filter((origin, index, list) => list.indexOf(origin) === index);

app.use(cors({
  origin(origin, callback) {
    // Non-browser/server-to-server requests have no Origin header.
    if (!origin) return callback(null, true);
    if (corsOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS origin not allowed: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // Idempotency-Key is sent by cart.html during POST /api/orders.
  // Without it, the browser preflight fails and the frontend reports
  // the misleading "Failed to fetch" message.
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Idempotency-Key',
    'x-setup-key'
  ]
}));

app.options('*', cors());

const globalLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      Number(process.env.RATE_LIMIT_MAX)        || 100,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please slow down.' },
});
app.use(globalLimiter);

// Razorpay webhooks need the exact raw request bytes for HMAC verification.
app.post('/api/payments/webhook', express.raw({ type: 'application/json', limit: '1mb' }), handleWebhook);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts. Try again in 15 minutes.' },
});

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(mongoSanitize());
app.use(xssClean());
app.use(hpp({ whitelist: ['sort', 'category', 'cuisine'] }));

if (process.env.NODE_ENV === 'development') app.use(morgan('dev'));

// ── OTP diagnostic logging ────────────────────────────────────
// Keep this lightweight and production-safe: log request flow and a masked phone,
// while the OTP utility itself logs the mock OTP when OTP_PROVIDER=mock.
const maskPhone = (phone) => {
  const value = String(phone || '');
  if (value.length <= 4) return '****';
  return `${value.slice(0, 3)}****${value.slice(-3)}`;
};

if (process.env.NODE_ENV === 'development') {
  app.use('/api/users/send-otp', (req, res, next) => {
    console.log(`[OTP-DEBUG] request ${req.method} ${req.originalUrl} origin=${req.get('origin') || 'none'} phone=${maskPhone(req.body?.phone)}`);
    res.on('finish', () => {
      console.log(`[OTP-DEBUG] response status=${res.statusCode} success=${res.statusCode >= 200 && res.statusCode < 300}`);
    });
    next();
  });
}

// ── Health & Welcome Routes ───────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ success: true, service: 'Nearbite API', version: '1.0.0', uptime: process.uptime().toFixed(2) + 's' });
});

app.get('/', (req, res) => {
  res.status(200).send('<h2>🍔 Nearbite Backend API is Live and Running! 🚀</h2>');
});

app.use('/api/users',       authLimiter, userRoutes);
app.use('/api/auth',        authLimiter, authRoutes);
app.use('/api/restaurants', restaurantRoutes);
app.use('/api/cart',        cartRoutes);
app.use('/api/orders',      orderRoutes);
app.use('/api/vendor',      vendorRoutes); 
app.use('/api/admin',       adminRoutes); 
app.use('/api/upload',      uploadRoutes);
app.use('/api/categories',  categoryRoutes);
app.use('/api/menu',        menuRoutes);
app.use('/api/riders',      riderRoutes);
app.use('/api/admin/riders', adminRiderRoutes);
app.use('/api/ratings',      platformRatingRoutes);
app.use('/api/payments',      paymentRoutes);

// ── Global Error Handlers ─────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── Start Server ──────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
let server;

const { startAssignmentRecovery } = require('./services/riderAssignmentService');

connectDB().then(() => {
  // Durable safety net for rider auto-assignment: an in-process setTimeout is
  // lost on restart/sleep, so on boot (and periodically) sweep for orders left
  // in 'assigned' past the accept window and reassign them.
  startAssignmentRecovery();

  server = app.listen(PORT, '0.0.0.0', () => {
    console.log('╔══════════════════════════════════════════════╗');
    console.log(`║  🍔  Nearbite API running on port ${PORT}       ║`);
    console.log('╚══════════════════════════════════════════════╝');
  });

  process.on('unhandledRejection', (err) => {
    console.error(`❌ Unhandled Rejection: ${err.message}`);
    server.close(() => process.exit(1));
  });
  process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
});

module.exports = app;
