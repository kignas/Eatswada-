'use strict';

// Dependency-free tests for the cancelled-order inventory recovery sweep.
// Run: node tests/inventory-release-recovery.test.js
const assert = require('assert');
const Module = require('module');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let rows;
let calls;

function reset() {
  rows = [
    { _id: 'cancelled-1', inventoryReservedAt: new Date(), inventoryReleasedAt: null },
    { _id: 'cancelled-2', inventoryReservedAt: new Date(), inventoryReleasedAt: null },
  ];
  calls = { filter: null, released: [], failed: [] };
}
const Order = {
  find(filter) {
    calls.filter = filter;
    let selected = rows;
    return {
      select() { return this; }, sort() { return this; }, limit(n) { selected = selected.slice(0, n); return this; },
      lean: async () => selected,
    };
  },
};
const inventory = {
  async releaseOrderInventory(order) {
    calls.released.push(String(order._id));
    if (String(order._id) === 'cancelled-2') throw new Error('temporary transaction failure');
    return { released: true };
  },
};
const stubs = new Map([
  [path.join(ROOT, 'models/Order.js'), Order],
  [path.join(ROOT, 'services/inventoryReservationService.js'), inventory],
  [path.join(ROOT, 'services/paymentService.js'), { async fetchOrderPayments() { return []; } }],
  [path.join(ROOT, 'services/notificationService.js'), { async notifyOrderStatus() {} }],
  [path.join(ROOT, 'controllers/paymentController.js'), { async markCheckoutPaid() {}, async markPartialCodAdvancePaid() {} }],
]);
const oldLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename) {
    let resolved;
    try { resolved = Module._resolveFilename(request, parent, isMain); } catch (_) { resolved = null; }
    if (resolved && stubs.has(resolved)) return stubs.get(resolved);
  }
  return oldLoad.call(this, request, parent, isMain);
};
const { recoverCancelledInventoryReleases } = require(path.join(ROOT, 'services/abandonedCheckoutService.js'));
Module._load = oldLoad;

(async () => {
  reset();
  const result = await recoverCancelledInventoryReleases();
  assert.deepStrictEqual(calls.filter, { status: 'cancelled', inventoryReservedAt: { $ne: null }, inventoryReleasedAt: null });
  assert.deepStrictEqual(calls.released, ['cancelled-1', 'cancelled-2']);
  assert.deepStrictEqual(result, { scanned: 2, released: 1 });
  console.log('PASS cancelled orders with pending inventory release are retried; failed rows remain retryable');
  console.log('1 inventory recovery test passed.');
})().catch(err => { console.error(err); process.exitCode = 1; });
