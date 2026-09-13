'use strict';
const assert = require('node:assert/strict');
const {
  MAX_DELIVERY_RADIUS_KM,
  calculateDeliveryFee,
  effectiveDeliveryRadiusKm,
} = require('../services/deliveryPricing');
const {
  BUSINESS_TIME_ZONE,
  isOpenByHours,
} = require('../services/restaurantHours');

assert.equal(MAX_DELIVERY_RADIUS_KM, 10);
assert.equal(calculateDeliveryFee(0), 30);
assert.equal(calculateDeliveryFee(9.99), 30);
assert.equal(calculateDeliveryFee(10), 30);
assert.throws(() => calculateDeliveryFee(10.01), err => err.code === 'DELIVERY_RADIUS_EXCEEDED');
assert.equal(effectiveDeliveryRadiusKm(15), 10);
assert.equal(effectiveDeliveryRadiusKm(8), 8);
assert.equal(effectiveDeliveryRadiusKm(undefined), 10);
assert.equal(BUSINESS_TIME_ZONE, 'Asia/Kolkata');

const overnight = {
  openingHours: {
    monday: { closed: false, opensAt: '18:00', closesAt: '02:00' },
    tuesday: { closed: true, opensAt: '10:00', closesAt: '22:00' },
  },
};
// 01:00 Tuesday IST = 19:30 Monday UTC during IST year-round.
assert.equal(isOpenByHours(overnight, new Date('2026-09-14T19:30:00Z')), true);
// 03:00 Tuesday IST is outside Monday's overnight window.
assert.equal(isOpenByHours(overnight, new Date('2026-09-14T21:30:00Z')), false);

console.log('Foundation 1 focused checks: PASS');
