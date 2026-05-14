const express = require('express');
const router  = express.Router();

const { protect } = require('../middleware/authMiddleware');
const { getMetrics } = require('../controllers/adminController');

/* ─────────────────────────────────────────────────────────────
 *  CEO / ADMIN ROUTES
 *
 *  Mount this in your main server.js / app.js:
 *    app.use('/api/admin', require('./routes/adminRoutes'));
 * ───────────────────────────────────────────────────────────── */

// GET /api/admin/metrics
// Returns totalRevenue, ordersToday, successRate, totalOrders.
// protect middleware validates the JWT; getMetrics enforces role === 'admin'|'ceo'.
router.get('/metrics', protect, getMetrics);

module.exports = router;
