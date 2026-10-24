'use strict';

const Order = require('../models/Order');
const User = require('../models/User');
const { notifyRiderAssignment } = require('./notificationService');
const { ACTIVE_RIDER_STATUSES, resolveMaxActiveOrdersPerRider } = require('./riderAssignmentService');

/**
 * Admin "assign rider".
 *
 * The admin picks WHICH rider; the order and rider still have to be fit for the job, with
 * the same rules automatic dispatch uses:
 *   order  - accepted by the restaurant and not yet with a rider who has the food, paid
 *            (online payment, or the COD advance), and not a restaurant self-delivery order
 *   rider  - active, online, below the live active-order cap (platform setting), and
 *            under their COD cash limit for a cash order
 *   write  - ONE conditional update (the claim), so a concurrent auto-dispatch, rider
 *            action, cancellation or second admin can never be overwritten.
 *
 * Returns { ok: true, order, alreadyAssigned? } or { ok: false, status, code, message }.
 */

// Statuses a rider may be put on. 'assigned' = a rider accepted but has not picked up yet.
const ASSIGNABLE_ORDER_STATUSES = ['confirmed', 'preparing', 'waiting_for_rider', 'assigned'];
// Once a rider has reached the restaurant / holds the food the job cannot be moved.
const LOCKED_RIDER_STATUSES = ['reached_restaurant', 'picked_up', 'out_for_delivery', 'delivered'];

const refuse = (status, code, message) => ({ ok: false, status, code, message });

async function assignRiderByAdmin({ orderId, riderId, adminName = 'admin' }) {
  const order = await Order.findById(orderId);
  if (!order) return refuse(404, 'ORDER_NOT_FOUND', 'Order not found');

  // Snapshot what we validated against; the claim below only succeeds if it is still true.
  const snap = {
    status: order.status,
    rider: order.rider || null,
    riderStatus: order.riderStatus,
    riderEarning: order.riderEarning,
    dispatchStartedAt: order.dispatchStartedAt,
    deliveryFee: Number(order.deliveryFee) || 0,
    tipAmount: Number(order.tipAmount) || 0,
    isCod: String(order.paymentMethod || '').toLowerCase() === 'cod',
    advance: Number(order.partialCodAdvanceAmount || 0),
    advanceStatus: order.partialCodAdvanceStatus,
    paymentStatus: order.paymentStatus,
    selfDelivery: order.deliveryModeSnapshot === 'self_delivery',
    _id: order._id,
  };

  if (['delivered', 'cancelled'].includes(snap.status)) {
    return refuse(409, 'ORDER_NOT_DISPATCHABLE', `Cannot assign a rider — order is already ${snap.status}.`);
  }
  if (!ASSIGNABLE_ORDER_STATUSES.includes(snap.status)) {
    return refuse(409, 'ORDER_NOT_DISPATCHABLE', snap.status === 'placed'
      ? 'The restaurant has not accepted this order yet, so a rider cannot be assigned.'
      : `Cannot assign a rider while the order is "${snap.status}".`);
  }
  if (snap.selfDelivery) {
    return refuse(409, 'ORDER_SELF_DELIVERY', 'This restaurant delivers its own orders; a platform rider cannot be assigned.');
  }
  const unpaid = snap.isCod
    ? snap.advance > 0 && snap.advanceStatus !== 'paid'
    : snap.paymentStatus !== 'paid';
  if (unpaid) {
    return refuse(409, 'ORDER_NOT_PAID', 'This order is not paid yet, so a rider cannot be assigned.');
  }
  if (snap.rider && LOCKED_RIDER_STATUSES.includes(snap.riderStatus)) {
    return refuse(409, 'ORDER_IN_DELIVERY', 'Cannot reassign — this order is already being delivered by a rider.');
  }

  const rider = await User.findOne({ _id: riderId, role: 'rider' }).select('_id name isActive riderDetails');
  if (!rider) return refuse(404, 'RIDER_NOT_FOUND', 'Rider not found');
  if (!rider.isActive) return refuse(409, 'RIDER_DISABLED', 'This rider is disabled and cannot be assigned.');

  if (snap.rider && String(snap.rider) === String(rider._id) && snap.riderStatus !== 'unassigned') {
    return { ok: true, alreadyAssigned: true, order };
  }

  if (!rider.riderDetails?.isOnline) {
    return refuse(409, 'RIDER_OFFLINE', 'This rider is offline and cannot take a delivery right now.');
  }
  // This order never counts against the rider here: if it already counted for them, the
  // same-rider no-op above would have returned.
  const maxActive = await resolveMaxActiveOrdersPerRider();
  const activeJobs = await Order.countDocuments({
    rider: rider._id,
    riderStatus: { $in: ACTIVE_RIDER_STATUSES },
    status: { $nin: ['delivered', 'cancelled'] },
  });
  if (activeJobs >= maxActive) {
    return refuse(409, 'RIDER_AT_CAPACITY', `This rider already has ${activeJobs} active deliveries (limit ${maxActive}).`);
  }
  if (snap.isCod && Number(rider.riderDetails?.cashInHand || 0) >= Number(rider.riderDetails?.codCashLimit ?? Infinity)) {
    return refuse(409, 'RIDER_CASH_LIMIT', 'This rider is at their cash-on-delivery limit. Collect their cash before giving them another COD order.');
  }

  const now = new Date();
  const claimed = await Order.findOneAndUpdate(
    {
      _id: snap._id,
      status: { $in: ASSIGNABLE_ORDER_STATUSES },
      rider: snap.rider, // exactly the rider we saw (null when unassigned): no overwriting a concurrent claim
      riderStatus: { $nin: LOCKED_RIDER_STATUSES },
    },
    {
      $set: {
        rider: rider._id,
        riderAssignedAt: now,
        riderStatus: 'assigned',
        dispatchStatus: 'assigned',
        dispatchStartedAt: snap.dispatchStartedAt || now,
        // Tip belongs to the rider. Set the earning once so reassignment cannot double-count it.
        riderEarning: Number(snap.riderEarning) || (snap.deliveryFee + snap.tipAmount),
      },
      $inc: { __v: 1 },
      $push: { riderStatusHistory: { status: 'assigned', note: `Assigned to ${rider.name} by ${adminName}`, at: now, riderId: rider._id } },
    },
    { new: true },
  );
  if (!claimed) {
    return refuse(409, 'ORDER_CHANGED', 'This order was just changed (cancelled, or already assigned by someone else). Please refresh and try again.');
  }

  // Tell the rider. A push failure must never undo a successful assignment.
  try { await notifyRiderAssignment(claimed, rider); } catch (_) { /* best effort */ }
  return { ok: true, order: claimed };
}

module.exports = { assignRiderByAdmin, ASSIGNABLE_ORDER_STATUSES, LOCKED_RIDER_STATUSES };
