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

// ── Signed quote ids ────────────────────────────────────────────────
// Quotes are not stored. A customer quote's id is a signed, self-describing
// token (HMAC-SHA256) that binds the quote to ONE customer, restaurant and
// payment method, with its pricing version, total and expiry. POST /orders
// verifies it (checkQuoteForOrder) so the customer is never charged a price
// they were not shown, and an expired quote cannot be honoured.
//
//   q2.<base64url(JSON payload)>.<base64url(HMAC)>
//
// The key is derived from QUOTE_SIGNING_SECRET (preferred) or JWT_SECRET with
// a domain-separation label, so a quote token can never be confused with a
// login token. Without a secret, issuing FAILS CLOSED and verifying rejects.
const QUOTE_TOKEN_PREFIX = 'q2';
const QUOTE_TOKEN_MAX_LENGTH = 2000;
const SIGNING_LABEL = 'eatswada-quote-v1:';

function signingKey() {
  const secret = process.env.QUOTE_SIGNING_SECRET || process.env.JWT_SECRET;
  if (!secret) return null;
  return crypto.createHash('sha256').update(SIGNING_LABEL + secret).digest();
}

const normaliseMethod = (m) => (String(m || 'upi').toLowerCase() === 'cod' ? 'cod' : 'upi');

function signQuoteToken(quote, { userId, restaurantId, paymentMethod } = {}) {
  const key = signingKey();
  if (!key) {
    const err = new Error('Quote signing secret is not configured.');
    err.statusCode = 500;
    throw err;
  }
  const exp = new Date(quote?.quoteExpiresAt).getTime();
  const total = Number(quote?.paise?.customerTotalPaise);
  if (!Number.isFinite(exp) || !Number.isFinite(total)) {
    const err = new Error('Quote cannot be signed: missing expiry or total.');
    err.statusCode = 500;
    throw err;
  }
  const payload = {
    v: 1,
    u: String(userId),
    r: String(restaurantId),
    pm: normaliseMethod(paymentMethod),
    pv: String(quote.pricingVersion),
    t: Math.round(total),
    iat: new Date(quote.quoteIssuedAt).getTime() || Date.now(),
    exp,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(`${QUOTE_TOKEN_PREFIX}.${body}`).digest('base64url');
  return `${QUOTE_TOKEN_PREFIX}.${body}.${sig}`;
}

/** Parse + signature-check a token. Returns the payload or null. */
function readQuoteToken(token) {
  if (typeof token !== 'string' || !token || token.length > QUOTE_TOKEN_MAX_LENGTH) return null;
  const key = signingKey();
  if (!key) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== QUOTE_TOKEN_PREFIX || !parts[1] || !parts[2]) return null;
  const expected = crypto.createHmac('sha256', key).update(`${parts[0]}.${parts[1]}`).digest();
  let given;
  try { given = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload || payload.v !== 1) return null;
    if (![payload.t, payload.exp].every(Number.isFinite)) return null;
    return payload;
  } catch { return null; }
}

/** Build + stamp a quote with a server-generated id. */
async function createQuote(args = {}) {
  const quote = await buildQuote({
    quoteTtlMs: args.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS,
    ...args,
  });
  if (quote && quote.serviceable !== false) {
    quote.quoteId = args.userId
      // Customer-facing quote: signed and bound to this customer.
      ? signQuoteToken(quote, {
          userId: args.userId,
          restaurantId: quote.restaurantId || args.restaurant?._id,
          paymentMethod: args.paymentMethod,
        })
      // Admin previews / internal callers: an opaque id, never accepted by checkout.
      : `q_${crypto.randomUUID()}`;
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

const QUOTE_REJECTIONS = {
  QUOTE_EXPIRED: 'Your price has expired. Please review the updated bill and try again.',
  QUOTE_PRICE_CHANGED: 'The price changed since it was shown. Please review the updated bill.',
  QUOTE_MISMATCH: 'This price quote does not match your order. Please refresh your cart and try again.',
};
const reject = (code, reason) => ({ ok: false, code, reason, message: QUOTE_REJECTIONS[code] });

/**
 * Check a customer-supplied quoteId against the order being placed.
 *
 * `freshQuote` is the engine quote just rebuilt from server data for THIS
 * order, so the amount the customer will be charged is always the fresh one;
 * this check only decides whether that is still what they were shown.
 *
 * When the order carries a coupon the quote endpoint did not price that
 * coupon, so the total is not compared (signature, owner, restaurant, payment
 * method, expiry and pricing version still are).
 *
 * @returns {{ok:true}|{ok:false,code:string,reason:string,message:string}}
 */
function checkQuoteForOrder({ quoteId, userId, restaurantId, paymentMethod, freshQuote, hasCoupon = false, now = new Date() } = {}) {
  const t = readQuoteToken(quoteId);
  if (!t) return reject('QUOTE_MISMATCH', 'quote_invalid');
  if (t.u !== String(userId)) return reject('QUOTE_MISMATCH', 'quote_wrong_customer');
  if (t.r !== String(restaurantId)) return reject('QUOTE_MISMATCH', 'quote_wrong_restaurant');
  if (t.pm !== normaliseMethod(paymentMethod)) return reject('QUOTE_MISMATCH', 'quote_wrong_payment_method');
  if (now.getTime() >= t.exp) return reject('QUOTE_EXPIRED', 'quote_expired');
  if (!freshQuote || freshQuote.serviceable === false) return reject('QUOTE_PRICE_CHANGED', 'not_serviceable');
  if (String(t.pv) !== String(freshQuote.pricingVersion)) return reject('QUOTE_PRICE_CHANGED', 'pricing_version_changed');
  if (!hasCoupon) {
    const freshTotal = Number(freshQuote?.paise?.customerTotalPaise);
    if (!Number.isFinite(freshTotal)) return reject('QUOTE_PRICE_CHANGED', 'quote_unverifiable');
    if (Math.abs(t.t - freshTotal) > VERIFY_TOLERANCE_PAISE) return reject('QUOTE_PRICE_CHANGED', 'price_changed');
  }
  return { ok: true };
}

module.exports = {
  VERIFY_TOLERANCE_PAISE,
  createQuote,
  isExpired,
  verifyQuote,
  checkQuoteForOrder,
  readQuoteToken,
  persistSnapshot,
  recordActuals,
};
