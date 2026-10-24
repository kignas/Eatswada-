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
 * The same sweep also expires a partial-COD order whose ADVANCE was never paid: it
 * sits `placed` with stock reserved and the restaurant is never told (the handoff only
 * happens after the advance is captured), so nothing else would ever free it. A late
 * advance capture is settled through markPartialCodAdvancePaid; if money turns up after
 * the cancel, the order is marked refund-eligible so the refund path returns it.
 *
 * A single failed payment attempt does NOT cancel an order any more (see
 * paymentController): this sweeper is the one place an unpaid order is expired.
 *
 * The expiry clock is `updatedAt`, not `createdAt`: retryPayment rewrites the
 * order (new Razorpay order id), which gives the customer a fresh window.
 * Anything that touches the order only ever delays expiry, never hastens it.
 */

const DEFAULT_EXPIRY_MINUTES = 15;
const MAX_PER_SWEEP = 50;
const EXPIRY_REASON = 'Payment not completed in time';
const ADVANCE_EXPIRY_REASON = 'Advance payment not completed in time';

function expiryMs() {
  const minutes = Number(process.env.UNPAID_CHECKOUT_EXPIRY_MINUTES);
  return (Number.isFinite(minutes) && minutes >= 5 ? minutes : DEFAULT_EXPIRY_MINUTES) * 60 * 1000;
}

const razorpayIdsOf = (order) => [...new Set([order.razorpayOrderId, ...(order.razorpayOrderIdHistory || [])].filter(Boolean).map(String))];

// Warn once per process about a capture we refuse to guess about, so a stuck
// order does not spam the log every sweep.
const warnedMismatch = new Set();

// Two kinds of unpaid order are expired here. Each has its own filter (kept separate so
// each stays a plain query): a full online checkout, and a partial-COD advance.
function eligibleFilter(kind, orderId, cutoff) {
  const base = { status: 'placed', updatedAt: { $lte: cutoff }, ...(orderId ? { _id: orderId } : {}) };
  if (kind === 'advance') {
    return { ...base, paymentMethod: 'cod', paymentStatus: 'cod_pending', partialCodAdvanceAmount: { $gt: 0 }, partialCodAdvanceStatus: 'pending' };
  }
  return { ...base, paymentStatus: 'pending', paymentMethod: { $ne: 'cod' } };
}

/**
 * Has any Razorpay order of this checkout actually been paid?
 * Returns 'paid' (checkout settled), 'none' (safe to cancel) or 'hold'
 * (cannot be sure: do not cancel). Throws are caught and turned into 'hold'.
 */
async function settleLateCapture(order, kind) {
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

    // Same amount rule as the webhook: the advance for a partial-COD order, otherwise
    // the sum of every order in this Razorpay order.
    let group = [order];
    let expected;
    if (kind === 'advance') {
      expected = Math.round(Number(order.partialCodAdvanceAmount || 0) * 100);
    } else {
      group = await Order.find({ $or: [{ razorpayOrderId }, { razorpayOrderIdHistory: razorpayOrderId }] }).sort({ createdAt: 1 });
      expected = Math.round(group.reduce((sum, o) => sum + Number(o.total || 0), 0) * 100);
    }
    if (Number(captured.amount) !== expected || String(captured.currency || '') !== 'INR') {
      if (!warnedMismatch.has(captured.id)) {
        warnedMismatch.add(captured.id);
        console.error(`[abandoned-checkout] payment ${captured.id} on ${razorpayOrderId} was captured with an unexpected amount/currency; order ${order._id} NOT cancelled, needs manual review`);
      }
      return 'hold';
    }
    // Lazy require: the controller pulls in most of the app and itself uses services.
    const pc = require('../controllers/paymentController');
    if (kind === 'advance') {
      const result = await pc.markPartialCodAdvancePaid(order, captured.id);
      // Anything but a clean "advance paid" (duplicate, already cancelled...) needs a human.
      return result && result.paid ? 'paid' : 'hold';
    }
    await pc.markCheckoutPaid(group, captured.id, captured.amount);
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
  const select = '_id user total paymentMethod partialCodAdvanceAmount razorpayOrderId razorpayOrderIdHistory';
  let kind = 'online';
  let eligible = eligibleFilter('online', orderId, cutoff);
  let order = await Order.findOne(eligible).select(select).lean();
  if (!order) {
    kind = 'advance';
    eligible = eligibleFilter('advance', orderId, cutoff);
    order = await Order.findOne(eligible).select(select).lean();
  }
  if (!order) return 'none';

  const verdict = await settleLateCapture(order, kind);
  if (verdict === 'paid') return 'paid';
  if (verdict === 'hold') return 'hold';

  const update = kind === 'advance'
    ? {
      $set: {
        status: 'cancelled',
        cancelReason: ADVANCE_EXPIRY_REASON,
        isCancellable: false,
        // Nobody is at fault for money that never came, but if a late advance capture
        // lands after this cancel it must be refunded, not kept (see markPartialCodAdvancePaid).
        partialCodRefundEligible: true,
      },
      $inc: { __v: 1 },
      $push: { statusHistory: { status: 'cancelled', note: 'Automatically cancelled: the COD advance was not paid in time', at: new Date() } },
    }
    : {
      $set: {
        status: 'cancelled',
        paymentStatus: 'failed',
        cancelReason: EXPIRY_REASON,
        isCancellable: false,
      },
      $inc: { __v: 1 },
      $push: { statusHistory: { status: 'cancelled', note: 'Automatically cancelled: online payment was not completed in time', at: new Date() } },
    };
  const expired = await Order.findOneAndUpdate(
    kind === 'advance'
      // The advance status is re-checked atomically: an advance captured this very moment wins.
      ? eligible
      // A payment that is being claimed this very moment wins over the sweeper.
      : { ...eligible, $or: [{ paymentClaimId: { $exists: false } }, { paymentClaimId: null }, { paymentClaimId: '' }] },
    update,
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
      for (const kind of ['online', 'advance']) {
        const rows = await Order.find(eligibleFilter(kind, null, cutoff)).select('_id updatedAt').sort({ updatedAt: 1 }).lean();
        stale.push(...rows);
      }
      stale.sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
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

module.exports = { expireAbandonedCheckout, recoverAbandonedCheckouts, startAbandonedCheckoutRecovery, EXPIRY_REASON, ADVANCE_EXPIRY_REASON };
