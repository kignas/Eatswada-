'use strict';

// Ola Maps route adapter contract test. No network calls.
const Module = require('module');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');

process.env.OLA_MAPS_API_KEY = 'test-ola-key';
delete process.env.MAPBOX_TOKEN;

let calls = [];
let httpImpl = async () => ({
  data: { routes: [{ legs: [{ distance: 4321, duration: 720 }] }] },
});
const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'axios') return { post: (...args) => { calls.push(args); return httpImpl(...args); } };
  return realLoad.apply(this, arguments);
};

function fresh() {
  for (const file of ['services/olaMapsService.js', 'services/pricing/routeService.js']) {
    delete require.cache[path.join(ROOT, file)];
  }
  return require(path.join(ROOT, 'services/pricing/routeService.js'));
}

(async () => {
  try {
    const routes = fresh();
    const from = [88.80, 26.50]; // [lng, lat]
    const to = [88.81, 26.51];

    const result = await routes.resolveRoute(from, to);
    assert.strictEqual(result.distanceKm, 4.32);
    assert.strictEqual(result.durationSec, 720);
    assert.strictEqual(result.source, 'ola_maps_directions_bike');
    assert.strictEqual(result.degraded, false);
    assert.strictEqual(calls.length, 1);

    const [url, body, config] = calls[0];
    assert.strictEqual(url, 'https://api.olamaps.io/routing/v1/directions');
    assert.strictEqual(body, null);
    assert.strictEqual(config.params.origin, '26.5,88.8');
    assert.strictEqual(config.params.destination, '26.51,88.81');
    assert.strictEqual(config.params.mode, 'bike');
    assert.strictEqual(config.params.api_key, 'test-ola-key');
    assert.strictEqual(config.timeout, 6500);

    // Same coordinates reuse the provider cache.
    await routes.resolveRoute(from, to);
    assert.strictEqual(calls.length, 1);

    // A non-OK response safely degrades to the conservative estimate.
    httpImpl = async () => ({ data: { routes: [] } });
    const failedRoute = await routes.resolveRoute([88.90, 26.60], [88.91, 26.61]);
    assert.strictEqual(failedRoute.source, 'haversine_estimate');
    assert.strictEqual(failedRoute.degraded, true);

    console.log('PASS Ola Maps request format, coordinate order, parsing, cache, and safe fallback');
  } catch (error) {
    console.error(`FAIL Ola Maps route integration: ${error.stack || error.message}`);
    process.exitCode = 1;
  } finally {
    Module._load = realLoad;
  }
})();
