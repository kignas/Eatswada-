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


// To this:
const ORDER_POPULATE_PATHS = [
  { path: 'restaurant', select: 'name image phone contactNumber' }, // Added phone fields
  { path: 'items.menuItem', select: 'image' },
  { path: 'user', select: 'name phone' } // Added customer profile
];


function withLiveDisplayData(orderDoc) {
  const order = orderDoc.toObject({ virtuals: false });

  if (order.restaurant && typeof order.restaurant === 'object') {
    order.restaurantName = order.restaurant.name || order.restaurantName;
    order.restaurantImage = order.restaurant.image || order.restaurantImage;
    order.restaurant = order.restaurant._id; 
  }

  if (Array.isArray(order.items)) {
    order.items = order.items.map((item) => {
      const liveMenuItem = item.menuItem && typeof item.menuItem === 'object' ? item.menuItem : null;
      return {
        ...item,
        image: item.image || (liveMenuItem && liveMenuItem.image) || '',
        menuItem: liveMenuItem ? liveMenuItem._id : item.menuItem,
      };
    });
  }

  return order;
}

/**
 * REWRITTEN: Server-Side Pricing Engine
 * We no longer trust the client's price, subtotal, or restaurantId.
 * We fetch the actual prices from the database using the Menu IDs.
 */
async function buildOrderItemsAndCalculate(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { items: [], subtotal: 0, restaurantId: null };
  }

  const menuIds = rawItems
    .map((it) => it.menuItem || it.menuId || it.id || it._id)
    .filter((id) => id && mongoose.Types.ObjectId.isValid(id));

  const menus = menuIds.length
    // 🔧 FIX: Menu schema's field is `restaurantId`, not `restaurant` (see Menu.js).
    // Selecting/reading the wrong name meant this was always undefined, which
    // turned into the literal string "undefined" below and crashed
    // Restaurant.findById() with a CastError on every single order.
    ? await Menu.find({ _id: { $in: menuIds } }).select('name price image isVeg restaurantId')
    : [];

  if (menus.length === 0) {
    throw new Error('None of the items in the cart exist in the database.');
  }

  // Security Check: Ensure all items belong to the same restaurant
  const restaurantIds = new Set(menus.map(m => String(m.restaurantId)));
  if (restaurantIds.size > 1) {
    throw new Error('Cart contains items from multiple restaurants. Please clear your cart.');
  }
  const verifiedRestaurantId = Array.from(restaurantIds)[0];

  const menuById = new Map(menus.map((m) => [String(m._id), m]));
  let calculatedSubtotal = 0;

  const items = rawItems.reduce((acc, it) => {
    const menuId = it.menuItem || it.menuId || it.id || it._id;
    const menu = menuId ? menuById.get(String(menuId)) : null;

    if (menu) {
      const qty = Number(it.quantity) || 1;
      const itemTotal = menu.price * qty;
      calculatedSubtotal += itemTotal;

      acc.push({
        menuItem:       menu._id,
        name:           menu.name, 
        price:          menu.price, 
        image:          menu.image || '',
        isVeg:          menu.isVeg,
        quantity:       qty,
        customizations: it.customizations || {},
      });
    }
    return acc;
  }, []);

  return { 
    items, 
    subtotal: calculatedSubtotal, 
    restaurantId: verifiedRestaurantId 
  };
}

const createOrder = asyncHandler(async (req, res) => {
  // Extract all possible variations of the restaurant ID your frontend might send
  const { items, deliveryAddress } = req.body; 
  const payloadResId = req.body.restaurant || req.body.restaurantId || req.body.resId;

  // 1. STRICT VALIDATION: Prevent Mongoose CastErrors instantly
  if (!payloadResId || !mongoose.Types.ObjectId.isValid(payloadResId)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid or missing Restaurant ID. Your cart data may be corrupted. Please clear your cart and try again.'
    });
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Cart is empty' });
  }

  // 2. ITEM SANITIZATION: Ensure no "undefined" menu items slipped through
  const hasCorruptedItems = items.some(it => !it.menuItem || !mongoose.Types.ObjectId.isValid(it.menuItem));
  if (hasCorruptedItems) {
    return res.status(400).json({
      success: false,
      message: 'Corrupted items detected in your cart. Please clear your cart and try again.'
    });
  }

  try {
    const { items: enrichedItems, subtotal, restaurantId } = await buildOrderItemsAndCalculate(items);

    const deliveryFee = 40; 
    const platformFee = 5;
    const calculatedTotal = subtotal + deliveryFee + platformFee;

    const restaurant = await Restaurant.findById(restaurantId).select('name');

    const order = await Order.create({
      user:            req.user._id, 
      restaurant:      restaurantId,
      restaurantName:  restaurant ? restaurant.name : 'Unknown',
      
      customerName:    req.user.name,
      customerPhone:   req.user.phone,

      items:           enrichedItems,
      deliveryAddress: deliveryAddress,
      subtotal:        subtotal,
      deliveryFee:     deliveryFee,
      platformFee:     platformFee,
      total:           calculatedTotal,
    });

    const deliveryOtp = order._plainDeliveryOtp;
    order.clearOtpSecrets();
    await order.populate(ORDER_POPULATE_PATHS);

    res.status(201).json({
      success: true,
      data: withLiveDisplayData(order),
      deliveryOtp,
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

const createGuestOrder = asyncHandler(async (req, res) => {
  const { items, deliveryAddress } = req.body;
  const payloadResId = req.body.restaurant || req.body.restaurantId || req.body.resId;

  // 1. STRICT VALIDATION FOR GUESTS
  if (!payloadResId || !mongoose.Types.ObjectId.isValid(payloadResId)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid or missing Restaurant ID. Your cart data may be corrupted. Please clear your cart and try again.'
    });
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Cart is empty' });
  }

  const hasCorruptedItems = items.some(it => !it.menuItem || !mongoose.Types.ObjectId.isValid(it.menuItem));
  if (hasCorruptedItems) {
    return res.status(400).json({
      success: false,
      message: 'Corrupted items detected in your cart. Please clear your cart and try again.'
    });
  }

  try {
    const { items: enrichedItems, subtotal, restaurantId } = await buildOrderItemsAndCalculate(items);

    const deliveryFee = 40;
    const platformFee = 5;
    const calculatedTotal = subtotal + deliveryFee + platformFee;

    const restaurant = await Restaurant.findById(restaurantId).select('name');

    const order = await Order.create({
      user: '000000000000000000000000', 
      restaurant: restaurantId,
      restaurantName: restaurant ? restaurant.name : 'Unknown',
      items: enrichedItems,
      deliveryAddress: deliveryAddress,
      subtotal: subtotal,
      deliveryFee: deliveryFee,
      platformFee: platformFee,
      total: calculatedTotal,
    });

    const deliveryOtp = order._plainDeliveryOtp;
    order.clearOtpSecrets();
    await order.populate(ORDER_POPULATE_PATHS);

    res.status(201).json({ success: true, data: withLiveDisplayData(order), deliveryOtp });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
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

  // SECURITY FIX: Vendor Authorization Check (BOLA)
  if (req.user.role === 'vendor' && String(order.restaurant) !== String(req.user.restaurantId)) {
    return res.status(403).json({ 
      success: false, 
      message: 'Unauthorized: You can only update orders for your own restaurant.' 
    });
  }

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

  // SECURITY FIX: Restrict vendors to only seeing their own orders
  if (req.user.role === 'vendor') {
    filter.restaurant = req.user.restaurantId;
  }

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
