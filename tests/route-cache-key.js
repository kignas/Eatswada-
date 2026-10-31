// Regression test (Step 4 of the pricing-integration audit, finding N3).
//
// The route cache key passed to the Mapbox provider was only the caller's
// prefix (`card:<restaurantId>|r2c`, `co:<restaurantId>|r2c`,
// `q:<restaurantId>:<addressId>|r2c`). It carried NO coordinates, so within the
// 60 s TTL a second customer asking about the same restaurant was handed the
// first customer's distance - and with it the wrong fee tier and price.
//
// Uses the REAL routeService + mapboxService with a stubbed HTTP client. No
// network. Usage: npm run test:route-cache-key
const Module = require('module');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');

process.env.MAPBOX_TOKEN = 'test-token';

let httpCalls = [];
let httpImpl;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'axios') return { get: (...a) => { httpCalls.push(a); return httpImpl(...a); } };
  return realLoad.apply(this, arguments);
};
const fresh = () => {
  for (const f of ['services/mapboxService.js', 'services/pricing/routeService.js']) delete require.cache[path.join(ROOT, f)];
  return require(path.join(ROOT, 'services/pricing/routeService.js'));
};

const RESTAURANT = [88.80, 26.50];
const NEAR = [88.81, 26.51];
const FAR = [88.95, 26.65];
// The fake road distance depends on the destination in the URL, like the real API.
const roadMetersFor = (url) => (url.includes(`${FAR[0]},${FAR[1]}`) ? 9000 : 1500);
const okHttp = async (url) => ({ data: { routes: [{ duration: 600, distance: roadMetersFor(url), geometry: { coordinates: [] } }] } });

let failed = 0;
async function t(name, fn) {
  httpCalls = []; httpImpl = okHttp;
  try { await fn(); console.log(`PASS ${name}`); } catch (err) { failed += 1; console.log(`FAIL ${name}: ${String(err.message).split('\n')[0]}`); }
}

(async () => {
  for (const prefix of ['card:64b7f0c2a1b2c3d4e5f60718', 'co:64b7f0c2a1b2c3d4e5f60718', 'q:64b7f0c2a1b2c3d4e5f60718:64b7f0c2a1b2c3d4e5f60719']) {
    await t(`A1 two customers behind the same cache prefix get their OWN distance (${prefix.split(':')[0]})`, async () => {
      const rs = fresh();
      const a = await rs.resolveTripDistances({ restaurantCoords: RESTAURANT, customerCoords: NEAR, cacheKeyPrefix: prefix });
      const b = await rs.resolveTripDistances({ restaurantCoords: RESTAURANT, customerCoords: FAR, cacheKeyPrefix: prefix });
      assert.strictEqual(a.restaurantToCustomerKm, 1.5);
      assert.strictEqual(b.restaurantToCustomerKm, 9, 'second customer was served the first customer\'s cached distance');
      assert.strictEqual(httpCalls.length, 2);
    });
  }

  await t('A2 the same customer + restaurant still hits the cache (no extra provider call)', async () => {
    const rs = fresh();
    const args = { restaurantCoords: RESTAURANT, customerCoords: NEAR, cacheKeyPrefix: 'card:R1' };
    await rs.resolveTripDistances(args);
    await rs.resolveTripDistances(args);
    assert.strictEqual(httpCalls.length, 1);
  });

  await t('A3 the same address id with edited coordinates is not served the old distance', async () => {
    const rs = fresh();
    const prefix = 'q:R1:ADDR1';
    const before = await rs.resolveTripDistances({ restaurantCoords: RESTAURANT, customerCoords: NEAR, cacheKeyPrefix: prefix });
    const after = await rs.resolveTripDistances({ restaurantCoords: RESTAURANT, customerCoords: FAR, cacheKeyPrefix: prefix });
    assert.notStrictEqual(before.restaurantToCustomerKm, after.restaurantToCustomerKm);
  });

  await t('A4 the key sent to the provider contains both endpoints and keeps the caller prefix', async () => {
    const rs = fresh();
    const keys = [];
    await rs.resolveRoute(RESTAURANT, NEAR, { cacheKey: 'card:R1|r2c', routeFn: async (a, b, key) => { keys.push(key); return null; } });
    assert.strictEqual(keys.length, 1);
    assert.ok(keys[0].startsWith('card:R1|r2c|'), `prefix lost: ${keys[0]}`);
    assert.ok(keys[0].includes(RESTAURANT.join(',')) && keys[0].includes(NEAR.join(',')), `coordinates missing: ${keys[0]}`);
  });

  await t('A5 with no caller key the key is still the coordinate pair', async () => {
    const rs = fresh();
    const keys = [];
    await rs.resolveRoute(RESTAURANT, NEAR, { routeFn: async (a, b, key) => { keys.push(key); return null; } });
    assert.strictEqual(keys[0], `${RESTAURANT.join(',')}|${NEAR.join(',')}`);
  });

  await t('A6 direction matters: restaurant->customer and customer->restaurant do not share a key', async () => {
    const rs = fresh();
    const keys = [];
    const routeFn = async (a, b, key) => { keys.push(key); return null; };
    await rs.resolveRoute(RESTAURANT, NEAR, { cacheKey: 'k', routeFn });
    await rs.resolveRoute(NEAR, RESTAURANT, { cacheKey: 'k', routeFn });
    assert.notStrictEqual(keys[0], keys[1]);
  });

  await t('A7 the rider leg (p2r) is keyed by the rider position too', async () => {
    const rs = fresh();
    const near = await rs.resolveTripDistances({ restaurantCoords: RESTAURANT, customerCoords: NEAR, riderCoords: NEAR, cacheKeyPrefix: 'q:R1:A' });
    const far = await rs.resolveTripDistances({ restaurantCoords: RESTAURANT, customerCoords: NEAR, riderCoords: FAR, cacheKeyPrefix: 'q:R1:A' });
    assert.notStrictEqual(near.riderToRestaurantKm, far.riderToRestaurantKm);
  });

  console.log(failed ? `\n${failed} FAILED` : '\nAll route-cache-key tests passed');
  process.exit(failed ? 1 : 0);
})();
