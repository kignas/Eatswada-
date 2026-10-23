'use strict';
const assert = require('node:assert/strict');
const { calculatePartialCod, discountedFoodSubtotalPaise } = require('../services/partialCodPolicy');

assert.equal(discountedFoodSubtotalPaise(1200, 100), 110000);
assert.deepEqual(calculatePartialCod(1000, 0, 1030, 1000), {
  required: false, advancePaise: 0, cashDuePaise: 103000, foodSubtotalPaise: 100000, allowed: false,
});
assert.deepEqual(calculatePartialCod(1000.01, 0, 1030.01, 1000), {
  required: true, advancePaise: 10000, cashDuePaise: 93001, foodSubtotalPaise: 100001, allowed: true,
});
// Half-up paise rounding: 10% of ₹1000.05 food subtotal = ₹100.005 -> ₹100.01.
assert.equal(calculatePartialCod(1000.05, 0, 1030.05, 1000).advancePaise, 10001);
assert.equal(calculatePartialCod(1200, 100, 1030, 1000).advancePaise, 11000);
assert.equal(calculatePartialCod(1500, 0, 1540, 1000).allowed, false);
assert.equal(calculatePartialCod(1500, 0, 1540, 1500).allowed, true);
console.log('partial COD policy unit tests passed');
