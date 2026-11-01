'use strict';
// Route detour sanity guard (services/pricing/routeService.applyDetourGuard).
// Pure test: providers are injected, no network. Usage: npm run test:route-detour-guard
const assert = require('assert');
const path = require('path');
const { applyDetourGuard, detourSettings } = require(path.join(__dirname, '..', 'services', 'pricing', 'routeService'));

// Foodie Dosa pin and a point ~3.3 km due east of it.
const FROM = [88.8132, 26.558559];
const dLng = 3.3 / (111.32 * Math.cos(26.558559 * Math.PI / 180));
const TO = [88.8132 + dLng, 26.558559];

const ola7 = { distanceMeters: 7000, durationSec: 1500, source: 'ola_maps_directions_bike' };
const mapbox4 = async () => ({ distanceMeters: 4000, durationSec: 900, source: 'mapbox_directions' });
const mapbox9 = async () => ({ distanceMeters: 9000, durationSec: 1800, source: 'mapbox_directions' });
const silent = { warn() {} };
let warned = 0;
const counting = { warn() { warned += 1; } };

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed += 1; console.log(`FAIL ${name}: ${String(e.message).split('\n')[0]}`); }
}

(async () => {
  await t('settings: default mode is log, default ratio 1.8', () => {
    assert.deepStrictEqual(detourSettings({}), { mode: 'log', ratio: 1.8 });
    assert.deepStrictEqual(detourSettings({ ROUTE_DETOUR_GUARD: 'bogus', ROUTE_DETOUR_RATIO: 'x' }), { mode: 'log', ratio: 1.8 });
    assert.deepStrictEqual(detourSettings({ ROUTE_DETOUR_GUARD: 'ENFORCE', ROUTE_DETOUR_RATIO: '2.2' }), { mode: 'enforce', ratio: 2.2 });
  });
  await t('LOG mode (default) never changes the distance, but logs both numbers', async () => {
    warned = 0;
    const r = await applyDetourGuard({ from: FROM, to: TO, primary: ola7, secondary: mapbox4, env: {}, log: counting });
    assert.strictEqual(r.distanceMeters, 7000);
    assert.strictEqual(warned, 1);
  });
  await t('ENFORCE mode swaps to the lower provider when Ola is > 1.8x straight line (7.0 vs 3.3 km)', async () => {
    const r = await applyDetourGuard({ from: FROM, to: TO, primary: ola7, secondary: mapbox4, env: { ROUTE_DETOUR_GUARD: 'enforce' }, log: silent });
    assert.strictEqual(r.distanceMeters, 4000);
    assert.strictEqual(r.source, 'mapbox_directions');
    assert.strictEqual(r.detourGuard.primaryKm, 7);
  });
  await t('ENFORCE keeps Ola when the second opinion is even longer', async () => {
    const r = await applyDetourGuard({ from: FROM, to: TO, primary: ola7, secondary: mapbox9, env: { ROUTE_DETOUR_GUARD: 'enforce' }, log: silent });
    assert.strictEqual(r.distanceMeters, 7000);
  });
  await t('ENFORCE keeps Ola when there is no second provider', async () => {
    const r = await applyDetourGuard({ from: FROM, to: TO, primary: ola7, secondary: async () => null, env: { ROUTE_DETOUR_GUARD: 'enforce' }, log: silent });
    assert.strictEqual(r.distanceMeters, 7000);
  });
  await t('ENFORCE survives a throwing second provider', async () => {
    const r = await applyDetourGuard({ from: FROM, to: TO, primary: ola7, secondary: async () => { throw new Error('boom'); }, env: { ROUTE_DETOUR_GUARD: 'enforce' }, log: silent });
    assert.strictEqual(r.distanceMeters, 7000);
  });
  await t('a normal road distance (1.3x straight line) is untouched and the second provider is not even called', async () => {
    let called = 0;
    const ok = { distanceMeters: 4300, durationSec: 800, source: 'ola_maps_directions_bike' };
    const r = await applyDetourGuard({ from: FROM, to: TO, primary: ok, secondary: async () => { called += 1; return null; }, env: { ROUTE_DETOUR_GUARD: 'enforce' }, log: silent });
    assert.strictEqual(r.distanceMeters, 4300);
    assert.strictEqual(called, 0);
  });
  await t('boundary: 1.79x straight line is kept, 1.81x triggers the guard', async () => {
    const { haversineKm } = require(path.join(__dirname, '..', 'services', 'deliveryPricing'));
    const m = haversineKm(FROM, TO) * 1000;
    const keep = await applyDetourGuard({ from: FROM, to: TO, primary: { distanceMeters: m * 1.79, durationSec: 1, source: 'x' }, secondary: mapbox4, env: { ROUTE_DETOUR_GUARD: 'enforce' }, log: silent });
    assert.strictEqual(keep.distanceMeters, m * 1.79);
    const swap = await applyDetourGuard({ from: FROM, to: TO, primary: { distanceMeters: m * 1.81, durationSec: 1, source: 'x' }, secondary: mapbox4, env: { ROUTE_DETOUR_GUARD: 'enforce' }, log: silent });
    assert.strictEqual(swap.distanceMeters, 4000);
  });
  await t('very short hops (< 0.5 km straight) are never second-guessed', async () => {
    const near = [FROM[0] + 0.001, FROM[1]];
    const r = await applyDetourGuard({ from: FROM, to: near, primary: { distanceMeters: 900, durationSec: 1, source: 'x' }, secondary: mapbox4, env: { ROUTE_DETOUR_GUARD: 'enforce' }, log: silent });
    assert.strictEqual(r.distanceMeters, 900);
  });
  await t('OFF mode does nothing', async () => {
    const r = await applyDetourGuard({ from: FROM, to: TO, primary: ola7, secondary: mapbox4, env: { ROUTE_DETOUR_GUARD: 'off' }, log: silent });
    assert.strictEqual(r.distanceMeters, 7000);
  });
  await t('null primary passes through (resolveRoute then falls back to the estimate)', async () => {
    assert.strictEqual(await applyDetourGuard({ from: FROM, to: TO, primary: null, secondary: mapbox4, env: {}, log: silent }), null);
  });

  console.log(failed ? `\n${failed} FAILED` : '\nAll route-detour-guard tests passed');
  process.exit(failed ? 1 : 0);
})();
