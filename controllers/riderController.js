// File 3: controllers/riderController.js
'use strict';

const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const Order = require('../models/Order');
const { uploadToCloudinary } = require('../utils/riderUpload');
const { handleReassignment } = require('../services/riderAssignmentService');

const RIDER_STATUS_FLOW = ['assigned', 'accepted', 'reached_restaurant', 'picked_up', 'out_for_delivery', 'delivered'];
const ACTIVE_RIDER_STATUSES = ['assigned', 'accepted', 'reached_restaurant', 'picked_up', 'out_for_delivery'];
const STATUS_LABELS = {
  accepted: 'Accepted',
  rejected: 'Rejected',
  reached_restaurant: 'Reached Restaurant',
  picked_up: 'Picked Up',
  out_for_delivery: 'Out for Delivery',
  delivered: 'Delivered',
};

// Restaurant has an `owner` User reference, but the Restaurant schema does
// not have a phone field. The rider needs the owner's phone, so populate the
// owner explicitly instead of looking for restaurant.phone.
const RIDER_RESTAURANT_POPULATE = {
  path: 'restaurant',
  select: 'name address location owner',
  populate: {
    path: 'owner',
    select: 'name phone email',
  },
};

exports.getMyProfile = asyncHandler(async (req, res) => {
  res.json({ success: true, data: req.user });
});

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

exports.toggleOnline = asyncHandler(async (req, res) => {
  const rider = await User.findById(req.user._id);
  rider.riderDetails = rider.riderDetails || {};

  const wasOnline = rider.riderDetails.isOnline;
  rider.riderDetails.isOnline =
    typeof req.body.isOnline === 'boolean' ? req.body.isOnline : !wasOnline;

  await rider.save();

  // If the rider actively went offline, release any of their assigned tasks before pickup
  if (wasOnline && !rider.riderDetails.isOnline) {
    const activeOrders = await Order.find({ 
      rider: rider._id, 
      riderStatus: { $in: ['assigned', 'accepted', 'reached_restaurant'] } 
    });
    
    for (const activeOrder of activeOrders) {
      await handleReassignment(activeOrder._id, rider._id, `Auto-released: Rider ${rider.name} went offline.`);
    }
  }

  res.json({ success: true, data: { isOnline: rider.riderDetails.isOnline } });
});

exports.getAssignedOrders = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const filter = { rider: req.user._id };
  if (status) filter.riderStatus = status;

  const skip = (Number(page) - 1) * Number(limit);
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .populate(RIDER_RESTAURANT_POPULATE)
      .sort({ riderAssignedAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    Order.countDocuments(filter),
  ]);

  res.json({ success: true, data: { orders, total, page: Number(page), pages: Math.ceil(total / Number(limit)) } });
});

exports.getActiveOrder = asyncHandler(async (req, res) => {
  const order = await Order.findOne({
    rider: req.user._id,
    riderStatus: { $in: ACTIVE_RIDER_STATUSES },
  })
    .populate(RIDER_RESTAURANT_POPULATE)
    .sort({ riderAssignedAt: -1 });

  res.json({ success: true, data: order || null });
});

exports.getOrderHistory = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const filter = {
    rider: req.user._id,
    $or: [{ riderStatus: 'delivered' }, { status: 'cancelled' }],
  };

  const skip = (Number(page) - 1) * Number(limit);
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .populate(RIDER_RESTAURANT_POPULATE)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    Order.countDocuments(filter),
  ]);

  res.json({ success: true, data: { orders, total, page: Number(page), pages: Math.ceil(total / Number(limit)) } });
});

exports.getAssignedOrderById = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, rider: req.user._id })
    .populate(RIDER_RESTAURANT_POPULATE);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found or not assigned to you.' });
  res.json({ success: true, data: order });
});

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

exports.updateAssignedOrderStatus = asyncHandler(async (req, res) => {
  const { status, note } = req.body;
  const validRiderStatuses = ['accepted', 'rejected', 'reached_restaurant', 'picked_up', 'out_for_delivery', 'delivered'];

  if (!validRiderStatuses.includes(status)) {
    return res.status(400).json({
      success: false,
      message: `Invalid status. Must be one of: ${validRiderStatuses.map((s) => STATUS_LABELS[s]).join(', ')}.`,
    });
  }

  if (status === 'rejected') {
    const order = await Order.findOne({ _id: req.params.id, rider: req.user._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found or not assigned to you.' });
    
    const NO_REASSIGN_STATUSES = ['picked_up', 'out_for_delivery', 'delivered'];
    if (NO_REASSIGN_STATUSES.includes(order.riderStatus)) {
      return res.status(409).json({ success: false, message: 'Cannot reject an order after it has been picked up.' });
    }

    const result = await handleReassignment(order._id, req.user._id, `Rejected by rider (${req.user.name}). Note: ${note || ''}`);
    return res.json({ success: true, message: 'Order rejected successfully.', data: result });
  }

  const order = await Order.findOne({ _id: req.params.id, rider: req.user._id });
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found or not assigned to you.' });
  }

  if (order.status === 'cancelled') {
    return res.status(409).json({ success: false, message: 'This order has been cancelled.' });
  }

  if (status === 'delivered' && !order.deliveryOtpVerified) {
    return res.status(409).json({
      success: false,
      message: "Cannot mark as delivered — please verify the customer's delivery OTP first.",
    });
  }

  if (status === 'accepted' && order.status !== 'waiting_for_rider') {
    return res.status(409).json({
      success: false,
      message: `Cannot accept — order is currently "${order.status}", but must be "waiting_for_rider" first.`,
    });
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

  if (status === 'accepted') {
    order.advanceStatus('assigned', `Accepted by rider (${req.user.name})`);
  } else if (status === 'out_for_delivery' || status === 'delivered') {
    order.advanceStatus(status, `Updated by rider (${req.user.name})`);
  }

  await order.save();

  res.json({ success: true, message: `Order marked as ${STATUS_LABELS[status]}.`, data: order });
});

exports.verifyDeliveryOtp = asyncHandler(async (req, res) => {
  const { otp } = req.body;

  if (!otp || !/^\d{4}$/.test(String(otp).trim())) {
    return res.status(400).json({ success: false, message: 'A 4-digit OTP is required.' });
  }

  const order = await Order.findOne({ _id: req.params.id, rider: req.user._id }).select(
    '+deliveryOtpHash +deliveryOtpSalt +deliveryOtpExpiresAt +deliveryOtpAttempts +deliveryOtpLockedUntil'
  );

  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found or not assigned to you.' });
  }

  if (order.status === 'cancelled') {
    return res.status(409).json({ success: false, message: 'This order has been cancelled.' });
  }

  if (order.deliveryOtpVerified) {
    order.clearOtpSecrets();
    return res.json({ success: true, message: 'OTP already verified.', data: order });
  }

  if (order.status !== 'out_for_delivery') {
    return res.status(409).json({
      success: false,
      message: `OTP verification is only allowed while the order is "Out for Delivery". Current status: "${order.status}".`,
    });
  }

  const result = await order.verifyDeliveryOtp(String(otp).trim());

  if (!result.ok) {
    await order.save(); 

    if (result.reason === 'locked' || result.reason === 'locked_now') {
      const secondsLeft = Math.max(0, Math.ceil((result.lockedUntil - new Date()) / 1000));
      return res.status(429).json({
        success: false,
        message: `Too many incorrect attempts. Try again in ${Math.ceil(secondsLeft / 60)} minute(s).`,
        lockedUntil: result.lockedUntil,
      });
    }
    if (result.reason === 'expired') {
      return res.status(410).json({
        success: false,
        message: 'This delivery OTP has expired. Please contact support.',
      });
    }
    if (result.reason === 'not_set') {
      return res.status(409).json({
        success: false,
        message: 'No delivery OTP is set for this order. Please contact support.',
      });
    }
    
    return res.status(400).json({
      success: false,
      message: `Incorrect OTP. ${result.attemptsRemaining} attempt(s) remaining before a temporary lockout.`,
      attemptsRemaining: result.attemptsRemaining,
    });
  }

  order.advanceStatus('otp_verified', `Delivery OTP verified by rider (${req.user.name})`);
  await order.save();

  order.clearOtpSecrets();
  res.json({ success: true, message: 'OTP verified — you can now complete the delivery.', data: order });
});
