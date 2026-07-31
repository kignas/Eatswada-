'use strict';

const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const Order = require('../models/Order');
const { uploadToCloudinary } = require('../utils/riderUpload');

/* ── Rider-owned delivery status flow ──
 * unassigned -> assigned -> accepted -> reached_restaurant -> picked_up -> out_for_delivery -> delivered
 * 'unassigned' / 'assigned' are set by the system (order creation / admin
 * assignment — see orderController.assignRider). Everything from 'accepted'
 * onward is driven by the rider, one step at a time, via
 * updateAssignedOrderStatus below.
 */
const RIDER_STATUS_FLOW = ['assigned', 'accepted', 'reached_restaurant', 'picked_up', 'out_for_delivery', 'delivered'];
const ACTIVE_RIDER_STATUSES = ['assigned', 'accepted', 'reached_restaurant', 'picked_up', 'out_for_delivery'];
const STATUS_LABELS = {
  accepted: 'Accepted',
  reached_restaurant: 'Reached Restaurant',
  picked_up: 'Picked Up',
  out_for_delivery: 'Out for Delivery',
  delivered: 'Delivered',
};

/* GET /api/riders/profile */
exports.getMyProfile = asyncHandler(async (req, res) => {
  // req.user is already the full, password-stripped User doc (set by `protect`).
  res.json({ success: true, data: req.user });
});

/* PUT /api/riders/profile */
exports.updateMyProfile = asyncHandler(async (req, res) => {
  const rider = await User.findById(req.user._id);
  const { name, vehicleType, vehicleNumber, deliveryZone } = req.body;

  if (name !== undefined) rider.name = String(name).trim();

  rider.riderDetails = rider.riderDetails || {};

  if (vehicleType !== undefined) rider.riderDetails.vehicleType = vehicleType;
  if (deliveryZone !== undefined) rider.riderDetails.deliveryZone = String(deliveryZone).trim();

  if (vehicleNumber !== undefined) {
    const normalized = String(vehicleNumber).trim().toUpperCase();
    const clash = await User.findOne({
      role: 'rider',
      'riderDetails.vehicleNumber': normalized,
      _id: { $ne: rider._id },
    });
    if (clash) {
      return res.status(409).json({ success: false, message: 'A rider with this vehicle number already exists.' });
    }
    rider.riderDetails.vehicleNumber = normalized;
  }

  try {
    await rider.save();
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }

  res.json({ success: true, message: 'Profile updated.', data: rider });
});

/* PUT /api/riders/profile/photo — multipart/form-data, field name "photo" */
exports.updateMyPhoto = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No image file provided (field name: "photo").' });
  }

  const result = await uploadToCloudinary(req.file.buffer, req.file.mimetype, 'nearbite/riders');

  const rider = await User.findById(req.user._id);
  rider.avatar = result.secure_url;
  await rider.save();

  res.json({ success: true, message: 'Profile picture updated.', data: { avatar: rider.avatar } });
});

/* PUT /api/riders/status — online/offline toggle.
 * Body { isOnline: true|false } sets it explicitly; an empty body flips it. */
exports.toggleOnline = asyncHandler(async (req, res) => {
  const rider = await User.findById(req.user._id);
  rider.riderDetails = rider.riderDetails || {};

  rider.riderDetails.isOnline =
    typeof req.body.isOnline === 'boolean' ? req.body.isOnline : !rider.riderDetails.isOnline;

  await rider.save();
  res.json({ success: true, data: { isOnline: rider.riderDetails.isOnline } });
});

/* GET /api/riders/orders — every order ever assigned to this rider.
 * Optional ?status=accepted|reached_restaurant|... filter. */
exports.getAssignedOrders = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const filter = { rider: req.user._id };
  if (status) filter.riderStatus = status;

  const skip = (Number(page) - 1) * Number(limit);
  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ riderAssignedAt: -1 }).skip(skip).limit(Number(limit)),
    Order.countDocuments(filter),
  ]);

  res.json({ success: true, data: { orders, total, page: Number(page), pages: Math.ceil(total / Number(limit)) } });
});

/* GET /api/riders/orders/active — the single in-progress order, if any. */
exports.getActiveOrder = asyncHandler(async (req, res) => {
  const order = await Order.findOne({
    rider: req.user._id,
    riderStatus: { $in: ACTIVE_RIDER_STATUSES },
  }).sort({ riderAssignedAt: -1 });

  res.json({ success: true, data: order || null });
});

/* GET /api/riders/orders/history — delivered or cancelled orders for this rider. */
exports.getOrderHistory = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const filter = {
    rider: req.user._id,
    $or: [{ riderStatus: 'delivered' }, { status: 'cancelled' }],
  };

  const skip = (Number(page) - 1) * Number(limit);
  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(Number(limit)),
    Order.countDocuments(filter),
  ]);

  res.json({ success: true, data: { orders, total, page: Number(page), pages: Math.ceil(total / Number(limit)) } });
});

/* GET /api/riders/orders/:id — single assigned order detail. */
exports.getAssignedOrderById = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, rider: req.user._id });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found or not assigned to you.' });
  res.json({ success: true, data: order });
});

/* GET /api/riders/earnings — earnings summary (all time / today / week / month). */
exports.getEarningsSummary = asyncHandler(async (req, res) => {
  const riderId = req.user._id;
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const baseMatch = { rider: riderId, riderStatus: 'delivered' };

  const summarize = async (extraMatch) => {
    const result = await Order.aggregate([
      { $match: { ...baseMatch, ...extraMatch } },
      { $group: { _id: null, earnings: { $sum: '$riderEarning' }, deliveries: { $sum: 1 } } },
    ]);
    return { earnings: result[0]?.earnings ?? 0, deliveries: result[0]?.deliveries ?? 0 };
  };

  const [allTime, today, thisWeek, thisMonth] = await Promise.all([
    summarize({}),
    summarize({ updatedAt: { $gte: todayStart } }),
    summarize({ updatedAt: { $gte: weekStart } }),
    summarize({ updatedAt: { $gte: monthStart } }),
  ]);

  res.json({ success: true, data: { allTime, today, thisWeek, thisMonth } });
});

/* PUT /api/riders/orders/:id/status
 * Advances the rider-owned delivery status by exactly one step.
 * Body: { status: 'accepted'|'reached_restaurant'|'picked_up'|'out_for_delivery'|'delivered', note?: string } */
exports.updateAssignedOrderStatus = asyncHandler(async (req, res) => {
  const { status, note } = req.body;
  const validRiderStatuses = ['accepted', 'reached_restaurant', 'picked_up', 'out_for_delivery', 'delivered'];

  if (!validRiderStatuses.includes(status)) {
    return res.status(400).json({
      success: false,
      message: `Invalid status. Must be one of: ${validRiderStatuses.map((s) => STATUS_LABELS[s]).join(', ')}.`,
    });
  }

  const order = await Order.findOne({ _id: req.params.id, rider: req.user._id });
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found or not assigned to you.' });
  }

  if (order.status === 'cancelled') {
    return res.status(409).json({ success: false, message: 'This order has been cancelled.' });
  }

  const currentIndex = RIDER_STATUS_FLOW.indexOf(order.riderStatus);
  const targetIndex = RIDER_STATUS_FLOW.indexOf(status);

  if (targetIndex !== currentIndex + 1) {
    return res.status(409).json({
      success: false,
      message: `Cannot move to "${STATUS_LABELS[status]}" from the order's current status. Statuses must be updated in order: ${RIDER_STATUS_FLOW.slice(
        1
      )
        .map((s) => STATUS_LABELS[s])
        .join(' \u2192 ')}.`,
    });
  }

  order.riderStatus = status;
  order.riderStatusHistory = order.riderStatusHistory || [];
  order.riderStatusHistory.push({ status, note: note || '', at: new Date() });

  // FIX: Using advanceStatus ensures deliveredAt is set so the vendor active tab clears it
  if (status === 'out_for_delivery' || status === 'delivered') {
    order.advanceStatus(status, `Updated by rider (${req.user.name})`);
  }

  await order.save();

  res.json({ success: true, message: `Order marked as ${STATUS_LABELS[status]}.`, data: order });
});
