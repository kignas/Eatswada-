const asyncHandler   = require('express-async-handler');
const Order           = require('../models/Order');
const Menu            = require('../models/Menu');
const Restaurant      = require('../models/Restaurant');

function assertVendorPayload(req, res) {
  if (!req.user || req.user.role !== 'vendor' || !req.user.restaurantId) {
    res.status(403).json({ success: false, message: 'Access denied. You are not a registered vendor.' });
    return false;
  }
  return true;
}

// Shared ownership filter. Kept as one helper instead of repeating the
// $or in every handler — some existing documents were saved with a
// `restaurantId` field before the schema settled on `restaurant`, so both
// are checked. (No behaviour change from the previous per-handler copies.)
function restaurantOwnershipFilter(req) {
  return { $or: [{ restaurant: req.user.restaurantId }, { restaurantId: req.user.restaurantId }] };
}

/* ─────────────────────────────────────────────────────────────
 *  ORDER STATUS GROUPS
 *  Mirrors the lifecycle defined on the Order model:
 *  placed → confirmed → preparing → out_for_delivery → delivered
 *  placed → cancelled (rejected by restaurant, or cancelled by user)
 * ───────────────────────────────────────────────────────────── */
const QUEUE_STATUSES   = ['placed', 'confirmed', 'preparing', 'out_for_delivery'];
const HISTORY_STATUSES = ['delivered', 'cancelled'];

// Forward-only transitions a vendor may trigger through the generic
// status endpoint. 'placed' is deliberately excluded — it can only leave
// that state through the dedicated accept/reject endpoints below, since
// those need their own reason/validation handling.
const VENDOR_STATUS_TRANSITIONS = {
  confirmed: 'preparing',
  preparing: 'out_for_delivery',
};

/* ─────────────────────────────────────────────────────────────
 *  ORDERS
 * ───────────────────────────────────────────────────────────── */

exports.getVendorOrders = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;

  // Optional ?view=queue | ?view=history — omitted entirely, this behaves
  // exactly as before and returns every order for the restaurant.
  const { view } = req.query;
  let statusFilter = {};
  if (view === 'queue')   statusFilter = { status: { $in: QUEUE_STATUSES } };
  if (view === 'history') statusFilter = { status: { $in: HISTORY_STATUSES } };

  const orders = await Order.find({
    ...restaurantOwnershipFilter(req),
    ...statusFilter,
  }).sort({ createdAt: -1 });

  res.status(200).json({ success: true, data: orders });
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
  await order.save();

  res.status(200).json({ success: true, data: order });
});

/* ─────────────────────────────────────────────────────────────
 *  MENU  (unchanged behaviour — only using the shared filter helper)
 * ───────────────────────────────────────────────────────────── */

exports.getVendorMenu = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  const items = await Menu.find(restaurantOwnershipFilter(req)).sort({ sortOrder: 1, createdAt: -1 });

  const grouped = {};
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const cat  = (typeof item.category === 'string' && item.category.trim()) ? item.category.trim() : 'Uncategorised';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(item);
  }
  res.status(200).json({ success: true, data: grouped });
});

exports.addMenuItem = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  const itemData = {
    ...req.body,
    restaurant: req.user.restaurantId,
    restaurantId: req.user.restaurantId,
  };
  const item = await Menu.create(itemData);
  res.status(201).json({ success: true, data: item });
});

exports.updateMenuItem = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  const { restaurant, restaurantId, ...safeBody } = req.body;
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
 *  RESTAURANT  (unchanged)
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
    { owner: req.user._id },
    { isActive: req.body.isActive },
    { new: true }
  );
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found.' });
  res.status(200).json({ success: true, data: restaurant });
});
