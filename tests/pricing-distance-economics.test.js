'use strict';

const assert = require('node:assert/strict');
const { buildRules } = require('../services/pricing/pricingRules');
const { buildRestaurantCardPricing } = require('../services/pricing/pricingOrchestrator');

async function quoteAtDistance(distanceKm, basketRupees = 200) {
  const rules = buildRules({
    pricingEngineEnabled: true,
    freeDeliveryEnabled: true,
    firstOrderFreeDeliveryEnabled: false,
    freeDeliveryThreshold: 299,
    riderBasePayout: 25,
    riderMinPayout: 25,
    riderPerKmPayout: 9,
    riderFreeFirstKm: 1,
    freeDeliveryAssumedPickupKm: 1,
  });
  return buildRestaurantCardPricing({
    rules,
    restaurant: { _id: 'distance-test', location: { coordinates: [77, 26] } },
    customerCoords: [77.01, 26],
    eligibleSubtotalRupees: basketRupees,
    routeFn: async () => ({ distanceMeters: distanceKm * 1000, durationSec: distanceKm * 240 }),
  });
}

(async () => {
  const near = await quoteAtDistance(1, 200);
  const far = await quoteAtDistance(10, 200);

  assert.equal(near.serviceable, true);
  assert.equal(far.serviceable, true);
  assert.equal(near.distanceKm, 1);
  assert.equal(far.distanceKm, 10);
  assert.equal(near.deliveryFee, 8);
  assert.equal(far.deliveryFee, 66);
  assert.ok(far.freeDelivery.threshold >= near.freeDelivery.threshold,
    '10 km threshold must not be lower than 1 km threshold');
  assert.ok(far.freeDelivery.threshold > near.freeDelivery.threshold,
    'higher rider/delivery costs at 10 km should raise the free-delivery threshold');

  const overRadius = await quoteAtDistance(10.5, 200);
  assert.equal(overRadius.serviceable, false);
  assert.equal(overRadius.reason, 'out_of_radius');

  console.log('PASS pricing distance economics: 1 km vs 10 km delivery fee, rider cost and free-delivery threshold');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
