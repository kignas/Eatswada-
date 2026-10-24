'use strict';
const SettlementLedger = require('../models/SettlementLedger');
const RiderLedger = require('../models/RiderLedger');
const Restaurant = require('../models/Restaurant');
const User = require('../models/User');
const Order = require('../models/Order');
const { calculateRestaurantCommission, DEFAULT_COMMISSION_RATE, roundCurrency } = require('./commissionService');

// An order is financially complete when the money is in: prepaid UPI orders
// are 'paid'; cash orders are 'cod_collected' once the rider banks the cash.
const SETTLED_PAYMENT_STATUSES = ['paid', 'cod_collected'];

function snapshot(order) {
  const c = order.commission || {};
  const food = Math.max(0, Number(c.baseAmount) || Math.max(0, Number(order.subtotal) || 0));
  const rate = Number.isFinite(Number(c.rate)) ? Number(c.rate) : DEFAULT_COMMISSION_RATE;
  const calc = calculateRestaurantCommission({ subtotal: food, discount: 0, rate });
  const commissionAmount = Number.isFinite(Number(c.amount)) ? Number(c.amount) : calc.amount;
  const restaurantNetAmount = Number.isFinite(Number(c.restaurantNetAmount)) ? Number(c.restaurantNetAmount) : calc.restaurantNetAmount;
  return { food: roundCurrency(food), rate, commissionAmount: roundCurrency(commissionAmount), restaurantNetAmount: roundCurrency(restaurantNetAmount) };
}

// Vendor's share of the order discount.
//
// Orders created after the discount-funding split was introduced carry an
// explicit `vendorDiscountShare` (and a `discountFunding` label). When present
// it is authoritative: platform-funded coupons leave the vendor whole,
// restaurant-funded coupons are charged in full, shared coupons are split.
//
// Historical orders have neither field. We cannot invent a funding allocation
// for them, so we preserve the legacy behaviour those orders were settled with:
// the whole customer discount is charged to the vendor. (This was, and remains,
// the pre-existing accounting for every pre-split order.) New orders are never
// settled this way because they always persist the split explicitly.
function vendorDiscountShare(order) {
  const explicit = order.vendorDiscountShare;
  if (explicit !== undefined && explicit !== null && Number.isFinite(Number(explicit))) {
    const share = Math.max(0, Number(explicit));
    const discount = Math.max(0, Number(order.discount) || Number(order.coupon?.discount) || 0);
    return roundCurrency(Math.min(share, discount));
  }
  const discount = Math.max(0, Number(order.discount) || Number(order.coupon?.discount) || 0);
  return roundCurrency(discount);
}

async function ensureOrderLedger(order, session = null) {
  if (!order || order.status !== 'delivered' || !order.restaurant) return null;
  if (!SETTLED_PAYMENT_STATUSES.includes(String(order.paymentStatus))) return null;
  const query = SettlementLedger.findOne({ order: order._id, source: 'order_delivery' });
  if (session) query.session(session);
  let existing = await query.lean();
  if (!existing) {
    const rq = Restaurant.findById(order.restaurant).select('owner');
    if (session) rq.session(session);
    const restaurant = await rq.lean();
    if (!restaurant?.owner) return null;
    const s = snapshot(order);
    const discountShare = vendorDiscountShare(order);
    const netVendorPayable = roundCurrency(s.food - s.commissionAmount - discountShare);
    // Pre-generate the _id so the insert is safe to retry (idempotent) and does
    // not depend on a duplicate-key error inside a transaction, which would
    // abort it. The unique {order, source} index still prevents a second row.
    try {
      const docs = await SettlementLedger.create([{
        _id: new (require('mongoose').Types.ObjectId)(),
        restaurant: order.restaurant,
        vendor: restaurant.owner,
        order: order._id,
        orderNumber: order.orderNumber || '',
        foodSales: s.food,
        commissionRate: s.rate,
        commissionAmount: s.commissionAmount,
        restaurantNetAmount: s.restaurantNetAmount,
        adjustmentAmount: 0,
        netSettlementAmount: netVendorPayable,
        // Transparent statement columns (Pillar 5).
        grossFoodBill: s.food,
        vendorDiscountShare: discountShare,
        penaltyAdjustment: 0,
        netVendorPayable,
        ledgerType: 'vendor',
        source: 'order_delivery',
        eligibleAt: new Date(),
      }], session ? { session } : undefined);
      existing = docs[0].toObject ? docs[0].toObject() : docs[0];
    } catch (err) {
      if (err?.code === 11000) {
        const retry = SettlementLedger.findOne({ order: order._id, source: 'order_delivery' });
        if (session) retry.session(session);
        existing = await retry.lean();
      } else throw err;
    }
  }

  // If a full refund was processed before the delivery ledger was first
  // created, create the adjustment now. This closes the timing gap between
  // Razorpay refund webhooks and rider delivery completion.
  if (existing && (order.refund?.status === 'completed' || (order.supportRefund?.status === 'completed' && Number(order.supportRefund.amount || 0) >= Number(order.total || 0) - 0.01))) {
    try {
      await applyRefundAdjustment(order, session);
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  return existing;
}

/**
 * Pillar 6 — record the rider's earning for a delivered order.
 * Idempotent (unique order + entryType) so repeated delivery callbacks are safe.
 */
async function ensureRiderLedger(order, session = null) {
  if (!order || order.status !== 'delivered' || !order.rider) return null;
  const existingQ = RiderLedger.findOne({ order: order._id, entryType: 'delivery_earning' });
  if (session) existingQ.session(session);
  const existing = await existingQ.lean();
  if (existing) return existing;

  const b = order.riderEarningBreakdown || {};
  const amount = roundCurrency(Number.isFinite(Number(order.riderEarning)) ? Number(order.riderEarning) : Number(b.total) || 0);
  const isCod = String(order.paymentMethod || '').toLowerCase() === 'cod';
  try {
    const docs = await RiderLedger.create([{
      _id: new (require('mongoose').Types.ObjectId)(),
      rider: order.rider,
      order: order._id,
      orderNumber: order.orderNumber || '',
      entryType: 'delivery_earning',
      amount,
      breakdown: {
        basePay: Number(b.basePay) || 0,
        distancePay: Number(b.distancePay) || 0,
        rainSurgeBonus: Number(b.rainSurgeBonus) || 0,
        waitTimePay: Number(b.waitTimePay) || 0,
        tip: Number(b.tip) || 0,
      },
      codCashCollected: isCod ? roundCurrency(Number(order.codCashCollectedAmount) || Number(order.total) || 0) : 0,
      note: 'Delivery earning',
    }], session ? { session } : undefined);
    return docs[0];
  } catch (err) {
    if (err?.code === 11000) return RiderLedger.findOne({ order: order._id, entryType: 'delivery_earning' }).lean();
    throw err;
  }
}

/** Record an auditable COD cash deposit from a rider back to Admin. */
async function recordCodCashDeposit({ riderId, amount, reference = '', note = '', adminId = null }) {
  const value = roundCurrency(Math.max(0, Number(amount) || 0));
  if (!riderId || value <= 0) return null;
  const { withRequiredTransaction } = require('./dbTransaction');
  return withRequiredTransaction(async (session) => {
    const rider = await User.findById(riderId).select('name role riderDetails.cashInHand').session(session).lean();
    if (!rider || rider.role !== 'rider') return null;
    const applied = Math.min(value, roundCurrency(Number(rider.riderDetails?.cashInHand) || 0));
    if (applied <= 0) return null;

    const updated = await User.findOneAndUpdate(
      { _id: riderId, role: 'rider', 'riderDetails.cashInHand': { $gte: applied } },
      { $inc: { 'riderDetails.cashInHand': -applied } },
      { new: true, session }
    );
    if (!updated) return null;

    const docs = await RiderLedger.create([{
      rider: riderId,
      entryType: 'cod_cash_deposit',
      amount: -applied,
      codCashCollected: applied,
      reference: String(reference || '').slice(0, 120),
      note: note || 'COD cash deposited with Admin',
      createdBy: adminId,
    }], { session });
    return docs[0];
  });
}

/**
 * Credit the rider's running COD cash balance for a delivered order, exactly
 * once. The order document is the idempotency key: a conditional update flips
 * `riderCashCreditedAt` from null to a timestamp and only the request that
 * performs that flip increments cashInHand. Concurrent/retried deliveries of
 * the same order therefore credit the balance at most once.
 *
 * Returns true when this call performed the credit, false when it was already
 * credited (or the order has no rider / no cash).
 */
async function creditRiderCashForOrder(order, { session = null } = {}) {
  if (!order?._id || !order.rider) return false;
  const amount = roundCurrency(Number(order.codCashCollectedAmount) || Number(order.total) || 0);
  if (amount <= 0) return false;

  const applyCredit = async (tx) => {
    const claim = await Order.findOneAndUpdate(
      { _id: order._id, rider: order.rider, riderCashCreditedAt: null },
      { $set: { riderCashCreditedAt: new Date() } },
      { new: true, session: tx }
    );
    if (!claim) return false; // already credited by a prior successful transaction

    const result = await User.updateOne(
      { _id: order.rider, role: 'rider' },
      { $inc: { 'riderDetails.cashInHand': amount } },
      { session: tx }
    );
    if (result.matchedCount !== 1) {
      const err = new Error('COD cash credit failed because the assigned rider account is missing or invalid.');
      err.code = 'RIDER_CASH_CREDIT_TARGET_MISSING';
      throw err; // transaction aborts, including the order claim
    }
    return true;
  };

  if (session) return applyCredit(session);
  const { withRequiredTransaction } = require('./dbTransaction');
  return withRequiredTransaction(applyCredit);
}

/** Record an auditable rider payout (Admin -> rider bank/UPI). */
async function recordRiderPayout({ riderId, amount, reference = '', note = '', adminId = null }) {
  const value = roundCurrency(Math.max(0, Number(amount) || 0));
  if (!riderId || value <= 0) return null;
  return RiderLedger.create({
    rider: riderId,
    entryType: 'payout',
    amount: -value,
    reference: String(reference || '').slice(0, 120),
    note: note || 'Rider payout',
    createdBy: adminId,
  });
}

/**
 * Pay a rider, capped at the authoritative live payable balance and guarded
 * against concurrent double-payouts.
 *
 * The balance is always recomputed from the rider's ledger + live COD cash
 * hold (never trusted from the client). The payout row is written first with a
 * unique payout token; a second concurrent request with the same token fails
 * its unique insert, so the same balance can never be paid twice. After the
 * row exists, the balance is re-read and the payout is rejected (and rolled
 * back) if it exceeds what is now actually payable.
 *
 * Returns { ok, entry, amount, balance, reason }.
 */
const PAYOUT_LOCK_STALE_MS = 60 * 1000;

async function payRider({ riderId, requestedAmount = null, reference = '', note = '', adminId = null, token }) {
  const mongoose = require('mongoose');
  if (!mongoose.Types.ObjectId.isValid(String(riderId))) {
    return { ok: false, reason: 'invalid_rider' };
  }

  // Serialise payouts for this rider. The conditional claim only succeeds when
  // no live lock is held; a stale lock (a crashed request) is reclaimed after
  // PAYOUT_LOCK_STALE_MS. This is what stops two concurrent requests from both
  // reading the same starting balance.
  const lockClaimedAt = new Date();
  const staleBefore = new Date(Date.now() - PAYOUT_LOCK_STALE_MS);
  const lock = await User.findOneAndUpdate(
    {
      _id: riderId,
      role: 'rider',
      $or: [{ 'riderDetails.payoutLockAt': null }, { 'riderDetails.payoutLockAt': { $lte: staleBefore } }],
    },
    { $set: { 'riderDetails.payoutLockAt': lockClaimedAt } },
    { new: true }
  );
  if (!lock) {
    const exists = await User.exists({ _id: riderId, role: 'rider' });
    return exists
      ? { ok: false, reason: 'payout_in_progress' }
      : { ok: false, reason: 'not_found' };
  }

  try {
    const balanceBefore = await getRiderBalance(riderId);
    if (!balanceBefore) return { ok: false, reason: 'not_found' };

    const payable = roundCurrency(balanceBefore.netPayable);
    if (payable <= 0) return { ok: false, reason: 'no_balance', balance: balanceBefore };

    const requested = requestedAmount === null || requestedAmount === undefined || requestedAmount === ''
      ? payable
      : roundCurrency(requestedAmount);
    if (!Number.isFinite(requested) || requested <= 0) return { ok: false, reason: 'invalid_amount', balance: balanceBefore };

    // Never pay more than the authoritative payable balance. An explicit
    // over-balance request is rejected outright rather than silently capped.
    if (requested > payable + 0.001) return { ok: false, reason: 'exceeds_balance', balance: balanceBefore };
    const amount = Math.min(requested, payable);

    // The bank/UPI reference is mandatory at the controller. Use it as the
    // fallback idempotency key so a retry after a lost HTTP response cannot
    // create a second payout merely because the client omitted an idempotency key.
    const normalizedReference = String(reference || '').trim().toUpperCase();
    const payoutToken = String(token || (normalizedReference ? `utr:${normalizedReference}` : '')).slice(0, 120)
      || new mongoose.Types.ObjectId().toString();
    let entry;
    try {
      entry = await RiderLedger.create({
        rider: riderId,
        entryType: 'payout',
        amount: -amount,
        reference: String(reference || '').slice(0, 120),
        note: note || 'Rider payout',
        createdBy: adminId,
        payoutToken,
      });
    } catch (err) {
      if (err?.code === 11000) return { ok: false, reason: 'duplicate', balance: balanceBefore };
      throw err;
    }

    const balanceAfter = await getRiderBalance(riderId);
    return { ok: true, entry, amount, balance: balanceAfter };
  } finally {
    await User.updateOne({ _id: riderId, 'riderDetails.payoutLockAt': lockClaimedAt }, { $set: { 'riderDetails.payoutLockAt': null } }).catch(() => {});
  }
}

/** Live rider balances: earnings, COD cash held and net payable. */
async function getRiderBalance(riderId) {
  const [rider, agg] = await Promise.all([
    User.findById(riderId).select('name phone riderDetails').lean(),
    RiderLedger.aggregate([
      { $match: { rider: new (require('mongoose').Types.ObjectId)(String(riderId)) } },
      { $group: {
        _id: null,
        totalEarnings: { $sum: { $cond: [{ $eq: ['$entryType', 'delivery_earning'] }, '$amount', 0] } },
        totalDeposits: { $sum: { $cond: [{ $eq: ['$entryType', 'cod_cash_deposit'] }, '$amount', 0] } },
        totalPayouts: { $sum: { $cond: [{ $eq: ['$entryType', 'payout'] }, '$amount', 0] } },
        totalAdjustments: { $sum: { $cond: [{ $eq: ['$entryType', 'adjustment'] }, '$amount', 0] } },
      } },
    ]),
  ]);
  if (!rider) return null;
  const a = agg[0] || {};
  const totalEarnings = roundCurrency(a.totalEarnings || 0);
  const cashInHand = roundCurrency(Number(rider.riderDetails?.cashInHand) || 0);
  const ledgerNet = roundCurrency((a.totalEarnings || 0) + (a.totalDeposits || 0) + (a.totalPayouts || 0) + (a.totalAdjustments || 0));
  return {
    rider: { _id: rider._id, name: rider.name, phone: rider.phone },
    totalEarnings,
    codCashHeld: cashInHand,
    codCashLimit: roundCurrency(Number(rider.riderDetails?.codCashLimit) || 0),
    totalDeposits: roundCurrency(Math.abs(a.totalDeposits || 0)),
    totalPayouts: roundCurrency(Math.abs(a.totalPayouts || 0)),
    totalAdjustments: roundCurrency(a.totalAdjustments || 0),
    // Net payable = earnings already banked minus what the rider still holds
    // as cash. A positive figure means Admin owes the rider a payout.
    netPayable: roundCurrency(totalEarnings - cashInHand + (a.totalAdjustments || 0) - Math.abs(a.totalPayouts || 0)),
    ledgerNet,
  };
}

/** Live unsettled vendor balance + itemized orders for one restaurant. */
async function getRestaurantSettlementStatement(restaurantId, { includeSettled = false } = {}) {
  const mongoose = require('mongoose');
  if (!mongoose.Types.ObjectId.isValid(restaurantId)) return null;
  const rid = new mongoose.Types.ObjectId(String(restaurantId));
  const statusFilter = includeSettled ? { $ne: 'void' } : { $in: ['eligible', 'reserved'] };
  const rows = await SettlementLedger.find({ restaurant: rid, status: statusFilter, ledgerType: 'vendor' })
    .sort({ createdAt: -1 }).limit(1000).lean();
  const totals = rows.reduce((acc, r) => {
    acc.grossFoodBill += Number(r.grossFoodBill || r.foodSales || 0);
    acc.commissionAmount += Number(r.commissionAmount || 0);
    acc.vendorDiscountShare += Number(r.vendorDiscountShare || 0);
    acc.penaltyAdjustment += Number(r.penaltyAdjustment || 0);
    acc.netVendorPayable += Number(r.netVendorPayable ?? r.netSettlementAmount ?? 0);
    return acc;
  }, { grossFoodBill: 0, commissionAmount: 0, vendorDiscountShare: 0, penaltyAdjustment: 0, netVendorPayable: 0 });
  Object.keys(totals).forEach(k => { totals[k] = roundCurrency(totals[k]); });
  return { restaurant: rid, orders: rows, totals, unsettledBalance: totals.netVendorPayable };
}

async function applyRefundAdjustment(order, session = null) {
  const fullSupportRefund = order?.supportRefund?.status === 'completed'
    && Number(order.supportRefund.amount || 0) >= Number(order.total || 0) - 0.01;
  if (!order?._id || (order.refund?.status !== 'completed' && !fullSupportRefund)) return null;
  const q = SettlementLedger.findOne({ order: order._id, source: 'order_delivery', status: { $ne: 'void' } });
  if (session) q.session(session);
  const original = await q.lean();
  if (!original) return null;
  const existingQ = SettlementLedger.findOne({ order: order._id, source: 'refund_adjustment' });
  if (session) existingQ.session(session);
  if (await existingQ.lean()) return null;

  const adjustment = -Math.abs(Number(original.netSettlementAmount) || 0);
  try {
    const docs = await SettlementLedger.create([{
      restaurant: original.restaurant,
      vendor: original.vendor,
      order: order._id,
      orderNumber: original.orderNumber,
      foodSales: 0,
      commissionRate: original.commissionRate,
      commissionAmount: 0,
      restaurantNetAmount: 0,
      adjustmentAmount: adjustment,
      netSettlementAmount: adjustment,
      source: 'refund_adjustment',
      eligibleAt: new Date(),
    }], session ? { session } : undefined);
    return docs[0];
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
}


async function recordRestaurantPaymentFeeCharge(order, amount, reason = 'Restaurant non-response caused order cancellation') {
  const fee = roundCurrency(Math.max(0, Number(amount) || 0));
  if (!order?._id || !order.restaurant || fee <= 0) return null;
  const existing = await SettlementLedger.findOne({ order: order._id, source: 'restaurant_charge' }).lean();
  if (existing) return existing;
  const restaurant = await Restaurant.findById(order.restaurant).select('owner').lean();
  if (!restaurant?.owner) return null;
  try {
    const docs = await SettlementLedger.create([{
      restaurant: order.restaurant,
      vendor: restaurant.owner,
      order: order._id,
      orderNumber: order.orderNumber || '',
      foodSales: 0,
      commissionRate: Number(order.commission?.rate) || 0,
      commissionAmount: 0,
      restaurantNetAmount: 0,
      adjustmentAmount: -fee,
      netSettlementAmount: -fee,
      source: 'restaurant_charge',
      eligibleAt: new Date(),
    }]);
    return docs[0];
  } catch (err) {
    if (err?.code === 11000) return SettlementLedger.findOne({ order: order._id, source: 'restaurant_charge' }).lean();
    throw err;
  }
}

module.exports = {
  ensureOrderLedger,
  ensureRiderLedger,
  creditRiderCashForOrder,
  recordCodCashDeposit,
  recordRiderPayout,
  payRider,
  getRiderBalance,
  getRestaurantSettlementStatement,
  applyRefundAdjustment,
  recordRestaurantPaymentFeeCharge,
  snapshot,
};
