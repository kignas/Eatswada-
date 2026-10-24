// Regression test: coupon admin endpoints (controllers/couponController.js) must validate input.
// Before: create spread req.body into Coupon.create (admin could set usedCount etc.), percent value had
// no 100 cap, value 0/negative accepted, toggle did `!!req.body.isActive` (the string "false" turned a
// coupon ON), and none of the async handlers were wrapped (a DB error left the request hanging).
// Runs with no database (in-memory fakes). Usage: npm run test:coupon-hardening
const Module = require('module');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const CONTROLLER = path.join(ROOT, 'controllers/couponController.js');

// ── in-memory models ─────────────────────────────────────────────────────────────
const state = { created: [], updates: [], codes: new Set(), failNext: null, coupon: null, redemptions: 0, delivered: null };
const Coupon = {
  create: async (doc) => {
    if (state.failNext) { const e = state.failNext; state.failNext = null; throw e; }
    if (state.codes.has(doc.code)) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    state.codes.add(doc.code); state.created.push(doc); return { _id: 'C1', ...doc };
  },
  find: () => ({ sort: () => ({ lean: async () => { if (state.failNext) { const e = state.failNext; state.failNext = null; throw e; } return []; } }) }),
  findByIdAndUpdate: async (id, update) => {
    if (state.failNext) { const e = state.failNext; state.failNext = null; throw e; }
    state.updates.push({ id, update });
    return id === 'ffffffffffffffffffffffff' ? null : { _id: id, isActive: update.$set.isActive };
  },
  findOne: async () => { if (state.failNext) { const e = state.failNext; state.failNext = null; throw e; } return state.coupon; },
};
const Redemption = { countDocuments: async () => state.redemptions };
const Order = { exists: async () => state.delivered };
const stubs = {
  [path.join(ROOT, 'models/Coupon.js')]: Coupon,
  [path.join(ROOT, 'models/CouponRedemption.js')]: Redemption,
  [path.join(ROOT, 'models/Order.js')]: Order,
  'express-async-handler': (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
};
const anything = new Proxy(function () {}, { get: (t, p) => (p === 'then' ? undefined : anything), apply: () => anything, construct: () => anything });
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (parent && parent.filename === CONTROLLER) {
    const resolved = request.startsWith('.') ? path.resolve(path.dirname(CONTROLLER), request) + '.js' : request;
    return stubs[resolved] || stubs[request] || anything;
  }
  return origLoad.call(this, request, parent, ...rest);
};
const ctrl = require(CONTROLLER);
Module._load = origLoad;
const realLog = console.log; console.log = () => {};

const ADMIN = { _id: 'A1', role: 'admin' };
const USER = { _id: 'U1', role: 'user' };
const ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const call = async (handler, req) => {
  const out = { nextErr: null };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; if (!out.status) out.status = 200; return res; } };
  await Promise.race([
    handler({ params: {}, body: {}, ...req }, res, (e) => { out.nextErr = e || new Error('next()'); }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('handler hung / rejected')), 500)),
  ]);
  return out;
};
const create = (body, user = ADMIN) => call(ctrl.create, { user, body });
const good = { code: 'welcome10', type: 'percent', value: 10 };
const reset = () => { state.created = []; state.updates = []; state.codes = new Set(); state.failNext = null; state.coupon = null; state.redemptions = 0; state.delivered = null; };
const rejected = (r, label) => { assert.strictEqual(r.status, 400, `${label}: expected 400, got ${r.status}`); assert.strictEqual(r.body.success, false); assert.strictEqual(state.created.length, 0, `${label}: coupon was created`); };

(async () => {
  let pass = 0;
  const t = async (name, fn) => { reset(); await fn(); pass++; realLog('PASS', name); };

  await t('A: create only stores whitelisted fields (usedCount, _id, createdAt are dropped), code upper-cased', async () => {
    const r = await create({ ...good, usedCount: 999, _id: 'X', createdAt: '2020-01-01', isAdminOverride: true, minSubtotal: '150' });
    assert.strictEqual(r.status, 201);
    const doc = state.created[0];
    assert.strictEqual(doc.code, 'WELCOME10');
    assert.strictEqual(doc.minSubtotal, 150);
    for (const k of ['usedCount', '_id', 'createdAt', 'isAdminOverride']) assert.ok(!(k in doc), `${k} leaked into Coupon.create`);
    assert.deepStrictEqual(Object.keys(doc).sort(), ['code', 'minSubtotal', 'type', 'value']);
  });

  await t('B: percent value must be 1-100', async () => {
    for (const value of [101, 150, 0, 0.5, -10, NaN, 'abc', null, undefined, {}, [], true]) rejected(await create({ ...good, value }), `percent ${String(value)}`);
    assert.strictEqual((await create({ ...good, code: 'P100', value: 100 })).status, 201);
    assert.strictEqual((await create({ ...good, code: 'PCT1', value: 1 })).status, 201);
  });

  await t('C: fixed value must be > 0 and within the cap (5000)', async () => {
    for (const value of [0, -5, 5001, 1e9, 'x', null]) rejected(await create({ code: 'FLAT', type: 'fixed', value }), `fixed ${String(value)}`);
    assert.strictEqual((await create({ code: 'FLAT50', type: 'fixed', value: 50 })).status, 201);
    assert.strictEqual((await create({ code: 'FLAT5000', type: 'fixed', value: 5000 })).status, 201);
  });

  await t('D: bad code or type rejected', async () => {
    for (const b of [{ ...good, code: 'ab' }, { ...good, code: 'has space' }, { ...good, code: undefined }, { ...good, type: 'bogus' }, { ...good, type: undefined }, { ...good, type: { $ne: 1 } }]) rejected(await create(b), JSON.stringify(b));
  });

  await t('E: limits are sane integers / ranges', async () => {
    const bad = [
      { maxDiscount: 0 }, { maxDiscount: -1 }, { maxDiscount: 5001 }, { maxDiscount: 'x' },
      { minSubtotal: -1 }, { minSubtotal: 100001 }, { minSubtotal: 'x' },
      { usageLimit: 0 }, { usageLimit: 1.5 }, { usageLimit: 1000001 }, { usageLimit: 'x' },
      { perUserLimit: 0 }, { perUserLimit: 2.5 }, { perUserLimit: 101 },
      { minSubtotal: '  ' }, { maxDiscount: '  ' }, { usageLimit: '  ' }, { perUserLimit: '  ' }, // whitespace is not a number
    ];
    for (const extra of bad) rejected(await create({ ...good, ...extra }), JSON.stringify(extra));
    const ok = await create({ ...good, maxDiscount: 100, minSubtotal: 200, usageLimit: 500, perUserLimit: 3, firstOrderOnly: true });
    assert.strictEqual(ok.status, 201);
    assert.deepStrictEqual({ ...state.created[0] }, { code: 'WELCOME10', type: 'percent', value: 10, maxDiscount: 100, minSubtotal: 200, usageLimit: 500, perUserLimit: 3, firstOrderOnly: true });
  });

  await t('F: dates must be valid and expiresAt must be after startsAt', async () => {
    // a bad expiry must be reported as an invalid date (not just as "before start"), and non-string/number
    // values (true -> epoch 1ms, [2030] -> year 2030) must not be coerced into dates
    const badExpiry = await create({ ...good, expiresAt: 'nope' });
    assert.strictEqual(badExpiry.status, 400); assert.match(badExpiry.body.message, /invalid expiry date/i);
    const badStart = await create({ ...good, startsAt: 'not-a-date' });
    assert.strictEqual(badStart.status, 400); assert.match(badStart.body.message, /invalid start date/i);
    for (const extra of [{ startsAt: true }, { startsAt: [2030] }, { expiresAt: [2031] }]) rejected(await create({ ...good, ...extra }), JSON.stringify(extra));
    for (const extra of [
      { startsAt: 'not-a-date' }, { expiresAt: 'nope' }, { expiresAt: true }, { startsAt: {} },
      { startsAt: '2030-02-01T00:00:00Z', expiresAt: '2030-01-01T00:00:00Z' },
      { startsAt: '2030-02-01T00:00:00Z', expiresAt: '2030-02-01T00:00:00Z' },
      { expiresAt: '2000-01-01T00:00:00Z' }, // before the default start (now)
    ]) rejected(await create({ ...good, ...extra }), JSON.stringify(extra));
    const ok = await create({ ...good, startsAt: '2030-01-01T00:00:00Z', expiresAt: '2030-02-01T00:00:00Z' });
    assert.strictEqual(ok.status, 201);
    assert.ok(state.created[0].startsAt instanceof Date && state.created[0].expiresAt instanceof Date);
  });

  await t('G: restaurant, fundedBy, share percent and flags are validated', async () => {
    for (const extra of [
      { restaurant: 'not-an-id' }, { restaurant: { $ne: null } }, { restaurant: 123 },
      { fundedBy: 'someone' }, { restaurantSharePercent: 101 }, { restaurantSharePercent: -1 }, { restaurantSharePercent: 'x' }, { restaurantSharePercent: '  ' },
      { firstOrderOnly: 'maybe' }, { isActive: 'maybe' }, { isActive: 1 },
    ]) rejected(await create({ ...good, ...extra }), JSON.stringify(extra));
    const ok = await create({ ...good, restaurant: ID, fundedBy: 'shared', restaurantSharePercent: 40, isActive: false });
    assert.strictEqual(ok.status, 201);
    assert.strictEqual(state.created[0].restaurant, ID);
    assert.strictEqual(state.created[0].isActive, false);
  });

  await t('H: duplicate code -> 409 COUPON_CODE_EXISTS (not a 500)', async () => {
    assert.strictEqual((await create(good)).status, 201);
    const r = await create({ ...good, code: ' welcome10 ' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, 'COUPON_CODE_EXISTS');
    assert.strictEqual(r.nextErr, null);
  });

  await t('I: non-admins are refused on create / list / toggle and nothing is written', async () => {
    for (const user of [USER, null, { _id: 'V1', role: 'vendor' }]) {
      assert.strictEqual((await create(good, user)).status, 403);
      assert.strictEqual((await call(ctrl.list, { user })).status, 403);
      assert.strictEqual((await call(ctrl.toggle, { user, params: { id: ID }, body: { isActive: true } })).status, 403);
    }
    assert.strictEqual(state.created.length + state.updates.length, 0);
  });

  await t('J: toggle validates the id and needs a real boolean ("false" no longer turns a coupon on)', async () => {
    const tg = (body, id = ID) => call(ctrl.toggle, { user: ADMIN, params: { id }, body });
    for (const id of ['abc', '', '123', 'zzzzzzzzzzzzzzzzzzzzzzzz']) assert.strictEqual((await tg({ isActive: true }, id)).status, 400, `id ${id}`);
    for (const body of [{}, { isActive: 'maybe' }, { isActive: 1 }, { isActive: null }, { isActive: {} }]) assert.strictEqual((await tg(body)).status, 400, JSON.stringify(body));
    assert.strictEqual(state.updates.length, 0);
    assert.strictEqual((await tg({ isActive: 'false' })).status, 200);
    assert.strictEqual(state.updates.at(-1).update.$set.isActive, false);
    assert.strictEqual((await tg({ isActive: false })).status, 200);
    assert.strictEqual(state.updates.at(-1).update.$set.isActive, false);
    assert.strictEqual((await tg({ isActive: true })).status, 200);
    assert.strictEqual(state.updates.at(-1).update.$set.isActive, true);
    assert.strictEqual((await tg({ isActive: 'true' })).status, 200);
    assert.strictEqual(state.updates.at(-1).update.$set.isActive, true);
    assert.strictEqual((await tg({ isActive: true }, 'ffffffffffffffffffffffff')).status, 404);
  });

  await t('K: a DB error reaches next(err) on every handler (no hanging request)', async () => {
    const boom = new Error('db down');
    state.failNext = boom; let r = await call(ctrl.validate, { user: USER, body: { code: 'X', subtotal: 100 } });
    assert.strictEqual(r.nextErr, boom, 'validate');
    state.failNext = boom; r = await create(good);
    assert.strictEqual(r.nextErr, boom, 'create');
    state.failNext = boom; r = await call(ctrl.list, { user: ADMIN });
    assert.strictEqual(r.nextErr, boom, 'list');
    state.failNext = boom; r = await call(ctrl.toggle, { user: ADMIN, params: { id: ID }, body: { isActive: true } });
    assert.strictEqual(r.nextErr, boom, 'toggle');
  });

  await t('L: customer validate still works (percent, maxDiscount cap, auth, bad coupon)', async () => {
    state.coupon = { _id: 'C1', code: 'SAVE10', type: 'percent', value: 10, maxDiscount: 30, minSubtotal: 100, usedCount: 0, usageLimit: null, perUserLimit: 1, firstOrderOnly: false, restaurant: null };
    let r = await call(ctrl.validate, { user: USER, body: { code: 'save10', subtotal: 500 } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.data, { code: 'SAVE10', discount: 30, type: 'percent' });
    r = await call(ctrl.validate, { user: USER, body: { code: 'save10', subtotal: 50 } });
    assert.strictEqual(r.status, 400);
    r = await call(ctrl.validate, { user: undefined, body: { code: 'save10', subtotal: 500 } });
    assert.strictEqual(r.status, 401);
    state.coupon = null;
    r = await call(ctrl.validate, { user: USER, body: { code: 'nope', subtotal: 500 } });
    assert.strictEqual(r.status, 400);
  });

  realLog(`\n${pass} scenarios passed`);
})().catch((e) => { realLog('FAIL', e && e.message ? e.message : e); process.exit(1); });
