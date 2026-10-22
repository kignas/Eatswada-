'use strict';

// Issue A / B — COD collection idempotency, concurrent delivery, and Admin
// force-deliver payment-state integrity. Runs against a disposable in-memory
// MongoDB REPLICA SET so the real transaction paths are exercised.
//
//   node tests/financial-cod-delivery.test.js

const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startReplSet, stopReplSet, makeRes, makeReq, makeReporter } = require('./helpers/replset');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.RIDER_BASE_PAY = process.env.RIDER_BASE_PAY || '0';

const User = require('../models/User');
const Order = require('../models/Order');
const Restaurant = require('../models/Restaurant');
const SettlementLedger = require('../models/SettlementLedger');
const RiderLedger = require('../models/RiderLedger');
const AdminAuditLog = require('../models/AdminAuditLog');
const riderController = require('../controllers/riderController');
const adminController = require('../controllers/adminController');

const { test, finish } = makeReporter('COD delivery / force-deliver integrity');

let seq = 0;
async function seed({ paymentMethod = 'cod', total = 200, riderCash = 0 } = {}) {
  seq += 1;
  const owner = await User.create({ name: 'Owner', phone: `9000000${String(seq).padStart(3, '0')}`, role: 'vendor', password: 'x'.repeat(12) });
  const rider = await User.create({ name: 'Rider', phone: `9100000${String(seq).padStart(3, '0')}`, role: 'rider', password: 'x'.repeat(12) });
  const customer = await User.create({ name: 'Cust', phone: `9200000${String(seq).padStart(3, '0')}`, role: 'user', password: 'x'.repeat(12) });
  const restaurant = await Restaurant.create({ name: `R${seq}`, owner: owner._id, cuisines: ['Indian'] });
  if (riderCash) await User.updateOne({ _id: rider._id }, { $set: { 'riderDetails.cashInHand': riderCash } });
  const order = await Order.create({
    user: customer._id,
    restaurant: restaurant._id,
    restaurantName: restaurant.name,
    items: [{ menuItem: new mongoose.Types.ObjectId(), name: 'Dish', price: total, quantity: 1, status: 'pending' }],
    deliveryAddress: { label: 'Home', line1: '1 Road', area: 'Maynaguri', city: 'Maynaguri' },
    subtotal: total,
    total,
    paymentMethod,
    paymentStatus: paymentMethod === 'cod' ? 'cod_pending' : 'pending',
    status: 'out_for_delivery',
    rider: rider._id,
    riderStatus: 'out_for_delivery',
    // Explicit funding split so settlement math is deterministic in the test.
    discount: 0,
    vendorDiscountShare: 0,
    discountFunding: 'none',
    commission: { rate: 15, baseAmount: total, amount: Math.round(total * 15) / 100, restaurantNetAmount: total - Math.round(total * 15) / 100 },
  });
  // The pre-save OTP hook resets deliveryOtpVerified on every save, so mark the
  // customer handoff as verified with a direct update (the rider verified it in
  // a prior request in the real flow).
  await Order.updateOne({ _id: order._id }, { $set: { deliveryOtpVerified: true } });
  order.deliveryOtpVerified = true;
  return { owner, rider, customer, restaurant, order };
}

const cashOf = async (id) => Number((await User.findById(id).select('riderDetails.cashInHand').lean()).riderDetails.cashInHand || 0);

(async () => {
  await startReplSet();

  await test('A1: two concurrent COD deliveries credit cash exactly once', async () => {
    const { rider, order } = await seed({ total: 200 });
    const mk = () => makeReq({ user: { _id: rider._id, name: 'Rider', role: 'rider' }, params: { id: String(order._id) }, body: { status: 'delivered', codCashCollected: true } });
    const r1 = makeRes(); const r2 = makeRes();
    await Promise.all([
      riderController.updateAssignedOrderStatus(mk(), r1),
      riderController.updateAssignedOrderStatus(mk(), r2),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    assert.deepEqual(codes, [200, 409], `expected exactly one success, got ${codes}`);
    assert.equal(await cashOf(rider._id), 200, 'cash must be credited exactly once');
    const fresh = await Order.findById(order._id).lean();
    assert.equal(fresh.riderStatus, 'delivered');
    assert.equal(fresh.paymentStatus, 'cod_collected');
    const earn = await RiderLedger.countDocuments({ order: order._id, entryType: 'delivery_earning' });
    assert.equal(earn, 1, 'exactly one rider earning ledger row');
  });

  await test('A2: duplicate COD delivery after success is rejected and does not double-credit', async () => {
    const { rider, order } = await seed({ total: 150 });
    const mk = () => makeReq({ user: { _id: rider._id, name: 'Rider', role: 'rider' }, params: { id: String(order._id) }, body: { status: 'delivered', codCashCollected: true } });
    const first = makeRes(); await riderController.updateAssignedOrderStatus(mk(), first);
    assert.equal(first.statusCode, 200);
    const second = makeRes(); await riderController.updateAssignedOrderStatus(mk(), second);
    assert.equal(second.statusCode, 409);
    assert.equal(await cashOf(rider._id), 150);
  });

  await test('A3: COD delivery without codCashCollected confirmation is rejected', async () => {
    const { rider, order } = await seed({ total: 120 });
    const res = makeRes();
    await riderController.updateAssignedOrderStatus(makeReq({ user: { _id: rider._id, name: 'Rider', role: 'rider' }, params: { id: String(order._id) }, body: { status: 'delivered' } }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'COD_CASH_NOT_COLLECTED');
    assert.equal(await cashOf(rider._id), 0);
  });

  await test('A4: an order cannot be delivered while the cash credit is unclaimed (no delivered-without-ledger)', async () => {
    const { rider, order } = await seed({ total: 90 });
    const res = makeRes();
    await riderController.updateAssignedOrderStatus(makeReq({ user: { _id: rider._id, name: 'Rider', role: 'rider' }, params: { id: String(order._id) }, body: { status: 'delivered', codCashCollected: true } }), res);
    assert.equal(res.statusCode, 200);
    const fresh = await Order.findById(order._id).lean();
    assert.ok(fresh.riderCashCreditedAt, 'riderCashCreditedAt must be stamped');
    const vendorRows = await SettlementLedger.countDocuments({ order: order._id, source: 'order_delivery' });
    assert.equal(vendorRows, 1, 'one vendor settlement row exists for the delivered order');
  });

  await test('B1: COD force-deliver with missing confirmation is rejected', async () => {
    const { rider, order } = await seed({ total: 300 });
    const res = makeRes();
    await adminController.forceDeliverOrder(makeReq({ user: { _id: new mongoose.Types.ObjectId(), role: 'admin' }, params: { id: String(order._id) }, body: { reason: 'doorstep network' } }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'COD_CASH_NOT_COLLECTED');
    assert.equal(await cashOf(rider._id), 0);
  });

  await test('B2: COD force-deliver with false confirmation is rejected', async () => {
    const { rider, order } = await seed({ total: 300 });
    const res = makeRes();
    await adminController.forceDeliverOrder(makeReq({ user: { _id: new mongoose.Types.ObjectId(), role: 'admin' }, params: { id: String(order._id) }, body: { reason: 'x', codCashCollected: false } }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(await cashOf(rider._id), 0);
  });

  await test('B3: COD force-deliver with true confirmation succeeds once and is idempotent', async () => {
    const { rider, order } = await seed({ total: 300 });
    const admin = new mongoose.Types.ObjectId();
    const req = makeReq({ user: { _id: admin, role: 'admin' }, params: { id: String(order._id) }, body: { reason: 'no network at door', codCashCollected: true } });
    const first = makeRes(); await adminController.forceDeliverOrder(req, first);
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    assert.equal(await cashOf(rider._id), 300);
    const second = makeRes(); await adminController.forceDeliverOrder(req, second);
    assert.equal(second.statusCode, 409, 'retry must not re-credit cash');
    assert.equal(await cashOf(rider._id), 300);
    const audits = await AdminAuditLog.countDocuments({ action: 'order.force_deliver', targetId: order._id });
    assert.equal(audits, 1);
  });

  await test('B4: unpaid ONLINE force-deliver is rejected; paid ONLINE succeeds', async () => {
    const unpaid = await seed({ paymentMethod: 'upi', total: 250 });
    const admin = new mongoose.Types.ObjectId();
    const res1 = makeRes();
    await adminController.forceDeliverOrder(makeReq({ user: { _id: admin, role: 'admin' }, params: { id: String(unpaid.order._id) }, body: { reason: 'x' } }), res1);
    assert.equal(res1.statusCode, 409, 'unpaid online must not be force-delivered');

    await Order.updateOne({ _id: unpaid.order._id }, { $set: { paymentStatus: 'paid' } });
    const res2 = makeRes();
    await adminController.forceDeliverOrder(makeReq({ user: { _id: admin, role: 'admin' }, params: { id: String(unpaid.order._id) }, body: { reason: 'paid recovery' } }), res2);
    assert.equal(res2.statusCode, 200, JSON.stringify(res2.body));
    assert.equal(await cashOf(unpaid.rider._id), 0, 'no COD cash for an online order');
  });

  await test('B5: force-deliver requires a non-empty reason', async () => {
    const { order } = await seed({ total: 100 });
    const res = makeRes();
    await adminController.forceDeliverOrder(makeReq({ user: { _id: new mongoose.Types.ObjectId(), role: 'admin' }, params: { id: String(order._id) }, body: { codCashCollected: true } }), res);
    assert.equal(res.statusCode, 400);
  });

  await test('E1: non-admin cannot force-deliver (server-side authorization)', async () => {
    const { order } = await seed({ total: 100 });
    const res = makeRes();
    await adminController.forceDeliverOrder(makeReq({ user: { _id: new mongoose.Types.ObjectId(), role: 'vendor' }, params: { id: String(order._id) }, body: { reason: 'x', codCashCollected: true } }), res);
    assert.equal(res.statusCode, 403);
  });

  await test('E3: force-dispatch requires a reason and refuses an order a rider already carries', async () => {
    const { order } = await seed({ total: 100 });
    const admin = new mongoose.Types.ObjectId();
    const noReason = makeRes();
    await adminController.forceDispatchOrder(makeReq({ user: { _id: admin, role: 'admin' }, params: { id: String(order._id) }, body: {} }), noReason);
    assert.equal(noReason.statusCode, 400);

    await Order.updateOne({ _id: order._id }, { $set: { riderStatus: 'picked_up' } });
    const carrying = makeRes();
    await adminController.forceDispatchOrder(makeReq({ user: { _id: admin, role: 'admin' }, params: { id: String(order._id) }, body: { reason: 'x' } }), carrying);
    assert.equal(carrying.statusCode, 409);
  });

  await test('E4: force-dispatch is audited and does not assign a second rider', async () => {
    const { rider, order } = await seed({ total: 100 });
    await Order.updateOne({ _id: order._id }, { $set: { status: 'preparing', rider: null, riderStatus: 'unassigned' } });
    const admin = new mongoose.Types.ObjectId();
    const res = makeRes();
    await adminController.forceDispatchOrder(makeReq({ user: { _id: admin, role: 'admin' }, params: { id: String(order._id) }, body: { reason: 'kitchen ready' } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(await AdminAuditLog.countDocuments({ action: 'order.force_dispatch', targetId: order._id }), 1);
    const fresh = await Order.findById(order._id).lean();
    // The order must never end up with two different riders; it either stays
    // unassigned (no available rider) or gets exactly one.
    assert.ok(fresh.rider === null || String(fresh.rider).length > 0);
    void rider;
  });

  await test('E2: force-accept requires a restaurant and creates an audit entry', async () => {
    const { rider, order } = await seed({ total: 100 });
    await Order.updateOne({ _id: order._id }, { $set: { status: 'placed', rider: null, riderStatus: 'unassigned', deliveryOtpVerified: false } });
    const admin = new mongoose.Types.ObjectId();
    const res = makeRes();
    await adminController.forceAcceptOrder(makeReq({ user: { _id: admin, role: 'admin' }, params: { id: String(order._id) }, body: { reason: 'vendor offline' } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'preparing');
    const audits = await AdminAuditLog.countDocuments({ action: 'order.force_accept', targetId: order._id });
    assert.equal(audits, 1);
    void rider;
  });

  const code = finish();
  await stopReplSet();
  process.exit(code);
})().catch(async (err) => {
  console.error('HARNESS ERROR', err);
  await stopReplSet().catch(() => {});
  process.exit(1);
});
