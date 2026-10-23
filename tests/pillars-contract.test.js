'use strict';

// Contract + pure-logic tests for the COD trust, visit analytics, support-ops
// and review-moderation work. No database is required: the money/policy
// functions are pure, and the endpoint checks assert against the route and
// controller source the same way the other *-contract tests do.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (err) { failed++; console.log(`FAIL ${name} — ${err.message}`); }
}

/* ── 1. COD terms resolver (pure) ─────────────────────────────────── */
const { resolveCodTerms, shouldAutoBlockCod } = require('../services/codPolicyService');
const { buildPaymentView } = require('../services/orderPaymentView');

check('COD advance is 10% above ₹1,000 and the rest is cash', () => {
  const terms = resolveCodTerms({ subtotalRupees: 1000.05, discountRupees: 0, grandTotalRupees: 1030.05, settings: {} });
  assert.equal(terms.required, true);
  assert.equal(terms.advancePercent, 10);
  assert.equal(terms.advancePaise, 10001);            // 10% of ₹1000.05, half-up
  assert.equal(terms.cashDuePaise, 103005 - 10001);
});

check('COD advance is not required at or below the ₹1,000 threshold', () => {
  const terms = resolveCodTerms({ subtotalRupees: 1000, discountRupees: 0, grandTotalRupees: 1030, settings: {} });
  assert.equal(terms.required, false);
  assert.equal(terms.advancePaise, 0);
  assert.equal(terms.cashDuePaise, 103000);
});

check('Discount reduces the subtotal that drives the advance', () => {
  const terms = resolveCodTerms({ subtotalRupees: 1200, discountRupees: 100, grandTotalRupees: 1030, settings: {} });
  // 1100 discounted food × 10% = 110.00
  assert.equal(terms.advancePaise, 11000);
});

check('A per-customer policy overrides the platform default', () => {
  const customer = { codPolicy: { advanceRequiredAbove: 0, advancePercent: 50 } };
  const terms = resolveCodTerms({ subtotalRupees: 500, discountRupees: 0, grandTotalRupees: 520, settings: { codAdvanceThreshold: 1000, codAdvancePercent: 10 }, customer });
  assert.equal(terms.source, 'customer');
  assert.equal(terms.required, true);
  assert.equal(terms.advancePercent, 50);
  assert.equal(terms.advancePaise, 25000);            // 50% of ₹500
  assert.equal(terms.cashDuePaise, 52000 - 25000);
});

check('Advance never exceeds the amount the customer actually owes', () => {
  const customer = { codPolicy: { advanceRequiredAbove: 0, advancePercent: 100 } };
  const terms = resolveCodTerms({ subtotalRupees: 500, discountRupees: 0, grandTotalRupees: 520, settings: {}, customer });
  // 100% of the ₹500 food subtotal is due online; the ₹20 of fees stays cash.
  assert.equal(terms.advancePaise, 50000);
  assert.equal(terms.cashDuePaise, 2000);
});

check('Auto-block only fires when enabled and the limit is reached', () => {
  assert.equal(shouldAutoBlockCod({ refusedDeliveries: 5, failedDeliveries: 5 }, { codAutoBlockEnabled: false }), false);
  assert.equal(shouldAutoBlockCod({ refusedDeliveries: 2, failedDeliveries: 0 }, { codAutoBlockEnabled: true, codMaxRefusalsBeforeAutoBlock: 3 }), false);
  assert.equal(shouldAutoBlockCod({ refusedDeliveries: 2, failedDeliveries: 1 }, { codAutoBlockEnabled: true, codMaxRefusalsBeforeAutoBlock: 3 }), true);
});

/* ── 2. Payment view shown to rider / restaurant apps ──────────────── */
check('Rider sees ₹100 paid online and ₹900 cash on a ₹1,000 partial-COD order', () => {
  const view = buildPaymentView({
    paymentMethod: 'cod', paymentStatus: 'cod_pending', total: 1000,
    partialCodAdvanceAmount: 100, partialCodAdvanceStatus: 'paid', partialCodCashDue: 900,
  });
  assert.equal(view.isPartialCod, true);
  assert.equal(view.advancePaid, 100);
  assert.equal(view.cashToCollect, 900);
  assert.equal(view.blocksDelivery, false);
});

check('Delivery is blocked until a required advance is confirmed', () => {
  const view = buildPaymentView({
    paymentMethod: 'cod', total: 1000,
    partialCodAdvanceAmount: 100, partialCodAdvanceStatus: 'pending', partialCodCashDue: 900,
  });
  assert.equal(view.blocksDelivery, true);
  assert.equal(view.advancePaid, 0);
  assert.equal(view.cashToCollect, 900);
});

check('A plain COD order collects the full total in cash', () => {
  const view = buildPaymentView({ paymentMethod: 'cod', total: 450 });
  assert.equal(view.isPartialCod, false);
  assert.equal(view.cashToCollect, 450);
  assert.equal(view.label, 'Cash on Delivery — Free');
});

check('A UPI order never reports cash to collect', () => {
  const view = buildPaymentView({ paymentMethod: 'upi', paymentStatus: 'paid', total: 450 });
  assert.equal(view.isCod, false);
  assert.equal(view.cashToCollect, 0);
  assert.equal(view.blocksDelivery, false);
});

/* ── 3. Endpoint contracts ─────────────────────────────────────────── */
const adminRoutes = read('routes/adminRoutes.js');
const adminController = read('controllers/adminController.js');
const adminMarketplace = read('controllers/adminMarketplaceController.js');
const analyticsRoutes = read('routes/analyticsRoutes.js');
const vendorRoutes = read('routes/vendorRoutes.js');
const orderRoutes = read('routes/orderRoutes.js');
const orderController = read('controllers/orderController.js');
const platformController = read('controllers/platformController.js');
const userModel = read('models/User.js');
const reviewModel = read('models/Review.js');
const supportModel = read('models/SupportTicket.js');
const riderEarning = read('services/riderEarningService.js');
const riderAssignment = read('services/riderAssignmentService.js');

check('Admin can review COD abuse, set per-customer terms and freeze accounts', () => {
  assert.match(adminRoutes, /router\.get\('\/customers\/trust'/);
  assert.match(adminRoutes, /router\.patch\('\/customers\/:userId\/cod-policy'/);
  assert.match(adminRoutes, /router\.patch\('\/customers\/:userId\/freeze'/);
  assert.match(adminController, /exports\.updateCustomerCodPolicy/);
  assert.match(adminController, /exports\.setCustomerAccountFreeze/);
});

check('Frozen accounts cannot place orders and COD is blocked server-side', () => {
  assert.match(userModel, /accountStatus/);
  assert.match(orderController, /customer\?\.accountStatus === 'frozen'/);
  assert.match(orderController, /customer\?\.isCodBlocked === true/);
  assert.match(orderController, /resolveCodTerms\(\{/);
});

check('Public status exposes COD terms and the account-frozen flag', () => {
  assert.match(platformController, /codDisplayLabel/);
  assert.match(platformController, /isAccountFrozen/);
  assert.match(platformController, /codPolicy\?\.advancePercent/);
});

check('Visit analytics are recorded and visible to admin and vendor', () => {
  assert.match(analyticsRoutes, /router\.post\('\/visit'/);
  assert.match(analyticsRoutes, /router\.get\('\/admin\/platform'/);
  assert.match(analyticsRoutes, /router\.get\('\/vendor\/menu'/);
  assert.match(adminRoutes, /router\.get\('\/analytics\/visits'/);
  assert.match(vendorRoutes, /router\.get\('\/analytics\/visits'/);
  assert.match(read('server.js'), /\['\/analytics',\s*analyticsRoutes\]/);
});

check('Rider distance pay is capped by riderMaxDistanceKm', () => {
  assert.match(riderEarning, /riderMaxDistanceKm/);
  assert.match(riderEarning, /payableKm = Math\.min\(distanceKm, maxDistanceKm\)/);
});

check('Rider concurrency cap is configurable and defaults to batching', () => {
  assert.match(riderAssignment, /resolveMaxActiveOrdersPerRider/);
  assert.match(riderAssignment, /maxActiveOrdersPerOnlineRider/);
  assert.match(read('services/platformSettingsService.js'), /maxActiveOrdersPerOnlineRider:\s*3/);
});

check('Support has agent assignment, SLA clocks and a metrics scoreboard', () => {
  assert.match(supportModel, /assignedTo/);
  assert.match(supportModel, /firstResponseDueAt/);
  assert.match(adminRoutes, /support\/tickets\/:id\/assign/);
  assert.match(adminRoutes, /router\.get\('\/support\/metrics'/);
  assert.match(adminMarketplace, /exports\.getSupportMetrics/);
  assert.match(read('utils/supportHelpers.js'), /slaDueDates/);
});

check('Reviews carry item photos, reporting and admin moderation analytics', () => {
  assert.match(reviewModel, /photos:\s*\{\s*type:\s*\[\{\s*type:\s*String/);
  assert.match(reviewModel, /reportedCount/);
  assert.match(orderRoutes, /router\.post\('\/reviews\/:reviewId\/report'/);
  assert.match(orderController, /const reportReview = asyncHandler/);
  assert.match(adminRoutes, /router\.get\('\/reviews\/analytics'/);
  assert.match(adminController, /exports\.getReviewAnalytics/);
});

check('Checkout bill includes admin-controlled GST, handling and packaging lines', () => {
  const checkoutMath = read('services/checkoutMath.js');
  assert.match(checkoutMath, /taxPercent/);
  assert.match(checkoutMath, /platformHandlingFee/);
  assert.match(checkoutMath, /packagingCharge/);
  assert.match(read('services/platformSettingsService.js'), /packagingChargePerItem/);
});

check('Account freeze is enforced at login and checkout', () => {
  assert.match(read('services/customerTrustService.js'), /setAccountFreeze/);
  assert.match(orderController, /ACCOUNT_FROZEN/);
});

check('Admin work can be divided into functional permission modules', () => {
  assert.match(adminController, /'support\.manage'/);
  assert.match(adminController, /'customers\.trust'/);
  assert.match(adminController, /'reviews\.moderate'/);
  assert.match(adminRoutes, /requirePermission\('support\.manage'\)/);
  assert.match(adminRoutes, /requirePermission\('customers\.trust'\)/);
  assert.match(adminRoutes, /requirePermission\('reviews\.moderate'\)/);
});

check('Admin sees saved locations read-only (req 2)', () => {
  assert.match(adminController, /exports\.getCustomerSavedLocations/);
  // The admin handler is a pure read — it must not mutate addresses.
  const handler = adminController.slice(adminController.indexOf('exports.getCustomerSavedLocations'));
  assert.ok(!/Address\.(findByIdAndUpdate|updateOne|findOneAndUpdate|deleteOne)/.test(handler.slice(0, 1200)));
});

console.log(`\nPillars contract: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
