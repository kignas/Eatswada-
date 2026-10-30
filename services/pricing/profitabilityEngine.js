'use strict';

// ─────────────────────────────────────────────────────────────────────
// Profitability engine — projected contribution per order.
//
// CONTRIBUTION DEFINITION (one consistent definition, no double counting):
//
//   contribution = gross platform revenue - known variable costs
//
// GROSS PLATFORM REVENUE (money Eatswada collects or earns):
//   • customer food price        (base + uplift, net of the customer discount)
//   • customer delivery fee      (the part the customer actually pays)
//   • small-order fee
//   • COD handling fee
//   • other authorised platform revenue
//
// KNOWN VARIABLE COSTS (money Eatswada pays out):
//   • restaurant base settlement (the restaurant's agreed menu amount)
//   • guaranteed rider payout
//   • rider incentives
//   • payment-gateway charges (including tax on those charges)
//   • tax on the platform service (GST on the food-price uplift)
//   • platform-funded promotion discount
//   • cancellation + refund risk allowance
//   • other measurable variable operating costs
//
// The restaurant base settlement appears here as a cost because Eatswada
// collects the full customer food price and remits the base. The uplift is
// therefore reported SEPARATELY as an informational line
// (`foodPriceUpliftPaise`) that is ALREADY included in the customer food price
// — adding it again would be the exact double-count the business model forbids.
//
// All arithmetic is integer paise.
// ─────────────────────────────────────────────────────────────────────

const { toPaise, fromPaise, percentOfPaise, roundHalfUp } = require('./money');

/** Minimum required contribution for a food basket value. */
function requiredContributionPaise(basketPaise, tiers = []) {
  const basket = Math.max(0, Number(basketPaise) || 0);
  const list = Array.isArray(tiers) && tiers.length ? tiers : [{ maxBasket: null, target: 0 }];
  for (const tier of list) {
    if (tier.maxBasket === null || tier.maxBasket === undefined) return Math.max(0, toPaise(tier.target));
    if (basket <= toPaise(tier.maxBasket)) return Math.max(0, toPaise(tier.target));
  }
  return Math.max(0, toPaise(list[list.length - 1].target));
}

/**
 * Compute the projected contribution of an order.
 *
 * @param {object} args
 * @param {number} args.baseSubtotalPaise        restaurant base menu amount
 * @param {number} args.upliftPaise              Eatswada food-price uplift
 * @param {number} args.customerFoodSubtotalPaise customer food price actually paid
 * @param {number} args.deliveryFeePaise         delivery fee the customer pays
 * @param {number} [args.smallOrderFeePaise]
 * @param {number} [args.codFeePaise]
 * @param {number} [args.otherRevenuePaise]
 * @param {number} [args.restaurantPayablePaise] base settlement owed (defaults to base)
 * @param {number} args.riderPayoutPaise
 * @param {number} [args.riderIncentivePaise]
 * @param {number} [args.platformFundedDiscountPaise]
 * @param {boolean} [args.isCod]
 * @param {object} args.rules
 * @returns {object} full breakdown + contribution + required target + shortfall
 */
function computeContribution({
  baseSubtotalPaise = 0,
  upliftPaise = 0,
  customerFoodSubtotalPaise = 0,
  deliveryFeePaise = 0,
  smallOrderFeePaise = 0,
  codFeePaise = 0,
  otherRevenuePaise = 0,
  restaurantPayablePaise = null,
  riderPayoutPaise = 0,
  riderIncentivePaise = 0,
  commissionPaise = 0,
  platformFundedDiscountPaise = 0,
  // The platform-funded discount ALREADY counted in `platformFundedDiscountPaise`.
  // Reported separately for the audit trail and never added again.
  platformFundedCouponPaise = 0,
  isCod = false,
  gatewayChargeBasePaise = null,
  codCashBasePaise = null,
  rules = {},
} = {}) {
  const customerFood = Math.max(0, Number(customerFoodSubtotalPaise) || 0);
  const delivery = Math.max(0, Number(deliveryFeePaise) || 0);
  const smallOrder = Math.max(0, Number(smallOrderFeePaise) || 0);
  const codFee = Math.max(0, Number(codFeePaise) || 0);
  const otherRevenue = Math.max(0, Number(otherRevenuePaise) || 0);
  const restaurantPayable = Math.max(0, Number.isFinite(Number(restaurantPayablePaise))
    ? Number(restaurantPayablePaise)
    : Number(baseSubtotalPaise) || 0);
  const riderPayout = Math.max(0, Number(riderPayoutPaise) || 0);
  const riderIncentive = Math.max(0, Number(riderIncentivePaise) || 0);
  const platformDiscount = Math.max(0, Number(platformFundedDiscountPaise) || 0);
  // Split of `platformDiscount` for the audit trail (informational only).
  const platformCoupon = Math.min(platformDiscount, Math.max(0, Number(platformFundedCouponPaise) || 0));

  const grossRevenuePaise = customerFood + delivery + smallOrder + codFee + otherRevenue + Math.max(0, Number(commissionPaise) || 0);

  // Payment-gateway charge applies to money actually moved through the
  // gateway. A pure COD order moves nothing online; a partial-COD advance is
  // passed in as `gatewayChargeBasePaise`. `null`/undefined means "not
  // supplied" — Number(null) is 0, which would silently zero the charge.
  const gatewayBaseSupplied = gatewayChargeBasePaise !== null && gatewayChargeBasePaise !== undefined;
  const gatewayChargeBase = gatewayBaseSupplied
    ? Math.max(0, Number(gatewayChargeBasePaise) || 0)
    : (isCod ? 0 : grossRevenuePaise);
  const gatewayVariable = percentOfPaise(gatewayChargeBase, rules.paymentGatewayFeePercent);
  const gatewayFixed = Math.max(0, toPaise(rules.paymentGatewayFeeFixed));
  const gatewayBase = gatewayVariable + gatewayFixed;
  const gatewayTax = percentOfPaise(gatewayBase, rules.paymentGatewayFeeTaxPercent);
  const gatewayFeePaise = gatewayBase + gatewayTax;

  // Tax on Eatswada's platform service (the food-price uplift).
  const taxOnUpliftPaise = percentOfPaise(Math.max(0, Number(upliftPaise) || 0), rules.gstOnUpliftPercent);

  // Refund / cancellation risk allowance on the exposure Eatswada carries.
  const riskBasePaise = customerFood + delivery;
  const riskAllowancePaise = percentOfPaise(riskBasePaise, rules.cancellationRiskPercent)
    + percentOfPaise(riskBasePaise, rules.refundRiskPercent);

  // COD operational cost: cash collection/reconciliation plus failed-delivery
  // risk on the cash the rider must collect. This is a REAL expense, which is
  // why a COD handling fee is justified rather than an arbitrary penalty.
  const codCashBase = isCod
    ? Math.max(0, Number.isFinite(Number(codCashBasePaise)) ? Number(codCashBasePaise) : (customerFood + delivery + smallOrder))
    : 0;
  const codOperationalCostPaise = isCod
    ? percentOfPaise(codCashBase, rules.codCashHandlingPercent)
      + toPaise(rules.codCashHandlingFixed)
      + percentOfPaise(codCashBase, rules.codFailedDeliveryRiskPercent)
    : 0;

  const totalCostsPaise = restaurantPayable
    + riderPayout
    + riderIncentive
    + gatewayFeePaise
    + taxOnUpliftPaise
    + platformDiscount
    + riskAllowancePaise
    + codOperationalCostPaise;

  const contributionPaise = grossRevenuePaise - totalCostsPaise;

  const basketPaise = Math.max(0, Number(customerFoodSubtotalPaise) || 0);
  const requiredPaise = requiredContributionPaise(basketPaise, rules.contributionTiers);
  const shortfallPaise = Math.max(0, requiredPaise - contributionPaise);

  return {
    // Revenue lines
    grossRevenuePaise,
    customerFoodSubtotalPaise: customerFood,
    deliveryFeePaise: delivery,
    smallOrderFeePaise: smallOrder,
    codFeePaise: codFee,
    otherRevenuePaise: otherRevenue,
    // Cost lines
    restaurantPayablePaise: restaurantPayable,
    riderPayoutPaise: riderPayout,
    riderIncentivePaise: riderIncentive,
    paymentGatewayFeePaise: gatewayFeePaise,
    paymentGatewayTaxPaise: gatewayTax,
    taxOnUpliftPaise,
    platformFundedDiscountPaise: platformDiscount,
    riskAllowancePaise,
    codOperationalCostPaise,
    totalCostsPaise,
    // Result
    contributionPaise,
    requiredContributionPaise: requiredPaise,
    shortfallPaise,
    meetsTarget: contributionPaise >= requiredPaise,
    // Informational: already included in customerFoodSubtotalPaise. Never add
    // this to revenue again.
    foodPriceUpliftPaise: Math.max(0, Number(upliftPaise) || 0),
    // Informational: already included in grossRevenuePaise (commission model).
    commissionPaise: Math.max(0, Number(commissionPaise) || 0),
    // Informational: the platform-funded coupon portion already counted inside
    // platformFundedDiscountPaise. Never add this to costs again.
    platformFundedCouponPaise: platformCoupon,
    // Rupee views
    contributionRupees: fromPaise(contributionPaise),
    requiredContributionRupees: fromPaise(requiredPaise),
    shortfallRupees: fromPaise(shortfallPaise),
  };
}

/**
 * The three order-acceptance decisions.
 *   PROFITABLE                  — meets the target, allow checkout
 *   REPRICING_REQUIRED          — target missed but permitted fees can close it
 *   NOT_ECONOMICALLY_SERVICEABLE— target cannot be met within permitted rules
 */
const DECISION = Object.freeze({
  PROFITABLE: 'PROFITABLE',
  REPRICING_REQUIRED: 'REPRICING_REQUIRED',
  NOT_ECONOMICALLY_SERVICEABLE: 'NOT_ECONOMICALLY_SERVICEABLE',
});

function decideOutcome({ contributionPaise, requiredPaise, canReprice }) {
  const contribution = Number(contributionPaise) || 0;
  const required = Number(requiredPaise) || 0;
  if (contribution >= required) return DECISION.PROFITABLE;
  return canReprice ? DECISION.REPRICING_REQUIRED : DECISION.NOT_ECONOMICALLY_SERVICEABLE;
}

module.exports = {
  DECISION,
  computeContribution,
  requiredContributionPaise,
  decideOutcome,
  roundHalfUp,
};
