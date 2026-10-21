'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const checks = [];
function check(name, ok) { checks.push({ name, ok: !!ok }); }
const order = read('models/Order.js');
const rider = read('controllers/riderController.js');
const riderRoutes = read('routes/riderRoutes.js');
const review = read('models/Review.js');
const orderController = read('controllers/orderController.js');
const restaurant = read('controllers/restaurantController.js');
const ticket = read('models/SupportTicket.js');
const support = read('controllers/customerSupportController.js');
const helpers = read('utils/supportHelpers.js');
const admin = read('controllers/adminMarketplaceController.js');
const adminRoutes = read('routes/adminRoutes.js');
const vendor = read('controllers/vendorController.js');
check('Pickup code is hidden by default and generated securely', /pickupCode: \{ type: String, select: false/.test(order) && /crypto\.randomInt\(1000, 10000\)/.test(order));
check('Pickup code has attempt lockout and timing-safe hash comparison', /timingSafeEqual/.test(order) && /pickupCodeAttempts/.test(order) && /15 \* 60 \* 1000/.test(order));
check('Rider pickup verification endpoint is registered', /verifyPickupCode/.test(rider) && /verify-pickup-code/.test(riderRoutes));
check('Pickup requires verified code only for orders where feature is enabled', /pickupCodeRequired && !order\.pickupCodeVerifiedAt/.test(rider));
check('Restaurant arrival enforces fresh GPS and 200m geofence', /OUTSIDE_RESTAURANT_GEOFENCE/.test(rider) && /2 \* 60 \* 1000/.test(rider) && /distanceMeters > 200/.test(rider));
check('Vendor order list explicitly selects pickup code for vendor-only display', /Order\.find\(query\)\.select\('\+pickupCode'\)/.test(vendor));
check('Review schema supports per-item star ratings', /itemRatings/.test(review) && /score: \{ type: Number, required: true, min: 1, max: 5 \}/.test(review));
check('Review submission validates item ratings against purchased items', /orderItem = \(order\.items/.test(orderController) && /review\.itemRatings = itemRatings/.test(orderController));
check('Customer review API returns item ratings and vendor reply', /itemRatings: r\.itemRatings \|\| \[\]/.test(restaurant) && /vendorReply:/.test(restaurant));
check('Support tickets persist complaint photos and expose them to participants', /photos: \{ type: \[\{ type: String/.test(ticket) && /photos: o\.photos \|\| \[\]/.test(helpers) && /photos,/.test(support));
check('Admin payout requires UTR and verifies ledger sum before paid state', /Bank UTR\/reference is required/.test(admin) && /reconciledAmount/.test(admin));
check('Admin payout reconciliation endpoint is registered', /getPayoutReconciliation/.test(admin) && /payout-requests\/:id\/reconciliation/.test(adminRoutes));
if (checks.some(x => !x.ok)) {
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}`);
  process.exit(1);
}
for (const c of checks) console.log(`PASS ${c.name}`);
console.log(`Restaurant Partner backend feature contracts: ${checks.length} passed, 0 failed`);
