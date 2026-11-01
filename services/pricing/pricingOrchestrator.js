'use strict';

// ─────────────────────────────────────────────────────────────────────
// Pricing orchestrator — the ONE authoritative backend service that
// coordinates every pricing calculation and returns a complete, consistent
// checkout quote.
//
// Order of operations (matches the required calculation sequence):
//   1. verified restaurant coordinates + customer address  (caller supplies)
//   2. restaurant -> customer road route                   (routeService)
//   3. customer delivery fee                               (deliveryFeeEngine)
//   4. rider pickup route + payout                         (riderPayoutEngine)
//   5. Eatswada delivery expenses
//   6. projected contribution                              (profitabilityEngine)
//   7. permitted adjustments: small-order fee, COD fee     (their engines)
//   8. eligible discount                                   (discountOptimizer)
//   9. approve / reprice / reject decision
//  10. complete quote + financial snapshot
//
// The orchestrator NEVER trusts a client-supplied total, fee, distance,
// commission or payout. Every input is either server-resolved or validated.
//
// All money is integer paise internally; rupee views are produced only for the
// API boundary.
// ─────────────────────────────────────────────────────────────────────

const money = require('./money');
const { computeFoodPrice } = require('./foodPriceEngine');
const { computeMinimumOrder, minimumOrderView } = require('./minimumOrderEngine');
const { computeDeliveryFee } = require('./deliveryFeeEngine');
const { computeRiderPayout, isPeakHourAt } = require('./riderPayoutEngine');
const { computeSmallOrderFee } = require('./smallOrderFeeEngine');
const { computeCodFee } = require('./codFeeEngine');
const { computeFreeDelivery, targetForBasket } = require('./freeDeliveryThresholdEngine');
const { computeContribution, requiredContributionPaise, DECISION } = require('./profitabilityEngine');

// Distance-specific minimum contribution allowed for a funded threshold-based
// free-delivery promotion. This does NOT replace the normal order contribution
// tiers; it is used only while underwriting this particular promotion.
function freeDeliveryContributionTargetPaise(distanceKm, rules) {
  const km = Math.max(0, Number(distanceKm) || 0);
  const bands = Array.isArray(rules?.freeDeliveryContributionByDistance)
    ? rules.freeDeliveryContributionByDistance : [];
  const match = bands.find((band) => km <= Number(band.maxKm));
  if (match) return toPaise(match.target);
  // Beyond configured bands, fail conservatively using the highest configured
  // target; never extend the cheapest nearby-customer subsidy tier.
  if (bands.length) return toPaise(bands[bands.length - 1].target);
  return requiredContributionPaise(0, rules?.contributionTiers || []);
}
const { optimiseDiscount } = require('./discountOptimizer');
const { resolveTripDistances } = require('./routeService');

const { toPaise, fromPaise, percentOfPaise } = money;

const DEFAULT_QUOTE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Local hour in the platform business timezone (Asia/Kolkata). */
function businessHour(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false,
    }).formatToParts(now);
    const hour = parts.find(p => p.type === 'hour');
    return hour ? Number(hour.value) : now.getHours();
  } catch (_) {
    return now.getHours();
  }
}

function sumItemsRupees(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, item) => {
    const qty = Math.max(0, Math.floor(Number(item?.quantity) || 0));
    const price = Math.max(0, Number(item?.unitPriceRupees ?? item?.price ?? 0) || 0);
    return sum + qty * price;
  }, 0);
}

/**
 * Build the authoritative quote for one restaurant's slice of a checkout.
 *
 * @returns {Promise<object>} the complete quote (see the returned `quote` shape)
 */
async function buildQuote({
  rules,
  restaurant = {},
  items = [],
  customerCoords = null,
  riderCoords = null,
  distances: distanceOverride = null,
  paymentMethod = 'upi',
  isFirstOrder = false,
  coupon = null,
  hasNextOrderNearby = false,
  waitingMinutes = 0,
  isRemoteZone = false,
  now = new Date(),
  routeFn = null,
  cacheKeyPrefix = '',
  quoteTtlMs = DEFAULT_QUOTE_TTL_MS,
  selfDeliveryAvailable = false,
  customerEligibleForDiscount = true,
  campaignBudgetRemainingPaise = null,
} = {}) {
  if (!rules || typeof rules !== 'object') {
    const err = new Error('Pricing rules are required.');
    err.statusCode = 500;
    throw err;
  }

  const isCod = String(paymentMethod || '').toLowerCase() === 'cod';
  const commissionable = restaurant.commissionable === true;
  const platformMaxDistanceKm = Number(rules.maxDeliveryDistanceKm) || 10;
  const restaurantRadiusKm = Number(restaurant.deliveryRadiusKm);
  const maxDistanceKm = Number.isFinite(restaurantRadiusKm) && restaurantRadiusKm > 0
    ? Math.min(platformMaxDistanceKm, restaurantRadiusKm)
    : platformMaxDistanceKm;

  // ── 1/2. Distances ─────────────────────────────────────────────────
  const restaurantCoords = restaurant?.location?.coordinates || restaurant?.coords || null;
  const distances = distanceOverride && Number.isFinite(Number(distanceOverride.restaurantToCustomerKm))
    ? {
        available: true,
        restaurantToCustomerKm: Number(distanceOverride.restaurantToCustomerKm),
        riderToRestaurantKm: Number.isFinite(Number(distanceOverride.riderToRestaurantKm))
          ? Number(distanceOverride.riderToRestaurantKm) : null,
        repositioningKm: Number.isFinite(Number(distanceOverride.repositioningKm))
          ? Number(distanceOverride.repositioningKm) : 0,
        restaurantToCustomerSec: Number(distanceOverride.restaurantToCustomerSec) || 0,
        riderToRestaurantSec: Number(distanceOverride.riderToRestaurantSec) || 0,
        sources: distanceOverride.sources || { restaurantToCustomer: 'provided' },
        degraded: distanceOverride.degraded === true,
      }
    : await resolveTripDistances({
        restaurantCoords,
        customerCoords,
        riderCoords,
        hasNextOrderNearby,
        routeFn,
        cacheKeyPrefix,
      });

  if (!distances.available) {
    return {
      serviceable: false,
      decision: DECISION.NOT_ECONOMICALLY_SERVICEABLE,
      reason: 'route_unavailable',
      message: 'We could not calculate a delivery route for this address. Please re-select your delivery location.',
      warnings: ['route_unavailable'],
    };
  }

  const deliveryKm = distances.restaurantToCustomerKm;

  // ── 3. Customer delivery fee (distance bands) ──────────────────────
  // A distance beyond the platform cap is a SERVICEABILITY answer, not an
  // exception: returning a rejected quote (the same shape as
  // `route_unavailable`) lets every caller — checkout, cards, admin previews —
  // render "delivery unavailable" instead of blowing up the request.
  let deliveryFee;
  try {
    deliveryFee = computeDeliveryFee({
      distanceKm: deliveryKm,
      bands: rules.deliveryFeeBands,
      maxDistanceKm,
    });
  } catch (err) {
    if (err && err.code === 'DELIVERY_RADIUS_EXCEEDED') {
      return {
        serviceable: false,
        decision: DECISION.NOT_ECONOMICALLY_SERVICEABLE,
        reason: 'out_of_delivery_radius',
        message: `This address is outside our ${maxDistanceKm} km delivery area.`,
        restaurantId: restaurant._id ? String(restaurant._id) : null,
        pricingVersion: rules.version,
        distance: {
          restaurantToCustomerKm: deliveryKm,
          riderToRestaurantKm: Number.isFinite(Number(distances.riderToRestaurantKm)) ? distances.riderToRestaurantKm : null,
          repositioningKm: Number(distances.repositioningKm) || 0,
          sources: distances.sources,
          degraded: distances.degraded === true,
        },
        warnings: ['out_of_delivery_radius'],
      };
    }
    throw err;
  }

  // ── 4. Rider payout (independent of the customer fee) ──────────────
  const peak = isPeakHourAt(businessHour(now), rules);
  const riderPayout = computeRiderPayout({
    deliveryKm,
    pickupKm: Number(distances.riderToRestaurantKm) || 0,
    repositioningKm: Number(distances.repositioningKm) || 0,
    waitingMinutes,
    isPeakHour: peak,
    isRemoteZone,
    rules,
  });

  // ── Food price (uplift model) ──────────────────────────────────────
  const baseSubtotalRupees = sumItemsRupees(items);
  const couponDiscountPaise = Math.max(0, Number(coupon?.discountPaise) || 0);
  const couponFundedBy = coupon ? String(coupon.fundedBy || 'platform') : 'none';
  const restaurantSharePercent = couponFundedBy === 'restaurant' ? 100
    : couponFundedBy === 'shared' ? Math.max(0, Math.min(100, Number(coupon.restaurantSharePercent) || 0))
    : 0;

  const food = computeFoodPrice({
    baseSubtotalRupees,
    upliftPercent: rules.foodPriceUpliftPercent,
    restaurantChargePercent: rules.restaurantChargePercent,
    // Coupons are applied explicitly in the bill and the contribution maths, so
    // the engine's food price stays the GROSS online price (never pre-discounted).
    discountRupees: 0,
    commissionable,
    // Stored menu prices already include the Eatswada uplift (see pricingRules).
    pricesIncludeUplift: rules.menuPricesIncludeUplift !== false,
  });

  // A restaurant still on the legacy commission plan earns Eatswada commission
  // instead of the food-price uplift. Counting BOTH would double-count the same
  // revenue, so exactly one applies: commission restaurants get no uplift (see
  // foodPriceEngine) and the commission is booked as platform revenue here.
  const commissionRate = Math.max(0, Math.min(100, Number(restaurant.commissionRate) || 0));
  const commissionPaise = commissionable ? percentOfPaise(food.baseSubtotalPaise, commissionRate) : 0;

  const restaurantFundedDiscountPaise = percentOfPaise(couponDiscountPaise, restaurantSharePercent);
  const platformFundedCouponPaise = Math.max(0, couponDiscountPaise - restaurantFundedDiscountPaise);

  /**
   * Contribution for a candidate set of adjustments at the ACTUAL basket.
   *
   * Revenue uses the GROSS online food price and the FULL delivery fee; every
   * discount and subsidy is then an explicit, separately-auditable expense line.
   * That keeps each line visible without counting any amount twice.
   */
  let thresholdFreeDeliveryTargetPaise = null;

  const contributionFor = ({
    couponPaise = couponDiscountPaise,
    subsidyPaise = 0,
    smallOrderPaise = 0,
    codPaise = 0,
    autoDiscountPaise = 0,
    gatewayChargeBasePaise = null,
  } = {}) => {
    const restaurantFunded = percentOfPaise(couponPaise, restaurantSharePercent);
    const platformCoupon = Math.max(0, couponPaise - restaurantFunded);
    // Cash the rider actually collects on a COD order (before the COD fee, which
    // is itself collected — using the pre-fee base avoids a circular solve).
    const codCashBasePaise = isCod
      ? food.grossFoodPricePaise + Math.max(0, deliveryFee.feePaise - subsidyPaise) + smallOrderPaise
      : null;
    return computeContribution({
      baseSubtotalPaise: food.baseSubtotalPaise,
      upliftPaise: food.upliftPaise,
      commissionPaise,
      customerFoodSubtotalPaise: food.grossFoodPricePaise,
      deliveryFeePaise: deliveryFee.feePaise,
      smallOrderFeePaise: smallOrderPaise,
      codFeePaise: codPaise,
      restaurantPayablePaise: Math.max(0, food.baseSubtotalPaise - restaurantFunded - commissionPaise),
      riderPayoutPaise: riderPayout.totalPaise,
      platformFundedDiscountPaise: platformCoupon + subsidyPaise + autoDiscountPaise,
      isCod,
      gatewayChargeBasePaise,
      codCashBasePaise,
      rules: (subsidyPaise > 0 && promotionFundingSource === 'platform_free_delivery_threshold'
        && Number.isFinite(thresholdFreeDeliveryTargetPaise))
        ? { ...rules, contributionTiers: [{ maxBasket: null, target: fromPaise(thresholdFreeDeliveryTargetPaise) }] }
        : rules,
    });
  };

  /**
   * Contribution at a HYPOTHETICAL gross food basket, using the SAME real cost
   * model (rider payout, gateway, tax, risk). Used by the free-delivery
   * threshold search so the threshold it publishes is one the real model can
   * actually fund — an uplift-only approximation would promise free delivery
   * the profitability engine would later refuse.
   *
   * @param {number} grossBasketPaise  gross online food price (base + uplift)
   * @param {number} subsidyPaise      subsidy already taken out of delivery revenue
   */
  const thresholdRiderPayout = computeRiderPayout({
    deliveryKm,
    pickupKm: Number(rules.freeDeliveryAssumedPickupKm) || 0,
    repositioningKm: Number(distances.repositioningKm) || 0,
    waitingMinutes: 0,
    isPeakHour: peak,
    isRemoteZone,
    rules,
  });

  // Distance-aware minimum order (same inputs the restaurant card uses, so the
  // card, menu, cart and checkout can never disagree).
  const minimumOrderResult = computeMinimumOrder({
    rules,
    deliveryFeePaise: deliveryFee.feePaise,
    riderPayoutPaise: thresholdRiderPayout.totalPaise,
    restaurantMinOrderRupees: restaurant.minOrder,
    commissionable,
    commissionRate,
  });

  const contributionAtGrossPaise = (grossBasketPaise, subsidyPaise = 0) => {
    const gross = Math.max(0, Math.round(Number(grossBasketPaise) || 0));
    const upliftFraction = Math.max(0, Number(rules.foodPriceUpliftPercent) || 0) / 100;
    // Derive the base amount back from the gross price under the active model.
    const basePaise = commissionable
      ? gross
      : Math.max(0, Math.round(gross / (1 + upliftFraction)));
    const upliftPaise = Math.max(0, gross - basePaise);
    const commissionAtBasket = commissionable ? percentOfPaise(basePaise, commissionRate) : 0;
    const subsidy = Math.max(0, Number(subsidyPaise) || 0);
    const codCashBasePaise = isCod
      ? gross + Math.max(0, deliveryFee.feePaise - subsidy)
      : null;
    return computeContribution({
      baseSubtotalPaise: basePaise,
      upliftPaise,
      commissionPaise: commissionAtBasket,
      customerFoodSubtotalPaise: gross,
      deliveryFeePaise: deliveryFee.feePaise,
      restaurantPayablePaise: Math.max(0, basePaise - commissionAtBasket),
      riderPayoutPaise: thresholdRiderPayout.totalPaise,
      platformFundedDiscountPaise: subsidy,
      isCod,
      codCashBasePaise,
      rules,
    });
  };

  // ── 5. Free-delivery subsidy ───────────────────────────────────────
  // The subsidy reduces delivery REVENUE (the delivery fee the customer pays);
  // it is not also booked as a cost, which would double-count it. It is granted
  // only when the threshold engine's funding test passes, so nothing is promised
  // that the contribution maths would not cover.
  const freeDeliveryBase = computeFreeDelivery({
    baseThresholdRupees: rules.freeDeliveryThreshold,
    deliveryFeePaise: deliveryFee.feePaise,
    subsidyPaise: deliveryFee.feePaise,
    currentSubtotalPaise: food.grossFoodPricePaise,
    upliftPercent: rules.foodPriceUpliftPercent,
    tiers: rules.contributionTiers,
    enabled: rules.freeDeliveryEnabled !== false,
    safetyReservePaise: toPaise(rules.discountSafetyReserve),
    // The real model (not an uplift-only approximation) decides the threshold
    // and the funding, so the published threshold is one the engine will honour.
    contributionAt: (basketPaise) => contributionAtGrossPaise(basketPaise, 0).contributionPaise,
    requiredAt: () => freeDeliveryContributionTargetPaise(deliveryKm, rules),
  });

  // First-order free delivery (one redemption, distance + subsidy capped).
  const firstOrderEligible = rules.firstOrderFreeDeliveryEnabled !== false
    && isFirstOrder === true
    && deliveryKm <= Number(rules.firstOrderFreeDeliveryMaxKm)
    && food.grossFoodPricePaise >= toPaise(rules.firstOrderFreeDeliveryMinBasket);


  let deliverySubsidyPaise = 0;
  let promotionFundingSource = 'none';
  thresholdFreeDeliveryTargetPaise = freeDeliveryContributionTargetPaise(deliveryKm, rules);

  // Free delivery is a THRESHOLD benefit: it is earned by the eligible basket
  // reaching the effective threshold, never granted to a basket that is merely
  // too small. A sub-threshold basket must pay its delivery fee (and any
  // permitted fees) — otherwise the subsidy would be handed to exactly the
  // small orders the contribution target exists to protect against, and the
  // answer would change between UPI and COD for no customer-visible reason.
  const noSubsidyContribution = contributionFor({ subsidyPaise: 0 });
  const freeDeliveryReached = freeDeliveryBase.reachedThreshold
    && freeDeliveryBase.subsidisedPaise > 0
    // Threshold promotions use the distance-specific promotion floor. Normal
    // order contribution targets remain unchanged for all non-promotion orders.
    && noSubsidyContribution.contributionPaise >= thresholdFreeDeliveryTargetPaise;

  if (firstOrderEligible) {
    const candidate = Math.min(deliveryFee.feePaise, toPaise(rules.firstOrderFreeDeliveryMaxSubsidy));
    // The first-order promotion is a platform expense; grant it only while the
    // order still meets its contribution target with the subsidy applied.
    if (candidate > 0 && contributionFor({ subsidyPaise: candidate }).meetsTarget) {
      deliverySubsidyPaise = candidate;
      promotionFundingSource = 'platform_first_order_free_delivery';
    }
  } else if (freeDeliveryReached) {
    deliverySubsidyPaise = freeDeliveryBase.subsidisedPaise;
    promotionFundingSource = 'platform_free_delivery_threshold';
  }

  // ── 6. Permitted adjustments ───────────────────────────────────────
  // The base contribution carries the granted subsidy, so the fee solve and the
  // decision are both computed against the SAME money the customer will pay.
  const baseContribution = contributionFor({ subsidyPaise: deliverySubsidyPaise });

  // The small-order fee is the customer paying the SHORTFALL, capped — never a
  // flat charge. Because the gateway takes a percentage of everything the
  // customer pays, adding the fee nudges the gateway cost up, so the fee is
  // solved iteratively. The COD handling fee is added afterwards, only for COD.
  const solvePermittedFees = (subsidyPaise) => {
    let smallPaise = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const shortfall = contributionFor({ subsidyPaise, smallOrderPaise: smallPaise }).shortfallPaise;
      const step = computeSmallOrderFee({
        shortfallPaise: shortfall,
        maxFeePaise: toPaise(rules.smallOrderFeeMax),
        enabled: rules.smallOrderFeeEnabled !== false,
      });
      const nextSmallPaise = Math.min(toPaise(rules.smallOrderFeeMax), smallPaise + step.feePaise);
      if (nextSmallPaise <= smallPaise) break;
      smallPaise = nextSmallPaise;
    }

    let contributionNow = contributionFor({ subsidyPaise, smallOrderPaise: smallPaise });
    let codPaise = 0;
    if (!contributionNow.meetsTarget && isCod) {
      const codFee = computeCodFee({
        isCod: true,
        cashBaseRupees: fromPaise(food.grossFoodPricePaise + Math.max(0, deliveryFee.feePaise - subsidyPaise) + smallPaise),
        percent: rules.codHandlingFeePercent,
        fixedRupees: rules.codHandlingFeeFixed,
        maxRupees: rules.codHandlingFeeMax,
        enabled: rules.codHandlingFeeEnabled !== false,
      });
      codPaise = codFee.feePaise;
      contributionNow = contributionFor({ subsidyPaise, smallOrderPaise: smallPaise, codPaise });
    }
    return { smallOrderFeePaise: smallPaise, codFeePaise: codPaise, contribution: contributionNow };
  };

  let smallOrderFeePaise = 0;
  let codFeePaise = 0;
  let contribution = baseContribution;

  if (!baseContribution.meetsTarget) {
    const solved = solvePermittedFees(deliverySubsidyPaise);
    smallOrderFeePaise = solved.smallOrderFeePaise;
    codFeePaise = solved.codFeePaise;
    contribution = solved.contribution;
  }

  // A delivery subsidy must never leave the order below its target: if the fee
  // path could not close the gap, give the subsidy back (and re-solve the fees
  // against the restored delivery revenue) rather than underwrite a free
  // delivery on a loss-making order.
  if (deliverySubsidyPaise > 0 && !contribution.meetsTarget) {
    deliverySubsidyPaise = 0;
    promotionFundingSource = 'none';
    const resolved = solvePermittedFees(0);
    smallOrderFeePaise = resolved.smallOrderFeePaise;
    codFeePaise = resolved.codFeePaise;
    contribution = resolved.contribution;
  }
  const repricingApplied = smallOrderFeePaise > 0 || codFeePaise > 0;

  // The effective delivery fee the customer pays is decided only AFTER the
  // subsidy give-back above, so the bill and the contribution always agree.
  const effectiveDeliveryFeePaise = Math.max(0, deliveryFee.feePaise - deliverySubsidyPaise);

  // ── 8. Decision ────────────────────────────────────────────────────
  let decision;
  let reason;
  if (contribution.meetsTarget) {
    decision = repricingApplied ? DECISION.REPRICING_REQUIRED : DECISION.PROFITABLE;
    reason = repricingApplied ? 'target_met_after_permitted_fees' : 'target_met';
  } else {
    decision = DECISION.NOT_ECONOMICALLY_SERVICEABLE;
    reason = 'target_unreachable_within_permitted_rules';
  }

  // Minimum order: the authoritative gate. A basket below the distance-aware
  // (or restaurant-contractual) minimum is not orderable, regardless of any
  // small-order fee that might otherwise have closed the gap.
  const minimumOrder = minimumOrderView(minimumOrderResult, food.grossFoodPricePaise);
  if (!minimumOrder.met) {
    decision = DECISION.NOT_ECONOMICALLY_SERVICEABLE;
    reason = minimumOrderResult.source === 'restaurant' ? 'below_restaurant_minimum_order' : 'below_minimum_order';
  }

  // ── 9. Discount optimiser ──────────────────────────────────────────
  // The optimiser works out the MOST Eatswada could afford to discount without
  // breaching the target. That figure is always REPORTED (so the admin/campaign
  // layer can act on it), but it is only folded into the customer's bill when
  // an admin explicitly enables `discountAutoApplyEnabled`. A large basket is
  // never discounted on its own — "do not automatically offer a discount simply
  // because a large basket exists".
  //
  // The optimiser also never STACKS on a coupon: when the customer has already
  // applied a coupon, the automatic discount is suppressed so the two cannot
  // compound (and so a coupon can never be gamed by pairing it with a basket
  // that would otherwise earn a second discount).
  let discount = {
    enabled: rules.discountOptimizerEnabled !== false,
    applied: false,
    recommendedDiscountPaise: 0,
    recommendedDiscountRupees: 0,
    maxTheoreticalDiscountPaise: 0,
    maxTheoreticalDiscountRupees: 0,
    reason: 'not_evaluated',
  };

  if (contribution.meetsTarget) {
    const candidate = optimiseDiscount({
      projectedContributionPaise: contribution.contributionPaise,
      requiredContributionPaise: contribution.requiredContributionPaise,
      rules,
      customerEligible: customerEligibleForDiscount,
      campaignBudgetRemainingPaise,
    });
    discount = { ...candidate, applied: false };
    if (candidate.recommendedDiscountPaise > 0 && couponDiscountPaise > 0) {
      discount = { ...discount, reason: 'coupon_already_applied', applied: false };
    } else if (candidate.recommendedDiscountPaise > 0 && rules.discountAutoApplyEnabled === true) {
      const verified = contributionFor({
        subsidyPaise: deliverySubsidyPaise,
        smallOrderPaise: smallOrderFeePaise,
        codPaise: codFeePaise,
        autoDiscountPaise: candidate.recommendedDiscountPaise,
      });
      if (!verified.meetsTarget) {
        discount = { ...discount, reason: 'discount_would_breach_target' };
      } else {
        discount = { ...discount, applied: true };
        contribution = verified;
      }
    } else if (candidate.recommendedDiscountPaise > 0) {
      discount = { ...discount, reason: 'auto_apply_disabled' };
    }
  }

  // The customer's food payable is the gross online food price less every
  // Eatswada-funded and coupon discount the order has been granted.
  const autoDiscountPaise = discount.applied ? discount.recommendedDiscountPaise : 0;
  const foodDiscountPaise = Math.min(
    food.grossFoodPricePaise,
    couponDiscountPaise + autoDiscountPaise
  );
  const customerFoodPayablePaise = Math.max(0, food.grossFoodPricePaise - foodDiscountPaise);

  const customerTotalPaise = customerFoodPayablePaise
    + effectiveDeliveryFeePaise
    + smallOrderFeePaise
    + codFeePaise;

  const warnings = [];
  if (distances.degraded) warnings.push('route_distance_estimated');
  if (deliverySubsidyPaise > 0) warnings.push('delivery_subsidised');

  const nowMs = now.getTime();
  const quote = {
    serviceable: decision !== DECISION.NOT_ECONOMICALLY_SERVICEABLE || selfDeliveryAvailable === true,
    decision,
    reason,
    message: minimumOrder.met ? undefined : minimumOrder.message,
    restaurantId: restaurant._id ? String(restaurant._id) : null,
    pricingVersion: rules.version,
    selfDeliveryAvailable: selfDeliveryAvailable === true,

    // ── Distance-aware minimum order (customer-facing) ──
    minimumOrder,

    // ── Route / distance snapshot ──
    distance: {
      restaurantToCustomerKm: deliveryKm,
      riderToRestaurantKm: Number.isFinite(Number(distances.riderToRestaurantKm)) ? distances.riderToRestaurantKm : null,
      repositioningKm: Number(distances.repositioningKm) || 0,
      totalTripKm: riderPayout.trip.totalKm,
      restaurantToCustomerSec: distances.restaurantToCustomerSec || 0,
      riderToRestaurantSec: distances.riderToRestaurantSec || 0,
      sources: distances.sources,
      degraded: distances.degraded === true,
      bandIndex: deliveryFee.bandIndex,
      band: deliveryFee.band,
    },

    // ── Customer-facing bill (rupees) ──
    bill: {
      baseFoodSubtotal: fromPaise(food.baseSubtotalPaise),
      foodUplift: fromPaise(food.upliftPaise),
      // GROSS online food price (before any discount).
      customerFoodSubtotal: fromPaise(food.grossFoodPricePaise),
      // Every discount the order was granted (coupon + automatic optimiser).
      discount: fromPaise(foodDiscountPaise),
      couponDiscount: fromPaise(couponDiscountPaise),
      autoDiscount: fromPaise(autoDiscountPaise),
      foodPayable: fromPaise(customerFoodPayablePaise),
      deliveryFee: fromPaise(effectiveDeliveryFeePaise),
      baseDeliveryFee: fromPaise(deliveryFee.feePaise),
      deliverySubsidy: fromPaise(deliverySubsidyPaise),
      smallOrderFee: fromPaise(smallOrderFeePaise),
      codFee: fromPaise(codFeePaise),
      total: fromPaise(customerTotalPaise),
      grandTotal: fromPaise(customerTotalPaise),
    },

    // ── Rider payout breakdown (rupees) ──
    riderPayout: {
      base: riderPayout.baseRupees,
      distance: riderPayout.distanceRupees,
      pickup: riderPayout.pickupRupees,
      repositioning: riderPayout.repositionRupees,
      waiting: riderPayout.waitRupees,
      peak: riderPayout.peakRupees,
      remoteZone: riderPayout.remoteRupees,
      floorApplied: riderPayout.floorApplied,
      guaranteedTotal: riderPayout.totalRupees,
      trip: riderPayout.trip,
      estimatedFuelExpenses: riderPayout.expenses.fuelRupees,
      estimatedMaintenance: riderPayout.expenses.maintenanceRupees,
      estimatedVehicleExpenses: riderPayout.expenses.totalExpensesRupees,
      estimatedNetEarnings: riderPayout.estimatedNetRupees,
    },

    // ── Eatswada contribution (rupees) ──
    contribution: {
      projected: contribution.contributionRupees,
      required: contribution.requiredContributionRupees,
      shortfall: contribution.shortfallRupees,
      meetsTarget: contribution.meetsTarget,
      grossRevenue: fromPaise(contribution.grossRevenuePaise),
      totalCosts: fromPaise(contribution.totalCostsPaise),
      foodPriceUplift: fromPaise(contribution.foodPriceUpliftPaise),
      commission: fromPaise(contribution.commissionPaise),
      restaurantPayable: fromPaise(contribution.restaurantPayablePaise),
      riderPayout: fromPaise(contribution.riderPayoutPaise),
      paymentGatewayFee: fromPaise(contribution.paymentGatewayFeePaise),
      taxOnUplift: fromPaise(contribution.taxOnUpliftPaise),
      codOperationalCost: fromPaise(contribution.codOperationalCostPaise || 0),
      platformFundedDiscount: fromPaise(contribution.platformFundedDiscountPaise),
      riskAllowance: fromPaise(contribution.riskAllowancePaise),
      promotionFundingSource,
    },

    // ── Discount optimiser output ──
    discount: {
      enabled: discount.enabled,
      maxTheoretical: discount.maxTheoreticalDiscountRupees,
      recommended: discount.recommendedDiscountRupees,
      reason: discount.reason,
    },

    // ── Free delivery (for restaurant cards / menu / cart) ──
    freeDelivery: {
      available: freeDeliveryBase.available,
      enabled: freeDeliveryBase.enabled,
      threshold: freeDeliveryBase.thresholdRupees,
      baseThreshold: freeDeliveryBase.baseThresholdRupees,
      raised: freeDeliveryBase.raised === true,
      eligibleSubtotal: freeDeliveryBase.eligibleSubtotalRupees,
      amountRemaining: freeDeliveryBase.amountRemainingRupees,
      // The authoritative answer for THIS order: the subsidy was only granted
      // when the contribution maths approved it.
      unlocked: deliverySubsidyPaise > 0,
      reachedThreshold: freeDeliveryBase.reachedThreshold === true,
      subsidised: fromPaise(deliverySubsidyPaise),
      deliveryFee: freeDeliveryBase.deliveryFeeRupees,
      effectiveDeliveryFee: fromPaise(effectiveDeliveryFeePaise),
      reason: deliverySubsidyPaise > 0 ? 'unlocked' : freeDeliveryBase.reason,
    },

    warnings,

    // ── Integer-paise snapshot (authoritative; used for persistence) ──
    paise: {
      baseSubtotalPaise: food.baseSubtotalPaise,
      upliftPaise: food.upliftPaise,
      restaurantChargePaise: food.restaurantChargePaise,
      grossFoodPricePaise: food.grossFoodPricePaise,
      customerFoodSubtotalPaise: food.grossFoodPricePaise,
      discountPaise: foodDiscountPaise,
      couponDiscountPaise,
      autoDiscountPaise,
      customerFoodPayablePaise,
      deliveryFeePaise: effectiveDeliveryFeePaise,
      baseDeliveryFeePaise: deliveryFee.feePaise,
      deliverySubsidyPaise,
      smallOrderFeePaise,
      codFeePaise,
      customerTotalPaise,
      restaurantPayablePaise: Math.max(0, food.baseSubtotalPaise - restaurantFundedDiscountPaise - commissionPaise),
      restaurantFundedDiscountPaise,
      platformFundedCouponPaise,
      riderPayoutPaise: riderPayout.totalPaise,
      riderExpensesPaise: riderPayout.expenses.totalExpensesPaise,
      riderPickupPaise: riderPayout.pickupPaise,
      riderDeliveryPaise: riderPayout.distancePaise,
      riderRepositionPaise: riderPayout.repositionPaise,
      riderWaitPaise: riderPayout.waitPaise,
      riderPeakPaise: riderPayout.peakPaise,
      paymentGatewayFeePaise: contribution.paymentGatewayFeePaise,
      taxOnUpliftPaise: contribution.taxOnUpliftPaise,
      riskAllowancePaise: contribution.riskAllowancePaise,
      contributionPaise: contribution.contributionPaise,
      requiredContributionPaise: contribution.requiredContributionPaise,
      grossRevenuePaise: contribution.grossRevenuePaise,
      totalCostsPaise: contribution.totalCostsPaise,
    },

    paymentMethod: isCod ? 'cod' : 'upi',
    isCod,
    isFirstOrder: isFirstOrder === true,
    quoteIssuedAt: new Date(nowMs).toISOString(),
    quoteExpiresAt: new Date(nowMs + Math.max(0, Number(quoteTtlMs) || 0)).toISOString(),
  };

  return quote;
}

/**
 * Restaurant-card / menu-page helper: the free-delivery + delivery-fee block
 * the customer frontend renders. Uses the SAME engines as checkout so the
 * card can never disagree with the bill.
 *
 * Returns the exact response shape required for restaurant cards.
 */
async function buildRestaurantCardPricing({
  rules,
  restaurant = {},
  customerCoords = null,
  eligibleSubtotalRupees = 0,
  isFirstOrder = false,
  now = new Date(),
  routeFn = null,
  cacheKeyPrefix = '',
} = {}) {
  const restaurantCoords = restaurant?.location?.coordinates || restaurant?.coords || null;
  const distances = await resolveTripDistances({
    restaurantCoords,
    customerCoords,
    hasNextOrderNearby: false,
    routeFn,
    cacheKeyPrefix,
  });

  const base = {
    restaurantId: restaurant._id ? String(restaurant._id) : null,
    pricingVersion: rules.version,
    serviceable: false,
    distanceKm: null,
    deliveryFee: null,
    freeDelivery: null,
  };

  if (!distances.available) {
    return { ...base, reason: 'route_unavailable' };
  }

  const deliveryKm = distances.restaurantToCustomerKm;
  const maxDistanceKm = Number(rules.maxDeliveryDistanceKm) || 10;
  const configuredRadius = Number(restaurant.deliveryRadiusKm);
  const effectiveRadius = Number.isFinite(configuredRadius) && configuredRadius > 0
    ? Math.min(configuredRadius, maxDistanceKm)
    : maxDistanceKm;

  if (deliveryKm > effectiveRadius) {
    return { ...base, distanceKm: deliveryKm, reason: 'out_of_radius', effectiveRadiusKm: effectiveRadius };
  }

  const deliveryFee = computeDeliveryFee({ distanceKm: deliveryKm, bands: rules.deliveryFeeBands, maxDistanceKm });
  const eligibleSubtotalPaise = toPaise(eligibleSubtotalRupees);

  // The card must quote the SAME unlock point the checkout will enforce, so it
  // uses the SAME real contribution model (rider payout, gateway fee, tax, risk
  // allowance) rather than an uplift-only approximation. An approximation would
  // let a card advertise "free delivery at ₹299" while checkout demanded a much
  // larger basket — the exact contradiction the spec forbids.
  const cardRiderPayout = computeRiderPayout({
    deliveryKm,
    pickupKm: Number(rules.freeDeliveryAssumedPickupKm) || 0,
    // No rider has been assigned for a restaurant card. Use the same
    // conservative pickup assumption as checkout quotes; do not invent a
    // full-distance repositioning leg that checkout will not necessarily use.
    repositioningKm: 0,
    waitingMinutes: 0,
    isPeakHour: isPeakHourAt(businessHour(now), rules),
    isRemoteZone: false,
    rules,
  });
  const upliftFraction = Math.max(0, Number(rules.foodPriceUpliftPercent) || 0) / 100;
  const contributionAtGross = (grossBasketPaise, subsidyPaise = 0) => {
    const gross = Math.max(0, Math.round(Number(grossBasketPaise) || 0));
    const basePaise = Math.max(0, Math.round(gross / (1 + upliftFraction)));
    return computeContribution({
      baseSubtotalPaise: basePaise,
      upliftPaise: Math.max(0, gross - basePaise),
      customerFoodSubtotalPaise: gross,
      deliveryFeePaise: deliveryFee.feePaise,
      restaurantPayablePaise: basePaise,
      riderPayoutPaise: cardRiderPayout.totalPaise,
      platformFundedDiscountPaise: Math.max(0, Number(subsidyPaise) || 0),
      isCod: false,
      rules,
    });
  };

  const minimumOrder = minimumOrderView(computeMinimumOrder({
    rules,
    deliveryFeePaise: deliveryFee.feePaise,
    riderPayoutPaise: cardRiderPayout.totalPaise,
    restaurantMinOrderRupees: restaurant.minOrder,
    commissionable: restaurant.commissionable === true,
    commissionRate: restaurant.commissionRate,
  }), eligibleSubtotalPaise);

  const freeDelivery = computeFreeDelivery({
    baseThresholdRupees: rules.freeDeliveryThreshold,
    deliveryFeePaise: deliveryFee.feePaise,
    subsidyPaise: deliveryFee.feePaise,
    currentSubtotalPaise: eligibleSubtotalPaise,
    upliftPercent: rules.foodPriceUpliftPercent,
    tiers: rules.contributionTiers,
    enabled: rules.freeDeliveryEnabled !== false,
    safetyReservePaise: toPaise(rules.discountSafetyReserve),
    contributionAt: (basketPaise) => contributionAtGross(basketPaise, 0).contributionPaise,
    requiredAt: () => freeDeliveryContributionTargetPaise(deliveryKm, rules),
  });

  const firstOrderEligible = rules.firstOrderFreeDeliveryEnabled !== false
    && isFirstOrder === true
    && deliveryKm <= Number(rules.firstOrderFreeDeliveryMaxKm)
    && eligibleSubtotalPaise >= toPaise(rules.firstOrderFreeDeliveryMinBasket);
  const firstOrderCandidatePaise = firstOrderEligible
    ? Math.min(deliveryFee.feePaise, toPaise(rules.firstOrderFreeDeliveryMaxSubsidy))
    : 0;
  // A card must never advertise a first-order subsidy that checkout's real
  // profitability calculation would reject. Keep the same contribution floor.
  const firstOrderSubsidyPaise = firstOrderCandidatePaise > 0
    && contributionAtGross(eligibleSubtotalPaise, firstOrderCandidatePaise).meetsTarget
    ? firstOrderCandidatePaise : 0;

  const subsidisedPaise = Math.max(freeDelivery.subsidisedPaise, firstOrderSubsidyPaise);

  return {
    restaurantId: base.restaurantId,
    pricingVersion: rules.version,
    serviceable: true,
    distanceKm: deliveryKm,
    distanceSource: distances.sources.restaurantToCustomer,
    distanceDegraded: distances.degraded === true,
    freeDelivery: {
      available: freeDelivery.available,
      threshold: freeDelivery.thresholdRupees,
      baseThreshold: freeDelivery.baseThresholdRupees,
      eligibleSubtotal: freeDelivery.eligibleSubtotalRupees,
      amountRemaining: freeDelivery.amountRemainingRupees,
      unlocked: subsidisedPaise > 0,
      firstOrderFreeDelivery: firstOrderEligible,
      reason: subsidisedPaise > 0 ? 'unlocked' : freeDelivery.reason,
      distanceKm: deliveryKm,
      riderPayoutEstimate: cardRiderPayout.totalRupees,
      riderVehicleExpenseEstimate: cardRiderPayout.expenses.totalExpensesRupees,
    },
    deliveryFee: deliveryFee.feeRupees,
    minimumOrder,
    effectiveDeliveryFee: fromPaise(Math.max(0, deliveryFee.feePaise - subsidisedPaise)),
    subsidised: fromPaise(subsidisedPaise),
  };
}

module.exports = {
  DECISION,
  freeDeliveryContributionTargetPaise,
  DEFAULT_QUOTE_TTL_MS,
  businessHour,
  sumItemsRupees,
  buildQuote,
  buildRestaurantCardPricing,
  requiredContributionPaise,
  targetForBasket,
};
