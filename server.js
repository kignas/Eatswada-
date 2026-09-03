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

// ── Connect to MongoDB ────────────────────────────────────────
// (connection is awaited below, right before the server starts listening)

// 🚨 APP IS CREATED HERE FIRST! 🚨
const app = express();
// Render sits behind a reverse proxy. Trust the first proxy hop so
// express-rate-limit sees the real client IP instead of the shared proxy IP.
app.set('trust proxy', 1);

app.set("trust proxy", 1);

// ── Middleware ────────────────────────────────────────────────
app.use(compression());
app.use(helmet());

// Production CORS is configured through CORS_ORIGINS (comma-separated).
// The GitHub Pages portal origin is retained because the current Admin,
// Vendor and Rider portals use that host. Never use '*' with credentials.
const configuredCorsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const defaultCorsOrigins = [
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://kignas.github.io',
];

const allowedCorsOrigins = [...new Set([...defaultCorsOrigins, ...configuredCorsOrigins])];

app.use(cors({
  origin: (origin, callback) => {
    // Non-browser/server-to-server requests have no Origin header.
    if (!origin) return callback(null, true);
    if (allowedCorsOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-setup-key']
}));

// Use the exact same allow-list for preflight as for normal requests.
// `cors()` without options would reflect any origin on OPTIONS requests.
app.options('*', cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedCorsOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-setup-key'],
}));

const globalLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      Number(process.env.RATE_LIMIT_MAX)        || 100,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please slow down.' },
});
app.use(globalLimiter);

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

// ── Health & Welcome Routes ───────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ success: true, service: 'Eatswada API', version: '1.0.0', uptime: process.uptime().toFixed(2) + 's' });
});

app.get('/', (req, res) => {
  res.status(200).send('<h2>🍔 Eatswada Backend API is Live and Running! 🚀</h2>');
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

// ── Global Error Handlers ─────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── Start Server ──────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
let server;

connectDB().then(() => {
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log('╔══════════════════════════════════════════════╗');
    console.log(`║  🍔  Eatswada API running on port ${PORT}       ║`);
    console.log('╚══════════════════════════════════════════════╝');
  });

  process.on('unhandledRejection', (err) => {
    console.error(`❌ Unhandled Rejection: ${err.message}`);
    server.close(() => process.exit(1));
  });
  process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
});

module.exports = app;
