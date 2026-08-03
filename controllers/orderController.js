// File 2: controllers/orderController.js
const mongoose    = require('mongoose');
const Order       = require('../models/Order');
const Cart        = require('../models/Cart');
const Address     = require('../models/Address');
const Restaurant  = require('../models/Restaurant');
const Menu        = require('../models/Menu');
const User        = require('../models/User');
const asyncHandler = require('express-async-handler');
const { autoAssignRider, scheduleRiderTimeout } = require('../services/riderAssignmentService');

// ── Live-data population for order responses ────────────────────────
// Orders store a *snapshot* of the restaurant name/image and each item's
// image at checkout time (denormalized for speed/history). That snapshot
// is what was going stale: it never changes even after a vendor renames
// their restaurant or swaps a dish photo. These paths pull the current
// Restaurant/Menu documents alongside the order so the API can prefer
// live data over the frozen snapshot.
const ORDER_POPULATE_PATHS = [
  { path: 'restaurant', select: 'name image' },
  { path: 'items.menuItem', select: 'image' },
];

/**
 * Build the JSON an order response should send: live restaurant name/logo
 * and live per-item image where available, falling back to the snapshot
 * stored on the order itself when the referenced document is missing
 * (soft-deleted restaurant, deleted menu item, or a legacy order created
 * before these refs existed) — old orders keep rendering exactly as
 * before, and nothing here is ever a hardcoded name or image.
 */
function withLiveDisplayData(orderDoc) {
  const order = orderDoc.toObject({ virtuals: false });

  if (order.restaurant && typeof order.restaurant === 'object') {
    order.restaurantName = order.restaurant.name || order.restaurantName;
    order.restaurantImage = order.restaurant.image || order.restaurantImage;
    order.restaurant = order.restaurant._id; // keep the field shape (an id) existing clients expect
  }

  if (Array.isArray(order.items)) {
    order.items = order.items.map((item) => {
      const liveMenuItem = item.menuItem && typeof item.menuItem === 'object' ? item.menuItem : null;
      return {
        ...item,
        // Priority: item.image (the checkout-time snapshot — correct for
        // every order created after the fix in buildOrderItems) first,
        // then the live Menu doc's image as a fallback for legacy orders
        // saved before item.image was ever populated, then '' (the
        // frontend renders an initials placeholder when this is empty).
        image: item.image || (liveMenuItem && liveMenuItem.image) || '',
        menuItem: liveMenuItem ? liveMenuItem._id : item.menuItem,
      };
    });
  }

  return order;
}

/**
 * Builds the `items` array that actually gets persisted on the order.
 *
 * Root cause of the empty item image: the client cart payload was being
 * written straight to `Order.create({ items })` with no server-side
 * enrichment, and the checkout UI never carried the menu photo through
 * to that payload — so `image` landed in Mongo as "" on every order,
 * and `menuItem` was never set at all.
 *
 * This looks each line item up against the live Menu document (however
 * the client identified it — `menuItem`, `menuId`, `id`, or `_id`, since
 * the cart payload shape isn't guaranteed) and stamps the *current* menu
 * image and a real `menuItem` ref onto the item. `name`/`price`/`quantity`
 * keep coming from the client cart, since those already save correctly
 * and price must match what the customer was actually charged.
 */
async function buildOrderItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];

  const menuIds = rawItems
    .map((it) => it.menuItem || it.menuId || it.id || it._id)
    .filter((id) => id && mongoose.Types.ObjectId.isValid(id));

  const menus = menuIds.length
    ? await Menu.find({ _id: { $in: menuIds } }).select('name price image isVeg')
    : [];
  const menuById = new Map(menus.map((m) => [String(m._id), m]));

  return rawItems.map((it) => {
    const menuId = it.menuItem || it.menuId || it.id || it._id;
    const menu = menuId ? menuById.get(String(menuId)) : null;

    return {
      menuItem:       menu ? menu._id : (it.menuItem || undefined),
      name:           it.name || (menu && menu.name),
      price:          it.price,
      image:          (menu && menu.image) || it.image || '',
      isVeg:          typeof it.isVeg === 'boolean' ? it.isVeg : (menu ? menu.isVeg : true),
      quantity:       it.quantity,
      customizations: it.customizations || {},
    };
  });
}

const createOrder = asyncHandler(async (req, res) => {
  const { items, restaurantId, restaurantName, subtotal, total, deliveryAddress } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Cart is empty' });
  }

  const order = await Order.create({
    user:            req.user._id, 
    restaurant:      restaurantId,
    restaurantName:  restaurantName,
    items:           await buildOrderItems(items),
    deliveryAddress: deliveryAddress,
    subtotal:        subtotal,
    deliveryFee:     40,
    platformFee:     5,
    total:           total,
  });

  const deliveryOtp = order._plainDeliveryOtp;
  order.clearOtpSecrets();
  await order.populate(ORDER_POPULATE_PATHS);

  res.status(201).json({
    success: true,
    data: withLiveDisplayData(order),
    deliveryOtp,
  });
});

const getOrders = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 10 } = req.query;
  const filter = { user: req.user._id };
  if (status) filter.status = status;

  const skip = (Number(page) - 1) * Number(limit);
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .select('+deliveryOtp')
      .populate(ORDER_POPULATE_PATHS)
      .populate('rider', 'name phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    Order.countDocuments(filter),
  ]);

  res.json({
    success: true,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
    total,
    data: orders.map(withLiveDisplayData),
  });
});

const getOrderById = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, user: req.user._id })
    .select('+deliveryOtp')
    .populate(ORDER_POPULATE_PATHS)
    .populate('rider', 'name phone');
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  res.json({ success: true, data: withLiveDisplayData(order) });
});

const cancelOrder = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  if (!order.isCancellable)
    return res.status(400).json({ success: false, message: 'Order cannot be cancelled at this stage' });

  order.advanceStatus('cancelled', req.body.reason || 'Cancelled by customer');
  order.cancelReason = req.body.reason || 'Cancelled by customer';
  await order.save();
  await order.populate(ORDER_POPULATE_PATHS);

  res.json({ success: true, message: 'Order cancelled', data: withLiveDisplayData(order) });
});

const rateOrder = asyncHandler(async (req, res) => {
  const { score, comment } = req.body;
  const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  if (order.status !== 'delivered')
    return res.status(400).json({ success: false, message: 'You can only rate delivered orders' });

  order.rating = { score, comment, givenAt: new Date() };
  await order.save();
  await order.populate(ORDER_POPULATE_PATHS);
  res.json({ success: true, data: withLiveDisplayData(order) });
});

const VENDOR_SETTABLE_STATUSES = ['confirmed', 'preparing', 'waiting_for_rider', 'delivered', 'cancelled'];

const FORWARD_TRANSITIONS = {
  placed:             ['confirmed'],
  confirmed:          ['preparing'],
  preparing:          ['waiting_for_rider'],
  waiting_for_rider:  [], 
  assigned:           [], 
  out_for_delivery:   ['delivered'],
  otp_verified:       ['delivered'],
  delivered:          [], 
  cancelled:          [], 
};

const CANCELLABLE_FROM = ['placed', 'confirmed', 'preparing', 'waiting_for_rider', 'assigned', 'out_for_delivery', 'otp_verified'];

function allowedNextStatuses(currentStatus) {
  const forward = FORWARD_TRANSITIONS[currentStatus] || [];
  return CANCELLABLE_FROM.includes(currentStatus) ? [...forward, 'cancelled'] : forward;
}

const updateOrderStatus = asyncHandler(async (req, res) => {
  const { status, note } = req.body;
  if (!VENDOR_SETTABLE_STATUSES.includes(status))
    return res.status(400).json({ success: false, message: 'Invalid status' });

  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

  const allowed = allowedNextStatuses(order.status);
  if (!allowed.includes(status)) {
    return res.status(409).json({
      success: false,
      message: allowed.length
        ? `Cannot move order from "${order.status}" to "${status}". Allowed next status: ${allowed.join(', ')}.`
        : `Cannot update order — it is currently "${order.status}", which cannot be changed from this endpoint.`,
    });
  }

  if (status === 'delivered' && !order.deliveryOtpVerified) {
    return res.status(409).json({
      success: false,
      message: 'Cannot mark this order as delivered until the delivery OTP has been verified.',
    });
  }

  order.advanceStatus(status, note || '');

  let riderAssignment = null;
  if (status === 'waiting_for_rider' && !order.rider) {
    riderAssignment = await autoAssignRider(order); 
  }

  await order.save();
  await order.populate(ORDER_POPULATE_PATHS);

  // If auto-assigned successfully, schedule the 60-second acceptance timeout check
  if (riderAssignment && riderAssignment.assigned) {
    scheduleRiderTimeout(order._id, order.rider);
  }

  res.json({
    success: true,
    data: withLiveDisplayData(order),
    ...(riderAssignment ? { riderAssignment } : {}),
  });
});

const getAllOrders = asyncHandler(async (req, res) => {
  const { status, restaurant, page = 1, limit = 20 } = req.query;
  const filter = {};
  if (status)     filter.status     = status;
  if (restaurant) filter.restaurant = restaurant;

  const skip = (Number(page) - 1) * Number(limit);
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .populate('user', 'name phone')
      .populate(ORDER_POPULATE_PATHS)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    Order.countDocuments(filter),
  ]);

  res.json({
    success: true,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
    total,
    data: orders.map(withLiveDisplayData),
  });
});

const createGuestOrder = asyncHandler(async (req, res) => {
  const { items, deliveryAddress, restaurantId, restaurantName, subtotal, total } = req.body;

  const order = await Order.create({
    user: '000000000000000000000000', 
    restaurant: restaurantId,
    restaurantName: restaurantName,
    items: await buildOrderItems(items),
    deliveryAddress: deliveryAddress,
    subtotal: subtotal,
    total: total,
  });

  const deliveryOtp = order._plainDeliveryOtp;
  order.clearOtpSecrets();
  await order.populate(ORDER_POPULATE_PATHS);

  res.status(201).json({ success: true, data: withLiveDisplayData(order), deliveryOtp });
});

const RIDER_LOCKED_FOR_REASSIGN = ['reached_restaurant', 'picked_up', 'out_for_delivery'];

const assignRider = asyncHandler(async (req, res) => {
  const { riderId } = req.body;
  if (!riderId) {
    return res.status(400).json({ success: false, message: 'riderId is required' });
  }

  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

  if (['delivered', 'cancelled'].includes(order.status)) {
    return res.status(409).json({
      success: false,
      message: `Cannot assign a rider — order is already ${order.status}.`,
    });
  }

  if (order.rider && RIDER_LOCKED_FOR_REASSIGN.includes(order.riderStatus)) {
    return res.status(409).json({
      success: false,
      message: 'Cannot reassign — this order is already being delivered by a rider.',
    });
  }

  const rider = await User.findOne({ _id: riderId, role: 'rider' });
  if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });
  if (!rider.isActive) {
    return res.status(409).json({ success: false, message: 'This rider is disabled and cannot be assigned.' });
  }

  order.rider = rider._id;
  order.riderAssignedAt = new Date();
  order.riderStatus = 'assigned';
  order.riderEarning = order.riderEarning || order.deliveryFee || 0;
  order.riderStatusHistory = order.riderStatusHistory || [];
  order.riderStatusHistory.push({
    status: 'assigned',
    note: `Assigned to ${rider.name} by admin`,
    at: new Date(),
  });

  await order.save();
  await order.populate(ORDER_POPULATE_PATHS);

  // If manually assigned by admin, schedule the 60-second acceptance timeout check
  scheduleRiderTimeout(order._id, order.rider);

  res.json({ success: true, message: 'Rider assigned successfully.', data: withLiveDisplayData(order) });
});

module.exports = {
  createOrder, 
  getOrders, 
  getOrderById,
  cancelOrder, 
  rateOrder, 
  updateOrderStatus, 
  getAllOrders,
  createGuestOrder,
  assignRider
};
