'use strict';

/**
 * pushService — device-token storage and order push notifications.
 *
 * Device tokens and notification/ring state are persisted in MongoDB. Ring
 * ownership is claimed with an atomic MongoDB update, so multiple backend
 * instances can safely share the same notification workload.
 *
 * A process-local timer is intentionally NOT used as the source of truth.
 * The database record is the durable state; a lightweight sweep on each
 * notification call advances a ring when due. This survives process restarts
 * and prevents every Render instance from independently sending the same ring.
 */

const User = require('../models/User');
const Restaurant = require('../models/Restaurant');
const Order = require('../models/Order');
const Notification = require('../models/Notification');
const { sendPushToTokens } = require('../models/firebaseAdmin');

const RING_INTERVAL_MS = 15 * 1000;
const RING_MAX_TRIES = 10;
const RING_LEASE_MS = 10 * 1000;

/* ── Token registration ─────────────────────────────────────── */
async function registerToken(userId, token) {
  if (!token || typeof token !== 'string' || token.length < 20 || token.length > 4096) {
    const e = new Error('A valid device token is required');
    e.statusCode = 400;
    throw e;
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
    console.error('[PUSH] send failed:', err.message);
    return { sent: 0, error: err.message };
  }

  if (invalid.length) {
    await User.updateOne({ _id: userId }, { $pull: { fcmTokens: { $in: invalid } } });
  }
  return { sent: tokens.length - invalid.length };
}

/* ── Persistent ring helpers ────────────────────────────────── */
function ringFields() {
  return {
    'ring.active': true,
    'ring.attempts': 0,
    'ring.lastSentAt': null,
    'ring.leaseUntil': null,
  };
}

async function createOrResumeRingNotification({ userId, title, message, data, dedupeKey }) {
  const notification = await Notification.findOneAndUpdate(
    { dedupeKey },
    {
      $setOnInsert: {
        user: userId,
        type: 'order',
        title,
        message,
        data,
        dedupeKey,
        ring: ringFieldsFromDefaults(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  return notification;
}

function ringFieldsFromDefaults() {
  return {
    active: true,
    attempts: 0,
    lastSentAt: null,
    leaseUntil: null,
  };
}

async function claimRing(notificationId) {
  const now = new Date();
  const leaseUntil = new Date(Date.now() + RING_LEASE_MS);
  const nextAttempt = await Notification.findOneAndUpdate(
    {
      _id: notificationId,
      'ring.active': true,
      readAt: null,
      'ring.attempts': { $lt: RING_MAX_TRIES },
      $and: [
        {
          $or: [
            { 'ring.leaseUntil': null },
            { 'ring.leaseUntil': { $lte: now } },
          ],
        },
        {
          $or: [
            { 'ring.lastSentAt': null },
            { 'ring.lastSentAt': { $lte: new Date(Date.now() - RING_INTERVAL_MS) } },
          ],
        },
      ],
    },
    {
      $inc: { 'ring.attempts': 1 },
      $set: { 'ring.leaseUntil': leaseUntil },
    },
    { new: true }
  ).lean();

  return nextAttempt;
}

async function finishRingAttempt(notificationId) {
  await Notification.updateOne(
    { _id: notificationId },
    {
      $set: {
        'ring.lastSentAt': new Date(),
        'ring.leaseUntil': null,
      },
    }
  );
}

async function stopRingByNotification(notificationId) {
  await Notification.updateOne(
    { _id: notificationId },
    {
      $set: {
        'ring.active': false,
        'ring.leaseUntil': null,
      },
    }
  );
}

/* ── New-order ring to the restaurant owner ─────────────────── */
async function notifyRestaurantNewOrder(order) {
  try {
    const id = String(order._id);
    const restaurant = await Restaurant.findById(order.restaurant).select('owner name').lean();
    if (!restaurant || !restaurant.owner) return;
    const ownerId = restaurant.owner;
    const dedupeKey = `vendor_new_order:${String(ownerId)}:${id}`;

    const notification = await createOrResumeRingNotification({
      userId: ownerId,
      title: 'New order!',
      message: `New order · ₹${Number(order.total || 0)} · tap to accept`,
      data: {
        orderId: id,
        orderNumber: order.orderNumber || '',
        kind: 'new_order',
      },
      dedupeKey,
    });

    // If the order is no longer placed, no ring should be resumed.
    if (order.status !== 'placed') {
      await stopRingByNotification(notification._id);
      return;
    }

    await sendClaimedRing(notification._id, ownerId, {
      type: 'new_order',
      title: 'New order!',
      body: `New order · ₹${Number(order.total || 0)} · tap to accept`,
      orderId: id,
      orderNumber: order.orderNumber || '',
    });
  } catch (err) {
    console.error('[PUSH] notifyRestaurantNewOrder failed:', err.message);
  }
}

async function sendClaimedRing(notificationId, userId, payload) {
  const claimed = await claimRing(notificationId);
  if (!claimed) return false;

  try {
    await pushToUser(userId, payload);
  } finally {
    await finishRingAttempt(notificationId).catch(() => {});
  }
  return true;
}

async function notifyAdminsNewOrder(order) {
  const id = String(order._id);
  const admins = await User.find({ role: 'admin' }).select('_id').lean();
  if (!admins.length) return { recipients: 0, sent: 0 };

  let recipients = 0;
  let sent = 0;
  const title = 'New order received';
  const body = `Order ${order.orderNumber || '#' + id.slice(-6).toUpperCase()} · ₹${Number(order.total || 0)} · ${order.restaurantName || 'Restaurant'}`;

  for (const admin of admins) {
    const adminId = String(admin._id);
    const dedupeKey = `admin_new_order:${adminId}:${id}`;

    let notification;
    try {
      notification = await createOrResumeRingNotification({
        userId: admin._id,
        title,
        message: body,
        data: {
          orderId: id,
          orderNumber: order.orderNumber || '',
          kind: 'admin_new_order',
          restaurantName: order.restaurantName || '',
        },
        dedupeKey,
      });
    } catch (err) {
      // Another instance may have won a simultaneous upsert. Retry by reading
      // the durable notification rather than creating a duplicate.
      if (err?.code === 11000) {
        notification = await Notification.findOne({ dedupeKey }).lean();
      } else {
        throw err;
      }
    }

    if (!notification) continue;
    recipients += 1;

    if (notification.readAt || order.status !== 'placed') {
      if (order.status !== 'placed') await stopRingByNotification(notification._id);
      continue;
    }

    const didSend = await sendClaimedRing(notification._id, admin._id, {
      type: 'admin_new_order',
      title,
      body,
      orderId: id,
      orderNumber: order.orderNumber || '',
      restaurantName: order.restaurantName || '',
    });
    if (didSend) sent += 1;
  }

  return { recipients, sent };
}

/*
 * Kept for backwards compatibility with callers that used the old in-memory
 * timer API. Ring state is now durable, so stopping means deactivating the
 * matching MongoDB notification records.
 */
async function stopAdminRing(adminId, orderId) {
  const key = `admin_new_order:${String(adminId)}:${String(orderId)}`;
  await stopRingByDedupeKey(key);
}

async function stopRing(orderId) {
  const keySuffix = String(orderId);
  await Notification.updateMany(
    {
      'data.orderId': keySuffix,
      'data.kind': 'new_order',
    },
    { $set: { 'ring.active': false, 'ring.leaseUntil': null } }
  );
}

async function stopRingByDedupeKey(dedupeKey) {
  await Notification.updateOne(
    { dedupeKey },
    { $set: { 'ring.active': false, 'ring.leaseUntil': null } }
  );
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
