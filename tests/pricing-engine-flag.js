// Regression test (Step 1 of the pricing-integration audit, finding N1).
//
// Before the fix, POST /api/pricing/quote and GET /api/pricing/restaurant-cards
// priced with the engine even when `pricingEngineEnabled` was false, while
// createOrder only uses the engine when the flag is on. With the flag at its
// default (false) the cart showed engine prices (₹8/22/33/66 + uplift) but the
// order was charged the legacy price.
//
// The real controllers/pricingController.js is loaded with stubbed packages,
// models and engine services. No database, no Express.
// Usage: npm run test:pricing-engine-flag
const Module = require('module');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');

const spies = { createQuote: 0, buildCard: 0, restaurantFindOne: 0, restaurantFind: 0, addressFindOne: 0, orderExists: 0 };
let currentRules = {};

const RESTAURANT_ID = '64b7f0c2a1b2c3d4e5f60718';
const ADDRESS_ID = '64b7f0c2a1b2c3d4e5f60719';
const MENU_ID = '64b7f0c2a1b2c3d4e5f6071a';

const chain = (value) => ({ select() { return this; }, lean: async () => value });
const stubs = {
  mongoose: { Types: { ObjectId: { isValid: (v) => /^[0-9a-fA-F]{24}$/.test(String(v)) } } },
  'express-async-handler': (fn) => fn,
  [path.join(ROOT, 'models/Restaurant.js')]: {
    findOne: () => { spies.restaurantFindOne += 1; return chain({ _id: RESTAURANT_ID, location: { coordinates: [88.8, 26.5] }, deliveryRadiusKm: 10 }); },
    find: () => { spies.restaurantFind += 1; return chain([{ _id: RESTAURANT_ID, location: { coordinates: [88.8, 26.5] }, deliveryRadiusKm: 10 }]); },
  },
  [path.join(ROOT, 'models/Menu.js')]: { find: () => chain([{ _id: MENU_ID, price: 100 }]) },
  [path.join(ROOT, 'models/Address.js')]: {
    findOne: () => { spies.addressFindOne += 1; return chain({ _id: ADDRESS_ID, location: { coordinates: [88.81, 26.51] } }); },
  },
  [path.join(ROOT, 'models/Order.js')]: { exists: async () => { spies.orderExists += 1; return null; } },
  [path.join(ROOT, 'services/pricing/pricingRules.js')]: { resolvePricingRules: async () => currentRules },
  [path.join(ROOT, 'services/pricing/quoteService.js')]: {
    createQuote: async () => { spies.createQuote += 1; return { serviceable: true, quoteId: 'q_test', pricingVersion: 'v1' }; },
  },
  [path.join(ROOT, 'services/pricing/pricingOrchestrator.js')]: {
    buildRestaurantCardPricing: async ({ restaurant }) => { spies.buildCard += 1; return { restaurantId: String(restaurant._id), serviceable: true, distanceKm: 2 }; },
  },
  [path.join(ROOT, 'services/deliveryPricing.js')]: { validCoordinates: (c) => Array.isArray(c) && c.length === 2 && c.every(Number.isFinite) },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  if (parent && request.startsWith('.')) {
    const resolved = path.resolve(path.dirname(parent.filename), request);
    for (const candidate of [resolved, `${resolved}.js`]) {
      if (Object.prototype.hasOwnProperty.call(stubs, candidate)) return stubs[candidate];
    }
  }
  return realLoad.apply(this, arguments);
};

const controller = require(path.join(ROOT, 'controllers/pricingController.js'));

function fakeRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  return res;
}
const resetSpies = () => { for (const k of Object.keys(spies)) spies[k] = 0; };
const user = { _id: '64b7f0c2a1b2c3d4e5f6071b' };
const quoteReq = () => ({ user, body: { restaurantId: RESTAURANT_ID, addressId: ADDRESS_ID, items: [{ menuItem: MENU_ID, quantity: 1 }], paymentMethod: 'upi' } });
const cardsReq = () => ({ user, query: { restaurantIds: RESTAURANT_ID, addressId: ADDRESS_ID } });

let failed = 0;
async function t(name, fn) {
  resetSpies();
  try { await fn(); console.log(`PASS ${name}`); } catch (err) { failed += 1; console.log(`FAIL ${name}: ${err.message.split('\n')[0]}`); }
}

(async () => {
  // ── Flag OFF: the engine must not price anything ────────────────────
  for (const [label, value] of [['false', false], ['missing', undefined], ['string "true"', 'true'], ['number 1', 1]]) {
    await t(`quote is refused, without pricing or DB work, when pricingEngineEnabled is ${label}`, async () => {
      currentRules = { version: 'v1', pricingEngineEnabled: value };
      const res = fakeRes();
      await controller.quote(quoteReq(), res);
      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.code, 'PRICING_ENGINE_DISABLED');
      assert.strictEqual(res.body.data, undefined, 'no quote data may leak when the engine is off');
      assert.strictEqual(spies.createQuote, 0, 'createQuote must not run');
      assert.strictEqual(spies.restaurantFindOne + spies.addressFindOne, 0, 'no DB lookups before the gate');
    });

    await t(`restaurant-cards returns no cards when pricingEngineEnabled is ${label}`, async () => {
      currentRules = { version: 'v1', pricingEngineEnabled: value };
      const res = fakeRes();
      await controller.restaurantCards(cardsReq(), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.engineEnabled, false);
      assert.deepStrictEqual(res.body.data.cards, []);
      assert.strictEqual(spies.buildCard, 0, 'card pricing must not run');
      assert.strictEqual(res.headers['Cache-Control'], 'no-store');
    });
  }

  // ── Flag ON: behaviour is unchanged ─────────────────────────────────
  await t('quote still prices when pricingEngineEnabled is true', async () => {
    currentRules = { version: 'v1', pricingEngineEnabled: true };
    const res = fakeRes();
    await controller.quote(quoteReq(), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.quoteId, 'q_test');
    assert.strictEqual(spies.createQuote, 1);
  });

  await t('restaurant-cards still prices when pricingEngineEnabled is true', async () => {
    currentRules = { version: 'v1', pricingEngineEnabled: true };
    const res = fakeRes();
    await controller.restaurantCards(cardsReq(), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.data.cards.length, 1);
    assert.strictEqual(res.body.data.engineEnabled, true);
    assert.strictEqual(spies.buildCard, 1);
  });

  // ── Existing validation keeps working with the flag on ──────────────
  await t('invalid restaurantId is still a 400 when the engine is on', async () => {
    currentRules = { version: 'v1', pricingEngineEnabled: true };
    const res = fakeRes();
    await controller.quote({ user, body: { restaurantId: 'nope', items: [] } }, res);
    assert.strictEqual(res.statusCode, 400);
  });

  await t('quote without a verified address is still a 400 when the engine is on', async () => {
    currentRules = { version: 'v1', pricingEngineEnabled: true };
    const res = fakeRes();
    const req = quoteReq();
    req.body.addressId = null;
    await controller.quote(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(spies.createQuote, 0);
  });

  // ── Public config is untouched and reports the real flag ────────────
  await t('GET /pricing/config reports pricingEngineEnabled truthfully', async () => {
    currentRules = { version: 'v1', pricingEngineEnabled: false, deliveryFeeBands: [] };
    let res = fakeRes();
    await controller.publicConfig({}, res);
    assert.strictEqual(res.body.data.pricingEngineEnabled, false);
    currentRules = { version: 'v1', pricingEngineEnabled: true, deliveryFeeBands: [] };
    res = fakeRes();
    await controller.publicConfig({}, res);
    assert.strictEqual(res.body.data.pricingEngineEnabled, true);
  });

  console.log(failed ? `\n${failed} FAILED` : '\nAll pricing-engine-flag tests passed');
  process.exit(failed ? 1 : 0);
})();
