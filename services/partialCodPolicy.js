'use strict';

// Money helpers for partial COD. Inputs and outputs are integer paise where
// practical to avoid binary floating-point drift.
function discountedFoodSubtotalPaise(subtotalRupees, discountRupees) {
  const subtotal = Math.round(Number(subtotalRupees || 0) * 100);
  const discount = Math.round(Number(discountRupees || 0) * 100);
  return Math.max(0, subtotal - discount);
}

function calculatePartialCod(subtotalRupees, discountRupees, grandTotalRupees, maxCodOrderAmount) {
  const foodPaise = discountedFoodSubtotalPaise(subtotalRupees, discountRupees);
  if (foodPaise <= 100000) return { required: false, advancePaise: 0, cashDuePaise: Math.round(Number(grandTotalRupees || 0) * 100), foodSubtotalPaise: foodPaise, allowed: Number.isFinite(Number(maxCodOrderAmount)) && Number(maxCodOrderAmount) > 0 ? Math.round(Number(grandTotalRupees || 0) * 100) <= Math.round(Number(maxCodOrderAmount) * 100) : true };
  // 10% advance, nearest paise with half-up rounding.
  const advancePaise = Math.floor((foodPaise + 5) / 10);
  const cashDuePaise = Math.max(0, Math.round(Number(grandTotalRupees || 0) * 100) - advancePaise);
  const cap = Number(maxCodOrderAmount);
  const allowed = !(Number.isFinite(cap) && cap > 0) || cashDuePaise <= Math.round(cap * 100);
  return { required: true, advancePaise, cashDuePaise, foodSubtotalPaise: foodPaise, allowed };
}

module.exports = { discountedFoodSubtotalPaise, calculatePartialCod };
