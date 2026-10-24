// Regression test: a double-tapped checkout (no Idempotency-Key sent) must not
// create duplicate orders or double-reserve stock. The server derives a key from
// user + cart + address + payment details, and dedupes within a short window.
// Runs with no database (in-memory fakes). Usage: npm run test:checkout-idempotency
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { makeOrderModel } = require('./helpers/fakeOrderModel');
const ROOT = path.join(__dirname, '..');

const svc = require(path.join(ROOT, 'services/checkoutIdempotencyService.js'));
const WINDOW = 30 * 1000;

// Minimal in-memory IdempotencyKey: unique _id (E11000) + atomic findOneAndUpdate.
const makeLockModel = () => {
  const docs = new Map();
  return {
    docs,
    async create(doc) {
      await new Promise(r => setTimeout(r, 1)); // yield so concurrent callers interleave
      if (docs.has(doc._id)) { const e = new Error('E11000 duplicate key'); e.code = 11000; throw e; }
      docs.set(doc._id, { ...doc, createdAt: doc.createdAt || new Date() });
      return docs.get(doc._id);
    },
    async findOneAndUpdate(filter, update) {
      await new Promise(r => setTimeout(r, 1));
      const d = docs.get(filter._id);
      if (!d) return null;
      if (filter.createdAt && filter.createdAt.$lt && !(d.createdAt.getTime() < filter.createdAt.$lt.getTime())) return null;
      Object.assign(d, update.$set);
      return d;
    },
    async deleteOne({ _id }) { docs.delete(_id); },
  };
};

const body = (over = {}) => ({
  items: [{ menuItem: 'a'.repeat(24), quantity: 2 }, { menuItem: 'b'.repeat(24), quantity: 1 }],
  addressId: 'c'.repeat(24), paymentMethod: 'upi', tipAmount: 10, couponCode: '', ...over,
});
const req = (b, headers = {}) => ({ body: b, headers });

(async () => {
  let pass = 0;
  const t = async (name, fn) => { await fn(); pass++; console.log('PASS', name); };

  await t('A: same cart twice → same derived key, even if key/item order differs', async () => {
    const k1 = svc.resolveCheckoutKey('u1', req(body()));
    const reordered = body({ items: [{ quantity: 1, menuItem: 'b'.repeat(24) }, { quantity: 2, menuItem: 'a'.repeat(24) }] });
    const k2 = svc.resolveCheckoutKey('u1', req(reordered));
    assert.strictEqual(k1.derived, true);
    assert.ok(k1.key && k1.key.length <= 100);
    assert.strictEqual(k1.key, k2.key);
  });

  await t('B: any real difference (qty, address, method, tip, coupon, note, user) → different key', async () => {
    const base = svc.resolveCheckoutKey('u1', req(body())).key;
    const variants = [
      svc.resolveCheckoutKey('u1', req(body({ items: [{ menuItem: 'a'.repeat(24), quantity: 3 }, { menuItem: 'b'.repeat(24), quantity: 1 }] }))).key,
      svc.resolveCheckoutKey('u1', req(body({ addressId: 'd'.repeat(24) }))).key,
      svc.resolveCheckoutKey('u1', req(body({ paymentMethod: 'cod' }))).key,
      svc.resolveCheckoutKey('u1', req(body({ tipAmount: 20 }))).key,
      svc.resolveCheckoutKey('u1', req(body({ couponCode: 'SAVE10' }))).key,
      svc.resolveCheckoutKey('u1', req(body({ restaurantNote: 'no onion' }))).key,
      svc.resolveCheckoutKey('u2', req(body())).key,
    ];
    for (const v of variants) assert.notStrictEqual(v, base);
    assert.strictEqual(new Set(variants).size, variants.length);
  });

  await t('C: a client-supplied Idempotency-Key (header or body) is honored as-is, not replaced', async () => {
    const h = svc.resolveCheckoutKey('u1', req(body(), { 'idempotency-key': 'my-key-1' }));
    assert.deepStrictEqual(h, { key: 'my-key-1', derived: false });
    const b = svc.resolveCheckoutKey('u1', req(body({ idempotencyKey: 'my-key-2' })));
    assert.deepStrictEqual(b, { key: 'my-key-2', derived: false });
  });

  await t('D: replay filter — derived keys only replay orders inside the window; client keys replay always', async () => {
    const Order = makeOrderModel();
    const now = Date.now();
    Order.insert({ _id: 'old', user: 'u1', idempotencyKey: 'srv:x', createdAt: new Date(now - 5 * 60 * 1000).toISOString() });
    Order.insert({ _id: 'new', user: 'u1', idempotencyKey: 'srv:x', createdAt: new Date(now - 5 * 1000).toISOString() });
    const derived = await Order.find(svc.replayFilter('u1', { key: 'srv:x', derived: true }, now, WINDOW));
    assert.deepStrictEqual(derived.map(o => o._id), ['new']);
    Order.insert({ _id: 'old2', user: 'u1', idempotencyKey: 'mine', createdAt: new Date(now - 5 * 60 * 1000).toISOString() });
    const client = await Order.find(svc.replayFilter('u1', { key: 'mine', derived: false }, now, WINDOW));
    assert.deepStrictEqual(client.map(o => o._id), ['old2']);
  });

  await t('E: two simultaneous double-tap requests → exactly one claims the lock', async () => {
    const Lock = makeLockModel();
    const k = svc.resolveCheckoutKey('u1', req(body()));
    const now = Date.now();
    const results = await Promise.all([
      svc.claimCheckoutLock(Lock, { userId: 'u1', ...k }, now, WINDOW),
      svc.claimCheckoutLock(Lock, { userId: 'u1', ...k }, now, WINDOW),
      svc.claimCheckoutLock(Lock, { userId: 'u1', ...k }, now, WINDOW),
    ]);
    assert.strictEqual(results.filter(Boolean).length, 1);
  });

  await t('F: inside the window a repeat is refused; after the window the same cart may be ordered again', async () => {
    const Lock = makeLockModel();
    const k = svc.resolveCheckoutKey('u1', req(body()));
    const t0 = Date.now();
    assert.strictEqual(await svc.claimCheckoutLock(Lock, { userId: 'u1', ...k }, t0, WINDOW), true);
    assert.strictEqual(await svc.claimCheckoutLock(Lock, { userId: 'u1', ...k }, t0 + 10 * 1000, WINDOW), false);
    assert.strictEqual(await svc.claimCheckoutLock(Lock, { userId: 'u1', ...k }, t0 + WINDOW + 1000, WINDOW), true);
  });

  await t('G: two simultaneous requests right after the window expires → still only one wins the takeover', async () => {
    const Lock = makeLockModel();
    const k = svc.resolveCheckoutKey('u1', req(body()));
    const t0 = Date.now();
    await svc.claimCheckoutLock(Lock, { userId: 'u1', ...k }, t0, WINDOW);
    const later = t0 + WINDOW + 1000;
    const results = await Promise.all([
      svc.claimCheckoutLock(Lock, { userId: 'u1', ...k }, later, WINDOW),
      svc.claimCheckoutLock(Lock, { userId: 'u1', ...k }, later, WINDOW),
    ]);
    assert.strictEqual(results.filter(Boolean).length, 1);
  });

  await t('H: a client-supplied key lock is NEVER taken over by age (existing behavior unchanged)', async () => {
    const Lock = makeLockModel();
    const k = { key: 'my-key', derived: false };
    const t0 = Date.now();
    assert.strictEqual(await svc.claimCheckoutLock(Lock, { userId: 'u1', ...k }, t0, WINDOW), true);
    assert.strictEqual(await svc.claimCheckoutLock(Lock, { userId: 'u1', ...k }, t0 + 10 * WINDOW, WINDOW), false);
  });

  await t('I: non-duplicate DB errors are not swallowed', async () => {
    const Lock = { async create() { throw new Error('connection lost'); } };
    await assert.rejects(() => svc.claimCheckoutLock(Lock, { userId: 'u1', key: 'k', derived: true }, Date.now(), WINDOW), /connection lost/);
  });

  await t('J: window is configurable, floors at 5s, defaults to 30s', async () => {
    const prev = process.env.CHECKOUT_DEDUPE_WINDOW_SECONDS;
    delete process.env.CHECKOUT_DEDUPE_WINDOW_SECONDS; assert.strictEqual(svc.dedupeWindowMs(), 30000);
    process.env.CHECKOUT_DEDUPE_WINDOW_SECONDS = '60'; assert.strictEqual(svc.dedupeWindowMs(), 60000);
    process.env.CHECKOUT_DEDUPE_WINDOW_SECONDS = '1'; assert.strictEqual(svc.dedupeWindowMs(), 30000);
    if (prev === undefined) delete process.env.CHECKOUT_DEDUPE_WINDOW_SECONDS; else process.env.CHECKOUT_DEDUPE_WINDOW_SECONDS = prev;
  });

  await t('K: wiring — createOrder derives the key, uses the replay filter and the claim helper', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'controllers/orderController.js'), 'utf8');
    assert.ok(src.includes("require('../services/checkoutIdempotencyService')"), 'service must be imported');
    assert.ok(/resolveCheckoutKey\(/.test(src), 'createOrder must resolve/derive the key');
    assert.ok(/replayFilter\(/.test(src), 'replay reads must use the window-aware filter');
    assert.ok(/claimCheckoutLock\(/.test(src), 'lock must be claimed through the helper');
    assert.ok(!/IdempotencyKey\.create\(/.test(src), 'controller must not insert the raw lock any more');
    const raw = src.split('\n').filter(l => /Order\.find\(\{ user: req\.user\._id, idempotencyKey \}\)/.test(l));
    assert.strictEqual(raw.length, 0, 'no replay read may bypass the window-aware filter');
  });

  await t('L: package.json exposes the test script', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.scripts['test:checkout-idempotency'], 'node tests/checkout-idempotency.js');
  });

  console.log(`\n${pass} scenarios passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
