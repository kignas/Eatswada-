'use strict';

const DELIVERY_RULES = Object.freeze({
  under10: 30,
  from10to15: 40,
  above15: 50,
});

function calculateDeliveryFee(distanceKm) {
  const d = Number(distanceKm);
  if (!Number.isFinite(d) || d < 0) throw new Error('Invalid delivery distance');
  if (d < 10) return DELIVERY_RULES.under10;
  if (d <= 15) return DELIVERY_RULES.from10to15;
  return DELIVERY_RULES.above15;
}

module.exports = { DELIVERY_RULES, calculateDeliveryFee };
