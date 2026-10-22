'use strict';
const SettlementLedger = require('../models/SettlementLedger');
const RiderLedger = require('../models/RiderLedger');
const Restaurant = require('../models/Restaurant');
const User = require('../models/User');
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

// Vendor's share of a platform coupon. The coupon is funded by the platform,
// so by default the vendor keeps its full commission base; when the platform
// policy is to share the discount, the vendor absorbs the discount amount
// (never more than the food bill).
function vendorDiscountShare(order) {
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
    try {
      const docs = await SettlementLedger.create([{
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
  if (existing && order.refund?.status === 'completed') {
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
  const rider = await User.findById(riderId).select('name role riderDetails.cashInHand').lean();
  if (!rider || rider.role !== 'rider') return null;
  const applied = Math.min(value, roundCurrency(Number(rider.riderDetails?.cashInHand) || 0));
  if (applied <= 0) return null;

  const updated = await User.findOneAndUpdate(
    { _id: riderId, role: 'rider', 'riderDetails.cashInHand': { $gte: applied } },
    { $inc: { 'riderDetails.cashInHand': -applied } },
    { new: true }
  );
  if (!updated) return null;

  return RiderLedger.create({
    rider: riderId,
    entryType: 'cod_cash_deposit',
    amount: -applied,
    codCashCollected: applied,
    reference: String(reference || '').slice(0, 120),
    note: note || 'COD cash deposited with Admin',
    createdBy: adminId,
  });
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
  if (!order?._id || order.refund?.status !== 'completed') return null;
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
  recordCodCashDeposit,
  recordRiderPayout,
  getRiderBalance,
  getRestaurantSettlementStatement,
  applyRefundAdjustment,
  recordRestaurantPaymentFeeCharge,
  snapshot,
};
