'use strict';

const Order = require('../models/Order');
const Restaurant = require('../models/Restaurant');

// Orders occupying a restaurant's active operational capacity. A delivered or
// cancelled order is no longer counted, while waiting/assigned/out-for-delivery
// are still active from the kitchen's perspective.
const ACTIVE_ORDER_STATUSES = Object.freeze([
  'placed',
  'confirmed',
  'preparing',
  'waiting_for_rider',
  'assigned',
  'out_for_delivery',
  'otp_verified',
]);

async function getRestaurantCapacity(restaurantId) {
  const restaurant = await Restaurant.findById(restaurantId)
    .select('_id name maxActiveOrders deliveryMode businessType commissionRate commissionPlan settlementSchedule')
    .lean();
  if (!restaurant) return null;

  const maxActiveOrders = Number.isInteger(Number(restaurant.maxActiveOrders)) && Number(restaurant.maxActiveOrders) > 0
    ? Number(restaurant.maxActiveOrders)
    : 20;

  const activeOrders = await Order.countDocuments({
    restaurant: restaurant._id,
    status: { $in: ACTIVE_ORDER_STATUSES },
  });

  return { restaurant, activeOrders, maxActiveOrders, availableSlots: Math.max(0, maxActiveOrders - activeOrders) };
}

module.exports = { ACTIVE_ORDER_STATUSES, getRestaurantCapacity };
