'use strict';

// ─────────────────────────────────────────────────────────────────────
// Admin controls for the Restaurant Performance & Ranking Engine.
//
//   GET   /api/admin/restaurants/performance           — scores + factors
//   GET   /api/admin/restaurants/:id/performance       — one restaurant, detail
//   PATCH /api/admin/restaurants/:id/ranking           — pin / feature / sponsor
//   GET   /api/admin/ranking/config                    — current weights
//   PATCH /api/admin/ranking/config                    — retune weights
//   POST  /api/admin/ranking/recompute                 — force a refresh
//   GET   /api/admin/ranking/poor-performers           — weak completion/cancel
//   GET   /api/admin/restaurants/offline               — offline status + reason
//
// Every mutation is written to the admin audit trail (AdminAuditLog) through
// services/auditService, which never throws, so an audit-write failure cannot
// break the admin action.
// ─────────────────────────────────────────────────────────────────────

const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Restaurant = require('../models/Restaurant');
const RestaurantPerformance = require('../models/RestaurantPerformance');
const RankingConfig = require('../models/RankingConfig');
const { logAdminAction } = require('../services/auditService');
const {
  getRankingConfig,
  invalidateRankingConfigCache,
  refreshAllRestaurantPerformance,
  CONFIG_KEY,
} = require('../services/restaurantRankingService');
const { classifyRestaurantAvailability } = require('../services/restaurantAvailability');
const { getLocalContext } = require('../services/restaurantHours');
const { DEFAULT_WEIGHTS, FACTOR_LABELS } = require('../services/restaurantPerformanceService');

function assertAdmin(req, res) {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ success: false, message: 'Admin credentials required.' });
    return false;
  }
  return true;
}

const clampLimit = (value, fallback = 50, max = 200) => Math.min(max, Math.max(1, Number(value) || fallback));

/**
 * GET /api/admin/restaurants/performance?limit=&sort=score|completion|cancellation
 * Every restaurant's current score, confidence and factor breakdown.
 */
exports.listRestaurantPerformance = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const limit = clampLimit(req.query.limit, 50, 200);
  const sortKey = String(req.query.sort || 'score');

  const sort = sortKey === 'completion'
    ? { 'sample.completed': -1 }
    : sortKey === 'cancellation'
      ? { 'sample.cancelled': -1 }
      : { score: -1 };

  const rows = await RestaurantPerformance.find({}).sort(sort).limit(limit).lean();
  const ids = rows.map((r) => r.restaurant);
  const restaurants = ids.length
    ? await Restaurant.find({ _id: { $in: ids } })
      .select('name isActive approvalStatus isFeatured isPinned isSponsored performance availability openingHours isOpen')
      .lean()
    : [];
  const byId = new Map(restaurants.map((r) => [String(r._id), r]));
  const now = new Date();
  const context = getLocalContext(now);

  res.json({
    success: true,
    data: rows.map((row) => {
      const restaurant = byId.get(String(row.restaurant)) || {};
      const availability = classifyRestaurantAvailability(restaurant, now, context);
      return {
        restaurantId: row.restaurant,
        name: restaurant.name || 'Unknown',
        score: row.score,
        dataConfidence: row.dataConfidence,
        isNewRestaurant: row.isNewRestaurant,
        computedAt: row.computedAt,
        factors: row.factors,
        sample: row.sample,
        availabilityClass: availability.class,
        orderable: availability.orderable,
        featured: restaurant.isFeatured === true,
        pinned: restaurant.isPinned === true,
        sponsored: restaurant.isSponsored === true,
      };
    }),
  });
});

/** GET /api/admin/restaurants/:id/performance — one restaurant, with factors. */
exports.getRestaurantPerformance = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid restaurant id.' });
  const restaurant = await Restaurant.findById(id).select('name isActive approvalStatus isFeatured isPinned isSponsored sponsorLabel performance availability openingHours isOpen').lean();
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found.' });

  const performance = await RestaurantPerformance.findOne({ restaurant: id }).lean();
  const now = new Date();
  const availability = classifyRestaurantAvailability(restaurant, now, getLocalContext(now));

  res.json({
    success: true,
    data: {
      restaurantId: restaurant._id,
      name: restaurant.name,
      score: performance?.score ?? restaurant.performance?.score ?? 0,
      dataConfidence: performance?.dataConfidence ?? restaurant.performance?.dataConfidence ?? 0,
      isNewRestaurant: performance?.isNewRestaurant ?? restaurant.performance?.isNew ?? true,
      computedAt: performance?.computedAt || null,
      factors: performance?.factors || [],
      sample: performance?.sample || null,
      availability: { class: availability.class, orderable: availability.orderable, reason: availability.reason, label: availability.label, nextOpening: availability.nextOpening },
      overrides: { featured: restaurant.isFeatured === true, pinned: restaurant.isPinned === true, sponsored: restaurant.isSponsored === true, sponsorLabel: restaurant.sponsorLabel || '' },
    },
  });
});

/**
 * PATCH /api/admin/restaurants/:id/ranking
 * Body: { isPinned?, pinnedUntil?, pinReason?, isFeatured?, isSponsored?, sponsoredUntil?, sponsorLabel? }
 * Manually feature / pin / sponsor. Audited.
 */
exports.updateRestaurantRanking = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid restaurant id.' });
  const restaurant = await Restaurant.findById(id).select('name isFeatured isPinned pinnedUntil pinReason isSponsored sponsoredUntil sponsorLabel');
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found.' });

  const body = req.body || {};
  const update = {};
  const before = {
    isFeatured: restaurant.isFeatured, isPinned: restaurant.isPinned, pinnedUntil: restaurant.pinnedUntil,
    pinReason: restaurant.pinReason, isSponsored: restaurant.isSponsored, sponsoredUntil: restaurant.sponsoredUntil,
    sponsorLabel: restaurant.sponsorLabel,
  };

  if (Object.prototype.hasOwnProperty.call(body, 'isFeatured')) {
    if (typeof body.isFeatured !== 'boolean') return res.status(400).json({ success: false, message: 'isFeatured must be a boolean.' });
    update.isFeatured = body.isFeatured;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'isPinned')) {
    if (typeof body.isPinned !== 'boolean') return res.status(400).json({ success: false, message: 'isPinned must be a boolean.' });
    update.isPinned = body.isPinned;
    // Un-pinning clears any expiry/reason so the state cannot linger.
    if (!body.isPinned) { update.pinnedUntil = null; update.pinReason = ''; }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'pinnedUntil')) {
    if (body.pinnedUntil === null || body.pinnedUntil === '') update.pinnedUntil = null;
    else {
      const when = new Date(body.pinnedUntil);
      if (Number.isNaN(when.getTime())) return res.status(400).json({ success: false, message: 'pinnedUntil must be a valid date.' });
      update.pinnedUntil = when;
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'pinReason')) {
    update.pinReason = String(body.pinReason || '').slice(0, 200);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'isSponsored')) {
    if (typeof body.isSponsored !== 'boolean') return res.status(400).json({ success: false, message: 'isSponsored must be a boolean.' });
    update.isSponsored = body.isSponsored;
    if (!body.isSponsored) update.sponsoredUntil = null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sponsoredUntil')) {
    if (body.sponsoredUntil === null || body.sponsoredUntil === '') update.sponsoredUntil = null;
    else {
      const when = new Date(body.sponsoredUntil);
      if (Number.isNaN(when.getTime())) return res.status(400).json({ success: false, message: 'sponsoredUntil must be a valid date.' });
      update.sponsoredUntil = when;
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sponsorLabel')) {
    update.sponsorLabel = String(body.sponsorLabel || '').slice(0, 60);
  }

  if (!Object.keys(update).length) {
    return res.status(400).json({ success: false, message: 'Provide isPinned, isFeatured, isSponsored, their expiry, or a label.' });
  }

  const updated = await Restaurant.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true })
    .select('name isFeatured isPinned pinnedUntil pinReason isSponsored sponsoredUntil sponsorLabel');

  await logAdminAction(req, {
    action: 'restaurant.ranking.update',
    targetType: 'restaurant',
    targetId: updated._id,
    targetLabel: updated.name,
    oldValue: before,
    newValue: {
      isFeatured: updated.isFeatured, isPinned: updated.isPinned, pinnedUntil: updated.pinnedUntil,
      pinReason: updated.pinReason, isSponsored: updated.isSponsored, sponsoredUntil: updated.sponsoredUntil,
      sponsorLabel: updated.sponsorLabel,
    },
  });

  res.json({
    success: true,
    data: {
      restaurantId: updated._id,
      featured: updated.isFeatured,
      pinned: updated.isPinned,
      pinnedUntil: updated.pinnedUntil,
      pinReason: updated.pinReason,
      sponsored: updated.isSponsored,
      sponsoredUntil: updated.sponsoredUntil,
      sponsorLabel: updated.sponsorLabel,
    },
  });
});

/** GET /api/admin/ranking/config — weights + thresholds, with labels. */
exports.getRankingConfig = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const config = await getRankingConfig({ fresh: true });
  res.json({
    success: true,
    data: {
      weights: config.weights,
      defaultWeights: DEFAULT_WEIGHTS,
      factorLabels: FACTOR_LABELS,
      windowDays: config.windowDays,
      recentWindowDays: config.recentWindowDays,
      minOrdersForFullConfidence: config.minOrdersForFullConfidence,
      minReviewsForFullConfidence: config.minReviewsForFullConfidence,
      targetPrepMinutes: config.targetPrepMinutes,
      targetRating: config.targetRating,
      neutralRating: config.neutralRating,
      sponsoredEnabled: config.sponsoredEnabled,
      maxSponsoredSlots: config.maxSponsoredSlots,
      sponsoredScoreBoost: config.sponsoredScoreBoost,
    },
  });
});

/**
 * PATCH /api/admin/ranking/config
 * Retune the ranking weights and thresholds. Audited; the in-process config
 * cache is invalidated immediately so the change takes effect on the next
 * listing request.
 */
exports.updateRankingConfig = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const body = req.body || {};
  const set = {};

  if (body.weights && typeof body.weights === 'object') {
    for (const [key, raw] of Object.entries(body.weights)) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_WEIGHTS, key)) continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({ success: false, message: `Weight "${key}" must be a non-negative number.` });
      }
      set[`weights.${key}`] = value;
    }
    // A weights patch that zeroes everything would make the score meaningless.
    const merged = { ...DEFAULT_WEIGHTS };
    for (const [key] of Object.entries(set)) merged[key.split('.')[1]] = set[key];
    const total = Object.values(merged).reduce((acc, v) => acc + (Number(v) || 0), 0);
    if (total <= 0) return res.status(400).json({ success: false, message: 'At least one weight must be greater than zero.' });
  }

  const numeric = {
    windowDays: [1, 365], recentWindowDays: [1, 90],
    minOrdersForFullConfidence: [1, 100000], minReviewsForFullConfidence: [1, 100000],
    targetPrepMinutes: [1, 240], targetRating: [1, 5], neutralRating: [1, 5],
    maxSponsoredSlots: [0, 20], sponsoredScoreBoost: [0, 50],
  };
  for (const [key, [min, max]] of Object.entries(numeric)) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const value = Number(body[key]);
    if (!Number.isFinite(value) || value < min || value > max) {
      return res.status(400).json({ success: false, message: `${key} must be a number between ${min} and ${max}.` });
    }
    set[key] = value;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sponsoredEnabled')) {
    if (typeof body.sponsoredEnabled !== 'boolean') return res.status(400).json({ success: false, message: 'sponsoredEnabled must be a boolean.' });
    set.sponsoredEnabled = body.sponsoredEnabled;
  }

  if (!Object.keys(set).length) return res.status(400).json({ success: false, message: 'Provide weights or a threshold to update.' });

  const previous = await RankingConfig.findOne({ key: CONFIG_KEY }).lean();
  await RankingConfig.findOneAndUpdate(
    { key: CONFIG_KEY },
    { $set: { ...set, updatedBy: req.user._id } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  invalidateRankingConfigCache();

  await logAdminAction(req, {
    action: 'ranking.config.update',
    targetType: 'ranking',
    targetId: null,
    targetLabel: 'ranking config',
    oldValue: previous ? { weights: previous.weights, windowDays: previous.windowDays, sponsoredScoreBoost: previous.sponsoredScoreBoost } : null,
    newValue: set,
  });

  const config = await getRankingConfig({ fresh: true });
  res.json({ success: true, data: { weights: config.weights, windowDays: config.windowDays, sponsoredEnabled: config.sponsoredEnabled, maxSponsoredSlots: config.maxSponsoredSlots, sponsoredScoreBoost: config.sponsoredScoreBoost } });
});

/** POST /api/admin/ranking/recompute — force a full score refresh. */
exports.recomputeRanking = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const result = await refreshAllRestaurantPerformance({ limit: clampLimit(req.body?.limit, 500, 2000) });
  await logAdminAction(req, {
    action: 'ranking.recompute',
    targetType: 'ranking',
    targetId: null,
    targetLabel: 'ranking recompute',
    oldValue: null,
    newValue: result,
  });
  res.json({ success: true, data: result });
});

/**
 * GET /api/admin/ranking/poor-performers?limit=
 * Restaurants with weak completion or cancellation performance, so an admin can
 * intervene before customers notice. Derived from the same persisted factors
 * the ranking uses — no separate calculation.
 */
exports.getPoorPerformers = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const limit = clampLimit(req.query.limit, 25, 100);

  const rows = await RestaurantPerformance.find({
    'sample.orders': { $gt: 0 },
    $or: [
      { 'sample.cancelled': { $gt: 0 } },
      { 'sample.completed': { $gt: 0 } },
    ],
  }).lean();

  const scored = rows.map((row) => {
    const completed = Number(row.sample?.completed || 0);
    const cancelled = Number(row.sample?.cancelled || 0);
    const total = completed + cancelled;
    const completionRate = total > 0 ? Math.round((completed / total) * 1000) / 10 : null;
    const cancellationRate = total > 0 ? Math.round((cancelled / total) * 1000) / 10 : null;
    return {
      restaurantId: row.restaurant,
      score: row.score,
      completionRate,
      cancellationRate,
      completed,
      cancelled,
      complaints: Number(row.sample?.complaints || 0),
      refunds: Number(row.sample?.refunds || 0),
      avgPrepMinutes: row.sample?.avgPrepMinutes ?? null,
    };
  });

  // "Poor" = completion below 85% or cancellation above 15%, ranked worst first.
  const poor = scored
    .filter((r) => (r.completionRate != null && r.completionRate < 85) || (r.cancellationRate != null && r.cancellationRate > 15))
    .sort((a, b) => (a.completionRate ?? 100) - (b.completionRate ?? 100))
    .slice(0, limit);

  const ids = poor.map((r) => r.restaurantId);
  const names = ids.length ? await Restaurant.find({ _id: { $in: ids } }).select('name').lean() : [];
  const nameMap = new Map(names.map((r) => [String(r._id), r.name]));

  res.json({ success: true, data: poor.map((r) => ({ ...r, name: nameMap.get(String(r.restaurantId)) || 'Unknown' })) });
});

/**
 * GET /api/admin/restaurants/offline
 * Every restaurant that is currently NOT orderable, with the precise reason,
 * so temporarily-offline can be told apart from suspended/unapproved.
 */
exports.listOfflineRestaurants = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const restaurants = await Restaurant.find({})
    .select('name isActive approvalStatus availability openingHours isOpen performance isPinned isFeatured')
    .lean();
  const now = new Date();
  const context = getLocalContext(now);

  const offline = [];
  for (const restaurant of restaurants) {
    const availability = classifyRestaurantAvailability(restaurant, now, context);
    if (availability.orderable) continue;
    offline.push({
      restaurantId: restaurant._id,
      name: restaurant.name,
      class: availability.class,
      reason: availability.reason,
      label: availability.label,
      nextOpening: availability.nextOpening,
      approvalStatus: restaurant.approvalStatus,
      isActive: restaurant.isActive !== false,
      performanceScore: Number(restaurant.performance?.score) || 0,
    });
  }

  res.json({ success: true, count: offline.length, data: offline });
});

/**
 * GET /api/admin/ranking/sponsored
 * Sponsored placements currently in effect (clearly-labelled inventory).
 */
exports.listSponsored = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const now = new Date();
  const restaurants = await Restaurant.find({ isSponsored: true })
    .select('name sponsoredUntil sponsorLabel isActive approvalStatus performance')
    .lean();
  res.json({
    success: true,
    data: restaurants.map((r) => ({
      restaurantId: r._id,
      name: r.name,
      sponsorLabel: r.sponsorLabel || 'Sponsored',
      sponsoredUntil: r.sponsoredUntil,
      active: !r.sponsoredUntil || new Date(r.sponsoredUntil) > now,
      performanceScore: Number(r.performance?.score) || 0,
    })),
  });
});
