const express = require('express');
const router  = express.Router();

const { protect } = require('../middleware/authMiddleware');

const {
  getVendorOrders,
  getVendorMenu,
  addMenuItem,
  updateMenuItem,
  toggleItemStock,
  getRestaurantProfile,
  updateRestaurantStatus,
} = require('../controllers/vendorController');

/* ─────────────────────────────────────────────────────────────
 *  RESTAURANT
 * ───────────────────────────────────────────────────────────── */

// GET  /api/vendor/restaurant  — header profile + isActive flag
router.get('/restaurant', protect, getRestaurantProfile);

// PUT  /api/vendor/status      — master online / offline toggle
router.put('/status', protect, updateRestaurantStatus);

/* ─────────────────────────────────────────────────────────────
 *  ORDERS
 * ───────────────────────────────────────────────────────────── */

// GET  /api/vendor/orders      — vendor's live order queue
router.get('/orders', protect, getVendorOrders);

/* ─────────────────────────────────────────────────────────────
 *  MENU
 *  NOTE: /menu/:id/toggle-stock MUST come before /menu/:id
 *        so Express does not greedily match 'toggle-stock' as
 *        the :id parameter.
 * ───────────────────────────────────────────────────────────── */

// GET  /api/vendor/menu                   — grouped-by-category menu
router.get('/menu', protect, getVendorMenu);

// POST /api/vendor/menu                   — add new item
router.post('/menu', protect, addMenuItem);

// PUT  /api/vendor/menu/:id/toggle-stock  — atomic inStock flip  ← NEW
router.put('/menu/:id/toggle-stock', protect, toggleItemStock);

// PUT  /api/vendor/menu/:id               — general field update (price etc.)
router.put('/menu/:id', protect, updateMenuItem);

module.exports = router;
