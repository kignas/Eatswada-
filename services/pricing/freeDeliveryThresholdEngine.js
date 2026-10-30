'use strict';

// ─────────────────────────────────────────────────────────────────────
// Free-delivery threshold engine.
//
// The admin threshold is the BASE configuration and is always preserved. The
// engine may RAISE the effective threshold when the delivery is not
// economically viable at the base threshold, but it never lowers it and it
// never promises free delivery the profitability engine will not fund.
//
// Given the rider delivery cost and Eatswada's available contribution, the
// engine finds the smallest basket at which the delivery subsidy can be
// covered while still meeting the minimum contribution target for that
// basket band. That basket becomes the dynamic threshold.
//
// This is a pure function so restaurant cards, menu pages, cart and checkout
// all call the same code with the same inputs.
// ─────────────────────────────────────────────────────────────────────

const { toPaise, fromPaise } = require('./money');

/** Contribution target for a food basket value (integer paise in, paise out). */
function targetForBasket(basketPaise, tiers = []) {
  const basket = Math.max(0, Number(basketPaise) || 0);
  const list = Array.isArray(tiers) ? tiers : [];
  for (const tier of list) {
    if (tier.maxBasket === null || tier.maxBasket === undefined) return toPaise(tier.target);
    if (basket <= toPaise(tier.maxBasket)) return toPaise(tier.target);
  }
  return list.length ? toPaise(list[list.length - 1].target) : 0;
}

/**
 * Smallest eligible basket at (or above) the base threshold whose REAL
 * contribution can fund the delivery subsidy and still meet its tier target.
 *
 * `contributionAt(basketPaise)` must return the contribution BEFORE the
 * subsidy is deducted (i.e. with the delivery fee fully earned). The search
 * subtracts the subsidy itself, so the caller never has to encode it twice.
 *
 * Returns `null` when no basket up to the cap can fund the subsidy.
 */
function minimumSubsidyBasket({
  baseThresholdPaise = 0,
  subsidyPaise = 0,
  requiredAt = (b) => targetForBasket(b, []),
  contributionAt,
  capPaise = null,
  stepPaise = 100,
} = {}) {
  if (typeof contributionAt !== 'function') return null;
  const subsidy = Math.max(0, Number(subsidyPaise) || 0);
  const start = Math.max(0, Math.round(Number(baseThresholdPaise) || 0));
  const cap = Number.isFinite(Number(capPaise)) && Number(capPaise) > 0
    ? Math.round(Number(capPaise))
    : Math.max(start * 20, 500000);
  const step = Math.max(100, Math.round(Number(stepPaise) || 100));

  const fundable = (basket) => {
    const contribution = Number(contributionAt(basket)) || 0;
    return contribution - subsidy >= (Number(requiredAt(basket)) || 0);
  };

  if (fundable(start)) return start;
  for (let basket = start + step; basket <= cap; basket += step) {
    if (fundable(basket)) {
      // Refine inside the last step so the threshold is exact to the rupee.
      for (let exact = basket - step + 100; exact < basket; exact += 100) {
        if (fundable(exact)) return exact;
      }
      return basket;
    }
  }
  return null;
}

/**
 * @param {object} args
 * @param {number}  args.baseThresholdRupees    admin-configured base threshold
 * @param {number}  args.deliveryFeePaise       the normal (paid) delivery fee
 * @param {number}  args.subsidyPaise           the delivery fee Eatswada would absorb
 * @param {number}  args.currentSubtotalPaise   current eligible cart subtotal
 * @param {number}  args.upliftPercent          food-price uplift (fallback model only)
 * @param {number}  args.availableContributionPaise projected contribution at the current basket
 * @param {Array}   args.tiers                  contribution tiers
 * @param {Function} [args.contributionAt]      REAL contribution lookup (preferred)
 * @param {Function} [args.requiredAt]          required target lookup for a basket
 * @param {boolean} [args.enabled]
 * @param {number}  [args.safetyReservePaise]
 * @returns {object} threshold/eligibility result
 */
function computeFreeDelivery({
  baseThresholdRupees = 0,
  deliveryFeePaise = 0,
  subsidyPaise = 0,
  currentSubtotalPaise = 0,
  upliftPercent = 0,
  availableContributionPaise = 0,
  requiredContributionPaise = null,
  tiers = [],
  enabled = true,
  safetyReservePaise = 0,
  contributionAt = null,
  requiredAt = null,
} = {}) {
  const baseThresholdPaise = Math.max(0, toPaise(baseThresholdRupees));
  const feePaise = Math.max(0, Number(deliveryFeePaise) || 0);
  const subsidy = Math.min(feePaise, Math.max(0, Number(subsidyPaise) || 0));
  const current = Math.max(0, Number(currentSubtotalPaise) || 0);

  const disabledResult = (reason, { available = true } = {}) => ({
    available,
    enabled: false,
    thresholdPaise: baseThresholdPaise,
    thresholdRupees: fromPaise(baseThresholdPaise),
    baseThresholdPaise,
    baseThresholdRupees: fromPaise(baseThresholdPaise),
    raised: false,
    eligibleSubtotalPaise: current,
    eligibleSubtotalRupees: fromPaise(current),
    amountRemainingPaise: available ? Math.max(0, baseThresholdPaise - current) : 0,
    amountRemainingRupees: fromPaise(available ? Math.max(0, baseThresholdPaise - current) : 0),
    // No subsidy is granted, so nothing is ever reported as unlocked.
    unlocked: false,
    reachedThreshold: available && current >= baseThresholdPaise,
    fundable: false,
    subsidisedPaise: 0,
    subsidisedRupees: 0,
    deliveryFeePaise: feePaise,
    deliveryFeeRupees: fromPaise(feePaise),
    effectiveDeliveryFeePaise: feePaise,
    effectiveDeliveryFeeRupees: fromPaise(feePaise),
    reason,
  });

  if (!enabled) return disabledResult('free_delivery_disabled', { available: false });
  if (subsidy <= 0 || feePaise <= 0) return disabledResult('no_delivery', { available: false });

  // Funding is decided against the ACTUAL contribution the caller reports, so
  // the same maths serves both a threshold search (no contribution known yet)
  // and a card/checkout check (contribution known). When the caller supplies a
  // required-contribution override we use it; otherwise the tier target applies.
  // How much extra food-price uplift does one additional rupee of basket
  // generate? That is what can pay for the delivery subsidy. It is only used
  // as a FALLBACK when the caller cannot supply the real contribution model.
  const upliftFraction = Math.max(0, Number(upliftPercent) || 0) / 100;
  const hasRealModel = typeof contributionAt === 'function';
  if (!hasRealModel && upliftFraction <= 0) {
    // Without an uplift and without a real model there is no food-price revenue
    // to fund the subsidy.
    return disabledResult('subsidy_not_fundable');
  }

  const requiredFor = (basketPaise) => {
    if (typeof requiredAt === 'function') return Math.max(0, Number(requiredAt(basketPaise)) || 0);
    if (Number.isFinite(Number(requiredContributionPaise)) && requiredContributionPaise !== null) {
      return Math.max(0, Number(requiredContributionPaise));
    }
    return targetForBasket(basketPaise, tiers);
  };

  const reserve = Math.max(0, Number(safetyReservePaise) || 0);
  let requiredBasketPaise = null;

  if (hasRealModel) {
    // Preferred: search the REAL contribution model (rider payout, gateway,
    // tax, risk allowance all included) so the threshold is never optimistic.
    requiredBasketPaise = minimumSubsidyBasket({
      baseThresholdPaise,
      subsidyPaise: subsidy + reserve,
      requiredAt: requiredFor,
      contributionAt,
    });
  } else {
    // Fallback: analytic solve within each tier (target is constant per tier).
    const list = Array.isArray(tiers) && tiers.length ? tiers : [{ maxBasket: null, target: 0 }];
    for (const tier of list) {
      const tierMaxPaise = tier.maxBasket === null || tier.maxBasket === undefined ? null : toPaise(tier.maxBasket);
      const tierTargetPaise = Math.max(0, Number(requiredContributionPaise) || toPaise(tier.target));
      const needed = subsidy + tierTargetPaise + reserve;
      const candidate = Math.ceil(needed / upliftFraction);
      if (candidate <= 0) continue;
      if (tierMaxPaise === null || candidate <= tierMaxPaise) {
        requiredBasketPaise = candidate;
        break;
      }
    }
  }

  // If no tier could fund the subsidy, free delivery is not offered at all.
  if (requiredBasketPaise === null) {
    return {
      ...disabledResult('subsidy_not_fundable'),
    };
  }

  // The effective threshold is never lower than the admin base threshold.
  const thresholdPaise = Math.max(baseThresholdPaise, requiredBasketPaise);
  const raised = thresholdPaise > baseThresholdPaise;
  const reachedThreshold = current >= thresholdPaise;

  // Funding test, in the same currency the contribution engine uses:
  //   contributionAt(basket) = uplift(basket) - required(basket) - reserve
  // The subsidy is granted only when the basket has reached the threshold AND
  // that contribution actually covers the subsidy. Nothing is promised that the
  // profitability engine would not approve.
  const contributionAtCurrent = Math.floor(current * upliftFraction)
    - requiredFor(current)
    - Math.max(0, Number(safetyReservePaise) || 0);
  const contributionAtThreshold = Math.floor(thresholdPaise * upliftFraction)
    - requiredFor(thresholdPaise)
    - Math.max(0, Number(safetyReservePaise) || 0);

  // Funding test. When the caller supplies the REAL contribution model the
  // answer is exact: fundable iff the current basket has reached the threshold
  // and its real contribution (with the subsidy already deducted) still meets
  // the target. The uplift-only approximation is used ONLY when no real model
  // is available.
  let fundable;
  if (hasRealModel) {
    const currentContribution = Number(contributionAt(current)) || 0;
    fundable = reachedThreshold && (currentContribution - subsidy) >= requiredFor(current);
  } else {
    const suppliedContribution = Number.isFinite(Number(availableContributionPaise))
      && Number(availableContributionPaise) !== 0
      ? Number(availableContributionPaise)
      : null;
    const suppliedRequired = Number.isFinite(Number(requiredContributionPaise))
      && requiredContributionPaise !== null
      ? Math.max(0, Number(requiredContributionPaise))
      : null;

    fundable = reachedThreshold
      && (suppliedContribution !== null && suppliedRequired !== null
        // Real contribution already has the subsidy applied as a cost.
        ? suppliedContribution >= suppliedRequired - 1
        : suppliedContribution !== null
          ? suppliedContribution >= subsidy - 1
          : contributionAtCurrent >= subsidy - 1);
  }

  const grantedSubsidyPaise = fundable ? subsidy : 0;

  return {
    available: true,
    enabled: true,
    thresholdPaise,
    thresholdRupees: fromPaise(thresholdPaise),
    baseThresholdPaise,
    baseThresholdRupees: fromPaise(baseThresholdPaise),
    raised,
    eligibleSubtotalPaise: current,
    eligibleSubtotalRupees: fromPaise(current),
    amountRemainingPaise: Math.max(0, thresholdPaise - current),
    amountRemainingRupees: fromPaise(Math.max(0, thresholdPaise - current)),
    unlocked: fundable,
    reachedThreshold,
    fundable,
    contributionAtCurrentPaise: contributionAtCurrent,
    contributionAtThresholdPaise: contributionAtThreshold,
    subsidisedPaise: grantedSubsidyPaise,
    subsidisedRupees: fromPaise(grantedSubsidyPaise),
    deliveryFeePaise: feePaise,
    deliveryFeeRupees: fromPaise(feePaise),
    effectiveDeliveryFeePaise: feePaise - grantedSubsidyPaise,
    effectiveDeliveryFeeRupees: fromPaise(feePaise - grantedSubsidyPaise),
    reason: fundable ? 'unlocked' : (reachedThreshold ? 'subsidy_not_fundable' : 'below_threshold'),
  };
}

module.exports = { computeFreeDelivery, targetForBasket, minimumSubsidyBasket };
