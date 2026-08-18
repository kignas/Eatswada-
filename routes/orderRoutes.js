const express = require('express');
const router  = express.Router();

const {
  createOrder, getOrders, getOrderById,
  cancelOrder, rateOrder, updateOrderStatus, getAllOrders,
  assignRider,
} = require('../controllers/orderController');

const { protect, authorize } = require('../middleware/authMiddleware');

// ==========================================
// 1. ADMIN ROUTE (Must be at the top!)
// ==========================================
// We changed this to '/all' and removed the admin-lock for now so you can test it!
router.get('/all', protect, authorize('admin', 'ceo'), getAllOrders);

// ==========================================
// 2. STANDARD ROUTES
// ==========================================
router.post('/', protect, createOrder);
router.get('/', protect, getOrders);

// ==========================================
// 3. DYNAMIC ID ROUTES (Must be at the bottom!)
// ==========================================
router.get('/:id', protect, getOrderById);
router.put('/:id/status', protect, authorize('admin', 'ceo'), updateOrderStatus);
router.put('/:id/cancel', protect, cancelOrder);
router.put('/:id/rate', protect, rateOrder);

// Rider assignment — ADMIN ONLY.
router.put('/:id/assign-rider', protect, authorize('admin', 'ceo'), assignRider);

module.exports = router;
