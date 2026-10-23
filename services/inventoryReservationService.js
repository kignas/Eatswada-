'use strict';
const Menu = require('../models/Menu');
const Order = require('../models/Order');
const InventoryMovement = require('../models/InventoryMovement');


// A line's menuItem may be a raw ObjectId OR a populated Menu document (some
// callers pass an order that was just `.populate('items.menuItem')`d, e.g. the
// checkout controller). `String(populatedDoc)` yields the whole document's JSON,
// which then fails ObjectId casting and aborts the reservation. Resolve to the
// id in both cases.
function menuItemIdOf(line) {
  const ref = line && line.menuItem;
  if (!ref) return '';
  if (typeof ref === 'object' && ref._id) return String(ref._id);
  return String(ref);
}

// Reserve tracked stock at checkout using a conditional atomic decrement. Two
// concurrent checkouts cannot both consume the same units. Untracked legacy
// items keep their previous unlimited-stock behavior.
async function reserveOrderInventory(order, actorId = null) {
  if (!order?._id) throw Object.assign(new Error('Order is required for inventory reservation.'), {statusCode:400});
  if (order.inventoryReservedAt && !order.inventoryReleasedAt) return {reserved:false,reason:'already_reserved'};
  const needs = new Map();
  for (const line of (order.items || [])) {
    const id = menuItemIdOf(line);
    if (id) needs.set(id,(needs.get(id)||0)+Number(line.quantity||0));
  }
  const reserved=[];
  try {
    for (const [menuItemId, quantity] of needs) {
      if (!Number.isInteger(quantity) || quantity < 1) throw Object.assign(new Error('Invalid inventory quantity.'),{statusCode:400});
      const item = await Menu.findOne({_id:menuItemId,restaurantId:order.restaurant,isActive:{$ne:false}}).select('_id name trackStock stockQuantity inStock manualAvailability');
      if (!item) throw Object.assign(new Error('A menu item is no longer available. Please refresh your cart.'),{statusCode:409});
      if (!item.trackStock) continue;
      const before=Number(item.stockQuantity||0);
      const updated=await Menu.findOneAndUpdate(
        {_id:item._id,restaurantId:order.restaurant,trackStock:true,stockQuantity:{$gte:quantity},inStock:true,isActive:{$ne:false}},
        [{$set:{stockQuantity:{$subtract:[{$ifNull:['$stockQuantity',0]},quantity]},inStock:{$and:[{$ne:[{$ifNull:['$manualAvailability','$inStock']},false]},{$gt:[{$subtract:[{$ifNull:['$stockQuantity',0]},quantity]},0]}]}}}],
        {new:true}
      );
      if (!updated) throw Object.assign(new Error(`${item.name} no longer has enough stock. Please update your cart.`),{statusCode:409});
      reserved.push({itemId:item._id,quantity,before,after:Number(updated.stockQuantity)});
      await InventoryMovement.create({restaurantId:order.restaurant,menuItemId:item._id,actorId,orderId:order._id,change:-quantity,before,after:Number(updated.stockQuantity),reason:'checkout_stock_reserved'});
    }
    if (reserved.length) await Order.updateOne({_id:order._id,inventoryReservedAt:null},{$set:{inventoryReservedAt:new Date(),inventoryReleasedAt:null}});
    return {reserved:reserved.length>0,items:reserved};
  } catch (error) {
    // Reverse any earlier decrements from this attempt before surfacing failure.
    for (const r of reserved.reverse()) {
      const restored=await Menu.findOneAndUpdate(
        {_id:r.itemId,restaurantId:order.restaurant},
        [{$set:{stockQuantity:{$add:[{$ifNull:['$stockQuantity',0]},r.quantity]},inStock:{$and:[{$ne:[{$ifNull:['$manualAvailability','$inStock']},false]},{$gt:[{$add:[{$ifNull:['$stockQuantity',0]},r.quantity]},0]}]}}}],
        {new:true}
      );
      if (restored) await InventoryMovement.create({restaurantId:order.restaurant,menuItemId:r.itemId,actorId,orderId:order._id,change:r.quantity,before:r.after,after:Number(restored.stockQuantity),reason:'checkout_reservation_rollback'});
    }
    throw error;
  }
}

// Idempotent release claim prevents repeated cancellation requests from
// restoring the same accepted-order stock more than once.
async function releaseOrderInventory(order, actorId = null) {
  if (!order?.inventoryReservedAt || order.inventoryReleasedAt) return { released:false, reason:'not_reserved_or_already_released' };
  const claim = await Order.findOneAndUpdate(
    { _id:order._id, inventoryReservedAt:{$ne:null}, inventoryReleasedAt:null },
    { $set:{inventoryReleasedAt:new Date()} },
    { new:true }
  );
  if (!claim) return { released:false, reason:'already_released' };
  const quantities = new Map();
  for (const line of (order.items || [])) {
    const id = menuItemIdOf(line); if(id) quantities.set(id,(quantities.get(id)||0)+Number(line.quantity||0));
  }
  for (const [menuItemId, quantity] of quantities) {
    const item=await Menu.findOne({_id:menuItemId,restaurantId:order.restaurant}).select('_id stockQuantity inStock');
    if(!item) continue;
    const before=Number(item.stockQuantity||0);
    const updated=await Menu.findOneAndUpdate(
      {_id:item._id,restaurantId:order.restaurant},
      [{$set:{stockQuantity:{$add:[{$ifNull:['$stockQuantity',0]},quantity]},inStock:{$and:[{$ne:[{$ifNull:['$manualAvailability','$inStock']},false]},{$or:[{$ne:[{$ifNull:['$trackStock',false]},true]},{$gt:[{$add:[{$ifNull:['$stockQuantity',0]},quantity]},0]}]}]}}}],
      {new:true}
    );
    await InventoryMovement.create({restaurantId:order.restaurant,menuItemId:item._id,actorId,orderId:order._id,change:quantity,before,after:Number(updated.stockQuantity),reason:'cancelled_order_stock_restored'});
  }
  return {released:true};
}
module.exports={releaseOrderInventory,reserveOrderInventory};
