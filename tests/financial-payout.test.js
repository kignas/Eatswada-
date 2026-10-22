'use strict';

// Issue C — rider payout cannot exceed the authoritative payable balance and
// concurrent payouts cannot pay the same earnings twice.
//   node tests/financial-payout.test.js

const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startReplSet, stopReplSet, makeRes, makeReq, makeReporter } = require('./helpers/replset');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const User = require('../models/User');
const RiderLedger = require('../models/RiderLedger');
const settlementController = require('../controllers/settlementController');
const { getRiderBalance } = require('../services/settlementService');

const { test, finish } = makeReporter('Rider payout integrity');

const adminId = () => new mongoose.Types.ObjectId();
let seq = 0;

async function seedRider({ earnings = 1000, cashInHand = 0 } = {}) {
  seq += 1;
  const rider = await User.create({ name: `R${seq}`, phone: `9300000${String(seq).padStart(3, '0')}`, role: 'rider', password: 'x'.repeat(12) });
  if (cashInHand) await User.updateOne({ _id: rider._id }, { $set: { 'riderDetails.cashInHand': cashInHand } });
  if (earnings > 0) {
    await RiderLedger.create({ rider: rider._id, order: new mongoose.Types.ObjectId(), entryType: 'delivery_earning', amount: earnings, note: 'seed' });
  }
  return rider;
}

const payoutSum = async (riderId) => {
  const rows = await RiderLedger.find({ rider: riderId, entryType: 'payout' }).lean();
  return Math.round(rows.reduce((s, r) => s + Number(r.amount || 0), 0) * 100) / 100;
};

(async () => {
  await startReplSet();

  await test('C1: payout above the payable balance is rejected', async () => {
    const rider = await seedRider({ earnings: 500 });
    const res = makeRes();
    await settlementController.settleRiderPayout(makeReq({ user: { _id: adminId(), role: 'admin' }, params: { id: String(rider._id) }, body: { amount: 9999, reference: 'UTR1' } }), res);
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    assert.equal(await payoutSum(rider._id), 0, 'no payout row may be created');
    assert.equal((await getRiderBalance(rider._id)).netPayable, 500);
  });

  await test('C2: a payout within the balance succeeds and is recorded with its reference', async () => {
    const rider = await seedRider({ earnings: 500 });
    const res = makeRes();
    await settlementController.settleRiderPayout(makeReq({ user: { _id: adminId(), role: 'admin' }, params: { id: String(rider._id) }, body: { amount: 200, reference: 'UTR-OK' } }), res);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    const rows = await RiderLedger.find({ rider: rider._id, entryType: 'payout' }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, -200);
    assert.equal(rows[0].reference, 'UTR-OK');
    assert.equal((await getRiderBalance(rider._id)).netPayable, 300);
  });

  await test('C3: two concurrent payouts against the same balance cannot double-pay', async () => {
    const rider = await seedRider({ earnings: 1000 });
    const mk = () => makeReq({ user: { _id: adminId(), role: 'admin' }, params: { id: String(rider._id) }, body: { amount: 1000, reference: 'CONC' } });
    const r1 = makeRes(); const r2 = makeRes();
    await Promise.all([
      settlementController.settleRiderPayout(mk(), r1),
      settlementController.settleRiderPayout(mk(), r2),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    assert.equal(codes[0], 201, `one payout should succeed, got ${codes}`);
    assert.notEqual(codes[1], 201, `only one payout may succeed, got ${codes}`);
    assert.equal(await payoutSum(rider._id), -1000, 'exactly one full payout of 1000');
    const bal = await getRiderBalance(rider._id);
    assert.ok(bal.netPayable >= 0, `balance must never go negative (got ${bal.netPayable})`);
  });

  await test('C4: a retried payout with the same idempotency key is not paid twice', async () => {
    const rider = await seedRider({ earnings: 400 });
    const key = 'payout-key-abc';
    const body = { amount: 400, reference: 'UTR-RETRY', idempotencyKey: key };
    const r1 = makeRes();
    await settlementController.settleRiderPayout(makeReq({ user: { _id: adminId(), role: 'admin' }, params: { id: String(rider._id) }, body }), r1);
    assert.equal(r1.statusCode, 201, JSON.stringify(r1.body));
    const r2 = makeRes();
    await settlementController.settleRiderPayout(makeReq({ user: { _id: adminId(), role: 'admin' }, params: { id: String(rider._id) }, body }), r2);
    assert.equal(r2.statusCode, 409, 'duplicate request must be rejected');
    assert.equal(await payoutSum(rider._id), -400, 'only one payout row');
  });

  await test('C5: malformed / non-positive amounts are rejected', async () => {
    const rider = await seedRider({ earnings: 100 });
    // (null/omitted is the documented "pay the full balance" case, covered in C2.)
    for (const amount of [0, -5, 'abc', {}]) {
      const res = makeRes();
      await settlementController.settleRiderPayout(makeReq({ user: { _id: adminId(), role: 'admin' }, params: { id: String(rider._id) }, body: { amount, reference: 'X' } }), res);
      assert.equal(res.statusCode, 400, `amount=${JSON.stringify(amount)} should be rejected`);
    }
    assert.equal(await payoutSum(rider._id), 0);
  });

  await test('C6: no positive payable balance -> rejected', async () => {
    const rider = await seedRider({ earnings: 500, cashInHand: 500 }); // earnings fully held as cash
    const res = makeRes();
    await settlementController.settleRiderPayout(makeReq({ user: { _id: adminId(), role: 'admin' }, params: { id: String(rider._id) }, body: { reference: 'X' } }), res);
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  });

  await test('C7: missing UTR reference is rejected', async () => {
    const rider = await seedRider({ earnings: 100 });
    const res = makeRes();
    await settlementController.settleRiderPayout(makeReq({ user: { _id: adminId(), role: 'admin' }, params: { id: String(rider._id) }, body: { amount: 50 } }), res);
    assert.equal(res.statusCode, 400);
  });

  await test('C8: a non-admin cannot trigger a payout', async () => {
    const rider = await seedRider({ earnings: 100 });
    const res = makeRes();
    await settlementController.settleRiderPayout(makeReq({ user: { _id: new mongoose.Types.ObjectId(), role: 'vendor' }, params: { id: String(rider._id) }, body: { amount: 50, reference: 'X' } }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(await payoutSum(rider._id), 0);
  });

  const code = finish();
  await stopReplSet();
  process.exit(code);
})().catch(async (err) => {
  console.error('HARNESS ERROR', err);
  await stopReplSet().catch(() => {});
  process.exit(1);
});
