const express = require('express');
const router  = express.Router();

const {
  createOrder, getOrders, getOrderById,
  cancelOrder, rateOrder, updateOrderStatus, getAllOrders,
  createGuestOrder // <--- IMPORTED GUEST FUNCTION
} = require('../controllers/orderController');

const { protect, authorize } = require('../middleware/authMiddleware');

// ── VIP GUEST DOOR (Must go ABOVE protect!) ──
router.post('/guest', createGuestOrder);

// ── SECURE DOORS (Everything below requires login) ──
router.use(protect);

router.post ('/',            createOrder);
router.get  ('/',            getOrders);
router.get  ('/admin/all',   authorize('admin'), getAllOrders);
router.get  ('/:id',         getOrderById);
router.put  ('/:id/cancel',  cancelOrder);
router.put  ('/:id/rate',    rateOrder);
router.put  ('/:id/status',  authorize('admin', 'restaurant_owner'), updateOrderStatus);

module.exports = router;
