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
 *
 * Once riderStatus/order.status reach 'out_for_delivery', the rider must
 * call verifyDeliveryOtp (below) with the code the customer received at
 * checkout before 'delivered' will be accepted — see the OTP gate inside
 * updateAssignedOrderStatus. A successful verification moves order.status
 * (not riderStatus) to 'otp_verified' and sets order.deliveryOtpVerified.
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
    Order.find(filter).sort({ riderAssignedAt: -1 }).skip(skip).limit(Number(limit)).populate('restaurant', 'name image address location'),
    Order.countDocuments(filter),
  ]);

  res.json({ success: true, data: { orders, total, page: Number(page), pages: Math.ceil(total / Number(limit)) } });
});

/* GET /api/riders/orders/active — the single in-progress order, if any. */
exports.getActiveOrder = asyncHandler(async (req, res) => {
  const order = await Order.findOne({
    rider: req.user._id,
    riderStatus: { $in: ACTIVE_RIDER_STATUSES },
  }).sort({ riderAssignedAt: -1 }).populate('restaurant', 'name image address location');

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
    Order.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(Number(limit)).populate('restaurant', 'name image address location'),
    Order.countDocuments(filter),
  ]);

  res.json({ success: true, data: { orders, total, page: Number(page), pages: Math.ceil(total / Number(limit)) } });
});

/* GET /api/riders/orders/:id — single assigned order detail. */
exports.getAssignedOrderById = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, rider: req.user._id }).populate('restaurant', 'name image address location');
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

  const order = await Order.findOne({ _id: req.params.id, rider: req.user._id }).populate('restaurant', 'name image address location');
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found or not assigned to you.' });
  }

  if (order.status === 'cancelled') {
    return res.status(409).json({ success: false, message: 'This order has been cancelled.' });
  }

  // ── DELIVERY OTP GATE ──────────────────────────────────────
  // Requirement: delivery cannot be completed until the customer's OTP
  // has been verified. See verifyDeliveryOtp below, which sets this flag
  // once the rider confirms the code with the customer.
  if (status === 'delivered' && !order.deliveryOtpVerified) {
    return res.status(409).json({
      success: false,
      message: "Cannot mark as delivered — please verify the customer's delivery OTP first.",
    });
  }

  // ── STRICT ORDER-STATUS TRANSITION VALIDATION ─────────────────
  // riderStatus itself is already gated one step at a time by
  // RIDER_STATUS_FLOW below. This additionally guards the order-level
  // side effect that 'accepted' triggers (order.status -> 'assigned'):
  // a rider can only accept once the vendor has actually pushed the
  // order to 'waiting_for_rider' (see orderController.updateOrderStatus).
  // Without this, an order manually assigned via PUT
  // /api/orders/:id/assign-rider before that point could let order.status
  // skip straight from e.g. 'preparing' to 'assigned'.
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

  // FIX: Using advanceStatus ensures deliveredAt is set so the vendor active tab clears it
  if (status === 'accepted') {
    // Rider has accepted the job — order leaves 'waiting_for_rider' and
    // moves to 'assigned' at the order level. riderStatus itself still
    // records the finer-grained 'accepted' step below.
    order.advanceStatus('assigned', `Accepted by rider (${req.user.name})`);
  } else if (status === 'out_for_delivery' || status === 'delivered') {
    order.advanceStatus(status, `Updated by rider (${req.user.name})`);
    // COD is collected at the door. Once the rider completes delivery,
    // the order is considered paid in cash. Online payments remain pending
    // here until the real payment provider is integrated later.
    if (status === 'delivered' && order.paymentMethod === 'cod') {
      order.paymentStatus = 'paid';
    }
  }

  await order.save();

  res.json({ success: true, message: `Order marked as ${STATUS_LABELS[status]}.`, data: order });
});

/* PUT /api/riders/orders/:id/verify-otp
 * Body: { otp: '1234' }
 *
 * Verifies the customer's delivery OTP. Required before a rider can mark
 * an order 'delivered' (see the OTP gate inside updateAssignedOrderStatus
 * above). Only allowed while the order is 'out_for_delivery'. Enforces a
 * per-order failed-attempt limit and temporary lockout — see
 * Order.OTP_CONFIG (currently 5 attempts / 15-minute lockout). */

/* PUT /api/riders/location — the rider app sends its live GPS here while
 * delivering. Stored as [lng, lat]; surfaced to the customer's tracking
 * screen only while the order is picked_up / out_for_delivery. */
exports.updateLocation = asyncHandler(async (req, res) => {
  const lat = Number(req.body.lat ?? req.body.latitude);
  const lng = Number(req.body.lng ?? req.body.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
      lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ success: false, message: 'Valid lat/lng required.' });
  }
  await User.updateOne(
    { _id: req.user._id, role: 'rider' },
    { $set: { 'riderDetails.currentLocation': { coordinates: [lng, lat], updatedAt: new Date() } } }
  );
  res.json({ success: true });
});

exports.verifyDeliveryOtp = asyncHandler(async (req, res) => {
  const { otp } = req.body;

  if (!otp || !/^\d{4}$/.test(String(otp).trim())) {
    return res.status(400).json({ success: false, message: 'A 4-digit OTP is required.' });
  }

  // deliveryOtp* fields are `select: false` on the model — explicitly
  // request them here since verifyDeliveryOtp() needs to read/mutate them.
  const order = await Order.findOne({ _id: req.params.id, rider: req.user._id }).populate('restaurant', 'name image address location').select(
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

  // Requirement: OTP verification is only allowed while the order is
  // 'out_for_delivery'.
  if (order.status !== 'out_for_delivery') {
    return res.status(409).json({
      success: false,
      message: `OTP verification is only allowed while the order is "Out for Delivery". Current status: "${order.status}".`,
    });
  }

  const result = await order.verifyDeliveryOtp(String(otp).trim());

  if (!result.ok) {
    await order.save(); // persist the updated attempt count / lockout

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
    // 'mismatch'
    return res.status(400).json({
      success: false,
      message: `Incorrect OTP. ${result.attemptsRemaining} attempt(s) remaining before a temporary lockout.`,
      attemptsRemaining: result.attemptsRemaining,
    });
  }

  // Success — moves order.status from 'out_for_delivery' to 'otp_verified'.
  // riderStatus is untouched here; the rider's next call is still
  // PUT /orders/:id/status { status: 'delivered' }, which the OTP gate
  // above will now allow.
  order.advanceStatus('otp_verified', `Delivery OTP verified by rider (${req.user.name})`);
  await order.save();

  order.clearOtpSecrets();
  res.json({ success: true, message: 'OTP verified — you can now complete the delivery.', data: order });
});
