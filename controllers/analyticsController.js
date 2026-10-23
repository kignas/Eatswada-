'use strict';

// ─────────────────────────────────────────────────────────────────────
// Visit analytics endpoints (Pillar 8).
//
// POST /api/analytics/visit   — public, optional auth. Records a site visit or
//                               a restaurant/menu view. Deliberately cheap and
//                               rate-limited so it cannot be used to inflate or
//                               DoS the analytics collection.
// GET  /api/analytics/admin/platform    — admin: platform traffic
// GET  /api/analytics/admin/restaurants — admin: per-restaurant traffic
// GET  /api/analytics/vendor/menu       — vendor: own restaurant traffic
// ─────────────────────────────────────────────────────────────────────

const asyncHandler = require('express-async-handler');
const Restaurant = require('../models/Restaurant');
const { recordVisit, getPlatformVisitAnalytics, getRestaurantVisitAnalytics } = require('../services/analyticsService');

const PLATFORM_EVENTS = new Set(['site_visit', 'search']);
const RESTAURANT_EVENTS = new Set(['restaurant_view', 'menu_view']);

function clientIp(req) {
  return String((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.socket?.remoteAddress || '');
}

// POST /api/analytics/visit
exports.trackVisit = asyncHandler(async (req, res) => {
  const eventType = String(req.body?.eventType || 'site_visit').trim();
  const restaurantId = req.body?.restaurantId ? String(req.body.restaurantId) : null;

  // Only allow events that belong to the declared scope, so a client cannot
  // invent an arbitrary event name or inflate a restaurant with platform hits.
  const isPlatform = PLATFORM_EVENTS.has(eventType);
  const isRestaurant = RESTAURANT_EVENTS.has(eventType);
  if (!isPlatform && !isRestaurant) {
    return res.status(400).json({ success: false, message: 'Unknown analytics event type.' });
  }
  if (isRestaurant && (!restaurantId || !require('mongoose').Types.ObjectId.isValid(restaurantId))) {
    return res.status(400).json({ success: false, message: 'A valid restaurantId is required for this event.' });
  }

  // Validate the restaurant exists before recording so random ids can't grow
  // the collection with junk rows.
  if (isRestaurant) {
    const exists = await Restaurant.exists({ _id: restaurantId, isActive: { $ne: false } });
    if (!exists) return res.status(404).json({ success: false, message: 'Restaurant not found.' });
  }

  const result = await recordVisit({
    eventType,
    scope: isRestaurant ? 'restaurant' : 'platform',
    restaurantId: isRestaurant ? restaurantId : null,
    userId: req.user?._id || null,
    ip: clientIp(req),
    userAgent: String(req.headers['user-agent'] || ''),
    platform: String(req.body?.platform || '').slice(0, 40),
    referrer: String(req.body?.referrer || req.headers.referer || '').slice(0, 200),
  });

  // 202 for a fire-and-forget beacon; recorded:false simply means already counted today.
  res.status(202).json({ success: true, data: result });
});

function assertAdmin(req, res) {
  if (req.user?.role !== 'admin') { res.status(403).json({ success: false, message: 'Admin credentials required.' }); return false; }
  return true;
}

// GET /api/analytics/admin/platform?period=7d|30d|90d|all
exports.getAdminPlatformAnalytics = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const data = await getPlatformVisitAnalytics({ period: String(req.query.period || '30d') });
  res.json({ success: true, data });
});

// GET /api/analytics/admin/restaurants?restaurantId=&period=
exports.getAdminRestaurantAnalytics = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const period = String(req.query.period || '30d');
  const restaurantId = String(req.query.restaurantId || '').trim();
  if (restaurantId) {
    if (!require('mongoose').Types.ObjectId.isValid(restaurantId)) return res.status(400).json({ success: false, message: 'Invalid restaurantId.' });
    const restaurant = await Restaurant.findById(restaurantId).select('name').lean();
    if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found.' });
    const data = await getRestaurantVisitAnalytics(restaurantId, { period });
    return res.json({ success: true, data: { restaurant: { id: restaurant._id, name: restaurant.name }, ...data } });
  }
  const data = await getPlatformVisitAnalytics({ period });
  res.json({ success: true, data: { restaurants: data.topRestaurants, period } });
});

// GET /api/analytics/vendor/menu?period=
exports.getVendorMenuAnalytics = asyncHandler(async (req, res) => {
  if (req.user?.role !== 'vendor' || !req.user.restaurantId) {
    return res.status(403).json({ success: false, message: 'Vendor restaurant access required.' });
  }
  const data = await getRestaurantVisitAnalytics(req.user.restaurantId, { period: String(req.query.period || '30d') });
  res.json({ success: true, data });
});
