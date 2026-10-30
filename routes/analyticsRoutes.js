'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { protect, authorize, optionalAuth } = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const c = require('../controllers/analyticsController');

const router = express.Router();

// Public beacon: generous but bounded, keyed by normalized client IP so a
// single abusive client cannot inflate traffic counts or hammer the collection.
const trackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { success: false, message: 'Too many analytics events. Please slow down.' },
});

// Public, optional-auth visit beacon.
router.post('/visit', trackLimiter, optionalAuth, c.trackVisit);

// Admin traffic dashboards.
router.get('/admin/platform', protect, authorize('admin'), requirePermission('analytics.view'), c.getAdminPlatformAnalytics);
router.get('/admin/restaurants', protect, authorize('admin'), requirePermission('analytics.view'), c.getAdminRestaurantAnalytics);
// Admin menu-view analytics (most-viewed restaurants/items, conversion, trends).
router.get('/admin/menu', protect, authorize('admin'), requirePermission('analytics.view'), c.getAdminMenuAnalytics);

// Vendor: own restaurant menu traffic.
router.get('/vendor/menu', protect, authorize('vendor'), c.getVendorMenuAnalytics);

module.exports = router;
