const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { protect } = require('../middleware/authMiddleware');
const { body, param } = require('express-validator');
const validate = require('../middleware/validateMiddleware');
const { verifyPayment, retryPayment, paymentStatus } = require('../controllers/paymentController');

// These limits run after authentication and are keyed by account, not shared IP.
// This protects payment endpoints without slowing normal browsing/menu requests.
const verifyPaymentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user._id),
  message: { success: false, message: 'Too many payment verification attempts. Please wait and try again.' },
});

const retryPaymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user._id),
  message: { success: false, message: 'Too many payment retries. Please wait before trying again.' },
});

// Validate untrusted payment identifiers before controller/database/provider work.
const verifyPaymentValidation = [
  body('orderId').isMongoId().withMessage('Valid orderId is required.'),
  body('razorpayPaymentId').isString().trim().matches(/^pay_[A-Za-z0-9]{6,64}$/).withMessage('Valid Razorpay payment ID is required.'),
  body('razorpayOrderId').isString().trim().matches(/^order_[A-Za-z0-9]{6,64}$/).withMessage('Valid Razorpay order ID is required.'),
  body('razorpaySignature').isString().trim().isHexadecimal().isLength({ min: 64, max: 64 }).withMessage('Valid payment signature is required.'),
];

const retryPaymentValidation = [
  body('orderId').isMongoId().withMessage('Valid orderId is required.'),
];

router.post('/verify', protect, verifyPaymentLimiter, verifyPaymentValidation, validate, verifyPayment);
router.post('/retry', protect, retryPaymentLimiter, retryPaymentValidation, validate, retryPayment);
router.get('/:id/status', protect, param('id').isMongoId().withMessage('Valid order ID is required.'), validate, paymentStatus);

module.exports = router;
