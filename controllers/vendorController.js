const asyncHandler   = require('express-async-handler');
const Order           = require('../models/Order');
const Menu            = require('../models/Menu');
const Restaurant      = require('../models/Restaurant');
const Review          = require('../models/Review');

// FIX: Import the auto-assignment service here
const { autoAssignRider, scheduleRiderTimeout } = require('../services/riderAssignmentService'); 

function assertVendorPayload(req, res) {
  if (!req.user || req.user.role !== 'vendor' || !req.user.restaurantId) {
    res.status(403).json({ success: false, message: 'Access denied. You are not a registered vendor.' });
    return false;
  }
  return true;
}

function restaurantOwnershipFilter(req) {
  return { $or: [{ restaurant: req.user.restaurantId }, { restaurantId: req.user.restaurantId }] };
}

const VENDOR_ORDER_POPULATE = [
  { path: 'user', select: 'name phone' },
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

  return order;
}

/* ─────────────────────────────────────────────────────────────
 *  ORDER STATUS GROUPS
 * ───────────────────────────────────────────────────────────── */
const QUEUE_STATUSES   = ['placed', 'confirmed', 'preparing', 'waiting_for_rider', 'assigned', 'out_for_delivery'];
const HISTORY_STATUSES = ['delivered', 'cancelled'];

const VENDOR_STATUS_TRANSITIONS = {
  confirmed: 'preparing',
  preparing: 'waiting_for_rider',
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

  const orders = await Order.find({
    ...restaurantOwnershipFilter(req),
    ...statusFilter,
  })
    .populate(VENDOR_ORDER_POPULATE)
    .sort({ createdAt: -1 });

  res.status(200).json({ success: true, data: orders.map(serializeVendorOrder) });
});

exports.acceptOrder = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;

  const order = await Order.findOne({ _id: req.params.id, ...restaurantOwnershipFilter(req) });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found or access denied.' });

  if (order.status !== 'placed') {
    return res.status(409).json({
      success: false,
      message: `Order cannot be accepted from its current status ("${order.status}").`,
    });
  }

  order.advanceStatus('confirmed', 'Accepted by restaurant');
  await order.save();

  res.status(200).json({ success: true, data: order });
});

exports.rejectOrder = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;

  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason) {
    return res.status(400).json({ success: false, message: 'A rejection reason is required.' });
  }

  const order = await Order.findOne({ _id: req.params.id, ...restaurantOwnershipFilter(req) });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found or access denied.' });

  if (order.status !== 'placed') {
    return res.status(409).json({
      success: false,
      message: `Order cannot be rejected from its current status ("${order.status}").`,
    });
  }

  order.cancelReason = reason;
  order.advanceStatus('cancelled', `Rejected by restaurant: ${reason}`);
  await order.save();

  res.status(200).json({ success: true, data: order });
});

exports.updateOrderStatus = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;

  const order = await Order.findOne({ _id: req.params.id, ...restaurantOwnershipFilter(req) });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found or access denied.' });

  const nextStatus = VENDOR_STATUS_TRANSITIONS[order.status];
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
 *  MENU 
 * ───────────────────────────────────────────────────────────── */

exports.getVendorMenu = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  const items = await Menu.find(restaurantOwnershipFilter(req)).sort({ sortOrder: 1, createdAt: -1 });
  res.status(200).json({ success: true, data: items });
});

exports.addMenuItem = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  const {
    restaurant,
    restaurantId,
    _id,
    createdAt,
    updatedAt,
    ...safeBody
  } = req.body;

  const itemData = {
    ...safeBody,
    restaurant: req.user.restaurantId,
    restaurantId: req.user.restaurantId,
  };
  const item = await Menu.create(itemData);
  res.status(201).json({ success: true, data: item });
});

exports.updateMenuItem = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  const {
    restaurant,
    restaurantId,
    _id,
    createdAt,
    updatedAt,
    ...safeBody
  } = req.body;
  const item = await Menu.findOneAndUpdate(
    { _id: req.params.id, ...restaurantOwnershipFilter(req) },
    safeBody,
    { new: true, runValidators: true }
  );
  if (!item) return res.status(404).json({ success: false, message: 'Item not found or access denied.' });
  res.status(200).json({ success: true, data: item });
});

exports.toggleItemStock = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  const existing = await Menu.findOne({ _id: req.params.id, ...restaurantOwnershipFilter(req) });
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
  res.status(200).json({ success: true, data: restaurant });
});

exports.updateRestaurantStatus = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  if (typeof req.body.isActive !== 'boolean') {
    return res.status(400).json({ success: false, message: 'isActive must be a boolean.' });
  }
  const restaurant = await Restaurant.findOneAndUpdate(
    { _id: req.user.restaurantId },
    { isActive: req.body.isActive },
    { new: true, runValidators: true }
  );
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found.' });
  res.status(200).json({ success: true, data: restaurant });
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

