// Regression test: staff-initiated cancellation must release stock, refund the
// customer, stop the vendor ring and notify — never just flip the status.
// Runs with no database and no Razorpay (in-memory fakes). Usage: npm run test:staff-cancel
const Module = require('module');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { makeOrderModel } = require('./helpers/fakeOrderModel');
const ROOT = path.join(__dirname, '..');

const Order = makeOrderModel();
const calls = { refunds: [], released: [], rung: [], notified: [] };
const stubs = {
  [path.join(ROOT, 'models/Order.js')]: Order,
  [path.join(ROOT, 'models/Coupon.js')]: {},
  [path.join(ROOT, 'services/paymentService.js')]: {
    async fetchPayment() { return null; },
    async refundPayment(pid, amount, notes) { await new Promise(r => setTimeout(r, 5)); calls.refunds.push({ pid, amount, notes }); return { id: 'rfnd_' + calls.refunds.length, status: 'pending' }; },
  },
  [path.join(ROOT, 'services/settlementService.js')]: { async recordRestaurantPaymentFeeCharge() {}, async applyRefundAdjustment() {} },
  [path.join(ROOT, 'services/inventoryReservationService.js')]: { async releaseOrderInventory(o) { calls.released.push(String(o._id)); return { released: true }; } },
  [path.join(ROOT, 'services/notificationService.js')]: { async notifyOrderStatus(u, o) { calls.notified.push(String(o._id)); } },
  [path.join(ROOT, 'services/pushService.js')]: { async stopRing(id) { calls.rung.push(String(id)); } },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { if (stubs[req]) return req; return origResolve.call(this, req, parent, ...rest); };
for (const [k, v] of Object.entries(stubs)) require.cache[k] = { id: k, filename: k, loaded: true, exports: v };
const { cancelOrderByStaff } = require(path.join(ROOT, 'services/orderCancellationService.js'));

// The stored fake doc doubles as the "database row"; give it the two model methods the service uses.
const make = (o) => {
  const doc = Order.insert({ user: 'u1', paymentMethod: 'upi', paymentStatus: 'paid', status: 'confirmed', razorpayPaymentId: 'pay_1', total: 250, ...o });
  doc.advanceStatus = function (s) { this.status = s; return this; };
  doc.save = async function () { return this; };
  return doc;
};
const reset = () => { Order.docs.length = 0; for (const k of Object.keys(calls)) calls[k].length = 0; };

(async () => {
  let pass = 0;
  const t = async (name, fn) => { reset(); await fn(); pass++; console.log('PASS', name); };

  await t('paid UPI order cancelled by staff → stock released, full refund, ring stopped, customer notified', async () => {
    const o = make({ _id: 'S1' });
    await cancelOrderByStaff(o, { reason: 'Kitchen closed', actorId: 'admin1' });
    assert.strictEqual(Order.get('S1').status, 'cancelled');
    assert.strictEqual(Order.get('S1').cancelReason, 'Kitchen closed');
    assert.deepStrictEqual(calls.released, ['S1']);
    assert.strictEqual(calls.refunds.length, 1);
    assert.strictEqual(calls.refunds[0].pid, 'pay_1');
    assert.strictEqual(calls.refunds[0].amount, 250);
    assert.deepStrictEqual(calls.rung, ['S1']);
    assert.deepStrictEqual(calls.notified, ['S1']);
  });

  await t('unpaid UPI order can be cancelled: stock released, nothing to refund', async () => {
    const o = make({ _id: 'S2', paymentStatus: 'pending', razorpayPaymentId: '', status: 'placed' });
    await cancelOrderByStaff(o, { reason: 'x' });
    assert.strictEqual(Order.get('S2').status, 'cancelled');
    assert.deepStrictEqual(calls.released, ['S2']);
    assert.strictEqual(calls.refunds.length, 0);
  });

  await t('partial-COD with captured advance → advance is refunded when staff cancel', async () => {
    const o = make({ _id: 'S3', paymentMethod: 'cod', paymentStatus: 'cod_pending', total: 1000, partialCodAdvanceAmount: 100, partialCodAdvanceStatus: 'paid', razorpayPaymentId: 'pay_adv', partialCodRefundEligible: false });
    await cancelOrderByStaff(o, { reason: 'Restaurant issue' });
    assert.strictEqual(calls.refunds.length, 1, 'advance must go back to the customer');
    assert.strictEqual(calls.refunds[0].pid, 'pay_adv');
    assert.strictEqual(calls.refunds[0].amount, 100);
  });

  await t('already delivered / cancelled orders are refused with 409 and nothing happens', async () => {
    for (const status of ['delivered', 'cancelled']) {
      const o = make({ _id: 'S4' + status, status });
      await assert.rejects(() => cancelOrderByStaff(o, {}), (e) => e.statusCode === 409);
    }
    assert.strictEqual(calls.refunds.length, 0); assert.strictEqual(calls.released.length, 0);
  });

  await t('two simultaneous staff cancels → exactly one refund', async () => {
    const a = make({ _id: 'S5' });
    await Promise.all([cancelOrderByStaff(a, { reason: 'a' }), (async () => { const b = Order.get('S5'); b.status = 'confirmed'; return cancelOrderByStaff(b, { reason: 'b' }); })()]);
    assert.strictEqual(calls.refunds.length, 1);
  });

  await t('contract: every staff/legacy cancel entry point delegates to cancelOrderByStaff', async () => {
    const admin = fs.readFileSync(path.join(ROOT, 'controllers/adminController.js'), 'utf8');
    const orders = fs.readFileSync(path.join(ROOT, 'controllers/orderController.js'), 'utf8');
    const uses = (src) => (src.match(/cancelOrderByStaff\(/g) || []).length;
    assert.ok(uses(admin) >= 2, 'adminController: updateOrderStatus AND cancelOrder must both use cancelOrderByStaff');
    assert.ok(uses(orders) >= 1, 'orderController.updateOrderStatus must use cancelOrderByStaff for status=cancelled');
  });

  console.log(`\n${pass} scenarios passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
