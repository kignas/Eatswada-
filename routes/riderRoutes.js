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
  updateLocation,
} = require('../controllers/riderController');

const { protect, authorize } = require('../middleware/authMiddleware');
const { upload } = require('../utils/riderUpload');

router.use(protect, authorize('rider'));

router.get('/profile', getMyProfile);
router.put('/profile', updateMyProfile);
router.put('/profile/photo', upload.single('photo'), updateMyPhoto);
router.put('/status', toggleOnline);
router.put('/location', updateLocation);

router.get('/earnings', getEarningsSummary);

router.get('/orders/active', getActiveOrder);
router.get('/orders/history', getOrderHistory);
router.get('/orders', getAssignedOrders);
router.get('/orders/:id', getAssignedOrderById);
router.put('/orders/:id/status', updateAssignedOrderStatus);

// IMPORTANT: the existing route is POST, so the production page uses POST.
router.post('/orders/:id/verify-otp', verifyDeliveryOtp);

module.exports = router;
