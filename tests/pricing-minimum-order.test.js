'use strict';

const assert = require('node:assert/strict');
const { ENGINE_DEFAULTS, buildRules } = require('../services/pricing/pricingRules');
const { computeMinimumOrder } = require('../services/pricing/minimumOrderEngine');
const { computeSmallOrderFee } = require('../services/pricing/smallOrderFeeEngine');
const { toPaise } = require('../services/pricing/money');

// Requested Eatswada launch policy.
assert.equal(ENGINE_DEFAULTS.foodPriceUpliftPercent, 30);
assert.equal(ENGINE_DEFAULTS.platformMinimumOrderRupees, 99);
assert.equal(ENGINE_DEFAULTS.smallOrderFeeMax, 8);
assert.deepEqual(ENGINE_DEFAULTS.contributionTiers, [
  { maxBasket: 299, target: 3 },
  { maxBasket: 399, target: 8 },
  { maxBasket: 499, target: 12 },
  { maxBasket: 699, target: 20 },
  { maxBasket: null, target: 20 },
]);

const rules = buildRules();
assert.equal(rules.platformMinimumOrderRupees, 99);
assert.equal(rules.smallOrderFeeMax, 8);

// A configured admin override remains authoritative; this patch does not
// silently erase admin-managed settings or versioned PricingRule documents.
const adminOverride = buildRules({
  platformMinimumOrderRupees: 125,
  smallOrderFeeMax: 6,
  foodPriceUpliftPercent: 30,
});
assert.equal(adminOverride.platformMinimumOrderRupees, 125);
assert.equal(adminOverride.smallOrderFeeMax, 6);

const near = computeMinimumOrder({
  rules,
  deliveryFeePaise: toPaise(8),
  riderPayoutPaise: toPaise(25),
  restaurantMinOrderRupees: 0,
});
const far = computeMinimumOrder({
  rules,
  deliveryFeePaise: toPaise(33),
  riderPayoutPaise: toPaise(60),
  restaurantMinOrderRupees: 0,
});
const restaurantContract = computeMinimumOrder({
  rules,
  deliveryFeePaise: toPaise(8),
  riderPayoutPaise: toPaise(25),
  restaurantMinOrderRupees: 249,
});
assert.ok(near.minimumRupees >= 99, 'platform minimum must never be below ₹99');
assert.ok(near.minimumRupees < 199, 'nearby small orders should not inherit the old higher basket target');
assert.ok(far.minimumRupees > near.minimumRupees, 'higher distance costs must raise the economic minimum');
assert.equal(restaurantContract.minimumRupees, 249, 'restaurant contractual minimum must be preserved');
assert.equal(restaurantContract.source, 'restaurant');

const fee = computeSmallOrderFee({ shortfallPaise: toPaise(3), maxFeePaise: toPaise(8), enabled: true });
assert.equal(fee.feeRupees, 3, 'small-order fee must charge only the required shortfall');
const cappedFee = computeSmallOrderFee({ shortfallPaise: toPaise(12), maxFeePaise: toPaise(8), enabled: true });
assert.equal(cappedFee.feeRupees, 8, 'small-order fee must never exceed ₹8');
assert.equal(cappedFee.closesGap, false, 'the fee engine must report an uncovered shortfall honestly');

console.log('PASS pricing minimum-order policy: ₹99 floor, ₹3 small-basket target, ₹8 fee cap, distance economics and restaurant minimum preserved');
