const Order = require('../models/Order');
const { refundPayment } = require('./paymentService');

/**
 * Initiate a Razorpay refund for a CANCELLED, PAID order and record the refund
 * lifecycle on the order document.
 *
 * Launch-fix (double-refund race):
 *  - The refund is CLAIMED atomically in MongoDB before Razorpay is called.
 *    Only one request can move refund.status from 'none' to 'processing', so a
 *    customer cancel + vendor reject + admin cancel arriving together (or a
 *    payment webhook + /payments/verify racing) can never send two refunds.
 *  - The claim also requires status === 'cancelled' IN THE DATABASE. Callers
 *    must therefore save the cancellation FIRST and refund SECOND. If the
 *    cancellation lost a race (e.g. the vendor accepted a moment earlier and
 *    the save threw VersionError), no refund is ever sent.
 *  - This function persists the refund result itself. Callers must NOT save
 *    the document again afterwards (a later save could overwrite a
 *    refund.processed webhook that arrived in between).
 *  - The in-memory `order` is updated so the caller's response shows the
 *    refund state.
 *  - NEVER throws. If Razorpay fails, refund.status becomes 'failed' with the
 *    reason, for manual follow-up in the admin panel.
 */
const CLAIMABLE_REFUND_STATE = [
  { 'refund.status': { $exists: false } },
  { 'refund.status': null },
  { 'refund.status': 'none' },
];

function syncInMemory(order, fresh) {
  if (!order || !fresh) return;
  try {
    order.set('refund', fresh.refund ? (fresh.refund.toObject ? fresh.refund.toObject() : fresh.refund) : undefined);
    order.set('paymentStatus', fresh.paymentStatus);
  } catch (_) { /* response-only convenience; never fail the request */ }
}

async function initiateOrderRefund(order, reason = '') {
  if (!order) return { refunded: false, skipped: 'no_order' };
  if (order.paymentMethod === 'cod') return { refunded: false, skipped: 'cod' };

  const cleanReason = String(reason || '').slice(0, 200);
  const now = new Date();

  // Atomic claim — the single gate that makes double refunds impossible.
  const claimed = await Order.findOneAndUpdate(
    {
      _id: order._id,
      status: 'cancelled',
      paymentStatus: 'paid',
      razorpayPaymentId: { $nin: ['', null] },
      $or: CLAIMABLE_REFUND_STATE,
    },
    {
      $set: {
        'refund.status': 'processing',
        'refund.reason': cleanReason,
        'refund.initiatedAt': now,
        'refund.razorpayRefundId': '',
        'refund.completedAt': null,
      },
    },
    { new: true }
  );

  if (!claimed) {
    const current = await Order.findById(order._id).select('status paymentStatus refund').lean();
    syncInMemory(order, current);
    if (!current) return { refunded: false, skipped: 'no_order' };
    if (current.status !== 'cancelled') return { refunded: false, skipped: 'not_cancelled' };
    if (current.paymentStatus !== 'paid') return { refunded: false, skipped: 'not_paid' };
    return { refunded: false, skipped: 'already_started', status: current.refund?.status };
  }

  // Use the database copy (not the caller's possibly-stale document) for money.
  const amount = Number(claimed.total || 0);
  await Order.updateOne({ _id: claimed._id }, { $set: { 'refund.amount': amount } });

  try {
    const refund = await refundPayment(claimed.razorpayPaymentId, amount, {
      orderId: String(claimed._id),
      reason: cleanReason,
    });

    const set = { 'refund.razorpayRefundId': String((refund && refund.id) || '') };
    // Instant/test-mode refunds come back already processed.
    if (refund && refund.status === 'processed') {
      set['refund.status'] = 'completed';
      set['refund.completedAt'] = new Date();
      set.paymentStatus = 'refunded';
    }
    // Filter on 'processing' so we never downgrade a refund.processed webhook
    // that may already have marked this refund completed.
    await Order.updateOne({ _id: claimed._id, 'refund.status': 'processing' }, { $set: set });

    const fresh = await Order.findById(claimed._id).select('paymentStatus refund').lean();
    syncInMemory(order, fresh);
    return { refunded: true, status: fresh?.refund?.status, refundId: set['refund.razorpayRefundId'] };
  } catch (err) {
    const message = err && (err.error?.description || err.message) ? (err.error?.description || err.message) : 'unknown error';
    await Order.updateOne(
      { _id: claimed._id, 'refund.status': 'processing' },
      { $set: { 'refund.status': 'failed', 'refund.reason': `refund initiation failed: ${message}`.slice(0, 200) } }
    ).catch(() => {});
    const fresh = await Order.findById(claimed._id).select('paymentStatus refund').lean().catch(() => null);
    syncInMemory(order, fresh);
    console.error(`[REFUND] order=${claimed._id} failed: ${message}`);
    return { refunded: false, error: message };
  }
}

/**
 * Refund a payment that should never have been taken — e.g. the customer paid
 * twice for the same checkout (an old Razorpay order captured late after a
 * retry). Refunds the WHOLE payment. Safe to call repeatedly: Razorpay rejects
 * a second full refund of the same payment because it would exceed the
 * captured amount. Records the outcome on every order in the checkout.
 */
async function refundDuplicatePayment(orderIds, paymentId, amountRupees, reason = 'Duplicate payment for an already-paid checkout') {
  const entry = { paymentId: String(paymentId), amount: Number(amountRupees || 0), at: new Date() };
  // Idempotency guard: only one caller records + refunds a given payment id.
  const claim = await Order.updateMany(
    { _id: { $in: orderIds }, 'duplicatePayments.paymentId': { $ne: String(paymentId) } },
    { $push: { duplicatePayments: { ...entry, status: 'processing', refundId: '' } } }
  );
  if (!claim.modifiedCount) return { refunded: false, skipped: 'already_handled' };

  try {
    const refund = await refundPayment(paymentId, amountRupees, { reason: String(reason).slice(0, 200) });
    await Order.updateMany(
      { _id: { $in: orderIds }, 'duplicatePayments.paymentId': String(paymentId) },
      { $set: { 'duplicatePayments.$.status': refund?.status === 'processed' ? 'completed' : 'processing', 'duplicatePayments.$.refundId': String(refund?.id || '') } }
    );
    console.warn(`[PAYMENT] duplicate payment ${paymentId} refunded (${refund?.id || 'pending'})`);
    return { refunded: true, refundId: refund?.id };
  } catch (err) {
    const message = err && (err.error?.description || err.message) ? (err.error?.description || err.message) : 'unknown error';
    await Order.updateMany(
      { _id: { $in: orderIds }, 'duplicatePayments.paymentId': String(paymentId) },
      { $set: { 'duplicatePayments.$.status': 'failed', 'duplicatePayments.$.error': message.slice(0, 200) } }
    ).catch(() => {});
    console.error(`[PAYMENT] duplicate payment ${paymentId} refund FAILED — refund manually in Razorpay: ${message}`);
    return { refunded: false, error: message };
  }
}

module.exports = { initiateOrderRefund, refundDuplicatePayment };
