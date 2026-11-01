'use strict';
// Fee-consistency contract for the pricing engine with PRODUCTION DEFAULT rules.
// Answers "why do my fees change with item price?" with executable facts:
//   * the DELIVERY fee depends on distance band only (never on basket size,
//     until the free-delivery threshold is reached);
//   * the SMALL-ORDER fee only tops up the shortfall, so it can only shrink as
//     the basket grows, and never exceeds smallOrderFeeMax;
//   * a basket under the minimum is blocked (not priced with a smaller fee);
//   * UPI pays at least as much small-order fee as COD (gateway cost).
// No DB, no network. Usage: npm run test:pricing-fee-consistency
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { buildRules } = require(path.join(ROOT, 'services/pricing/pricingRules'));
const { buildQuote } = require(path.join(ROOT, 'services/pricing/pricingOrchestrator'));

const rules = buildRules({ pricingEngineEnabled: true });
const REST = { _id: 'r', location: { coordinates: [88.8132, 26.558559] }, deliveryRadiusKm: 10, minOrder: 1, commissionable: false };
const eastOf = (km) => [88.8132 + km / (111.32 * Math.cos(26.558559 * Math.PI / 180)), 26.558559];

const quote = (amount, paymentMethod = 'upi', km = 0, over = {}) => buildQuote({
  rules, restaurant: { ...REST, ...over }, items: [{ quantity: 1, unitPriceRupees: amount }],
  customerCoords: eastOf(km), paymentMethod, isFirstOrder: false, routeFn: async () => null,
});

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed += 1; console.log(`FAIL ${name}: ${String(e.message).split('\n')[0]}`); }
}

(async () => {
  await t('replay matches production: Rs200 basket -> Rs208 and Rs150 UPI -> Rs159.69', async () => {
    assert.strictEqual((await quote(200)).bill.grandTotal, 208);
    assert.strictEqual((await quote(150)).bill.grandTotal, 159.69);
    assert.strictEqual((await quote(150, 'cod')).bill.grandTotal, 158);
  });

  await t('delivery fee is the same for every basket size at one distance (until free delivery)', async () => {
    for (const km of [0, 2.5, 4.5]) {
      const fees = new Set();
      for (let amt = 150; amt <= 250; amt += 10) {
        const q = await quote(amt, 'upi', km);
        if (q.bill.deliverySubsidy === 0) fees.add(q.bill.deliveryFee);
      }
      assert.strictEqual(fees.size, 1, `delivery fee varied with basket at ${km} km: ${[...fees]}`);
    }
  });

  await t('small-order fee never grows with a bigger basket and never exceeds the admin cap', async () => {
    for (const pm of ['upi', 'cod']) {
      let prev = Infinity;
      for (let amt = 102; amt <= 400; amt += 2) {
        const q = await quote(amt, pm);
        if (q.serviceable === false) continue;
        assert.ok(q.bill.smallOrderFee <= prev + 1e-9, `${pm} fee grew at Rs${amt}`);
        assert.ok(q.bill.smallOrderFee <= rules.smallOrderFeeMax, `${pm} fee above cap at Rs${amt}`);
        prev = q.bill.smallOrderFee;
      }
    }
  });

  await t('bill adds up: total = food + delivery + small-order + COD fee (no hidden line)', async () => {
    for (const pm of ['upi', 'cod']) for (const amt of [150, 200, 320]) for (const km of [0, 3, 6]) {
      const q = await quote(amt, pm, km);
      if (q.serviceable === false) continue;
      const b = q.bill;
      const sum = Math.round((b.foodPayable + b.deliveryFee + b.smallOrderFee + b.codFee) * 100) / 100;
      assert.strictEqual(sum, b.grandTotal, `${pm} Rs${amt} ${km}km: ${sum} != ${b.grandTotal}`);
    }
  });

  await t('a basket below the minimum is BLOCKED with a "Minimum order" message, never priced', async () => {
    const q = await quote(100);
    assert.strictEqual(q.serviceable, false);
    assert.strictEqual(q.reason, 'below_minimum_order');
    assert.ok(/minimum order/i.test(q.message || ''), `unexpected message: ${q.message}`);
    assert.ok(q.minimumOrder && q.minimumOrder.met === false);
  });

  await t('the minimum order is at least the platform floor (99) and rises with distance (Rs102 at the shop, Rs129 at ~5 road km)', async () => {
    const near = await quote(100, 'upi', 0);
    const far = await quote(100, 'upi', 4);
    assert.ok(near.minimumOrder.amount >= rules.platformMinimumOrderRupees);
    assert.ok(far.minimumOrder.amount > near.minimumOrder.amount);
    assert.strictEqual(near.minimumOrder.amount, 102);
  });

  await t('UPI small-order fee >= COD small-order fee (UPI carries the gateway cost; COD target is lower)', async () => {
    for (const amt of [102, 120, 140, 150, 160]) {
      const u = await quote(amt, 'upi'); const c = await quote(amt, 'cod');
      assert.ok(u.bill.smallOrderFee >= c.bill.smallOrderFee, `Rs${amt}: UPI ${u.bill.smallOrderFee} < COD ${c.bill.smallOrderFee}`);
    }
  });

  await t('KNOWN QUIRK (documented): free delivery starts ~Rs20 EARLIER for COD than for UPI at 0 km', async () => {
    const firstFree = async (pm) => { for (let a = 100; a <= 700; a += 10) { const q = await quote(a, pm); if (q.bill.deliveryFee === 0) return a; } return null; };
    const upi = await firstFree('upi'); const cod = await firstFree('cod');
    assert.ok(upi !== null && cod !== null);
    assert.ok(cod <= upi, `expected COD threshold (${cod}) <= UPI threshold (${upi}); if this flips the engine changed - re-read the owner notes`);
  });

  await t('the small-order fee is exact to the paisa (this is why odd amounts like Rs1.69 appear)', async () => {
    const q = await quote(150, 'upi');
    assert.strictEqual(q.bill.smallOrderFee, 1.69);
  });

  await t('restaurant list never returns the static seed distance fields', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'controllers/restaurantController.js'), 'utf8');
    const proj = src.slice(src.indexOf('const CUSTOMER_LIST_PROJECTION'), src.indexOf('/**\n * Restaurant-level authorization'));
    assert.ok(!/\bdistanceMeters:\s*1\b/.test(proj), 'distanceMeters is projected');
    assert.ok(!/^\s*distance:\s*1\b/m.test(proj), 'distance is projected');
  });

  await t('GET /restaurants/:id returns the whole document (so codEnabled reaches the cart)', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'controllers/restaurantController.js'), 'utf8');
    const at = src.indexOf('const getRestaurantById');
    const body = src.slice(at, src.indexOf('const getMenu', at));
    assert.ok(/Restaurant\.findOne\(\{ _id: req\.params\.id, isActive: true, approvalStatus: 'approved' \}\)\s*;/.test(body), 'a .select() was added to getRestaurantById');
    assert.ok(/\.\.\.view/.test(body));
  });

  console.log(failed ? `\n${failed} FAILED` : '\nAll pricing-fee-consistency tests passed');
  process.exit(failed ? 1 : 0);
})();
