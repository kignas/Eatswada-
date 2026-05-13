'use strict';

/**
 * vendorRoutes.js
 *
 * All routes are protected by the `protect` middleware (valid JWT required).
 * Role enforcement and restaurantId validation is done inside each controller
 * via the shared assertVendor() helper.
 *
 * Mount point (in app.js / server.js):
 *   app.use('/api/vendor', vendorRoutes);
 *
 * Full route map:
 *   GET    /api/vendor/restaurant   → getVendorRestaurant  (header data on load)
 *   GET    /api/vendor/orders       → getVendorOrders
 *   GET    /api/vendor/menu         → getVendorMenu        (grouped by category)
 *   POST   /api/vendor/menu         → addMenuItem
 *   PUT    /api/vendor/menu/:id     → updateMenuItem       (whitelisted fields)
 *   DELETE /api/vendor/menu/:id     → deleteMenuItem       (soft delete only)
 *   PUT    /api/vendor/status       → updateRestaurantStatus
 */

const express = require('express');
const router  = express.Router();

const { protect } = require('../middleware/authMiddleware');

const {
  getVendorRestaurant,
  getVendorOrders,
  getVendorMenu,
  addMenuItem,
  updateMenuItem,
  deleteMenuItem,
  updateRestaurantStatus,
} = require('../controllers/vendorController');

// ── Restaurant info ──
router.get('/restaurant', protect, getVendorRestaurant);

// ── Orders ──
router.get('/orders', protect, getVendorOrders);

// ── Menu ──
router.get('/menu',         protect, getVendorMenu);
router.post('/menu',        protect, addMenuItem);
router.put('/menu/:id',     protect, updateMenuItem);
router.delete('/menu/:id',  protect, deleteMenuItem);

// ── Master Online/Offline toggle ──
router.put('/status', protect, updateRestaurantStatus);

module.exports = router;
