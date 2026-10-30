// File 1: services/riderAssignmentService.js
'use strict';

/**
 * Dispatch service. Dispatch status is separate from kitchen/order status so
 * riders can be sourced after restaurant acceptance while food is preparing.
 * Every initial claim is conditional/atomic; GPS must be fresh to be eligible.
 */
const User = require('../models/User');
const Order = require('../models/Order');
const Restaurant = require('../models/Restaurant');
const { notifyRiderAssignment } = require('./notificationService');

const ACTIVE_RIDER_STATUSES = ['assigned', 'accepted', 'reached_restaurant', 'picked_up', 'out_for_delivery'];
const DISPATCHABLE_ORDER_STATUSES = ['confirmed', 'preparing', 'waiting_for_rider'];
const LOCATION_MAX_AGE_MS = Math.max(30_000, Number(process.env.RIDER_LOCATION_MAX_AGE_MS) || 3 * 60 * 1000);
const ACCEPT_TIMEOUT_MS = Math.max(15_000, Number(process.env.RIDER_ACCEPT_TIMEOUT_MS) || 60 * 1000);
// Fallback concurrency cap when the platform setting is unavailable. Zomato and
// Swiggy batch up to 2–3 orders per rider in one trip, so 3 is a safe default;
// admins tune it live via maxActiveOrdersPerOnlineRider.
const MAX_ACTIVE_ORDERS_PER_RIDER = Math.max(1, Number(process.env.MAX_ACTIVE_ORDERS_PER_RIDER) || 3);

// Resolve the live per-rider concurrency cap from platform settings, falling
// back to the env/default constant if settings cannot be read.
async function resolveMaxActiveOrdersPerRider() {
  try {
    const { getPlatformSettings } = require('./platformSettingsService');
    const settings = await getPlatformSettings();
    const cap = Number(settings.maxActiveOrdersPerOnlineRider);
    return Number.isFinite(cap) && cap >= 1 ? cap : MAX_ACTIVE_ORDERS_PER_RIDER;
  } catch (_) {
    return MAX_ACTIVE_ORDERS_PER_RIDER;
  }
}

function normalizeZone(value) { return String(value || '').trim().toLowerCase(); }
function validCoords(coords) {
  return Array.isArray(coords) && coords.length >= 2 && Number.isFinite(Number(coords[0])) && Number.isFinite(Number(coords[1])) &&
    Math.abs(Number(coords[0])) <= 180 && Math.abs(Number(coords[1])) <= 90 && !(Number(coords[0]) === 0 && Number(coords[1]) === 0);
}
function haversineKm(a, b) {
  const rad = n => n * Math.PI / 180;
  const [lng1, lat1] = a.map(Number); const [lng2, lat2] = b.map(Number);
  const dLat = rad(lat2-lat1), dLng = rad(lng2-lng1);
  const h = Math.sin(dLat/2)**2 + Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLng/2)**2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
async function resolveOrderZone(order) {
  if (order.restaurant) {
    try {
      const restaurant = await Restaurant.findById(order.restaurant).select('deliveryZone area city').lean();
      const zone = restaurant && (restaurant.deliveryZone || restaurant.area || restaurant.city);
      if (zone) return normalizeZone(zone);
    } catch (_) {}
  }
  return normalizeZone((order.deliveryAddress && (order.deliveryAddress.area || order.deliveryAddress.city)) || '');
}
async function getRestaurantCoordinates(order) {
  if (!order.restaurant) return null;
  try {
    const restaurant = await Restaurant.findById(order.restaurant).select('location.coordinates').lean();
    const coords = restaurant?.location?.coordinates;
    if (!validCoords(coords)) return null;
    // Restaurant schema historically defaults to Kolkata. Treat that legacy
    // placeholder as missing coordinates rather than dispatching Maynaguri jobs
    // using a fabricated pickup point.
    if (Number(coords[0]) === 88.3832 && Number(coords[1]) === 22.5726) return null;
    return coords.map(Number);
  } catch (_) { return null; }
}

async function findBestAvailableRider(order, excludeRiderIds = [], options = {}) {
  const cutoff = new Date(Date.now() - LOCATION_MAX_AGE_MS);
  const query = {
    role: 'rider', isActive: true,
    'riderDetails.isOnline': true,
    'riderDetails.currentLocation.updatedAt': { $gte: cutoff },
  };
  if (excludeRiderIds?.length) query._id = { $nin: excludeRiderIds };
  const [onlineRiders, orderZone, restaurantCoords] = await Promise.all([
    User.find(query).select('_id name riderDetails updatedAt').lean(),
    resolveOrderZone(order), getRestaurantCoordinates(order),
  ]);
  if (!onlineRiders.length) return { rider: null, zoneMatched: false, reason: 'No online riders with a fresh GPS location are currently available.' };
  if (!restaurantCoords) return { rider: null, zoneMatched: false, reason: 'Restaurant coordinates are missing or invalid; dispatch cannot safely estimate pickup distance.' };

  // COD cash-capacity guard (Pillar 3): a rider already holding cash at or
  // above their limit must not take another cash order. They stay eligible
  // for prepaid UPI orders, so only COD dispatches filter them out.
  const isCodOrder = String(options.paymentMethod || order?.paymentMethod || '').toLowerCase() === 'cod';
  const cashEligible = isCodOrder
    ? onlineRiders.filter(r => Number(r.riderDetails?.cashInHand || 0) < Number(r.riderDetails?.codCashLimit ?? Infinity))
    : onlineRiders;
  if (!cashEligible.length) {
    return { rider: null, zoneMatched: false, reason: 'Every eligible rider is at their COD cash limit. Collect deposits before dispatching another cash order.' };
  }

  const sameZone = orderZone ? cashEligible.filter(r => normalizeZone(r.riderDetails?.deliveryZone) === orderZone) : [];
  const riderIds = cashEligible.map(r => r._id);
  const maxPerRider = await resolveMaxActiveOrdersPerRider();
  const loadCounts = await Order.aggregate([
    { $match: { rider: { $in: riderIds }, riderStatus: { $in: ACTIVE_RIDER_STATUSES }, status: { $nin: ['delivered', 'cancelled'] } } },
    { $group: { _id: '$rider', activeCount: { $sum: 1 } } },
  ]);
  const loadMap = new Map(loadCounts.map(x => [String(x._id), x.activeCount]));
  const rankPool = pool => pool.map(r => {
    const coords = r.riderDetails?.currentLocation?.coordinates;
    return { rider: r, distanceKm: validCoords(coords) ? haversineKm(coords, restaurantCoords) : Infinity, activeCount: loadMap.get(String(r._id)) || 0 };
  }).filter(x => Number.isFinite(x.distanceKm) && x.activeCount < maxPerRider)
    .sort((a,b) => a.distanceKm - b.distanceKm || a.activeCount - b.activeCount || String(a.rider._id).localeCompare(String(b.rider._id)));
  // Prefer same-zone riders when they have capacity; if all are busy, safely
  // fall back to the wider eligible pool rather than leaving a job unassigned.
  let ranked = rankPool(sameZone);
  let zoneMatched = ranked.length > 0;
  if (!ranked.length) { ranked = rankPool(cashEligible); zoneMatched = false; }
  if (!ranked.length) return { rider: null, zoneMatched: false, reason: 'No rider has fresh valid coordinates and capacity for another delivery.' };
  return { rider: ranked[0].rider, zoneMatched, distanceKm: Number(ranked[0].distanceKm.toFixed(2)) };
}

async function autoAssignRider(order, excludeRiderIds = []) {
  try {
    if (order.rider) return { assigned: false, rider: null, reason: 'Order already has a rider assigned.' };
    if (order.deliveryModeSnapshot === 'self_delivery') return { assigned: false, rider: null, reason: 'Restaurant uses self-delivery.' };
    if (!DISPATCHABLE_ORDER_STATUSES.includes(order.status)) return { assigned: false, rider: null, reason: `Order status ${order.status} is not eligible for dispatch.` };
    // Do not offer a rider before the persisted preparation-aware dispatch time.
    // An early-ready action can make this timestamp due immediately.
    if (order.dispatchNotBefore && new Date(order.dispatchNotBefore).getTime() > Date.now()) {
      return { assigned: false, rider: null, scheduled: true, dispatchNotBefore: order.dispatchNotBefore, reason: 'Rider dispatch is scheduled closer to the estimated food-ready time.' };
    }

    const { rider, zoneMatched, distanceKm, reason } = await findBestAvailableRider(order, excludeRiderIds, { paymentMethod: order.paymentMethod });
    const now = new Date();
    if (!rider) {
      await Order.updateOne({ _id: order._id, rider: null, status: { $in: DISPATCHABLE_ORDER_STATUSES } }, {
        $set: { dispatchStatus: 'no_rider', dispatchLastAttemptAt: now }, $inc: { dispatchAttemptCount: 1 },
      });
      order.dispatchStatus = 'no_rider'; order.dispatchLastAttemptAt = now;
      return { assigned: false, rider: null, reason: reason || 'No eligible rider is available.' };
    }

    const baseRiderFee = Number(order.deliveryFee) || 0;
    const riderTip = Number(order.tipAmount) || 0;
    const note = `Auto-dispatched to ${rider.name}; pickup ${distanceKm} km${zoneMatched ? ', same zone' : ', cross-zone fallback'}.`;
    // This conditional write is the claim: only one concurrent dispatcher can win.
    const claimed = await Order.findOneAndUpdate(
      { _id: order._id, rider: null, status: { $in: DISPATCHABLE_ORDER_STATUSES }, deliveryModeSnapshot: { $ne: 'self_delivery' } },
      { $set: { rider: rider._id, riderAssignedAt: now, riderStatus: 'assigned', riderEarning: Number(order.riderEarning) || (baseRiderFee + riderTip), dispatchStatus: 'assigned', dispatchStartedAt: order.dispatchStartedAt || now, dispatchLastAttemptAt: now },
        $inc: { dispatchAttemptCount: 1 },
        $push: { riderStatusHistory: { status: 'assigned', note, at: now, riderId: rider._id } } },
      { new: true }
    );
    if (!claimed) return { assigned: false, rider: null, reason: 'Order was claimed or changed by another request.' };

    // Dynamic pricing engine: guarantee the rider the projected payout BEFORE
    // the offer is accepted. No-op on a legacy (non-engine) order.
    try {
      const { ensureGuaranteedPayout } = require('./pricing/riderPayoutIntegration');
      const guarantee = await ensureGuaranteedPayout(claimed, rider);
      if (guarantee) {
        claimed.riderEarning = guarantee.guaranteedPayoutRupees;
        claimed.riderGuaranteedPayout = guarantee;
      }
    } catch (guaranteeErr) {
      console.error('[dispatch] guaranteed payout failed:', guaranteeErr.message);
    }

    // Keep the caller's document aligned with the authoritative atomic claim.
    order.rider = claimed.rider; order.riderAssignedAt = claimed.riderAssignedAt;
    order.riderStatus = claimed.riderStatus; order.riderEarning = claimed.riderEarning;
    order.dispatchStatus = claimed.dispatchStatus; order.dispatchStartedAt = claimed.dispatchStartedAt;
    order.dispatchLastAttemptAt = claimed.dispatchLastAttemptAt; order.dispatchAttemptCount = claimed.dispatchAttemptCount;
    order.riderStatusHistory = claimed.riderStatusHistory;
    notifyRiderAssignment(claimed, rider).catch(() => {});
    return { assigned: true, rider: { _id: rider._id, name: rider.name }, distanceKm, reason: zoneMatched ? 'Assigned to nearest eligible rider in the delivery zone.' : 'Assigned to nearest eligible rider in the wider pool.' };
  } catch (err) {
    return { assigned: false, rider: null, reason: `Auto-assignment failed: ${err.message}` };
  }
}

async function handleReassignment(orderId, oldRiderId, reasonNote) {
  const lockedOrder = await Order.findOneAndUpdate(
    { _id: orderId, rider: oldRiderId, riderStatus: { $nin: ['picked_up', 'out_for_delivery', 'delivered'] }, status: { $nin: ['delivered', 'cancelled'] } },
    { $unset: { rider: 1, riderAssignedAt: 1, riderEarning: 1 },
      $set: { riderStatus: 'unassigned', dispatchStatus: 'searching' },
      $push: { riderStatusHistory: { status: 'unassigned', note: reasonNote, at: new Date(), riderId: oldRiderId } } },
    { new: true }
  );
  if (!lockedOrder) return { assigned: false, reason: 'Order state changed concurrently or is past reassignment stage.' };
  const excludedIds = lockedOrder.riderStatusHistory.filter(h => h.status === 'unassigned' && h.riderId).map(h => String(h.riderId));
  excludedIds.push(String(oldRiderId));
  const assignment = await autoAssignRider(lockedOrder, excludedIds);
  if (assignment.assigned) { await lockedOrder.save(); scheduleRiderTimeout(lockedOrder._id, lockedOrder.rider); }
  return assignment;
}
function scheduleRiderTimeout(orderId, riderId) {
  const timeoutMs = ACCEPT_TIMEOUT_MS;
  const timer = setTimeout(async () => {
    try {
      const order = await Order.findById(orderId);
      if (order && order.rider && String(order.rider) === String(riderId) && order.riderStatus === 'assigned') {
        await handleReassignment(orderId, riderId, `Auto-released: rider did not accept within ${Math.round(timeoutMs/1000)} seconds.`);
      }
    } catch (err) { console.error('Timeout reassignment failed:', err); }
  }, timeoutMs);
  if (timer.unref) timer.unref();
}
async function recoverStuckAssignments() {
  const cutoff = new Date(Date.now() - ACCEPT_TIMEOUT_MS);
  let stuck = [];
  try { stuck = await Order.find({ riderStatus: 'assigned', riderAssignedAt: { $lte: cutoff }, status: { $nin: ['delivered','cancelled'] } }).select('_id rider').lean(); }
  catch (err) { console.error('[assignment-recovery] scan failed:', err.message); return { scanned: 0, reassigned: 0 }; }
  let reassigned = 0;
  for (const order of stuck) {
    if (!order.rider) continue;
    try { const r = await handleReassignment(order._id, order.rider, 'Auto-released on recovery sweep: rider did not accept in time.'); if (r?.assigned) reassigned++; }
    catch (err) { console.error(`[assignment-recovery] order ${order._id} failed:`, err.message); }
  }
  return { scanned: stuck.length, reassigned };
}
async function recoverUnassignedOrders() {
  const retryCutoff = new Date(Date.now() - Math.max(30_000, Number(process.env.RIDER_DISPATCH_RETRY_MS) || 60_000));
  let candidates = [];
  try {
    candidates = await Order.find({ rider: null, status: { $in: DISPATCHABLE_ORDER_STATUSES }, deliveryModeSnapshot: { $ne: 'self_delivery' }, dispatchStatus: { $in: ['not_started', 'searching', 'no_rider'] }, $and: [ { $or: [{ dispatchNotBefore: null }, { dispatchNotBefore: { $lte: new Date() } }] }, { $or: [{ dispatchLastAttemptAt: null }, { dispatchLastAttemptAt: { $lte: retryCutoff } }] } ] }).sort({ createdAt: 1 }).limit(50).lean();
  } catch (err) { console.error('[dispatch-recovery] scan failed:', err.message); return { scanned: 0, assigned: 0 }; }
  let assigned = 0;
  for (const candidate of candidates) {
    try {
      const now = new Date();
      const lock = await Order.updateOne({ _id: candidate._id, rider: null, $and: [ { $or: [{ dispatchNotBefore: null }, { dispatchNotBefore: { $lte: now } }] }, { $or: [{ dispatchLastAttemptAt: null }, { dispatchLastAttemptAt: { $lte: retryCutoff } }] } ] }, { $set: { dispatchLastAttemptAt: now, dispatchStatus: 'searching' } });
      if (!lock.modifiedCount) continue;
      const order = await Order.findById(candidate._id);
      if (!order || order.rider) continue;
      const result = await autoAssignRider(order);
      if (result.assigned) { assigned++; scheduleRiderTimeout(order._id, order.rider); }
    } catch (err) { console.error(`[dispatch-recovery] order ${candidate._id} failed:`, err.message); }
  }
  return { scanned: candidates.length, assigned };
}
let recoveryTimer = null;
function startAssignmentRecovery(intervalMs = 60 * 1000) {
  recoverStuckAssignments().catch(() => {});
  recoverUnassignedOrders().catch(() => {});
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = setInterval(() => { recoverStuckAssignments().catch(() => {}); recoverUnassignedOrders().catch(() => {}); }, intervalMs);
  if (recoveryTimer.unref) recoveryTimer.unref();
  return recoveryTimer;
}
/**
 * Pillar 1 — live delivery capacity snapshot for a zone.
 *
 * `onlineRiders` counts active riders with a fresh GPS fix in the zone (or
 * platform-wide when no zone resolves). `activeOrders` counts orders those
 * riders are currently carrying. Used by the checkout shortage circuit
 * breaker; also exposed to the Admin dashboard.
 */
async function getZoneDeliveryCapacity(zone = '') {
  const cutoff = new Date(Date.now() - LOCATION_MAX_AGE_MS);
  const normalized = normalizeZone(zone);
  const riderQuery = {
    role: 'rider', isActive: true,
    'riderDetails.isOnline': true,
    'riderDetails.currentLocation.updatedAt': { $gte: cutoff },
  };
  if (normalized) riderQuery['riderDetails.deliveryZone'] = { $regex: `^${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' };

  let onlineRiders = 0;
  let activeOrders = 0;
  try {
    const riders = await User.find(riderQuery).select('_id').lean();
    onlineRiders = riders.length;
    if (onlineRiders) {
      activeOrders = await Order.countDocuments({
        rider: { $in: riders.map(r => r._id) },
        riderStatus: { $in: ACTIVE_RIDER_STATUSES },
        status: { $nin: ['delivered', 'cancelled'] },
      });
    }
  } catch (err) {
    console.error('[capacity] snapshot failed:', err.message);
  }
  const ratio = onlineRiders > 0 ? activeOrders / onlineRiders : Infinity;
  return { zone: normalized, onlineRiders, activeOrders, activeOrdersPerRider: onlineRiders ? Number(ratio.toFixed(2)) : null };
}

module.exports = { autoAssignRider, findBestAvailableRider, resolveOrderZone, handleReassignment, scheduleRiderTimeout, recoverStuckAssignments, recoverUnassignedOrders, startAssignmentRecovery, getZoneDeliveryCapacity, haversineKm, resolveMaxActiveOrdersPerRider, MAX_ACTIVE_ORDERS_PER_RIDER, ACTIVE_RIDER_STATUSES };
