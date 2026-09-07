const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { verifyPayment, retryPayment, paymentStatus } = require('../controllers/paymentController');

router.post('/verify', protect, verifyPayment);
router.post('/retry', protect, retryPayment);
router.get('/:id/status', protect, paymentStatus);

module.exports = router;
