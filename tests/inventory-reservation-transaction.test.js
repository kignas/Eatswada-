'use strict';

// Dependency-free behavior tests for atomic stock reservation/release.
// Run: node tests/inventory-reservation-transaction.test.js
const assert = require('assert');
const Module = require('module');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const session = { id: 'inventory-session' };
let state;
let transactionFailure;
let failMovementReason;
let inTransaction;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function reset() {
  state = {
    orders: [{
      _id: 'order-1', restaurant: 'restaurant-1', inventoryReservedAt: null, inventoryReleasedAt: null,
      items: [{ menuItem: 'tracked-1', quantity: 2 }, { menuItem: 'untracked-1', quantity: 3 }],
    }],
    menus: [
      { _id: 'tracked-1', restaurantId: 'restaurant-1', name: 'Tracked item', trackStock: true, stockQuantity: 5, inStock: true, manualAvailability: true, isActive: true },
      { _id: 'untracked-1', restaurantId: 'restaurant-1', name: 'Untracked item', trackStock: false, stockQuantity: 9, inStock: true, manualAvailability: true, isActive: true },
    ],
    movements: [],
  };
  transactionFailure = null;
  failMovementReason = null;
  inTransaction = false;
}
function checkSession(s, operation) {
  assert.strictEqual(s, session, `${operation} must be inside the transaction`);
}
function query(operation, execute, initialSession = null) {
  let selectedSession = initialSession;
  return {
    select() { return this; }, sort() { return this; }, limit() { return this; },
    session(s) { selectedSession = s; return this; },
    lean() { return this; },
    then(resolve, reject) {
      Promise.resolve().then(() => {
        if (inTransaction) checkSession(selectedSession, operation);
        return execute(selectedSession);
      }).then(resolve, reject);
    },
  };
}
function orderMatches(order, filter) {
  if (!order || String(order._id) !== String(filter._id)) return false;
  if (filter.inventoryReservedAt && filter.inventoryReservedAt.$ne === null && order.inventoryReservedAt == null) return false;
  if (filter.inventoryReleasedAt === null && order.inventoryReleasedAt != null) return false;
  const ors = filter.$or;
  if (ors && !ors.some(c => {
    if (Object.prototype.hasOwnProperty.call(c, 'inventoryReservedAt')) return order.inventoryReservedAt == null;
    if (c.inventoryReleasedAt && c.inventoryReleasedAt.$ne === null) return order.inventoryReleasedAt != null;
    return false;
  })) return false;
  return true;
}
const Order = {
  findById(id) { return query('Order.findById', () => state.orders.find(o => String(o._id) === String(id)) || null); },
  findOneAndUpdate(filter, update, options = {}) {
    if (options.session) checkSession(options.session, 'Order.findOneAndUpdate options');
    return query('Order.findOneAndUpdate', () => {
      const row = state.orders.find(o => orderMatches(o, filter));
      if (!row) return null;
      for (const [key, value] of Object.entries(update.$set || {})) row[key] = value;
      return row;
    }, options.session || null);
  },
};
const Menu = {
  findOne(filter) { return query('Menu.findOne', () => state.menus.find(m => String(m._id) === String(filter._id) && String(m.restaurantId) === String(filter.restaurantId) && (filter.isActive?.$ne !== false || m.isActive !== false)) || null); },
  findOneAndUpdate(filter, pipeline, options = {}) {
    if (options.session) checkSession(options.session, 'Menu.findOneAndUpdate options');
    return query('Menu.findOneAndUpdate', () => {
      const item = state.menus.find(m => String(m._id) === String(filter._id) && String(m.restaurantId) === String(filter.restaurantId));
      if (!item) return null;
      if (filter.trackStock === true && item.trackStock !== true) return null;
      if (filter.inStock === true && item.inStock !== true) return null;
      if (filter.stockQuantity?.$gte != null && item.stockQuantity < filter.stockQuantity.$gte) return null;
      const stockExpr = pipeline[0].$set.stockQuantity;
      if (stockExpr.$subtract) item.stockQuantity -= Number(stockExpr.$subtract[1]);
      else if (stockExpr.$add) item.stockQuantity += Number(stockExpr.$add[1]);
      item.inStock = item.manualAvailability !== false && (!item.trackStock || item.stockQuantity > 0);
      return item;
    }, options.session || null);
  },
};
const InventoryMovement = {
  find(filter) {
    return query('InventoryMovement.find', () => state.movements.filter(m =>
      String(m.orderId) === String(filter.orderId) && filter.reason.$in.includes(m.reason)));
  },
  async create(documents, options = {}) {
    checkSession(options.session, 'InventoryMovement.create');
    const rows = Array.isArray(documents) ? documents : [documents];
    for (const row of rows) {
      if (failMovementReason && row.reason === failMovementReason) throw new Error('injected movement insert failure');
      state.movements.push({ ...row });
    }
    return Array.isArray(documents) ? rows : rows[0];
  },
};
const tx = {
  async withRequiredTransaction(work) {
    if (transactionFailure) throw transactionFailure;
    const before = clone(state);
    inTransaction = true;
    try { return await work(session); }
    catch (err) { state = before; throw err; }
    finally { inTransaction = false; }
  },
};
const mocks = new Map([
  [path.join(ROOT, 'models/Menu.js'), Menu],
  [path.join(ROOT, 'models/Order.js'), Order],
  [path.join(ROOT, 'models/InventoryMovement.js'), InventoryMovement],
  [path.join(ROOT, 'services/dbTransaction.js'), tx],
]);
const oldLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename) {
    let resolved;
    try { resolved = Module._resolveFilename(request, parent, isMain); } catch (_) { resolved = null; }
    if (resolved && mocks.has(resolved)) return mocks.get(resolved);
  }
  return oldLoad.call(this, request, parent, isMain);
};
const { reserveOrderInventory, releaseOrderInventory } = require(path.join(ROOT, 'services/inventoryReservationService.js'));
Module._load = oldLoad;

(async () => {
  let passed = 0;
  async function test(name, fn) { reset(); await fn(); passed++; console.log(`PASS ${name}`); }
  await test('reserves only tracked items and commits marker, stock and movement together', async () => {
    const result = await reserveOrderInventory({ _id: 'order-1' }, 'actor-1');
    assert.strictEqual(result.reserved, true);
    assert.strictEqual(state.menus.find(m => m._id === 'tracked-1').stockQuantity, 3);
    assert.strictEqual(state.menus.find(m => m._id === 'untracked-1').stockQuantity, 9, 'untracked stock must not be decremented');
    assert.ok(state.orders[0].inventoryReservedAt);
    assert.strictEqual(state.orders[0].inventoryReleasedAt, null);
    assert.strictEqual(state.movements.length, 1);
    assert.strictEqual(state.movements[0].change, -2);
  });
  await test('release restores only the net reserved movement and cannot inflate untracked stock', async () => {
    await reserveOrderInventory({ _id: 'order-1' }, 'actor-1');
    const result = await releaseOrderInventory({ _id: 'order-1' }, 'actor-1');
    assert.strictEqual(result.released, true);
    assert.strictEqual(state.menus.find(m => m._id === 'tracked-1').stockQuantity, 5);
    assert.strictEqual(state.menus.find(m => m._id === 'untracked-1').stockQuantity, 9);
    assert.ok(state.orders[0].inventoryReleasedAt);
    assert.strictEqual(state.movements.length, 2);
    assert.strictEqual(state.movements[1].change, 2);
  });
  await test('duplicate release does not restore stock twice', async () => {
    await reserveOrderInventory({ _id: 'order-1' });
    await releaseOrderInventory({ _id: 'order-1' });
    const second = await releaseOrderInventory({ _id: 'order-1' });
    assert.strictEqual(second.released, false);
    assert.strictEqual(state.menus.find(m => m._id === 'tracked-1').stockQuantity, 5);
    assert.strictEqual(state.movements.length, 2);
  });
  await test('movement write failure rolls stock and marker back atomically', async () => {
    await reserveOrderInventory({ _id: 'order-1' });
    failMovementReason = 'cancelled_order_stock_restored';
    await assert.rejects(releaseOrderInventory({ _id: 'order-1' }), /injected movement insert failure/);
    assert.strictEqual(state.orders[0].inventoryReleasedAt, null);
    assert.strictEqual(state.menus.find(m => m._id === 'tracked-1').stockQuantity, 3);
    assert.strictEqual(state.movements.length, 1, 'failed transaction cannot persist release movement');
  });
  await test('transaction unavailable fails closed before reserving stock', async () => {
    transactionFailure = Object.assign(new Error('transaction support required'), { code: 'TRANSACTION_REQUIRED', statusCode: 503 });
    await assert.rejects(reserveOrderInventory({ _id: 'order-1' }), e => e.code === 'TRANSACTION_REQUIRED');
    assert.strictEqual(state.menus.find(m => m._id === 'tracked-1').stockQuantity, 5);
    assert.strictEqual(state.orders[0].inventoryReservedAt, null);
    assert.strictEqual(state.movements.length, 0);
  });
  console.log(`\n${passed} inventory transaction tests passed.`);
})().catch(err => { console.error(err); process.exitCode = 1; });
