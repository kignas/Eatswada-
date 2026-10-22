const Order = require('../models/Order');
const Coupon = require('../models/Coupon');
const SettlementLedger = require('../models/SettlementLedger');
const RiderLedger = require('../models/RiderLedger');
const User = require('../models/User');
const { refundPayment, fetchPayment } = require('./paymentService');
const { recordRestaurantPaymentFeeCharge } = require('./settlementService');

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

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
  if (order.paymentMethod === 'cod') {
    // COD orders were paid in cash at the door, so a gateway refund is not the
    // correct instrument. If the rider has already collected the cash
    // (paymentStatus 'cod_collected'), queue a manual COD resolution payout
    // for Admin to action. This records a pending obligation; it does NOT mean
    // the customer has already been paid. Never throws.
    if (order.paymentStatus === 'cod_collected') {
      try {
        await recordCodResolutionPayout(
          order._id,
          Number(order.total || 0),
          String(reason || 'Order cancelled after COD collection').slice(0, 200),
          null
        );
        return { refunded: false, skipped: 'cod_manual_payout_pending' };
      } catch (err) {
        console.error(`[REFUND] COD resolution payout failed for order=${order._id}: ${err.message}`);
        return { refunded: false, skipped: 'cod', error: err.message };
      }
    }
    return { refunded: false, skipped: 'cod' };
  }

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
    // Razorpay's payment entity exposes the actual gateway fee + tax. For a
    // restaurant-caused cancellation, allocate only the portion attributable
    // to this refunded order. This prevents a multi-restaurant checkout from
    // charging one restaurant for another restaurant's payment cost.
    let paymentProcessingCost = 0;
    if (claimed.cancellationResponsibility === 'restaurant') {
      try {
        const payment = await fetchPayment(claimed.razorpayPaymentId);
        const gatewayCostPaise = Math.max(0, Number(payment?.fee || 0) + Number(payment?.tax || 0));
        const capturedPaise = Math.max(0, Number(payment?.amount || 0));
        const refundPaise = Math.max(0, Math.round(amount * 100));
        if (gatewayCostPaise > 0 && capturedPaise > 0 && refundPaise > 0) {
          paymentProcessingCost = Math.round((gatewayCostPaise * Math.min(refundPaise, capturedPaise) / capturedPaise)) / 100;
        }
      } catch (feeErr) {
        console.error(`[REFUND] could not read Razorpay processing cost for order=${claimed._id}: ${feeErr.message}`);
      }
      if (paymentProcessingCost > 0) {
        await recordRestaurantPaymentFeeCharge(claimed, paymentProcessingCost);
      }
      await Order.updateOne({ _id: claimed._id }, {
        $set: {
          'refund.paymentProcessingCost': paymentProcessingCost,
          'refund.restaurantChargeAmount': paymentProcessingCost,
          'refund.restaurantChargeRecordedAt': paymentProcessingCost > 0 ? new Date() : null,
          restaurantChargeAmount: paymentProcessingCost,
          restaurantChargeReason: paymentProcessingCost > 0 ? 'Actual Razorpay payment-processing cost allocated to restaurant-caused cancellation' : '',
        },
      });
    }

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

// ─────────────────────────────────────────────────────────────────────
// Pillar 4 — support-resolution refunds.
//
// initiateOrderRefund() above is deliberately locked to CANCELLED orders
// (cancellation refunds). A support agent refunds a DELIVERED order for a
// missing item / spill / quality problem, which is a different lifecycle, so
// it needs its own atomic claim. Both share the same Razorpay call.
// ─────────────────────────────────────────────────────────────────────

/**
 * Refund (fully or partially) a DELIVERED, prepaid order. Atomically claims
 * `supportRefund.status: none -> processing` so concurrent resolutions can
 * never send two refunds. NEVER throws; returns a result descriptor.
 */
async function initiateSupportRefund(orderId, amountRupees, reason = '', adminId = null) {
  const order = await Order.findById(orderId).select('paymentMethod paymentStatus razorpayPaymentId total supportRefund');
  if (!order) return { refunded: false, skipped: 'no_order' };

  const requested = round2(amountRupees);
  if (requested <= 0) return { refunded: false, skipped: 'invalid_amount' };
  if (order.paymentMethod === 'cod') return { refunded: false, skipped: 'cod' };
  if (order.paymentStatus !== 'paid') return { refunded: false, skipped: 'not_paid' };
  if (!order.razorpayPaymentId) return { refunded: false, skipped: 'no_payment_id' };

  const capped = Math.min(requested, round2(order.total));
  const claimed = await Order.findOneAndUpdate(
    {
      _id: order._id,
      paymentStatus: 'paid',
      $or: [
        { 'supportRefund.status': { $exists: false } },
        { 'supportRefund.status': null },
        { 'supportRefund.status': 'none' },
        { 'supportRefund.status': 'failed' },
      ],
    },
    { $set: {
      'supportRefund.status': 'processing',
      'supportRefund.amount': capped,
      'supportRefund.reason': String(reason || '').slice(0, 200),
      'supportRefund.initiatedBy': adminId,
      'supportRefund.initiatedAt': new Date(),
    } },
    { new: true }
  );
  if (!claimed) return { refunded: false, skipped: 'already_started' };

  try {
    const refund = await refundPayment(claimed.razorpayPaymentId, capped, {
      orderId: String(claimed._id), reason: String(reason || 'Support resolution').slice(0, 200),
    });
    const completed = refund && refund.status === 'processed';
    const set = { 'supportRefund.razorpayRefundId': String((refund && refund.id) || '') };
    if (completed) {
      set['supportRefund.status'] = 'completed';
      set['supportRefund.completedAt'] = new Date();
      // Only a FULL refund flips the order's payment status; a partial refund
      // leaves the order paid (the rest of the bill still stands).
      if (capped >= round2(order.total) - 0.01) set.paymentStatus = 'refunded';
    }
    await Order.updateOne({ _id: claimed._id, 'supportRefund.status': 'processing' }, { $set: set });
    return { refunded: true, status: completed ? 'completed' : 'processing', refundId: set['supportRefund.razorpayRefundId'], amount: capped };
  } catch (err) {
    const message = err?.error?.description || err?.message || 'unknown error';
    await Order.updateOne({ _id: claimed._id, 'supportRefund.status': 'processing' },
      { $set: { 'supportRefund.status': 'failed', 'supportRefund.error': String(message).slice(0, 200) } }).catch(() => {});
    console.error(`[SUPPORT-REFUND] order=${claimed._id} failed: ${message}`);
    return { refunded: false, error: message };
  }
}

/**
 * COD resolution payout. Cash was handed to the rider, so the customer cannot
 * be refunded through a gateway. Instead Admin records a manual payout, which
 * this stores as a pending obligation on the order for Admin follow-up.
 */
async function recordCodResolutionPayout(orderId, amountRupees, reason = '', adminId = null) {
  const order = await Order.findById(orderId).select('paymentMethod paymentStatus total codResolutionPayout');
  if (!order) return { recorded: false, skipped: 'no_order' };
  const amount = round2(amountRupees);
  if (amount <= 0) return { recorded: false, skipped: 'invalid_amount' };
  if (order.paymentMethod !== 'cod') return { recorded: false, skipped: 'not_cod' };
  if (order.paymentStatus !== 'cod_collected') return { recorded: false, skipped: 'cod_not_collected' };
  if (['pending', 'paid'].includes(order.codResolutionPayout?.status)) return { recorded: false, skipped: 'already_recorded' };

  // The Order schema defaults codResolutionPayout.status to 'none', so 'none'
  // must be claimable alongside an absent/null value — otherwise the payout can
  // never be recorded for any real order.
  const claimed = await Order.findOneAndUpdate(
    {
      _id: order._id,
      paymentMethod: 'cod',
      paymentStatus: 'cod_collected',
      $or: [
        { 'codResolutionPayout.status': { $exists: false } },
        { 'codResolutionPayout.status': null },
        { 'codResolutionPayout.status': 'none' },
        { 'codResolutionPayout.status': 'failed' },
      ],
    },
    { $set: { 'codResolutionPayout': { status: 'pending', amount: Math.min(amount, round2(order.total)), reason: String(reason || '').slice(0, 200), recordedBy: adminId, recordedAt: new Date(), payoutReference: '', paidBy: null, paidAt: null } } },
    { new: true }
  );
  if (!claimed) return { recorded: false, skipped: 'already_recorded' };
  return { recorded: true, status: 'pending', amount: Math.min(amount, round2(order.total)), method: 'manual_payout_pending' };
}

/** Issue a platform coupon as a goodwill resolution (works for UPI and COD). */
async function issueResolutionCoupon({ amountRupees, customerId, adminId = null, note = '' }) {
  const value = round2(amountRupees);
  if (value <= 0) return null;
  const code = `SORRY${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000); // 60 days
  const coupon = await Coupon.create({
    code,
    type: 'fixed',
    value,
    maxDiscount: value,
    minSubtotal: 0,
    usageLimit: 1,
    perUserLimit: 1,
    firstOrderOnly: false,
    restaurant: null,
    startsAt: new Date(),
    expiresAt,
    isActive: true,
  });
  return { couponId: coupon._id, code: coupon.code, value, expiresAt, note, issuedBy: adminId, customer: customerId || null };
}

/**
 * Apply a fault-attribution deduction to the responsible party's ledger.
 *  - vendor  : a negative SettlementLedger row against the restaurant
 *  - rider   : a negative RiderLedger adjustment against the rider
 *  - platform: no ledger row (the platform absorbs the cost)
 * Never throws; returns a descriptor describing what was written.
 */
async function applyFaultAttributionDeduction({ orderId, target, amountRupees, reason = '', adminId = null }) {
  const amount = round2(amountRupees);
  const result = { target, amount, ledgerId: null, applied: false };
  if (!['vendor', 'rider', 'platform'].includes(target)) return { ...result, error: 'invalid_target' };
  if (target === 'platform') return { ...result, applied: true, note: 'Absorbed by platform' };
  if (amount <= 0) return result;

  const order = await Order.findById(orderId).select('restaurant rider orderNumber').lean();
  if (!order) return { ...result, error: 'no_order' };

  try {
    if (target === 'vendor') {
      if (!order.restaurant) return { ...result, error: 'no_restaurant' };
      const Restaurant = require('../models/Restaurant');
      const restaurant = await Restaurant.findById(order.restaurant).select('owner').lean();
      if (!restaurant?.owner) return { ...result, error: 'no_vendor' };
      const doc = await SettlementLedger.create({
        restaurant: order.restaurant,
        vendor: restaurant.owner,
        order: order._id,
        orderNumber: order.orderNumber || '',
        foodSales: 0,
        commissionRate: 0,
        commissionAmount: 0,
        restaurantNetAmount: 0,
        adjustmentAmount: -amount,
        netSettlementAmount: -amount,
        grossFoodBill: 0,
        vendorDiscountShare: 0,
        penaltyAdjustment: -amount,
        netVendorPayable: -amount,
        ledgerType: 'vendor',
        source: 'restaurant_charge',
        note: String(reason || 'Support resolution deduction').slice(0, 300),
      });
      return { ...result, applied: true, ledgerId: doc._id };
    }
    // rider
    if (!order.rider) return { ...result, error: 'no_rider' };
    const doc = await RiderLedger.create({
      rider: order.rider,
      order: order._id,
      orderNumber: order.orderNumber || '',
      entryType: 'adjustment',
      amount: -amount,
      note: String(reason || 'Support resolution deduction').slice(0, 300),
      createdBy: adminId,
    });
    return { ...result, applied: true, ledgerId: doc._id };
  } catch (err) {
    console.error(`[SUPPORT-DEDUCT] order=${orderId} target=${target} failed: ${err.message}`);
    return { ...result, error: err.message };
  }
}

module.exports = {
  initiateOrderRefund,
  refundDuplicatePayment,
  initiateSupportRefund,
  recordCodResolutionPayout,
  issueResolutionCoupon,
  applyFaultAttributionDeduction,
};
