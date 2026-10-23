'use strict';

// ─────────────────────────────────────────────────────────────────────
// COD terms resolver (Pillar 3).
//
// One place decides how much of a Cash-on-Delivery order must be paid online
// as an advance and how much the rider collects at the door. Inputs:
//
//   • platform defaults  — codAdvanceThreshold / codAdvancePercent settings
//   • per-customer rule  — user.codPolicy (a repeat COD abuser can be put on
//                          a stricter policy, e.g. 50% online above ₹0)
//
// The default (10% above a ₹1,000 discounted food subtotal) reproduces the
// launch rule exactly, so existing behaviour and tests are unchanged.
//
// All money maths is done in integer paise with half-up rounding to avoid
// binary floating-point drift, matching services/partialCodPolicy.
// ─────────────────────────────────────────────────────────────────────

const { discountedFoodSubtotalPaise } = require('./partialCodPolicy');

const DEFAULT_ADVANCE_THRESHOLD_RUPEES = 1000;
const DEFAULT_ADVANCE_PERCENT = 10;
const MAX_ADVANCE_PERCENT = 100;

function toRupees(paise) {
  return Math.round(paise) / 100;
}

/** Half-up percentage of an integer-paise base. */
function percentOfPaise(basePaise, percent) {
  const p = Number(percent);
  if (!Number.isFinite(p) || p <= 0) return 0;
  const clamped = Math.min(MAX_ADVANCE_PERCENT, p);
  return Math.floor((basePaise * clamped + 50) / 100);
}

/**
 * Resolve the COD terms for one restaurant's order.
 *
 * @param {object}  args
 * @param {number}  args.subtotalRupees     food subtotal before discount
 * @param {number}  args.discountRupees     customer discount on this restaurant
 * @param {number}  args.grandTotalRupees   final payable for this restaurant
 * @param {object}  args.settings           merged platform settings
 * @param {object}  args.customer           lean user doc (codPolicy, isCodBlocked)
 * @returns {{
 *   required: boolean, advancePercent: number, thresholdRupees: number,
 *   foodSubtotalPaise: number, advancePaise: number, cashDuePaise: number,
 *   source: 'platform'|'customer'
 * }}
 */
function resolveCodTerms({ subtotalRupees, discountRupees, grandTotalRupees, settings = {}, customer = null } = {}) {
  const foodPaise = discountedFoodSubtotalPaise(subtotalRupees, discountRupees);
  const grandTotalPaise = Math.max(0, Math.round(Number(grandTotalRupees || 0) * 100));

  const customerThreshold = customer?.codPolicy?.advanceRequiredAbove;
  const customerPercent = customer?.codPolicy?.advancePercent;

  const platformThreshold = Number(settings.codAdvanceThreshold);
  const platformPercent = Number(settings.codAdvancePercent);

  const thresholdRupees = Number.isFinite(Number(customerThreshold))
    ? Math.max(0, Number(customerThreshold))
    : Number.isFinite(platformThreshold) && platformThreshold >= 0
      ? platformThreshold
      : DEFAULT_ADVANCE_THRESHOLD_RUPEES;

  const advancePercent = Number.isFinite(Number(customerPercent))
    ? Math.min(MAX_ADVANCE_PERCENT, Math.max(0, Number(customerPercent)))
    : Number.isFinite(platformPercent) && platformPercent > 0
      ? Math.min(MAX_ADVANCE_PERCENT, platformPercent)
      : DEFAULT_ADVANCE_PERCENT;

  const source = Number.isFinite(Number(customerThreshold)) || Number.isFinite(Number(customerPercent))
    ? 'customer'
    : 'platform';

  // Nothing is due online when the discounted food subtotal is at or below the
  // threshold, or when the resolved percentage is zero.
  const thresholdPaise = Math.round(thresholdRupees * 100);
  if (advancePercent <= 0 || foodPaise <= thresholdPaise) {
    return {
      required: false,
      advancePercent,
      thresholdRupees,
      foodSubtotalPaise: foodPaise,
      advancePaise: 0,
      cashDuePaise: grandTotalPaise,
      source,
    };
  }

  const advancePaise = Math.min(percentOfPaise(foodPaise, advancePercent), grandTotalPaise);
  return {
    required: advancePaise > 0,
    advancePercent,
    thresholdRupees,
    foodSubtotalPaise: foodPaise,
    advancePaise,
    cashDuePaise: Math.max(0, grandTotalPaise - advancePaise),
    source,
  };
}

/**
 * Decide whether a customer's COD counters should auto-block them. Pure so it
 * can be unit tested without a database. The caller persists the result.
 */
function shouldAutoBlockCod({ refusedDeliveries = 0, failedDeliveries = 0 } = {}, settings = {}) {
  if (settings.codAutoBlockEnabled !== true) return false;
  const limit = Number(settings.codMaxRefusalsBeforeAutoBlock);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  return Number(refusedDeliveries || 0) + Number(failedDeliveries || 0) >= limit;
}

module.exports = {
  DEFAULT_ADVANCE_THRESHOLD_RUPEES,
  DEFAULT_ADVANCE_PERCENT,
  toRupees,
  percentOfPaise,
  resolveCodTerms,
  shouldAutoBlockCod,
};
