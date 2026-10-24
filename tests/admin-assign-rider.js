// Regression test: the admin "assign rider" endpoint must apply the same safety rules
// as automatic dispatch (the admin chooses WHO, not whether the order is ready):
//   order  -> accepted by the restaurant, paid (online / COD advance), not self-delivery
//   rider  -> active, online, below the live active-order cap, under the COD cash limit
//   write  -> one atomic claim, so it cannot race auto-dispatch or another admin
// The assigned rider is also notified (before, a manual assignment never pinged them).
// Runs with no database (in-memory fakes). Usage: npm run test:admin-assign-rider
const Module = require('module');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { makeOrderModel } = require('./helpers/fakeOrderModel');
const ROOT = path.join(__dirname, '..');

const Order = makeOrderModel();
Order.countDocuments = async (filter) => (await Order.find(filter)).length;
const riders = new Map();
let userHook = null; // runs while the service is loading the rider (simulates a concurrent write)
const User = {
  findOne(filter) {
    const q = {
      select() { return q; },
      then(res, rej) {
        return (async () => {
          if (userHook) await userHook();
          const r = riders.get(String(filter._id));
          return r && (!filter.role || r.role === filter.role) ? r : null;
        })().then(res, rej);
      },
    };
    return q;
  },
};
const calls = { notified: [], timers: [] };
let notifyShouldThrow = false;
let cap = 3;
const stubs = {
  [path.join(ROOT, 'models/Order.js')]: Order,
  [path.join(ROOT, 'models/User.js')]: User,
  [path.join(ROOT, 'services/notificationService.js')]: {
    async notifyRiderAssignment(order, rider) { if (notifyShouldThrow) throw new Error('push down'); calls.notified.push({ order: String(order._id), rider: String(rider._id) }); },
  },
  [path.join(ROOT, 'services/riderAssignmentService.js')]: {
    ACTIVE_RIDER_STATUSES: ['assigned', 'accepted', 'reached_restaurant', 'picked_up', 'out_for_delivery'],
    async resolveMaxActiveOrdersPerRider() { return cap; },
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { if (stubs[req]) return req; return origResolve.call(this, req, parent, ...rest); };
for (const [k, v] of Object.entries(stubs)) require.cache[k] = { id: k, filename: k, loaded: true, exports: v };

let svc;
try { svc = require(path.join(ROOT, 'services/manualRiderAssignmentService.js')); }
catch (e) { console.error('FAIL: services/manualRiderAssignmentService.js is missing or broken:', e.message); process.exit(1); }

const rider = (id, over = {}) => { const r = { _id: id, name: 'Rider ' + id, role: 'rider', isActive: true, riderDetails: { isOnline: true, cashInHand: 0, codCashLimit: 2000 }, ...over }; riders.set(id, r); return r; };
const order = (over = {}) => Order.insert({
  _id: 'O1', status: 'confirmed', paymentMethod: 'upi', paymentStatus: 'paid', partialCodAdvanceAmount: 0, partialCodAdvanceStatus: 'not_required',
  deliveryModeSnapshot: 'platform', rider: null, riderStatus: 'unassigned', dispatchStatus: 'searching', deliveryFee: 30, tipAmount: 10,
  riderStatusHistory: [], ...over,
});
const busy = (riderId, n, over = {}) => { for (let i = 0; i < n; i++) Order.insert({ _id: `B-${riderId}-${i}-${Math.random()}`, rider: riderId, riderStatus: 'accepted', status: 'preparing', ...over }); };
const reset = () => { Order.docs.length = 0; riders.clear(); calls.notified.length = 0; userHook = null; notifyShouldThrow = false; cap = 3; };
const assign = (riderId, id = 'O1') => svc.assignRiderByAdmin({ orderId: id, riderId, adminName: 'Admin' });
const refused = async (promise, status, code) => {
  const r = await promise;
  assert.strictEqual(r.ok, false, 'must be refused');
  assert.strictEqual(r.status, status);
  if (code) assert.strictEqual(r.code, code);
  return r;
};

(async () => {
  let pass = 0;
  const t = async (name, fn) => { reset(); await fn(); pass++; console.log('PASS', name); };

  await t('A: valid assignment → atomic claim, status fields set, earning = fee + tip, rider notified', async () => {
    rider('R1'); order();
    const r = await assign('R1');
    assert.strictEqual(r.ok, true);
    const o = Order.get('O1');
    assert.strictEqual(String(o.rider), 'R1');
    assert.strictEqual(o.riderStatus, 'assigned');
    assert.strictEqual(o.dispatchStatus, 'assigned');
    assert.strictEqual(o.riderEarning, 40);
    assert.ok(o.riderAssignedAt);
    assert.strictEqual(o.riderStatusHistory.length, 1);
    assert.match(o.riderStatusHistory[0].note, /Assigned to Rider R1 by Admin/);
    assert.deepStrictEqual(calls.notified, [{ order: 'O1', rider: 'R1' }]);
  });

  await t('B: order not dispatchable (placed / out_for_delivery / otp_verified / delivered / cancelled) → 409, nothing changes', async () => {
    rider('R1');
    for (const status of ['placed', 'out_for_delivery', 'otp_verified', 'delivered', 'cancelled']) {
      Order.docs.length = 0; order({ status });
      await refused(assign('R1'), 409, 'ORDER_NOT_DISPATCHABLE');
      assert.strictEqual(Order.get('O1').rider, null, status);
    }
    assert.strictEqual(calls.notified.length, 0);
  });

  await t('C: statuses a rider may legitimately be set on: confirmed, preparing, waiting_for_rider, assigned (before pickup)', async () => {
    rider('R1');
    for (const status of ['confirmed', 'preparing', 'waiting_for_rider']) {
      Order.docs.length = 0; order({ status });
      assert.strictEqual((await assign('R1')).ok, true, status);
    }
    Order.docs.length = 0; order({ status: 'assigned', rider: 'R9', riderStatus: 'accepted', riderEarning: 40 }); rider('R9');
    assert.strictEqual((await assign('R1')).ok, true, 'reassign before pickup');
  });

  await t('D: unpaid online order → 409 ORDER_NOT_PAID; paid online, plain COD, and partial-COD with PAID advance are fine', async () => {
    rider('R1');
    order({ paymentStatus: 'pending' });
    await refused(assign('R1'), 409, 'ORDER_NOT_PAID');
    Order.docs.length = 0; order({ paymentMethod: 'cod', paymentStatus: 'cod_pending', partialCodAdvanceAmount: 100, partialCodAdvanceStatus: 'pending' });
    await refused(assign('R1'), 409, 'ORDER_NOT_PAID');
    assert.strictEqual(Order.get('O1').rider, null);
    Order.docs.length = 0; order({ paymentMethod: 'cod', paymentStatus: 'cod_pending', partialCodAdvanceAmount: 100, partialCodAdvanceStatus: 'paid' });
    assert.strictEqual((await assign('R1')).ok, true);
    Order.docs.length = 0; order({ paymentMethod: 'cod', paymentStatus: 'cod_pending' });
    assert.strictEqual((await assign('R1')).ok, true);
  });

  await t('E: restaurant self-delivery order → 409 (platform riders do not deliver it)', async () => {
    rider('R1'); order({ deliveryModeSnapshot: 'self_delivery' });
    await refused(assign('R1'), 409, 'ORDER_SELF_DELIVERY');
    assert.strictEqual(Order.get('O1').rider, null);
  });

  await t('F: rider missing / not a rider → 404; disabled → 409; offline → 409 RIDER_OFFLINE', async () => {
    order();
    await refused(assign('nope'), 404);
    riders.set('U1', { _id: 'U1', role: 'user', isActive: true, name: 'Cust' });
    await refused(assign('U1'), 404);
    rider('R2', { isActive: false });
    await refused(assign('R2'), 409);
    rider('R3', { riderDetails: { isOnline: false, cashInHand: 0, codCashLimit: 2000 } });
    await refused(assign('R3'), 409, 'RIDER_OFFLINE');
    assert.strictEqual(Order.get('O1').rider, null);
    assert.strictEqual(calls.notified.length, 0);
  });

  await t('G: capacity — at the live cap → 409 RIDER_AT_CAPACITY; below it fine; delivered/cancelled jobs do not count; cap follows platform setting', async () => {
    rider('R1'); order();
    busy('R1', 3);
    await refused(assign('R1'), 409, 'RIDER_AT_CAPACITY');
    cap = 4;
    assert.strictEqual((await assign('R1')).ok, true, 'cap raised in platform settings');
    reset(); rider('R1'); order(); busy('R1', 2);
    assert.strictEqual((await assign('R1')).ok, true, 'two active jobs, cap 3');
    reset(); rider('R1'); order(); busy('R1', 5, { status: 'delivered', riderStatus: 'delivered' }); busy('R1', 5, { status: 'cancelled' });
    assert.strictEqual((await assign('R1')).ok, true, 'finished jobs are not load');
  });

  await t('H: re-assigning the rider who already holds this order is a no-op even when that rider is AT the cap (this order is one of their jobs)', async () => {
    rider('R1'); order({ status: 'assigned', rider: 'R1', riderStatus: 'assigned', riderEarning: 40 });
    busy('R1', 2); // 2 others + this order = 3 = cap
    const r = await assign('R1');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.alreadyAssigned, true);
  });

  await t('I: COD cash limit — rider at the limit cannot take a COD order but can take a prepaid one', async () => {
    rider('R1', { riderDetails: { isOnline: true, cashInHand: 2000, codCashLimit: 2000 } });
    order({ paymentMethod: 'cod', paymentStatus: 'cod_pending' });
    await refused(assign('R1'), 409, 'RIDER_CASH_LIMIT');
    assert.strictEqual(Order.get('O1').rider, null);
    Order.docs.length = 0; order();
    assert.strictEqual((await assign('R1')).ok, true);
  });

  await t('J: rider already carrying the food (reached_restaurant / picked_up / out_for_delivery) → cannot be reassigned', async () => {
    rider('R1'); rider('R2');
    for (const riderStatus of ['reached_restaurant', 'picked_up', 'out_for_delivery']) {
      Order.docs.length = 0; order({ status: 'preparing', rider: 'R1', riderStatus });
      await refused(assign('R2'), 409, 'ORDER_IN_DELIVERY');
      assert.strictEqual(String(Order.get('O1').rider), 'R1', riderStatus);
    }
  });

  await t('K: reassigning keeps the original riderEarning (tip is never double counted) and records history', async () => {
    rider('R1'); rider('R2');
    order({ status: 'assigned', rider: 'R1', riderStatus: 'assigned', riderEarning: 40, riderStatusHistory: [{ status: 'assigned', note: 'first' }] });
    assert.strictEqual((await assign('R2')).ok, true);
    const o = Order.get('O1');
    assert.strictEqual(String(o.rider), 'R2');
    assert.strictEqual(o.riderEarning, 40);
    assert.strictEqual(o.riderStatusHistory.length, 2);
  });

  await t('L: assigning the rider who already has it is a harmless no-op (no second push, no history spam)', async () => {
    rider('R1'); order();
    await assign('R1');
    const again = await assign('R1');
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.alreadyAssigned, true);
    assert.strictEqual(Order.get('O1').riderStatusHistory.length, 1);
    assert.strictEqual(calls.notified.length, 1);
  });

  await t('M: two admins assign different riders at once → exactly one wins; the other gets 409 ORDER_CHANGED', async () => {
    rider('R1'); rider('R2'); order();
    const [a, b] = await Promise.all([assign('R1'), assign('R2')]);
    assert.strictEqual([a, b].filter(x => x.ok).length, 1);
    const loser = [a, b].find(x => !x.ok);
    assert.strictEqual(loser.status, 409); assert.strictEqual(loser.code, 'ORDER_CHANGED');
    assert.strictEqual(calls.notified.length, 1);
  });

  await t('N: auto-dispatch claims the order while the admin request is in flight → admin gets 409, auto-dispatch keeps it', async () => {
    rider('R1'); rider('R2'); order();
    userHook = async () => { const o = Order.get('O1'); o.rider = 'R2'; o.riderStatus = 'assigned'; };
    const r = await refused(assign('R1'), 409, 'ORDER_CHANGED');
    assert.strictEqual(String(Order.get('O1').rider), 'R2');
    assert.strictEqual(calls.notified.length, 0);
  });

  await t('O: order cancelled while the admin request is in flight → no rider is attached to a dead order', async () => {
    rider('R1'); order();
    userHook = async () => { Order.get('O1').status = 'cancelled'; };
    await refused(assign('R1'), 409, 'ORDER_CHANGED');
    assert.strictEqual(Order.get('O1').rider, null);
  });

  await t('S: the rider picks the food up while the admin request is in flight → admin gets 409 ORDER_CHANGED, pickup is not overwritten', async () => {
    rider('R1'); rider('R2'); order({ status: 'assigned', rider: 'R1', riderStatus: 'accepted', riderEarning: 40 });
    userHook = async () => { Order.get('O1').riderStatus = 'picked_up'; };
    await refused(assign('R2'), 409, 'ORDER_CHANGED');
    assert.strictEqual(String(Order.get('O1').rider), 'R1');
    assert.strictEqual(Order.get('O1').riderStatus, 'picked_up');
  });

  await t('P: push notification failure never fails the assignment', async () => {
    rider('R1'); order(); notifyShouldThrow = true;
    const r = await assign('R1');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(String(Order.get('O1').rider), 'R1');
  });

  await t('Q: unknown order → 404', async () => {
    rider('R1');
    await refused(assign('R1', 'missing'), 404);
  });

  await t('R: wiring — controller delegates to the service; route stays admin-only; helper exports exist', async () => {
    const ctl = fs.readFileSync(path.join(ROOT, 'controllers/orderController.js'), 'utf8');
    assert.ok(ctl.includes("require('../services/manualRiderAssignmentService')"), 'controller must import the service');
    const body = ctl.slice(ctl.indexOf('const assignRider = asyncHandler'), ctl.indexOf('module.exports'));
    assert.ok(/assignRiderByAdmin\(/.test(body), 'assignRider must call assignRiderByAdmin');
    assert.ok(!/order\.rider\s*=\s*rider\._id/.test(body), 'assignRider must not write the rider directly any more');
    const routes = fs.readFileSync(path.join(ROOT, 'routes/orderRoutes.js'), 'utf8');
    assert.ok(/router\.put\('\/:id\/assign-rider', protect, authorize\('admin'\), assignRider\)/.test(routes));
    const ras = fs.readFileSync(path.join(ROOT, 'services/riderAssignmentService.js'), 'utf8');
    assert.ok(/module\.exports = \{[^}]*ACTIVE_RIDER_STATUSES/.test(ras), 'riderAssignmentService must export ACTIVE_RIDER_STATUSES');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.scripts['test:admin-assign-rider'], 'node tests/admin-assign-rider.js');
  });

  console.log(`\n${pass} scenarios passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
