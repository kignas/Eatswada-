'use strict';

// ─────────────────────────────────────────────────────────────────────
// Checkout integration for the dynamic pricing engine.
//
// Keeps controllers/orderController.js small: the controller resolves the
// verified restaurants, items and customer coordinates (which it already
// does) and hands them here. This module owns the engine-specific work:
//
//   • route distances via the central route service (never the client)
//   • one authoritative quote per restaurant
//   • the three-way acceptance decision
//   • the engine-shaped customer bill, commission snapshot and financial
//     snapshot payload
//
// When the engine is disabled the caller never reaches this module, so the
// legacy checkout path is untouched.
// ─────────────────────────────────────────────────────────────────────

const { resolveTripDistances } = require('./routeService');
const { buildQuote } = require('./pricingOrchestrator');
const { DECISION } = require('./profitabilityEngine');
const { fromPaise } = require('./money');

/** Extract [lng, lat] from a restaurant document, or null. */
function restaurantCoordsOf(restaurant) {
  const coords = restaurant?.location?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (lng === 0 && lat === 0) return null;
  return [lng, lat];
}

/**
 * Price every restaurant slice of a checkout with the dynamic engine.
 *
 * @param {object} args
 * @param {object} args.rules           resolved pricing rules
 * @param {Array}  args.priced          [{ restaurant, serverItems, subtotal, ... }] from the controller
 * @param {number[]} args.customerCoords verified customer [lng, lat]
 * @param {string} args.paymentMethod   'upi' | 'cod'
 * @param {boolean} args.isFirstOrder
 * @param {object} args.coupon          { discountPaise, fundedBy, restaurantSharePercent } | null
 * @param {Function} [args.routeFn]     injectable route provider (tests)
 * @returns {Promise<{quotes:Array, decisions:object, rejected:object|null}>}
 */
async function priceCheckoutWithEngine({
  rules,
  priced,
  customerCoords,
  paymentMethod = 'upi',
  isFirstOrder = false,
  coupon = null,
  now = new Date(),
  routeFn = null,
  campaignBudgetRemainingPaise = null,
  waitingMinutes = 0,
} = {}) {
  const isCod = String(paymentMethod || '').toLowerCase() === 'cod';

  // Resolve routes for every restaurant concurrently. Each restaurant gets its
  // own key prefix so the provider cache cannot cross-contaminate.
  const distanceSets = await Promise.all(priced.map((p, index) => resolveTripDistances({
    restaurantCoords: restaurantCoordsOf(p.restaurant),
    customerCoords,
    hasNextOrderNearby: false,
    routeFn,
    cacheKeyPrefix: `co:${p.restaurant?._id || index}`,
  })));

  // Distribute one coupon across restaurants by base subtotal using the same
  // largest-remainder allocation the legacy path uses, so the engine and the
  // legacy bill never disagree on a multi-restaurant discount.
  const { allocatePaise, toPaise } = require('./money');
  const weights = priced.map(p => Math.max(0, Number(p.subtotal) || 0));
  const discountShares = coupon && coupon.discountPaise > 0
    ? allocatePaise(Number(coupon.discountPaise) || 0, weights)
    : priced.map(() => 0);

  const quotes = [];
  let rejected = null;
  let anyRepricing = false;

  for (let i = 0; i < priced.length; i += 1) {
    const p = priced[i];
    const sharePaise = discountShares[i] || 0;
    const couponForRestaurant = coupon
      ? {
          discountPaise: sharePaise,
          fundedBy: coupon.fundedBy || 'platform',
          restaurantSharePercent: coupon.restaurantSharePercent || 0,
        }
      : null;

    const quote = await buildQuote({
      rules,
      restaurant: {
        _id: p.restaurant?._id,
        location: p.restaurant?.location,
        deliveryRadiusKm: p.restaurant?.deliveryRadiusKm,
        // Legacy commission is OPT-IN and explicitly gated. Restaurant
        // .commissionRate defaults to 15 for EVERY restaurant, so "rate > 0"
        // would silently put every restaurant on the commission model and the
        // food-price uplift would never apply. The uplift model is the default;
        // commission applies only when the admin has enabled the legacy model
        // AND the restaurant is actually on a legacy/custom commission plan.
        commissionable: rules.legacyCommissionModelEnabled === true
          && ['legacy', 'custom'].includes(String(p.restaurant?.commissionPlan || ''))
          && Number(p.restaurant?.commissionRate) > 0,
        commissionRate: p.restaurant?.commissionRate,
      },
      items: p.serverItems || [],
      customerCoords,
      distances: distanceSets[i],
      paymentMethod,
      isFirstOrder,
      coupon: couponForRestaurant,
      hasNextOrderNearby: false,
      waitingMinutes,
      now,
      routeFn,
      cacheKeyPrefix: `co:${p.restaurant?._id || i}`,
      campaignBudgetRemainingPaise,
    });

    quotes.push(quote);

    if (quote.decision === DECISION.NOT_ECONOMICALLY_SERVICEABLE) {
      rejected = rejected || {
        restaurantId: String(p.restaurant?._id || ''),
        restaurantName: p.restaurant?.name || '',
        quote,
      };
    }
    if (quote.decision === DECISION.REPRICING_REQUIRED) anyRepricing = true;
  }

  return {
    quotes,
    decisions: {
      anyRepricing,
      allProfitable: !rejected && !anyRepricing,
      anyRejected: Boolean(rejected),
    },
    rejected,
  };
}

/**
 * Build the itemized customer bill an Order stores, from an engine quote.
 *
 * Field names deliberately match the existing Pillar-2 bill shape so every
 * current consumer (receipt, admin console, tracking) keeps working; the
 * engine-only lines are added alongside.
 */
function billFromQuote(quote, { tipRupees = 0 } = {}) {
  const b = quote.bill || {};
  const tip = Math.max(0, Number(tipRupees) || 0);
  return {
    itemSubtotal: b.foodPayable ?? 0,
    packagingCharge: 0,
    deliveryFee: b.deliveryFee ?? 0,
    baseDeliveryFee: b.baseDeliveryFee ?? 0,
    isFreeDeliveryApplied: Number(b.deliverySubsidy || 0) > 0,
    platformHandlingFee: 0,
    smallCartFee: b.smallOrderFee ?? 0,
    rainSurgeFee: 0,
    discountAmount: b.discount ?? 0,
    taxAmount: 0,
    tipAmount: tip,
    grandTotal: Math.round(((b.grandTotal ?? 0) + tip) * 100) / 100,
    // ── Engine-only lines (additive) ──
    baseFoodSubtotal: b.baseFoodSubtotal ?? 0,
    foodUplift: b.foodUplift ?? 0,
    customerFoodSubtotal: b.customerFoodSubtotal ?? 0,
    deliverySubsidy: b.deliverySubsidy ?? 0,
    codFee: b.codFee ?? 0,
  };
}

/** Engine-shaped commission snapshot: zero commission, restaurant keeps base. */
function commissionFromQuote(quote) {
  const p = quote.paise || {};
  const base = Number(p.baseSubtotalPaise || 0);
  const payable = Number(p.restaurantPayablePaise || base);
  return {
    rate: 0,
    baseAmount: fromPaise(base),
    amount: 0,
    restaurantNetAmount: fromPaise(payable),
    calculatedAt: new Date(),
  };
}

module.exports = {
  priceCheckoutWithEngine,
  billFromQuote,
  commissionFromQuote,
  restaurantCoordsOf,
};
