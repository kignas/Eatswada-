const { refundPayment } = require('./paymentService');

/**
 * Initiate a Razorpay refund for a cancelled order and record the refund
 * lifecycle on the order document.
 *
 * Design notes:
 *  - MUTATES `order` in place but does NOT save — the caller persists it as part
 *    of its own save, so cancellation and refund state are written atomically.
 *  - Safe to call unconditionally on any cancelled order: it no-ops for COD,
 *    unpaid, or already-refunding orders, so it can never double-refund.
 *  - NEVER throws. If the Razorpay call fails, the order is still cancelled and
 *    the refund is marked 'failed' (with the reason) for manual follow-up —
 *    a payment hiccup must not block the customer's/vendor's cancellation.
 *  - Sets status to 'processing'; the refund.processed / refund.failed webhook
 *    flips it to 'completed'/'failed'. If Razorpay reports 'processed'
 *    synchronously (common for instant refunds/test mode), it's marked
 *    'completed' right away and the webhook is idempotent on top of that.
 *
 * Returns a small result object for logging/response; the source of truth is
 * the mutated order.refund.
 */
async function initiateOrderRefund(order, reason = '') {
  if (!order) return { refunded: false, skipped: 'no_order' };
  if (order.paymentMethod === 'cod') return { refunded: false, skipped: 'cod' };
  if (order.paymentStatus !== 'paid') return { refunded: false, skipped: 'not_paid' };
  if (!order.razorpayPaymentId) return { refunded: false, skipped: 'no_payment_id' };
  if (order.refund && order.refund.status && order.refund.status !== 'none') {
    return { refunded: false, skipped: 'already_started', status: order.refund.status };
  }

  const cleanReason = String(reason || '').slice(0, 200);

  try {
    const refund = await refundPayment(order.razorpayPaymentId, order.total, {
      orderId: String(order._id),
      reason: cleanReason,
    });

    order.refund = {
      status: 'processing',
      amount: Number(order.total || 0),
      razorpayRefundId: String((refund && refund.id) || ''),
      reason: cleanReason,
      initiatedAt: new Date(),
      completedAt: null,
    };

    // Instant/test-mode refunds come back already processed — reflect that now.
    if (refund && refund.status === 'processed') {
      order.refund.status = 'completed';
      order.refund.completedAt = new Date();
      order.paymentStatus = 'refunded';
    }

    return { refunded: true, status: order.refund.status, refundId: order.refund.razorpayRefundId };
  } catch (err) {
    // Cancellation still succeeds; surface the refund for manual handling.
    order.refund = {
      status: 'failed',
      amount: Number(order.total || 0),
      razorpayRefundId: '',
      reason: `refund initiation failed: ${err && err.message ? err.message : 'unknown error'}`.slice(0, 200),
      initiatedAt: new Date(),
      completedAt: null,
    };
    return { refunded: false, error: err && err.message ? err.message : 'unknown error' };
  }
}

module.exports = { initiateOrderRefund };
