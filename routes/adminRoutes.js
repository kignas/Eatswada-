const { requirePermission, requireFullAdmin } = require('../middleware/permissionMiddleware');
const express = require('express');
const rateLimit = require('express-rate-limit');
const adminMarketplace = require('../controllers/adminMarketplaceController');
const router  = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  adminLogin, getMetrics, getOrders, updateOrderStatus, cancelOrder,
  getRestaurants, toggleRestaurant, getRecentOrders, getPeakHours,
  getCustomers, getRevenueAnalytics, getTopRestaurants,
  getCustomerTrustOverview, getCustomerTrust, updateCustomerCodPolicy, setCustomerAccountFreeze,
  getVisitAnalytics,
  getVendors, getVendorById, updateVendor, toggleVendorStatus,
  getReviews, moderateReview, getPlatformRatings, getReviewAnalytics,
  getRestaurantCommission, updateRestaurantCommission, updateRestaurantFssai,
  getRestaurantDeliverySettings, updateRestaurantDeliverySettings,
  getAdminPermissions, updateAdminPermissions,
  forceAcceptOrder, forceDispatchOrder, forceDeliverOrder, getDeliveryCapacity,
  getAllRestaurantInventory, updateAnyRestaurantInventory, getCustomerSavedLocations,
} = require('../controllers/adminController');
const {
  getVendorApplications, getVendorApplicationById,
  approveVendorApplication, rejectVendorApplication, requestVendorApplicationChanges,
} = require('../controllers/vendorApplicationController');
const adminRanking = require('../controllers/adminRankingController');
const { listAuditLogs } = require('../controllers/adminAuditController');

// server.js applies authLimiter to /api/users and /api/auth but not to
// /api/admin, so this endpoint previously sat behind nothing but the global
// 100-per-15-min limiter — roughly 9,600 password guesses a day per IP
// against the highest-privilege account on the platform.
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' },
});

router.post('/login', adminLoginLimiter, adminLogin);
router.get('/metrics', protect, authorize('admin'), requirePermission('analytics.view'), getMetrics);
router.get('/dashboard/recent-orders', protect, authorize('admin'), requirePermission('orders.manage'), getRecentOrders);
router.get('/dashboard/peak-hours', protect, authorize('admin'), requirePermission('analytics.view'), getPeakHours);
router.get('/orders', protect, authorize('admin'), requirePermission('orders.manage'), getOrders);
router.patch('/orders/:id/status', protect, authorize('admin'), requirePermission('orders.manage'), updateOrderStatus);
router.patch('/orders/:id/cancel', protect, authorize('admin'), requirePermission('orders.manage'), cancelOrder);
// Pillar 7 — live order war-room overrides.
router.put('/orders/:id/force-accept', protect, authorize('admin'), requirePermission('orders.manage'), forceAcceptOrder);
router.put('/orders/:id/force-dispatch', protect, authorize('admin'), requirePermission('orders.manage'), forceDispatchOrder);
router.put('/orders/:id/force-deliver', protect, authorize('admin'), requirePermission('orders.manage'), forceDeliverOrder);
// Pillar 1 — live delivery capacity for the dashboard shortage circuit breaker.
router.get('/delivery-capacity', protect, authorize('admin'), requirePermission('orders.manage'), getDeliveryCapacity);
router.get('/restaurants', protect, authorize('admin'), requirePermission('restaurants.manage'), getRestaurants);
// Restaurant Performance & Ranking Engine — admin controls. Declared BEFORE the
// generic /restaurants/:id routes so the literal paths are not captured as :id.
router.get('/restaurants/performance', protect, authorize('admin'), requirePermission('analytics.view'), adminRanking.listRestaurantPerformance);
router.get('/restaurants/offline', protect, authorize('admin'), requirePermission('restaurants.manage'), adminRanking.listOfflineRestaurants);
router.get('/ranking/config', protect, authorize('admin'), requirePermission('analytics.view'), adminRanking.getRankingConfig);
router.patch('/ranking/config', protect, authorize('admin'), requirePermission('settings.manage'), adminRanking.updateRankingConfig);
router.post('/ranking/recompute', protect, authorize('admin'), requirePermission('analytics.view'), adminRanking.recomputeRanking);
router.get('/ranking/poor-performers', protect, authorize('admin'), requirePermission('analytics.view'), adminRanking.getPoorPerformers);
router.get('/ranking/sponsored', protect, authorize('admin'), requirePermission('analytics.view'), adminRanking.listSponsored);
router.get('/restaurants/:id/performance', protect, authorize('admin'), requirePermission('analytics.view'), adminRanking.getRestaurantPerformance);
router.patch('/restaurants/:id/ranking', protect, authorize('admin'), requirePermission('restaurants.manage'), adminRanking.updateRestaurantRanking);
// Reuse the restaurant settings reader so admin UI can inspect FSSAI data (it is already asyncHandler-wrapped).
router.get('/restaurants/:id/fssai', protect, authorize('admin'), requirePermission('restaurants.manage'), getRestaurantDeliverySettings);
router.patch('/restaurants/:id/fssai', protect, authorize('admin'), requirePermission('restaurants.manage'), updateRestaurantFssai);
router.get('/restaurants/:id/commission', protect, authorize('admin'), requirePermission('finance.manage'), getRestaurantCommission);
router.patch('/restaurants/:id/commission', protect, authorize('admin'), requirePermission('finance.manage'), updateRestaurantCommission);
router.get('/restaurants/:id/delivery-settings', protect, authorize('admin'), requirePermission('restaurants.manage'), getRestaurantDeliverySettings);
router.patch('/restaurants/:id/delivery-settings', protect, authorize('admin'), requirePermission('restaurants.manage'), updateRestaurantDeliverySettings);
// Vendor payouts move real money (mark paid / reject releases or settles ledger
// entries), so they need the finance permission like every /settlements route.
// Full access requires the explicit '*' permission; an empty list grants nothing.
router.get('/payout-requests', protect, authorize('admin'), requirePermission('finance.manage'), adminMarketplace.listPayoutRequests);
router.get('/payout-requests/:id/reconciliation', protect, authorize('admin'), requirePermission('finance.manage'), adminMarketplace.getPayoutReconciliation);
router.patch('/payout-requests/:id', protect, authorize('admin'), requirePermission('finance.manage'), adminMarketplace.updatePayoutRequest);
router.get('/support/tickets', protect, authorize('admin'), requirePermission('support.manage'), adminMarketplace.listSupportTickets);
router.get('/support/tickets/:id/resolution', protect, authorize('admin'), requirePermission('support.manage'), adminMarketplace.getSupportResolutionContext);
router.post('/support/tickets/:id/resolve', protect, authorize('admin'), requirePermission('support.manage'), adminMarketplace.resolveSupportTicket);
router.patch('/support/tickets/:id/fault', protect, authorize('admin'), requirePermission('support.manage'), adminMarketplace.setSupportFaultAttribution);
router.post('/support/tickets/:id/reply', protect, authorize('admin'), requirePermission('support.manage'), adminMarketplace.replySupportTicket);
// Pillar 4 — agent assignment, live typing and SLA scoreboard.
router.patch('/support/tickets/:id/assign', protect, authorize('admin'), requirePermission('support.manage'), adminMarketplace.assignSupportTicket);
router.post('/support/tickets/:id/typing', protect, authorize('admin'), requirePermission('support.manage'), adminMarketplace.setSupportTyping);
router.get('/support/metrics', protect, authorize('admin'), requirePermission('support.manage'), adminMarketplace.getSupportMetrics);
router.patch('/restaurants/:id/toggle', protect, authorize('admin'), requirePermission('restaurants.manage'), toggleRestaurant);
router.get('/customers', protect, authorize('admin'), requirePermission('customers.view'), getCustomers);
router.get('/customers/:userId/saved-locations', protect, authorize('admin'), requirePermission('customers.view'), getCustomerSavedLocations);
// Pillar 3 / 7 — COD abuse review queue, per-customer COD terms, account freeze.
router.get('/customers/trust', protect, authorize('admin'), requirePermission('customers.trust'), getCustomerTrustOverview);
router.get('/customers/:userId/trust', protect, authorize('admin'), requirePermission('customers.trust'), getCustomerTrust);
router.patch('/customers/:userId/cod-policy', protect, authorize('admin'), requirePermission('customers.trust'), updateCustomerCodPolicy);
router.patch('/customers/:userId/freeze', protect, authorize('admin'), requirePermission('customers.trust'), setCustomerAccountFreeze);
// Read-only admin audit trail (full administrators only).
router.get('/audit-logs', protect, authorize('admin'), requireFullAdmin, listAuditLogs);
// Pillar 8 — platform + per-restaurant visit analytics.
router.get('/analytics/visits', protect, authorize('admin'), requirePermission('analytics.view'), getVisitAnalytics);
router.get('/inventory', protect, authorize('admin'), requirePermission('restaurants.manage'), getAllRestaurantInventory);
router.patch('/inventory/:itemId', protect, authorize('admin'), requirePermission('restaurants.manage'), updateAnyRestaurantInventory);
router.get('/analytics/revenue', protect, authorize('admin'), requirePermission('analytics.view'), getRevenueAnalytics);
// Pillar 5 — platform vs restaurant review health and top-rated dishes.
router.get('/reviews/analytics', protect, authorize('admin'), requirePermission('reviews.moderate'), getReviewAnalytics);
router.get('/analytics/top-restaurants', protect, authorize('admin'), requirePermission('analytics.view'), getTopRestaurants);
router.get('/reviews', protect, authorize('admin'), requirePermission('reviews.moderate'), getReviews);
router.patch('/reviews/:id', protect, authorize('admin'), requirePermission('reviews.moderate'), moderateReview);
router.get('/admins/:id/permissions', protect, authorize('admin'), requireFullAdmin, getAdminPermissions);
router.patch('/admins/:id/permissions', protect, authorize('admin'), requireFullAdmin, updateAdminPermissions);
router.get('/platform-ratings', protect, authorize('admin'), requirePermission('reviews.moderate'), getPlatformRatings);

// Vendor account management (vendor *creation* is POST /api/auth/admin/create-vendor)
router.get('/vendors', protect, authorize('admin'), requirePermission('vendors.manage'), getVendors);
// Vendor onboarding review. Applications are separate from existing admin
// vendor provisioning so the legacy create-vendor workflow remains intact.
router.get('/vendor-applications', protect, authorize('admin'), requirePermission('vendors.manage'), getVendorApplications);
router.get('/vendor-applications/:id', protect, authorize('admin'), requirePermission('vendors.manage'), getVendorApplicationById);
router.patch('/vendor-applications/:id/approve', protect, authorize('admin'), requirePermission('vendors.manage'), approveVendorApplication);
router.patch('/vendor-applications/:id/reject', protect, authorize('admin'), requirePermission('vendors.manage'), rejectVendorApplication);
router.patch('/vendor-applications/:id/request-changes', protect, authorize('admin'), requirePermission('vendors.manage'), requestVendorApplicationChanges);

router.get('/vendors/:id', protect, authorize('admin'), requirePermission('vendors.manage'), getVendorById);
router.put('/vendors/:id', protect, authorize('admin'), requirePermission('vendors.manage'), updateVendor);
router.patch('/vendors/:id/toggle', protect, authorize('admin'), requirePermission('vendors.manage'), toggleVendorStatus);

module.exports = router;
