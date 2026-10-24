'use strict';

// Dependency-free behavioral tests for couponUsageService's transaction contract.
// Run: node tests/coupon-usage-transaction.test.js
const assert = require('assert');
const Module = require('module');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const session = { id: 'fake-transaction-session' };
let state;
let operations;
let transactionCount;
let transactionFailure;
let inTransaction = false;

function reset(overrides = {}) {
  state = {
    coupon: {
      _id: 'coupon-1', usageLimit: 2, usedCount: 0, perUserLimit: 1,
      isActive: true, startsAt: new Date('2020-01-01T00:00:00.000Z'), expiresAt: null,
    },
    usages: [],
    redemptions: [],
  };
  Object.assign(state, overrides);
  operations = [];
  transactionCount = 0;
  transactionFailure = null;
  inTransaction = false;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function sameId(a, b) { return String(a) === String(b); }
function matchUsage(row, q) { return row && sameId(row.coupon, q.coupon) && sameId(row.user, q.user); }
function matchRedemption(row, q) {
  return row && (q.coupon == null || sameId(row.coupon, q.coupon)) &&
    (q.user == null || sameId(row.user, q.user)) &&
    (q.orderGroupId == null || sameId(row.orderGroupId, q.orderGroupId));
}

function makeQuery(operation, executor, shouldUseSession = true, initialSession = null) {
  let selectedSession = initialSession;
  const q = {
    select() { return this; },
    lean() { return this; },
    session(s) {
      selectedSession = s;
      operations.push({ operation: `${operation}.session`, session: s });
      return this;
    },
    then(resolve, reject) {
      Promise.resolve().then(() => {
        operations.push({ operation, session: selectedSession });
        if (typeof shouldUseSession === 'function') shouldUseSession(selectedSession);
        else if (shouldUseSession) assert.strictEqual(selectedSession, session, `${operation} must use the transaction session`);
        return executor(selectedSession);
      }).then(resolve, reject);
    },
  };
  return q;
}

const Coupon = {
  findById(id) {
    return makeQuery('Coupon.findById', () => sameId(state.coupon?._id, id) ? state.coupon : null);
  },
  findOneAndUpdate(filter, update, options = {}) {
    assert.strictEqual(options.session, session, 'Coupon.findOneAndUpdate must receive session');
    operations.push({ operation: 'Coupon.findOneAndUpdate.options', session: options.session });
    return makeQuery('Coupon.findOneAndUpdate', () => {
      const c = state.coupon;
      if (!c || !sameId(c._id, filter._id) || c.isActive !== true) return null;
      const unlimited = c.usageLimit == null;
      if (!unlimited && !(c.usedCount < c.usageLimit)) return null;
      c.usedCount += Number(update.$inc?.usedCount || 0);
      return c;
    }, true, options.session);
  },
};

const CouponUsage = {
  findOne(filter) {
    return makeQuery('CouponUsage.findOne', () => state.usages.find(x => matchUsage(x, filter)) || null);
  },
  countDocuments(filter) {
    return makeQuery('CouponUsage.countDocuments', () => state.usages.filter(x => matchUsage(x, filter)).length);
  },
  findOneAndUpdate(filter, update, options = {}) {
    assert.strictEqual(options.session, session, 'CouponUsage.findOneAndUpdate must receive session');
    operations.push({ operation: 'CouponUsage.findOneAndUpdate.options', session: options.session });
    return makeQuery('CouponUsage.findOneAndUpdate', () => {
      const row = state.usages.find(x => matchUsage(x, filter) && x.usedCount < filter.usedCount.$lt);
      if (!row) return null;
      row.usedCount += Number(update.$inc?.usedCount || 0);
      return row;
    }, true, options.session);
  },
  async create(documents, options = {}) {
    assert.strictEqual(options.session, session, 'CouponUsage.create must receive session');
    operations.push({ operation: 'CouponUsage.create', session: options.session });
    const rows = Array.isArray(documents) ? documents : [documents];
    for (const input of rows) {
      if (state.usages.some(x => matchUsage(x, input))) throw Object.assign(new Error('duplicate usage'), { code: 11000 });
      state.usages.push({ ...input });
    }
    return Array.isArray(documents) ? rows : rows[0];
  },
};

const CouponRedemption = {
  findOne(filter) {
    return makeQuery('CouponRedemption.findOne', () => state.redemptions.find(x => matchRedemption(x, filter)) || null, selected => {
      if (inTransaction) assert.strictEqual(selected, session, 'CouponRedemption.findOne must use transaction session inside transaction');
      else assert.strictEqual(selected, null, 'outside-transaction lookup should not use an expired session');
    });
  },
  countDocuments(filter) {
    return makeQuery('CouponRedemption.countDocuments', () => state.redemptions.filter(x => matchRedemption(x, filter)).length);
  },
  async create(documents, options = {}) {
    assert.strictEqual(options.session, session, 'CouponRedemption.create must receive session');
    operations.push({ operation: 'CouponRedemption.create', session: options.session });
    const rows = Array.isArray(documents) ? documents : [documents];
    for (const input of rows) {
      if (state.redemptions.some(x => sameId(x.orderGroupId, input.orderGroupId))) {
        throw Object.assign(new Error('duplicate redemption'), { code: 11000 });
      }
      state.redemptions.push({ ...input });
    }
    return Array.isArray(documents) ? rows : rows[0];
  },
};

const transactionStub = {
  async withRequiredTransaction(work) {
    transactionCount++;
    if (transactionFailure) throw transactionFailure;
    const before = clone(state);
    inTransaction = true;
    try {
      return await work(session);
    } catch (err) {
      state = before; // model an abort: no writes commit on transaction failure
      throw err;
    } finally { inTransaction = false; }
  },
};

const mocks = new Map([
  [path.join(ROOT, 'models/Coupon.js'), Coupon],
  [path.join(ROOT, 'models/CouponRedemption.js'), CouponRedemption],
  [path.join(ROOT, 'models/CouponUsage.js'), CouponUsage],
  [path.join(ROOT, 'services/dbTransaction.js'), transactionStub],
]);
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename) {
    let resolved;
    try { resolved = Module._resolveFilename(request, parent, isMain); } catch (_) { resolved = null; }
    if (resolved && mocks.has(resolved)) return mocks.get(resolved);
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { claimCouponUsage } = require(path.join(ROOT, 'services/couponUsageService.js'));
Module._load = originalLoad;

(async () => {
  let passed = 0;
  async function test(name, fn) {
    reset();
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  }

  await test('successful claim commits global, per-user, and redemption writes through one transaction', async () => {
    const redemption = await claimCouponUsage({ couponId: 'coupon-1', userId: 'user-1', orderGroupId: 'group-1', discount: 12.34 });
    assert.strictEqual(transactionCount, 1);
    assert.strictEqual(state.coupon.usedCount, 1);
    assert.deepStrictEqual(state.usages, [{ coupon: 'coupon-1', user: 'user-1', usedCount: 1 }]);
    assert.strictEqual(state.redemptions.length, 1);
    assert.strictEqual(redemption.discount, 12.34);
    assert.ok(operations.some(x => x.operation === 'Coupon.findOneAndUpdate.options'));
    assert.ok(operations.some(x => x.operation === 'CouponUsage.create'));
    assert.ok(operations.some(x => x.operation === 'CouponRedemption.create'));
  });

  await test('replaying the same order-group redemption does not increment counters', async () => {
    state.redemptions.push({ coupon: 'coupon-1', user: 'user-1', orderGroupId: 'group-existing', discount: 5 });
    state.usages.push({ coupon: 'coupon-1', user: 'user-1', usedCount: 1 });
    state.coupon.usedCount = 1;
    const result = await claimCouponUsage({ couponId: 'coupon-1', userId: 'user-1', orderGroupId: 'group-existing', discount: 5 });
    assert.strictEqual(result.orderGroupId, 'group-existing');
    assert.strictEqual(state.coupon.usedCount, 1);
    assert.strictEqual(state.usages[0].usedCount, 1);
    assert.strictEqual(state.redemptions.length, 1);
    assert.strictEqual(operations.some(x => x.operation === 'Coupon.findOneAndUpdate.options'), false);
  });

  await test('per-user limit rejection rolls back the earlier global counter claim', async () => {
    state.coupon.usedCount = 0;
    state.usages.push({ coupon: 'coupon-1', user: 'user-1', usedCount: 1 });
    state.redemptions.push({ coupon: 'coupon-1', user: 'user-1', orderGroupId: 'old-group', discount: 4 });
    await assert.rejects(
      claimCouponUsage({ couponId: 'coupon-1', userId: 'user-1', orderGroupId: 'new-group', discount: 4 }),
      err => err.statusCode === 409,
    );
    assert.strictEqual(state.coupon.usedCount, 0, 'global claim must roll back with the aborted transaction');
    assert.strictEqual(state.usages[0].usedCount, 1);
    assert.strictEqual(state.redemptions.length, 1);
  });

  await test('global usage limit rejection does not write per-user state or redemption', async () => {
    state.coupon.usedCount = state.coupon.usageLimit;
    await assert.rejects(
      claimCouponUsage({ couponId: 'coupon-1', userId: 'user-2', orderGroupId: 'group-limited', discount: 2 }),
      err => err.statusCode === 409,
    );
    assert.strictEqual(state.coupon.usedCount, state.coupon.usageLimit);
    assert.strictEqual(state.usages.length, 0);
    assert.strictEqual(state.redemptions.length, 0);
  });

  await test('transaction support unavailable fails closed before any model mutation', async () => {
    const err = Object.assign(new Error('transaction support required'), { statusCode: 503, code: 'TRANSACTION_REQUIRED' });
    transactionFailure = err;
    await assert.rejects(
      claimCouponUsage({ couponId: 'coupon-1', userId: 'user-1', orderGroupId: 'group-no-tx', discount: 2 }),
      e => e.code === 'TRANSACTION_REQUIRED' && e.statusCode === 503,
    );
    assert.strictEqual(state.coupon.usedCount, 0);
    assert.strictEqual(state.usages.length, 0);
    assert.strictEqual(state.redemptions.length, 0);
  });

  console.log(`\n${passed} coupon transaction tests passed.`);
})().catch(err => { console.error(err); process.exitCode = 1; });
