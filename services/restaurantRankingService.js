'use strict';

// ─────────────────────────────────────────────────────────────────────
// Restaurant ranking service.
//
// The single place that answers "in what order do customers see restaurants?"
// and "may this restaurant accept an order right now?".
//
// Layers:
//   1. computeRestaurantSample()  — aggregate the rolling-window inputs
//      (orders, reviews, support tickets, refunds, repeat customers).
//   2. refreshRestaurantPerformance() — fold the sample through the pure
//      scorer and persist it (RestaurantPerformance + the denormalised copy on
//      Restaurant so the listing sorts in one indexed query).
//   3. rankRestaurants()          — pure ordering of an already-fetched page:
//      online before offline, pinned first, then performance; sponsored slots
//      are injected and labelled.
//
// Caching / cost control (requirement: no expensive full ranking per request):
//   • The customer listing sorts on `Restaurant.performance.score`, an indexed
//     field. Ranking a page therefore costs ZERO extra aggregation queries.
//   • Scores are recomputed by a periodic sweep and on significant events
//     (order delivered/cancelled, review moderated, refund resolved), not per
//     request.
//   • The ranking config is cached in-process and invalidated on admin write.
// ─────────────────────────────────────────────────────────────────────

const mongoose = require('mongoose');
const Restaurant = require('../models/Restaurant');
const Order = require('../models/Order');
const Review = require('../models/Review');
const SupportTicket = require('../models/SupportTicket');
const RestaurantPerformance = require('../models/RestaurantPerformance');
const RankingConfig = require('../models/RankingConfig');
const { createMemoryCache, readTtlMs } = require('../utils/memoryCache');
const { computePerformanceScore, resolveConfig, DEFAULT_CONFIG } = require('./restaurantPerformanceService');
const { classifyRestaurantAvailability, isCustomerVisible } = require('./restaurantAvailability');
const { haversineKm, MAX_DELIVERY_RADIUS_KM, validCoordinates } = require('./deliveryPricing');

const CONFIG_KEY = 'ranking';
const CONFIG_TTL_MS = readTtlMs('RANKING_CONFIG_CACHE_TTL_MS', 60_000);
const configCache = createMemoryCache({ ttlMs: CONFIG_TTL_MS });

/** Load the (cached) ranking configuration, merged over safe defaults. */
async function getRankingConfig({ fresh = false } = {}) {
  if (fresh) configCache.invalidate();
  return configCache.get('config', async () => {
    let doc = null;
    try {
      doc = await RankingConfig.findOne({ key: CONFIG_KEY }).lean();
    } catch (err) {
      console.error('[ranking] could not load ranking config:', err.message);
    }
    return resolveConfig(doc || {});
  });
}

/** Invalidate the cached config after an admin write. */
function invalidateRankingConfigCache() {
  configCache.invalidate();
}

// ── Sample aggregation ────────────────────────────────────────────────

/**
 * Aggregate the rolling-window performance inputs for one restaurant.
 * Read-only; never throws into a caller's request path.
 */
async function computeRestaurantSample(restaurantId, config) {
  const rid = new mongoose.Types.ObjectId(String(restaurantId));
  const windowStart = new Date(Date.now() - config.windowDays * 86400000);
  const recentStart = new Date(Date.now() - config.recentWindowDays * 86400000);

  const orderMatch = { restaurant: rid, createdAt: { $gte: windowStart } };

  const [orderRows, recentRows, reviewRows, complaintRows, refundRows, repeatRows] = await Promise.all([
    Order.aggregate([
      { $match: orderMatch },
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
          restaurantFaultCancelled: {
            $sum: { $cond: [{ $eq: ['$cancellationResponsibility', 'restaurant'] }, 1, 0] },
          },
          // Preparation is measured against the restaurant's OWN promise
          // (prepMinutes) using the real start→ready timestamps.
          avgPrepMinutes: {
            $avg: {
              $cond: [
                { $and: [{ $ne: ['$prepReadyAt', null] }, { $ne: ['$prepStartedAt', null] }] },
                { $divide: [{ $subtract: ['$prepReadyAt', '$prepStartedAt'] }, 60000] },
                null,
              ],
            },
          },
          avgPromisedMinutes: { $avg: '$prepMinutes' },
          lateOrders: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$prepReadyAt', null] },
                    { $ne: ['$prepStartedAt', null] },
                    { $ne: ['$prepMinutes', null] },
                    { $gt: [{ $subtract: ['$prepReadyAt', '$prepStartedAt'] }, { $multiply: ['$prepMinutes', 60000] }] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
    Order.aggregate([
      { $match: { restaurant: rid, createdAt: { $gte: recentStart } } },
      {
        $group: {
          _id: null,
          recentOrders: { $sum: 1 },
          recentCompleted: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
          recentCancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
        },
      },
    ]),
    Review.aggregate([
      { $match: { restaurant: rid, isVisible: true, createdAt: { $gte: windowStart } } },
      { $group: { _id: null, reviews: { $sum: 1 }, avgRating: { $avg: '$score' } } },
    ]),
    // Complaints attributed to the restaurant (vendor fault) in the window.
    SupportTicket.aggregate([
      { $match: { restaurant: rid, createdAt: { $gte: windowStart }, faultAttribution: 'vendor' } },
      { $group: { _id: null, complaints: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: { restaurant: rid, createdAt: { $gte: windowStart }, 'refund.status': 'completed' } },
      { $group: { _id: null, refunds: { $sum: 1 } } },
    ]),
    // Repeat customers: how many of this restaurant's window orders came from a
    // customer who has ordered here more than once.
    Order.aggregate([
      { $match: { restaurant: rid, createdAt: { $gte: windowStart } } },
      { $group: { _id: '$user', orders: { $sum: 1 } } },
      { $group: { _id: null, repeatOrders: { $sum: { $cond: [{ $gt: ['$orders', 1] }, '$orders', 0] } } } },
    ]),
  ]);

  const orders = orderRows[0] || {};
  const recent = recentRows[0] || {};
  const reviews = reviewRows[0] || {};
  const complaints = complaintRows[0] || {};
  const refunds = refundRows[0] || {};
  const repeat = repeatRows[0] || {};

  const recentTotal = Number(recent.recentOrders || 0);
  const recentCompletionRate = recentTotal > 0
    ? Number(recent.recentCompleted || 0) / recentTotal
    : null;

  return {
    orders: Number(orders.orders || 0),
    completed: Number(orders.completed || 0),
    cancelled: Number(orders.cancelled || 0),
    restaurantFaultCancelled: Number(orders.restaurantFaultCancelled || 0),
    avgPrepMinutes: orders.avgPrepMinutes == null ? null : Number(orders.avgPrepMinutes),
    avgPromisedMinutes: orders.avgPromisedMinutes == null ? null : Number(orders.avgPromisedMinutes),
    lateOrders: Number(orders.lateOrders || 0),
    reviews: Number(reviews.reviews || 0),
    avgRating: reviews.avgRating == null ? null : Number(reviews.avgRating),
    complaints: Number(complaints.complaints || 0),
    refunds: Number(refunds.refunds || 0),
    repeatOrders: Number(repeat.repeatOrders || 0),
    recentOrders: recentTotal,
    recentCompletionRate,
  };
}

/**
 * Compute and persist one restaurant's performance score.
 * Writes RestaurantPerformance (detail) and Restaurant.performance (the
 * denormalised, indexed copy the listing sorts on). Never throws.
 */
async function refreshRestaurantPerformance(restaurantId, { config = null } = {}) {
  try {
    const cfg = config || await getRankingConfig();
    const sample = await computeRestaurantSample(restaurantId, cfg);
    const result = computePerformanceScore(sample, cfg);

    await RestaurantPerformance.findOneAndUpdate(
      { restaurant: restaurantId },
      {
        $set: {
          score: result.score,
          dataConfidence: result.dataConfidence,
          isNewRestaurant: result.isNewRestaurant,
          factors: result.factors,
          sample,
          windowDays: result.windowDays,
          weights: result.weights,
          computedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await Restaurant.updateOne(
      { _id: restaurantId },
      {
        $set: {
          'performance.score': result.score,
          'performance.dataConfidence': result.dataConfidence,
          'performance.isNew': result.isNewRestaurant,
          'performance.computedAt': new Date(),
        },
      }
    );

    return { ...result, sample };
  } catch (err) {
    console.error(`[ranking] refresh failed for ${restaurantId}:`, err.message);
    return null;
  }
}

/**
 * Refresh every customer-visible restaurant. Intended for the periodic sweep
 * (and manual admin trigger), never for a customer request.
 */
async function refreshAllRestaurantPerformance({ limit = 500 } = {}) {
  const config = await getRankingConfig({ fresh: true });
  const restaurants = await Restaurant.find({ isActive: { $ne: false } }).select('_id').limit(limit).lean();
  let updated = 0;
  for (const restaurant of restaurants) {
    // Sequential on purpose: a sweep must not stampede the DB with parallel
    // aggregations. The interval is configurable and this runs off the request
    // path, so throughput matters less than steady load.
    const result = await refreshRestaurantPerformance(restaurant._id, { config });
    if (result) updated += 1;
  }
  return { scanned: restaurants.length, updated, windowDays: config.windowDays };
}

// ── Ranking (ordering a page of already-fetched restaurants) ──────────

function sponsoredActive(restaurant, now) {
  if (!restaurant?.isSponsored) return false;
  if (!restaurant.sponsoredUntil) return true;
  return new Date(restaurant.sponsoredUntil) > now;
}

function pinnedActive(restaurant, now) {
  if (!restaurant?.isPinned) return false;
  if (!restaurant.pinnedUntil) return true;
  return new Date(restaurant.pinnedUntil) > now;
}

/**
 * Order a list of restaurants for the customer listing.
 *
 * Rules, in precedence order:
 *   1. ONLINE before OFFLINE. Always. An offline restaurant can never outrank
 *      an online one, no matter how it is pinned or sponsored.
 *   2. Inside the online group: pinned (admin) → featured (legacy admin) →
 *      performance score → legacy displayPriority → rating.
 *   3. Inside the offline group: performance score → rating.
 *   4. Sponsored restaurants are injected into the top `maxSponsoredSlots`
 *      positions of the ONLINE group and marked `sponsored: true`.
 *
 * @returns {Array} the same restaurants, each with `rankPosition`,
 *   `sponsored`, `sponsoredLabel` and `availabilityClass` set.
 */
function rankRestaurants(restaurants, { now = new Date(), config = null, context = null } = {}) {
  const cfg = config || resolveConfig({});
  const list = Array.isArray(restaurants) ? restaurants : [];

  const decorated = list.map((restaurant) => {
    const availability = classifyRestaurantAvailability(restaurant, now, context);
    return {
      ...restaurant,
      availabilityClass: availability.class,
      orderable: availability.orderable,
      availabilityInfo: availability,
      _online: availability.orderable ? 1 : 0,
      _pinned: pinnedActive(restaurant, now) ? 1 : 0,
      _sponsored: sponsoredActive(restaurant, now) ? 1 : 0,
      _score: Number(restaurant?.performance?.score) || 0,
    };
  });

  const byScore = (a, b) =>
    b._online - a._online ||
    b._pinned - a._pinned ||
    (b.isFeatured ? 1 : 0) - (a.isFeatured ? 1 : 0) ||
    b._score - a._score ||
    (Number(b.displayPriority) || 0) - (Number(a.displayPriority) || 0) ||
    (Number(b.rating) || 0) - (Number(a.rating) || 0);

  const sorted = decorated.slice().sort(byScore);

  // Sponsored injection: take sponsored ONLINE restaurants and float them into
  // the top slots, but only within the online block so rule 1 still holds.
  let ordered = sorted;
  if (cfg.sponsoredEnabled && cfg.maxSponsoredSlots > 0) {
    const onlineCount = sorted.filter((r) => r._online === 1).length;
    const slots = Math.min(cfg.maxSponsoredSlots, onlineCount);
    const sponsored = sorted.filter((r) => r._online === 1 && r._sponsored === 1).slice(0, slots);
    if (sponsored.length) {
      const sponsoredIds = new Set(sponsored.map((r) => String(r._id)));
      const rest = sorted.filter((r) => !sponsoredIds.has(String(r._id)));
      const offline = rest.filter((r) => r._online === 0);
      const onlineRest = rest.filter((r) => r._online === 1);
      // Interleave: sponsored fill positions 0..n-1, then the organic online
      // block, then every offline restaurant.
      ordered = [...sponsored, ...onlineRest, ...offline];
    }
  }

  return ordered.map((restaurant, index) => {
    const { _online, _pinned, _sponsored, _score, ...clean } = restaurant;
    return {
      ...clean,
      sponsored: restaurant._sponsored === 1,
      sponsoredLabel: restaurant._sponsored === 1 ? (restaurant.sponsorLabel || 'Sponsored') : '',
      pinned: restaurant._pinned === 1,
      rankPosition: index + 1,
    };
  });
}

/**
 * Attach delivery distance + serviceability to a restaurant for a customer
 * location, without changing the ranking contract when no location is known.
 */
function withServiceability(restaurant, customerCoords) {
  if (!validCoordinates(customerCoords)) {
    return { ...restaurant, distanceKm: null, serviceable: null };
  }
  const coords = restaurant?.location?.coordinates;
  if (!validCoordinates(coords)) {
    return { ...restaurant, distanceKm: null, serviceable: false, unserviceableReason: 'no_location' };
  }
  const distanceKm = Math.round(haversineKm(coords, customerCoords) * 100) / 100;
  const configured = Number(restaurant.deliveryRadiusKm);
  const radius = Number.isFinite(configured) && configured > 0 ? Math.min(configured, MAX_DELIVERY_RADIUS_KM) : MAX_DELIVERY_RADIUS_KM;
  return {
    ...restaurant,
    distanceKm,
    serviceable: distanceKm <= radius,
    deliveryRadiusKm: radius,
  };
}

/** Periodically recompute scores. Mirrors the other recovery schedulers. */
function startPerformanceScheduler(intervalMs = Number(process.env.RANKING_REFRESH_INTERVAL_MS) || 15 * 60 * 1000) {
  let timer = null;
  const run = () => refreshAllRestaurantPerformance().catch((err) => console.error('[ranking] sweep failed:', err.message));
  timer = setInterval(run, Math.max(60_000, intervalMs));
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

// ── Event-driven refresh (debounced) ─────────────────────────────────
// A delivery, cancellation or review is a "significant performance event".
// Recomputing immediately per event would run seven aggregations per order and
// stampede the DB during a lunch rush, so refreshes are COALESCED per
// restaurant over a short window: many events -> one recomputation. The
// periodic sweep is the safety net if a process restarts mid-window.
const pendingRefreshes = new Map(); // restaurantId -> timeout
const DEBOUNCE_MS = Number(process.env.RANKING_REFRESH_DEBOUNCE_MS) || 30_000;

/**
 * Queue a performance recomputation for one restaurant. Safe to call from any
 * event hook: it never throws and never blocks the caller.
 */
function schedulePerformanceRefresh(restaurantId, { delayMs = DEBOUNCE_MS } = {}) {
  const id = String(restaurantId || '');
  if (!/^[a-f\d]{24}$/i.test(id)) return;
  const existing = pendingRefreshes.get(id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingRefreshes.delete(id);
    refreshRestaurantPerformance(id).catch((err) => console.error('[ranking] event refresh failed:', err.message));
  }, Math.max(0, delayMs));
  if (typeof timer.unref === 'function') timer.unref();
  pendingRefreshes.set(id, timer);
}

module.exports = {
  CONFIG_KEY,
  getRankingConfig,
  invalidateRankingConfigCache,
  computeRestaurantSample,
  refreshRestaurantPerformance,
  refreshAllRestaurantPerformance,
  rankRestaurants,
  withServiceability,
  startPerformanceScheduler,
  schedulePerformanceRefresh,
  DEFAULT_CONFIG,
  isCustomerVisible,
};
