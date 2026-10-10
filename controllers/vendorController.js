const mongoose = require('mongoose');
const { notifyOrderStatus } = require('../services/notificationService');
const asyncHandler   = require('express-async-handler');
const Order           = require('../models/Order');
const Menu            = require('../models/Menu');
const Restaurant      = require('../models/Restaurant');
const Review          = require('../models/Review');
const InventoryMovement = require('../models/InventoryMovement');
const { releaseOrderInventory } = require('../services/inventoryReservationService');

// FIX: Import the auto-assignment service here
const { autoAssignRider, scheduleRiderTimeout } = require('../services/riderAssignmentService'); 
const { initiateOrderRefund } = require('../services/refundService');
const { stopRing } = require('../services/pushService');
const { getRestaurantCapacity } = require('../services/vendorMarketplaceService');
const { isRestaurantResponseOverdue } = require('../services/orderCancellationPolicy');
const { buildOpeningHoursUpdate, operationalStatus, getLocalContext } = require('../services/restaurantHours');

function assertVendorPayload(req, res) {
  if (!req.user || req.user.role !== 'vendor' || !req.user.restaurantId) {
    res.status(403).json({ success: false, message: 'Access denied. You are not a registered vendor.' });
    return false;
  }
  return true;
}

function orderOwnershipFilter(req) {
  return { restaurant: req.user.restaurantId };
}

function vendorMenuFilter(req) {
  return { restaurantId: req.user.restaurantId };
}

const VENDOR_ORDER_POPULATE = [
  { path: 'user', select: 'name phone' },
  { path: 'rider', select: 'name phone' },
  {
    path: 'restaurant',
    select: 'name address owner',
    populate: { path: 'owner', select: 'name phone' },
  },
];

function serializeVendorOrder(orderDoc) {
  const order = orderDoc.toObject({ virtuals: false });
  const customer = order.user && typeof order.user === 'object' ? order.user : null;
  const restaurant = order.restaurant && typeof order.restaurant === 'object' ? order.restaurant : null;
  const owner = restaurant?.owner && typeof restaurant.owner === 'object' ? restaurant.owner : null;

  order.customerName = order.customerName || customer?.name || 'Customer';
  order.customerPhone = order.customerPhone || customer?.phone || '';
  order.customer = { _id: customer?._id || order.user, name: order.customerName, phone: order.customerPhone };
  order.restaurantAddress = restaurant?.address || '';
  order.restaurantPhone = owner?.phone || restaurant?.phone || restaurant?.contactNumber || '';
  order.restaurantOwnerName = owner?.name || '';

  const rider = order.rider && typeof order.rider === 'object' ? order.rider : null;
  order.riderInfo = rider ? { name: rider.name || 'Rider', phone: rider.phone || '' } : null;

  return order;
}

/* ─────────────────────────────────────────────────────────────
 *  ORDER STATUS GROUPS
 * ───────────────────────────────────────────────────────────── */
const QUEUE_STATUSES   = ['placed', 'confirmed', 'preparing', 'waiting_for_rider', 'assigned', 'out_for_delivery'];
const HISTORY_STATUSES = ['delivered', 'cancelled'];

// `preparing` branches by the restaurant's approved delivery mode.
// Self-delivery skips the Eatswada rider queue; Eatswada-rider restaurants
// continue through waiting_for_rider -> assigned -> out_for_delivery.
const VENDOR_STATUS_TRANSITIONS = {
  confirmed: 'preparing',
  preparing: 'waiting_for_rider',
  otp_verified: 'delivered',
};

/* ─────────────────────────────────────────────────────────────
 *  ORDERS
 * ───────────────────────────────────────────────────────────── */

exports.getVendorOrders = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;

  const { view } = req.query;
  let statusFilter = {};
  if (view === 'queue')   statusFilter = { status: { $in: QUEUE_STATUSES } };
  if (view === 'history') statusFilter = { status: { $in: HISTORY_STATUSES } };

  // Same filter as before — extracted so the count and the page share it.
  const query = {
    ...orderOwnershipFilter(req),
    ...statusFilter,
    $or: [
      { paymentMethod: 'cod' },
      { paymentMethod: { $ne: 'cod' }, paymentStatus: 'paid' },
    ],
  };

  // ── Pagination (Phase 2 — Performance at Scale) ──────────────────────
  // ONLY the history view paginates. The live queue (and the unfiltered
  // default) return every matching order uncapped, so the kitchen never loses
  // sight of an active order behind a page boundary. The queue path is the
  // original query verbatim — just with consistent meta appended.
  if (view !== 'history') {
    const orders = await Order.find(query)
      .populate(VENDOR_ORDER_POPULATE)
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      data: orders.map(serializeVendorOrder),
      // An uncapped view is simply "page 1 of 1" holding everything, so clients
      // can read the same meta fields regardless of which view they requested.
      currentPage: 1,
      totalPages: 1,
      totalOrders: orders.length,
    });
  }

  // History view: page 1 / limit 20 by default; limit clamped to a sane ceiling
  // so a client can't request an unbounded page (mirrors getVendorReviews below).
  const page  = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const skip  = (page - 1) * limit;

  const [orders, totalOrders] = await Promise.all([
    Order.find(query)
      .populate(VENDOR_ORDER_POPULATE)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Order.countDocuments(query),
  ]);

  res.status(200).json({
    success: true,
    data: orders.map(serializeVendorOrder),
    // New pagination metadata — appended alongside the existing shape, never
    // replacing `success`/`data`, so current clients keep working unchanged.
    currentPage: page,
    totalPages: Math.ceil(totalOrders / limit),
    totalOrders,
  });
});

exports.acceptOrder = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;

  const order = await Order.findOne({ _id: req.params.id, ...orderOwnershipFilter(req) });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found or access denied.' });

  if (order.paymentMethod !== 'cod' && order.paymentStatus !== 'paid') {
    return res.status(402).json({ success: false, message: 'Online payment has not been captured yet.' });
  }

  if (order.status !== 'placed') {
    return res.status(409).json({
      success: false,
      message: `Order cannot be accepted from its current status ("${order.status}").`,
    });
  }
  if (isRestaurantResponseOverdue(order)) {
    return res.status(409).json({
      success: false,
      code: 'RESTAURANT_RESPONSE_WINDOW_EXPIRED',
      message: 'The 5-minute restaurant response window has expired. This order is being cancelled automatically.',
    });
  }

  const capacity = await getRestaurantCapacity(req.user.restaurantId);
  if (!capacity) return res.status(404).json({ success:false, message:'Restaurant not found.' });
  if (capacity.activeOrders >= capacity.maxActiveOrders) {
    return res.status(409).json({
      success:false,
      code:'RESTAURANT_ORDER_CAPACITY_REACHED',
      message:`Restaurant is at its maximum active-order capacity (${capacity.maxActiveOrders}). Please wait for an active order to finish before accepting another.`,
      data:{ activeOrders:capacity.activeOrders, maxActiveOrders:capacity.maxActiveOrders, availableSlots:capacity.availableSlots },
    });
  }

  // Reserve tracked stock exactly once when the vendor accepts the order.
  // Atomic conditional updates prevent two simultaneous accepts overselling.
  const stockNeeds = new Map();
  for (const line of (order.items || [])) {
    const id = String(line.menuItem || '');
    if (id) stockNeeds.set(id, (stockNeeds.get(id) || 0) + Number(line.quantity || 0));
  }
  const reserved = [];
  try {
    for (const [itemId, quantity] of stockNeeds) {
      const item = await Menu.findOne({ _id:itemId, restaurantId:req.user.restaurantId, trackStock:true, isActive:{$ne:false} }).select('_id stockQuantity name');
      if (!item) continue;
      const before = Number(item.stockQuantity || 0);
      const updated = await Menu.findOneAndUpdate(
        { _id:itemId, restaurantId:req.user.restaurantId, trackStock:true, stockQuantity:{$gte:quantity} },
        { $inc:{stockQuantity:-quantity}, $set:{inStock: before-quantity > 0} },
        { new:true }
      );
      if (!updated) throw Object.assign(new Error(`${item.name} no longer has enough stock.`), { statusCode:409 });
      reserved.push({itemId,quantity,before,after:Number(updated.stockQuantity)});
    }
    for (const r of reserved) await InventoryMovement.create({restaurantId:req.user.restaurantId,menuItemId:r.itemId,actorId:req.user._id,orderId:order._id,change:-r.quantity,before:r.before,after:r.after,reason:'order_accepted'});
  } catch (err) {
    for (const r of reserved.reverse()) {
      await Menu.updateOne({_id:r.itemId,restaurantId:req.user.restaurantId},{$inc:{stockQuantity:r.quantity},$set:{inStock:true}});
    }
    throw err;
  }

  const prep = Number(req.body && req.body.prepMinutes);
  if (Number.isFinite(prep) && prep > 0 && prep <= 240) order.prepMinutes = Math.round(prep);

  order.advanceStatus('confirmed', 'Accepted by restaurant');
  if (reserved.length) order.inventoryReservedAt = new Date();
  try { await order.save(); } catch (err) {
    for (const line of reserved) { await Menu.updateOne({_id:line.itemId,restaurantId:req.user.restaurantId},{$inc:{stockQuantity:line.quantity},$set:{inStock:true}}); }
    await InventoryMovement.deleteMany({orderId:order._id,reason:'order_accepted'});
    throw err;
  }
  stopRing(order._id);
  await notifyOrderStatus(order.user, order);

  res.status(200).json({ success: true, data: order });
});

exports.rejectOrder = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;

  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason) {
    return res.status(400).json({ success: false, message: 'A rejection reason is required.' });
  }

  const order = await Order.findOne({ _id: req.params.id, ...orderOwnershipFilter(req) });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found or access denied.' });

  if (order.status !== 'placed') {
    return res.status(409).json({
      success: false,
      message: `Order cannot be rejected from its current status ("${order.status}").`,
    });
  }

  order.cancelReason = reason;
  order.cancellationResponsibility = 'none';
  order.advanceStatus('cancelled', `Rejected by restaurant: ${reason}`);

  // Launch-fix: persist the rejection FIRST (VersionError → 409 if the
  // customer/admin changed the order at the same moment), THEN refund. The
  // refund service claims atomically and saves its own result.
  await order.save();
  await initiateOrderRefund(order, `Rejected by restaurant: ${reason}`);
  stopRing(order._id);
  await notifyOrderStatus(order.user, order);

  res.status(200).json({ success: true, data: order });
});

exports.updateOrderStatus = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;

  const order = await Order.findOne({ _id: req.params.id, ...orderOwnershipFilter(req) });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found or access denied.' });

  if (order.paymentMethod !== 'cod' && order.paymentStatus !== 'paid') {
    return res.status(402).json({ success: false, message: 'Online payment has not been captured yet.' });
  }

  let nextStatus = VENDOR_STATUS_TRANSITIONS[order.status];
  if (order.status === 'preparing') {
    const restaurant = await Restaurant.findById(order.restaurant).select('deliveryMode');
    const deliveryMode = restaurant?.deliveryMode || 'eatswada_rider';
    nextStatus = deliveryMode === 'self_delivery' ? 'out_for_delivery' : 'waiting_for_rider';
  }
  if (order.status === 'otp_verified' && order.deliveryModeSnapshot !== 'self_delivery') {
    return res.status(409).json({ success:false, message:'Only self-delivery orders can be marked delivered by the vendor.' });
  }
  if (nextStatus === 'delivered' && !order.deliveryOtpVerified) {
    return res.status(409).json({ success:false, message:'Verify the customer delivery PIN before marking this self-delivery order delivered.' });
  }
  if (!nextStatus) {
    return res.status(409).json({
      success: false,
      message: `No vendor-triggered transition is available from "${order.status}".`,
    });
  }

  const note = (typeof req.body.note === 'string' && req.body.note.trim()) || `Marked ${nextStatus} by restaurant`;
  order.advanceStatus(nextStatus, note);

  // FIX: Trigger rider assignment when the vendor transitions the order to out_for_delivery
  let riderAssignment = null;
  if (nextStatus === 'waiting_for_rider' && !order.rider) {
    riderAssignment = await autoAssignRider(order);
  }

  await order.save();
  await notifyOrderStatus(order.user, order);

  // Auto-assigned riders must have the same 60-second acceptance timeout
  // as manually assigned riders. Without this, a rider who ignores the
  // assignment leaves the order stuck on `assigned` forever.
  if (riderAssignment && riderAssignment.assigned) {
    scheduleRiderTimeout(order._id, order.rider);
  }

  res.status(200).json({ 
    success: true, 
    data: order,
    ...(riderAssignment ? { riderAssignment } : {}),
  });
});


/* ─────────────────────────────────────────────────────────────
 *  EARNINGS — P0.3
 *  Financial read-only view. No payout/settlement is created here.
 *  Restaurant earnings use the commission snapshot stored on each order.
 *  Delivery fees and rider tips are excluded from restaurant earnings.
 * ───────────────────────────────────────────────────────────── */
const EARNINGS_ACTIVE_STATUSES = ['placed', 'confirmed', 'preparing', 'waiting_for_rider', 'assigned', 'out_for_delivery'];

function earningsSnapshot(order) {
  const c = order.commission && typeof order.commission === 'object' ? order.commission : null;
  const base = Number(c?.baseAmount);
  const amount = Number(c?.amount);
  const net = Number(c?.restaurantNetAmount);
  if (Number.isFinite(base) && Number.isFinite(amount) && Number.isFinite(net)) {
    return { rate: Number(c.rate) || 0, foodSales: base, commission: amount, restaurantNet: net, source: 'snapshot' };
  }
  // Legacy orders created before P0.2: provide a clearly deterministic read-only
  // fallback for the vendor screen. New orders always carry the snapshot.
  const subtotal = Math.max(0, Number(order.subtotal) || 0);
  const rate = 15;
  const commission = Math.round(subtotal * rate) / 100;
  return { rate, foodSales: subtotal, commission, restaurantNet: Math.max(0, Math.round((subtotal - commission) * 100) / 100), source: 'legacy-default' };
}

function earningsRange(period) {
  const now = new Date();
  if (period === 'today') {
    const start = new Date(now); start.setHours(0, 0, 0, 0); return { $gte: start, $lte: now };
  }
  if (period === '7d') return { $gte: new Date(now.getTime() - 7 * 86400000), $lte: now };
  if (period === '30d') return { $gte: new Date(now.getTime() - 30 * 86400000), $lte: now };
  return undefined;
}

exports.getVendorEarningsSummary = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  const period = ['today', '7d', '30d', 'all'].includes(req.query.period) ? req.query.period : '30d';
  const range = earningsRange(period);
  const baseFilter = { ...orderOwnershipFilter(req), status: { $nin: ['cancelled'] } };
  if (range) baseFilter.createdAt = range;

  const [orders, lifetimeOrders] = await Promise.all([
    Order.find(baseFilter).select('subtotal discount total status commission paymentMethod createdAt orderNumber').sort({ createdAt: -1 }).limit(500).lean(),
    Order.find({ ...orderOwnershipFilter(req), status: { $nin: ['cancelled'] } }).select('subtotal status commission').sort({ createdAt: -1 }).limit(2000).lean(),
  ]);

  const summarize = (list) => list.reduce((acc, order) => {
    const e = earningsSnapshot(order);
    if (EARNINGS_ACTIVE_STATUSES.includes(order.status)) acc.inProgress += e.restaurantNet;
    if (order.status === 'delivered') {
      acc.deliveredFoodSales += e.foodSales;
      acc.deliveredCommission += e.commission;
      acc.deliveredEarnings += e.restaurantNet;
      acc.deliveredOrders += 1;
    }
    acc.totalFoodSales += e.foodSales;
    acc.totalCommission += e.commission;
    acc.totalRestaurantEarnings += e.restaurantNet;
    acc.totalOrders += 1;
    return acc;
  }, { totalFoodSales:0,totalCommission:0,totalRestaurantEarnings:0,deliveredFoodSales:0,deliveredCommission:0,deliveredEarnings:0,deliveredOrders:0,inProgress:0,totalOrders:0 });

  const current = summarize(orders);
  const lifetime = summarize(lifetimeOrders);
  const round = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  for (const obj of [current, lifetime]) for (const k of Object.keys(obj)) obj[k] = round(obj[k]);

  res.json({
    success: true,
    data: {
      period,
      currency: 'INR',
      current,
      lifetime,
      settlement: { status: 'not_started', available: false, message: 'Payout and settlement tracking will be added in a later phase.' },
    },
  });
});

exports.getVendorEarningsOrders = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const view = ['completed', 'in_progress', 'all'].includes(req.query.view) ? req.query.view : 'completed';
  const filter = { ...orderOwnershipFilter(req), status: { $ne: 'cancelled' } };
  if (view === 'completed') filter.status = 'delivered';
  if (view === 'in_progress') filter.status = { $in: EARNINGS_ACTIVE_STATUSES };
  const [orders, total] = await Promise.all([
    Order.find(filter).select('orderNumber subtotal discount total status commission paymentMethod createdAt').sort({ createdAt: -1 }).skip((page-1)*limit).limit(limit).lean(),
    Order.countDocuments(filter),
  ]);
  const data = orders.map(o => { const e=earningsSnapshot(o); return { id:o._id, orderNumber:o.orderNumber, status:o.status, paymentMethod:o.paymentMethod, createdAt:o.createdAt, foodSales:e.foodSales, commissionRate:e.rate, commission:e.commission, restaurantNetAmount:e.restaurantNet, commissionSource:e.source }; });
  res.json({ success:true, data, pagination:{ page, limit, total, pages:Math.ceil(total/limit) } });
});

/* ─────────────────────────────────────────────────────────────
 *  MENU 
 * ───────────────────────────────────────────────────────────── */

exports.getVendorMenu = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  const items = await Menu.find(vendorMenuFilter(req)).sort({ sortOrder: 1, createdAt: -1 });
  res.status(200).json({ success: true, data: items });
});


exports.toggleItemStock = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  const existing = await Menu.findOne({ _id: req.params.id, ...vendorMenuFilter(req) });
  if (!existing) return res.status(404).json({ success: false, message: 'Menu item not found or access denied.' });

  const updated = await Menu.findByIdAndUpdate(existing._id, { inStock: !existing.inStock }, { new: true });
  res.status(200).json({
    success: true,
    data: updated,
    inStock: updated.inStock,
    message: updated.inStock ? 'Item is now In Stock.' : 'Item is now Out of Stock.',
  });
});

/* ─────────────────────────────────────────────────────────────
 *  RESTAURANT  
 * ───────────────────────────────────────────────────────────── */

exports.getRestaurantProfile = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  const restaurant = await Restaurant.findById(req.user.restaurantId);
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant profile not found.' });
  const now = new Date();
  const plain = restaurant.toObject({ virtuals: true });
  plain.operational = operationalStatus(plain, now, getLocalContext(now));
  res.status(200).json({ success: true, data: plain });
});



exports.updateVendorAvailability = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  const restaurant = await Restaurant.findOne({ _id: req.user.restaurantId, owner: req.user._id });
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant profile not found.' });

  const status = String(req.body?.status || '').trim();
  const allowed = ['open', 'closed_today', 'temporarily_closed', 'busy'];
  if (!allowed.includes(status)) return res.status(400).json({ success: false, message: `status must be one of: ${allowed.join(', ')}` });
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'autoHours') && typeof req.body.autoHours !== 'boolean') {
    return res.status(400).json({ success: false, message: 'autoHours must be a boolean.' });
  }

  const open = status === 'open' || status === 'busy';
  const update = { isOpen: open, 'availability.isOpen': open, 'availability.status': status, 'availability.closedReason': open ? '' : status };
  if (typeof req.body?.autoHours === 'boolean') update['availability.autoHours'] = req.body.autoHours;
  const updated = await Restaurant.findByIdAndUpdate(restaurant._id, { $set: update }, { new: true, runValidators: true });
  const now = new Date();
  res.json({ success: true, data: updated, operational: operationalStatus(updated, now, getLocalContext(now)) });
});

exports.updateBusinessHours = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  const restaurant = await Restaurant.findOne({ _id: req.user.restaurantId, owner: req.user._id });
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant profile not found.' });

  const body = req.body || {};
  const update = {};
  if (Object.prototype.hasOwnProperty.call(body, 'openingHours')) {
    const hoursCheck = buildOpeningHoursUpdate(body.openingHours);
    if (hoursCheck.error) return res.status(400).json({ success: false, message: hoursCheck.error });
    Object.assign(update, hoursCheck.set);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'autoHours')) {
    if (typeof body.autoHours !== 'boolean') return res.status(400).json({ success: false, message: 'autoHours must be a boolean.' });
    update['availability.autoHours'] = body.autoHours;
  }
  if (!Object.keys(update).length) {
    return res.status(400).json({ success: false, message: 'Provide openingHours and/or autoHours.' });
  }

  const updated = await Restaurant.findByIdAndUpdate(
    restaurant._id, { $set: update }, { new: true, runValidators: true }
  );
  const now = new Date();
  const plain = updated.toObject({ virtuals: true });
  plain.operational = operationalStatus(plain, now, getLocalContext(now));
  res.json({ success: true, data: plain });
});
exports.getVendorReviews = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  const restaurantId = req.user.restaurantId;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  const [restaurant, reviews, total] = await Promise.all([
    Restaurant.findById(restaurantId).select('name rating ratingCount reviewCount'),
    Review.find({ restaurant: restaurantId, isVisible: true }).populate('user','name avatar').sort({ createdAt: -1 }).skip(skip).limit(limit),
    Review.countDocuments({ restaurant: restaurantId, isVisible: true })
  ]);
  if (!restaurant) return res.status(404).json({ success:false, message:'Restaurant not found.' });
  res.json({ success:true, summary:{ name:restaurant.name, rating:restaurant.rating, ratingCount:restaurant.ratingCount, reviewCount:restaurant.reviewCount || total }, page, pages:Math.ceil(total/limit), total, data:reviews });
});



/* Vendor analytics: server-computed, restaurant-scoped metrics. */
exports.getVendorAnalytics = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  const period = ['7d', '30d', '90d', 'all'].includes(req.query.period) ? req.query.period : '30d';
  const match = { restaurant: new mongoose.Types.ObjectId(String(req.user.restaurantId)) };
  if (period !== 'all') {
    const days = Number(period.slice(0, -1));
    match.createdAt = { $gte: new Date(Date.now() - days * 86400000), $lte: new Date() };
  }
  const [summaryRows, statusRows, dailyRows, topItems] = await Promise.all([
    Order.aggregate([
      { $match: match },
      { $group: { _id: null,
        totalOrders: { $sum: 1 },
        deliveredOrders: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
        cancelledOrders: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
        deliveredFoodSales: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, { $ifNull: ['$subtotal', 0] }, 0] } },
      } },
    ]),
    Order.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    Order.aggregate([
      { $match: match },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } }, orders: { $sum: 1 }, deliveredSales: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, { $ifNull: ['$subtotal', 0] }, 0] } } } },
      { $sort: { _id: 1 } },
    ]),
    Order.aggregate([
      { $match: match }, { $unwind: '$items' },
      { $group: { _id: '$items.name', quantity: { $sum: { $ifNull: ['$items.quantity', 0] } }, sales: { $sum: { $multiply: [{ $ifNull: ['$items.price', 0] }, { $ifNull: ['$items.quantity', 0] }] } } } },
      { $sort: { quantity: -1, sales: -1 } }, { $limit: 5 },
      { $project: { _id: 0, name: '$_id', quantity: 1, sales: 1 } },
    ]),
  ]);
  const summary = summaryRows[0] || { totalOrders: 0, deliveredOrders: 0, cancelledOrders: 0, deliveredFoodSales: 0 };
  const money = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
  res.json({ success: true, data: {
    period,
    summary: {
      totalOrders: summary.totalOrders || 0,
      deliveredOrders: summary.deliveredOrders || 0,
      cancelledOrders: summary.cancelledOrders || 0,
      deliveredFoodSales: money(summary.deliveredFoodSales),
      averageDeliveredOrderValue: summary.deliveredOrders ? money(summary.deliveredFoodSales / summary.deliveredOrders) : 0,
    },
    statusCounts: statusRows.map(row => ({ status: row._id, count: row.count })),
    daily: dailyRows.map(row => ({ date: row._id, orders: row.orders, deliveredSales: money(row.deliveredSales) })),
    topItems: topItems.map(row => ({ ...row, sales: money(row.sales) })),
    currency: 'INR',
  }});
});

exports.replyToVendorReview = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid review id.' });
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(400).json({ success: false, message: 'Reply message is required.' });
  if (message.length > 500) return res.status(400).json({ success: false, message: 'Reply cannot exceed 500 characters.' });
  const review = await Review.findOne({ _id: req.params.id, restaurant: req.user.restaurantId, isVisible: true });
  if (!review) return res.status(404).json({ success: false, message: 'Review not found or not visible.' });
  const now = new Date();
  review.vendorReply = { message, repliedAt: review.vendorReply?.repliedAt || now, updatedAt: now };
  await review.save();
  res.json({ success: true, data: { reviewId: review._id, vendorReply: review.vendorReply } });
});
