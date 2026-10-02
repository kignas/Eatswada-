'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const contains = (file, text) => read(file).includes(text);

assert(contains('models/VendorApplication.js', "businessType: { type: String, enum: ['restaurant', 'cloud_kitchen']"));
assert(contains('models/VendorApplication.js', "deliveryMode: { type: String, enum: ['self_delivery', 'eatswada_rider']"));
assert(contains('models/VendorApplication.js', "required: [true, 'FSSAI license / registration number is required']"));
assert(contains('models/Restaurant.js', 'maxActiveOrders'));
assert(contains('models/Restaurant.js', 'settlementSchedule'));
assert(contains('models/Menu.js', 'approvalStatus'));
assert(contains('models/Menu.js', 'stockQuantity'));
assert(contains('models/Order.js', 'deliveryModeSnapshot'));
assert(contains('models/Order.js', 'businessTypeSnapshot'));
assert(contains('services/commissionService.js', 'self_delivery: 15'));
assert(contains('services/commissionService.js', 'eatswada_rider: 25'));
assert(contains('controllers/vendorController.js', 'RESTAURANT_ORDER_CAPACITY_REACHED'));
assert(contains('controllers/vendorController.js', "deliveryMode === 'self_delivery' ? 'out_for_delivery' : 'waiting_for_rider'"));
assert(contains('controllers/vendorMarketplaceController.js', 'createVendorMenuItem'));
assert(contains('controllers/vendorMarketplaceController.js', 'verifySelfDeliveryOtp'));
assert(contains('controllers/vendorMarketplaceController.js', 'requestVendorWithdrawal'));
assert(contains('controllers/vendorMarketplaceController.js', 'createVendorSupportTicket'));
assert(contains('controllers/menuController.js', 'getPendingMenuItems'));
assert(contains('controllers/menuController.js', 'reviewMenuItem'));
assert(contains('routes/vendorApplicationRoutes.js', "router.get('/config'"));
assert(contains('routes/vendorRoutes.js', "router.post('/menu'"));
assert(contains('routes/vendorRoutes.js', "router.put('/menu/:id/inventory'"));
assert(contains('routes/vendorRoutes.js', "verify-delivery-otp"));
assert(contains('routes/adminRoutes.js', "delivery-settings"));
assert(contains('routes/adminRoutes.js', "payout-requests"));
assert(contains('routes/adminRoutes.js', "support/tickets"));
assert(contains('controllers/restaurantController.js', "approvalStatus: 'approved'"));

console.log('Vendor marketplace contract: PASS');
