'use strict';
const Menu = require('../models/Menu');
const Order = require('../models/Order');
const InventoryMovement = require('../models/InventoryMovement');

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
    const id=String(line.menuItem||''); if(id) quantities.set(id,(quantities.get(id)||0)+Number(line.quantity||0));
  }
  for (const [menuItemId, quantity] of quantities) {
    const item=await Menu.findOne({_id:menuItemId,restaurantId:order.restaurant}).select('_id stockQuantity inStock');
    if(!item) continue;
    const before=Number(item.stockQuantity||0);
    const updated=await Menu.findOneAndUpdate({_id:item._id,restaurantId:order.restaurant},{$inc:{stockQuantity:quantity},$set:{inStock:true}},{new:true});
    await InventoryMovement.create({restaurantId:order.restaurant,menuItemId:item._id,actorId,orderId:order._id,change:quantity,before,after:Number(updated.stockQuantity),reason:'cancelled_order_stock_restored'});
  }
  return {released:true};
}
module.exports={releaseOrderInventory};
