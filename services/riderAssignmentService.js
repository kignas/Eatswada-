// File 1: services/riderAssignmentService.js
'use strict';

/**
 * Rider Assignment Service
 * ─────────────────────────
 * Finds and assigns the best available rider to an order automatically.
 * Includes capabilities to handle timeouts, rejections, and auto-release.
 */

const User = require('../models/User');
const Order = require('../models/Order');
const Restaurant = require('../models/Restaurant');

const ACTIVE_RIDER_STATUSES = ['assigned', 'accepted', 'reached_restaurant', 'picked_up', 'out_for_delivery'];

function normalizeZone(value) {
  return String(value || '').trim().toLowerCase();
}

async function resolveOrderZone(order) {
  if (order.restaurant) {
    try {
      const restaurant = await Restaurant.findById(order.restaurant)
        .select('deliveryZone area city')
        .lean();
      const zone = restaurant && (restaurant.deliveryZone || restaurant.area || restaurant.city);
      if (zone) return normalizeZone(zone);
    } catch (err) {}
  }
  const fallback = (order.deliveryAddress && (order.deliveryAddress.area || order.deliveryAddress.city)) || '';
  return normalizeZone(fallback);
}

/**
 * Finds the single best available rider for an order.
 * @param {Object} order 
 * @param {Array<String>} excludeRiderIds - IDs of riders who rejected or timed out
 */
async function findBestAvailableRider(order, excludeRiderIds = []) {
  const query = {
    role: 'rider',
    isActive: true,
    'riderDetails.isOnline': true,
  };

  if (excludeRiderIds && excludeRiderIds.length > 0) {
    query._id = { $nin: excludeRiderIds };
  }

  const onlineRiders = await User.find(query)
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
    if (loadA !== loadB) return loadA - loadB; 
    return new Date(a.updatedAt) - new Date(b.updatedAt); 
  });

  return { rider: pool[0], zoneMatched };
}

/**
 * Attempts to auto-assign the best available rider.
 */
async function autoAssignRider(order, excludeRiderIds = []) {
  try {
    if (order.rider) {
      return { assigned: false, rider: null, reason: 'Order already has a rider assigned.' };
    }

    const { rider, zoneMatched } = await findBestAvailableRider(order, excludeRiderIds);
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
    return { assigned: false, rider: null, reason: `Auto-assignment failed: ${err.message}` };
  }
}

/**
 * Safely handles order release and reassignment caused by timeouts, rejections, or offline status.
 * Uses atomic operations to prevent duplicate assignment from concurrent requests.
 */
async function handleReassignment(orderId, oldRiderId, reasonNote) {
  // Prevent reassignment if the rider has already picked up the order
  const NO_REASSIGN_STATUSES = ['picked_up', 'out_for_delivery', 'delivered'];

  // Atomically unassign the rider to prevent concurrent race conditions
  const lockedOrder = await Order.findOneAndUpdate(
    { _id: orderId, rider: oldRiderId, riderStatus: { $nin: NO_REASSIGN_STATUSES } },
    {
      $unset: { rider: 1, riderAssignedAt: 1, riderEarning: 1 },
      $set: { riderStatus: 'unassigned', status: 'waiting_for_rider' },
      $push: { riderStatusHistory: { status: 'unassigned', note: reasonNote, at: new Date(), riderId: oldRiderId } }
    },
    { new: true }
  );

  if (!lockedOrder) {
    return { assigned: false, reason: 'Order state changed concurrently or past reassignment stage.' };
  }

  // Retrieve riders who previously timed out or rejected this order so they aren't reassigned immediately
  const excludedIds = lockedOrder.riderStatusHistory
    .filter(h => h.status === 'unassigned' && h.riderId)
    .map(h => String(h.riderId));
  excludedIds.push(String(oldRiderId));

  // Auto-assign the next available rider
  const assignment = await autoAssignRider(lockedOrder, excludedIds);
  if (assignment.assigned) {
    await lockedOrder.save();
    scheduleRiderTimeout(lockedOrder._id, lockedOrder.rider);
  }
  
  return assignment;
}

/**
 * Schedules a background timeout that releases the order if not accepted within 60 seconds.
 */
function scheduleRiderTimeout(orderId, riderId) {
  setTimeout(async () => {
    try {
      const order = await Order.findById(orderId);
      // Check if the order is still tied to the same rider and hasn't progressed past 'assigned'
      if (order && order.rider && order.rider.toString() === riderId.toString() && order.riderStatus === 'assigned') {
        await handleReassignment(orderId, riderId, 'Auto-released: Rider did not accept within 60 seconds.');
      }
    } catch (err) {
      console.error('Timeout reassignment failed:', err);
    }
  }, 60 * 1000);
}

/**
 * Durable recovery for the accept-timeout.
 * ─────────────────────────────────────────
 * scheduleRiderTimeout() uses an in-process setTimeout, which is lost when the
 * server restarts, sleeps (Render free tier), or is replaced. This sweep is the
 * safety net: it finds orders still sitting in riderStatus 'assigned' past the
 * accept window and releases + reassigns them, so an order can never get stuck
 * "assigned" forever just because the process that scheduled its timeout died.
 *
 * handleReassignment() uses an atomic findOneAndUpdate, so even if two
 * instances sweep at once only one wins per order — safe to run everywhere.
 */
const ACCEPT_TIMEOUT_MS = 60 * 1000;

async function recoverStuckAssignments() {
  const cutoff = new Date(Date.now() - ACCEPT_TIMEOUT_MS);
  let stuck = [];
  try {
    stuck = await Order.find({
      riderStatus: 'assigned',
      riderAssignedAt: { $lte: cutoff },
      status: { $nin: ['delivered', 'cancelled'] },
    }).select('_id rider').lean();
  } catch (err) {
    console.error('[assignment-recovery] scan failed:', err.message);
    return { scanned: 0, reassigned: 0 };
  }

  let reassigned = 0;
  for (const order of stuck) {
    if (!order.rider) continue;
    try {
      const result = await handleReassignment(
        order._id,
        order.rider,
        'Auto-released on recovery sweep: rider did not accept in time.'
      );
      if (result && result.assigned) reassigned += 1;
    } catch (err) {
      console.error(`[assignment-recovery] order ${order._id} failed:`, err.message);
    }
  }
  return { scanned: stuck.length, reassigned };
}

let recoveryTimer = null;

/**
 * Runs one sweep on boot, then every intervalMs. Call once from server.js
 * after the DB connection is established.
 */
function startAssignmentRecovery(intervalMs = 60 * 1000) {
  recoverStuckAssignments().catch(() => {});
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = setInterval(() => { recoverStuckAssignments().catch(() => {}); }, intervalMs);
  if (recoveryTimer.unref) recoveryTimer.unref();
  return recoveryTimer;
}

module.exports = { 
  autoAssignRider, 
  findBestAvailableRider, 
  resolveOrderZone, 
  handleReassignment, 
  scheduleRiderTimeout,
  recoverStuckAssignments,
  startAssignmentRecovery,
};
