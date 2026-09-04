'use strict';

/*
 * Phase 3.5A — multi-restaurant checkout integration tests.
 *
 * These exercise the REAL controllers against an in-memory MongoDB, without
 * touching HTTP routes or auth middleware: each handler is invoked with a
 * lightweight { req, res, next } mock. That keeps the suite portable across
 * whatever router/auth wiring the app uses.
 *
 * Requirements (already dev-deps in most setups; install if missing):
 *   npm i -D mongodb-memory-server
 * Run with the project's test runner, e.g.:
 *   node --test tests/multiRestaurantCheckout.integration.test.js
 *
 * If your Menu/Restaurant/Address/User schemas require extra fields, extend
 * the seed helpers below — the assertions themselves should not need changes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../models/Order');
const Cart = require('../models/Cart');
const orderController = require('../controllers/orderController');
const cartController = require('../controllers/cartController');

// Models the controllers depend on (paths per the repo layout).
const Restaurant = require('../models/Restaurant');
const Menu = require('../models/Menu');
const User = require('../models/User');
const Address = require('../models/Address');

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  const { collections } = mongoose.connection;
  for (const key of Object.keys(collections)) await collections[key].deleteMany({});
});

// ── Mocks ───────────────────────────────────────────────────────────────
function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

// Invoke an express-async-handler-wrapped controller and capture the result
// or the error it forwards to next().
async function invoke(handler, req) {
  const res = mockRes();
  let error = null;
  await new Promise((resolve) => {
    const next = (err) => { error = err || null; resolve(); };
    const maybe = handler(req, res, next);
    if (maybe && typeof maybe.then === 'function') maybe.then(() => resolve(), () => resolve());
    else resolve();
  });
  return { res, error, status: error ? (error.statusCode || 500) : res.statusCode, body: res.body };
}

// ── Seed helpers (Maynaguri-area coordinates so distance < radius) ────────
async function seedUser() {
  return User.create({ name: 'Test Customer', phone: '9000000001', role: 'customer' });
}

async function seedAddress(userId) {
  // Customer near restaurants → short distance, base ₹30 tier.
  return Address.create({
    user: userId, tag: 'Home', house: '12', area: 'Maynaguri', city: 'Maynaguri', pincode: '735224',
    location: { type: 'Point', coordinates: [88.8200, 26.5600] },
  });
}

async function seedRestaurant(overrides = {}) {
  return Restaurant.create({
    name: 'Rest', isActive: true, codEnabled: true,
    minOrder: 0, freeDeliveryEnabled: true, freeDeliveryAbove: 0,
    availability: { isOpen: true },
    location: { type: 'Point', coordinates: [88.8210, 26.5610] },
    ...overrides,
  });
}

async function seedMenu(restaurant, overrides = {}) {
  return Menu.create({
    name: 'Dish', price: 100, inStock: true,
    restaurantId: restaurant._id,
    ...overrides,
  });
}

const reqFor = (user, body) => ({ user, body });

// ── Regression: add-to-cart resolves Menu.restaurantId (production schema) ──
test('add-to-cart uses Menu.restaurantId and stores authoritative cart ownership', async () => {
  const user = await seedUser();
  const rest = await seedRestaurant({ name: 'Schema-Test-Restaurant' });
  const dish = await seedMenu(rest, { name: 'Schema-Test-Dish', price: 75 });

  const { status, body } = await invoke(cartController.addToCart, reqFor(user, {
    menuItemId: String(dish._id), quantity: 1,
  }));

  assert.equal(status, 200);
  assert.equal(body?.success, true);
  const cart = await Cart.findOne({ user: user._id }).lean();
  assert.ok(cart, 'cart was not created');
  assert.equal(String(cart.items[0].restaurant), String(rest._id));
  assert.equal(String(cart.items[0].menuItem), String(dish._id));
});

// ── #1 / #27  Single-restaurant checkout still works ─────────────────────
test('single-restaurant checkout returns the legacy shape and one order', async () => {
  const user = await seedUser();
  const address = await seedAddress(user._id);
  const rest = await seedRestaurant({ minOrder: 150 });
  const dish = await seedMenu(rest, { price: 180 });

  const { status, body } = await invoke(orderController.createOrder, reqFor(user, {
    items: [{ menuItem: String(dish._id), quantity: 1 }],
    addressId: String(address._id),
    paymentMethod: 'cod',
    restaurantNote: 'no onions',
    tipAmount: 20,
  }));

  assert.equal(status, 201);
  assert.ok(body.data, 'legacy single-restaurant response has data');
  assert.ok(body.deliveryOtp, 'plaintext OTP returned to customer once');
  assert.equal(body.data.subtotal, 180);
  assert.equal(body.data.tipAmount, 20);
  assert.equal(body.data.restaurantNote, 'no onions');
  const all = await Order.find({});
  assert.equal(all.length, 1);
});

// ── #2 / #3  Multi-restaurant checkout creates one order per restaurant ──
test('multi-restaurant checkout creates one order per restaurant sharing a checkoutGroupId', async () => {
  const user = await seedUser();
  const address = await seedAddress(user._id);
  const a = await seedRestaurant({ name: 'A' });
  const b = await seedRestaurant({ name: 'B' });
  const da = await seedMenu(a, { price: 120 });
  const db = await seedMenu(b, { price: 200 });

  const { status, body } = await invoke(orderController.createOrder, reqFor(user, {
    items: [
      { menuItem: String(da._id), quantity: 1 },
      { menuItem: String(db._id), quantity: 1 },
    ],
    addressId: String(address._id),
    paymentMethod: 'cod',
    tipAmount: 20,
  }));

  assert.equal(status, 201);
  assert.equal(body.orders.length, 2);
  assert.ok(body.checkoutGroupId);
  const orders = await Order.find({ checkoutGroupId: body.checkoutGroupId });
  assert.equal(orders.length, 2);
  // Each order is single-restaurant.
  for (const o of orders) assert.ok(o.restaurant);
});

// ── #7  Client cannot fake menu price ────────────────────────────────────
test('client-supplied price is ignored — server uses the live menu price', async () => {
  const user = await seedUser();
  const address = await seedAddress(user._id);
  const rest = await seedRestaurant();
  const dish = await seedMenu(rest, { price: 100 });

  const { status, body } = await invoke(orderController.createOrder, reqFor(user, {
    items: [{ menuItem: String(dish._id), quantity: 1, price: 1 }], // lie
    addressId: String(address._id),
  }));
  assert.equal(status, 201);
  assert.equal(body.data.subtotal, 100); // not 1
});

// ── #8 / #9  Client cannot fake restaurantId / cross-restaurant item ─────
test('client-supplied restaurantId is ignored; items group by real owner', async () => {
  const user = await seedUser();
  const address = await seedAddress(user._id);
  const a = await seedRestaurant({ name: 'A' });
  const b = await seedRestaurant({ name: 'B' });
  const da = await seedMenu(a, { price: 120 });

  const { status, body } = await invoke(orderController.createOrder, reqFor(user, {
    items: [{ menuItem: String(da._id), quantity: 1 }],
    restaurantId: String(b._id), // lie: claim it belongs to B
    addressId: String(address._id),
  }));
  assert.equal(status, 201);
  // Single group resolved to the REAL owner A.
  assert.equal(String(body.data.restaurant), String(a._id));
});

// ── #13 / #14  Tip bounds ────────────────────────────────────────────────
test('tip cannot be negative or exceed the maximum', async () => {
  const user = await seedUser();
  const address = await seedAddress(user._id);
  const rest = await seedRestaurant();
  const dish = await seedMenu(rest);

  const neg = await invoke(orderController.createOrder, reqFor(user, {
    items: [{ menuItem: String(dish._id), quantity: 1 }], addressId: String(address._id), tipAmount: -5,
  }));
  assert.equal(neg.status, 400);

  const tooBig = await invoke(orderController.createOrder, reqFor(user, {
    items: [{ menuItem: String(dish._id), quantity: 1 }], addressId: String(address._id), tipAmount: 999999,
  }));
  assert.equal(tooBig.status, 400);
});

// ── #15 / #16  Tip not duplicated; allocation sums exactly ───────────────
test('tip is split across restaurant orders and sums exactly to the requested tip', async () => {
  const user = await seedUser();
  const address = await seedAddress(user._id);
  const a = await seedRestaurant({ name: 'A' });
  const b = await seedRestaurant({ name: 'B' });
  const da = await seedMenu(a, { price: 120 });
  const db = await seedMenu(b, { price: 200 });

  const { body } = await invoke(orderController.createOrder, reqFor(user, {
    items: [{ menuItem: String(da._id), quantity: 1 }, { menuItem: String(db._id), quantity: 1 }],
    addressId: String(address._id),
    tipAmount: 20,
  }));

  const orders = await Order.find({ checkoutGroupId: body.checkoutGroupId });
  const tipSum = Math.round(orders.reduce((s, o) => s + o.tipAmount, 0) * 100) / 100;
  assert.equal(tipSum, 20);
  assert.ok(orders.every(o => o.tipAmount < 20)); // not duplicated whole onto both
});

// ── #17  Restaurant note persists ────────────────────────────────────────
test('restaurant note persists on the order', async () => {
  const user = await seedUser();
  const address = await seedAddress(user._id);
  const rest = await seedRestaurant();
  const dish = await seedMenu(rest);

  const { body } = await invoke(orderController.createOrder, reqFor(user, {
    items: [{ menuItem: String(dish._id), quantity: 1 }],
    addressId: String(address._id),
    restaurantNote: '   extra spicy   ',
  }));
  const order = await Order.findById(body.data._id);
  assert.equal(order.restaurantNote, 'extra spicy');
});

// ── #24  COD must be enabled for EVERY restaurant ────────────────────────
test('multi-restaurant checkout fails if any restaurant has COD disabled', async () => {
  const user = await seedUser();
  const address = await seedAddress(user._id);
  const a = await seedRestaurant({ name: 'A', codEnabled: true });
  const b = await seedRestaurant({ name: 'B', codEnabled: false });
  const da = await seedMenu(a);
  const db = await seedMenu(b);

  const { status } = await invoke(orderController.createOrder, reqFor(user, {
    items: [{ menuItem: String(da._id), quantity: 1 }, { menuItem: String(db._id), quantity: 1 }],
    addressId: String(address._id),
    paymentMethod: 'cod',
  }));
  assert.equal(status, 403);
  assert.equal(await Order.countDocuments({}), 0); // nothing created
});

// ── #4 / #5  Independent minimum orders per restaurant ───────────────────
test('each restaurant minimum order is validated independently', async () => {
  const user = await seedUser();
  const address = await seedAddress(user._id);
  const a = await seedRestaurant({ name: 'A', minOrder: 150 });
  const b = await seedRestaurant({ name: 'B', minOrder: 100 });
  const da = await seedMenu(a, { price: 120 }); // below A's 150
  const db = await seedMenu(b, { price: 200 }); // above B's 100

  const { status } = await invoke(orderController.createOrder, reqFor(user, {
    items: [{ menuItem: String(da._id), quantity: 1 }, { menuItem: String(db._id), quantity: 1 }],
    addressId: String(address._id),
  }));
  assert.equal(status, 400); // A fails its minimum
  assert.equal(await Order.countDocuments({}), 0); // rollback: no partial checkout
});

// ── #25 / #26  Cart clears only after full success; failure keeps cart ───
test('cart is preserved when checkout fails and cleared only on full success', async () => {
  const user = await seedUser();
  const address = await seedAddress(user._id);
  const a = await seedRestaurant({ name: 'A', minOrder: 999 }); // will fail min order
  const da = await seedMenu(a, { price: 120 });
  await Cart.create({ user: user._id, items: [{
    menuItem: da._id, restaurant: a._id, restaurantName: 'A', name: 'Dish', price: 120, quantity: 1,
  }] });

  const fail = await invoke(orderController.createOrder, reqFor(user, {
    items: [{ menuItem: String(da._id), quantity: 1 }], addressId: String(address._id),
  }));
  assert.equal(fail.status, 400);
  const cartAfterFail = await Cart.findOne({ user: user._id });
  assert.equal(cartAfterFail.items.length, 1, 'cart preserved on failure');

  // Now make it succeed.
  a.minOrder = 0; await a.save();
  const ok = await invoke(orderController.createOrder, reqFor(user, {
    items: [{ menuItem: String(da._id), quantity: 1 }], addressId: String(address._id),
  }));
  assert.equal(ok.status, 201);
  const cartAfterOk = await Cart.findOne({ user: user._id });
  assert.equal(cartAfterOk.items.length, 0, 'cart cleared on success');
});

// ── Multi-restaurant cart grouping (cart controller) ─────────────────────
test('cart groups items from two restaurants (A then B)', async () => {
  const user = await seedUser();
  const a = await seedRestaurant({ name: 'A' });
  const b = await seedRestaurant({ name: 'B' });
  const da = await seedMenu(a, { price: 120 });
  const db = await seedMenu(b, { price: 200 });

  await invoke(cartController.addToCart, reqFor(user, { menuItemId: String(da._id), quantity: 1 }));
  const { body } = await invoke(cartController.addToCart, reqFor(user, { menuItemId: String(db._id), quantity: 1 }));

  assert.equal(body.data.groups.length, 2);
  assert.equal(body.data.foodSubtotal, 320);
});
