'use strict';

// ─────────────────────────────────────────────────────────────────────
// Restaurant performance scoring (Restaurant Performance & Ranking Engine).
//
// Produces a 0–100 score from seven configurable factors over a rolling
// window:
//
//   ratings       20%   average visible review score
//   completion    20%   completed / (completed + cancelled)
//   preparation   15%   on-time preparation vs the restaurant's own promise
//   cancellation  15%   1 − cancellation rate (restaurant-fault weighted)
//   complaints    10%   complaints + refunds per order (lower is better)
//   repeat        10%   share of orders from returning customers
//   recent        10%   this week's completion performance vs the window
//
// Design decisions that matter:
//   • Minimum sample requirements: a factor with too little data is marked
//     `hasData:false`, contributes its NEUTRAL prior (0.5) instead of a
//     misleading 0 or 1, and is excluded from `dataConfidence`. A brand-new
//     restaurant therefore lands near the middle of the pack rather than at
//     the bottom (requirement: don't penalise new restaurants).
//   • Score normalisation: every raw metric is mapped to 0–1 against a
//     configurable target, so weights are comparable and retunable.
//   • Pure functions only — no database access — so the maths is unit-testable
//     and the aggregation lives in the refresh service.
// ─────────────────────────────────────────────────────────────────────

const FACTOR_KEYS = ['ratings', 'completion', 'preparation', 'cancellation', 'complaints', 'repeat', 'recent'];

const FACTOR_LABELS = {
  ratings: 'Customer ratings',
  completion: 'Order completion rate',
  preparation: 'Preparation time',
  cancellation: 'Cancellation rate',
  complaints: 'Complaints & refunds',
  repeat: 'Repeat customers',
  recent: 'Recent performance',
};

// Suggested initial weights (also the schema defaults on RankingConfig).
const DEFAULT_WEIGHTS = Object.freeze({
  ratings: 0.20,
  completion: 0.20,
  preparation: 0.15,
  cancellation: 0.15,
  complaints: 0.10,
  repeat: 0.10,
  recent: 0.10,
});

const DEFAULT_CONFIG = Object.freeze({
  weights: { ...DEFAULT_WEIGHTS },
  windowDays: 30,
  recentWindowDays: 7,
  minOrdersForFullConfidence: 20,
  minReviewsForFullConfidence: 5,
  targetPrepMinutes: 25,
  targetRating: 4.5,
  neutralRating: 4.0,
  sponsoredEnabled: true,
  maxSponsoredSlots: 3,
  sponsoredScoreBoost: 5,
});

const NEUTRAL = 0.5;
const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/**
 * Merge a stored/partial config over the defaults and normalise the weights to
 * sum to 1. Unknown keys are ignored; malformed numbers fall back to defaults
 * so the engine can never be wedged by a bad document.
 */
function resolveConfig(raw = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
  const weights = {};
  for (const key of FACTOR_KEYS) {
    const value = Number(raw?.weights?.[key]);
    weights[key] = Number.isFinite(value) && value >= 0 ? value : DEFAULT_WEIGHTS[key];
  }
  const sum = FACTOR_KEYS.reduce((acc, key) => acc + weights[key], 0);
  if (sum > 0) for (const key of FACTOR_KEYS) weights[key] = weights[key] / sum;

  return {
    weights,
    windowDays: Math.max(1, num(cfg.windowDays, DEFAULT_CONFIG.windowDays)),
    recentWindowDays: Math.max(1, num(cfg.recentWindowDays, DEFAULT_CONFIG.recentWindowDays)),
    minOrdersForFullConfidence: Math.max(1, num(cfg.minOrdersForFullConfidence, DEFAULT_CONFIG.minOrdersForFullConfidence)),
    minReviewsForFullConfidence: Math.max(1, num(cfg.minReviewsForFullConfidence, DEFAULT_CONFIG.minReviewsForFullConfidence)),
    targetPrepMinutes: Math.max(1, num(cfg.targetPrepMinutes, DEFAULT_CONFIG.targetPrepMinutes)),
    targetRating: Math.min(5, Math.max(1, num(cfg.targetRating, DEFAULT_CONFIG.targetRating))),
    neutralRating: Math.min(5, Math.max(1, num(cfg.neutralRating, DEFAULT_CONFIG.neutralRating))),
    sponsoredEnabled: cfg.sponsoredEnabled !== false,
    maxSponsoredSlots: Math.max(0, num(cfg.maxSponsoredSlots, DEFAULT_CONFIG.maxSponsoredSlots)),
    sponsoredScoreBoost: Math.max(0, num(cfg.sponsoredScoreBoost, DEFAULT_CONFIG.sponsoredScoreBoost)),
  };
}

/** Normalise a rating (1–5) so targetRating maps to 1 and 1 star maps to 0. */
function normaliseRating(rating, config) {
  const target = config.targetRating;
  if (!(target > 1)) return NEUTRAL;
  return clamp01((num(rating, config.neutralRating) - 1) / (target - 1));
}

/**
 * Preparation-time score. On-time deliveries score by how far under the
 * restaurant's own promised time they landed; late ones decay but never reach
 * exactly 0 (a slow day is not a dishonest day).
 */
function normalisePreparation({ avgPrepMinutes, avgPromisedMinutes, lateOrders, completed }, config) {
  const completedCount = num(completed, 0);
  if (completedCount <= 0) return NEUTRAL;
  const promised = num(avgPromisedMinutes, 0) > 0 ? num(avgPromisedMinutes) : config.targetPrepMinutes;
  const actual = num(avgPrepMinutes, promised);
  // ratio 1.0 at exactly the promise; <1 early, >1 late.
  const ratio = actual / promised;
  // Early/on-time: 1.0 → 0.75 across ratio 0.5→1.0. Late: decays to 0.2 by 2×.
  let score;
  if (ratio <= 1) score = 0.75 + 0.25 * clamp01((1 - ratio) / 0.5);
  else score = Math.max(0.2, 0.75 - 0.55 * clamp01((ratio - 1) / 1));
  // Penalise the late RATE as well, so one catastrophic order cannot be hidden
  // by a fast average.
  const lateRate = clamp01(num(lateOrders, 0) / completedCount);
  return clamp01(score * (1 - 0.3 * lateRate));
}

/** 1 − weighted cancellation rate, where restaurant-fault cancels count double. */
function normaliseCancellation({ completed, cancelled, restaurantFaultCancelled }, config) {
  const completedCount = num(completed, 0);
  const cancelledCount = num(cancelled, 0);
  const total = completedCount + cancelledCount;
  if (total <= 0) return NEUTRAL;
  const fault = Math.min(cancelledCount, num(restaurantFaultCancelled, 0));
  const weighted = (cancelledCount + fault) / total;
  return clamp01(1 - weighted);
}

/** Complaints + refunds per completed order; 0.1+ per order floors the score. */
function normaliseComplaints({ completed, complaints, refunds }, config) {
  const completedCount = num(completed, 0);
  if (completedCount <= 0) {
    const events = num(complaints, 0) + num(refunds, 0);
    return events > 0 ? 0.2 : NEUTRAL;
  }
  const rate = (num(complaints, 0) + num(refunds, 0)) / completedCount;
  return clamp01(1 - clamp01(rate / 0.1));
}

/**
 * Compute every factor for one restaurant's window sample and fold them into a
 * 0–100 score.
 *
 * @param {object} sample  Raw window aggregates (see models/RestaurantPerformance.sample).
 * @param {object} rawConfig
 */
function computePerformanceScore(sample = {}, rawConfig = {}) {
  const config = resolveConfig(rawConfig);

  const completed = num(sample.completed, 0);
  const cancelled = num(sample.cancelled, 0);
  const orders = num(sample.orders, completed + cancelled);
  const reviews = num(sample.reviews, 0);

  const completionRate = completed + cancelled > 0 ? completed / (completed + cancelled) : null;
  const ordersForConfidence = Math.max(completed + cancelled, orders);
  const ordersConfident = ordersForConfidence >= config.minOrdersForFullConfidence;
  const reviewsConfident = reviews >= config.minReviewsForFullConfidence;
  const hasHistory = completed + cancelled > 0;

  const raw = {
    ratings: sample.avgRating,
    completion: completionRate,
    preparation: {
      avgPrepMinutes: sample.avgPrepMinutes,
      avgPromisedMinutes: sample.avgPromisedMinutes,
      lateOrders: sample.lateOrders,
      completed,
    },
    cancellation: {
      completed,
      cancelled,
      restaurantFaultCancelled: sample.restaurantFaultCancelled,
    },
    complaints: { completed, complaints: sample.complaints, refunds: sample.refunds },
    repeat: { orders: ordersForConfidence, repeatOrders: sample.repeatOrders },
    recent: { completionRate: sample.recentCompletionRate, orders: sample.recentOrders },
  };

  const factors = {
    ratings: {
      normalised: reviews > 0 && sample.avgRating != null ? normaliseRating(sample.avgRating, config) : NEUTRAL,
      hasData: reviews > 0 && sample.avgRating != null,
    },
    completion: {
      normalised: completionRate == null ? NEUTRAL : clamp01(completionRate),
      hasData: ordersConfident && completionRate != null,
    },
    preparation: {
      normalised: normalisePreparation(raw.preparation, config),
      hasData: ordersConfident && completed > 0 && sample.avgPrepMinutes != null,
    },
    cancellation: {
      normalised: normaliseCancellation(raw.cancellation, config),
      hasData: ordersConfident,
    },
    complaints: {
      normalised: normaliseComplaints(raw.complaints, config),
      hasData: ordersConfident && hasHistory,
    },
    repeat: {
      normalised: num(sample.repeatOrders, 0) > 0 && ordersForConfidence > 0
        ? clamp01(num(sample.repeatOrders, 0) / ordersForConfidence)
        : NEUTRAL,
      hasData: ordersConfident && num(sample.repeatOrders, 0) > 0,
    },
    recent: {
      normalised: sample.recentCompletionRate == null ? NEUTRAL : clamp01(num(sample.recentCompletionRate)),
      hasData: num(sample.recentOrders, 0) >= Math.min(5, config.minOrdersForFullConfidence),
    },
  };

  let score = 0;
  let confidenceNumerator = 0;
  const breakdown = [];
  for (const key of FACTOR_KEYS) {
    const weight = config.weights[key];
    const factor = factors[key];
    score += weight * factor.normalised;
    if (factor.hasData) confidenceNumerator += weight;
    breakdown.push({
      key,
      label: FACTOR_LABELS[key],
      weight: Math.round(weight * 1000) / 1000,
      normalised: Math.round(factor.normalised * 1000) / 1000,
      raw: raw[key] ?? null,
      hasData: factor.hasData,
    });
  }

  const dataConfidence = Math.round(confidenceNumerator * 1000) / 1000;
  return {
    score: Math.round(score * 100 * 100) / 100,   // 0–100, two decimals
    dataConfidence,
    // "New" = not yet enough order history for the order-driven factors.
    isNewRestaurant: !ordersConfident,
    factors: breakdown,
    weights: config.weights,
    windowDays: config.windowDays,
  };
}

module.exports = {
  FACTOR_KEYS,
  FACTOR_LABELS,
  DEFAULT_WEIGHTS,
  DEFAULT_CONFIG,
  NEUTRAL,
  resolveConfig,
  normaliseRating,
  normalisePreparation,
  normaliseCancellation,
  normaliseComplaints,
  computePerformanceScore,
};
