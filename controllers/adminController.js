const { initiateOrderRefund } = require('../services/refundService');
'use strict';

const PlatformRating = require('../models/PlatformRating');
const asyncHandler = require('express-async-handler');
const { releaseOrderInventory } = require('../services/inventoryReservationService');
const bcrypt       = require('bcryptjs');
const User         = require('../models/User');
const Order        = require('../models/Order');
const Restaurant   = require('../models/Restaurant');
const Menu = require('../models/Menu');
const InventoryMovement = require('../models/InventoryMovement');
const Review       = require('../models/Review');
const generateToken = require('../utils/generateToken');
const { uploadToCloudinary } = require('../utils/riderUpload');
const { logAdminAction } = require('../services/auditService');
const { commissionRateForDeliveryMode, commissionPlanForDeliveryMode } = require('../services/commissionService');
const { operationalStatus, getLocalContext } = require('../services/restaurantHours');
const { setAccountFreeze } = require('../services/customerTrustService');

const ADMIN_ROLES = ['admin'];
const VEHICLE_TYPES = ['bike', 'scooter', 'bicycle', 'car'];

// Staff accounts (admin, vendor, rider) can read every customer's name,
// phone number and home address. Six characters is not enough for that.
const STAFF_MIN_PASSWORD = 10;

const clampPage = (value) => Math.max(1, Number(value) || 1);
const clampLimit = (value, fallback = 20, max = 100) => Math.min(max, Math.max(1, Number(value) || fallback));

function assertAdmin(req, res) {
  if (!req.user || !ADMIN_ROLES.includes(req.user.role)) {
    res.status(403).json({ success: false, message: 'Access denied. Admin credentials required.' });
    return false;
  }
  return true;
}

exports.adminLogin = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ success: false, message: 'Email and password are required.' });

  const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password');

  // One reply for every failure mode, and the bcrypt compare runs either way.
  //
  // The old code returned 403 "Admin account required" for a registered
  // non-admin email and 401 for an unknown one, before checking the password —
  // a free oracle for testing whether any given email has an Eatswada account.
  // Comparing against a dummy hash when the user is missing keeps the response
  // time flat too, so timing doesn't leak what the status code no longer does.
  const DUMMY_HASH = '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const isMatch = await bcrypt.compare(password, user?.password || DUMMY_HASH);

  if (!user || !user.password || !isMatch || !ADMIN_ROLES.includes(user.role)) {
    return res.status(401).json({ success: false, message: 'Invalid credentials.' });
  }
  if (!user.isActive) return res.status(401).json({ success: false, message: 'Account deactivated.' });

  user.lastLogin = new Date();
  await user.save();

  res.json({
    success: true,
    data: {
      token: generateToken(user._id, user.role, user.tokenVersion),
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    },
  });
});

exports.getMetrics = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const [revenueResult, todayResult, rateResult, restaurantCount, userCount, cancelledToday] =
    await Promise.all([
      Order.aggregate([{ $match: { status: 'delivered' } }, { $group: { _id: null, totalRevenue: { $sum: '$total' }, totalOrders: { $sum: 1 } } }]),
      Order.aggregate([{ $match: { createdAt: { $gte: todayStart } } }, { $group: { _id: null, ordersToday: { $sum: 1 }, revenueToday: { $sum: '$total' } } }]),
      Order.aggregate([{ $match: { status: { $in: ['delivered', 'cancelled'] } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      Restaurant.countDocuments({ isActive: true }),
      User.countDocuments({ role: 'user', isActive: true }),
      Order.countDocuments({ status: 'cancelled', createdAt: { $gte: todayStart } }),
    ]);
  const rd = revenueResult[0] ?? null;
  const td = todayResult[0] ?? null;
  let delivered = 0, cancelled = 0;
  for (const r of (rateResult || [])) {
    if (r._id === 'delivered') delivered = r.count;
    if (r._id === 'cancelled') cancelled = r.count;
  }
  const term = delivered + cancelled;
  res.json({ success: true, data: {
    totalRevenue: rd?.totalRevenue ?? 0, totalOrders: rd?.totalOrders ?? 0,
    ordersToday: td?.ordersToday ?? 0, revenueToday: td?.revenueToday ?? 0,
    successRate: term > 0 ? Math.round((delivered / term) * 100) : 0,
    onlineRestaurants: restaurantCount, totalCustomers: userCount,
    cancelledToday, activeRiders: 0, avgDeliveryTime: 40,
  }});
});

exports.getOrders = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const { status, search } = req.query;
  const page = clampPage(req.query.page);
  const limit = clampLimit(req.query.limit, 25, 100);
  const filter = {};
  if (status) filter.status = status.toLowerCase();
  if (search) filter.$or = [{ orderNumber: { $regex: search, $options: 'i' } }, { restaurantName: { $regex: search, $options: 'i' } }];
  const skip = (page - 1) * limit;
  const [orders, total] = await Promise.all([
    Order.find(filter).populate('user', 'name phone email').sort({ createdAt: -1 }).skip(skip).limit(limit),
    Order.countDocuments(filter),
  ]);
  res.json({ success: true, data: { orders: orders.map(o => ({
    id: o._id, orderNumber: o.orderNumber, customerName: o.user?.name ?? 'Unknown',
    customerPhone: o.user?.phone ?? '', restaurantName: o.restaurantName,
    totalAmount: o.total, status: o.status.toUpperCase(),
    paymentMethod: o.paymentMethod,
    commission: o.commission || { rate: 15, baseAmount: o.subtotal || 0, amount: 0, restaurantNetAmount: o.subtotal || 0 },
    riderName: null, createdAt: o.createdAt,
  })), total, page: Number(page), pages: Math.ceil(total / limit) }});
});

exports.updateOrderStatus = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const { status } = req.body || {};
  const target = String(status || '').toLowerCase();
  const transitions = {
    placed: ['confirmed', 'cancelled'],
    confirmed: ['preparing', 'cancelled'],
    preparing: ['waiting_for_rider', 'cancelled'],
    waiting_for_rider: ['assigned', 'cancelled'],
    assigned: ['out_for_delivery', 'cancelled'],
    out_for_delivery: ['otp_verified', 'cancelled'],
    otp_verified: ['delivered'],
  };
  if (!Object.keys(transitions).some(k => transitions[k].includes(target))) {
    return res.status(400).json({ success: false, message: 'Invalid or terminal order status.' });
  }
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  if (!(transitions[order.status] || []).includes(target)) {
    return res.status(409).json({ success: false, message: `Cannot move order from "${order.status}" to "${target}".` });
  }
  if (target === 'delivered' && !order.deliveryOtpVerified) {
    return res.status(409).json({ success: false, message: 'Delivery OTP must be verified before an order can be marked delivered.' });
  }
  const previousStatus = order.status;
  order.advanceStatus(target, 'Updated by admin');
  await order.save();
  if (target === 'delivered') await require('../services/settlementService').ensureOrderLedger(order);
  await logAdminAction(req, {
    action: 'order.status.update',
    targetType: 'order',
    targetId: order._id,
    targetLabel: order.orderNumber || String(order._id),
    oldValue: { status: previousStatus },
    newValue: { status: order.status },
  });
  res.json({ success: true, data: order });
});

exports.cancelOrder = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  if (['delivered', 'cancelled'].includes(order.status)) {
    return res.status(409).json({ success: false, message: `Cannot cancel an order that is already ${order.status}.` });
  }
  const reason = String(req.body?.reason || 'Cancelled by admin').trim().slice(0, 200);
  const previousStatus = order.status;
  order.advanceStatus('cancelled', reason);
  order.cancelReason = reason;
  // Launch-fix: persist the cancellation first, then refund (atomic claim).
  await order.save();
  await releaseOrderInventory(order, req.user._id);
  await initiateOrderRefund(order, reason);
  await logAdminAction(req, {
    action: 'order.cancel',
    targetType: 'order',
    targetId: order._id,
    targetLabel: order.orderNumber || String(order._id),
    oldValue: { status: previousStatus },
    newValue: { status: order.status, reason },
  });
  res.json({ success: true, data: order });
});

// ─────────────────────────────────────────────────────────────────────
// Pillar 7 — Live Order War Room overrides.
//
// Three emergency levers for the ops desk when a normal transition is stuck:
//   force-accept   vendor is unresponsive -> accept on their behalf (+KPT)
//   force-dispatch skip the delayed-dispatch window -> assign a rider now
//   force-deliver  OTP cannot be delivered (no network at the door)
//
// Every override requires a reason, is written to AdminAuditLog, and is also
// appended to the order's own adminOverrides history.
// ─────────────────────────────────────────────────────────────────────

function pushOrderOverride(order, action, reason, adminId) {
  order.adminOverrides = order.adminOverrides || [];
  order.adminOverrides.push({ action, reason: String(reason || '').slice(0, 300), by: adminId, at: new Date() });
}

exports.forceAcceptOrder = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const reason = String(req.body?.reason || '').trim().slice(0, 300);
  if (!reason) return res.status(400).json({ success: false, message: 'A reason is required for a force-accept override.' });

  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  // Force-accept acts on the vendor's behalf, so the order must belong to a
  // restaurant. (Acceptance is intentionally allowed before payment — the
  // checkout/payment lifecycle lets the kitchen accept first; the payment
  // prerequisite is enforced at rider acceptance / delivery, not here.)
  if (!order.restaurant) {
    return res.status(409).json({ success: false, message: 'This order has no restaurant and cannot be accepted.' });
  }
  if (['delivered', 'cancelled'].includes(order.status)) {
    return res.status(409).json({ success: false, message: `Cannot force-accept an order that is already ${order.status}.` });
  }
  if (['preparing', 'waiting_for_rider', 'assigned', 'out_for_delivery'].includes(order.status)) {
    return res.status(409).json({ success: false, message: `Order is already past vendor acceptance (${order.status}).` });
  }

  const previousStatus = order.status;
  // Accept on the vendor's behalf. KPT = kitchen prep time; the platform
  // default prep window is used so dispatch scheduling still works.
  const prepMinutes = Number(order.prepMinutes) > 0 ? Number(order.prepMinutes) : 15;
  const now = new Date();
  const prepStartedAt = order.prepStartedAt || now;
  const setFields = {
    status: 'preparing',
    vendorAcceptedAt: now,
    prepStartedAt,
    prepReadyAt: new Date(prepStartedAt.getTime() + prepMinutes * 60000),
    dispatchNotBefore: new Date(prepStartedAt.getTime() + Math.max(0, prepMinutes - 12) * 60000),
  };
  if (!(Number(order.prepMinutes) > 0)) setFields.prepMinutes = prepMinutes;

  // Conditional on the pre-acceptance status so a retried / concurrent
  // force-accept cannot transition the order twice.
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: order.status },
    {
      $set: setFields,
      $push: {
        statusHistory: { status: 'preparing', note: `Force-accepted by admin (${reason})` },
        adminOverrides: { action: 'force_accept', reason: String(reason || '').slice(0, 300), by: req.user._id, at: now },
      },
    },
    { new: true }
  );
  if (!updated) {
    return res.status(409).json({ success: false, message: 'This order changed concurrently. Refresh and try again.' });
  }

  await logAdminAction(req, {
    action: 'order.force_accept',
    targetType: 'order',
    targetId: order._id,
    targetLabel: order.orderNumber || String(order._id),
    oldValue: { status: previousStatus },
    newValue: { status: 'preparing', reason, prepMinutes },
  });
  res.json({ success: true, data: updated });
});

exports.forceDispatchOrder = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const reason = String(req.body?.reason || '').trim().slice(0, 300);
  if (!reason) return res.status(400).json({ success: false, message: 'A reason is required for a force-dispatch override.' });

  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  if (['delivered', 'cancelled'].includes(order.status)) {
    return res.status(409).json({ success: false, message: `Cannot force-dispatch an order that is already ${order.status}.` });
  }
  if (['out_for_delivery', 'picked_up'].includes(order.riderStatus)) {
    return res.status(409).json({ success: false, message: 'A rider is already carrying this order.' });
  }

  // Cancel the delayed-dispatch window so autoAssignRider dispatches NOW.
  order.dispatchNotBefore = null;
  order.isFoodReady = true;
  order.orderReadyAt = order.orderReadyAt || new Date();
  order.dispatchStartedAt = order.dispatchStartedAt || new Date();
  pushOrderOverride(order, 'force_dispatch', reason, req.user._id);
  await order.save();

  const { autoAssignRider } = require('../services/riderAssignmentService');
  const assignment = await autoAssignRider(order);
  const fresh = await Order.findById(order._id);

  await logAdminAction(req, {
    action: 'order.force_dispatch',
    targetType: 'order',
    targetId: order._id,
    targetLabel: order.orderNumber || String(order._id),
    newValue: { reason, assigned: !!assignment?.rider, riderId: assignment?.rider?._id || null },
  });
  res.json({ success: true, data: { order: fresh, assignment } });
});

exports.forceDeliverOrder = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const reason = String(req.body?.reason || '').trim().slice(0, 300);
  if (!reason) return res.status(400).json({ success: false, message: 'A reason is required for a force-deliver override.' });

  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  if (order.status === 'delivered') return res.status(409).json({ success: false, message: 'Order is already delivered.' });
  if (order.status === 'cancelled') return res.status(409).json({ success: false, message: 'A cancelled order cannot be force-delivered.' });
  if (!order.rider) return res.status(409).json({ success: false, message: 'Assign a rider before force-delivering an order.' });

  const isCod = String(order.paymentMethod || '').toLowerCase() === 'cod';

  // Payment-state integrity (Pillar 7). An unpaid ONLINE order must not be
  // force-delivered: there is no collected money to settle. COD is different —
  // the cash is taken at the door, so it only needs an explicit, validated
  // cash-collection confirmation.
  if (!isCod) {
    if (order.paymentStatus !== 'paid') {
      return res.status(409).json({
        success: false,
        message: `Cannot force-deliver an unpaid online order (payment status: ${order.paymentStatus}). Recover the payment first.`,
      });
    }
  } else {
    // Never treat an absent / null / malformed confirmation as success.
    const codCashCollected = req.body?.codCashCollected === true;
    if (!codCashCollected) {
      return res.status(409).json({
        success: false,
        code: 'COD_CASH_NOT_COLLECTED',
        message: 'Confirm the COD cash was collected (codCashCollected: true) before force-delivering.',
      });
    }
  }

  const previousStatus = order.status;
  const previousPaymentStatus = order.paymentStatus;

  // ── ATOMIC FORCE-DELIVER ───────────────────────────────────
  // Conditional on the current status so a retried / concurrent force-deliver
  // cannot transition twice or credit COD cash twice.
  const { computeRiderEarning } = require('../services/riderEarningService');
  const { creditRiderCashForOrder } = require('../services/settlementService');
  const earningBreakdown = await computeRiderEarning(order);
  const now = new Date();
  const setFields = {
    status: 'delivered',
    deliveredAt: now,
    isCancellable: false,
    deliveryOtpVerified: true,
    deliveryOtpBypassReason: reason,
    riderStatus: 'delivered',
    riderEarningBreakdown: earningBreakdown,
    riderEarning: earningBreakdown.total,
    riderWaitTimeMinutes: earningBreakdown.waitTimeMinutes,
    riderCashCreditedAt: null,
  };
  if (isCod) {
    setFields.paymentStatus = 'cod_collected';
    setFields.cashCollected = true;
    setFields.codCollectedAt = now;
    setFields.codCashCollectedAmount = Number(order.total || 0);
  }
  const adminOverrides = order.adminOverrides || [];
  adminOverrides.push({ action: 'force_deliver', reason: String(reason || '').slice(0, 300), by: req.user._id, at: now });

  const { withRequiredTransaction } = require('../services/dbTransaction');
  const updated = await withRequiredTransaction(async (session) => {
    const claimed = await Order.findOneAndUpdate(
      { _id: order._id, status: order.status, rider: order.rider, paymentMethod: order.paymentMethod, paymentStatus: order.paymentStatus },
      {
        $set: setFields,
        $push: {
          statusHistory: { status: 'delivered', note: `Force-delivered by admin (${reason})` },
          adminOverrides: adminOverrides[adminOverrides.length - 1],
        },
      },
      { new: true, session: session || undefined }
    );
    if (!claimed) return null;
    if (isCod) await creditRiderCashForOrder(claimed, { session });
    await require('../services/settlementService').ensureOrderLedger(claimed, session);
    await require('../services/settlementService').ensureRiderLedger(claimed, session);
    return claimed;
  });

  if (!updated) {
    return res.status(409).json({ success: false, message: 'This order changed concurrently. Refresh and try again.' });
  }

  await logAdminAction(req, {
    action: 'order.force_deliver',
    targetType: 'order',
    targetId: order._id,
    targetLabel: order.orderNumber || String(order._id),
    oldValue: { status: previousStatus, paymentStatus: previousPaymentStatus, otpVerified: false },
    newValue: { status: 'delivered', paymentStatus: isCod ? 'cod_collected' : previousPaymentStatus, otpVerified: true, reason, codCashCollected: isCod },
  });
  res.json({ success: true, data: updated });
});

// ─────────────────────────────────────────────────────────────────────
// Pillar 1 — live delivery-capacity view for the dashboard shortage card.
// ─────────────────────────────────────────────────────────────────────
exports.getDeliveryCapacity = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const { getZoneDeliveryCapacity } = require('../services/riderAssignmentService');
  const { getPlatformSettings } = require('../services/platformSettingsService');
  const zone = String(req.query.zone || '').trim();
  const [capacity, settings] = await Promise.all([getZoneDeliveryCapacity(zone), getPlatformSettings()]);
  res.json({ success: true, data: {
    capacity,
    settings: {
      isUnderMaintenance: settings.isUnderMaintenance,
      isDeliveryPausedShortage: settings.isDeliveryPausedShortage,
      autoShortageCircuitBreaker: settings.autoShortageCircuitBreaker,
      maxActiveOrdersPerOnlineRider: settings.maxActiveOrdersPerOnlineRider,
      isRainSurgeActive: settings.isRainSurgeActive,
    },
  } });
});

exports.updateRestaurantFssai = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const status = req.body?.status;
  if (!['pending','verified','expired','rejected'].includes(status)) return res.status(400).json({success:false,message:'FSSAI status must be pending, verified, expired, or rejected.'});
  const restaurant = await Restaurant.findById(req.params.id).select('_id name fssaiLicenseNumber fssaiCertificateUrl fssaiExpiryDate fssaiVerificationStatus');
  if (!restaurant) return res.status(404).json({success:false,message:'Restaurant not found.'});
  const previous={status:restaurant.fssaiVerificationStatus||'pending',verifiedAt:restaurant.fssaiVerifiedAt||null};
  restaurant.fssaiVerificationStatus=status;
  restaurant.fssaiVerifiedAt=status==='verified'?new Date():null;
  // Persist the license number when an admin edits an existing restaurant.
  // Saving a number does not itself verify that the license is genuine.
  if (req.body?.fssaiLicenseNumber !== undefined) {
    restaurant.fssaiLicenseNumber = String(req.body.fssaiLicenseNumber || '').trim().slice(0, 100);
  }
  if (req.body?.certificateUrl !== undefined) restaurant.fssaiCertificateUrl=String(req.body.certificateUrl||'').trim().slice(0,2000);
  if (req.body?.expiryDate !== undefined) restaurant.fssaiExpiryDate=req.body.expiryDate ? new Date(req.body.expiryDate) : null;
  await restaurant.save();
  await logAdminAction(req,{action:'restaurant.fssai.verify',targetType:'restaurant',targetId:restaurant._id,targetLabel:restaurant.name,oldValue:previous,newValue:{status:restaurant.fssaiVerificationStatus,verifiedAt:restaurant.fssaiVerifiedAt,licenseNumberUpdated:req.body?.fssaiLicenseNumber!==undefined}});
  res.json({success:true,data:restaurant});
});

exports.getRestaurantCommission = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const restaurant = await Restaurant.findById(req.params.id).select('_id name commissionRate isActive approvalStatus');
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found.' });

  res.json({
    success: true,
    data: {
      restaurantId: restaurant._id,
      restaurantName: restaurant.name,
      commissionRate: Number.isFinite(Number(restaurant.commissionRate)) ? Number(restaurant.commissionRate) : 15,
      isActive: restaurant.isActive,
      approvalStatus: restaurant.approvalStatus,
    },
  });
});

exports.updateRestaurantCommission = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;

  const rawRate = req.body?.commissionRate;
  const rate = Number(rawRate);
  if (rawRate === '' || rawRate === null || rawRate === undefined || !Number.isFinite(rate) || rate < 0 || rate > 100) {
    return res.status(400).json({
      success: false,
      message: 'commissionRate must be a number between 0 and 100.',
    });
  }

  const normalizedRate = Math.round(rate * 100) / 100;
  const restaurant = await Restaurant.findById(req.params.id);
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found.' });

  const previousRate = restaurant.commissionRate;
  restaurant.commissionRate = normalizedRate;
  await restaurant.save();

  await logAdminAction(req, {
    action: 'restaurant.commission.update',
    targetType: 'restaurant',
    targetId: restaurant._id,
    targetLabel: restaurant.name,
    oldValue: { commissionRate: previousRate },
    newValue: { commissionRate: restaurant.commissionRate },
  });

  res.json({
    success: true,
    message: 'Restaurant commission rate updated. Existing orders keep their original commission snapshots.',
    data: {
      restaurantId: restaurant._id,
      restaurantName: restaurant.name,
      commissionRate: restaurant.commissionRate,
    },
  });
});


exports.getRestaurantDeliverySettings = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const restaurant = await Restaurant.findById(req.params.id).select('_id name businessType deliveryMode commissionPlan commissionRate maxActiveOrders settlementSchedule fssaiLicenseNumber fssaiCertificateUrl fssaiExpiryDate fssaiVerificationStatus');
  if (!restaurant) return res.status(404).json({success:false,message:'Restaurant not found.'});
  res.json({success:true,data:restaurant});
});

exports.updateRestaurantDeliverySettings = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const restaurant = await Restaurant.findById(req.params.id);
  if (!restaurant) return res.status(404).json({success:false,message:'Restaurant not found.'});

  const body=req.body||{};
  const before={ businessType:restaurant.businessType||'restaurant', deliveryMode:restaurant.deliveryMode||'eatswada_rider', commissionPlan:restaurant.commissionPlan||'legacy', commissionRate:Number(restaurant.commissionRate)||15, maxActiveOrders:restaurant.maxActiveOrders||10, settlementSchedule:restaurant.settlementSchedule||'weekly' };

  if (body.businessType!==undefined) {
    if(!['restaurant','cloud_kitchen'].includes(body.businessType)) return res.status(400).json({success:false,message:'businessType must be restaurant or cloud_kitchen.'});
    restaurant.businessType=body.businessType;
  }
  if (body.deliveryMode!==undefined) {
    if(!['self_delivery','eatswada_rider'].includes(body.deliveryMode)) return res.status(400).json({success:false,message:'deliveryMode must be self_delivery or eatswada_rider.'});
    restaurant.deliveryMode=body.deliveryMode;
  }
  if (body.maxActiveOrders!==undefined) {
    const cap=Number(body.maxActiveOrders); if(!Number.isInteger(cap)||cap<1||cap>500)return res.status(400).json({success:false,message:'maxActiveOrders must be an integer between 1 and 500.'});
    restaurant.maxActiveOrders=cap;
  }
  if (body.settlementSchedule!==undefined) {
    if(!['weekly','monthly'].includes(body.settlementSchedule))return res.status(400).json({success:false,message:'settlementSchedule must be weekly or monthly.'});
    restaurant.settlementSchedule=body.settlementSchedule;
  }

  // Delivery mode determines the standard commercial plan. An explicit
  // commissionRate is allowed only when the admin chooses the custom plan.
  if (body.commissionRate!==undefined) {
    const rate=Number(body.commissionRate); if(!Number.isFinite(rate)||rate<0||rate>100)return res.status(400).json({success:false,message:'commissionRate must be between 0 and 100.'});
    restaurant.commissionRate=Math.round(rate*100)/100;
    restaurant.commissionPlan='custom';
  } else if (body.deliveryMode!==undefined) {
    restaurant.commissionRate=commissionRateForDeliveryMode(restaurant.deliveryMode);
    restaurant.commissionPlan=commissionPlanForDeliveryMode(restaurant.deliveryMode);
  }

  await restaurant.save();
  await logAdminAction(req,{action:'restaurant.delivery-settings.update',targetType:'restaurant',targetId:restaurant._id,targetLabel:restaurant.name,oldValue:before,newValue:{businessType:restaurant.businessType,deliveryMode:restaurant.deliveryMode,commissionPlan:restaurant.commissionPlan,commissionRate:restaurant.commissionRate,maxActiveOrders:restaurant.maxActiveOrders,settlementSchedule:restaurant.settlementSchedule}});
  res.json({success:true,message:'Restaurant delivery and operational settings updated. Existing orders retain their snapshots.',data:restaurant});
});

exports.getRestaurants = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const { search, status = 'active' } = req.query;
  const filter = {};
  // Active restaurants are the normal admin list. Legacy inactive records are
  // available only when the admin explicitly selects the inactive cleanup view.
  if (status !== 'inactive') filter.isActive = true;
  else filter.isActive = false;
  if (search) filter.name = { $regex: search, $options: 'i' };
  const restaurants = await Restaurant.find(filter).populate('owner', 'name phone email').sort({ homeOrder: 1, isFeatured: -1, displayPriority: -1, createdAt: -1 });
  const now = new Date();
  const hoursContext = getLocalContext(now);
  res.json({ success: true, data: restaurants.map(r => ({
    id: r._id, name: r.name, ownerName: r.owner?.name ?? '',
    phone: r.owner?.phone ?? '', address: r.address ?? '',
    cuisine: r.cuisineDisplay || (r.cuisine || []).join(', '),
    rating: r.rating, ratingCount: r.ratingCount, reviewCount: r.reviewCount || 0, displayPriority: r.displayPriority || 0, homeOrder: r.homeOrder ?? 999999, isFeatured: !!r.isFeatured, isBestSeller: !!r.isBestSeller, isNearFast: !!r.isNearFast, avgPrepTime: r.estimatedDeliveryMin ?? 20,
    isOpen: r.isOpen, isActive: r.isActive, approvalStatus: r.approvalStatus, rejectionReason: r.rejectionReason, commissionRate: Number.isFinite(Number(r.commissionRate)) ? Number(r.commissionRate) : 15, totalOrders: r.totalOrders, image: r.image, createdAt: r.createdAt,
    openingHours: r.openingHours, availability: r.availability,
    // Expose computed state separately; keep isOpen/availability as persisted
    // manual settings for backward-compatible admin actions.
    operational: operationalStatus(r, now, hoursContext),
  }))});
});

exports.toggleRestaurant = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const restaurant = await Restaurant.findById(req.params.id);
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found.' });
  if (!restaurant.isActive) {
    return res.status(409).json({ success: false, message: 'This restaurant is deactivated. Restore it before changing its open/closed status.' });
  }
  // This legacy toggle is an explicit manual override. Mirror both fields and
  // persist a reason so auto-hours cannot immediately undo a manual closure.
  const isCurrentlyManuallyClosed = restaurant.availability?.status === 'temporarily_closed'
    || restaurant.availability?.status === 'closed_today'
    || restaurant.availability?.isOpen === false;
  const nextOpen = isCurrentlyManuallyClosed;
  restaurant.isOpen = nextOpen;
  restaurant.availability.isOpen = nextOpen;
  restaurant.availability.status = nextOpen ? 'open' : 'temporarily_closed';
  restaurant.availability.closedReason = nextOpen ? '' : 'temporarily_closed';
  await restaurant.save();
  const now = new Date();
  res.json({ success: true, data: { isOpen: restaurant.isOpen, operational: operationalStatus(restaurant, now, getLocalContext(now)) } });
});

exports.getRecentOrders = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const orders = await Order.find({}).populate('user', 'name').sort({ createdAt: -1 }).limit(10);
  res.json({ success: true, data: orders.map(o => ({
    id: o._id, restaurantName: o.restaurantName, customerName: o.user?.name ?? 'Unknown',
    status: o.status.toUpperCase(), totalAmount: o.total, createdAt: o.createdAt,
  }))});
});

exports.getPeakHours = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const result = await Order.aggregate([
    { $match: { createdAt: { $gte: todayStart } } },
    { $group: { _id: { $hour: '$createdAt' }, orders: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  const hours = Array.from({ length: 24 }, (_, i) => {
    const found = result.find(r => r._id === i);
    return { hour: `${i}:00`, orders: found ? found.orders : 0 };
  });
  res.json({ success: true, data: hours });
});

exports.getCustomers = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const { search } = req.query;
  const page = clampPage(req.query.page);
  const limit = clampLimit(req.query.limit, 20, 100);
  const filter = { role: 'user', isActive: true };
  if (search) filter.$or = [{ name: { $regex: search, $options: 'i' } }, { phone: { $regex: search, $options: 'i' } }, { email: { $regex: search, $options: 'i' } }];
  const skip = (page - 1) * limit;
  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);
  const orderAgg = await Order.aggregate([
    { $match: { user: { $in: users.map(u => u._id) } } },
    { $group: { _id: '$user', totalOrders: { $sum: 1 }, totalSpent: { $sum: '$total' } } },
  ]);
  const orderMap = new Map(orderAgg.map(a => [String(a._id), a]));
  res.json({ success: true, data: { customers: users.map(u => {
    const s = orderMap.get(String(u._id)) ?? { totalOrders: 0, totalSpent: 0 };
    return { id: u._id, name: u.name, phone: u.phone, email: u.email ?? '', totalOrders: s.totalOrders, totalSpent: s.totalSpent, createdAt: u.createdAt };
  }), total, page: Number(page), pages: Math.ceil(total / limit) }});
});

exports.getRevenueAnalytics = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const { period = '7d' } = req.query;
  const days = period === '30d' ? 30 : period === '90d' ? 90 : 14;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await Order.aggregate([
    { $match: { createdAt: { $gte: since }, status: { $ne: 'cancelled' } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  res.json({ success: true, data: result.map(r => ({ date: r._id, revenue: r.revenue, orders: r.orders })) });
});

exports.getTopRestaurants = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const result = await Order.aggregate([
    { $match: { status: 'delivered' } },
    { $group: { _id: '$restaurant', name: { $first: '$restaurantName' }, orders: { $sum: 1 }, revenue: { $sum: '$total' } } },
    { $sort: { orders: -1 } },
    { $limit: 10 },
  ]);
  res.json({ success: true, data: result.map(r => ({ id: r._id, name: r.name, orders: r.orders, revenue: r.revenue })) });
});

/* ─────────────────────────────────────────────────────────────
 *  VENDOR MANAGEMENT
 *  (vendor *creation* stays in authController.createVendor — this
 *  is read/update/deactivate for accounts that already exist.)
 * ───────────────────────────────────────────────────────────── */

exports.getVendors = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const { search, status } = req.query;
  const page = clampPage(req.query.page);
  const limit = clampLimit(req.query.limit, 20, 100);
  const filter = { role: 'vendor' };
  if (status === 'active') filter.isActive = true;
  if (status === 'inactive') filter.isActive = false;
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
    ];
  }
  const skip = (page - 1) * limit;
  const [vendors, total] = await Promise.all([
    User.find(filter)
      .populate('restaurantId', 'name image isActive isOpen')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments(filter),
  ]);
  res.json({
    success: true,
    data: {
      vendors: vendors.map((v) => ({
        id: v._id,
        name: v.name,
        email: v.email,
        phone: v.phone,
        isActive: v.isActive,
        restaurant: v.restaurantId
          ? {
              id: v.restaurantId._id,
              name: v.restaurantId.name,
              image: v.restaurantId.image,
              isActive: v.restaurantId.isActive,
              isOpen: v.restaurantId.isOpen,
            }
          : null,
        lastLogin: v.lastLogin,
        createdAt: v.createdAt,
      })),
      total,
      page: Number(page),
      pages: Math.ceil(total / limit),
    },
  });
});

exports.getVendorById = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const vendor = await User.findOne({ _id: req.params.id, role: 'vendor' }).populate('restaurantId');
  if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found.' });
  res.json({ success: true, data: vendor });
});

exports.updateVendor = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const vendor = await User.findOne({ _id: req.params.id, role: 'vendor' });
  if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found.' });

  const { name, email, phone, password } = req.body;

  if (email !== undefined) {
    const normalized = String(email).toLowerCase().trim();
    if (normalized !== vendor.email) {
      const clash = await User.findOne({ email: normalized, _id: { $ne: vendor._id } });
      if (clash) return res.status(409).json({ success: false, message: 'Email is already in use by another account.' });
      vendor.email = normalized;
    }
  }

  if (phone !== undefined) {
    const normalized = String(phone).trim();
    if (normalized !== vendor.phone) {
      const clash = await User.findOne({ phone: normalized, _id: { $ne: vendor._id } });
      if (clash) return res.status(409).json({ success: false, message: 'Phone number is already in use by another account.' });
      vendor.phone = normalized;
    }
  }

  if (name !== undefined) vendor.name = String(name).trim();

  if (password !== undefined && password !== '') {
    if (password.length < STAFF_MIN_PASSWORD) {
      return res.status(400).json({ success: false, message: 'Password must be at least 10 characters.' });
    }
    vendor.password = password; // re-hashed by the User pre('save') hook
  }

  try {
    await vendor.save();
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }

  res.json({
    success: true,
    message: 'Vendor updated successfully.',
    data: {
      id: vendor._id,
      name: vendor.name,
      email: vendor.email,
      phone: vendor.phone,
      isActive: vendor.isActive,
      restaurantId: vendor.restaurantId,
    },
  });
});

// Soft-deactivate / reactivate — mirrors the isActive pattern already used
// for Restaurant. A vendor account is never hard-deleted: their orders and
// restaurant history must survive.
exports.toggleVendorStatus = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const vendor = await User.findOne({ _id: req.params.id, role: 'vendor' });
  if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found.' });

  const vendorWasActive = vendor.isActive;
  vendor.isActive = !vendor.isActive;
  await vendor.save();

  await logAdminAction(req, {
    action: 'vendor.status.toggle',
    targetType: 'vendor',
    targetId: vendor._id,
    targetLabel: vendor.name || vendor.email || '',
    oldValue: { isActive: vendorWasActive },
    newValue: { isActive: vendor.isActive },
  });

  // Deactivating the vendor's login should also take their restaurant off
  // the live menu — it can no longer be managed if nobody can log in to it.
  if (!vendor.isActive && vendor.restaurantId) {
    await Restaurant.findByIdAndUpdate(vendor.restaurantId, { $set: { isOpen: false, 'availability.isOpen': false, 'availability.closedReason': 'temporarily_closed' } });
  }

  res.json({
    success: true,
    message: vendor.isActive ? 'Vendor reactivated.' : 'Vendor deactivated.',
    data: { id: vendor._id, isActive: vendor.isActive },
  });
});

/* ─────────────────────────────────────────────────────────────
 *  RIDER MANAGEMENT
 *  Riders are User documents with role: 'rider' and a nested
 *  riderDetails object (see models/User.js). Login lives in
 *  authController.riderLogin — this is admin CRUD only.
 * ───────────────────────────────────────────────────────────── */

// Order statuses where a rider is actively mid-delivery — used to block
// deletion and to block silently reassigning the order to someone else.
const RIDER_ACTIVE_STATUSES = ['assigned', 'accepted', 'reached_restaurant', 'picked_up', 'out_for_delivery'];

exports.createRider = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;

  const { name, email, phone, password, vehicleType, vehicleNumber, deliveryZone } = req.body;

  if (!name?.trim() || !email || !phone || !password) {
    return res.status(400).json({
      success: false,
      message: 'name, email, phone, and password are required.',
    });
  }
  if (password.length < STAFF_MIN_PASSWORD) {
    return res.status(400).json({ success: false, message: 'Password must be at least 10 characters.' });
  }
  if (!VEHICLE_TYPES.includes(vehicleType)) {
    return res.status(400).json({
      success: false,
      message: `vehicleType must be one of: ${VEHICLE_TYPES.join(', ')}.`,
    });
  }
  if (!vehicleNumber?.trim()) {
    return res.status(400).json({ success: false, message: 'vehicleNumber is required.' });
  }
  if (!deliveryZone?.trim()) {
    return res.status(400).json({ success: false, message: 'deliveryZone is required.' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const normalizedPhone = phone.trim();
  const normalizedVehicleNumber = vehicleNumber.trim().toUpperCase();

  const existing = await User.findOne({ $or: [{ email: normalizedEmail }, { phone: normalizedPhone }] });
  if (existing) {
    return res.status(409).json({ success: false, message: 'A user with this email or phone number already exists.' });
  }

  const vehicleClash = await User.findOne({ role: 'rider', 'riderDetails.vehicleNumber': normalizedVehicleNumber });
  if (vehicleClash) {
    return res.status(409).json({ success: false, message: 'A rider with this vehicle number already exists.' });
  }

  // Profile picture is optional at creation time — a rider can also upload
  // / replace their own via PUT /api/riders/profile/photo after logging in.
  let avatarUrl = '';
  if (req.file) {
    const result = await uploadToCloudinary(req.file.buffer, req.file.mimetype, 'nearbite/riders');
    avatarUrl = result.secure_url;
  }

  let rider;
  try {
    rider = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      phone: normalizedPhone,
      password, // hashed by the User pre('save') hook — do not hash here
      role: 'rider',
      avatar: avatarUrl,
      isActive: true,
      isPhoneVerified: true,
      riderDetails: {
        vehicleType,
        vehicleNumber: normalizedVehicleNumber,
        deliveryZone: deliveryZone.trim(),
        isOnline: false,
      },
    });
  } catch (err) {
    return res.status(400).json({ success: false, message: `Could not create rider: ${err.message}` });
  }

  res.status(201).json({
    success: true,
    message: 'Rider account created successfully.',
    data: rider,
  });
});

exports.getRiders = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const { search, status, online, zone } = req.query;
  const page = clampPage(req.query.page);
  const limit = clampLimit(req.query.limit, 20, 100);
  const filter = { role: 'rider' };
  if (status === 'active') filter.isActive = true;
  if (status === 'inactive') filter.isActive = false;
  if (online === 'true') filter['riderDetails.isOnline'] = true;
  if (online === 'false') filter['riderDetails.isOnline'] = false;
  if (zone) filter['riderDetails.deliveryZone'] = { $regex: zone, $options: 'i' };
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { 'riderDetails.vehicleNumber': { $regex: search, $options: 'i' } },
    ];
  }
  const skip = (page - 1) * limit;
  const [riders, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);
  res.json({
    success: true,
    data: { riders, total, page: Number(page), pages: Math.ceil(total / limit) },
  });
});

exports.getRiderById = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const rider = await User.findOne({ _id: req.params.id, role: 'rider' });
  if (!rider) return res.status(404).json({ success: false, message: 'Rider not found.' });
  res.json({ success: true, data: rider });
});

exports.updateRider = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const rider = await User.findOne({ _id: req.params.id, role: 'rider' });
  if (!rider) return res.status(404).json({ success: false, message: 'Rider not found.' });

  const { name, email, phone, password, vehicleType, vehicleNumber, deliveryZone } = req.body;

  if (email !== undefined) {
    const normalized = String(email).toLowerCase().trim();
    if (normalized !== rider.email) {
      const clash = await User.findOne({ email: normalized, _id: { $ne: rider._id } });
      if (clash) return res.status(409).json({ success: false, message: 'Email is already in use by another account.' });
      rider.email = normalized;
    }
  }

  if (phone !== undefined) {
    const normalized = String(phone).trim();
    if (normalized !== rider.phone) {
      const clash = await User.findOne({ phone: normalized, _id: { $ne: rider._id } });
      if (clash) return res.status(409).json({ success: false, message: 'Phone number is already in use by another account.' });
      rider.phone = normalized;
    }
  }

  if (name !== undefined) rider.name = String(name).trim();

  if (password !== undefined && password !== '') {
    if (password.length < STAFF_MIN_PASSWORD) {
      return res.status(400).json({ success: false, message: 'Password must be at least 10 characters.' });
    }
    rider.password = password; // re-hashed by the User pre('save') hook
  }

  rider.riderDetails = rider.riderDetails || {};

  if (vehicleType !== undefined) {
    if (!VEHICLE_TYPES.includes(vehicleType)) {
      return res.status(400).json({
        success: false,
        message: `vehicleType must be one of: ${VEHICLE_TYPES.join(', ')}.`,
      });
    }
    rider.riderDetails.vehicleType = vehicleType;
  }

  if (vehicleNumber !== undefined) {
    const normalized = String(vehicleNumber).trim().toUpperCase();
    const clash = await User.findOne({
      role: 'rider',
      'riderDetails.vehicleNumber': normalized,
      _id: { $ne: rider._id },
    });
    if (clash) return res.status(409).json({ success: false, message: 'A rider with this vehicle number already exists.' });
    rider.riderDetails.vehicleNumber = normalized;
  }

  if (deliveryZone !== undefined) rider.riderDetails.deliveryZone = String(deliveryZone).trim();

  if (req.file) {
    const result = await uploadToCloudinary(req.file.buffer, req.file.mimetype, 'nearbite/riders');
    rider.avatar = result.secure_url;
  }

  try {
    await rider.save();
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }

  res.json({
    success: true,
    message: 'Rider updated successfully.',
    data: rider,
  });
});

// Soft disable / enable — mirrors toggleVendorStatus. Order history (past
// assignments) is preserved; the rider just can't log in / go online.
exports.toggleRiderStatus = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const rider = await User.findOne({ _id: req.params.id, role: 'rider' });
  if (!rider) return res.status(404).json({ success: false, message: 'Rider not found.' });

  rider.isActive = !rider.isActive;
  if (!rider.isActive) {
    rider.riderDetails = rider.riderDetails || {};
    rider.riderDetails.isOnline = false; // a disabled rider can't stay online / receive orders
  }
  await rider.save();

  res.json({
    success: true,
    message: rider.isActive ? 'Rider reactivated.' : 'Rider disabled.',
    data: { id: rider._id, isActive: rider.isActive },
  });
});

// Hard delete — distinct from disable. Blocked while the rider has an order
// currently in progress so a delivery never loses its rider mid-flight.
// Completed/cancelled orders keep the (now-dangling) rider reference for
// historical reporting, exactly like Restaurant keeps its order history.
exports.deleteRider = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const rider = await User.findOne({ _id: req.params.id, role: 'rider' });
  if (!rider) return res.status(404).json({ success: false, message: 'Rider not found.' });

  const activeOrder = await Order.findOne({ rider: rider._id, riderStatus: { $in: RIDER_ACTIVE_STATUSES } });
  if (activeOrder) {
    return res.status(409).json({
      success: false,
      message: 'This rider has an order in progress and cannot be deleted. Reassign it first or wait for delivery to complete.',
    });
  }

  await User.findByIdAndDelete(rider._id);

  await logAdminAction(req, {
    action: 'rider.delete',
    targetType: 'rider',
    targetId: rider._id,
    targetLabel: rider.name || rider.phone || '',
    oldValue: { existed: true },
    newValue: { deleted: true },
  });

  res.json({ success: true, message: 'Rider deleted permanently.' });
});


exports.getReviews = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  const filter = {};
  if (req.query.restaurantId) filter.restaurant = req.query.restaurantId;
  if (req.query.visible === 'true') filter.isVisible = true;
  if (req.query.visible === 'false') filter.isVisible = false;
  // Moderation queue: only customer-reported reviews, most-flagged first.
  if (String(req.query.flagged || '') === 'true') filter.isFlagged = true;
  if (String(req.query.lowRated || '') === 'true') filter.score = { $lte: 2 };
  const [reviews, total] = await Promise.all([
    Review.find(filter).populate('user','name phone').populate('restaurant','name').sort({ reportedCount: -1, createdAt: -1 }).skip(skip).limit(limit),
    Review.countDocuments(filter)
  ]);
  res.json({ success: true, page, pages: Math.ceil(total/limit), total, data: reviews });
});

exports.moderateReview = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const { isVisible, adminNote = '' } = req.body;
  if (typeof isVisible !== 'boolean') return res.status(400).json({ success: false, message: 'isVisible must be boolean.' });
  const update = { isVisible, adminNote: String(adminNote).slice(0,300), moderatedBy: req.user._id, moderatedAt: new Date() };
  // Hiding a review also clears its flag so it leaves the moderation queue.
  if (isVisible === false) update.isFlagged = false;
  const review = await Review.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!review) return res.status(404).json({ success: false, message: 'Review not found.' });
  // Recalculate the restaurant's verified rating after moderation changes.
  const stats = await Review.aggregate([{ $match: { restaurant: review.restaurant, isVisible: true } }, { $group: { _id: null, avg: { $avg: '$score' }, count: { $sum: 1 } } }]);
  const s = stats[0] || { avg: 0, count: 0 };
  await Restaurant.findByIdAndUpdate(review.restaurant, { rating: s.count ? Math.round(s.avg*10)/10 : 4, ratingCount: s.count, reviewCount: s.count });
  await logAdminAction(req, { action: 'review.moderate', targetType: 'review', targetId: review._id, targetLabel: String(review._id), newValue: { isVisible, adminNote: update.adminNote } });
  res.json({ success: true, data: review });
});

// GET /api/admin/reviews/analytics — platform vs restaurant review health.
exports.getReviewAnalytics = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 86400000);
  const [restaurantAgg, platformAgg, photoAgg, flaggedCount, itemTop] = await Promise.all([
    Review.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: null, avg: { $avg: '$score' }, count: { $sum: 1 }, withPhotos: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$photos', []] } }, 0] }, 1, 0] } }, riderAvg: { $avg: '$riderScore' } } },
    ]),
    PlatformRating.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: null, avg: { $avg: '$score' }, count: { $sum: 1 } } },
    ]),
    Review.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $project: { n: { $add: [{ $size: { $ifNull: ['$photos', []] } }, { $sum: { $map: { input: { $ifNull: ['$itemRatings', []] }, as: 'i', in: { $size: { $ifNull: ['$$i.photos', []] } } } } }] } } },
      { $group: { _id: null, totalPhotos: { $sum: '$n' } } },
    ]),
    Review.countDocuments({ isFlagged: true }),
    // Best and worst rated dishes from per-item ratings.
    Review.aggregate([
      { $match: { createdAt: { $gte: since }, isVisible: true } },
      { $unwind: '$itemRatings' },
      { $group: { _id: { name: '$itemRatings.itemName' }, avg: { $avg: '$itemRatings.score' }, count: { $sum: 1 } } },
      { $match: { count: { $gte: 3 } } },
      { $sort: { avg: -1 } },
      { $limit: 5 },
    ]),
  ]);
  const r = restaurantAgg[0] || { avg: 0, count: 0, withPhotos: 0, riderAvg: 0 };
  const p = platformAgg[0] || { avg: 0, count: 0 };
  res.json({
    success: true,
    data: {
      period: `${days}d`,
      restaurantReviews: { average: Math.round((r.avg || 0) * 10) / 10, count: r.count, withPhotos: r.withPhotos, riderAverage: r.riderAvg ? Math.round(r.riderAvg * 10) / 10 : null },
      platformReviews: { average: Math.round((p.avg || 0) * 10) / 10, count: p.count },
      totalPhotos: photoAgg[0]?.totalPhotos || 0,
      flaggedReviews: flaggedCount,
      topRatedItems: itemTop.map(x => ({ itemName: x._id.name, average: Math.round(x.avg * 10) / 10, count: x.count })),
    },
  });
});

// Platform-level Rate Us feedback (separate from verified restaurant/order reviews).
exports.getPlatformRatings = asyncHandler(async (req, res) => {
  const requestedLimit = Number(req.query.limit);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 50, 1), 100);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const skip = (page - 1) * limit;
  const [rows, total, summary, distribution] = await Promise.all([
    PlatformRating.find({}).populate('user', 'name phone email').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    PlatformRating.countDocuments({}),
    PlatformRating.aggregate([{ $group: { _id: null, average: { $avg: '$score' }, count: { $sum: 1 } } }]),
    PlatformRating.aggregate([{ $group: { _id: '$score', count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
  ]);
  const avg = summary[0]?.average || 0;
  res.json({
    success: true,
    data: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    summary: { average: Math.round(avg * 10) / 10, count: summary[0]?.count || 0, distribution: Object.fromEntries(distribution.map(x => [String(x._id), x.count])) },
  });
});




// Least-privilege admin staff modules. An admin with an empty permission set
// keeps full access (back-compat); a populated set scopes them to these areas.
// Support / trust / review modules let a growing team be split by function.
const ADMIN_PERMISSION_SET = ['restaurants.manage','restaurants.delete','vendors.manage','orders.manage','finance.manage','coupons.manage','settings.manage','analytics.view','support.manage','customers.trust','reviews.moderate'];
exports.getAdminPermissions = asyncHandler(async (req,res)=>{ if(!assertAdmin(req,res)) return; const u=await User.findById(req.params.id).select('name email role permissions isActive'); if(!u||u.role!=='admin') return res.status(404).json({success:false,message:'Admin account not found.'}); res.json({success:true,data:u}); });
exports.updateAdminPermissions = asyncHandler(async (req,res)=>{ if(!assertAdmin(req,res)) return; if(String(req.user._id)===String(req.params.id)) return res.status(400).json({success:false,message:'You cannot change your own admin permissions.'}); const u=await User.findById(req.params.id).select('role permissions'); if(!u||u.role!=='admin') return res.status(404).json({success:false,message:'Admin account not found.'}); const previousPermissions=Array.isArray(u.permissions)?[...u.permissions]:[]; const permissions=Array.isArray(req.body?.permissions)?[...new Set(req.body.permissions.filter(p=>ADMIN_PERMISSION_SET.includes(p)))]:[]; u.permissions=permissions; await u.save(); await logAdminAction(req,{action:'admin.permissions.update',targetType:'admin',targetId:u._id,targetLabel:u.email||String(u._id),oldValue:{permissions:previousPermissions},newValue:{permissions:u.permissions}}); res.json({success:true,data:{adminId:u._id,permissions:u.permissions}}); });


// Admin inventory controls are intentionally cross-restaurant; vendor inventory
// routes remain scoped to req.user.restaurantId and cannot call these handlers.
exports.getAllRestaurantInventory = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const page = clampPage(req.query.page);
  const limit = clampLimit(req.query.limit, 50, 100);
  const filter = { isActive: { $ne: false } };
  if (req.query.restaurantId && require('mongoose').Types.ObjectId.isValid(req.query.restaurantId)) filter.restaurantId = req.query.restaurantId;
  if (req.query.search) filter.name = { $regex: String(req.query.search).slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  const [items, total] = await Promise.all([
    Menu.find(filter).select('restaurantId name price image inStock manualAvailability trackStock stockQuantity lowStockThreshold approvalStatus isActive updatedAt').populate('restaurantId', 'name owner').sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Menu.countDocuments(filter),
  ]);
  res.json({ success:true, data:items, total, page, pages:Math.ceil(total / limit) });
});

exports.updateAnyRestaurantInventory = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const item = await Menu.findOne({ _id:req.params.itemId, isActive:{$ne:false} });
  if (!item) return res.status(404).json({success:false,message:'Menu item not found.'});
  const body = req.body || {};
  const update = {};
  if (body.stockQuantity !== undefined) {
    const qty = Number(body.stockQuantity);
    if (!Number.isInteger(qty) || qty < 0) return res.status(400).json({success:false,message:'stockQuantity must be a non-negative integer.'});
    update.stockQuantity = qty;
  }
  if (body.trackStock !== undefined) {
    if (typeof body.trackStock !== 'boolean') return res.status(400).json({success:false,message:'trackStock must be a boolean.'});
    update.trackStock = body.trackStock;
  }
  if (body.isAvailable !== undefined || body.manualAvailability !== undefined) {
    const available = body.manualAvailability !== undefined ? body.manualAvailability : body.isAvailable;
    if (typeof available !== 'boolean') return res.status(400).json({success:false,message:'isAvailable must be a boolean.'});
    update.manualAvailability = available;
  }
  if (body.lowStockThreshold !== undefined) {
    const threshold = Number(body.lowStockThreshold);
    if (!Number.isInteger(threshold) || threshold < 0) return res.status(400).json({success:false,message:'lowStockThreshold must be a non-negative integer.'});
    update.lowStockThreshold = threshold;
  }
  if (!Object.keys(update).length) return res.status(400).json({success:false,message:'Provide stockQuantity, trackStock, isAvailable, or lowStockThreshold.'});
  const nextTrack = update.trackStock === undefined ? item.trackStock : update.trackStock;
  const nextQty = update.stockQuantity === undefined ? Number(item.stockQuantity || 0) : update.stockQuantity;
  const nextManual = update.manualAvailability === undefined ? (item.manualAvailability !== false) : update.manualAvailability;
  update.inStock = nextManual && (!nextTrack || nextQty > 0);
  const before = Number(item.stockQuantity || 0);
  const updated = await Menu.findOneAndUpdate({_id:item._id, restaurantId:item.restaurantId}, {$set:update}, {new:true,runValidators:true});
  if (update.stockQuantity !== undefined && before !== Number(updated.stockQuantity)) {
    await InventoryMovement.create({restaurantId:item.restaurantId,menuItemId:item._id,actorId:req.user._id,change:Number(updated.stockQuantity)-before,before,after:Number(updated.stockQuantity),reason:'admin_manual_adjustment'});
  }
  await logAdminAction(req,{action:'inventory.update',targetType:'menu_item',targetId:item._id,targetLabel:item.name,oldValue:{stockQuantity:before,inStock:item.inStock,trackStock:item.trackStock},newValue:{stockQuantity:updated.stockQuantity,inStock:updated.inStock,trackStock:updated.trackStock}});
  res.json({success:true,data:updated});
});

// Admin-only customer saved-address lookup. This exposes only the address data
// required for support/operations, not authentication secrets or live GPS.
exports.getCustomerSavedLocations = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const User = require('../models/User');
  const Address = require('../models/Address');
  if (!require('mongoose').Types.ObjectId.isValid(req.params.userId)) return res.status(400).json({success:false,message:'Invalid user ID.'});
  const user = await User.findOne({_id:req.params.userId,role:'user'}).select('name phone email addresses defaultAddress').lean();
  if (!user) return res.status(404).json({success:false,message:'Customer not found.'});
  const addresses = await Address.find({user:user._id}).select('tag house area landmark city pincode location isDefault createdAt updatedAt').sort({isDefault:-1,updatedAt:-1}).lean();
  res.json({success:true,data:{user:{id:user._id,name:user.name,phone:user.phone,email:user.email||''},addresses:addresses.map(a=>({...a,coordinates:Array.isArray(a.location?.coordinates)?{longitude:a.location.coordinates[0],latitude:a.location.coordinates[1]}:null}))}});
});

/* ─────────────────────────────────────────────────────────────────────
 *  COD TRUST + ACCOUNT FREEZE (Pillar 3 / 7)
 *
 *  Admin review queue for customers who abuse Cash on Delivery: refuse the
 *  order at the door, or repeatedly fail delivery through their own fault.
 *  Each customer's counters, effective COD terms and freeze state are shown
 *  together so an operator can act in one place.
 * ───────────────────────────────────────────────────────────────────── */

// Mongoose persists unset Number fields as null, and Number(null) === 0. A
// plain isFinite() test would therefore report "no override" as "override = 0".
function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function serializeCustomerTrust(u) {
  return {
    id: u._id,
    name: u.name || 'Customer',
    phone: u.phone || '',
    email: u.email || '',
    isCodBlocked: u.isCodBlocked === true,
    accountStatus: u.accountStatus || 'active',
    frozenReason: u.frozenReason || '',
    frozenAt: u.frozenAt || null,
    codTrust: {
      refusedDeliveries: Number(u.codTrust?.refusedDeliveries || 0),
      failedDeliveries: Number(u.codTrust?.failedDeliveries || 0),
      lastFailedAt: u.codTrust?.lastFailedAt || null,
      autoBlocked: u.codTrust?.autoBlocked === true,
      autoBlockedAt: u.codTrust?.autoBlockedAt || null,
    },
    codPolicy: {
      advanceRequiredAbove: nullableNumber(u.codPolicy?.advanceRequiredAbove),
      advancePercent: nullableNumber(u.codPolicy?.advancePercent),
      note: u.codPolicy?.note || '',
      updatedAt: u.codPolicy?.updatedAt || null,
    },
    createdAt: u.createdAt,
  };
}

// GET /api/admin/customers/trust?risk=high|blocked|frozen&search=
exports.getCustomerTrustOverview = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const page = clampPage(req.query.page);
  const limit = clampLimit(req.query.limit, 20, 100);
  const filter = { role: 'user' };

  const risk = String(req.query.risk || '').trim();
  if (risk === 'blocked') filter.isCodBlocked = true;
  else if (risk === 'frozen') filter.accountStatus = 'frozen';
  else if (risk === 'high') {
    filter.$or = [
      { 'codTrust.refusedDeliveries': { $gte: 1 } },
      { 'codTrust.failedDeliveries': { $gte: 1 } },
      { 'codTrust.autoBlocked': true },
    ];
  }

  const search = String(req.query.search || '').trim().slice(0, 80);
  if (search) {
    const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$and = [
      ...(filter.$and || []),
      { $or: [{ name: { $regex: safe, $options: 'i' } }, { phone: { $regex: safe, $options: 'i' } }, { email: { $regex: safe, $options: 'i' } }] },
    ];
  }

  const [rows, total] = await Promise.all([
    User.find(filter)
      .select('name phone email isCodBlocked accountStatus frozenReason frozenAt codTrust codPolicy createdAt')
      .sort({ 'codTrust.lastFailedAt': -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: rows.map(serializeCustomerTrust),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

// GET /api/admin/customers/:userId/trust
exports.getCustomerTrust = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  if (!require('mongoose').Types.ObjectId.isValid(req.params.userId)) return res.status(400).json({ success: false, message: 'Invalid user ID.' });
  const u = await User.findOne({ _id: req.params.userId, role: 'user' })
    .select('name phone email isCodBlocked accountStatus frozenReason frozenAt frozenBy codTrust codPolicy createdAt').lean();
  if (!u) return res.status(404).json({ success: false, message: 'Customer not found.' });
  res.json({ success: true, data: serializeCustomerTrust(u) });
});

// PATCH /api/admin/customers/:userId/cod-policy
// Body: { isCodBlocked?, advanceRequiredAbove?, advancePercent?, resetCounters?, note? }
exports.updateCustomerCodPolicy = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  if (!require('mongoose').Types.ObjectId.isValid(req.params.userId)) return res.status(400).json({ success: false, message: 'Invalid user ID.' });
  const user = await User.findOne({ _id: req.params.userId, role: 'user' });
  if (!user) return res.status(404).json({ success: false, message: 'Customer not found.' });

  const before = serializeCustomerTrust(user);
  const set = {};
  const unset = {};

  if (req.body?.isCodBlocked !== undefined) {
    set.isCodBlocked = req.body.isCodBlocked === true;
    if (set.isCodBlocked === false) {
      // Manual unblock clears the automatic-block flag so the counter logic can
      // re-evaluate from a clean slate rather than instantly re-blocking.
      set['codTrust.autoBlocked'] = false;
      set['codTrust.autoBlockedAt'] = null;
    }
  }

  const hasThreshold = req.body?.advanceRequiredAbove !== undefined;
  const hasPercent = req.body?.advancePercent !== undefined;
  if (hasThreshold) {
    if (req.body.advanceRequiredAbove === null || req.body.advanceRequiredAbove === '') {
      set['codPolicy.advanceRequiredAbove'] = null;
    } else {
      const n = Number(req.body.advanceRequiredAbove);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ success: false, message: 'advanceRequiredAbove must be a non-negative number or null.' });
      set['codPolicy.advanceRequiredAbove'] = n;
    }
  }
  if (hasPercent) {
    if (req.body.advancePercent === null || req.body.advancePercent === '') {
      set['codPolicy.advancePercent'] = null;
    } else {
      const n = Number(req.body.advancePercent);
      if (!Number.isFinite(n) || n < 0 || n > 100) return res.status(400).json({ success: false, message: 'advancePercent must be between 0 and 100 or null.' });
      set['codPolicy.advancePercent'] = n;
    }
  }
  if (hasThreshold || hasPercent || req.body?.note !== undefined) {
    set['codPolicy.note'] = String(req.body?.note || '').slice(0, 200);
    set['codPolicy.updatedBy'] = req.user._id;
    set['codPolicy.updatedAt'] = new Date();
  }
  if (req.body?.resetCounters === true) {
    set['codTrust.refusedDeliveries'] = 0;
    set['codTrust.failedDeliveries'] = 0;
    set['codTrust.lastFailedAt'] = null;
    set['codTrust.autoBlocked'] = false;
    set['codTrust.autoBlockedAt'] = null;
  }

  if (!Object.keys(set).length && !Object.keys(unset).length) {
    return res.status(400).json({ success: false, message: 'No COD policy changes were supplied.' });
  }

  const updated = await User.findByIdAndUpdate(
    user._id,
    { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    { new: true, runValidators: true }
  ).select('name phone email isCodBlocked accountStatus frozenReason frozenAt codTrust codPolicy createdAt').lean();

  await logAdminAction(req, {
    action: 'customer.cod-policy.update',
    targetType: 'user',
    targetId: user._id,
    targetLabel: user.phone || String(user._id),
    oldValue: { isCodBlocked: before.isCodBlocked, codPolicy: before.codPolicy, codTrust: before.codTrust },
    newValue: { isCodBlocked: updated.isCodBlocked, codPolicy: updated.codPolicy, codTrust: updated.codTrust },
  });

  res.json({ success: true, data: serializeCustomerTrust(updated) });
});

// PATCH /api/admin/customers/:userId/freeze  Body: { frozen: true|false, reason? }
exports.setCustomerAccountFreeze = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  if (!require('mongoose').Types.ObjectId.isValid(req.params.userId)) return res.status(400).json({ success: false, message: 'Invalid user ID.' });
  if (typeof req.body?.frozen !== 'boolean') return res.status(400).json({ success: false, message: 'frozen must be true or false.' });

  const result = await setAccountFreeze(req.params.userId, {
    frozen: req.body.frozen,
    reason: req.body?.reason,
    adminId: req.user._id,
  });
  if (!result.ok) return res.status(result.status || 400).json({ success: false, message: result.message });

  await logAdminAction(req, {
    action: req.body.frozen ? 'customer.freeze' : 'customer.unfreeze',
    targetType: 'user',
    targetId: req.params.userId,
    targetLabel: String(req.params.userId),
    newValue: { accountStatus: result.data.accountStatus, reason: result.data.frozenReason },
  });

  res.json({ success: true, data: result.data });
});

/* ─────────────────────────────────────────────────────────────────────
 *  PLATFORM VISIT ANALYTICS (Pillar 8)
 *  The admin already saw WHO logs in; this adds HOW MANY people browse the
 *  customer site (unique visitors per day) and the top-viewed restaurants.
 * ───────────────────────────────────────────────────────────────────── */
exports.getVisitAnalytics = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const { getPlatformVisitAnalytics } = require('../services/analyticsService');
  const data = await getPlatformVisitAnalytics({ period: String(req.query.period || '30d') });
  res.json({ success: true, data });
});
