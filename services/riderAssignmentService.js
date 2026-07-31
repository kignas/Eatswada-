'use strict';

/**
 * Rider Assignment Service
 * ─────────────────────────
 * Finds and assigns the best available rider to an order automatically.
 * Kept separate from orderController so the matching logic can be reused
 * (a background retry job, an admin "auto-assign" button, etc.) without
 * duplicating it.
 *
 * Contract: autoAssignRider() NEVER throws. Any internal failure (bad
 * lookup, missing zone data, DB hiccup) is caught and reported back as
 * { assigned: false, reason }, so a failure here can never crash the
 * order-status-update request that triggered it.
 */

const User = require('../models/User');
const Order = require('../models/Order');
const Restaurant = require('../models/Restaurant');

// Every riderStatus that counts as "this rider is currently busy with a
// delivery" — mirrors ACTIVE_RIDER_STATUSES in riderController.js.
const ACTIVE_RIDER_STATUSES = ['assigned', 'accepted', 'reached_restaurant', 'picked_up', 'out_for_delivery'];

function normalizeZone(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Best-effort resolution of a "zone" string to match riders against.
 * Tries the restaurant's own deliveryZone/area/city first (whichever of
 * those fields actually exists on your Restaurant schema — unknown fields
 * just come back undefined, no crash), then falls back to the delivery
 * address snapshot stored on the order itself.
 *
 * Returns '' (never throws) if nothing usable is found — callers should
 * treat '' as "no zone preference, treat all online riders equally".
 */
async function resolveOrderZone(order) {
  if (order.restaurant) {
    try {
      const restaurant = await Restaurant.findById(order.restaurant)
        .select('deliveryZone area city')
        .lean();
      const zone = restaurant && (restaurant.deliveryZone || restaurant.area || restaurant.city);
      if (zone) return normalizeZone(zone);
    } catch (err) {
      // Swallow — fall back to the order's own address snapshot below.
    }
  }
  const fallback = (order.deliveryAddress && (order.deliveryAddress.area || order.deliveryAddress.city)) || '';
  return normalizeZone(fallback);
}

/**
 * Finds the single best available rider for an order. Never throws.
 * Resolves to { rider: null, zoneMatched: false } if no online rider exists.
 *
 * Selection rules:
 *  1. role: 'rider', isActive: true, riderDetails.isOnline: true
 *  2. riders in the order's zone are preferred over riders outside it —
 *     falls back to the full online pool if none match the zone, or if
 *     the zone couldn't be resolved (never leaves an order unassigned
 *     just because zone data is missing)
 *  3. within that pool, fewest currently-active deliveries wins
 *  4. ties are broken by whichever rider has been idle the longest
 *     (oldest `updatedAt` on their user doc)
 */
async function findBestAvailableRider(order) {
  const onlineRiders = await User.find({
    role: 'rider',
    isActive: true,
    'riderDetails.isOnline': true,
  })
    .select('_id name riderDetails updatedAt')
    .lean();

  if (!onlineRiders.length) return { rider: null, zoneMatched: false };

  const orderZone = await resolveOrderZone(order);
  const sameZoneRiders = orderZone
    ? onlineRiders.filter((r) => normalizeZone(r.riderDetails && r.riderDetails.deliveryZone) === orderZone)
    : [];

  const zoneMatched = sameZoneRiders.length > 0;
  const pool = zoneMatched ? sameZoneRiders : onlineRiders;

  const riderIds = pool.map((r) => r._id);
  const loadCounts = await Order.aggregate([
    { $match: { rider: { $in: riderIds }, riderStatus: { $in: ACTIVE_RIDER_STATUSES } } },
    { $group: { _id: '$rider', activeCount: { $sum: 1 } } },
  ]);
  const loadMap = new Map(loadCounts.map((l) => [String(l._id), l.activeCount]));

  pool.sort((a, b) => {
    const loadA = loadMap.get(String(a._id)) || 0;
    const loadB = loadMap.get(String(b._id)) || 0;
    if (loadA !== loadB) return loadA - loadB; // fewer active deliveries first
    return new Date(a.updatedAt) - new Date(b.updatedAt); // longer-idle rider first
  });

  return { rider: pool[0], zoneMatched };
}

/**
 * Attempts to auto-assign the best available rider to `order`.
 * Mutates the given Mongoose order document in place (sets rider,
 * riderAssignedAt, riderStatus, riderStatusHistory, riderEarning) but
 * does NOT call order.save() — that stays the caller's responsibility so
 * it can be batched with whatever else is already being saved.
 *
 * Always resolves — never rejects.
 *
 * @returns {Promise<{assigned: boolean, rider: {_id, name}|null, reason: string}>}
 */
async function autoAssignRider(order) {
  try {
    if (order.rider) {
      return { assigned: false, rider: null, reason: 'Order already has a rider assigned.' };
    }

    const { rider, zoneMatched } = await findBestAvailableRider(order);
    if (!rider) {
      return { assigned: false, rider: null, reason: 'No online riders are currently available.' };
    }

    order.rider = rider._id;
    order.riderAssignedAt = new Date();
    order.riderStatus = 'assigned';
    order.riderEarning = order.riderEarning || order.deliveryFee || 0;
    order.riderStatusHistory = order.riderStatusHistory || [];
    order.riderStatusHistory.push({
      status: 'assigned',
      note: `Auto-assigned to ${rider.name}${zoneMatched ? ' (same zone)' : ' (nearest available, outside zone)'}`,
      at: new Date(),
    });

    return {
      assigned: true,
      rider: { _id: rider._id, name: rider.name },
      reason: zoneMatched
        ? 'Auto-assigned within delivery zone.'
        : 'Auto-assigned from wider pool (no same-zone rider was online).',
    };
  } catch (err) {
    // Defensive catch-all — auto-assignment must never break the order
    // status update that triggered it.
    return { assigned: false, rider: null, reason: `Auto-assignment failed: ${err.message}` };
  }
}

module.exports = { autoAssignRider, findBestAvailableRider, resolveOrderZone };
