const express = require('express');
const router  = express.Router();

const { protect } = require('../middleware/authMiddleware');
const role         = require('../middleware/roleMiddleware');

const {
  getVendorOrders,
  acceptOrder,
  rejectOrder,
  getVendorMenu,
  addMenuItem,
  updateMenuItem,
  toggleItemStock,
  getRestaurantProfile,
  updateRestaurantStatus,
} = require('../controllers/vendorController');

// FIX: Import updateOrderStatus from orderController so auto-assignment triggers
const { updateOrderStatus } = require('../controllers/orderController');

/* ─────────────────────────────────────────────────────────────
 *  RESTAURANT
 * ───────────────────────────────────────────────────────────── */

// GET  /api/vendor/restaurant  — header profile + isActive flag
router.get('/restaurant', protect, getRestaurantProfile);

// PUT  /api/vendor/status      — master online / offline toggle
router.put('/status', protect, updateRestaurantStatus);

/* ─────────────────────────────────────────────────────────────
 *  ORDERS
 *  NOTE: action routes (accept/reject/status) MUST come before any
 *        future generic '/orders/:id' route, so Express doesn't try
 *        to match 'accept' / 'reject' / 'status' as the :id param.
 * ───────────────────────────────────────────────────────────── */

// GET  /api/vendor/orders             — order list. ?view=queue or ?view=history filters it;
//                                        omitted = every order (unchanged default behaviour)
router.get('/orders', protect, getVendorOrders);

// PUT  /api/vendor/orders/:id/accept  — accept a newly placed order                    ← NEW
router.put('/orders/:id/accept', protect, role('vendor'), acceptOrder);

// PUT  /api/vendor/orders/:id/reject  — reject a newly placed order, body: { reason }  ← NEW
router.put('/orders/:id/reject', protect, role('vendor'), rejectOrder);

// PUT  /api/vendor/orders/:id/status  — advance one step: confirmed→preparing,
//                                        preparing→out_for_delivery                     ← NEW
router.put('/orders/:id/status', protect, role('vendor'), updateOrderStatus);

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

// PUT  /api/vendor/menu/:id/toggle-stock  — atomic inStock flip
router.put('/menu/:id/toggle-stock', protect, toggleItemStock);

// PUT  /api/vendor/menu/:id               — general field update (price etc.)
router.put('/menu/:id', protect, updateMenuItem);

module.exports = router;
