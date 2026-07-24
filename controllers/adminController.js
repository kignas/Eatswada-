'use strict';

const asyncHandler = require('express-async-handler');
const bcrypt       = require('bcryptjs');
const User         = require('../models/User');
const Order        = require('../models/Order');
const Restaurant   = require('../models/Restaurant');
const generateToken = require('../utils/generateToken');

const ADMIN_ROLES = ['admin', 'ceo'];

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
  if (!user || !user.password)
    return res.status(401).json({ success: false, message: 'Invalid credentials.' });
  if (!ADMIN_ROLES.includes(user.role))
    return res.status(403).json({ success: false, message: 'Access denied. Admin account required.' });

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid credentials.' });
  if (!user.isActive) return res.status(401).json({ success: false, message: 'Account deactivated.' });

  user.lastLogin = new Date();
  await user.save();

  res.json({
    success: true,
    data: {
      token: generateToken(user._id, user.role),
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
  const { status, search, page = 1, limit = 25 } = req.query;
  const filter = {};
  if (status) filter.status = status.toLowerCase();
  if (search) filter.$or = [{ orderNumber: { $regex: search, $options: 'i' } }, { restaurantName: { $regex: search, $options: 'i' } }];
  const skip = (Number(page) - 1) * Number(limit);
  const [orders, total] = await Promise.all([
    Order.find(filter).populate('user', 'name phone email').sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
    Order.countDocuments(filter),
  ]);
  res.json({ success: true, data: { orders: orders.map(o => ({
    id: o._id, orderNumber: o.orderNumber, customerName: o.user?.name ?? 'Unknown',
    customerPhone: o.user?.phone ?? '', restaurantName: o.restaurantName,
    totalAmount: o.total, status: o.status.toUpperCase(),
    paymentMethod: o.paymentMethod, riderName: null, createdAt: o.createdAt,
  })), total, page: Number(page), pages: Math.ceil(total / Number(limit)) }});
});

exports.updateOrderStatus = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const { status } = req.body;
  if (!status) return res.status(400).json({ success: false, message: 'Status is required.' });
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  order.status = status.toLowerCase();
  order.statusHistory.push({ status: order.status, note: 'Updated by admin' });
  await order.save();
  res.json({ success: true, data: order });
});

exports.cancelOrder = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  order.status = 'cancelled';
  order.cancelReason = req.body.reason || 'Cancelled by admin';
  order.isCancellable = false;
  order.statusHistory.push({ status: 'cancelled', note: order.cancelReason });
  await order.save();
  res.json({ success: true, data: order });
});

exports.getRestaurants = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const { search, status = 'active' } = req.query;
  const filter = {};
  // 'all' intentionally omits the isActive filter entirely so deactivated
  // restaurants remain visible/recoverable instead of vanishing from admin view.
  if (status === 'active') filter.isActive = true;
  else if (status === 'inactive') filter.isActive = false;
  if (search) filter.name = { $regex: search, $options: 'i' };
  const restaurants = await Restaurant.find(filter).populate('owner', 'name phone email').sort({ createdAt: -1 });
  res.json({ success: true, data: restaurants.map(r => ({
    id: r._id, name: r.name, ownerName: r.owner?.name ?? '',
    phone: r.owner?.phone ?? '', address: r.address ?? '',
    cuisine: r.cuisineDisplay || (r.cuisine || []).join(', '),
    rating: r.rating, avgPrepTime: r.estimatedDeliveryMin ?? 20,
    isOpen: r.isOpen, isActive: r.isActive, totalOrders: r.totalOrders, image: r.image, createdAt: r.createdAt,
  }))});
});

exports.toggleRestaurant = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const restaurant = await Restaurant.findById(req.params.id);
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found.' });
  if (!restaurant.isActive) {
    return res.status(409).json({ success: false, message: 'This restaurant is deactivated. Restore it before changing its open/closed status.' });
  }
  restaurant.isOpen = !restaurant.isOpen;
  await restaurant.save();
  res.json({ success: true, data: { isOpen: restaurant.isOpen } });
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
  const { search, page = 1, limit = 20 } = req.query;
  const filter = { role: 'user', isActive: true };
  if (search) filter.$or = [{ name: { $regex: search, $options: 'i' } }, { phone: { $regex: search, $options: 'i' } }, { email: { $regex: search, $options: 'i' } }];
  const skip = (Number(page) - 1) * Number(limit);
  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
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
  }), total, page: Number(page), pages: Math.ceil(total / Number(limit)) }});
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
  const { search, status, page = 1, limit = 20 } = req.query;
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
  const skip = (Number(page) - 1) * Number(limit);
  const [vendors, total] = await Promise.all([
    User.find(filter)
      .populate('restaurantId', 'name image isActive isOpen')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
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
      pages: Math.ceil(total / Number(limit)),
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
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
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

  vendor.isActive = !vendor.isActive;
  await vendor.save();

  // Deactivating the vendor's login should also take their restaurant off
  // the live menu — it can no longer be managed if nobody can log in to it.
  if (!vendor.isActive && vendor.restaurantId) {
    await Restaurant.findByIdAndUpdate(vendor.restaurantId, { isOpen: false });
  }

  res.json({
    success: true,
    message: vendor.isActive ? 'Vendor reactivated.' : 'Vendor deactivated.',
    data: { id: vendor._id, isActive: vendor.isActive },
  });
});
