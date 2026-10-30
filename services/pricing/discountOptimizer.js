'use strict';

// ─────────────────────────────────────────────────────────────────────
// Discount optimiser.
//
// For a basket that generates more contribution than it needs, work out how
// much discount Eatswada could afford to fund WITHOUT breaching the minimum
// contribution target:
//
//   maximumDiscount = projectedContribution - requiredContribution - safetyReserve
//
// Hard rules enforced here:
//   • the discount can never take contribution below the required target;
//   • the rider's guaranteed payout is untouched;
//   • the restaurant's agreed settlement is untouched;
//   • only the PLATFORM-funded portion is offered automatically — a
//     restaurant-funded discount is a separate, contractually authorised
//     decision and is never invented by this engine;
//   • a discount is never offered merely because a basket is large: it must
//     be explicitly enabled and must respect the campaign budget, the min/max
//     discount window and the customer's eligibility.
//
// All arithmetic is integer paise.
// ─────────────────────────────────────────────────────────────────────

const { toPaise, fromPaise, clampPaise } = require('./money');

/**
 * @param {object} args
 * @param {number} args.projectedContributionPaise  contribution before any discount
 * @param {number} args.requiredContributionPaise   minimum target for this basket
 * @param {object} args.rules
 * @param {boolean} [args.customerEligible]         defaults to true
 * @param {number}  [args.campaignBudgetRemainingPaise] overrides the rule budget
 * @param {boolean} [args.restaurantFundedAvailable] informational only
 * @returns {object}
 */
function optimiseDiscount({
  projectedContributionPaise = 0,
  requiredContributionPaise = 0,
  rules = {},
  customerEligible = true,
  campaignBudgetRemainingPaise = null,
  restaurantFundedAvailable = false,
} = {}) {
  const contribution = Number(projectedContributionPaise) || 0;
  const required = Number(requiredContributionPaise) || 0;
  const reserve = Math.max(0, toPaise(rules.discountSafetyReserve));

  const base = {
    enabled: rules.discountOptimizerEnabled !== false,
    customerEligible: customerEligible !== false,
    projectedContributionPaise: contribution,
    requiredContributionPaise: required,
    safetyReservePaise: reserve,
    restaurantFundedAvailable: restaurantFundedAvailable === true,
    maxTheoreticalDiscountPaise: 0,
    maxTheoreticalDiscountRupees: 0,
    recommendedDiscountPaise: 0,
    recommendedDiscountRupees: 0,
    reason: '',
  };

  if (rules.discountOptimizerEnabled === false) return { ...base, reason: 'optimizer_disabled' };
  if (customerEligible === false) return { ...base, reason: 'customer_ineligible' };

  const headroomPaise = contribution - required - reserve;
  const maxTheoretical = Math.max(0, headroomPaise);
  base.maxTheoreticalDiscountPaise = maxTheoretical;
  base.maxTheoreticalDiscountRupees = fromPaise(maxTheoretical);

  if (maxTheoretical <= 0) {
    return { ...base, reason: 'no_headroom' };
  }

  const budget = campaignBudgetRemainingPaise === null || campaignBudgetRemainingPaise === undefined
    ? (rules.promotionBudgetRemaining === null || rules.promotionBudgetRemaining === undefined
        ? null
        : Math.max(0, toPaise(rules.promotionBudgetRemaining)))
    : Math.max(0, Number(campaignBudgetRemainingPaise) || 0);

  const minDiscountPaise = Math.max(0, toPaise(rules.discountMinAmount));
  const maxDiscountPaise = Math.max(0, toPaise(rules.discountMaxAmount));

  // Affordability ceiling: theoretical headroom, the configured maximum, and
  // (when a budget exists) what the campaign can still fund.
  let affordable = Math.min(maxTheoretical, maxDiscountPaise);
  if (budget !== null) affordable = Math.min(affordable, budget);

  if (affordable < minDiscountPaise) {
    return { ...base, reason: 'below_minimum_discount' };
  }
  if (affordable <= 0) {
    return { ...base, reason: 'budget_exhausted' };
  }

  const recommended = clampPaise(affordable, minDiscountPaise, maxDiscountPaise);
  // Never discount below the required target (belt and braces).
  const safeRecommended = Math.min(recommended, maxTheoretical);

  return {
    ...base,
    maxTheoreticalDiscountPaise: maxTheoretical,
    maxTheoreticalDiscountRupees: fromPaise(maxTheoretical),
    recommendedDiscountPaise: safeRecommended,
    recommendedDiscountRupees: fromPaise(safeRecommended),
    platformFundedDiscountPaise: safeRecommended,
    budgetLimited: budget !== null && budget < maxTheoretical,
    reason: safeRecommended > 0 ? 'discount_available' : 'no_headroom',
  };
}

module.exports = { optimiseDiscount };
