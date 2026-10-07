'use strict';

const Order = require('../models/Order');
const { initiateOrderRefund } = require('./refundService');
const { releaseOrderInventory } = require('./inventoryReservationService');
const { notifyOrderStatus } = require('./notificationService');
const { stopRing } = require('./pushService');
const { isRestaurantResponseOverdue } = require('./orderCancellationPolicy');

/**
 * Cancel a placed order that passed the restaurant's 5-minute response window.
 * Only one process wins the conditional update, so overlapping sweeps are safe.
 */
async function expireUnrespondedOrder(orderId) {
  const now = new Date();
  const expired = await Order.findOneAndUpdate(
    {
      _id: orderId,
      status: 'placed',
      restaurantResponseDeadline: { $ne: null, $lte: now },
    },
    {
      $set: {
        status: 'cancelled',
        cancelReason: 'Restaurant did not respond within 5 minutes',
        cancellationResponsibility: 'restaurant',
        isCancellable: false,
        restaurantChargeReason: 'Restaurant did not respond within the 5-minute order acceptance window',
      },
      $inc: { __v: 1 },
      $push: { statusHistory: { status: 'cancelled', note: 'Automatically cancelled: restaurant did not respond within 5 minutes' } },
    },
    { new: true },
  );
  if (!expired) return false;

  await releaseOrderInventory(expired, expired.user).catch(() => {});
  await initiateOrderRefund(expired, 'Restaurant did not respond within 5 minutes');
  await stopRing(expired._id).catch(() => {});
  await notifyOrderStatus(expired.user, expired).catch(() => {});
  return true;
}

async function recoverUnrespondedOrders() {
  const now = new Date();
  let overdue = [];
  try {
    overdue = await Order.find({
      status: 'placed',
      restaurantResponseDeadline: { $ne: null, $lte: now },
    }).select('_id restaurantResponseDeadline').lean();
  } catch (err) {
    console.error('[restaurant-response-recovery] scan failed:', err.message);
    return { scanned: 0, cancelled: 0 };
  }

  let cancelled = 0;
  for (const order of overdue) {
    try { if (await expireUnrespondedOrder(order._id)) cancelled += 1; }
    catch (err) { console.error(`[restaurant-response-recovery] order ${order._id} failed:`, err.message); }
  }
  return { scanned: overdue.length, cancelled };
}

let recoveryTimer = null;
function startRestaurantResponseRecovery(intervalMs = 10 * 1000) {
  recoverUnrespondedOrders().catch(() => {});
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = setInterval(() => { recoverUnrespondedOrders().catch(() => {}); }, intervalMs);
  if (recoveryTimer.unref) recoveryTimer.unref();
  return recoveryTimer;
}

module.exports = { expireUnrespondedOrder, recoverUnrespondedOrders, startRestaurantResponseRecovery };
