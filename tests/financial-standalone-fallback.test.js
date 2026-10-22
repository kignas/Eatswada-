'use strict';

// Deployment-topology safety: transactions require a replica set. Explicitly
// optional operations may use withOptionalTransaction, but financial multi-document
// delivery/deposit/settlement flows fail closed on a standalone MongoDB so no
// partial money movement can be committed.
//   node tests/financial-standalone-fallback.test.js

const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { makeRes, makeReq, makeReporter } = require('./helpers/replset');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const User = require('../models/User');
const Order = require('../models/Order');
const Restaurant = require('../models/Restaurant');
const RiderLedger = require('../models/RiderLedger');
const riderController = require('../controllers/riderController');
const { payRider, getRiderBalance } = require('../services/settlementService');
const { withOptionalTransaction, isTransactionUnsupported } = require('../services/dbTransaction');

const { test, finish } = makeReporter('Standalone (no-transaction) fallback');
let mongod = null;
let seq = 0;

(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri()); // standalone: NO replica set
  await Promise.all(Object.values(mongoose.models).map(m => m.init().catch(() => {})));

  await test('T1: withOptionalTransaction degrades gracefully on a standalone mongod', async () => {
    const Probe = mongoose.models.Probe || mongoose.model('Probe', new mongoose.Schema({ a: Number }));
    let sawSession = null;
    const result = await withOptionalTransaction(async (session) => {
      sawSession = session;
      // Touch the database so the transaction attempt actually reaches the
      // server (a standalone rejects it, forcing the fallback path).
      await Probe.create([{ a: 1 }], session ? { session } : undefined);
      return 'ran';
    });
    assert.equal(result, 'ran');
    assert.equal(sawSession, null, 'no session may be supplied on a standalone');
    assert.equal(await Probe.countDocuments(), 1, 'the work still committed');
  });

  await test('T2: a real transaction error is still surfaced (not swallowed)', async () => {
    let threw = false;
    try {
      await withOptionalTransaction(async () => { throw new Error('business failure'); });
    } catch (err) { threw = true; assert.equal(err.message, 'business failure'); }
    assert.equal(threw, true, 'non-transaction errors must propagate');
  });

  await test('T3: COD delivery fails closed on standalone MongoDB without partial financial writes', async () => {
    seq += 1;
    const owner = await User.create({ name: 'O', phone: `7000000${String(seq).padStart(3, '0')}`, role: 'vendor', password: 'x'.repeat(12) });
    const rider = await User.create({ name: 'R', phone: `7100000${String(seq).padStart(3, '0')}`, role: 'rider', password: 'x'.repeat(12) });
    const customer = await User.create({ name: 'C', phone: `7200000${String(seq).padStart(3, '0')}`, role: 'user', password: 'x'.repeat(12) });
    const rest = await Restaurant.create({ name: `S${seq}`, owner: owner._id, cuisines: ['Indian'] });
    const order = await Order.create({
      user: customer._id, restaurant: rest._id, restaurantName: rest.name,
      items: [{ menuItem: new mongoose.Types.ObjectId(), name: 'D', price: 180, quantity: 1, status: 'pending' }],
      deliveryAddress: { label: 'h', line1: '1', area: 'a', city: 'c' },
      subtotal: 180, total: 180, paymentMethod: 'cod', paymentStatus: 'cod_pending',
      status: 'out_for_delivery', rider: rider._id, riderStatus: 'out_for_delivery',
      discount: 0, vendorDiscountShare: 0, discountFunding: 'none',
      commission: { rate: 15, baseAmount: 180, amount: 27, restaurantNetAmount: 153 },
    });
    await Order.updateOne({ _id: order._id }, { $set: { deliveryOtpVerified: true } });

    const mk = () => makeReq({ user: { _id: rider._id, name: 'R', role: 'rider' }, params: { id: String(order._id) }, body: { status: 'delivered', codCashCollected: true } });
    const r1 = makeRes(); const r2 = makeRes();
    const run = (req, res) => new Promise((resolve, reject) => {
      Promise.resolve(riderController.updateAssignedOrderStatus(req, res, reject)).then(resolve, reject);
    });
    const results = await Promise.allSettled([run(mk(), r1), run(mk(), r2)]);
    assert.ok(results.some(r => r.status === 'rejected'), 'transaction-required delivery must fail closed on standalone MongoDB');
    const freshOrder = await Order.findById(order._id).lean();
    assert.notEqual(freshOrder.status, 'delivered', 'order must not be marked delivered without transaction support');
    const cash = Number((await User.findById(rider._id).select('riderDetails.cashInHand').lean()).riderDetails.cashInHand || 0);
    assert.equal(cash, 0, 'cash balance must remain unchanged');
    const earn = await RiderLedger.countDocuments({ order: order._id, entryType: 'delivery_earning' });
    assert.equal(earn, 0, 'no ledger entry may be committed without a completed delivery');
  });

  await test('T4: payouts cannot exceed the balance without a transaction', async () => {
    seq += 1;
    const rider = await User.create({ name: 'R2', phone: `7300000${String(seq).padStart(3, '0')}`, role: 'rider', password: 'x'.repeat(12) });
    await RiderLedger.create({ rider: rider._id, order: new mongoose.Types.ObjectId(), entryType: 'delivery_earning', amount: 600 });
    const over = await payRider({ riderId: rider._id, requestedAmount: 5000, reference: 'UTR' });
    assert.equal(over.ok, false);
    assert.equal(over.reason, 'exceeds_balance');
    assert.equal((await getRiderBalance(rider._id)).netPayable, 600);
  });

  const code = finish();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
  process.exit(code);
})().catch(async (err) => {
  console.error('HARNESS ERROR', err);
  await mongoose.disconnect().catch(() => {});
  if (mongod) await mongod.stop().catch(() => {});
  process.exit(1);
});
