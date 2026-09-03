const express = require('express');
const router  = express.Router();

const {
  createOrder, getOrders, getOrderById, getOrderReview, submitReview,
  cancelOrder, rateOrder, updateOrderStatus, getAllOrders,
  assignRider,
} = require('../controllers/orderController');

const { protect, authorize } = require('../middleware/authMiddleware');

// ==========================================
// 1. ADMIN ROUTE (Must be at the top!)
// ==========================================
// We changed this to '/all' and removed the admin-lock for now so you can test it!
router.get('/all', protect, authorize('admin'), getAllOrders);

// ==========================================
// 2. STANDARD ROUTES
// ==========================================
router.post('/', protect, createOrder);
router.get('/', protect, getOrders);

// ==========================================
// 3. DYNAMIC ID ROUTES (Must be at the bottom!)
// ==========================================
router.get('/:id/review', protect, getOrderReview);
router.get('/:id', protect, getOrderById);
router.put('/:id/status', protect, authorize('admin'), updateOrderStatus);
router.put('/:id/cancel', protect, cancelOrder);
router.put('/:id/rate', protect, rateOrder);
router.post('/:id/review', protect, submitReview);
router.put('/:id/review', protect, submitReview);

// Rider assignment — ADMIN ONLY.
router.put('/:id/assign-rider', protect, authorize('admin'), assignRider);

module.exports = router;
