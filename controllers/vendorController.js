const asyncHandler   = require('express-async-handler');
const Order          = require('../models/Order');
const Menu           = require('../models/Menu');
const Restaurant     = require('../models/Restaurant');

/* ─────────────────────────────────────────────────────────────
 *  STRICT JWT PAYLOAD GUARD
 *  Every handler that touches vendor-scoped data calls this
 *  first.  Returns true if the payload is valid; otherwise
 *  responds 403 and returns false.
 * ───────────────────────────────────────────────────────────── */
function assertVendorPayload(req, res) {
  if (
    !req.user ||
    req.user.role !== 'vendor' ||
    !req.user.restaurantId
  ) {
    res.status(403).json({
      success: false,
      message: 'Access denied. You are not a registered vendor.',
    });
    return false;
  }
  return true;
}

/* ─────────────────────────────────────────────────────────────
 *  1. GET /api/vendor/orders
 *     Returns ONLY the live orders that belong to this vendor.
 * ───────────────────────────────────────────────────────────── */
exports.getVendorOrders = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;

  const orders = await Order.find({
    restaurantId: req.user.restaurantId,
  }).sort({ createdAt: -1 });

  res.status(200).json({ success: true, data: orders });
});

/* ─────────────────────────────────────────────────────────────
 *  2. GET /api/vendor/menu
 *     Returns items grouped by category for this vendor.
 * ───────────────────────────────────────────────────────────── */
exports.getVendorMenu = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;

  const items = await Menu.find({
    restaurantId: req.user.restaurantId,
  }).sort({ sortOrder: 1, createdAt: -1 });

  // Group by category — safe iteration, no blind .map
  const grouped = {};
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const cat  = (typeof item.category === 'string' && item.category.trim())
      ? item.category.trim()
      : 'Uncategorised';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(item);
  }

  res.status(200).json({ success: true, data: grouped });
});

/* ─────────────────────────────────────────────────────────────
 *  3. POST /api/vendor/menu
 *     Adds a new item, always locked to this vendor's restaurant.
 * ───────────────────────────────────────────────────────────── */
exports.addMenuItem = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;

  const itemData = {
    ...req.body,
    restaurantId: req.user.restaurantId, // ownership override — hacker-proof
  };

  const item = await Menu.create(itemData);
  res.status(201).json({ success: true, data: item });
});

/* ─────────────────────────────────────────────────────────────
 *  4. PUT /api/vendor/menu/:id
 *     General field update (price, name, etc.).
 *     Security: compound query ensures item belongs to THIS vendor.
 * ───────────────────────────────────────────────────────────── */
exports.updateMenuItem = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;

  // Strip any attempt to re-assign ownership via the body
  const { restaurantId: _stripped, ...safeBody } = req.body;

  const item = await Menu.findOneAndUpdate(
    { _id: req.params.id, restaurantId: req.user.restaurantId },
    safeBody,
    { new: true, runValidators: true }
  );

  if (!item) {
    return res.status(404).json({
      success: false,
      message: 'Item not found or you do not have permission to edit it.',
    });
  }

  res.status(200).json({ success: true, data: item });
});

/* ─────────────────────────────────────────────────────────────
 *  5. PUT /api/vendor/menu/:id/toggle-stock  ← NEW
 *     Atomically flips the inStock boolean.
 *     Ownership is enforced via the compound { _id, restaurantId }
 *     filter — a vendor can NEVER touch another restaurant's item.
 * ───────────────────────────────────────────────────────────── */
exports.toggleItemStock = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;

  // Step 1: fetch the item (ownership check baked in)
  const existing = await Menu.findOne({
    _id:          req.params.id,
    restaurantId: req.user.restaurantId,
  });

  if (!existing) {
    return res.status(404).json({
      success: false,
      message: 'Menu item not found or access denied.',
    });
  }

  // Step 2: atomic toggle — no race condition vs. passing boolean from client
  const updated = await Menu.findByIdAndUpdate(
    existing._id,
    { inStock: !existing.inStock },
    { new: true }
  );

  res.status(200).json({
    success:  true,
    data:     updated,
    inStock:  updated.inStock,
    message:  updated.inStock
      ? 'Item is now In Stock.'
      : 'Item is now Out of Stock.',
  });
});

/* ─────────────────────────────────────────────────────────────
 *  6. GET /api/vendor/restaurant
 *     Returns the restaurant profile for the header / toggle.
 * ───────────────────────────────────────────────────────────── */
exports.getRestaurantProfile = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;

  const restaurant = await Restaurant.findById(req.user.restaurantId);
  if (!restaurant) {
    return res.status(404).json({
      success: false,
      message: 'Restaurant profile not found.',
    });
  }

  res.status(200).json({ success: true, data: restaurant });
});

/* ─────────────────────────────────────────────────────────────
 *  7. PUT /api/vendor/status
 *     Master online / offline switch for the restaurant.
 * ───────────────────────────────────────────────────────────── */
exports.updateRestaurantStatus = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;

  if (typeof req.body.isActive !== 'boolean') {
    return res.status(400).json({
      success: false,
      message: 'isActive must be a boolean.',
    });
  }

  const restaurant = await Restaurant.findOneAndUpdate(
    { owner: req.user._id },
    { isActive: req.body.isActive },
    { new: true }
  );

  if (!restaurant) {
    return res.status(404).json({
      success: false,
      message: 'Restaurant not found.',
    });
  }

  res.status(200).json({ success: true, data: restaurant });
});
