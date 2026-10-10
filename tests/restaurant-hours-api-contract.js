'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const routes = read('routes/restaurantRoutes.js');
const vendorRoutes = read('routes/vendorRoutes.js');
const restaurant = read('controllers/restaurantController.js');
const vendor = read('controllers/vendorController.js');
const admin = read('controllers/adminController.js');
const cart = read('controllers/cartController.js');
const order = read('controllers/orderController.js');

// Configuration writes remain behind authentication and role checks.
assert.match(routes, /router\.patch\(['"]\/:id\/availability['"],\s*protect,\s*authorize\(['"]admin['"]\),\s*updateRestaurantAvailability\)/);
assert.match(vendorRoutes, /router\.put\(['"]\/restaurant\/hours['"],\s*protect,\s*role\(['"]vendor['"]\),\s*updateBusinessHours\)/);
assert.match(vendor, /Restaurant\.findOne\(\{ _id: req\.user\.restaurantId, owner: req\.user\._id \}\)/);
assert.match(restaurant, /canManageRestaurant\(req\.user, restaurant\)/);
assert.match(restaurant, /buildOpeningHoursUpdate\(body\.openingHours\)/);

// Public list/detail payloads expose computed schedule status without a timer
// or database write; order creation and cart-add enforce the same status.
assert.match(restaurant, /withOperationalAvailability\(restaurant, now, hoursContext\)/);
assert.match(restaurant, /withOperationalAvailability\(restaurant, now, getLocalContext\(now\)\)/);
assert.match(cart, /select\('name image isActive availability isOpen openingHours'\)/);
assert.match(cart, /!restaurantOperational\.open/);
assert.match(order, /select\('name image owner location availability isOpen openingHours /);
assert.match(order, /if \(!operational\.open\)/);

// Admin/vendor response payloads include schedule + calculated state for later UI wiring.
assert.match(admin, /openingHours: r\.openingHours, availability: r\.availability/);
assert.match(admin, /operational: operationalStatus\(r, now, hoursContext\)/);
assert.match(vendor, /plain\.operational = operationalStatus\(plain, now, getLocalContext\(now\)\)/);

console.log('Restaurant-hours API contract: PASS');
