'use strict';

// Issue D — discount funding split (platform / restaurant / shared / none /
// historical) and Issue F — settlement batch integrity (single restaurant,
// no double settlement, transactional failure, authorization).
//   node tests/financial-settlement.test.js

const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startReplSet, stopReplSet, makeRes, makeReq, makeReporter } = require('./helpers/replset');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const User = require('../models/User');
const Order = require('../models/Order');
const Restaurant = require('../models/Restaurant');
const SettlementLedger = require('../models/SettlementLedger');
const SettlementBatch = require('../models/SettlementBatch');
const AdminAuditLog = require('../models/AdminAuditLog');
const settlementController = require('../controllers/settlementController');
const { ensureOrderLedger, getRestaurantSettlementStatement } = require('../services/settlementService');

const { test, finish } = makeReporter('Settlement / discount funding integrity');
const adminId = () => new mongoose.Types.ObjectId();
let seq = 0;

async function seedOrder({ subtotal = 1000, discount = 0, vendorDiscountShare, discountFunding = 'none', rate = 15, paymentStatus = 'paid' } = {}) {
  seq += 1;
  const owner = await User.create({ name: 'Owner', phone: `9400000${String(seq).padStart(3, '0')}`, role: 'vendor', password: 'x'.repeat(12) });
  const customer = await User.create({ name: 'Cust', phone: `9500000${String(seq).padStart(3, '0')}`, role: 'user', password: 'x'.repeat(12) });
  const restaurant = await Restaurant.create({ name: `R${seq}`, owner: owner._id, cuisines: ['Indian'] });
  const commissionAmount = Math.round(subtotal * rate) / 100;
  const order = await Order.create({
    user: customer._id,
    restaurant: restaurant._id,
    restaurantName: restaurant.name,
    items: [{ menuItem: new mongoose.Types.ObjectId(), name: 'Dish', price: subtotal, quantity: 1, status: 'pending' }],
    deliveryAddress: { label: 'Home', line1: '1', area: 'Maynaguri', city: 'Maynaguri' },
    subtotal,
    total: subtotal,
    discount,
    ...(vendorDiscountShare !== undefined ? { vendorDiscountShare } : {}),
    discountFunding,
    paymentMethod: 'upi',
    paymentStatus,
    status: 'delivered',
    commission: { rate, baseAmount: subtotal, amount: commissionAmount, restaurantNetAmount: subtotal - commissionAmount },
  });
  return { owner, customer, restaurant, order };
}

const ledgerFor = async (orderId) => SettlementLedger.findOne({ order: orderId, source: 'order_delivery' }).lean();

(async () => {
  await startReplSet();

  await test('D1: platform-funded discount is not charged to the vendor', async () => {
    const { order } = await seedOrder({ subtotal: 1000, discount: 200, vendorDiscountShare: 0, discountFunding: 'platform' });
    await ensureOrderLedger(order);
    const l = await ledgerFor(order._id);
    assert.equal(l.vendorDiscountShare, 0);
    assert.equal(l.netVendorPayable, 850, 'vendor keeps full commission base minus commission');
  });

  await test('D2: restaurant-funded discount is fully charged to the vendor', async () => {
    const { order } = await seedOrder({ subtotal: 1000, discount: 200, vendorDiscountShare: 200, discountFunding: 'restaurant' });
    await ensureOrderLedger(order);
    const l = await ledgerFor(order._id);
    assert.equal(l.vendorDiscountShare, 200);
    assert.equal(l.netVendorPayable, 650, '850 - 200');
  });

  await test('D3: shared discount splits the charge', async () => {
    const { order } = await seedOrder({ subtotal: 1000, discount: 200, vendorDiscountShare: 100, discountFunding: 'shared' });
    await ensureOrderLedger(order);
    const l = await ledgerFor(order._id);
    assert.equal(l.vendorDiscountShare, 100);
    assert.equal(l.netVendorPayable, 750, '850 - 100');
  });

  await test('D4: no discount leaves the vendor payable untouched', async () => {
    const { order } = await seedOrder({ subtotal: 1000, discount: 0, vendorDiscountShare: 0, discountFunding: 'none' });
    await ensureOrderLedger(order);
    const l = await ledgerFor(order._id);
    assert.equal(l.vendorDiscountShare, 0);
    assert.equal(l.netVendorPayable, 850);
  });

  await test('D5: historical order without split metadata keeps legacy (whole discount to vendor)', async () => {
    const { order } = await seedOrder({ subtotal: 1000, discount: 200, discountFunding: 'none' }); // no vendorDiscountShare
    const raw = await Order.findById(order._id).lean();
    assert.equal(raw.vendorDiscountShare, null, 'field must be absent/null on a historical-style order');
    await ensureOrderLedger(order);
    const l = await ledgerFor(order._id);
    assert.equal(l.vendorDiscountShare, 200, 'legacy fallback charges the whole discount to the vendor');
    assert.equal(l.netVendorPayable, 650);
  });

  await test('D6: settlement statement totals reconcile with the ledger', async () => {
    // One restaurant, two orders: a shared discount and a plain order.
    const first = await seedOrder({ subtotal: 1000, discount: 200, vendorDiscountShare: 100, discountFunding: 'shared' });
    await ensureOrderLedger(first.order);
    const second = await seedOrder({ subtotal: 500, discount: 0, vendorDiscountShare: 0, discountFunding: 'none' });
    // Re-point the second order at the first restaurant so the statement covers both.
    await Order.updateOne({ _id: second.order._id }, { $set: { restaurant: first.restaurant._id } });
    const secondFresh = await Order.findById(second.order._id);
    await ensureOrderLedger(secondFresh);

    const statement = await getRestaurantSettlementStatement(first.restaurant._id);
    assert.equal(statement.orders.length, 2);
    // grossFoodBill 1000 + 500 = 1500; commission 150 + 75 = 225;
    // vendorDiscountShare 100 + 0 = 100; net payable 750 + 425 = 1175.
    assert.equal(statement.totals.grossFoodBill, 1500);
    assert.equal(statement.totals.commissionAmount, 225);
    assert.equal(statement.totals.vendorDiscountShare, 100);
    assert.equal(statement.totals.netVendorPayable, 1175);
    assert.equal(statement.unsettledBalance, 1175);
  });

  await test('F1: a batch mixing two restaurants is rejected', async () => {
    const a = await seedOrder({ subtotal: 1000, vendorDiscountShare: 0 });
    const b = await seedOrder({ subtotal: 1000, vendorDiscountShare: 0 });
    await ensureOrderLedger(a.order); await ensureOrderLedger(b.order);
    const la = await ledgerFor(a.order._id); const lb = await ledgerFor(b.order._id);
    const res = makeRes();
    await settlementController.createSettlementBatch(makeReq({ user: { _id: adminId(), role: 'admin' }, body: { ledgerIds: [String(la._id), String(lb._id)], reference: 'UTR-MIX' } }), res);
    assert.equal(res.statusCode, 400, JSON.stringify(res.body));
    // Neither entry may be settled.
    assert.equal((await SettlementLedger.findById(la._id).lean()).status, 'eligible');
    assert.equal((await SettlementLedger.findById(lb._id).lean()).status, 'eligible');
  });

  await test('F2: an already-settled entry cannot be settled again', async () => {
    const a = await seedOrder({ subtotal: 1000, vendorDiscountShare: 0 });
    await ensureOrderLedger(a.order);
    const la = await ledgerFor(a.order._id);
    const res1 = makeRes();
    await settlementController.createSettlementBatch(makeReq({ user: { _id: adminId(), role: 'admin' }, body: { ledgerIds: [String(la._id)], reference: 'UTR-1' } }), res1);
    assert.equal(res1.statusCode, 201, JSON.stringify(res1.body));
    const res2 = makeRes();
    await settlementController.createSettlementBatch(makeReq({ user: { _id: adminId(), role: 'admin' }, body: { ledgerIds: [String(la._id)], reference: 'UTR-2' } }), res2);
    assert.equal(res2.statusCode, 409, 'double settlement must be refused');
    assert.equal(await SettlementBatch.countDocuments({ restaurant: a.restaurant._id }), 1);
  });

  await test('F3: a UTR/reference is required', async () => {
    const a = await seedOrder({ subtotal: 1000, vendorDiscountShare: 0 });
    await ensureOrderLedger(a.order);
    const la = await ledgerFor(a.order._id);
    const res = makeRes();
    await settlementController.createSettlementBatch(makeReq({ user: { _id: adminId(), role: 'admin' }, body: { ledgerIds: [String(la._id)] } }), res);
    assert.equal(res.statusCode, 400);
  });

  await test('F4: a failure mid-batch leaves no half-settled batch (transaction rollback)', async () => {
    const a = await seedOrder({ subtotal: 1000, vendorDiscountShare: 0 });
    await ensureOrderLedger(a.order);
    const la = await ledgerFor(a.order._id);
    const before = await SettlementBatch.countDocuments({});
    // Force the ledger update to fail by making the model throw once.
    const orig = SettlementLedger.updateMany;
    SettlementLedger.updateMany = async () => { throw new Error('simulated ledger write failure'); };
    let res = makeRes();
    try {
      await settlementController.createSettlementBatch(makeReq({ user: { _id: adminId(), role: 'admin' }, body: { ledgerIds: [String(la._id)], reference: 'UTR-FAIL' } }), res);
    } finally {
      SettlementLedger.updateMany = orig;
    }
    assert.equal(res.statusCode, 500, JSON.stringify(res.body));
    assert.equal(await SettlementBatch.countDocuments({}), before, 'no batch may be left behind');
    assert.equal((await SettlementLedger.findById(la._id).lean()).status, 'eligible', 'entry must remain eligible');
  });

  await test('F5: two concurrent settlement requests settle an entry only once', async () => {
    const a = await seedOrder({ subtotal: 1000, vendorDiscountShare: 0 });
    await ensureOrderLedger(a.order);
    const la = await ledgerFor(a.order._id);
    const mk = () => makeReq({ user: { _id: adminId(), role: 'admin' }, body: { ledgerIds: [String(la._id)], reference: 'UTR-CONC' } });
    const r1 = makeRes(); const r2 = makeRes();
    await Promise.all([
      settlementController.createSettlementBatch(mk(), r1),
      settlementController.createSettlementBatch(mk(), r2),
    ]);
    const successes = [r1, r2].filter(r => r.statusCode === 201).length;
    assert.equal(successes, 1, `exactly one settlement should succeed, got ${[r1.statusCode, r2.statusCode]}`);
    assert.equal(await SettlementBatch.countDocuments({ restaurant: a.restaurant._id }), 1);
  });

  await test('F6: a non-admin cannot create a settlement batch', async () => {
    const a = await seedOrder({ subtotal: 1000, vendorDiscountShare: 0 });
    await ensureOrderLedger(a.order);
    const la = await ledgerFor(a.order._id);
    const res = makeRes();
    await settlementController.createSettlementBatch(makeReq({ user: { _id: new mongoose.Types.ObjectId(), role: 'vendor' }, body: { ledgerIds: [String(la._id)], reference: 'X' } }), res);
    assert.equal(res.statusCode, 403);
    assert.equal((await SettlementLedger.findById(la._id).lean()).status, 'eligible');
  });

  await test('F7: successful batch is audited', async () => {
    const a = await seedOrder({ subtotal: 1000, vendorDiscountShare: 0 });
    await ensureOrderLedger(a.order);
    const la = await ledgerFor(a.order._id);
    const before = await AdminAuditLog.countDocuments({ action: 'settlement.batch.create' });
    const res = makeRes();
    await settlementController.createSettlementBatch(makeReq({ user: { _id: adminId(), role: 'admin' }, body: { ledgerIds: [String(la._id)], reference: 'UTR-AUDIT' } }), res);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    const after = await AdminAuditLog.countDocuments({ action: 'settlement.batch.create' });
    assert.equal(after, before + 1, 'exactly one audit row added for this batch');
  });

  const code = finish();
  await stopReplSet();
  process.exit(code);
})().catch(async (err) => {
  console.error('HARNESS ERROR', err);
  await stopReplSet().catch(() => {});
  process.exit(1);
});
