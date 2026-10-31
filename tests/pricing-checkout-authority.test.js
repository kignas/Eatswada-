'use strict';

// Regression contract: with the engine enabled, legacy pre-engine checks and
// fee calculations must not override the route-based authoritative quote.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const controller = fs.readFileSync(path.join(__dirname, '../controllers/orderController.js'), 'utf8');
const orchestrator = fs.readFileSync(path.join(__dirname, '../services/pricing/pricingOrchestrator.js'), 'utf8');

assert.match(controller, /pricingEngineEnabled\s*=\s*false/);
assert.match(controller, /if\s*\(!pricingEngineEnabled\s*&&\s*distanceKm\s*>\s*effectiveRadius\)/);
assert.match(controller, /if\s*\(!pricingEngineEnabled\s*&&\s*minimumOrder\s*>\s*0\s*&&\s*subtotal\s*<\s*minimumOrder\)/);
assert.match(controller, /const policyFee\s*=\s*pricingEngineEnabled\s*\?\s*0/);
assert.match(controller, /const pricingRules\s*=\s*await resolvePricingRules\(\)/);
assert.match(controller, /pricingEngineEnabled,\s*(?:platformMinimumOrderRupees:\s*pricingRules\.platformMinimumOrderRupees,\s*)?\}\)\)/);
assert.match(orchestrator, /const platformMaxDistanceKm\s*=\s*Number\(rules\.maxDeliveryDistanceKm\)\s*\|\|\s*10/);
assert.match(orchestrator, /Math\.min\(platformMaxDistanceKm,\s*restaurantRadiusKm\)/);

console.log('PASS engine-enabled checkout bypasses legacy distance, minimum-order and delivery-fee overrides');
console.log('PASS engine route enforces the stricter platform/restaurant delivery radius');
