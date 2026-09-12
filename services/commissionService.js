'use strict';

// Commission policy for P0.2. Keep this logic isolated so P0.3 (earnings) and
// P0.4 (settlements) can consume the exact same financial definitions.
const DEFAULT_COMMISSION_RATE = 15;

function roundCurrency(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizeCommissionRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return DEFAULT_COMMISSION_RATE;
  return roundCurrency(n);
}

/**
 * Calculate the restaurant/platform split for one order.
 *
 * Current policy:
 * - commission applies to food subtotal after any order-level discount;
 * - delivery fee is NOT commissionable;
 * - customer rider tip is NOT commissionable;
 * - the calculated values are intended to be snapshotted on Order at creation.
 *
 * Checkout currently has no active customer discount, so the discount term is
 * normally zero. When coupons arrive, their funding rules must explicitly feed
 * the correct discount into this function rather than silently changing the
 * historical calculation.
 */
function calculateRestaurantCommission({ subtotal, discount = 0, rate }) {
  const safeSubtotal = Math.max(0, Number(subtotal) || 0);
  const safeDiscount = Math.min(safeSubtotal, Math.max(0, Number(discount) || 0));
  const commissionableAmount = roundCurrency(safeSubtotal - safeDiscount);
  const commissionRate = normalizeCommissionRate(rate);
  const commissionAmount = roundCurrency(commissionableAmount * commissionRate / 100);
  const restaurantNetAmount = roundCurrency(commissionableAmount - commissionAmount);

  return {
    rate: commissionRate,
    baseAmount: commissionableAmount,
    amount: commissionAmount,
    restaurantNetAmount,
  };
}

module.exports = {
  DEFAULT_COMMISSION_RATE,
  normalizeCommissionRate,
  calculateRestaurantCommission,
  roundCurrency,
};
