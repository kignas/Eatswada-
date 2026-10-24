'use strict';

const Order = require('../models/Order');
const pushService = require('./pushService');
const { RESTAURANT_RESPONSE_WINDOW_MS } = require('./orderCancellationPolicy');

/**
 * Hand a fully-committed order to its restaurant.
 *
 * "Committed" means the customer owes nothing more before the kitchen starts:
 *   - ordinary COD orders (cash at the door), right after checkout
 *   - partial-COD orders, once the Razorpay advance is captured
 *   (Online UPI orders are handed over by paymentController.markCheckoutPaid.)
 *
 * What it does, exactly once per order:
 *   1. Starts the restaurant's 5-minute response window by setting
 *      restaurantResponseDeadline. Without this the auto-cancel sweep
 *      (restaurantOrderTimeoutService) can never expire an ignored COD order.
 *   2. Rings the restaurant and notifies admins.
 *
 * The deadline update is a conditional claim (deadline still null, order still
 * `placed`), so a duplicate call — webhook + verify racing, a Razorpay webhook
 * retry, a second sweep — claims nothing and sends no second notification.
 * Never throws: a push failure must not fail checkout or a payment callback.
 *
 * Returns { handedOff: boolean, order?: claimedOrder }.
 */
async function releaseOrderToRestaurant(order) {
  if (!order || !order._id) return { handedOff: false };
  try {
    const deadline = new Date(Date.now() + RESTAURANT_RESPONSE_WINDOW_MS);
    const claimed = await Order.findOneAndUpdate(
      { _id: order._id, status: 'placed', restaurantResponseDeadline: null },
      { $set: { restaurantResponseDeadline: deadline } },
      { new: true }
    );
    if (!claimed) return { handedOff: false };

    // Keep the caller's in-memory document aligned with the database.
    try { order.restaurantResponseDeadline = claimed.restaurantResponseDeadline; } catch (_) { /* response-only */ }

    pushService.notifyRestaurantNewOrder(claimed).catch((err) => console.error('[PUSH] vendor new-order:', err.message));
    pushService.notifyAdminsNewOrder(claimed).catch((err) => console.error('[PUSH] admin-new-order:', err.message));
    return { handedOff: true, order: claimed };
  } catch (err) {
    console.error(`[HANDOFF] order ${order._id} could not be released to the restaurant:`, err.message);
    return { handedOff: false, error: err.message };
  }
}

module.exports = { releaseOrderToRestaurant };
