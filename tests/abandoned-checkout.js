// Regression test: an unpaid online (UPI/card/wallet) checkout must not hold
// stock forever. After the expiry window the sweeper first asks Razorpay whether
// the money actually arrived late (then it settles the checkout), and only
// otherwise cancels the orders and releases their stock.
// Runs with no database and no Razorpay (in-memory fakes). Usage: npm run test:abandoned-checkout
const Module = require('module');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { makeOrderModel } = require('./helpers/fakeOrderModel');
const ROOT = path.join(__dirname, '..');

const Order = makeOrderModel();
const calls = { released: [], notified: [], paid: [], fetched: [] };
let razorpay = {}; // razorpayOrderId -> attempts[] | Error
const stubs = {
  [path.join(ROOT, 'models/Order.js')]: Order,
  [path.join(ROOT, 'services/paymentService.js')]: {
    async fetchOrderPayments(id) {
      calls.fetched.push(id);
      const r = razorpay[id];
      if (r instanceof Error) throw r;
      return r || [];
    },
  },
  [path.join(ROOT, 'services/inventoryReservationService.js')]: { async releaseOrderInventory(o) { calls.released.push(String(o._id)); return { released: true }; } },
  [path.join(ROOT, 'services/notificationService.js')]: { async notifyOrderStatus(u, o) { calls.notified.push(String(o._id)); } },
  [path.join(ROOT, 'controllers/paymentController.js')]: {
    async markCheckoutPaid(orders, paymentId, amountPaise) { calls.paid.push({ ids: orders.map(o => String(o._id)).sort(), paymentId, amountPaise }); for (const o of orders) { const d = Order.get(o._id); d.paymentStatus = 'paid'; d.razorpayPaymentId = paymentId; } /* like the real one */ return { liveOrderIds: orders.map(o => o._id), refundedOrderIds: [], duplicate: false }; },
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { if (stubs[req]) return req; return origResolve.call(this, req, parent, ...rest); };
for (const [k, v] of Object.entries(stubs)) require.cache[k] = { id: k, filename: k, loaded: true, exports: v };

let svc;
try { svc = require(path.join(ROOT, 'services/abandonedCheckoutService.js')); }
catch (e) { console.error('FAIL: services/abandonedCheckoutService.js is missing or broken:', e.message); process.exit(1); }
const { expireAbandonedCheckout, recoverAbandonedCheckouts } = svc;

const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const make = (o) => Order.insert({
  user: 'u1', restaurant: 'r1', paymentMethod: 'upi', paymentStatus: 'pending', status: 'placed',
  total: 250, razorpayOrderId: 'rzp_1', razorpayPaymentId: '', isCancellable: true,
  inventoryReservedAt: minutesAgo(30), inventoryReleasedAt: null, items: [{ menuItem: 'm1', quantity: 1 }],
  createdAt: minutesAgo(30), updatedAt: minutesAgo(30), statusHistory: [], ...o,
});
const reset = () => { Order.docs.length = 0; razorpay = {}; for (const k of Object.keys(calls)) calls[k].length = 0; };

(async () => {
  let pass = 0;
  const t = async (name, fn) => { reset(); await fn(); pass++; console.log('PASS', name); };

  await t('A: stale unpaid UPI order with no captured payment → cancelled, stock released once, customer told, nothing refunded', async () => {
    make({ _id: 'A1' });
    razorpay.rzp_1 = [{ id: 'pay_x', status: 'failed', amount: 25000, currency: 'INR' }];
    const r = await recoverAbandonedCheckouts();
    const o = Order.get('A1');
    assert.strictEqual(o.status, 'cancelled');
    assert.strictEqual(o.cancelReason, 'Payment not completed in time');
    assert.strictEqual(o.paymentStatus, 'failed');
    assert.strictEqual(o.isCancellable, false);
    assert.notStrictEqual(o.cancelReason, 'Payment failed', 'must not be revivable by retryPayment (stock is released)');
    assert.deepStrictEqual(calls.released, ['A1']);
    assert.deepStrictEqual(calls.notified, ['A1']);
    assert.strictEqual(calls.paid.length, 0);
    assert.strictEqual(r.cancelled, 1);
  });

  await t('B: an order younger than the expiry window is left alone (and Razorpay is not even asked)', async () => {
    make({ _id: 'B1', createdAt: minutesAgo(5), updatedAt: minutesAgo(5) });
    await recoverAbandonedCheckouts();
    assert.strictEqual(await expireAbandonedCheckout('B1'), 'none', 'direct call must also respect the window');
    assert.strictEqual(Order.get('B1').status, 'placed');
    assert.strictEqual(calls.released.length, 0);
    assert.strictEqual(calls.fetched.length, 0);
  });

  await t('C: Razorpay shows a LATE CAPTURE → checkout is settled as paid, NOT cancelled, stock kept', async () => {
    make({ _id: 'C1' });
    razorpay.rzp_1 = [{ id: 'pay_late', status: 'captured', amount: 25000, currency: 'INR' }];
    const r = await recoverAbandonedCheckouts();
    assert.strictEqual(Order.get('C1').status, 'placed');
    assert.deepStrictEqual(calls.paid, [{ ids: ['C1'], paymentId: 'pay_late', amountPaise: 25000 }]);
    assert.strictEqual(calls.released.length, 0);
    assert.strictEqual(r.paid, 1); assert.strictEqual(r.cancelled, 0);
  });

  await t('D: Razorpay lookup fails → order is NOT cancelled (a capture cannot be ruled out); next sweep cancels it', async () => {
    make({ _id: 'D1' });
    razorpay.rzp_1 = new Error('network down');
    const r1 = await recoverAbandonedCheckouts();
    assert.strictEqual(Order.get('D1').status, 'placed');
    assert.strictEqual(calls.released.length, 0);
    assert.strictEqual(r1.cancelled, 0);
    razorpay.rzp_1 = [];
    const r2 = await recoverAbandonedCheckouts();
    assert.strictEqual(Order.get('D1').status, 'cancelled');
    assert.strictEqual(r2.cancelled, 1);
  });

  await t('E: a payment retry refreshes the order → old createdAt alone must not expire a fresh retry', async () => {
    make({ _id: 'E1', createdAt: minutesAgo(60), updatedAt: minutesAgo(1) });
    const re = await recoverAbandonedCheckouts();
    assert.strictEqual(re.scanned, 0, 'a refreshed order must not even be scanned');
    assert.strictEqual(await expireAbandonedCheckout('E1'), 'none', 'direct call must also respect the refreshed window');
    assert.strictEqual(Order.get('E1').status, 'placed');
    assert.strictEqual(calls.released.length, 0);
  });

  await t('F: COD, already-paid, partial-COD and non-placed orders are never touched', async () => {
    make({ _id: 'F1', paymentMethod: 'cod', paymentStatus: 'cod_pending', razorpayOrderId: '' });
    make({ _id: 'F2', paymentStatus: 'paid', razorpayPaymentId: 'pay_ok' });
    make({ _id: 'F3', paymentMethod: 'cod', paymentStatus: 'cod_pending', partialCodAdvanceAmount: 100, partialCodAdvanceStatus: 'pending' });
    make({ _id: 'F4', status: 'cancelled', paymentStatus: 'failed' });
    make({ _id: 'F5', status: 'confirmed', paymentStatus: 'pending' });
    make({ _id: 'F6', paymentMethod: 'cod', paymentStatus: 'pending', razorpayOrderId: '' }); // defence in depth: COD is never an online checkout
    const rf = await recoverAbandonedCheckouts();
    assert.strictEqual(rf.scanned, 0, 'none of these may even be scanned');
    for (const id of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6']) assert.strictEqual(await expireAbandonedCheckout(id), 'none', `direct call must refuse ${id}`);
    for (const id of ['F1', 'F2', 'F3', 'F5', 'F6']) assert.notStrictEqual(Order.get(id).status, 'cancelled', id);
    assert.strictEqual(Order.get('F4').status, 'cancelled');
    assert.strictEqual(calls.released.length, 0);
    assert.strictEqual(calls.notified.length, 0);
  });

  await t('G: multi-restaurant checkout (one Razorpay order, two orders): late capture settles BOTH once; no capture cancels BOTH', async () => {
    make({ _id: 'G1', total: 100 }); make({ _id: 'G2', total: 150, restaurant: 'r2' });
    razorpay.rzp_1 = [{ id: 'pay_g', status: 'captured', amount: 25000, currency: 'INR' }];
    await recoverAbandonedCheckouts();
    assert.strictEqual(calls.paid.length, 1, 'markCheckoutPaid must be called once for the whole checkout');
    assert.deepStrictEqual(calls.paid[0].ids, ['G1', 'G2']);
    assert.strictEqual(Order.get('G1').status, 'placed'); assert.strictEqual(Order.get('G2').status, 'placed');
    reset();
    make({ _id: 'G3', total: 100 }); make({ _id: 'G4', total: 150, restaurant: 'r2' });
    await recoverAbandonedCheckouts();
    assert.strictEqual(Order.get('G3').status, 'cancelled'); assert.strictEqual(Order.get('G4').status, 'cancelled');
    assert.deepStrictEqual(calls.released.sort(), ['G3', 'G4']);
  });

  await t('H: capture on an OLD Razorpay order id (before a retry) is found through razorpayOrderIdHistory', async () => {
    make({ _id: 'H1', razorpayOrderId: 'rzp_new', razorpayOrderIdHistory: ['rzp_old'] });
    razorpay.rzp_new = [];
    razorpay.rzp_old = [{ id: 'pay_old', status: 'captured', amount: 25000, currency: 'INR' }];
    await recoverAbandonedCheckouts();
    assert.strictEqual(Order.get('H1').status, 'placed');
    assert.strictEqual(calls.paid.length, 1);
    assert.strictEqual(calls.paid[0].paymentId, 'pay_old');
    assert.strictEqual(calls.released.length, 0);
  });

  await t('I: captured payment with a WRONG amount is left for review — never cancelled', async () => {
    make({ _id: 'I1' });
    razorpay.rzp_1 = [{ id: 'pay_odd', status: 'captured', amount: 100, currency: 'INR' }];
    await recoverAbandonedCheckouts();
    assert.strictEqual(Order.get('I1').status, 'placed');
    assert.strictEqual(calls.paid.length, 0);
    assert.strictEqual(calls.released.length, 0);
  });

  await t('J: an order whose payment is being claimed right now is not cancelled', async () => {
    make({ _id: 'J1', paymentClaimId: 'pay_inflight' });
    await recoverAbandonedCheckouts();
    assert.strictEqual(Order.get('J1').status, 'placed');
    assert.strictEqual(calls.released.length, 0);
  });

  await t('K: two simultaneous expiries of the same order → cancelled and released exactly once', async () => {
    make({ _id: 'K1' });
    const res = await Promise.all([expireAbandonedCheckout('K1'), expireAbandonedCheckout('K1')]);
    assert.deepStrictEqual(res.filter(x => x === 'cancelled').length, 1);
    assert.deepStrictEqual(calls.released, ['K1']);
    assert.deepStrictEqual(calls.notified, ['K1']);
  });

  await t('L: an order without any Razorpay order id (gateway step never completed) is cancelled without calling Razorpay', async () => {
    make({ _id: 'L1', razorpayOrderId: '' });
    await recoverAbandonedCheckouts();
    assert.strictEqual(Order.get('L1').status, 'cancelled');
    assert.strictEqual(calls.fetched.length, 0);
    assert.deepStrictEqual(calls.released, ['L1']);
  });

  await t('M: wiring — server.js starts the sweeper and paymentController exports markCheckoutPaid', async () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.ok(/startAbandonedCheckoutRecovery\(\)/.test(server), 'server.js must call startAbandonedCheckoutRecovery()');
    const pc = fs.readFileSync(path.join(ROOT, 'controllers/paymentController.js'), 'utf8');
    assert.ok(/exports\.markCheckoutPaid\s*=\s*markCheckoutPaid/.test(pc), 'paymentController must export markCheckoutPaid');
    assert.ok(typeof svc.startAbandonedCheckoutRecovery === 'function');
  });

  console.log(`\n${pass} scenarios passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
