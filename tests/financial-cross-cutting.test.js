'use strict';

// Cross-cutting financial-integrity checks:
//   • COD reconciliation (deposit once, cash limit, concurrent deposit+delivery)
//   • Refund integrity (idempotent, capped, COD vs UPI)
//   • Checkout discount-funding snapshot on the order
//   node tests/financial-cross-cutting.test.js

const assert = require('node:assert/strict');
const path = require('path');
const mongoose = require('mongoose');
const { startReplSet, stopReplSet, makeRes, makeReq, makeReporter } = require('./helpers/replset');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Stub the Razorpay-backed payment service so refund flows can be exercised
// without any gateway credentials. The refund LOGIC under test is unchanged.
const refundCalls = [];
const ROOT = path.join(__dirname, '..');
const paymentServicePath = path.join(ROOT, 'services/paymentService.js');
require.cache[paymentServicePath] = {
  id: paymentServicePath, filename: paymentServicePath, loaded: true,
  exports: {
    refundPayment: async (pid, amount, notes) => { refundCalls.push({ pid, amount, notes }); return { id: `rfnd_${refundCalls.length}`, status: 'processed' }; },
    fetchPayment: async (pid) => ({ fee: 0, tax: 0, amount: Math.round(amountOf(pid) * 100) }),
    assertConfigured() {},
  },
};
// helper used above before definition is fine at call time
let _amountByPid = {};
function amountOf(pid) { return _amountByPid[pid] || 0; }

const User = require('../models/User');
const Order = require('../models/Order');
const Restaurant = require('../models/Restaurant');
const SettlementLedger = require('../models/SettlementLedger');
const RiderLedger = require('../models/RiderLedger');
const { recordCodCashDeposit, getRiderBalance, creditRiderCashForOrder } = require('../services/settlementService');
const { initiateOrderRefund, initiateSupportRefund } = require('../services/refundService');
const { findBestAvailableRider } = require('../services/riderAssignmentService');

const { test, finish } = makeReporter('Cross-cutting financial integrity');
let seq = 0;

async function seed({ paymentMethod = 'cod', total = 300, status = 'out_for_delivery', paymentStatus, riderCash = 0 } = {}) {
  seq += 1;
  const owner = await User.create({ name: 'Owner', phone: `9600000${String(seq).padStart(3, '0')}`, role: 'vendor', password: 'x'.repeat(12) });
  const rider = await User.create({ name: 'Rider', phone: `9700000${String(seq).padStart(3, '0')}`, role: 'rider', password: 'x'.repeat(12) });
  const customer = await User.create({ name: 'Cust', phone: `9800000${String(seq).padStart(3, '0')}`, role: 'user', password: 'x'.repeat(12) });
  const restaurant = await Restaurant.create({ name: `R${seq}`, owner: owner._id, cuisines: ['Indian'] });
  if (riderCash) await User.updateOne({ _id: rider._id }, { $set: { 'riderDetails.cashInHand': riderCash } });
  const order = await Order.create({
    user: customer._id, restaurant: restaurant._id, restaurantName: restaurant.name,
    items: [{ menuItem: new mongoose.Types.ObjectId(), name: 'Dish', price: total, quantity: 1, status: 'pending' }],
    deliveryAddress: { label: 'Home', line1: '1', area: 'Maynaguri', city: 'Maynaguri' },
    subtotal: total, total, paymentMethod,
    paymentStatus: paymentStatus || (paymentMethod === 'cod' ? 'cod_pending' : 'paid'),
    status, rider: rider._id, riderStatus: 'delivered',
    discount: 0, vendorDiscountShare: 0, discountFunding: 'none',
    commission: { rate: 15, baseAmount: total, amount: Math.round(total * 15) / 100, restaurantNetAmount: total - Math.round(total * 15) / 100 },
  });
  return { owner, rider, customer, restaurant, order };
}

const cashOf = async (id) => Number((await User.findById(id).select('riderDetails.cashInHand').lean()).riderDetails.cashInHand || 0);

// ── End-to-end checkout harness (real controller, in-memory replica set) ──
const Menu = require('../models/Menu');
const Address = require('../models/Address');
const Coupon = require('../models/Coupon');
const orderController = require('../controllers/orderController');

async function invoke(handler, req) {
  const res = makeRes();
  let error = null;
  await new Promise((resolve) => {
    const next = (err) => { error = err || null; resolve(); };
    const maybe = handler(req, res, next);
    if (maybe && typeof maybe.then === 'function') maybe.then(() => resolve(), () => resolve());
    else resolve();
  });
  if (error) throw error;
  return res;
}

async function runCheckout({ fundedBy, restaurantSharePercent = 0, value = 200, price = 1000 }) {
  seq += 1;
  const owner = await User.create({ name: 'Owner', phone: `8800000${String(seq).padStart(3, '0')}`, role: 'vendor', password: 'x'.repeat(12) });
  const customer = await User.create({ name: 'Cust', phone: `8900000${String(seq).padStart(3, '0')}`, role: 'user', password: 'x'.repeat(12) });
  const restaurant = await Restaurant.create({
    name: `Chk${seq}`, owner: owner._id, cuisines: ['Indian'], isActive: true,
    location: { type: 'Point', coordinates: [88.8210, 26.5610] },
  });
  const menu = await Menu.create({ name: 'Dish', price, inStock: true, restaurantId: restaurant._id });
  const address = await Address.create({
    user: customer._id, tag: 'Home', house: '12', area: 'Maynaguri', city: 'Maynaguri', pincode: '735224',
    location: { type: 'Point', coordinates: [88.8200, 26.5600] },
  });
  const coupon = await Coupon.create({
    code: `FUND${seq}`, type: 'fixed', value, fundedBy, restaurantSharePercent,
    minSubtotal: 0, perUserLimit: 5, isActive: true,
  });
  const res = await invoke(orderController.createOrder, {
    user: { _id: customer._id, name: customer.name, role: 'user' },
    headers: {},
    body: {
      items: [{ menuItem: String(menu._id), quantity: 1 }],
      addressId: String(address._id),
      paymentMethod: 'cod',
      couponCode: coupon.code,
    },
  });
  const order = await Order.findOne({ user: customer._id }).sort({ createdAt: -1 }).lean();
  if (!order) throw new Error(`checkout failed: ${JSON.stringify(res.body)}`);
  return { order, res };
}

(async () => {
  await startReplSet();

  // ── COD reconciliation ───────────────────────────────────────────────
  await test('X1: a COD deposit reduces cashInHand exactly once', async () => {
    const { rider } = await seed({ riderCash: 500 });
    const entry = await recordCodCashDeposit({ riderId: rider._id, amount: 200, reference: 'DEP1', adminId: new mongoose.Types.ObjectId() });
    assert.ok(entry);
    assert.equal(await cashOf(rider._id), 300);
    assert.equal(entry.amount, -200);
  });

  await test('X2: a deposit larger than the cash held is capped (never negative)', async () => {
    const { rider } = await seed({ riderCash: 100 });
    await recordCodCashDeposit({ riderId: rider._id, amount: 999, reference: 'DEP2' });
    assert.equal(await cashOf(rider._id), 0);
  });

  await test('X3: concurrent deposits cannot drive cash negative', async () => {
    const { rider } = await seed({ riderCash: 300 });
    await Promise.all([
      recordCodCashDeposit({ riderId: rider._id, amount: 300, reference: 'A' }),
      recordCodCashDeposit({ riderId: rider._id, amount: 300, reference: 'B' }),
    ]);
    const cash = await cashOf(rider._id);
    assert.ok(cash >= 0, `cash must never go negative (got ${cash})`);
    assert.equal(cash, 0, 'both deposits together can remove at most the 300 held');
  });

  await test('X4: a COD order can never be credited twice, even racing a delivery', async () => {
    const { rider, order } = await seed({ total: 250 });
    await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: 'cod_collected', codCashCollectedAmount: 250, cashCollected: true } });
    const fresh = await Order.findById(order._id);
    await Promise.all([
      creditRiderCashForOrder(fresh),
      creditRiderCashForOrder(fresh),
    ]);
    assert.equal(await cashOf(rider._id), 250, 'exactly one credit');
  });

  await test('X5: a missing rider account rolls back the COD credit marker', async () => {
    const { rider, order } = await seed({ total: 125 });
    await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: 'cod_collected', codCashCollectedAmount: 125, cashCollected: true } });
    const fresh = await Order.findById(order._id);
    await User.deleteOne({ _id: rider._id });
    await assert.rejects(() => creditRiderCashForOrder(fresh), /rider account is missing or invalid/i);
    const persisted = await Order.findById(order._id).lean();
    assert.equal(persisted.riderCashCreditedAt, null, 'failed credit must not leave a claimed marker');
  });

  await test('X6a: COD cash limit excludes a rider from COD dispatch but not prepaid', async () => {
    seq += 1;
    const atLimit = await User.create({
      name: 'Full', phone: `9900000${String(seq).padStart(3, '0')}`, role: 'rider', password: 'x'.repeat(12),
      riderDetails: { isOnline: true, cashInHand: 2000, codCashLimit: 2000, currentLocation: { coordinates: [88.82, 26.56], updatedAt: new Date() } },
    });
    const rest = await Restaurant.create({ name: `RX${seq}`, owner: new mongoose.Types.ObjectId(), cuisines: ['Indian'], location: { type: 'Point', coordinates: [88.8210, 26.5610] } });
    const order = { restaurant: rest._id, deliveryAddress: {}, paymentMethod: 'cod' };
    const codPick = await findBestAvailableRider(order, [], { paymentMethod: 'cod' });
    assert.equal(codPick.rider, null, 'rider at COD cash limit must be excluded from COD dispatch');
    const upiPick = await findBestAvailableRider({ ...order, paymentMethod: 'upi' }, [], { paymentMethod: 'upi' });
    assert.ok(upiPick.rider && String(upiPick.rider._id) === String(atLimit._id), 'rider must still receive prepaid orders');
  });

  // ── Refund integrity ─────────────────────────────────────────────────
  await test('X6b: a repeated cancellation refund is issued only once', async () => {
    refundCalls.length = 0;
    const { order } = await seed({ paymentMethod: 'upi', total: 400, status: 'cancelled', paymentStatus: 'paid' });
    await Order.updateOne({ _id: order._id }, { $set: { razorpayPaymentId: 'pay_X6', refund: { status: 'none' } } });
    _amountByPid['pay_X6'] = 400;
    const doc = await Order.findById(order._id);
    await initiateOrderRefund(doc, 'cancelled');
    const doc2 = await Order.findById(order._id);
    await initiateOrderRefund(doc2, 'cancelled again');
    assert.equal(refundCalls.length, 1, 'Razorpay must be called exactly once');
    assert.equal(refundCalls[0].amount, 400);
  });

  await test('X7: a support refund cannot exceed the order total', async () => {
    refundCalls.length = 0;
    const { order } = await seed({ paymentMethod: 'upi', total: 300, status: 'delivered', paymentStatus: 'paid' });
    await Order.updateOne({ _id: order._id }, { $set: { razorpayPaymentId: 'pay_X7', supportRefund: { status: 'none' } } });
    _amountByPid['pay_X7'] = 300;
    const r = await initiateSupportRefund(order._id, 9999, 'goodwill');
    assert.equal(r.refunded, true);
    assert.equal(refundCalls[0].amount, 300, 'refund capped at the order total');
  });

  await test('X8: a repeated support refund is issued only once', async () => {
    refundCalls.length = 0;
    const { order } = await seed({ paymentMethod: 'upi', total: 200, status: 'delivered', paymentStatus: 'paid' });
    await Order.updateOne({ _id: order._id }, { $set: { razorpayPaymentId: 'pay_X8', supportRefund: { status: 'none' } } });
    _amountByPid['pay_X8'] = 200;
    await initiateSupportRefund(order._id, 100, 'once');
    await initiateSupportRefund(order._id, 100, 'again');
    assert.equal(refundCalls.length, 1);
  });

  await test('X9: cancelling a COD order that was collected queues a manual payout (not a gateway refund)', async () => {
    refundCalls.length = 0;
    const { order } = await seed({ paymentMethod: 'cod', total: 150, status: 'cancelled', paymentStatus: 'cod_collected' });
    const doc = await Order.findById(order._id);
    const r = await initiateOrderRefund(doc, 'cancelled after collection');
    assert.equal(r.refunded, false);
    assert.equal(r.skipped, 'cod_manual_payout_pending');
    assert.equal(refundCalls.length, 0, 'no gateway refund for COD');
    const fresh = await Order.findById(order._id).lean();
    assert.equal(fresh.codResolutionPayout.status, 'pending');
    assert.equal(fresh.codResolutionPayout.amount, 150);
  });

  // ── Checkout discount snapshot ───────────────────────────────────────
  await test('X10: order persists the discount-funding split fields', async () => {
    const { order } = await seed({ total: 100 });
    await Order.updateOne({ _id: order._id }, { $set: { discount: 50, vendorDiscountShare: 25, discountFunding: 'shared' } });
    const fresh = await Order.findById(order._id).lean();
    assert.equal(fresh.vendorDiscountShare, 25);
    assert.equal(fresh.discountFunding, 'shared');
  });

  // ── End-to-end checkout: the funding split is persisted on the order ──
  await test('X12: checkout persists the discount-funding split for a platform coupon', async () => {
    const { order } = await runCheckout({ fundedBy: 'platform', restaurantSharePercent: 0, value: 200 });
    assert.equal(order.discount, 200, 'customer discount applied');
    assert.equal(order.vendorDiscountShare, 0, 'platform funds the whole discount');
    assert.equal(order.discountFunding, 'platform');
  });

  await test('X13: checkout persists a restaurant-funded split', async () => {
    const { order } = await runCheckout({ fundedBy: 'restaurant', value: 200 });
    assert.equal(order.discount, 200);
    assert.equal(order.vendorDiscountShare, 200, 'restaurant funds the whole discount');
    assert.equal(order.discountFunding, 'restaurant');
  });

  await test('X14: checkout persists a shared split (50/50)', async () => {
    const { order } = await runCheckout({ fundedBy: 'shared', restaurantSharePercent: 50, value: 200 });
    assert.equal(order.discount, 200);
    assert.equal(order.vendorDiscountShare, 100, 'restaurant funds half');
    assert.equal(order.discountFunding, 'shared');
  });

  const code = finish();
  await stopReplSet();
  process.exit(code);
})().catch(async (err) => {
  console.error('HARNESS ERROR', err);
  await stopReplSet().catch(() => {});
  process.exit(1);
});
