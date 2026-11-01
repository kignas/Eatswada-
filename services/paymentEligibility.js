'use strict';

// ─────────────────────────────────────────────────────────────────────
// Payment-method eligibility (single, explainable verdict).
//
// POST /orders enforces these same gates one by one (controllers/
// orderController.js, "Cash on Delivery is ..." errors). This module computes
// the SAME verdict without throwing, with a machine `code` and a plain-English
// `reason` for every gate, so the cart can show the true answer (and the true
// reason) instead of guessing from several client-side sources.
//
// Pure: pass in already-loaded data. No DB access here.
// ─────────────────────────────────────────────────────────────────────

const { resolveCodTerms } = require('./codPolicyService');

/**
 * @param {object} a
 * @param {object} a.settings        merged platform settings (getPlatformSettings)
 * @param {object} [a.customer]      { isCodBlocked, codPolicy }
 * @param {Array}  a.restaurants     [{ codEnabled }] one entry per restaurant in the checkout
 * @param {number} a.totalRupees     checkout grand total (customer pays)
 * @param {number} [a.foodSubtotalRupees]
 * @param {number} [a.discountRupees]
 */
function evaluatePaymentOptions({
  settings = {}, customer = null, restaurants = [], totalRupees = 0,
  foodSubtotalRupees = 0, discountRupees = 0,
} = {}) {
  const upiOn = settings.isUpiEnabled !== false;
  const codOn = settings.isCodEnabled === true;

  const gates = [];
  const gate = (name, ok, code, reason) => gates.push({ name, ok, code: ok ? null : code, reason: ok ? '' : reason });

  gate('platform_cod_enabled', codOn, 'COD_PLATFORM_OFF', 'Cash on Delivery is switched off for the whole platform.');
  gate('customer_not_cod_blocked', customer?.isCodBlocked !== true, 'COD_CUSTOMER_BLOCKED', 'Cash on Delivery is not available for this account.');
  gate('single_restaurant', restaurants.length <= 1, 'COD_MULTI_RESTAURANT', 'Cash on Delivery works for one restaurant per order.');
  const unknown = restaurants.some(r => r?.codEnabled === undefined || r?.codEnabled === null);
  gate('restaurant_cod_enabled',
    restaurants.length > 0 && restaurants.every(r => r?.codEnabled === true),
    unknown ? 'COD_RESTAURANT_UNKNOWN' : 'COD_RESTAURANT_OFF',
    unknown ? 'Could not confirm Cash on Delivery for this restaurant.' : 'This restaurant has not enabled Cash on Delivery.');

  // Cash the rider must carry (after any online advance) must fit the cap.
  let terms = { required: false, advancePaise: 0, cashDuePaise: Math.round(Number(totalRupees || 0) * 100) };
  if (restaurants.length === 1) {
    terms = resolveCodTerms({
      subtotalRupees: foodSubtotalRupees, discountRupees, grandTotalRupees: totalRupees, settings, customer,
    });
  }
  const cashDue = terms.cashDuePaise / 100;
  const maxCod = Number(settings.maxCodOrderAmount);
  const withinCap = !(Number.isFinite(maxCod) && maxCod > 0 && cashDue > maxCod);
  gate('within_cod_cap', withinCap, 'COD_OVER_CAP', `Cash due at the door must be at most ₹${maxCod}.`);

  const failed = gates.find(g => !g.ok) || null;
  return {
    upi: { ok: upiOn, code: upiOn ? null : 'UPI_PLATFORM_OFF', reason: upiOn ? '' : 'Online payment is switched off.' },
    cod: {
      ok: !failed,
      code: failed ? failed.code : null,
      reason: failed ? failed.reason : '',
      advanceRequired: terms.required === true,
      advanceAmount: terms.advancePaise / 100,
      cashDue,
    },
    gates,
  };
}

module.exports = { evaluatePaymentOptions };
