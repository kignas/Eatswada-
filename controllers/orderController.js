const Order      = require('../models/Order');
const Cart       = require('../models/Cart');
const Address    = require('../models/Address');
const Restaurant = require('../models/Restaurant');
const User       = require('../models/User');
const asyncHandler = require('express-async-handler');

// POST /api/orders  — create order from cart
// POST /api/orders  — create order from frontend payload
const createOrder = asyncHandler(async (req, res) => {
  const { items, restaurantId, restaurantName, subtotal, total, deliveryAddress } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Cart is empty' });
  }

  // Create the order directly from the data the frontend sends!
  const order = await Order.create({
    user:            req.user._id, // Secured by the JWT Token
    restaurant:      restaurantId,
    restaurantName:  restaurantName,
    items:           items,
    deliveryAddress: deliveryAddress,
    subtotal:        subtotal,
    deliveryFee:     40,
    platformFee:     5,
    total:           total,
  });

  res.status(201).json({ success: true, data: order });
});

// GET /api/orders  — order history for user
const getOrders = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 10 } = req.query;
  const filter = { user: req.user._id };
  if (status) filter.status = status;

  const skip = (Number(page) - 1) * Number(limit);
  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
    Order.countDocuments(filter),
  ]);

  res.json({
    success: true,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
    total,
    data: orders,
  });
});

// GET /api/orders/:id
const getOrderById = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  res.json({ success: true, data: order });
});

// PUT /api/orders/:id/cancel
const cancelOrder = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  if (!order.isCancellable)
    return res.status(400).json({ success: false, message: 'Order cannot be cancelled at this stage' });

  order.advanceStatus('cancelled', req.body.reason || 'Cancelled by customer');
  order.cancelReason = req.body.reason || 'Cancelled by customer';
  await order.save();

  res.json({ success: true, message: 'Order cancelled', data: order });
});

// PUT /api/orders/:id/rate
const rateOrder = asyncHandler(async (req, res) => {
  const { score, comment } = req.body;
  const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  if (order.status !== 'delivered')
    return res.status(400).json({ success: false, message: 'You can only rate delivered orders' });

  order.rating = { score, comment, givenAt: new Date() };
  await order.save();
  res.json({ success: true, data: order });
});

// ── ADMIN / RESTAURANT: update order status ──────────────────

// PUT /api/orders/:id/status
const updateOrderStatus = asyncHandler(async (req, res) => {
  const { status, note } = req.body;
  const validStatuses = ['confirmed','preparing','out_for_delivery','delivered','cancelled'];
  if (!validStatuses.includes(status))
    return res.status(400).json({ success: false, message: 'Invalid status' });

  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

  order.advanceStatus(status, note || '');
  await order.save();

  res.json({ success: true, data: order });
});

// GET /api/orders/admin/all  — admin view all orders
const getAllOrders = asyncHandler(async (req, res) => {
  const { status, restaurant, page = 1, limit = 20 } = req.query;
  const filter = {};
  if (status)     filter.status     = status;
  if (restaurant) filter.restaurant = restaurant;

  const skip = (Number(page) - 1) * Number(limit);
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .populate('user', 'name phone')
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
    data: orders,
  });
});

// POST /api/orders/guest  — Guest checkout (bypasses login and cart)
const createGuestOrder = asyncHandler(async (req, res) => {
  const { items, deliveryAddress, restaurantId, restaurantName, subtotal, total } = req.body;

  const order = await Order.create({
    user: '000000000000000000000000', // Dummy 24-character ID for a Guest
    restaurant: restaurantId,
    restaurantName: restaurantName,
    items: items,
    deliveryAddress: deliveryAddress,
    subtotal: subtotal,
    total: total,
  });

  res.status(201).json({ success: true, data: order });
});

// ── ADMIN: assign a rider to an order ─────────────────────────
// Note: this only sets order.status to 'cancelled'/'delivered' checks
// against the *existing* status field. It does not call advanceStatus()
// or touch order.status itself — assignment is purely a rider/riderStatus
// change layered on top of your existing order lifecycle.

// Once a rider has reached the restaurant (or later), swapping them out
// is blocked — the order is already physically in someone's hands.
const RIDER_LOCKED_FOR_REASSIGN = ['reached_restaurant', 'picked_up', 'out_for_delivery'];

// PUT /api/orders/:id/assign-rider  (ADMIN ONLY)
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

  res.json({ success: true, message: 'Rider assigned successfully.', data: order });
});

module.exports = {
  createOrder, getOrders, getOrderById,
  cancelOrder, rateOrder, updateOrderStatus, getAllOrders,
  createGuestOrder, // <--- ADDED THE NEW FUNCTION HERE
  assignRider,
};
module.exports = {
  createOrder, getOrders, getOrderById,
  cancelOrder, rateOrder, updateOrderStatus, getAllOrders,
  createGuestOrder // <--- ADDED THE NEW FUNCTION HERE
};
