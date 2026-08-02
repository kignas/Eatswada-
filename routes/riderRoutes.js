'use strict';

const express = require('express');
const router = express.Router();

const {
  getMyProfile,
  updateMyProfile,
  updateMyPhoto,
  toggleOnline,
  getAssignedOrders,
  getActiveOrder,
  getOrderHistory,
  getAssignedOrderById,
  getEarningsSummary,
  updateAssignedOrderStatus,
  verifyDeliveryOtp,
} = require('../controllers/riderController');

const { protect, authorize } = require('../middleware/authMiddleware');
const { upload } = require('../utils/riderUpload');

// Login lives in authRoutes.js as POST /api/auth/rider/login, alongside
// vendor/admin login, for consistency with the existing auth surface.
// Everything below requires a valid rider JWT.
router.use(protect, authorize('rider'));

router.get('/profile', getMyProfile);
router.put('/profile', updateMyProfile);
router.put('/profile/photo', upload.single('photo'), updateMyPhoto);

router.put('/status', toggleOnline);

router.get('/earnings', getEarningsSummary);

// ── Orders — specific routes before the dynamic '/:id' route ──
router.get('/orders/active', getActiveOrder);
router.get('/orders/history', getOrderHistory);
router.get('/orders', getAssignedOrders);
router.get('/orders/:id', getAssignedOrderById);
router.put('/orders/:id/status', updateAssignedOrderStatus);
router.post('/orders/:id/verify-otp', verifyDeliveryOtp);

module.exports = router;
