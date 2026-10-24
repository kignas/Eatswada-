// Regression test: ONE failed payment attempt must never cancel an online order.
// A customer who fails a UPI attempt and retries in the same Razorpay modal (or via
// retryPayment) must still end up with a paid, live order — not a refund and no order.
// The order stays placed/pending with its stock reserved; the abandoned-checkout
// sweeper expires it (and returns the stock) if the customer never pays.
// Also: a revived legacy order that the restaurant accepts must re-reserve stock in a way a
// later cancel can restore. Runs with no database and no Razorpay.
// Usage: npm run test:payment-failure-stock
const Module = require('module');
const path = require('path');
const assert = require('assert');
const { makeOrderModel } = require('./helpers/fakeOrderModel');
const ROOT = path.join(__dirname, '..');

const Order = makeOrderModel();
const calls = { released: [], decrements: [], refunds: [] };
let orderPayments = [];
let paymentToFetch = null;

// Realistic .select(): production only returns the listed fields. The shared fake
// ignores projections, which hid the "releaseOrderInventory silently no-ops" bug.
const origFindOne = Order.findOne.bind(Order);
const origFindById = Order.findById.bind(Order);
const project = (doc, fields) => {
  if (!doc) return doc;
  const keep = new Set(String(fields).split(/\s+/).filter(Boolean).concat('_id'));
  const out = {};
  for (const k of keep) if (doc[k] !== undefined) out[k] = JSON.parse(JSON.stringify(doc[k]));
  return out;
};
const withProjection = (q) => { const sel = q.select.bind(q); q.select = (fields) => { sel(); const fn = q.fn; q.fn = () => project(fn(), fields); return q; }; return q; };
Order.findOne = (f) => withProjection(origFindOne(f));
Order.findById = (id) => withProjection(origFindById(id));

// Stand-in for the real release service with the SAME guard and atomic claim:
// it does nothing for an order object that lacks the reservation markers.
const inventory = {
  async releaseOrderInventory(order) {
    if (!order?.inventoryReservedAt || order.inventoryReleasedAt) return { released: false };
    const claim = await Order.findOneAndUpdate({ _id: order._id, inventoryReservedAt: { $ne: null }, inventoryReleasedAt: null }, { $set: { inventoryReleasedAt: new Date().toISOString() } });
    if (!claim) return { released: false };
    calls.released.push(String(order._id));
    return { released: true };
  },
};
const menu = { items: {} };
const Menu = {
  findOne(filter) { const row = menu.items[String(filter._id)] || null; return { select: async () => row }; },
  async findOneAndUpdate(filter, pipeline) {
    const row = menu.items[String(filter._id)];
    const qty = filter.stockQuantity && filter.stockQuantity.$gte;
    if (!row || row.stockQuantity < qty) return null;
    const dec = pipeline[0].$set.stockQuantity.$subtract[1];
    row.stockQuantity -= dec; calls.decrements.push({ id: String(filter._id), by: dec });
    return { ...row };
  },
  async updateOne() {},
};
const noop = async () => {};
const stubs = {
  [path.join(ROOT, 'models/Order.js')]: Order,
  [path.join(ROOT, 'models/Cart.js')]: { async findOneAndUpdate() {} },
  [path.join(ROOT, 'models/Coupon.js')]: {},
  [path.join(ROOT, 'models/Menu.js')]: Menu,
  [path.join(ROOT, 'models/Restaurant.js')]: {},
  [path.join(ROOT, 'models/Review.js')]: {},
  [path.join(ROOT, 'models/InventoryMovement.js')]: { create: noop, deleteMany: noop },
  [path.join(ROOT, 'services/paymentService.js')]: {
    assertConfigured() {}, async createRazorpayOrder() { return { id: 'order_NEW' }; }, async fetchPayment() { return paymentToFetch; },
    async fetchOrderPayments() { return orderPayments; }, async refundPayment(pid, amount) { calls.refunds.push({ pid, amount }); return { id: 'rfnd_' + calls.refunds.length, status: 'pending' }; },
    verifyRazorpaySignature: () => true, verifyWebhookSignature: () => true, toPaise: (n) => Math.round(n * 100),
  },
  [path.join(ROOT, 'services/settlementService.js')]: { async applyRefundAdjustment() {} },
  [path.join(ROOT, 'services/couponUsageService.js')]: { async claimCouponUsage() {} },
  [path.join(ROOT, 'services/pushService.js')]: { notifyRestaurantNewOrder: noop, notifyAdminsNewOrder: noop, stopRing: noop },
  [path.join(ROOT, 'services/inventoryReservationService.js')]: inventory,
  [path.join(ROOT, 'services/notificationService.js')]: { notifyOrderStatus: noop },
  [path.join(ROOT, 'services/riderAssignmentService.js')]: { autoAssignRider: noop, scheduleRiderTimeout() {} },
  [path.join(ROOT, 'services/vendorMarketplaceService.js')]: { async getRestaurantCapacity() { return { activeOrders: 0, maxActiveOrders: 10, availableSlots: 10 }; } },
  [path.join(ROOT, 'services/platformSettingsService.js')]: { async getPlatformSettings() { return {}; } },
  'express-async-handler': (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)),
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { if (stubs[req]) return req; return origResolve.call(this, req, parent, ...rest); };
for (const [k, v] of Object.entries(stubs)) require.cache[k] = { id: k, filename: k, loaded: true, exports: v };
const pc = require(path.join(ROOT, 'controllers/paymentController.js'));
const vc = require(path.join(ROOT, 'controllers/vendorController.js'));

const base = (o) => ({
  user: 'u1', restaurant: 'r1', paymentMethod: 'upi', paymentStatus: 'pending', status: 'placed', razorpayOrderId: 'order_O1',
  razorpayOrderIdHistory: [], razorpayPaymentId: '', paymentClaimId: '', refund: { status: 'none' }, duplicatePayments: [], total: 100,
  items: [{ menuItem: 'm1', quantity: 2 }], inventoryReservedAt: new Date().toISOString(), inventoryReleasedAt: null, ...o,
});
const reset = () => { Order.docs.length = 0; calls.released.length = 0; calls.decrements.length = 0; calls.refunds.length = 0; orderPayments = []; paymentToFetch = null; for (const k of Object.keys(menu.items)) delete menu.items[k]; };
const res = () => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const webhook = (event, entity) => pc.handleWebhook({ body: Buffer.from(JSON.stringify({ event, payload: { payment: { entity } } })), get: () => 'sig' }, res(), (e) => { throw e; });
const failedEvt = (id, order_id, amount) => ({ id, order_id, amount, currency: 'INR', status: 'failed' });

(async () => {
  let pass = 0;
  const t = async (name, fn) => { reset(); await fn(); pass++; console.log('PASS', name); };

  await t('A: payment.failed webhook does NOT cancel the order or release its stock (customer may still retry and pay)', async () => {
    Order.insert(base({ _id: 'A1' }));
    await webhook('payment.failed', failedEvt('pay_f1', 'order_O1', 10000));
    assert.strictEqual(Order.get('A1').status, 'placed', 'one failed attempt must not cancel the order');
    assert.strictEqual(Order.get('A1').paymentStatus, 'pending');
    assert.strictEqual(calls.released.length, 0, 'stock stays reserved until the sweeper expires the order');
    await webhook('payment.failed', failedEvt('pay_f1', 'order_O1', 10000));
    assert.strictEqual(Order.get('A1').status, 'placed');
    assert.strictEqual(calls.released.length, 0);
  });

  await t('B: multi-restaurant checkout → a failed attempt cancels none of the orders', async () => {
    Order.insert(base({ _id: 'B1', total: 60 })); Order.insert(base({ _id: 'B2', total: 40, restaurant: 'r2' }));
    await webhook('payment.failed', failedEvt('pay_f2', 'order_O1', 10000));
    assert.strictEqual(Order.get('B1').status, 'placed'); assert.strictEqual(Order.get('B2').status, 'placed');
    assert.strictEqual(calls.released.length, 0);
  });

  await t('C: failure event for an OLD Razorpay attempt (after a retry) neither cancels nor releases the live order', async () => {
    Order.insert(base({ _id: 'C1', razorpayOrderId: 'order_NEW', razorpayOrderIdHistory: ['order_O1'] }));
    await webhook('payment.failed', failedEvt('pay_old', 'order_O1', 10000));
    assert.strictEqual(Order.get('C1').status, 'placed');
    assert.strictEqual(calls.released.length, 0);
  });

  await t('D: GET /payments/status with every attempt failed → order is NOT cancelled, still placed/pending and retryable', async () => {
    Order.insert(base({ _id: 'D1' }));
    orderPayments = [{ id: 'pay_x', status: 'failed', amount: 10000, currency: 'INR' }];
    const r = res();
    await pc.paymentStatus({ params: { id: 'D1' }, user: { _id: 'u1' } }, r, (e) => { throw e; });
    assert.strictEqual(r.body.data.orderStatus, 'placed');
    assert.strictEqual(Order.get('D1').paymentStatus, 'pending');
    assert.strictEqual(calls.released.length, 0);
  });

  await t('E: status check + webhook both see the failure → still nothing cancelled or released', async () => {
    Order.insert(base({ _id: 'E1' }));
    orderPayments = [{ id: 'pay_x', status: 'failed', amount: 10000, currency: 'INR' }];
    await pc.paymentStatus({ params: { id: 'E1' }, user: { _id: 'u1' } }, res(), (e) => { throw e; });
    await webhook('payment.failed', failedEvt('pay_x', 'order_O1', 10000));
    assert.strictEqual(Order.get('E1').status, 'placed');
    assert.strictEqual(calls.released.length, 0);
  });

  await t('F: payment still open (no failed attempt yet) → order and stock untouched', async () => {
    Order.insert(base({ _id: 'F1' }));
    orderPayments = [];
    await pc.paymentStatus({ params: { id: 'F1' }, user: { _id: 'u1' } }, res(), (e) => { throw e; });
    assert.strictEqual(Order.get('F1').status, 'placed');
    assert.strictEqual(calls.released.length, 0);
  });

  const accept = async (id) => {
    const doc = Order.get(id);
    doc.advanceStatus = function (s) { this.status = s; return this; };
    doc.generatePickupCode = () => {}; doc.save = async function () { return this; };
    doc.deliveryModeSnapshot = 'self_delivery';
    const r = res();
    await vc.acceptOrder({ params: { id }, body: { prepTimeMinutes: 20 }, user: { role: 'vendor', restaurantId: 'r1', _id: 'v1' } }, r, (e) => { throw e; });
    return r;
  };
  const tracked = () => { menu.items.m1 = { _id: 'm1', name: 'Momo', trackStock: true, stockQuantity: 10, inStock: true }; };

  await t('G: order revived after a payment failure (stock was released) → accept reserves stock again AND clears the released marker, so a later cancel restores it', async () => {
    tracked();
    Order.insert(base({ _id: 'G1', paymentStatus: 'paid', restaurantResponseDeadline: new Date(Date.now() + 60000).toISOString(), inventoryReleasedAt: new Date().toISOString() }));
    const r = await accept('G1');
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(calls.decrements, [{ id: 'm1', by: 2 }], 'stock reserved again at accept');
    assert.strictEqual(Order.get('G1').inventoryReleasedAt, null, 'reservation must be marked active again');
    const rel = await inventory.releaseOrderInventory(Order.get('G1'));
    assert.strictEqual(rel.released, true, 'a later cancel must be able to restore the stock');
  });

  await t('H: normal order (stock reserved at checkout) → accept does NOT take stock a second time', async () => {
    tracked();
    Order.insert(base({ _id: 'H1', paymentStatus: 'paid', restaurantResponseDeadline: new Date(Date.now() + 60000).toISOString() }));
    const r = await accept('H1');
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.strictEqual(calls.decrements.length, 0);
    assert.strictEqual(menu.items.m1.stockQuantity, 10);
  });

  await t('I: THE BUG — attempt 1 fails, attempt 2 in the same modal succeeds → order is PAID and live, nothing refunded', async () => {
    Order.insert(base({ _id: 'I1', total: 100 }));
    await webhook('payment.failed', failedEvt('pay_try1', 'order_O1', 10000));
    await webhook('payment.captured', { id: 'pay_try2', order_id: 'order_O1', amount: 10000, currency: 'INR', status: 'captured' });
    const o = Order.get('I1');
    assert.strictEqual(o.paymentStatus, 'paid');
    assert.strictEqual(o.status, 'placed', 'order must stay live for the restaurant');
    assert.strictEqual(o.razorpayPaymentId, 'pay_try2');
    assert.strictEqual(calls.refunds.length, 0, 'a customer who paid must not be refunded');
    assert.strictEqual(calls.released.length, 0);
  });

  await t('J: /payments/verify reporting a FAILED payment → 409 but the order stays live and retryable', async () => {
    Order.insert(base({ _id: 'J1', total: 100 }));
    paymentToFetch = { id: 'pay_bad', order_id: 'order_O1', amount: 10000, currency: 'INR', status: 'failed' };
    const r = res();
    await pc.verifyPayment({ body: { orderId: 'J1', razorpayPaymentId: 'pay_bad', razorpayOrderId: 'order_O1', razorpaySignature: 's' }, user: { _id: 'u1' } }, r, (e) => { throw e; });
    assert.strictEqual(r.code, 409);
    assert.strictEqual(r.body.success, false);
    assert.strictEqual(r.body.retryable, true);
    assert.notStrictEqual(r.body.orderStatus, 'cancelled');
    assert.strictEqual(Order.get('J1').status, 'placed');
    assert.strictEqual(calls.released.length, 0);
  });

  await t('K: after a failed attempt the customer can start a fresh payment on the same live order', async () => {
    Order.insert(base({ _id: 'K1', total: 100 }));
    await webhook('payment.failed', failedEvt('pay_try1', 'order_O1', 10000));
    const r = res();
    await pc.retryPayment({ body: { orderId: 'K1' }, user: { _id: 'u1' } }, r, (e) => { throw e; });
    assert.strictEqual(r.body.success, true, JSON.stringify(r.body));
    assert.strictEqual(Order.get('K1').razorpayOrderId, 'order_NEW');
    assert.strictEqual(Order.get('K1').status, 'placed');
  });

  await t('L: wiring — no payment-failure path in paymentController cancels the order any more', async () => {
    const src = require('fs').readFileSync(path.join(ROOT, 'controllers/paymentController.js'), 'utf8');
    assert.ok(!/\$set:\s*\{[^}]*cancelReason:\s*'Payment failed'/.test(src), "no code may SET cancelReason 'Payment failed' (retryPayment still matches it to revive legacy orders)");
    assert.ok(!/Payment failed; order cancelled automatically/.test(src), 'no automatic cancel note for failed attempts');
  });

  console.log(`\n${pass} scenarios passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
