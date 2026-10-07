'use strict';
const SettlementLedger = require('../models/SettlementLedger');
const Restaurant = require('../models/Restaurant');
const { calculateRestaurantCommission, DEFAULT_COMMISSION_RATE, roundCurrency } = require('./commissionService');

function snapshot(order) {
  const c = order.commission || {};
  const food = Math.max(0, Number(c.baseAmount) || Math.max(0, Number(order.subtotal) || 0));
  const rate = Number.isFinite(Number(c.rate)) ? Number(c.rate) : DEFAULT_COMMISSION_RATE;
  const calc = calculateRestaurantCommission({ subtotal: food, discount: 0, rate });
  const commissionAmount = Number.isFinite(Number(c.amount)) ? Number(c.amount) : calc.amount;
  const restaurantNetAmount = Number.isFinite(Number(c.restaurantNetAmount)) ? Number(c.restaurantNetAmount) : calc.restaurantNetAmount;
  return { food: roundCurrency(food), rate, commissionAmount: roundCurrency(commissionAmount), restaurantNetAmount: roundCurrency(restaurantNetAmount) };
}

async function ensureOrderLedger(order, session = null) {
  if (!order || order.status !== 'delivered' || order.paymentStatus !== 'paid' || !order.restaurant) return null;
  const query = SettlementLedger.findOne({ order: order._id, source: 'order_delivery' });
  if (session) query.session(session);
  let existing = await query.lean();
  if (!existing) {
    const rq = Restaurant.findById(order.restaurant).select('owner');
    if (session) rq.session(session);
    const restaurant = await rq.lean();
    if (!restaurant?.owner) return null;
    const s = snapshot(order);
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
        netSettlementAmount: s.restaurantNetAmount,
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

module.exports = { ensureOrderLedger, applyRefundAdjustment, recordRestaurantPaymentFeeCharge, snapshot };
