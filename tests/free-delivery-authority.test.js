'use strict';

const assert = require('node:assert/strict');
const { buildRules } = require('../services/pricing/pricingRules');
const { buildRestaurantCardPricing } = require('../services/pricing/pricingOrchestrator');

(async () => {
  const rules = buildRules({
    pricingEngineEnabled: true,
    freeDeliveryEnabled: true,
    firstOrderFreeDeliveryEnabled: true,
    firstOrderFreeDeliveryMaxKm: 4,
    firstOrderFreeDeliveryMaxSubsidy: 22,
    firstOrderFreeDeliveryMinBasket: 0,
    platformMinimumOrderRupees: 99,
    contributionTiers: [{ maxBasket: 299, target: 3 }, { maxBasket: null, target: 20 }],
    riderMinPayout: 25,
    riderPerKmPayout: 10,
    riderBasePayout: 0,
    freeDeliveryAssumedPickupKm: 1,
  });

  const card = await buildRestaurantCardPricing({
    rules,
    restaurant: { _id: 'free-delivery-authority-test', location: { coordinates: [77, 26] } },
    customerCoords: [77.001, 26],
    eligibleSubtotalRupees: 99,
    isFirstOrder: true,
    routeFn: async () => ({ distanceMeters: 1000, durationSec: 240 }),
  });

  assert.equal(card.serviceable, true);
  assert.equal(card.freeDelivery.firstOrderEligible, true,
    'the customer may qualify for the first-order promotion conditions');
  assert.equal(card.freeDelivery.unlocked, false,
    'the card must not claim free delivery unless a subsidy was actually funded');
  assert.equal(card.freeDelivery.firstOrderFreeDelivery, false,
    'firstOrderFreeDelivery means applied, not merely eligible');
  assert.equal(card.subsidised, 0);
  assert.ok(card.effectiveDeliveryFee > 0,
    'the displayed delivery fee must remain payable when the subsidy is not funded');

  console.log('PASS free-delivery authority: eligibility is not misreported as an applied subsidy');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
