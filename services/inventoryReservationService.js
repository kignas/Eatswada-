'use strict';
const Menu = require('../models/Menu');
const Order = require('../models/Order');
const InventoryMovement = require('../models/InventoryMovement');
const { withRequiredTransaction } = require('./dbTransaction');

// A line's menuItem may be a raw ObjectId OR a populated Menu document.
function menuItemIdOf(line) {
  const ref = line && line.menuItem;
  if (!ref) return '';
  if (typeof ref === 'object' && ref._id) return String(ref._id);
  return String(ref);
}

function queryWithSession(query, session) {
  return query.session(session);
}

function combineQuantities(items) {
  const needs = new Map();
  for (const line of (items || [])) {
    const id = menuItemIdOf(line);
    if (!id) continue;
    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw Object.assign(new Error('Invalid inventory quantity.'), { statusCode: 400 });
    }
    needs.set(id, (needs.get(id) || 0) + quantity);
  }
  return needs;
}

// Reserve tracked stock atomically with the order's reservation marker and
// movement ledger. A process crash or transaction failure cannot leave a
// committed stock decrement without its matching movement/marker.
async function reserveOrderInventory(order, actorId = null) {
  if (!order?._id) throw Object.assign(new Error('Order is required for inventory reservation.'), { statusCode: 400 });

  return withRequiredTransaction(async (session) => {
    const orderQuery = Order.findById(order._id);
    queryWithSession(orderQuery, session);
    const current = await orderQuery.lean();
    if (!current) throw Object.assign(new Error('Order not found for inventory reservation.'), { statusCode: 404 });
    if (current.inventoryReservedAt && !current.inventoryReleasedAt) {
      return { reserved: false, reason: 'already_reserved' };
    }

    const needs = combineQuantities(current.items);
    const tracked = [];
    for (const [menuItemId, quantity] of needs) {
      const itemQuery = Menu.findOne({
        _id: menuItemId,
        restaurantId: current.restaurant,
        isActive: { $ne: false },
      }).select('_id name trackStock stockQuantity inStock manualAvailability');
      queryWithSession(itemQuery, session);
      const item = await itemQuery.lean();
      if (!item) throw Object.assign(new Error('A menu item is no longer available. Please refresh your cart.'), { statusCode: 409 });
      if (item.trackStock) tracked.push({ item, quantity });
    }

    // Untracked legacy menu items retain their unlimited-stock behavior and do
    // not need a reservation marker.
    if (!tracked.length) return { reserved: false, items: [] };

    // The claim and all stock/ledger mutations live in the same transaction.
    // Concurrent attempts on the same order cannot both win this conditional
    // transition; a successful re-reservation is allowed only after release.
    const claimQuery = Order.findOneAndUpdate(
      {
        _id: current._id,
        $or: [
          { inventoryReservedAt: null },
          { inventoryReleasedAt: { $ne: null } },
        ],
      },
      { $set: { inventoryReservedAt: new Date(), inventoryReleasedAt: null } },
      { new: true, session },
    );
    const claim = await claimQuery.lean();
    if (!claim) return { reserved: false, reason: 'already_reserved' };

    const reserved = [];
    for (const { item, quantity } of tracked) {
      const before = Number(item.stockQuantity || 0);
      const updateQuery = Menu.findOneAndUpdate(
        {
          _id: item._id,
          restaurantId: current.restaurant,
          trackStock: true,
          stockQuantity: { $gte: quantity },
          inStock: true,
          isActive: { $ne: false },
        },
        [{ $set: {
          stockQuantity: { $subtract: [{ $ifNull: ['$stockQuantity', 0] }, quantity] },
          inStock: { $and: [
            { $ne: [{ $ifNull: ['$manualAvailability', '$inStock'] }, false] },
            { $gt: [{ $subtract: [{ $ifNull: ['$stockQuantity', 0] }, quantity] }, 0] },
          ] },
        } }],
        { new: true, session },
      );
      const updated = await updateQuery.lean();
      if (!updated) throw Object.assign(new Error(`${item.name} no longer has enough stock. Please update your cart.`), { statusCode: 409 });

      const after = Number(updated.stockQuantity);
      await InventoryMovement.create([{
        restaurantId: current.restaurant,
        menuItemId: item._id,
        actorId,
        orderId: current._id,
        change: -quantity,
        before,
        after,
        reason: 'checkout_stock_reserved',
      }], { session });
      reserved.push({ itemId: item._id, quantity, before, after });
    }

    return { reserved: true, items: reserved };
  });
}

// Release only stock that was actually reserved, based on the per-order
// movement ledger. This prevents untracked menu items in mixed orders from
// being incorrectly credited with stock. The order marker, stock increments,
// and positive movement records commit or roll back together.
async function releaseOrderInventory(order, actorId = null) {
  if (!order?._id) return { released: false, reason: 'no_order' };

  return withRequiredTransaction(async (session) => {
    const currentQuery = Order.findById(order._id);
    queryWithSession(currentQuery, session);
    const current = await currentQuery.lean();
    if (!current?.inventoryReservedAt) return { released: false, reason: 'not_reserved' };
    if (current.inventoryReleasedAt) return { released: false, reason: 'already_released' };

    const movementsQuery = InventoryMovement.find({
      orderId: current._id,
      reason: { $in: ['checkout_stock_reserved', 'checkout_reservation_rollback', 'cancelled_order_stock_restored'] },
    });
    queryWithSession(movementsQuery, session);
    const movements = await movementsQuery.lean();
    const netByItem = new Map();
    for (const movement of movements) {
      const id = String(movement.menuItemId);
      netByItem.set(id, (netByItem.get(id) || 0) + Number(movement.change || 0));
    }
    const outstanding = [...netByItem.entries()]
      .filter(([, net]) => net < 0)
      .map(([menuItemId, net]) => ({ menuItemId, quantity: -net }));

    // A reserved order with no reservation movement is inconsistent legacy
    // data. Do not set the released marker and silently hide the discrepancy.
    if (!movements.length) {
      throw Object.assign(new Error('Inventory reservation movement history is missing; release requires reconciliation.'), { statusCode: 409, code: 'INVENTORY_LEDGER_MISSING' });
    }

    const claimQuery = Order.findOneAndUpdate(
      { _id: current._id, inventoryReservedAt: { $ne: null }, inventoryReleasedAt: null },
      { $set: { inventoryReleasedAt: new Date() } },
      { new: true, session },
    );
    const claim = await claimQuery.lean();
    if (!claim) return { released: false, reason: 'already_released' };

    for (const { menuItemId, quantity } of outstanding) {
      if (!Number.isSafeInteger(quantity) || quantity < 1) {
        throw Object.assign(new Error('Invalid outstanding inventory reservation quantity.'), { statusCode: 409, code: 'INVENTORY_LEDGER_INVALID' });
      }
      const itemQuery = Menu.findOne({ _id: menuItemId, restaurantId: current.restaurant })
        .select('_id stockQuantity inStock');
      queryWithSession(itemQuery, session);
      const item = await itemQuery.lean();
      if (!item) {
        throw Object.assign(new Error(`Reserved menu item ${menuItemId} no longer exists; inventory release requires reconciliation.`), { statusCode: 409, code: 'INVENTORY_ITEM_MISSING' });
      }
      const before = Number(item.stockQuantity || 0);
      const updateQuery = Menu.findOneAndUpdate(
        { _id: item._id, restaurantId: current.restaurant },
        [{ $set: {
          stockQuantity: { $add: [{ $ifNull: ['$stockQuantity', 0] }, quantity] },
          inStock: { $and: [
            { $ne: [{ $ifNull: ['$manualAvailability', '$inStock'] }, false] },
            { $or: [
              { $ne: [{ $ifNull: ['$trackStock', false] }, true] },
              { $gt: [{ $add: [{ $ifNull: ['$stockQuantity', 0] }, quantity] }, 0] },
            ] },
          ] },
        } }],
        { new: true, session },
      );
      const updated = await updateQuery.lean();
      if (!updated) throw Object.assign(new Error(`Could not restore stock for menu item ${menuItemId}.`), { statusCode: 409, code: 'INVENTORY_RESTORE_FAILED' });
      await InventoryMovement.create([{
        restaurantId: current.restaurant,
        menuItemId: item._id,
        actorId,
        orderId: current._id,
        change: quantity,
        before,
        after: Number(updated.stockQuantity),
        reason: 'cancelled_order_stock_restored',
      }], { session });
    }

    return { released: true, items: outstanding };
  });
}

module.exports = { releaseOrderInventory, reserveOrderInventory };
