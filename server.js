**
 * server.js — Nearbite Backend Entry Point
 */
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

// ── Route imports ─────────────────────────────────────────────
const userRoutes       = require('./routes/userRoutes');
const restaurantRoutes = require('./routes/restaurantRoutes');
const cartRoutes       = require('./routes/cartRoutes');
const orderRoutes      = require('./routes/orderRoutes');

// ── Connect to MongoDB ────────────────────────────────────────
connectDB();

const app = express();

app.set("trust proxy", 1);

// ── Compression (gzip all responses) ─────────────────────────
app.use(compression());

// ── Security: HTTP headers ────────────────────────────────────
app.use(helmet());

// ── CORS — reads ALLOWED_ORIGINS from .env ────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(s => s.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Handle preflight for all routes
app.options('*', cors());

// ── Global Rate Limiter ───────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      Number(process.env.RATE_LIMIT_MAX)        || 100,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: 'Too many requests, please slow down.' },
});
app.use(globalLimiter);

// Stricter limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts. Try again in 15 minutes.' },
});

// ── Body Parsing ──────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ── Security: sanitize NoSQL injection ───────────────────────
app.use(mongoSanitize());

// ── Security: sanitize XSS ───────────────────────────────────
app.use(xssClean());

// ── Security: prevent HTTP parameter pollution ────────────────
app.use(hpp({
  whitelist: ['sort', 'category', 'cuisine'],
}));

// ── HTTP Request Logger (dev only) ───────────────────────────
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// ── Health Check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    success:  true,
    service:  'Nearbite API',
    version:  '1.0.0',
    env:      process.env.NODE_ENV || 'development',
    uptime:   process.uptime().toFixed(2) + 's',
    timestamp: new Date().toISOString(),
  });
});

// ── Root Welcome Route (Stops the 404 errors) ─────────────────
app.get('/', (req, res) => {
  res.status(200).send('<h2>🍔 Nearbite Backend API is Live and Running! 🚀</h2>');
});


// ── API Routes ────────────────────────────────────────────────
app.use('/api/users',       authLimiter, userRoutes);
app.use('/api/restaurants', restaurantRoutes);
app.use('/api/cart',        cartRoutes);
app.use('/api/orders',      orderRoutes);

// ── 404 + Global Error Handler ───────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── Start Server ──────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('╔══════════════════════════════════════════════╗');
  console.log(`║  🍔  Nearbite API running on port ${PORT}       ║`);
  console.log(`║  🌍  Environment : ${(process.env.NODE_ENV || 'development').padEnd(24)}║`);
  console.log(`║  📦  MongoDB     : connected                 ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});

// ── Graceful Shutdown ─────────────────────────────────────────
process.on('unhandledRejection', (err) => {
  console.error(`❌ Unhandled Rejection: ${err.message}`);
  server.close(() => process.exit(1));
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => process.exit(0));
});

module.exports = app;
