'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('controllers/vendorApplicationController.js');
const vendorRoutes = read('routes/vendorRoutes.js');
const adminRoutes = read('routes/adminRoutes.js');
const applicationRoutes = read('routes/vendorApplicationRoutes.js');
const menuRoutes = read('routes/menuRoutes.js');
const restaurantRoutes = read('routes/restaurantRoutes.js');
const reviewModel = read('models/Review.js');
const customerRestaurant = read('controllers/restaurantController.js');

// Application request contract: every runtime identifier used for onboarding is destructured.
for (const field of ['businessType','deliveryMode','vendorAgreementVersion','vendorAgreementAcceptedAt','privacyPolicyVersion','privacyPolicyAcceptedAt']) {
  assert(app.includes(field), `application field missing: ${field}`);
}
const configBlock = app.slice(app.indexOf('exports.getVendorApplicationConfig'), app.indexOf('exports.submitVendorApplication'));
assert(!configBlock.includes('commissionRate'), 'public application config must not expose commission');
assert(!app.includes('minOrder: current.minOrder'), 'application approval must not copy applicant minimum order');
assert(!app.includes('deliveryFee: current.deliveryFee'), 'application approval must not copy applicant delivery fee');
assert(!app.includes('freeDeliveryAbove: current.freeDeliveryAbove'), 'application approval must not copy applicant free-delivery threshold');
assert(app.includes("status: 'needs_changes'"), 'admin request-changes state must be implemented');
assert(read('models/VendorApplication.js').includes("'needs_changes'"), 'application schema must support needs_changes');
assert(applicationRoutes.includes("'/:id/request-changes'"));
assert(adminRoutes.includes("'/vendor-applications/:id/request-changes'"));

// Vendor ecosystem routes.
for (const route of ["router.post('/menu'", "router.put('/menu/:id'", "router.delete('/menu/:id'", "router.put('/menu/:id/inventory'", "router.post('/menu/upload-image'", "router.get('/analytics'", "router.post('/reviews/:id/reply'", "router.put('/restaurant/profile'"]) {
  assert(vendorRoutes.includes(route), `missing vendor route: ${route}`);
}
assert(menuRoutes.includes("router.get('/pending'"));
assert(menuRoutes.includes("router.patch('/:itemId/review/:action'"));
assert(restaurantRoutes.includes("authorize('admin', 'vendor')"));
assert(reviewModel.includes('vendorReply'));
assert(customerRestaurant.includes('vendorReply: r.vendorReply'));
console.log('Vendor ecosystem contract: PASS');
