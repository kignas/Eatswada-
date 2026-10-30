'use strict';

// ─────────────────────────────────────────────────────────────────────
// Dynamic pricing engine — public entry point.
//
// Consumers should require THIS module rather than reaching into individual
// engines, so the surface stays stable as the internals evolve.
// ─────────────────────────────────────────────────────────────────────

module.exports = {
  ...require('./money'),
  ...require('./pricingRules'),
  ...require('./routeService'),
  ...require('./foodPriceEngine'),
  ...require('./deliveryFeeEngine'),
  ...require('./riderPayoutEngine'),
  ...require('./smallOrderFeeEngine'),
  ...require('./codFeeEngine'),
  ...require('./freeDeliveryThresholdEngine'),
  ...require('./profitabilityEngine'),
  ...require('./discountOptimizer'),
  ...require('./pricingOrchestrator'),
  ...require('./quoteService'),
};
