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
const Notification = require('../models/Notification');
const { sendPushToTokens } = require('../models/firebaseAdmin');

const RING_INTERVAL_MS = 15 * 1000;   // re-alert cadence
const RING_MAX_TRIES    = 10;          // ~5 minutes of ringing, then give up
const activeRings = new Map();         // orderId -> intervalId
const activeAdminRings = new Map();    // adminId:orderId -> intervalId

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

    // Persist one in-app notification as well as the FCM push. This gives
    // the vendor a durable notification even if the device was offline.
    try {
      await Notification.create({
        user: ownerId,
        type: 'order',
        title: 'New order!',
        message: `New order · ₹${Number(order.total || 0)} · tap to accept`,
        data: {
          orderId: id,
          orderNumber: order.orderNumber || '',
          kind: 'new_order'
        }
      });
    } catch (err) {
      console.error('[NOTIFY] vendor notification persistence failed:', err.message);
    }

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

async function notifyAdminsNewOrder(order) {
  const id = String(order._id);
  const admins = await User.find({ role: 'admin' }).select('_id').lean();
  if (!admins.length) return { recipients: 0, sent: 0 };

  let recipients = 0, sent = 0;
  const title = 'New order received';
  const body = `Order ${order.orderNumber || '#' + id.slice(-6).toUpperCase()} · ₹${Number(order.total || 0)} · ${order.restaurantName || 'Restaurant'}`;

  for (const admin of admins) {
    const adminId = String(admin._id);
    const key = `${adminId}:${id}`;

    // One persistent notification per admin + order. If it already exists
    // and is still unread, resume/keep the repeat ring instead of skipping it.
    let notification = await Notification.findOne({
      user: admin._id,
      type: 'order',
      'data.kind': 'admin_new_order',
      'data.orderId': id,
    });

    if (!notification) {
      notification = await Notification.create({
        user: admin._id,
        type: 'order',
        title,
        message: body,
        data: {
          orderId: id,
          orderNumber: order.orderNumber || '',
          kind: 'admin_new_order',
          restaurantName: order.restaurantName || ''
        }
      });
      recipients += 1;
    }

    // If this admin has already opened/acknowledged the notification, do not
    // restart the ring on payment/webhook retries.
    if (notification.readAt || activeAdminRings.has(key)) continue;

    const payload = () => pushToUser(admin._id, {
      type: 'admin_new_order', title, body,
      orderId: id, orderNumber: order.orderNumber || '',
      restaurantName: order.restaurantName || '',
    }).catch(() => {});

    // Immediate alert, then repeat every 15s until this admin acknowledges it.
    payload();
    sent += 1;

    let tries = 1;
    const interval = setInterval(async () => {
      tries += 1;
      let unread = false;
      try {
        const fresh = await Notification.findOne({
          _id: notification._id,
          user: admin._id,
          type: 'order',
          'data.kind': 'admin_new_order',
          'data.orderId': id,
        }).select('readAt').lean();
        unread = !!fresh && !fresh.readAt;
      } catch (_) { unread = false; }

      if (!unread || tries > RING_MAX_TRIES) {
        stopAdminRing(adminId, id);
        return;
      }
      payload();
    }, RING_INTERVAL_MS);

    if (interval.unref) interval.unref();
    activeAdminRings.set(key, interval);
  }
  return { recipients, sent };
}

function stopAdminRing(adminId, orderId) {
  const key = `${String(adminId)}:${String(orderId)}`;
  const iv = activeAdminRings.get(key);
  if (iv) { clearInterval(iv); activeAdminRings.delete(key); }
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
  notifyAdminsNewOrder,
  stopRing,
  stopAdminRing,
};
