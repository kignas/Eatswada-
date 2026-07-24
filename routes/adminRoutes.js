const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  adminLogin, getMetrics, getOrders, updateOrderStatus, cancelOrder,
  getRestaurants, toggleRestaurant, getRecentOrders, getPeakHours,
  getCustomers, getRevenueAnalytics, getTopRestaurants,
  getVendors, getVendorById, updateVendor, toggleVendorStatus,
} = require('../controllers/adminController');

router.post('/login', adminLogin);
router.get('/metrics', protect, getMetrics);
router.get('/dashboard/recent-orders', protect, getRecentOrders);
router.get('/dashboard/peak-hours', protect, getPeakHours);
router.get('/orders', protect, getOrders);
router.patch('/orders/:id/status', protect, updateOrderStatus);
router.patch('/orders/:id/cancel', protect, cancelOrder);
router.get('/restaurants', protect, getRestaurants);
router.patch('/restaurants/:id/toggle', protect, toggleRestaurant);
router.get('/customers', protect, getCustomers);
router.get('/analytics/revenue', protect, getRevenueAnalytics);
router.get('/analytics/top-restaurants', protect, getTopRestaurants);

// Vendor account management (vendor *creation* is POST /api/auth/admin/create-vendor)
router.get('/vendors', protect, getVendors);
router.get('/vendors/:id', protect, getVendorById);
router.put('/vendors/:id', protect, updateVendor);
router.patch('/vendors/:id/toggle', protect, toggleVendorStatus);

module.exports = router;
