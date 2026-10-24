'use strict';

const Order = require('../models/Order');
const { fetchOrderPayments } = require('./paymentService');
const { releaseOrderInventory } = require('./inventoryReservationService');
const { notifyOrderStatus } = require('./notificationService');

/**
 * Expire abandoned online (UPI / card / wallet) checkouts.
 *
 * Why: an online order is created `placed` / `pending` and its stock is reserved
 * at checkout, but the restaurant is only told (and the 5-minute response
 * deadline only starts) once the money is captured. A customer who closes the
 * UPI app never triggers any further event, so nothing ever cancelled the order
 * and the reserved stock stayed locked forever.
 *
 * Safety rules (money first):
 *  1. Never cancel while a captured payment could exist. Before cancelling we ask
 *     Razorpay about the checkout's current AND previous Razorpay order ids. A late
 *     capture is settled through markCheckoutPaid (the normal paid path).
 *  2. If Razorpay cannot be reached, or shows a captured payment with an
 *     unexpected amount, the order is left alone and retried / reviewed later.
 *  3. The cancel itself is one atomic conditional update, so overlapping sweeps,
 *     a webhook, or a payment being claimed at that moment can never double-act.
 *  4. If money still arrives AFTER the cancel, markCheckoutPaid's cancelled-order
 *     path records and refunds it (see tests/payment-fixes.js L and M).
 *
 * The expiry clock is `updatedAt`, not `createdAt`: retryPayment rewrites the
 * order (new Razorpay order id), which gives the customer a fresh window.
 * Anything that touches the order only ever delays expiry, never hastens it.
 */

const DEFAULT_EXPIRY_MINUTES = 15;
const MAX_PER_SWEEP = 50;
const EXPIRY_REASON = 'Payment not completed in time';

function expiryMs() {
  const minutes = Number(process.env.UNPAID_CHECKOUT_EXPIRY_MINUTES);
  return (Number.isFinite(minutes) && minutes >= 5 ? minutes : DEFAULT_EXPIRY_MINUTES) * 60 * 1000;
}

const razorpayIdsOf = (order) => [...new Set([order.razorpayOrderId, ...(order.razorpayOrderIdHistory || [])].filter(Boolean).map(String))];

// Warn once per process about a capture we refuse to guess about, so a stuck
// order does not spam the log every sweep.
const warnedMismatch = new Set();

/**
 * Has any Razorpay order of this checkout actually been paid?
 * Returns 'paid' (checkout settled), 'none' (safe to cancel) or 'hold'
 * (cannot be sure: do not cancel). Throws are caught and turned into 'hold'.
 */
async function settleLateCapture(order) {
  const ids = razorpayIdsOf(order);
  for (const razorpayOrderId of ids) {
    let attempts;
    try { attempts = await fetchOrderPayments(razorpayOrderId); }
    catch (err) {
      console.warn(`[abandoned-checkout] Razorpay lookup failed for ${razorpayOrderId}: ${err.message}`);
      return 'hold';
    }
    const captured = attempts.find(p => p.status === 'captured');
    if (!captured) continue;

    // Same amount rule as the webhook: the sum of every order in this Razorpay order.
    const group = await Order.find({ $or: [{ razorpayOrderId }, { razorpayOrderIdHistory: razorpayOrderId }] }).sort({ createdAt: 1 });
    const expected = Math.round(group.reduce((sum, o) => sum + Number(o.total || 0), 0) * 100);
    if (Number(captured.amount) !== expected || String(captured.currency || '') !== 'INR') {
      if (!warnedMismatch.has(captured.id)) {
        warnedMismatch.add(captured.id);
        console.error(`[abandoned-checkout] payment ${captured.id} on ${razorpayOrderId} was captured with an unexpected amount/currency; order ${order._id} NOT cancelled, needs manual review`);
      }
      return 'hold';
    }
    // Lazy require: the controller pulls in most of the app and itself uses services.
    const { markCheckoutPaid } = require('../controllers/paymentController');
    await markCheckoutPaid(group, captured.id, captured.amount);
    return 'paid';
  }
  return 'none';
}

/**
 * Expire one abandoned order. Returns 'cancelled', 'paid' (a late capture was
 * settled instead), 'hold' (left alone on purpose) or 'none' (not eligible any more).
 */
async function expireAbandonedCheckout(orderId) {
  const cutoff = new Date(Date.now() - expiryMs());
  const eligible = {
    _id: orderId,
    status: 'placed',
    paymentStatus: 'pending',
    paymentMethod: { $ne: 'cod' },
    updatedAt: { $lte: cutoff },
  };
  const order = await Order.findOne(eligible).select('_id user total razorpayOrderId razorpayOrderIdHistory').lean();
  if (!order) return 'none';

  const verdict = await settleLateCapture(order);
  if (verdict === 'paid') return 'paid';
  if (verdict === 'hold') return 'hold';

  const expired = await Order.findOneAndUpdate(
    {
      ...eligible,
      // A payment that is being claimed this very moment wins over the sweeper.
      $or: [{ paymentClaimId: { $exists: false } }, { paymentClaimId: null }, { paymentClaimId: '' }],
    },
    {
      $set: {
        status: 'cancelled',
        paymentStatus: 'failed',
        cancelReason: EXPIRY_REASON,
        isCancellable: false,
      },
      $inc: { __v: 1 },
      $push: { statusHistory: { status: 'cancelled', note: 'Automatically cancelled: online payment was not completed in time', at: new Date() } },
    },
    { new: true },
  );
  if (!expired) return 'none';

  await releaseOrderInventory(expired, expired.user).catch((err) => console.error(`[abandoned-checkout] stock release failed for ${expired._id}:`, err.message));
  await Promise.resolve(notifyOrderStatus(expired.user, expired)).catch(() => {});
  return 'cancelled';
}

let sweeping = false;
async function recoverAbandonedCheckouts() {
  const result = { scanned: 0, cancelled: 0, paid: 0, held: 0 };
  if (sweeping) return result;
  sweeping = true;
  try {
    const cutoff = new Date(Date.now() - expiryMs());
    let stale = [];
    try {
      stale = await Order.find({
        status: 'placed',
        paymentStatus: 'pending',
        paymentMethod: { $ne: 'cod' },
        updatedAt: { $lte: cutoff },
      }).select('_id updatedAt').sort({ updatedAt: 1 }).lean();
    } catch (err) {
      console.error('[abandoned-checkout] scan failed:', err.message);
      return result;
    }
    stale = stale.slice(0, MAX_PER_SWEEP);
    result.scanned = stale.length;
    for (const { _id } of stale) {
      try {
        const outcome = await expireAbandonedCheckout(_id);
        if (outcome === 'cancelled') result.cancelled += 1;
        else if (outcome === 'paid') result.paid += 1;
        else if (outcome === 'hold') result.held += 1;
      } catch (err) {
        console.error(`[abandoned-checkout] order ${_id} failed:`, err.message);
      }
    }
    return result;
  } finally {
    sweeping = false;
  }
}

let recoveryTimer = null;
function startAbandonedCheckoutRecovery(intervalMs = 60 * 1000) {
  recoverAbandonedCheckouts().catch(() => {});
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = setInterval(() => { recoverAbandonedCheckouts().catch(() => {}); }, intervalMs);
  if (recoveryTimer.unref) recoveryTimer.unref();
  return recoveryTimer;
}

module.exports = { expireAbandonedCheckout, recoverAbandonedCheckouts, startAbandonedCheckoutRecovery, EXPIRY_REASON };
