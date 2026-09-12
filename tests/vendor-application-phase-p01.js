'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const required = [
  'models/VendorApplication.js',
  'controllers/vendorApplicationController.js',
  'routes/vendorApplicationRoutes.js',
];
for (const file of required) assert.ok(fs.existsSync(path.join(root, file)), `Missing ${file}`);

const Restaurant = require('../models/Restaurant');
const VendorApplication = require('../models/VendorApplication');
const controller = require('../controllers/vendorApplicationController');

assert.ok(['pending', 'approved', 'rejected', 'suspended'].includes(Restaurant.schema.path('approvalStatus').options.enum[0]));
assert.strictEqual(Restaurant.schema.path('approvalStatus').defaultValue, 'approved');
assert.strictEqual(VendorApplication.schema.path('status').defaultValue, 'pending');
assert.strictEqual(VendorApplication.schema.path('statusTokenHash').options.select, false);
assert.strictEqual(VendorApplication.schema.path('statusTokenExpiresAt').options.select, false);

for (const fn of [
  'submitVendorApplication', 'getVendorApplicationStatus',
  'getVendorApplications', 'getVendorApplicationById',
  'approveVendorApplication', 'rejectVendorApplication'
]) assert.strictEqual(typeof controller[fn], 'function', `${fn} export missing`);

const restaurantControllerSource = fs.readFileSync(path.join(root, 'controllers/restaurantController.js'), 'utf8');
assert.ok(restaurantControllerSource.includes("approvalStatus: 'approved'"), 'Customer restaurant discovery is not approval-gated');
assert.ok(restaurantControllerSource.includes("approvalStatus: 'approved'"), 'Public restaurant access is not approval-gated');

console.log('Vendor application P0.1 structural gate: PASS');
