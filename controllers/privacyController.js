"use strict";

const mongoose = require('mongoose');
const asyncHandler = require('express-async-handler');
const crypto = require('crypto');

const User = require('../models/User');
const Address = require('../models/Address');
const Order = require('../models/Order');
const Cart = require('../models/Cart');
const Notification = require('../models/Notification');
const Review = require('../models/Review');
const PlatformRating = require('../models/PlatformRating');
const CouponRedemption = require('../models/CouponRedemption');
const CouponUsage = require('../models/CouponUsage');
const IdempotencyKey = require('../models/IdempotencyKey');
const DataRequest = require('../models/DataRequest');
const Restaurant = require('../models/Restaurant');

const ACTIVE_ORDER_STATUSES = [
  'placed', 'confirmed', 'preparing', 'waiting_for_rider',
  'assigned', 'out_for_delivery', 'otp_verified'
];

function makeRequestId(prefix = 'PR') {
  return `${prefix}-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function publicUser(user) {
  if (!user) return null;
  const obj = typeof user.toJSON === 'function' ? user.toJSON() : user;
  return {
    name: obj.name || '',
    phone: obj.phone || '',
    email: obj.email || '',
    avatar: obj.avatar || '',
    createdAt: obj.createdAt || null,
    lastLogin: obj.lastLogin || null,
    adultConfirmedAt: obj.adultConfirmedAt || null,
    nominee: obj.dataNominee?.name ? {
      name: obj.dataNominee.name,
      email: obj.dataNominee.email || '',
      phone: obj.dataNominee.phone || '',
      relationship: obj.dataNominee.relationship || '',
      updatedAt: obj.dataNominee.updatedAt || null,
    } : null,
  };
}

function cleanNominee(body) {
  const name = String(body?.name || '').trim();
  const email = String(body?.email || '').trim().toLowerCase();
  const phone = String(body?.phone || '').trim();
  const relationship = String(body?.relationship || '').trim();
  if (!name && !email && !phone && !relationship) return null;
  if (name.length < 2 || name.length > 80) throw Object.assign(new Error('Nominee name must be 2-80 characters.'), { statusCode: 400 });
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw Object.assign(new Error('Enter a valid nominee email address.'), { statusCode: 400 });
  if (phone && !/^\+?[1-9]\d{9,14}$/.test(phone)) throw Object.assign(new Error('Enter a valid nominee mobile number.'), { statusCode: 400 });
  if (relationship.length > 60) throw Object.assign(new Error('Nominee relationship is too long.'), { statusCode: 400 });
  return { name, email, phone, relationship, updatedAt: new Date() };
}

const exportMyData = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = req.user._id;
  const user = await User.findById(userId).select('name phone email avatar createdAt lastLogin dataNominee').lean();
  if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });

  const [addresses, orders, reviews, ratings, notifications, privacyRequests] = await Promise.all([
    Address.find({ user: userId }).select('tag house area landmark city pincode location isDefault createdAt updatedAt').lean(),
    Order.find({ user: userId }).select([
      'orderNumber','shipmentId','restaurantName','createdAt','updatedAt','status',
      'items','subtotal','deliveryFee','discount','total','paymentMethod','paymentStatus',
      'deliveryAddress','deliveryDistanceKm','restaurantNote','deliveryInstructions','tipAmount',
      'estimatedDelivery','deliveredAt','cancelReason','refund.status','refund.amount',
      'refund.initiatedAt','refund.completedAt'
    ].join(' ')).sort({ createdAt: -1 }).lean(),
    Review.find({ user: userId }).select('restaurant order score riderScore comment isVisible createdAt updatedAt').populate('restaurant', 'name').lean(),
    PlatformRating.find({ user: userId }).select('sequence score comment createdAt updatedAt').lean(),
    Notification.find({ user: userId }).select('type title message data readAt createdAt updatedAt').sort({ createdAt: -1 }).limit(200).lean(),
    DataRequest.find({ user: userId, type: { $in: ['correction', 'grievance'] } }).select('requestId type message status adminNote createdAt resolvedAt').sort({ createdAt: -1 }).limit(100).lean(),
  ]);

  const exportOrders = orders.map((o) => ({
    orderNumber: o.orderNumber || '',
    shipmentId: o.shipmentId || '',
    restaurant: o.restaurantName || '',
    placedAt: o.createdAt || null,
    updatedAt: o.updatedAt || null,
    status: o.status || '',
    items: Array.isArray(o.items) ? o.items.map(i => ({
      name: i.name || '', price: i.price ?? null, quantity: i.quantity ?? null,
      isVeg: i.isVeg ?? null, customizations: i.customizations || {},
    })) : [],
    pricing: {
      subtotal: o.subtotal ?? null,
      deliveryFee: o.deliveryFee ?? null,
      discount: o.discount ?? null,
      total: o.total ?? null,
      tipAmount: o.tipAmount ?? null,
    },
    payment: { method: o.paymentMethod || '', status: o.paymentStatus || '' },
    deliveryAddress: o.deliveryAddress || null,
    deliveryDistanceKm: o.deliveryDistanceKm ?? null,
    restaurantNote: o.restaurantNote || '',
    deliveryInstructions: o.deliveryInstructions || '',
    estimatedDelivery: o.estimatedDelivery || null,
    deliveredAt: o.deliveredAt || null,
    cancelReason: o.cancelReason || '',
    refund: o.refund || null,
  }));

  await DataRequest.create({
    requestId: makeRequestId('ACCESS'),
    user: userId,
    type: 'access',
    message: 'Automated personal-data access/export request completed through the Privacy & Data page.',
    status: 'resolved',
    resolvedAt: new Date(),
  });

  res.json({
    success: true,
    data: {
      exportVersion: '1.0',
      generatedAt: new Date().toISOString(),
      account: publicUser(user),
      addresses,
      orders: exportOrders,
      reviews,
      platformRatings: ratings,
      notifications,
      privacyRequests,
      processingSummary: [
        'Account and authentication data are used to provide account access and security.',
        'Profile, contact and delivery information are used to provide food ordering and delivery.',
        'Order and support information are used to complete transactions, provide support, resolve disputes and maintain required records.',
        'Device notification identifiers may be used to send account, order and delivery notifications.',
        'Personal data may be shared with service providers and business partners only as needed to provide, secure or support Eatswada services.',
        'Where consent is the applicable basis, it can be withdrawn through the available means; processing may continue where otherwise authorised or required by law.',
      ],
      rights: ['access', 'correction', 'erasure', 'grievance redressal', 'nomination'],
    },
  });
});

const listMyPrivacyRequests = asyncHandler(async (req, res) => {
  const rows = await DataRequest.find({ user: req.user._id, type: { $in: ['correction', 'grievance'] } })
    .select('requestId type message status adminNote createdAt resolvedAt')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  res.json({ success: true, data: rows });
});

const createPrivacyRequest = asyncHandler(async (req, res) => {
  const type = String(req.body?.type || '').trim().toLowerCase();
  const message = String(req.body?.message || '').trim();
  if (!['correction', 'grievance'].includes(type)) return res.status(400).json({ success: false, message: 'Unsupported privacy request type.' });
  if (message.length < 5 || message.length > 2000) return res.status(400).json({ success: false, message: 'Please provide 5-2000 characters describing the request.' });

  const request = await DataRequest.create({
    requestId: makeRequestId(type === 'grievance' ? 'GRV' : 'COR'),
    user: req.user._id,
    type,
    message,
  });

  res.status(201).json({ success: true, message: 'Your request has been recorded.', data: { requestId: request.requestId } });
});

const setNominee = asyncHandler(async (req, res) => {
  const nominee = cleanNominee(req.body || {});
  const user = await User.findById(req.user._id);
  if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });
  user.dataNominee = nominee || undefined;
  await user.save();
  res.json({ success: true, message: nominee ? 'Nominee details saved.' : 'Nominee details cleared.', data: { nominee: nominee || null } });
});

const clearNominee = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });
  user.dataNominee = undefined;
  await user.save();
  res.json({ success: true, message: 'Nominee details cleared.' });
});

const deleteMyAccount = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = req.user._id;
  const confirmation = String(req.body?.confirmation || '').trim().toUpperCase();
  if (confirmation !== 'DELETE MY ACCOUNT') {
    return res.status(400).json({ success: false, message: 'Type DELETE MY ACCOUNT to confirm permanent account deletion.' });
  }
  if (req.user.role !== 'user') {
    return res.status(400).json({ success: false, message: 'Staff accounts must use the support process for account closure.' });
  }

  const active = await Order.findOne({
    user: userId,
    $or: [
      { status: { $in: ACTIVE_ORDER_STATUSES } },
      { 'refund.status': 'processing' },
    ],
  }).select('orderNumber status refund.status').lean();

  if (active) {
    return res.status(409).json({
      success: false,
      code: 'ACCOUNT_DELETION_BLOCKED_ACTIVE_ORDER',
      message: `Please complete or resolve active order ${active.orderNumber || ''} before deleting your account.`,
    });
  }

  const session = await mongoose.startSession();
  try {
    let affectedRestaurants = [];
    await session.withTransaction(async () => {
      const reviews = await Review.find({ user: userId }).select('restaurant').session(session).lean();
      affectedRestaurants = [...new Set(reviews.map(r => String(r.restaurant)).filter(Boolean))];

      // Orders are retained as anonymised transaction records where needed; direct customer identifiers are removed.
      await Order.updateMany(
        { user: userId },
        {
          $set: {
            user: null,
            customerName: '',
            customerPhone: '',
            restaurantNote: '',
            deliveryInstructions: '',
          },
          $unset: {
            deliveryAddress: 1,
            'rating.comment': 1,
            'rating.score': 1,
            'rating.givenAt': 1,
          },
        },
        { session }
      );

      await Address.deleteMany({ user: userId }, { session });
      await Cart.deleteMany({ user: userId }, { session });
      await Notification.deleteMany({ user: userId }, { session });
      await Review.deleteMany({ user: userId }, { session });
      await PlatformRating.deleteMany({ user: userId }, { session });
      await CouponRedemption.deleteMany({ user: userId }, { session });
      await CouponUsage.deleteMany({ user: userId }, { session });
      await IdempotencyKey.deleteMany({ user: userId }, { session });

      // Access-export audit rows are operational records and can be removed with
      // the account. Keep correction/grievance records where needed, but sever
      // the direct user reference after account deletion.
      await DataRequest.deleteMany({ user: userId, type: 'access' }, { session });
      await DataRequest.updateMany(
        { user: userId, type: { $in: ['correction', 'grievance'] } },
        { $set: { user: null } },
        { session }
      );

      await User.deleteOne({ _id: userId }, { session });

      for (const restaurantId of affectedRestaurants) {
        const stats = await Review.aggregate([
          { $match: { restaurant: new mongoose.Types.ObjectId(restaurantId), isVisible: true } },
          { $group: { _id: null, avg: { $avg: '$score' }, count: { $sum: 1 } } },
        ]).session(session);
        const row = stats[0] || { avg: 0, count: 0 };
        await Restaurant.updateOne(
          { _id: restaurantId },
          { $set: { rating: row.count ? Math.round(row.avg * 10) / 10 : 4, ratingCount: row.count, reviewCount: row.count } },
          { session }
        );
      }
    });
  } finally {
    await session.endSession();
  }

  res.json({
    success: true,
    message: 'Your Eatswada account has been deleted and customer identifiers have been removed from retained transaction records.',
  });
});

const listAdminRequests = asyncHandler(async (req, res) => {
  const status = req.query.status && ['open','in_progress','resolved','rejected'].includes(String(req.query.status))
    ? String(req.query.status) : null;
  const filter = status ? { status } : {};
  const rows = await DataRequest.find(filter)
    .populate('user', 'name phone email')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  res.json({ success: true, data: rows });
});

const updateAdminRequest = asyncHandler(async (req, res) => {
  const status = String(req.body?.status || '').trim();
  if (!['open','in_progress','resolved','rejected'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid request status.' });
  const adminNote = String(req.body?.adminNote || '').trim().slice(0, 2000);
  const update = { status, adminNote };
  if (status === 'resolved' || status === 'rejected') update.resolvedAt = new Date();
  else update.resolvedAt = null;
  const row = await DataRequest.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).populate('user', 'name phone email').lean();
  if (!row) return res.status(404).json({ success: false, message: 'Privacy request not found.' });
  res.json({ success: true, data: row });
});

module.exports = {
  exportMyData,
  listMyPrivacyRequests,
  createPrivacyRequest,
  setNominee,
  clearNominee,
  deleteMyAccount,
  listAdminRequests,
  updateAdminRequest,
};
