'use strict';

// ─────────────────────────────────────────────────────────────────────
// Quote service — persistence, expiry and verification of checkout quotes.
//
// A quote is the authoritative priced offer for one restaurant. It is stored
// so that:
//   • the checkout that follows a quote can be VERIFIED against it (the
//     client cannot re-price by editing the request);
//   • an expired quote cannot be paid for at a stale price;
//   • the order's immutable financial snapshot can be built from the exact
//     quote the customer saw.
//
// Quotes are deliberately short-lived (default 10 minutes). Verification
// compares the quote's authoritative totals against a freshly rebuilt quote;
// any material difference forces a re-quote rather than silently charging a
// different amount.
// ─────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const mongoose = require('mongoose');

const { buildQuote, DEFAULT_QUOTE_TTL_MS } = require('./pricingOrchestrator');

// Tolerance for re-verification: a 1-paisa rounding wobble is not a repricing.
const VERIFY_TOLERANCE_PAISE = 1;

/** Build + stamp a quote with a server-generated id. */
async function createQuote(args = {}) {
  const quote = await buildQuote({
    quoteTtlMs: args.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS,
    ...args,
  });
  if (quote && quote.serviceable !== false) {
    quote.quoteId = `q_${crypto.randomUUID()}`;
  }
  return quote;
}

/** True when the quote has no usable expiry or its expiry has passed. */
function isExpired(quote, now = new Date()) {
  if (!quote || !quote.quoteExpiresAt) return true;
  const expires = new Date(quote.quoteExpiresAt).getTime();
  if (!Number.isFinite(expires)) return true;
  return now.getTime() >= expires;
}

/**
 * Verify a stored quote against a freshly rebuilt one.
 *
 * @returns {{ok:boolean, reason?:string, quote?:object, deltaPaise?:number}}
 */
function verifyQuote(stored, fresh) {
  if (!stored) return { ok: false, reason: 'quote_missing' };
  if (!fresh || fresh.serviceable === false) return { ok: false, reason: 'not_serviceable' };
  if (isExpired(stored)) return { ok: false, reason: 'quote_expired' };
  if (String(stored.pricingVersion) !== String(fresh.pricingVersion)) {
    return { ok: false, reason: 'pricing_version_changed', storedVersion: stored.pricingVersion, freshVersion: fresh.pricingVersion };
  }

  const storedTotal = Number(stored?.paise?.customerTotalPaise);
  const freshTotal = Number(fresh?.paise?.customerTotalPaise);
  if (!Number.isFinite(storedTotal) || !Number.isFinite(freshTotal)) {
    return { ok: false, reason: 'quote_unverifiable' };
  }
  const deltaPaise = Math.abs(storedTotal - freshTotal);
  if (deltaPaise > VERIFY_TOLERANCE_PAISE) {
    return { ok: false, reason: 'price_changed', deltaPaise, fresh };
  }
  return { ok: true, quote: fresh, deltaPaise };
}

/** Persist the immutable financial snapshot for a confirmed order. */
async function persistSnapshot({ order, quote, rules, extras = {} } = {}) {
  if (!order?._id) return null;
  const OrderFinancialSnapshot = require('../../models/OrderFinancialSnapshot');
  const p = quote?.paise || {};

  const doc = {
    order: order._id,
    orderNumber: order.orderNumber || '',
    checkoutGroupId: order.checkoutGroupId || null,
    restaurant: order.restaurant || null,
    customer: order.user || null,
    rider: order.rider || null,
    paymentMethod: order.paymentMethod || 'upi',
    isCod: String(order.paymentMethod || '').toLowerCase() === 'cod',
    isFirstOrder: quote?.isFirstOrder === true,
    pricingRuleVersion: quote?.pricingVersion || rules?.version || '',
    rules: rules ? { ...rules } : {},
    route: {
      restaurantToCustomerKm: quote?.distance?.restaurantToCustomerKm ?? null,
      riderToRestaurantKm: quote?.distance?.riderToRestaurantKm ?? null,
      repositioningKm: quote?.distance?.repositioningKm ?? 0,
      totalTripKm: quote?.distance?.totalTripKm ?? 0,
      restaurantToCustomerSec: quote?.distance?.restaurantToCustomerSec ?? 0,
      riderToRestaurantSec: quote?.distance?.riderToRestaurantSec ?? 0,
      sources: quote?.distance?.sources || {},
      degraded: quote?.distance?.degraded === true,
    },
    projected: {
      baseFoodSubtotalPaise: p.baseSubtotalPaise || 0,
      customerFoodSubtotalPaise: p.customerFoodSubtotalPaise || 0,
      foodPriceUpliftPaise: p.upliftPaise || 0,
      restaurantPayablePaise: p.restaurantPayablePaise || 0,
      restaurantFundedDiscountPaise: p.restaurantFundedDiscountPaise || 0,
      platformFundedDiscountPaise: p.platformFundedCouponPaise || 0,
      deliveryFeePaise: p.deliveryFeePaise || 0,
      baseDeliveryFeePaise: p.baseDeliveryFeePaise || 0,
      deliverySubsidyPaise: p.deliverySubsidyPaise || 0,
      smallOrderFeePaise: p.smallOrderFeePaise || 0,
      codFeePaise: p.codFeePaise || 0,
      customerTotalPaise: p.customerTotalPaise || 0,
      riderGuaranteedPayoutPaise: p.riderPayoutPaise || 0,
      riderPickupPaise: p.riderPickupPaise || 0,
      riderDeliveryPaise: p.riderDeliveryPaise || 0,
      riderRepositionPaise: p.riderRepositionPaise || 0,
      riderWaitPaise: p.riderWaitPaise || 0,
      riderPeakPaise: p.riderPeakPaise || 0,
      estimatedRiderVehicleExpensesPaise: p.riderExpensesPaise || 0,
      paymentProcessingExpensesPaise: p.paymentGatewayFeePaise || 0,
      applicableTaxesPaise: p.taxOnUpliftPaise || 0,
      riskAllowancePaise: p.riskAllowancePaise || 0,
      grossRevenuePaise: p.grossRevenuePaise || 0,
      totalCostsPaise: p.totalCostsPaise || 0,
      expectedContributionPaise: p.contributionPaise || 0,
      minimumRequiredContributionPaise: p.requiredContributionPaise || 0,
    },
    promotionFundingSource: quote?.contribution?.promotionFundingSource || 'none',
    decision: quote?.decision || 'PROFITABLE',
    warnings: Array.isArray(quote?.warnings) ? quote.warnings : [],
    quoteIssuedAt: quote?.quoteIssuedAt ? new Date(quote.quoteIssuedAt) : null,
    quoteExpiresAt: quote?.quoteExpiresAt ? new Date(quote.quoteExpiresAt) : null,
    ...extras,
  };

  try {
    return await OrderFinancialSnapshot.findOneAndUpdate(
      { order: order._id },
      { $setOnInsert: doc },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    if (err?.code === 11000) return OrderFinancialSnapshot.findOne({ order: order._id });
    throw err;
  }
}

/**
 * Record ACTUAL post-delivery figures. Never touches `projected`.
 * Idempotent: repeated calls overwrite only the `actuals` block.
 */
async function recordActuals(orderId, actuals = {}) {
  const OrderFinancialSnapshot = require('../../models/OrderFinancialSnapshot');
  if (!mongoose.Types.ObjectId.isValid(String(orderId))) return null;
  const $set = { 'actuals.recordedAt': new Date() };
  if (Number.isFinite(Number(actuals.actualRiderPayoutPaise))) $set['actuals.actualRiderPayoutPaise'] = Math.round(Number(actuals.actualRiderPayoutPaise));
  if (Number.isFinite(Number(actuals.actualPaymentProcessingExpensesPaise))) $set['actuals.actualPaymentProcessingExpensesPaise'] = Math.round(Number(actuals.actualPaymentProcessingExpensesPaise));
  if (Number.isFinite(Number(actuals.actualRiderVehicleExpensesPaise))) $set['actuals.actualRiderVehicleExpensesPaise'] = Math.round(Number(actuals.actualRiderVehicleExpensesPaise));
  if (Number.isFinite(Number(actuals.actualContributionPaise))) $set['actuals.actualContributionPaise'] = Math.round(Number(actuals.actualContributionPaise));
  if (Number.isFinite(Number(actuals.refundPaise))) $set['actuals.refundPaise'] = Math.round(Number(actuals.refundPaise));
  if (Number.isFinite(Number(actuals.refundRiskRealisedPaise))) $set['actuals.refundRiskRealisedPaise'] = Math.round(Number(actuals.refundRiskRealisedPaise));
  if (actuals.notes !== undefined) $set['actuals.notes'] = String(actuals.notes || '').slice(0, 500);
  return OrderFinancialSnapshot.findOneAndUpdate(
    { order: orderId },
    { $set },
    { new: true }
  );
}

module.exports = {
  VERIFY_TOLERANCE_PAISE,
  createQuote,
  isExpired,
  verifyQuote,
  persistSnapshot,
  recordActuals,
};
