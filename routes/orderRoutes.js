const express = require('express');
const router  = express.Router();

const {
  createOrder, getOrders, getOrderById,
  cancelOrder, rateOrder, updateOrderStatus, getAllOrders,
} = require('../controllers/orderController');

const { protect, authorize } = require('../middleware/authMiddleware');

router.use(protect);

router.post ('/',            createOrder);
router.get  ('/',            getOrders);
router.get  ('/admin/all',   authorize('admin'), getAllOrders);
router.get  ('/:id',         getOrderById);
router.put  ('/:id/cancel',  cancelOrder);
router.put  ('/:id/rate',    rateOrder);
router.put  ('/:id/status',  authorize('admin', 'restaurant_owner'), updateOrderStatus);

module.exports = router;
