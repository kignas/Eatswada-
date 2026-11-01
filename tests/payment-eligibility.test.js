'use strict';
// Payment eligibility: the cart's COD/UPI verdict must follow the SAME gates
// POST /orders enforces. Pure test, no DB, no network.
// Usage: npm run test:payment-eligibility
const assert = require('assert');
const path = require('path');
const { evaluatePaymentOptions } = require(path.join(__dirname, '..', 'services', 'paymentEligibility'));

const settings = { isCodEnabled: true, isUpiEnabled: true, maxCodOrderAmount: 1000, codAdvanceThreshold: 1000, codAdvancePercent: 10 };
const base = { settings, customer: { isCodBlocked: false }, restaurants: [{ codEnabled: true }], totalRupees: 208, foodSubtotalRupees: 200 };
const run = (over = {}) => evaluatePaymentOptions({ ...base, ...over });

let failed = 0;
function t(name, fn) {
  try { fn(); console.log(`PASS ${name}`); } catch (e) { failed += 1; console.log(`FAIL ${name}: ${String(e.message).split('\n')[0]}`); }
}

t('all gates open -> COD ok, no advance', () => {
  const v = run();
  assert.strictEqual(v.cod.ok, true);
  assert.strictEqual(v.cod.advanceRequired, false);
  assert.strictEqual(v.cod.cashDue, 208);
  assert.strictEqual(v.upi.ok, true);
});
t('platform COD switch off -> COD_PLATFORM_OFF', () => {
  const v = run({ settings: { ...settings, isCodEnabled: false } });
  assert.strictEqual(v.cod.ok, false);
  assert.strictEqual(v.cod.code, 'COD_PLATFORM_OFF');
});
t('platform COD setting missing is treated as OFF (same as the order endpoint, which needs === true)', () => {
  const v = run({ settings: { ...settings, isCodEnabled: undefined } });
  assert.strictEqual(v.cod.code, 'COD_PLATFORM_OFF');
});
t('COD-blocked customer -> COD_CUSTOMER_BLOCKED', () => {
  const v = run({ customer: { isCodBlocked: true } });
  assert.strictEqual(v.cod.code, 'COD_CUSTOMER_BLOCKED');
});
t('restaurant codEnabled=false -> COD_RESTAURANT_OFF', () => {
  const v = run({ restaurants: [{ codEnabled: false }] });
  assert.strictEqual(v.cod.code, 'COD_RESTAURANT_OFF');
});
t('restaurant codEnabled unknown (undefined/null) is reported as UNKNOWN, not as "off"', () => {
  assert.strictEqual(run({ restaurants: [{}] }).cod.code, 'COD_RESTAURANT_UNKNOWN');
  assert.strictEqual(run({ restaurants: [{ codEnabled: null }] }).cod.code, 'COD_RESTAURANT_UNKNOWN');
});
t('two restaurants -> COD_MULTI_RESTAURANT', () => {
  const v = run({ restaurants: [{ codEnabled: true }, { codEnabled: true }] });
  assert.strictEqual(v.cod.code, 'COD_MULTI_RESTAURANT');
});
t('cash due over the cap -> COD_OVER_CAP (advance is NOT required below the food threshold)', () => {
  const v = run({ totalRupees: 1050, foodSubtotalRupees: 1000 });
  assert.strictEqual(v.cod.ok, false);
  assert.strictEqual(v.cod.code, 'COD_OVER_CAP');
});
t('above the advance threshold the online advance reduces the cash due and COD can still pass', () => {
  const v = run({ totalRupees: 1250, foodSubtotalRupees: 1200 });
  assert.strictEqual(v.cod.advanceRequired, true);
  assert.strictEqual(v.cod.advanceAmount, 120);
  assert.strictEqual(v.cod.cashDue, 1130);
  assert.strictEqual(v.cod.code, 'COD_OVER_CAP');   // 1130 > 1000 cap
  const v2 = run({ settings: { ...settings, maxCodOrderAmount: 1500 }, totalRupees: 1250, foodSubtotalRupees: 1200 });
  assert.strictEqual(v2.cod.ok, true);
});
t('a per-customer advance rule of "from Rs 0" forces an advance on every COD order', () => {
  const v = run({ customer: { isCodBlocked: false, codPolicy: { advanceRequiredAbove: 0, advancePercent: 20 } } });
  assert.strictEqual(v.cod.advanceRequired, true);
  assert.strictEqual(v.cod.advanceAmount, 40);
});
t('UPI switched off is reported separately and does not affect COD', () => {
  const v = run({ settings: { ...settings, isUpiEnabled: false } });
  assert.strictEqual(v.upi.ok, false);
  assert.strictEqual(v.upi.code, 'UPI_PLATFORM_OFF');
  assert.strictEqual(v.cod.ok, true);
});
t('gates list names every check, in order, so a screenshot shows which one failed', () => {
  const names = run().gates.map(g => g.name);
  assert.deepStrictEqual(names, ['platform_cod_enabled', 'customer_not_cod_blocked', 'single_restaurant', 'restaurant_cod_enabled', 'within_cod_cap']);
});
t('first failing gate wins the reason (platform before customer before restaurant)', () => {
  const v = run({ settings: { ...settings, isCodEnabled: false }, customer: { isCodBlocked: true }, restaurants: [{ codEnabled: false }] });
  assert.strictEqual(v.cod.code, 'COD_PLATFORM_OFF');
});

console.log(failed ? `\n${failed} FAILED` : '\nAll payment-eligibility tests passed');
process.exit(failed ? 1 : 0);
