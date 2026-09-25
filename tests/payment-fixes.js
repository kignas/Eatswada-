// Launch-fix regression test: refund race, cancelled-then-paid, retry/duplicate payments.
// Runs with no database and no Razorpay (in-memory fakes). Usage: npm run test:payment-fixes
const Module = require('module');
const path = require('path');
const assert = require('assert');
const { makeOrderModel } = require('./helpers/fakeOrderModel');
const ROOT = path.join(__dirname, '..');

const Order = makeOrderModel();
const calls = { refunds: [], notified: [], coupons: [], rzpOrders: 0 };
let orderPayments = [];
let paymentToFetch = null;
const paymentService = {
  assertConfigured() {},
  async createRazorpayOrder(amount) { calls.rzpOrders++; return { id: 'order_NEW' + calls.rzpOrders, amount: Math.round(amount * 100), currency: 'INR' }; },
  async fetchPayment() { return paymentToFetch; },
  async fetchOrderPayments() { return orderPayments; },
  async refundPayment(pid, amount, notes) { await new Promise(r => setTimeout(r, 5)); calls.refunds.push({ pid, amount, notes }); return { id: 'rfnd_' + calls.refunds.length, status: 'pending' }; },
  verifyRazorpaySignature: () => true,
  verifyWebhookSignature: () => true,
  toPaise: (n) => Math.round(n * 100),
};
const stubs = {
  [path.join(ROOT, 'models/Order.js')]: Order,
  [path.join(ROOT, 'models/Cart.js')]: { async findOneAndUpdate() {} },
  [path.join(ROOT, 'models/Coupon.js')]: {},
  [path.join(ROOT, 'services/paymentService.js')]: paymentService,
  [path.join(ROOT, 'services/settlementService.js')]: { async applyRefundAdjustment() {} },
  [path.join(ROOT, 'services/couponUsageService.js')]: { async claimCouponUsage(x) { calls.coupons.push(x); } },
  [path.join(ROOT, 'services/pushService.js')]: { notifyRestaurantNewOrder: async (o) => calls.notified.push(o._id), notifyAdminsNewOrder: async () => {} },
  'express-async-handler': (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)),
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (stubs[req]) return req;
  return origResolve.call(this, req, parent, ...rest);
};
for (const [k, v] of Object.entries(stubs)) {
  require.cache[k] = { id: k, filename: k, loaded: true, exports: v };
}
const { initiateOrderRefund } = require(path.join(ROOT, 'services/refundService.js'));
const pc = require(path.join(ROOT, 'controllers/paymentController.js'));

const base = (o) => ({ user: 'u1', paymentMethod: 'upi', paymentStatus: 'pending', status: 'placed', razorpayOrderId: 'order_O1', razorpayOrderIdHistory: [], razorpayPaymentId: '', paymentClaimId: '', refund: { status: 'none' }, duplicatePayments: [], total: 100, ...o });
const reset = () => { Order.docs.length = 0; calls.refunds.length = 0; calls.notified.length = 0; calls.coupons.length = 0; calls.rzpOrders = 0; orderPayments = []; };
const res = () => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const webhook = (event, entity) => pc.handleWebhook({ body: Buffer.from(JSON.stringify({ event, payload: { payment: { entity } } })), get: () => 'sig' }, res(), (e) => { throw e; });

(async () => {
  let pass = 0;
  const t = async (name, fn) => { reset(); await fn(); pass++; console.log('PASS', name); };

  await t('A: two simultaneous refunds for one order → Razorpay called once', async () => {
    Order.insert(base({ _id: 'A', status: 'cancelled', paymentStatus: 'paid', razorpayPaymentId: 'pay_1' }));
    const o = Order.get('A');
    const [r1, r2, r3] = await Promise.all([initiateOrderRefund({ ...o }, 'x'), initiateOrderRefund({ ...o }, 'y'), initiateOrderRefund({ ...o }, 'z')]);
    assert.strictEqual(calls.refunds.length, 1);
    assert.strictEqual([r1, r2, r3].filter(r => r.refunded).length, 1);
    assert.strictEqual(Order.get('A').refund.status, 'processing');
  });

  await t('B: no refund when the cancellation is not saved in the DB', async () => {
    Order.insert(base({ _id: 'B', status: 'confirmed', paymentStatus: 'paid', razorpayPaymentId: 'pay_1' }));
    const r = await initiateOrderRefund({ ...Order.get('B'), status: 'cancelled' }, 'x');
    assert.strictEqual(calls.refunds.length, 0); assert.strictEqual(r.skipped, 'not_cancelled');
  });

  await t('C: payment captured after one order was cancelled → live paid+notified, cancelled refunded, not notified', async () => {
    Order.insert(base({ _id: 'L', total: 120 }));
    Order.insert(base({ _id: 'X', total: 80, status: 'cancelled' }));
    await webhook('payment.captured', { id: 'pay_9', order_id: 'order_O1', amount: 20000, currency: 'INR', status: 'captured' });
    assert.strictEqual(Order.get('L').paymentStatus, 'paid');
    assert.deepStrictEqual(calls.notified, ['L']);
    assert.strictEqual(calls.refunds.length, 1);
    assert.strictEqual(calls.refunds[0].amount, 80);
    assert.strictEqual(Order.get('X').refund.status, 'processing');
    // Razorpay retries the webhook → nothing new happens
    await webhook('payment.captured', { id: 'pay_9', order_id: 'order_O1', amount: 20000, currency: 'INR', status: 'captured' });
    assert.strictEqual(calls.refunds.length, 1);
  });

  await t('D: retry keeps old id; late capture on OLD order is matched, then second payment is refunded as duplicate', async () => {
    Order.insert(base({ _id: 'R1', total: 150, paymentStatus: 'failed' }));
    const r = res();
    await pc.retryPayment({ body: { orderId: 'R1' }, user: { _id: 'u1' } }, r, (e) => { throw e; });
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(Order.get('R1').razorpayOrderId, 'order_NEW1');
    assert.deepStrictEqual(Order.get('R1').razorpayOrderIdHistory, ['order_O1']);
    // Old UPI payment captures late:
    await webhook('payment.captured', { id: 'pay_OLD', order_id: 'order_O1', amount: 15000, currency: 'INR', status: 'captured' });
    assert.strictEqual(Order.get('R1').paymentStatus, 'paid');
    assert.strictEqual(Order.get('R1').razorpayPaymentId, 'pay_OLD');
    // Customer also paid the new Razorpay order:
    await webhook('payment.captured', { id: 'pay_NEW', order_id: 'order_NEW1', amount: 15000, currency: 'INR', status: 'captured' });
    assert.strictEqual(Order.get('R1').razorpayPaymentId, 'pay_OLD');
    assert.strictEqual(calls.refunds.length, 1); assert.strictEqual(calls.refunds[0].pid, 'pay_NEW'); assert.strictEqual(calls.refunds[0].amount, 150);
    assert.strictEqual(Order.get('R1').duplicatePayments[0].paymentId, 'pay_NEW');
    // webhook retry for the duplicate → not refunded again
    await webhook('payment.captured', { id: 'pay_NEW', order_id: 'order_NEW1', amount: 15000, currency: 'INR', status: 'captured' });
    assert.strictEqual(calls.refunds.length, 1);
    assert.deepStrictEqual(calls.notified, ['R1']);
  });

  await t('E: retry detects that the earlier payment already went through', async () => {
    Order.insert(base({ _id: 'E1', total: 90 }));
    orderPayments = [{ id: 'pay_LATE', status: 'captured', amount: 9000, currency: 'INR' }];
    const r = res();
    await pc.retryPayment({ body: { orderId: 'E1' }, user: { _id: 'u1' } }, r, (e) => { throw e; });
    assert.strictEqual(r.code, 409); assert.strictEqual(r.body.alreadyPaid, true);
    assert.strictEqual(calls.rzpOrders, 0);
    assert.strictEqual(Order.get('E1').paymentStatus, 'paid');
  });

  await t('F: failure event on an OLD Razorpay order does not mark the new attempt failed', async () => {
    Order.insert(base({ _id: 'F1', razorpayOrderId: 'order_NEW', razorpayOrderIdHistory: ['order_O1'], total: 50 }));
    await webhook('payment.failed', { id: 'pay_f', order_id: 'order_O1', amount: 5000, currency: 'INR', status: 'failed' });
    assert.strictEqual(Order.get('F1').paymentStatus, 'pending');
  });

  await t('G: verifyPayment twice with same payment is idempotent', async () => {
    Order.insert(base({ _id: 'G1', total: 70 }));
    paymentToFetch = { id: 'pay_g', order_id: 'order_O1', amount: 7000, currency: 'INR', status: 'captured' };
    const req = { body: { orderId: 'G1', razorpayPaymentId: 'pay_g', razorpayOrderId: 'order_O1', razorpaySignature: 's' }, user: { _id: 'u1' } };
    const r1 = res(); await pc.verifyPayment(req, r1, (e) => { throw e; });
    const r2 = res(); await pc.verifyPayment(req, r2, (e) => { throw e; });
    assert.strictEqual(r1.body.paymentStatus, 'paid'); assert.strictEqual(r2.body.alreadyPaid, true);
    assert.strictEqual(calls.refunds.length, 0); assert.deepStrictEqual(calls.notified, ['G1']);
  });

  await t('H: retry on a fully cancelled checkout is refused', async () => {
    Order.insert(base({ _id: 'H1', status: 'cancelled' }));
    const r = res(); await pc.retryPayment({ body: { orderId: 'H1' }, user: { _id: 'u1' } }, r, (e) => { throw e; });
    assert.strictEqual(r.code, 409); assert.strictEqual(calls.rzpOrders, 0);
  });

  await t('I: two simultaneous retries → only one Razorpay order is committed', async () => {
    Order.insert(base({ _id: 'I1', paymentStatus: 'failed' }));
    const r1 = res(), r2 = res();
    await Promise.all([
      pc.retryPayment({ body: { orderId: 'I1' }, user: { _id: 'u1' } }, r1, (e) => { throw e; }),
      pc.retryPayment({ body: { orderId: 'I1' }, user: { _id: 'u1' } }, r2, (e) => { throw e; }),
    ]);
    assert.strictEqual(calls.rzpOrders, 2, 'two external attempts may be created, but only one may be committed');
    const successful = [r1, r2].filter(r => r.body?.success === true);
    const conflicts = [r1, r2].filter(r => r.code === 409);
    assert.strictEqual(successful.length, 1);
    assert.strictEqual(conflicts.length, 1);
    assert.strictEqual(Order.get('I1').razorpayOrderId, successful[0].body.payment.orderId);
    assert.deepStrictEqual(Order.get('I1').razorpayOrderIdHistory, ['order_O1']);
  });

  await t('J: two simultaneous captures → first payment wins and the other is refunded once', async () => {
    Order.insert(base({ _id: 'J1', total: 100 }));
    const e1 = webhook('payment.captured', { id: 'pay_A', order_id: 'order_O1', amount: 10000, currency: 'INR', status: 'captured' });
    const e2 = webhook('payment.captured', { id: 'pay_B', order_id: 'order_O1', amount: 10000, currency: 'INR', status: 'captured' });
    await Promise.all([e1, e2]);
    assert.strictEqual(Order.get('J1').paymentStatus, 'paid');
    assert.ok(['pay_A', 'pay_B'].includes(Order.get('J1').razorpayPaymentId));
    assert.strictEqual(calls.refunds.length, 1);
    assert.strictEqual(calls.refunds[0].amount, 100);
    assert.strictEqual(Order.get('J1').duplicatePayments.length, 1);
    assert.ok(['pay_A', 'pay_B'].includes(Order.get('J1').duplicatePayments[0].paymentId));
    assert.strictEqual(calls.notified.length, 1);
  });

  console.log(`\n${pass}/10 scenarios passed`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
