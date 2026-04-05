const Order      = require('../models/Order');
const Cart       = require('../models/Cart');
const Address    = require('../models/Address');
const Restaurant = require('../models/Restaurant');
const asyncHandler = require('express-async-handler');

// POST /api/orders  — create order from cart
const createOrder = asyncHandler(async (req, res) => {
  const cart = await Cart.findOne({ user: req.user._id }).populate('deliveryAddress');

  if (!cart || cart.items.length === 0)
    return res.status(400).json({ success: false, message: 'Cart is empty' });

  if (!cart.deliveryAddress)
    return res.status(400).json({ success: false, message: 'Please set a delivery address' });

  const restaurant = await Restaurant.findById(cart.restaurant);
  if (!restaurant)
    return res.status(404).json({ success: false, message: 'Restaurant not found' });

  const addr = cart.deliveryAddress;

  const order = await Order.create({
    user:            req.user._id,
    restaurant:      restaurant._id,
    restaurantName:  restaurant.name,
    restaurantImage: restaurant.image,
    items: cart.items.map(i => ({
      menuItem:  i.menuItem,
      name:      i.name,
      price:     i.price,
      image:     i.image,
      isVeg:     i.isVeg,
      quantity:  i.quantity,
      customizations: i.customizations,
    })),
    deliveryAddress: {
      tag: addr.tag, house: addr.house, area: addr.area,
      landmark: addr.landmark, city: addr.city, pincode: addr.pincode,
    },
    subtotal:      cart.subtotal,
    deliveryFee:   cart.deliveryFee,
    platformFee:   cart.platformFee,
    total:         cart.total,
    paymentMethod: cart.paymentMethod,
  });

  // Increment restaurant order count
  await Restaurant.findByIdAndUpdate(restaurant._id, { $inc: { totalOrders: 1 } });

  // Clear cart after successful order
  await Cart.findByIdAndUpdate(cart._id, {
    items: [], restaurant: null, restaurantName: '',
    subtotal: 0, deliveryFee: 40, platformFee: 5, total: 0,
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

module.exports = {
  createOrder, getOrders, getOrderById,
  cancelOrder, rateOrder, updateOrderStatus, getAllOrders,
  createGuestOrder // <--- ADDED THE NEW FUNCTION HERE
};
