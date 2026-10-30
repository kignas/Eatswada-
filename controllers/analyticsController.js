'use strict';

// ─────────────────────────────────────────────────────────────────────
// Analytics endpoints (Pillar 8, extended).
//
// POST /api/analytics/visit   — public, optional auth. Records a browse or
//                               funnel event. Deliberately cheap and
//                               rate-limited so it cannot be used to inflate or
//                               DoS the analytics collection.
// GET  /api/analytics/admin/platform    — admin: platform traffic
// GET  /api/analytics/admin/restaurants — admin: per-restaurant traffic
// GET  /api/analytics/admin/menu        — admin: menu views, items, conversion
// GET  /api/analytics/vendor/menu       — vendor: own restaurant analytics
//
// Server-authoritative order outcomes are recorded by the order lifecycle, not
// here — a client can never POST an "order_completed" event.
// ─────────────────────────────────────────────────────────────────────

const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Restaurant = require('../models/Restaurant');
const MenuItem = require('../models/Menu');
const {
  recordEvent,
  getPlatformVisitAnalytics,
  getRestaurantVisitAnalytics,
  getAdminMenuAnalytics,
  BROWSE_EVENTS,
  FUNNEL_EVENTS,
} = require('../services/analyticsService');

// Event types a client is allowed to submit. Outcome events are rejected: only
// the server may record them, so conversion cannot be forged from the browser.
const CLIENT_BROWSE_EVENTS = new Set(['site_visit', 'search']);
const CLIENT_RESTAURANT_EVENTS = new Set(['restaurant_view', 'menu_view']);
const CLIENT_ITEM_EVENTS = new Set(['item_view', 'add_to_cart', 'remove_from_cart', 'checkout_initiated']);

function clientIp(req) {
  return String((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.socket?.remoteAddress || '');
}

// POST /api/analytics/visit
exports.trackVisit = asyncHandler(async (req, res) => {
  const eventType = String(req.body?.eventType || 'site_visit').trim();
  const restaurantId = req.body?.restaurantId ? String(req.body.restaurantId) : null;
  const menuItemId = req.body?.menuItemId ? String(req.body.menuItemId) : null;
  const sessionId = req.body?.sessionId ? String(req.body.sessionId) : '';
  const eventKey = req.body?.eventKey ? String(req.body.eventKey) : '';

  const isPlatform = CLIENT_BROWSE_EVENTS.has(eventType);
  const isRestaurant = CLIENT_RESTAURANT_EVENTS.has(eventType);
  const isItem = CLIENT_ITEM_EVENTS.has(eventType);
  if (!isPlatform && !isRestaurant && !isItem) {
    return res.status(400).json({ success: false, message: 'Unknown analytics event type.' });
  }

  // NEVER trust a frontend-submitted restaurant id: it must be a valid ObjectId
  // AND the restaurant must actually exist and be customer-visible.
  if ((isRestaurant || isItem) && (!restaurantId || !mongoose.Types.ObjectId.isValid(restaurantId))) {
    return res.status(400).json({ success: false, message: 'A valid restaurantId is required for this event.' });
  }
  if (isRestaurant || isItem) {
    const exists = await Restaurant.exists({ _id: restaurantId, isActive: { $ne: false }, approvalStatus: 'approved' });
    if (!exists) return res.status(404).json({ success: false, message: 'Restaurant not found.' });
  }

  // An item event must reference an item that belongs to THAT restaurant, so a
  // client cannot attribute engagement to another restaurant's menu.
  if (isItem && menuItemId) {
    if (!mongoose.Types.ObjectId.isValid(menuItemId)) {
      return res.status(400).json({ success: false, message: 'Invalid menuItemId.' });
    }
    const owns = await MenuItem.exists({ _id: menuItemId, restaurantId });
    if (!owns) return res.status(400).json({ success: false, message: 'menuItemId does not belong to this restaurant.' });
  }

  const result = await recordEvent({
    eventType,
    scope: isPlatform ? 'platform' : 'restaurant',
    restaurantId: isRestaurant || isItem ? restaurantId : null,
    menuItemId: isItem ? menuItemId : null,
    userId: req.user?._id || null,
    ip: clientIp(req),
    userAgent: String(req.headers['user-agent'] || ''),
    sessionId,
    eventKey,
    platform: String(req.body?.platform || '').slice(0, 40),
    referrer: String(req.body?.referrer || req.headers.referer || '').slice(0, 200),
    source: String(req.body?.source || 'web').slice(0, 20),
  });

  // 202 for a fire-and-forget beacon; recorded:false means deduped/bot.
  res.status(202).json({ success: true, data: result });
});

function assertAdmin(req, res) {
  if (req.user?.role !== 'admin') { res.status(403).json({ success: false, message: 'Admin credentials required.' }); return false; }
  return true;
}

// GET /api/analytics/admin/platform?period=7d|30d|90d|all
exports.getAdminPlatformAnalytics = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const data = await getPlatformVisitAnalytics({
    period: String(req.query.period || '30d'),
    from: req.query.from || null,
    to: req.query.to || null,
  });
  res.json({ success: true, data });
});

// GET /api/analytics/admin/restaurants?restaurantId=&period=
exports.getAdminRestaurantAnalytics = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const period = String(req.query.period || '30d');
  const restaurantId = String(req.query.restaurantId || '').trim();
  if (restaurantId) {
    if (!mongoose.Types.ObjectId.isValid(restaurantId)) return res.status(400).json({ success: false, message: 'Invalid restaurantId.' });
    const restaurant = await Restaurant.findById(restaurantId).select('name').lean();
    if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found.' });
    const data = await getRestaurantVisitAnalytics(restaurantId, { period });
    return res.json({ success: true, data: { restaurant: { id: restaurant._id, name: restaurant.name }, ...data } });
  }
  const data = await getPlatformVisitAnalytics({ period });
  res.json({ success: true, data: { restaurants: data.topRestaurants, period } });
});

// GET /api/analytics/admin/menu?period=&from=&to=
// Admin menu-view dashboard: most-viewed restaurants/items, conversion rates,
// high-view/low-order restaurants and traffic trends, with date-range filtering.
exports.getAdminMenuAnalytics = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const data = await getAdminMenuAnalytics({
    period: String(req.query.period || '30d'),
    from: req.query.from || null,
    to: req.query.to || null,
  });
  res.json({ success: true, data });
});

// GET /api/analytics/vendor/menu?period=
// Vendor-scoped: a vendor can only ever read their OWN restaurant's analytics.
exports.getVendorMenuAnalytics = asyncHandler(async (req, res) => {
  if (req.user?.role !== 'vendor' || !req.user.restaurantId) {
    return res.status(403).json({ success: false, message: 'Vendor restaurant access required.' });
  }
  const data = await getRestaurantVisitAnalytics(req.user.restaurantId, { period: String(req.query.period || '30d') });
  res.json({ success: true, data });
});

// Exposed for tests/contract checks.
exports.CLIENT_BROWSE_EVENTS = CLIENT_BROWSE_EVENTS;
exports.CLIENT_RESTAURANT_EVENTS = CLIENT_RESTAURANT_EVENTS;
exports.CLIENT_ITEM_EVENTS = CLIENT_ITEM_EVENTS;
exports.BROWSE_EVENTS = BROWSE_EVENTS;
exports.FUNNEL_EVENTS = FUNNEL_EVENTS;
