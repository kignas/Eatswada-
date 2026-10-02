const express = require('express');
const router  = express.Router();

const { protect } = require('../middleware/authMiddleware');
const role         = require('../middleware/roleMiddleware');

const marketplace = require('../controllers/vendorMarketplaceController');
const { updateRestaurant } = require('../controllers/restaurantController');
const { uploadVendorMenuImage } = require('../controllers/uploadController');
const upload = require('../middleware/uploadMiddleware');
const multer = require('multer');

const handleMenuImageUpload = (req, res, next) => upload.single('image')(req, res, (err) => {
  if (!err) return next();
  const message = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE' ? 'Image must be 5MB or smaller.' : err.message;
  return res.status(400).json({ success: false, message });
});

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
  updateBusinessHours,
  getVendorEarningsSummary,
  getVendorEarningsOrders,
  getVendorAnalytics,
  replyToVendorReview,
} = require('../controllers/vendorController');

/* ─────────────────────────────────────────────────────────────
 *  RESTAURANT
 * ───────────────────────────────────────────────────────────── */

// GET  /api/vendor/restaurant  — header profile + isActive flag
router.get('/restaurant', protect, role('vendor'), getRestaurantProfile);
router.get('/profile', protect, role('vendor'), marketplace.getVendorProfile);
router.get('/dashboard', protect, role('vendor'), marketplace.getVendorDashboard);
router.get('/alerts', protect, role('vendor'), marketplace.getVendorAlerts);
router.get('/activity', protect, role('vendor'), marketplace.getVendorActivity);
router.put('/menu/availability/bulk', protect, role('vendor'), marketplace.bulkSetVendorAvailability);
router.put('/menu/reorder', protect, role('vendor'), marketplace.reorderVendorMenu);
router.get('/inventory/history', protect, role('vendor'), marketplace.getVendorStockHistory);
router.put('/restaurant/profile', protect, role('vendor'), updateRestaurant);
router.put('/restaurant/availability', protect, role('vendor'), updateVendorAvailability);
router.put('/restaurant/hours', protect, role('vendor'), updateBusinessHours);
router.get('/reviews', protect, role('vendor'), getVendorReviews);
router.post('/reviews/:id/reply', protect, role('vendor'), replyToVendorReview);
router.get('/analytics', protect, role('vendor'), getVendorAnalytics);
router.get('/earnings/summary', protect, role('vendor'), getVendorEarningsSummary);
router.get('/earnings/orders', protect, role('vendor'), getVendorEarningsOrders);
router.get('/onboarding/config', protect, role('vendor'), marketplace.getVendorOnboardingConfig);
router.get('/settings', protect, role('vendor'), marketplace.getVendorOperationalSettings);
router.put('/settings', protect, role('vendor'), marketplace.updateVendorOperationalSettings);
router.get('/capacity', protect, role('vendor'), marketplace.getVendorCapacity);
router.get('/settlements/summary', protect, role('vendor'), marketplace.getVendorSettlementSummary);
router.get('/settlements/withdrawals', protect, role('vendor'), marketplace.listVendorWithdrawals);
router.post('/settlements/withdraw', protect, role('vendor'), marketplace.requestVendorWithdrawal);
router.get('/support', protect, role('vendor'), marketplace.listVendorSupportTickets);
router.post('/support', protect, role('vendor'), marketplace.createVendorSupportTicket);
router.post('/support/:id/reply', protect, role('vendor'), marketplace.replyVendorSupportTicket);
router.get('/policies', marketplace.getVendorPolicies);


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
router.post('/orders/:id/verify-delivery-otp', protect, role('vendor'), marketplace.verifySelfDeliveryOtp);

/* ─────────────────────────────────────────────────────────────
 *  MENU
 * ───────────────────────────────────────────────────────────── */

// GET  /api/vendor/menu                   — grouped-by-category menu
router.get('/menu', protect, role('vendor'), getVendorMenu);
router.post('/menu/upload-image', protect, role('vendor'), handleMenuImageUpload, uploadVendorMenuImage);
router.post('/menu', protect, role('vendor'), marketplace.createVendorMenuItem);
router.put('/menu/:id', protect, role('vendor'), marketplace.updateVendorMenuItem);
router.delete('/menu/:id', protect, role('vendor'), marketplace.deleteVendorMenuItem);
router.put('/menu/:id/inventory', protect, role('vendor'), marketplace.setVendorInventory);


// PUT  /api/vendor/menu/:id/toggle-stock  — atomic inStock flip
router.put('/menu/:id/toggle-stock', protect, role('vendor'), toggleItemStock);


module.exports = router;
