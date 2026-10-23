'use strict';

// End-to-end verification of the Eatswada feature set added in this change:
//   • Partial COD resolution through the REAL checkout controller (Pillar 3)
//   • Per-customer COD policy override (50% online abuse policy)
//   • Account freeze blocking checkout (Pillar 7)
//   • Admin COD trust overview + policy update + freeze (Pillar 3/7)
//   • Rider/vendor payment view shows the correct cash due (req 11)
//   • Visit analytics idempotency and platform/vendor rollups (Pillar 8)
//   • Review reporting is one-per-customer and flags the review (req 17)
//   • Admin permission modules gate support/trust/review routes (work division)
//   • Rider concurrency cap + distance-pay cap (req 12/14)
//
// Runs against a disposable in-memory MongoDB REPLICA SET so the real
// controller paths and transactions are exercised.
//
//   node tests/eatswada-features-e2e.test.js

const assert = require('node:assert/strict');
const path = require('path');
const mongoose = require('mongoose');
const { startReplSet, stopReplSet, makeRes, makeReq, makeReporter } = require('./helpers/replset');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// The checkout controller's Razorpay path must never be hit by a COD test.
const ROOT = path.join(__dirname, '..');
const paymentServicePath = path.join(ROOT, 'services/paymentService.js');
require.cache[paymentServicePath] = {
  id: paymentServicePath, filename: paymentServicePath, loaded: true,
  exports: { createRazorpayOrder: async () => ({ id: 'order_test' }), assertConfigured() {}, refundPayment: async () => ({ id: 'rfnd_x', status: 'processed' }) },
};

const User = require('../models/User');
const Order = require('../models/Order');
const Restaurant = require('../models/Restaurant');
const Menu = require('../models/Menu');
const Address = require('../models/Address');
const Review = require('../models/Review');
const SupportTicket = require('../models/SupportTicket');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const orderController = require('../controllers/orderController');
const adminController = require('../controllers/adminController');
const analyticsController = require('../controllers/analyticsController');
const { buildPaymentView } = require('../services/orderPaymentView');
const { resolveCodTerms } = require('../services/codPolicyService');
const { recordCodFailure } = require('../services/customerTrustService');
const { resolveMaxActiveOrdersPerRider } = require('../services/riderAssignmentService');
const { computeRiderEarning } = require('../services/riderEarningService');

const { test, finish } = makeReporter('Eatswada feature end-to-end');
const PlatformSetting = require('../models/PlatformSetting');
let seq = 0;

// The launch default caps COD cash at ₹1,000, which is below the partial-COD
// threshold — so a ₹1,200 COD order would be refused by the cap before the
// advance logic runs. Raise the cap once so the partial-COD path is reachable.
async function seedSettings() {
  await PlatformSetting.updateOne(
    { key: 'platform' },
    { $set: { maxCodOrderAmount: 10000, codAdvanceThreshold: 1000, codAdvancePercent: 10 } },
    { upsert: true }
  );
}

async function invoke(handler, req) {
  const res = makeRes();
  let error = null;
  await new Promise((resolve) => {
    const next = (err) => { error = err || null; resolve(); };
    const maybe = handler(req, res, next);
    if (maybe && typeof maybe.then === 'function') maybe.then(() => resolve(), () => resolve());
    else resolve();
  });
  // Controllers signal a rejected checkout either by responding (json) or by
  // throwing a domain error to the error middleware. Capture the latter as a
  // status so tests can assert on the outcome instead of crashing.
  if (error) return { statusCode: error.statusCode || error.status || 500, body: { success: false, code: error.code, message: error.message }, error };
  return res;
}

async function seedCustomer({ codEnabled = true, price = 1200, codPolicy = undefined, accountStatus = 'active' } = {}) {
  seq += 1;
  const owner = await User.create({ name: 'Owner', phone: `8100000${String(seq).padStart(3, '0')}`, role: 'vendor', password: 'x'.repeat(12) });
  const customer = await User.create({ name: 'Cust', phone: `8200000${String(seq).padStart(3, '0')}`, role: 'user', password: 'x'.repeat(12), accountStatus });
  if (codPolicy) await User.updateOne({ _id: customer._id }, { $set: { codPolicy } });
  // The automatic shortage circuit breaker (on by default) blocks checkout when
  // no rider is online, so every checkout test needs one online rider.
  await User.create({
    name: 'Rider', phone: `8500000${String(seq).padStart(3, '0')}`, role: 'rider', password: 'x'.repeat(12),
    riderDetails: { isOnline: true, currentLocation: { type: 'Point', coordinates: [88.8200, 26.5600], updatedAt: new Date() } },
  });
  const restaurant = await Restaurant.create({
    name: `E2E${seq}`, owner: owner._id, cuisines: ['Indian'], isActive: true, codEnabled,
    location: { type: 'Point', coordinates: [88.8210, 26.5610] },
  });
  const menu = await Menu.create({ name: 'Dish', price, inStock: true, restaurantId: restaurant._id });
  const address = await Address.create({
    user: customer._id, tag: 'Home', house: '12', area: 'Maynaguri', city: 'Maynaguri', pincode: '735224',
    location: { type: 'Point', coordinates: [88.8200, 26.5600] },
  });
  return { owner, customer, restaurant, menu, address };
}

// A minimal Order row so Review documents (order is required + unique) can exist.
async function makeOrder(customer, restaurant) {
  return Order.create({
    user: customer._id, restaurant: restaurant._id, restaurantName: restaurant.name,
    items: [{ menuItem: new mongoose.Types.ObjectId(), name: 'Dish', price: 200, quantity: 1, status: 'delivered' }],
    deliveryAddress: { label: 'Home', line1: '1', area: 'Maynaguri', city: 'Maynaguri' },
    subtotal: 200, total: 200, paymentMethod: 'upi', paymentStatus: 'paid', status: 'delivered',
  });
}

async function checkout({ customer, menu, address, paymentMethod = 'cod' }) {
  return invoke(orderController.createOrder, {
    user: { _id: customer._id, name: customer.name, role: 'user' },
    headers: {},
    body: {
      items: [{ menuItem: String(menu._id), quantity: 1 }],
      addressId: String(address._id),
      paymentMethod,
    },
  });
}

(async () => {
  await startReplSet();
  await seedSettings();

  // ── Partial COD through the real checkout controller (req 5) ──────────
  await test('E1: COD above ₹1,000 charges a 10% advance and the rest at the door', async () => {
    const { customer, menu, address } = await seedCustomer({ price: 1200 });
    const res = await checkout({ customer, menu, address });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    const order = await Order.findOne({ user: customer._id }).sort({ createdAt: -1 }).lean();
    assert.ok(order, 'order created');
    assert.equal(order.paymentMethod, 'cod');
    // Food subtotal 1200 → advance 10% = 120, cash due = grand total - 120.
    assert.equal(Number(order.partialCodAdvanceAmount), 120, `advance was ${order.partialCodAdvanceAmount}`);
    assert.equal(order.partialCodAdvanceStatus, 'pending');
    assert.equal(Number(order.partialCodCashDue), Math.round((Number(order.total) - 120) * 100) / 100);
    assert.equal(order.paymentStatus, 'cod_pending');
  });

  await test('E2: COD at or below the threshold requires no advance', async () => {
    const { customer, menu, address } = await seedCustomer({ price: 500 });
    const res = await checkout({ customer, menu, address });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    const order = await Order.findOne({ user: customer._id }).sort({ createdAt: -1 }).lean();
    assert.equal(Number(order.partialCodAdvanceAmount || 0), 0);
    assert.equal(order.paymentStatus, 'cod_pending');
  });

  await test('E3: a per-customer 50% policy forces half online (abuse policy)', async () => {
    const { customer, menu, address } = await seedCustomer({ price: 1200, codPolicy: { advanceRequiredAbove: 0, advancePercent: 50 } });
    const res = await checkout({ customer, menu, address });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    const order = await Order.findOne({ user: customer._id }).sort({ createdAt: -1 }).lean();
    assert.equal(Number(order.partialCodAdvanceAmount), 600, `advance was ${order.partialCodAdvanceAmount}`);
  });

  await test('E4: resolveCodTerms treats a stored null policy as "no override"', async () => {
    // A real Mongoose user doc persists unset Numbers as null. This must fall
    // back to the platform default (10% / ₹1,000), not silently disable it.
    const real = await User.create({ name: 'Null', phone: `8300000${String(seq).padStart(3, '0')}`, role: 'user', password: 'x'.repeat(12) });
    const lean = await User.findById(real._id).select('codPolicy').lean();
    assert.equal(lean.codPolicy.advanceRequiredAbove, null, 'precondition: stored as null');
    const terms = resolveCodTerms({ subtotalRupees: 1500, discountRupees: 0, grandTotalRupees: 1600, settings: { codAdvanceThreshold: 1000, codAdvancePercent: 10 }, customer: lean });
    assert.equal(terms.required, true);
    assert.equal(terms.advancePercent, 10);
    assert.equal(terms.advancePaise, 15000);
    assert.equal(terms.source, 'platform');
  });

  // ── COD platform/restaurant gating (req 1/3) ──────────────────────────
  await test('E5: COD is refused when the restaurant has COD disabled', async () => {
    const { customer, menu, address } = await seedCustomer({ codEnabled: false });
    const res = await checkout({ customer, menu, address });
    assert.notEqual(res.statusCode, 201);
    assert.match(String(res.body?.message || ''), /Cash on Delivery is disabled/i);
  });

  // ── Account freeze (req 7) ────────────────────────────────────────────
  await test('E6: a frozen account cannot check out, even with UPI', async () => {
    const { customer, menu, address } = await seedCustomer({ accountStatus: 'frozen' });
    const cod = await checkout({ customer, menu, address, paymentMethod: 'cod' });
    assert.equal(cod.statusCode, 403);
    const upi = await checkout({ customer, menu, address, paymentMethod: 'upi' });
    assert.equal(upi.statusCode, 403);
    assert.equal(await Order.countDocuments({ user: customer._id }), 0);
  });

  // ── Payment view for rider/vendor apps (req 11) ───────────────────────
  await test('E7: the payment view shows ₹100 paid and ₹900 to collect', async () => {
    const view = buildPaymentView({
      paymentMethod: 'cod', total: 1000, paymentStatus: 'cod_pending',
      partialCodAdvanceAmount: 100, partialCodCashDue: 900, partialCodAdvanceStatus: 'paid',
    });
    assert.equal(view.isPartialCod, true);
    assert.equal(view.advancePaid, 100);
    assert.equal(view.cashToCollect, 900);
    assert.equal(view.blocksDelivery, false);
    assert.match(view.label, /₹100 paid online/);
  });

  await test('E8: the payment view blocks delivery until the advance is paid', async () => {
    const view = buildPaymentView({
      paymentMethod: 'cod', total: 1000, paymentStatus: 'cod_pending',
      partialCodAdvanceAmount: 100, partialCodCashDue: 900, partialCodAdvanceStatus: 'pending',
    });
    assert.equal(view.advancePaid, 0);
    assert.equal(view.blocksDelivery, true);
    // The label must state the amount DUE, not claim "₹0 paid online".
    assert.match(view.label, /₹100 advance due/);
  });

  await test('E9: a plain COD order shows "Cash on Delivery — Free"', async () => {
    const view = buildPaymentView({ paymentMethod: 'cod', total: 300, paymentStatus: 'cod_pending' });
    assert.equal(view.isPartialCod, false);
    assert.equal(view.cashToCollect, 300);
    assert.equal(view.label, 'Cash on Delivery — Free');
  });

  await test('E9b: the COD label honours the admin-configured platform setting', async () => {
    const view = buildPaymentView({ paymentMethod: 'cod', total: 300, paymentStatus: 'cod_pending' }, { codDisplayLabel: 'COD · No extra fee' });
    assert.equal(view.label, 'COD · No extra fee');
    // The Admin console writes through the structured singleton path.
    const { getPlatformSettings, updatePlatformConfig } = require('../services/platformSettingsService');
    await updatePlatformConfig({ codDisplayLabel: 'Pay cash at the door — no fee' });
    const settings = await getPlatformSettings();
    assert.equal(settings.codDisplayLabel, 'Pay cash at the door — no fee');
    // And that stored value flows straight into the view.
    assert.equal(buildPaymentView({ paymentMethod: 'cod', total: 300 }, { codDisplayLabel: settings.codDisplayLabel }).label, 'Pay cash at the door — no fee');
  });

  await test('E10: once cash is collected the view shows nothing left to collect', async () => {
    const view = buildPaymentView({
      paymentMethod: 'cod', total: 1000, paymentStatus: 'cod_collected',
      partialCodAdvanceAmount: 100, partialCodCashDue: 900, partialCodAdvanceStatus: 'paid',
      cashCollected: true, codCashCollectedAmount: 900, codCollectedAt: new Date(),
    });
    assert.equal(view.cashCollected, true);
    assert.equal(view.cashToCollect, 0);
  });

  // ── Admin trust + freeze console (req 6/7) ────────────────────────────
  await test('E11: the admin trust overview reports counters and effective policy', async () => {
    const { customer } = await seedCustomer({ codPolicy: { advanceRequiredAbove: 0, advancePercent: 50 } });
    await recordCodFailure(customer._id, { kind: 'refused', reasonCode: 'customer_requested_cancel' });
    const res = await invoke(adminController.getCustomerTrust, {
      user: { _id: new mongoose.Types.ObjectId(), role: 'admin' },
      params: { userId: String(customer._id) },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.codTrust.refusedDeliveries, 1);
    assert.equal(res.body.data.codPolicy.advancePercent, 50);
    // The reason code must actually persist (a field absent from the schema
    // would be silently dropped by Mongoose).
    const stored = await User.findById(customer._id).select('codTrust').lean();
    assert.equal(stored.codTrust.lastReasonCode, 'customer_requested_cancel');
  });

  await test('E12: an admin can freeze a customer and unfreeze them', async () => {
    const { customer } = await seedCustomer();
    const admin = new mongoose.Types.ObjectId();
    const frozen = await invoke(adminController.setCustomerAccountFreeze, {
      user: { _id: admin, role: 'admin' }, params: { userId: String(customer._id) }, body: { frozen: true, reason: 'Wasted food' },
    });
    assert.equal(frozen.statusCode, 200, JSON.stringify(frozen.body));
    assert.equal((await User.findById(customer._id).lean()).accountStatus, 'frozen');
    await invoke(adminController.setCustomerAccountFreeze, {
      user: { _id: admin, role: 'admin' }, params: { userId: String(customer._id) }, body: { frozen: false },
    });
    assert.equal((await User.findById(customer._id).lean()).accountStatus, 'active');
  });

  await test('E13: the admin COD policy update clears the auto-block flag on unblock', async () => {
    const { customer } = await seedCustomer();
    await User.updateOne({ _id: customer._id }, { $set: { isCodBlocked: true, 'codTrust.autoBlocked': true } });
    const res = await invoke(adminController.updateCustomerCodPolicy, {
      user: { _id: new mongoose.Types.ObjectId(), role: 'admin' }, params: { userId: String(customer._id) }, body: { isCodBlocked: false },
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const u = await User.findById(customer._id).lean();
    assert.equal(u.isCodBlocked, false);
    assert.equal(u.codTrust.autoBlocked, false);
  });

  // ── Visit analytics (req 8/9) ─────────────────────────────────────────
  await test('E14: platform visits are counted once per visitor per day', async () => {
    const visitor = { userId: new mongoose.Types.ObjectId() };
    const req = () => makeReq({ user: visitor, body: { eventType: 'site_visit' }, headers: { 'user-agent': 'jest' } });
    await invoke(analyticsController.trackVisit, req());
    await invoke(analyticsController.trackVisit, req());
    const count = await AnalyticsEvent.countDocuments({ scope: 'platform', eventType: 'site_visit' });
    assert.equal(count, 1, 'a refresh loop must not inflate visits');
  });

  await test('E15: a restaurant menu view is recorded and attributed', async () => {
    const { restaurant } = await seedCustomer();
    const res = await invoke(analyticsController.trackVisit, makeReq({
      user: { _id: new mongoose.Types.ObjectId(), role: 'user' },
      body: { eventType: 'menu_view', restaurantId: String(restaurant._id) },
      headers: { 'user-agent': 'jest' },
    }));
    assert.equal(res.statusCode, 202, JSON.stringify(res.body));
    const row = await AnalyticsEvent.findOne({ scope: 'restaurant', restaurant: restaurant._id }).lean();
    assert.ok(row, 'menu view recorded');
    assert.equal(row.eventType, 'menu_view');
  });

  await test('E16: the vendor menu analytics rollup returns a summary', async () => {
    const { restaurant } = await seedCustomer();
    await invoke(analyticsController.trackVisit, makeReq({
      user: { _id: new mongoose.Types.ObjectId(), role: 'user' },
      body: { eventType: 'restaurant_view', restaurantId: String(restaurant._id) }, headers: {},
    }));
    const res = await invoke(analyticsController.getVendorMenuAnalytics, {
      user: { _id: new mongoose.Types.ObjectId(), role: 'vendor', restaurantId: restaurant._id }, query: {},
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.summary.totalViews >= 1);
    assert.ok(Array.isArray(res.body.data.byEventType));
  });

  // ── Review reporting (req 17) ─────────────────────────────────────────
  await test('E17: a review can be reported once per customer and gets flagged', async () => {
    const { customer, restaurant } = await seedCustomer();
    const reporter = await User.create({ name: 'Rep', phone: `8400000${String(seq).padStart(3, '0')}`, role: 'user', password: 'x'.repeat(12) });
    const review = await Review.create({ user: customer._id, restaurant: restaurant._id, order: (await makeOrder(customer, restaurant))._id, score: 1, comment: 'fake' });
    const body = { reason: 'Abusive language' };
    const r1 = await invoke(orderController.reportReview, { user: { _id: reporter._id }, params: { reviewId: String(review._id) }, body });
    assert.equal(r1.statusCode, 201, JSON.stringify(r1.body));
    const r2 = await invoke(orderController.reportReview, { user: { _id: reporter._id }, params: { reviewId: String(review._id) }, body });
    assert.equal(r2.statusCode, 200);
    const fresh = await Review.findById(review._id).lean();
    assert.equal(fresh.reportedCount, 1, 'a customer reports a review once');
    assert.equal(fresh.isFlagged, true);
  });

  await test('E18: a customer cannot report their own review', async () => {
    const { customer, restaurant } = await seedCustomer();
    const review = await Review.create({ user: customer._id, restaurant: restaurant._id, order: (await makeOrder(customer, restaurant))._id, score: 1, comment: 'mine' });
    const res = await invoke(orderController.reportReview, { user: { _id: customer._id }, params: { reviewId: String(review._id) }, body: { reason: 'x' } });
    assert.equal(res.statusCode, 400);
  });

  // ── Rider capacity + pay cap (req 12/14) ──────────────────────────────
  await test('E19: the rider concurrency cap resolves to at least 1', async () => {
    const cap = await resolveMaxActiveOrdersPerRider();
    assert.ok(Number.isFinite(cap) && cap >= 1, `cap was ${cap}`);
  });

  await test('E20: rider distance pay is capped at 3 km (₹15)', async () => {
    const order = { deliveryDistanceKm: 10, total: 500 };
    const earning = await computeRiderEarning(order);
    const settings = require('../services/platformSettingsService');
    const s = await settings.getPlatformSettings();
    const expectedCap = Number(s.riderPerKmPay) * Number(s.riderMaxDistanceKm);
    assert.ok(earning.distancePay <= expectedCap + 0.001, `distancePay ${earning.distancePay} must be ≤ ${expectedCap}`);
  });

  // ── Support SLA + typing (req 16) ─────────────────────────────────────
  await test('E21: a support ticket gets SLA due dates and a typing ping works', async () => {
    const { customer } = await seedCustomer();
    const ticket = await SupportTicket.create({ customer: customer._id, subject: 'Late order', category: 'late_order', status: 'open', priority: 'normal' });
    const { slaDueDates } = require('../utils/supportHelpers');
    const due = slaDueDates('urgent', new Date());
    assert.ok(due.firstResponseDueAt instanceof Date && due.resolutionDueAt instanceof Date);
    const customerSupport = require('../controllers/customerSupportController');
    const res = await invoke(customerSupport.setTyping, { user: { _id: customer._id }, params: { id: String(ticket._id) }, body: { typing: true } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const fresh = await SupportTicket.findById(ticket._id).lean();
    assert.equal(fresh.typingRole, 'user');
  });

  await test('E22: notifications persist for every recipient (keyless rows must not collide)', async () => {
    const Notification = require('../models/Notification');
    await Notification.syncIndexes();
    const a = new mongoose.Types.ObjectId();
    const b = new mongoose.Types.ObjectId();
    // Regression: a sparse UNIQUE index over a field with `default: null` let
    // only the FIRST keyless notification ever be written; every later one hit
    // E11000 and was silently dropped. Three keyless rows must all persist.
    await Notification.create({ user: a, title: 'Order confirmed', message: 'x' });
    await Notification.create({ user: a, title: 'Rider assigned', message: 'x' });
    await Notification.create({ user: b, title: 'Order delivered', message: 'x' });
    assert.equal(await Notification.countDocuments({ user: a }), 2);
    // A real dedupe key still dedupes.
    await Notification.create({ user: a, title: 'Ring', message: 'x', dedupeKey: 'ring:o1' });
    await assert.rejects(
      () => Notification.create({ user: a, title: 'Ring again', message: 'x', dedupeKey: 'ring:o1' }),
      (err) => err.code === 11000
    );
    assert.equal(await Notification.countDocuments({ user: a }), 3);
  });

  await finish();
  await stopReplSet();
})().catch(async (err) => {
  console.error('E2E suite crashed:', err);
  try { await stopReplSet(); } catch (_) {}
  process.exit(1);
});
