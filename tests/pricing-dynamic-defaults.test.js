'use strict';
const assert = require('node:assert/strict');
const { ENGINE_DEFAULTS, buildRules } = require('../services/pricing/pricingRules');
const { computeFreeDelivery } = require('../services/pricing/freeDeliveryThresholdEngine');

assert.equal(ENGINE_DEFAULTS.pricingEngineEnabled, true, 'pricing engine must be enabled by default');
assert.equal(ENGINE_DEFAULTS.freeDeliveryThreshold, 0, 'no fixed ₹299 threshold');
assert.equal(buildRules().pricingEngineEnabled, true);
assert.equal(buildRules().freeDeliveryThreshold, 0);

function quoteFor(distanceKm, feePaise, riderPayoutPaise) {
  const contributionAt = (basketPaise) => {
    // Simplified deterministic economics for the regression: 30% markup
    // less rider payout, gateway/operating costs represented by 0 here.
    const base = Math.round(basketPaise / 1.3);
    const uplift = basketPaise - base;
    return uplift - riderPayoutPaise;
  };
  return computeFreeDelivery({
    baseThresholdRupees: 0,
    deliveryFeePaise: feePaise,
    subsidyPaise: feePaise,
    currentSubtotalPaise: 50000,
    tiers: [{ maxBasket: null, target: 20 }],
    enabled: true,
    contributionAt,
    requiredAt: () => 2000,
  });
}
const near = quoteFor(1, 800, 2500);
const far = quoteFor(10, 6600, 6000);
assert.equal(near.available, true);
assert.equal(far.available, true);
assert.ok(near.thresholdRupees <= far.thresholdRupees,
  'higher delivery subsidy/rider expense must not produce a lower free-delivery threshold');
console.log('pricing dynamic threshold defaults: passed');
