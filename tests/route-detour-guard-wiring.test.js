'use strict';
// End-to-end wiring of the detour guard through the REAL routeService, olaMapsService
// and mapboxService with a stubbed HTTP client (no network).
// Usage: npm run test:route-detour-guard-wiring
const Module = require('module');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');

process.env.OLA_MAPS_API_KEY = 'test-ola-key';
process.env.MAPBOX_TOKEN = 'test-mapbox-token';

let olaMeters = 7000;
let mapboxMeters = 4000;
let olaCalls = 0, mapboxCalls = 0;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'axios') {
    return {
      post: async () => { olaCalls += 1; return { data: { routes: [{ legs: [{ distance: olaMeters, duration: 900 }] }] } }; },
      get: async () => { mapboxCalls += 1; return { data: { routes: [{ distance: mapboxMeters, duration: 800, geometry: { coordinates: [] } }] } }; },
    };
  }
  return realLoad.apply(this, arguments);
};

function fresh() {
  for (const f of ['services/olaMapsService.js', 'services/mapboxService.js', 'services/pricing/routeService.js']) delete require.cache[path.join(ROOT, f)];
  return require(path.join(ROOT, 'services/pricing/routeService.js'));
}

const FROM = [88.8132, 26.558559];
const dLng = 3.3 / (111.32 * Math.cos(26.558559 * Math.PI / 180));
const TO = [88.8132 + dLng, 26.558559];

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed += 1; console.log(`FAIL ${name}: ${String(e.message).split('\n')[0]}`); }
}

(async () => {
  const realWarn = console.warn; console.warn = () => {};
  await t('default (log) keeps the Ola 7.0 km so no money changes until the owner opts in', async () => {
    delete process.env.ROUTE_DETOUR_GUARD;
    olaCalls = mapboxCalls = 0; olaMeters = 7000; mapboxMeters = 4000;
    const r = await fresh().resolveRoute(FROM, TO);
    assert.strictEqual(r.distanceKm, 7);
    assert.strictEqual(r.source, 'ola_maps_directions_bike');
    assert.strictEqual(mapboxCalls, 1, 'second opinion is fetched for the log line');
  });
  await t('ROUTE_DETOUR_GUARD=enforce uses Mapbox 4.0 km instead of Ola 7.0 km', async () => {
    process.env.ROUTE_DETOUR_GUARD = 'enforce';
    olaMeters = 7000; mapboxMeters = 4000;
    const r = await fresh().resolveRoute([88.80, 26.50], [88.80 + dLng, 26.50]);
    assert.strictEqual(r.distanceKm, 4);
    assert.strictEqual(r.source, 'mapbox_directions');
  });
  await t('a sane Ola route is used as is and Mapbox is not called', async () => {
    process.env.ROUTE_DETOUR_GUARD = 'enforce';
    olaCalls = mapboxCalls = 0; olaMeters = 4300; mapboxMeters = 4000;
    const r = await fresh().resolveRoute([88.70, 26.40], [88.70 + dLng, 26.40]);
    assert.strictEqual(r.distanceKm, 4.3);
    assert.strictEqual(mapboxCalls, 0);
  });
  console.warn = realWarn;
  console.log(failed ? `\n${failed} FAILED` : '\nAll route-detour-guard-wiring tests passed');
  process.exit(failed ? 1 : 0);
})();
