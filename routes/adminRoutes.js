const express = require('express');
const rateLimit = require('express-rate-limit');
const router  = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  adminLogin, getMetrics, getOrders, updateOrderStatus, cancelOrder,
  getRestaurants, toggleRestaurant, getRecentOrders, getPeakHours,
  getCustomers, getRevenueAnalytics, getTopRestaurants,
  getVendors, getVendorById, updateVendor, toggleVendorStatus,
  getReviews, moderateReview, getPlatformRatings,
} = require('../controllers/adminController');

// server.js applies authLimiter to /api/users and /api/auth but not to
// /api/admin, so this endpoint previously sat behind nothing but the global
// 100-per-15-min limiter — roughly 9,600 password guesses a day per IP
// against the highest-privilege account on the platform.
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' },
});

router.post('/login', adminLoginLimiter, adminLogin);
router.get('/metrics', protect, authorize('admin'), getMetrics);
router.get('/dashboard/recent-orders', protect, authorize('admin'), getRecentOrders);
router.get('/dashboard/peak-hours', protect, authorize('admin'), getPeakHours);
router.get('/orders', protect, authorize('admin'), getOrders);
router.patch('/orders/:id/status', protect, authorize('admin'), updateOrderStatus);
router.patch('/orders/:id/cancel', protect, authorize('admin'), cancelOrder);
router.get('/restaurants', protect, authorize('admin'), getRestaurants);
router.patch('/restaurants/:id/toggle', protect, authorize('admin'), toggleRestaurant);
router.get('/customers', protect, authorize('admin'), getCustomers);
router.get('/analytics/revenue', protect, authorize('admin'), getRevenueAnalytics);
router.get('/analytics/top-restaurants', protect, authorize('admin'), getTopRestaurants);
router.get('/reviews', protect, authorize('admin'), getReviews);
router.patch('/reviews/:id', protect, authorize('admin'), moderateReview);
router.get('/platform-ratings', protect, authorize('admin'), getPlatformRatings);

// Vendor account management (vendor *creation* is POST /api/auth/admin/create-vendor)
router.get('/vendors', protect, authorize('admin'), getVendors);
router.get('/vendors/:id', protect, authorize('admin'), getVendorById);
router.put('/vendors/:id', protect, authorize('admin'), updateVendor);
router.patch('/vendors/:id/toggle', protect, authorize('admin'), toggleVendorStatus);

module.exports = router;
