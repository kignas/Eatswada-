const express = require('express');
const router  = express.Router();

const { protect } = require('../middleware/authMiddleware');
const role         = require('../middleware/roleMiddleware');

const {
  getVendorOrders,
  acceptOrder,
  rejectOrder,
  updateOrderStatus, // ← RESTORED: Import back from vendorController
  getVendorMenu,
  addMenuItem,
  updateMenuItem,
  toggleItemStock,
  getRestaurantProfile,
  updateRestaurantStatus,
  getVendorReviews,
} = require('../controllers/vendorController');

/* ─────────────────────────────────────────────────────────────
 *  RESTAURANT
 * ───────────────────────────────────────────────────────────── */

// GET  /api/vendor/restaurant  — header profile + isActive flag
router.get('/restaurant', protect, role('vendor'), getRestaurantProfile);
router.get('/reviews', protect, role('vendor'), getVendorReviews);

// PUT  /api/vendor/status      — master online / offline toggle
router.put('/status', protect, role('vendor'), updateRestaurantStatus);

/* ─────────────────────────────────────────────────────────────
 *  ORDERS
 *  NOTE: action routes (accept/reject/status) MUST come before any
 *        future generic '/orders/:id' route, so Express doesn't try
 *        to match 'accept' / 'reject' / 'status' as the :id param.
 * ───────────────────────────────────────────────────────────── */

// GET  /api/vendor/orders             — order list. ?view=queue or ?view=history filters it;
//                                        omitted = every order (unchanged default behaviour)
router.get('/orders', protect, role('vendor'), getVendorOrders);

// PUT  /api/vendor/orders/:id/accept  — accept a newly placed order
router.put('/orders/:id/accept', protect, role('vendor'), acceptOrder);

// PUT  /api/vendor/orders/:id/reject  — reject a newly placed order, body: { reason }
router.put('/orders/:id/reject', protect, role('vendor'), rejectOrder);

// PUT  /api/vendor/orders/:id/status  — advance one step: confirmed→preparing, preparing→out_for_delivery
router.put('/orders/:id/status', protect, role('vendor'), updateOrderStatus);

/* ─────────────────────────────────────────────────────────────
 *  MENU
 * ───────────────────────────────────────────────────────────── */

// GET  /api/vendor/menu                   — grouped-by-category menu
router.get('/menu', protect, role('vendor'), getVendorMenu);

// POST /api/vendor/menu                   — add new item
router.post('/menu', protect, role('vendor'), addMenuItem);

// PUT  /api/vendor/menu/:id/toggle-stock  — atomic inStock flip
router.put('/menu/:id/toggle-stock', protect, role('vendor'), toggleItemStock);

// PUT  /api/vendor/menu/:id               — general field update (price etc.)
router.put('/menu/:id', protect, role('vendor'), updateMenuItem);

module.exports = router;
