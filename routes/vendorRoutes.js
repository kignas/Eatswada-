const express = require('express');
const router  = express.Router();

const { protect } = require('../middleware/authMiddleware');
const role         = require('../middleware/roleMiddleware');

const {
  getVendorOrders,
  acceptOrder,
  rejectOrder,
  updateOrderStatus,
  getVendorMenu,
  toggleItemStock,
  getRestaurantProfile,
  getVendorReviews,
  updateVendorAvailability,
  getVendorEarningsSummary,
  getVendorEarningsOrders,
} = require('../controllers/vendorController');

/* ─────────────────────────────────────────────────────────────
 *  RESTAURANT
 * ───────────────────────────────────────────────────────────── */

// GET  /api/vendor/restaurant  — header profile + isActive flag
router.get('/restaurant', protect, role('vendor'), getRestaurantProfile);
router.put('/restaurant/availability', protect, role('vendor'), updateVendorAvailability);
router.get('/reviews', protect, role('vendor'), getVendorReviews);
router.get('/earnings/summary', protect, role('vendor'), getVendorEarningsSummary);
router.get('/earnings/orders', protect, role('vendor'), getVendorEarningsOrders);


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

// PUT  /api/vendor/orders/:id/status  — advance vendor workflow: confirmed→preparing→waiting_for_rider
router.put('/orders/:id/status', protect, role('vendor'), updateOrderStatus);

/* ─────────────────────────────────────────────────────────────
 *  MENU
 * ───────────────────────────────────────────────────────────── */

// GET  /api/vendor/menu                   — grouped-by-category menu
router.get('/menu', protect, role('vendor'), getVendorMenu);


// PUT  /api/vendor/menu/:id/toggle-stock  — atomic inStock flip
router.put('/menu/:id/toggle-stock', protect, role('vendor'), toggleItemStock);


module.exports = router;
