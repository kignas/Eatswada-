const express = require('express');
const router  = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  adminLogin, getMetrics, getOrders, updateOrderStatus, cancelOrder,
  getRestaurants, toggleRestaurant, getRecentOrders, getPeakHours,
  getCustomers, getRevenueAnalytics, getTopRestaurants,
  getVendors, getVendorById, updateVendor, toggleVendorStatus,
  getReviews, moderateReview,
} = require('../controllers/adminController');

router.post('/login', adminLogin);
router.get('/metrics', protect, authorize('admin', 'ceo'), getMetrics);
router.get('/dashboard/recent-orders', protect, authorize('admin', 'ceo'), getRecentOrders);
router.get('/dashboard/peak-hours', protect, authorize('admin', 'ceo'), getPeakHours);
router.get('/orders', protect, authorize('admin', 'ceo'), getOrders);
router.patch('/orders/:id/status', protect, authorize('admin', 'ceo'), updateOrderStatus);
router.patch('/orders/:id/cancel', protect, authorize('admin', 'ceo'), cancelOrder);
router.get('/restaurants', protect, authorize('admin', 'ceo'), getRestaurants);
router.patch('/restaurants/:id/toggle', protect, authorize('admin', 'ceo'), toggleRestaurant);
router.get('/customers', protect, authorize('admin', 'ceo'), getCustomers);
router.get('/analytics/revenue', protect, authorize('admin', 'ceo'), getRevenueAnalytics);
router.get('/analytics/top-restaurants', protect, authorize('admin', 'ceo'), getTopRestaurants);
router.get('/reviews', protect, authorize('admin', 'ceo'), getReviews);
router.patch('/reviews/:id', protect, authorize('admin', 'ceo'), moderateReview);

// Vendor account management (vendor *creation* is POST /api/auth/admin/create-vendor)
router.get('/vendors', protect, authorize('admin', 'ceo'), getVendors);
router.get('/vendors/:id', protect, authorize('admin', 'ceo'), getVendorById);
router.put('/vendors/:id', protect, authorize('admin', 'ceo'), updateVendor);
router.patch('/vendors/:id/toggle', protect, authorize('admin', 'ceo'), toggleVendorStatus);

module.exports = router;
