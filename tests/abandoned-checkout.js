// Regression test: an unpaid online (UPI/card/wallet) checkout — and a partial-COD
// order whose advance was never paid — must not hold stock forever. After the expiry window the sweeper first asks Razorpay whether
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
const calls = { released: [], notified: [], paid: [], fetched: [], advancePaid: [] };
let razorpay = {}; // razorpayOrderId -> attempts[] | Error
let advanceResult = null; // test hook: force markPartialCodAdvancePaid's answer
let onFetch = null; // test hook: runs while the sweeper is talking to Razorpay
const stubs = {
  [path.join(ROOT, 'models/Order.js')]: Order,
  [path.join(ROOT, 'services/paymentService.js')]: {
    async fetchOrderPayments(id) {
      calls.fetched.push(id);
      if (onFetch) await onFetch(id);
      const r = razorpay[id];
      if (r instanceof Error) throw r;
      return r || [];
    },
  },
  [path.join(ROOT, 'services/inventoryReservationService.js')]: { async releaseOrderInventory(o) { calls.released.push(String(o._id)); return { released: true }; } },
  [path.join(ROOT, 'services/notificationService.js')]: { async notifyOrderStatus(u, o) { calls.notified.push(String(o._id)); } },
  [path.join(ROOT, 'controllers/paymentController.js')]: {
    async markPartialCodAdvancePaid(order, paymentId) { calls.advancePaid.push({ id: String(order._id), paymentId }); if (advanceResult) return advanceResult; const d = Order.get(order._id); d.partialCodAdvanceStatus = 'paid'; d.razorpayPaymentId = paymentId; return { paid: true, order: d }; },
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
const makeAdvance = (o) => make({ paymentMethod: 'cod', paymentStatus: 'cod_pending', total: 500, razorpayOrderId: 'rzp_adv', partialCodAdvanceAmount: 100, partialCodAdvanceStatus: 'pending', partialCodRefundEligible: false, ...o });
const reset = () => { Order.docs.length = 0; razorpay = {}; onFetch = null; advanceResult = null; for (const k of Object.keys(calls)) calls[k].length = 0; };

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

  await t('F: COD, already-paid, partial-COD (advance PAID) and non-placed orders are never touched', async () => {
    make({ _id: 'F1', paymentMethod: 'cod', paymentStatus: 'cod_pending', razorpayOrderId: '' });
    make({ _id: 'F2', paymentStatus: 'paid', razorpayPaymentId: 'pay_ok' });
    make({ _id: 'F3', paymentMethod: 'cod', paymentStatus: 'cod_pending', partialCodAdvanceAmount: 100, partialCodAdvanceStatus: 'paid', razorpayPaymentId: 'pay_adv' });
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

  await t('N: partial-COD order whose advance was never paid, no capture on Razorpay → cancelled, stock released, customer told, refund-eligible if money shows up later', async () => {
    makeAdvance({ _id: 'N1' });
    razorpay.rzp_adv = [{ id: 'pay_x', status: 'failed', amount: 10000, currency: 'INR' }];
    const r = await recoverAbandonedCheckouts();
    const o = Order.get('N1');
    assert.strictEqual(o.status, 'cancelled');
    assert.strictEqual(o.cancelReason, 'Advance payment not completed in time');
    assert.strictEqual(o.isCancellable, false);
    assert.strictEqual(o.partialCodRefundEligible, true, 'a late advance capture after this cancel must be refundable');
    assert.strictEqual(o.partialCodAdvanceStatus, 'pending');
    assert.deepStrictEqual(calls.released, ['N1']);
    assert.deepStrictEqual(calls.notified, ['N1']);
    assert.strictEqual(calls.advancePaid.length, 0); assert.strictEqual(calls.paid.length, 0);
    assert.strictEqual(r.cancelled, 1);
  });

  await t('O: partial-COD advance captured late on Razorpay → settled through the advance-paid path, NOT cancelled', async () => {
    makeAdvance({ _id: 'O1' });
    razorpay.rzp_adv = [{ id: 'pay_late', status: 'captured', amount: 10000, currency: 'INR' }];
    const r = await recoverAbandonedCheckouts();
    assert.deepStrictEqual(calls.advancePaid, [{ id: 'O1', paymentId: 'pay_late' }]);
    assert.strictEqual(calls.paid.length, 0, 'must not use the full-checkout paid path');
    assert.strictEqual(Order.get('O1').status, 'placed');
    assert.strictEqual(calls.released.length, 0);
    assert.strictEqual(r.paid, 1); assert.strictEqual(r.cancelled, 0);
  });

  await t('P: partial-COD advance captured with the WRONG amount → left for review, never cancelled', async () => {
    makeAdvance({ _id: 'P1' });
    razorpay.rzp_adv = [{ id: 'pay_odd', status: 'captured', amount: 50000, currency: 'INR' }]; // full total, not the advance
    const r = await recoverAbandonedCheckouts();
    assert.strictEqual(Order.get('P1').status, 'placed');
    assert.strictEqual(calls.released.length, 0); assert.strictEqual(calls.advancePaid.length, 0);
    assert.strictEqual(r.held, 1);
  });

  await t('Q: partial-COD + Razorpay unreachable → not cancelled; cancelled on a later sweep', async () => {
    makeAdvance({ _id: 'Q1' });
    razorpay.rzp_adv = new Error('network down');
    await recoverAbandonedCheckouts();
    assert.strictEqual(Order.get('Q1').status, 'placed');
    razorpay.rzp_adv = [];
    await recoverAbandonedCheckouts();
    assert.strictEqual(Order.get('Q1').status, 'cancelled');
  });

  await t('R: partial-COD younger than the window (or refreshed by a payment retry) is left alone', async () => {
    makeAdvance({ _id: 'R1', createdAt: minutesAgo(40), updatedAt: minutesAgo(2) });
    const r = await recoverAbandonedCheckouts();
    assert.strictEqual(r.scanned, 0);
    assert.strictEqual(await expireAbandonedCheckout('R1'), 'none');
    assert.strictEqual(Order.get('R1').status, 'placed');
  });

  await t('S: the advance gets paid WHILE the sweeper is checking Razorpay → order is not cancelled', async () => {
    makeAdvance({ _id: 'S1' });
    razorpay.rzp_adv = [];
    onFetch = async () => { const d = Order.get('S1'); d.partialCodAdvanceStatus = 'paid'; d.razorpayPaymentId = 'pay_now'; };
    await recoverAbandonedCheckouts();
    assert.strictEqual(Order.get('S1').status, 'placed');
    assert.strictEqual(calls.released.length, 0);
  });

  await t('T: two simultaneous expiries of one partial-COD order → cancelled and released exactly once', async () => {
    makeAdvance({ _id: 'T1' });
    razorpay.rzp_adv = [];
    const out = await Promise.all([expireAbandonedCheckout('T1'), expireAbandonedCheckout('T1')]);
    assert.strictEqual(out.filter(x => x === 'cancelled').length, 1);
    assert.deepStrictEqual(calls.released, ['T1']);
    assert.deepStrictEqual(calls.notified, ['T1']);
  });

  await t('U: partial-COD with a cancelled / non-placed status or paid advance is never scanned', async () => {
    makeAdvance({ _id: 'U1', status: 'cancelled' });
    makeAdvance({ _id: 'U2', status: 'confirmed' });
    makeAdvance({ _id: 'U3', partialCodAdvanceStatus: 'refunded' });
    const r = await recoverAbandonedCheckouts();
    assert.strictEqual(r.scanned, 0);
  });

  await t('V: wiring — paymentController exports markPartialCodAdvancePaid for the sweeper', async () => {
    const pcSrc = fs.readFileSync(path.join(ROOT, 'controllers/paymentController.js'), 'utf8');
    assert.ok(/exports\.markPartialCodAdvancePaid\s*=\s*markPartialCodAdvancePaid/.test(pcSrc));
  });

  await t('W: advance captured but markPartialCodAdvancePaid cannot apply it (duplicate / odd state) → held for review, not counted paid, not cancelled', async () => {
    makeAdvance({ _id: 'W1' });
    razorpay.rzp_adv = [{ id: 'pay_dup', status: 'captured', amount: 10000, currency: 'INR' }];
    advanceResult = { paid: false, duplicate: true };
    const r = await recoverAbandonedCheckouts();
    assert.strictEqual(r.held, 1); assert.strictEqual(r.paid, 0); assert.strictEqual(r.cancelled, 0);
    assert.strictEqual(Order.get('W1').status, 'placed');
    assert.strictEqual(calls.released.length, 0);
  });

  console.log(`\n${pass} scenarios passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
