'use strict';

const { releaseOrderInventory } = require('./inventoryReservationService');
const { initiateOrderRefund } = require('./refundService');
const { notifyOrderStatus } = require('./notificationService');
const { stopRing } = require('./pushService');

/**
 * Cancel an order on behalf of staff (admin / ops) with every side effect.
 *
 * Why this exists: setting status = 'cancelled' alone is NOT a cancellation.
 * A paid order also needs its stock released, its money refunded, the
 * restaurant's ringing alert stopped and the customer told. Several admin/legacy
 * endpoints used to flip the status only (money kept, stock locked). Every
 * staff-initiated cancel now goes through here.
 *
 * Order of operations matters and mirrors the customer cancel flow:
 *   1. persist the cancellation FIRST. `Order` uses optimisticConcurrency, so if
 *      the restaurant/rider changed the order a moment earlier this save throws
 *      VersionError (409) and NO refund is sent for an order that is going ahead.
 *   2. release reserved stock (idempotent claim),
 *   3. refund (atomic claim; the refund service saves its own result),
 *   4. stop the vendor ring and notify the customer (best effort).
 *
 * Staff/restaurant-initiated cancels are never the customer's fault, so a
 * partial-COD advance that was already captured is marked refundable.
 *
 * Throws a 409 for an order that is already delivered or cancelled.
 */
async function cancelOrderByStaff(order, { reason = '', actorId = null, responsibility = null } = {}) {
  if (!order) throw Object.assign(new Error('Order not found.'), { statusCode: 404 });
  if (['delivered', 'cancelled'].includes(order.status)) {
    throw Object.assign(new Error(`Cannot cancel an order that is already ${order.status}.`), { statusCode: 409 });
  }

  const why = String(reason || '').trim().slice(0, 200) || 'Cancelled by admin';
  order.advanceStatus('cancelled', why);
  order.cancelReason = why;
  if (responsibility) order.cancellationResponsibility = responsibility;
  if (Number(order.partialCodAdvanceAmount || 0) > 0) order.partialCodRefundEligible = true;

  await order.save();
  await releaseOrderInventory(order, actorId);
  await initiateOrderRefund(order, why);
  await Promise.resolve(stopRing(order._id)).catch(() => {});
  await Promise.resolve(notifyOrderStatus(order.user, order)).catch(() => {});
  return order;
}

module.exports = { cancelOrderByStaff };
