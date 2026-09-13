'use strict';

/**
 * pushService — device-token storage and order push notifications.
 *
 * Sending reuses the already-configured firebase-admin app (the same one
 * used for phone-auth verification), so no extra credentials are needed.
 *
 * The "ring until accepted" behaviour re-sends the new-order push every
 * RING_INTERVAL_MS until the order leaves the 'placed' state or RING_MAX_TRIES
 * is reached. The timer is in-process; it self-terminates by re-reading the
 * order status each tick, so it is correct even across process restarts
 * (a restart simply stops the ring — the vendor still has the order in queue).
 */

const User = require('../models/User');
const Restaurant = require('../models/Restaurant');
const Order = require('../models/Order');
const { sendPushToTokens } = require('../models/firebaseAdmin');

const RING_INTERVAL_MS = 30 * 1000;   // re-alert cadence
const RING_MAX_TRIES    = 10;          // ~5 minutes of ringing, then give up
const activeRings = new Map();         // orderId -> intervalId

/* ── Token registration ─────────────────────────────────────── */
async function registerToken(userId, token) {
  if (!token || typeof token !== 'string' || token.length < 20 || token.length > 4096) {
    const e = new Error('A valid device token is required'); e.statusCode = 400; throw e;
  }
  await User.updateOne({ _id: userId }, { $addToSet: { fcmTokens: token } });
}

async function unregisterToken(userId, token) {
  if (!token) return;
  await User.updateOne({ _id: userId }, { $pull: { fcmTokens: token } });
}

/* ── Send to one user's devices ─────────────────────────────── */
async function pushToUser(userId, data) {
  if (!userId) return { sent: 0 };
  const user = await User.findById(userId).select('fcmTokens').lean();
  const tokens = (user && user.fcmTokens) || [];
  if (!tokens.length) return { sent: 0 };

  let invalid = [];
  try {
    invalid = await sendPushToTokens(tokens, data);
  } catch (err) {
    // Firebase not configured / transient error — never break the order flow.
    console.error('[PUSH] send failed:', err.message);
    return { sent: 0, error: err.message };
  }
  if (invalid.length) {
    await User.updateOne({ _id: userId }, { $pull: { fcmTokens: { $in: invalid } } });
  }
  return { sent: tokens.length - invalid.length };
}

/* ── New-order ring to the restaurant owner ─────────────────── */
async function notifyRestaurantNewOrder(order) {
  try {
    const id = String(order._id);
    if (activeRings.has(id)) return;                 // already ringing for this order

    const restaurant = await Restaurant.findById(order.restaurant).select('owner name').lean();
    if (!restaurant || !restaurant.owner) return;
    const ownerId = restaurant.owner;

    const payload = () => pushToUser(ownerId, {
      type: 'new_order',
      title: 'New order!',
      body: `New order · ₹${Number(order.total || 0)} · tap to accept`,
      orderId: id,
      orderNumber: order.orderNumber || '',
    }).catch(() => {});

    payload();                                        // fire immediately

    let tries = 1;
    const interval = setInterval(async () => {
      tries += 1;
      let stillPlaced = false;
      try {
        const fresh = await Order.findById(id).select('status').lean();
        stillPlaced = !!fresh && fresh.status === 'placed';
      } catch (_) { stillPlaced = false; }

      if (!stillPlaced || tries > RING_MAX_TRIES) { stopRing(id); return; }
      payload();
    }, RING_INTERVAL_MS);

    if (interval.unref) interval.unref();             // don't keep the process alive
    activeRings.set(id, interval);
  } catch (err) {
    console.error('[PUSH] notifyRestaurantNewOrder failed:', err.message);
  }
}

function stopRing(orderId) {
  const id = String(orderId);
  const iv = activeRings.get(id);
  if (iv) { clearInterval(iv); activeRings.delete(id); }
}

module.exports = {
  registerToken,
  unregisterToken,
  pushToUser,
  notifyRestaurantNewOrder,
  stopRing,
};
