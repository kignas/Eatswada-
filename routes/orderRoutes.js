const express = require('express');
const router  = express.Router();
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const validate = require('../middleware/validateMiddleware');

const {
  createOrder, getOrders, getOrderById, getOrderReview, submitReview,
  cancelOrder, rateOrder, updateOrderStatus, getAllOrders,
  assignRider,
} = require('../controllers/orderController');

const { protect, authorize } = require('../middleware/authMiddleware');

// Authenticated-account limiter: avoids penalizing customers who share a
// household/mobile-carrier IP, and adds no database lookup beyond `protect`.
// The same router is mounted at /api and /api/v1, so both paths share this limit.
const createOrderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user._id),
  message: { success: false, message: 'Too many order attempts. Please wait a few minutes and try again.' },
});

// ==========================================
// 1. ADMIN ROUTE (Must be at the top!)
// ==========================================
// We changed this to '/all' and removed the admin-lock for now so you can test it!
router.get('/all', protect, authorize('admin'), getAllOrders);

// ==========================================
// 2. STANDARD ROUTES
// ==========================================
// Validate checkout shape before entering the order/payment controller. Pricing,
// ownership and availability are still verified server-side in createOrder.
const createOrderValidation = [
  body().custom((value) => value && typeof value === 'object' && !Array.isArray(value))
    .withMessage('Request body must be an object.'),
  body('items').isArray({ min: 1, max: 50 })
    .withMessage('Cart must contain between 1 and 50 items.'),
  body('items').custom((items) => {
    if (!Array.isArray(items)) return true; // handled by the array validator
    return items.every((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const menuId = item.menuItem || item.menuId || item.id || item._id;
      const validId = typeof menuId === 'string' && /^[a-fA-F0-9]{24}$/.test(menuId);
      const quantity = Number(item.quantity);
      return validId && Number.isInteger(quantity) && quantity >= 1 && quantity <= 99;
    });
  }).withMessage('Each cart item must have a valid menu item ID and quantity between 1 and 99.'),
  body('addressId').optional({ values: 'falsy' }).isMongoId()
    .withMessage('Invalid delivery address ID.'),
  body('paymentMethod').optional().equals('upi')
    .withMessage('Only UPI online payment is available.'),
  body('tipAmount').optional().isFloat({ min: 0, max: 500 })
    .withMessage('Tip must be between ₹0 and ₹500.'),
  body('deliveryAddress').optional().isObject()
    .withMessage('Delivery address must be an object.'),
  body('restaurantNote').optional().isString().isLength({ max: 250 })
    .withMessage('Restaurant note must be 250 characters or fewer.'),
  body('globalNote').optional().isBoolean()
    .withMessage('globalNote must be a boolean.'),
  body('deliveryInstructions').optional().isString().isLength({ max: 250 })
    .withMessage('Delivery instructions must be 250 characters or fewer.'),
  body('couponCode').optional().isString().isLength({ max: 100 })
    .withMessage('Coupon code must be 100 characters or fewer.'),
];

router.post('/', protect, createOrderLimiter, createOrderValidation, validate, createOrder);
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
