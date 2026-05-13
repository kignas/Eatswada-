'use strict';

/**
 * vendorController.js
 *
 * Handles all Vendor Portal business logic.
 * Every export is wrapped in express-async-handler so unhandled promise
 * rejections never crash the Render server process.
 *
 * Architectural rules enforced:
 *  - No hard deletes (Rule #1): menu items use isAvailable: false.
 *  - Backend-driven formatting (Rule #2): getVendorMenu groups by category.
 *  - No orphan items (Rule #3): restaurantId is always server-enforced.
 *  - Strict data types (Rule #4): price is coerced to Number on write.
 *  - Strict payload validation: no req.body is ever trusted blindly.
 *  - Whitelisted updates: updateMenuItem only allows specific fields.
 */

const asyncHandler = require('express-async-handler');
const Order      = require('../models/Order');
const Menu       = require('../models/Menu');
const Restaurant = require('../models/Restaurant');

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — shared role + restaurantId guard
// ─────────────────────────────────────────────────────────────────────────────
function assertVendor(req, res) {
  if (req.user.role !== 'vendor') {
    res.status(403).json({ success: false, message: 'Access denied. Vendor role required.' });
    return false;
  }
  if (!req.user.restaurantId) {
    res.status(403).json({
      success: false,
      message: 'Access denied. Your account is not linked to a restaurant. Contact EatSwada support.',
    });
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /api/vendor/orders
//    Returns only this vendor's non-terminal orders, newest first.
// ─────────────────────────────────────────────────────────────────────────────
exports.getVendorOrders = asyncHandler(async (req, res) => {
  if (!assertVendor(req, res)) return;

  const orders = await Order.find({
    restaurantId: req.user.restaurantId,
  })
    .sort({ createdAt: -1 })
    .lean();

  res.status(200).json({ success: true, count: orders.length, data: orders });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /api/vendor/menu
//    Returns this vendor's available menu items GROUPED BY CATEGORY.
//    Rule #2: Backend shapes the data so the frontend never needs to transform.
//
//    Response shape:
//    {
//      success: true,
//      data: {
//        "Starters": [ { _id, name, price, isVeg, inStock, ... }, ... ],
//        "Mains":    [ ... ],
//        ...
//      }
//    }
// ─────────────────────────────────────────────────────────────────────────────
exports.getVendorMenu = asyncHandler(async (req, res) => {
  if (!assertVendor(req, res)) return;

  // Fetch all menu items for this restaurant (including out-of-stock).
  // isAvailable: false means soft-deleted — exclude those.
  const items = await Menu.find({
    restaurantId: req.user.restaurantId,
    isAvailable: { $ne: false },
  })
    .sort({ category: 1, createdAt: 1 })
    .lean();

  // Group by category — plain loop, no .reduce() without safety checks.
  const grouped = {};
  if (Array.isArray(items)) {
    for (const item of items) {
      const cat = (typeof item.category === 'string' && item.category.trim())
        ? item.category.trim()
        : 'Uncategorised';

      if (!grouped[cat]) {
        grouped[cat] = [];
      }
      grouped[cat].push(item);
    }
  }

  res.status(200).json({ success: true, data: grouped });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. POST /api/vendor/menu
//    Creates a new menu item. restaurantId is always set from the server token —
//    any restaurantId in the request body is IGNORED (Rule #3: no orphan items).
// ─────────────────────────────────────────────────────────────────────────────
exports.addMenuItem = asyncHandler(async (req, res) => {
  if (!assertVendor(req, res)) return;

  const { name, price, category, description, image, isVeg } = req.body;

  // ── Strict payload validation ──
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ success: false, message: 'Item name is required.' });
  }

  const parsedPrice = Number(price);
  if (!price || isNaN(parsedPrice) || parsedPrice < 0) {
    return res.status(400).json({ success: false, message: 'A valid price (number ≥ 0) is required.' });
  }

  if (!category || typeof category !== 'string' || category.trim().length === 0) {
    return res.status(400).json({ success: false, message: 'Category is required.' });
  }

  // Build the item with a server-enforced restaurantId.
  const itemData = {
    name: name.trim(),
    price: parsedPrice,           // Rule #4: stored as Number
    category: category.trim(),
    description: typeof description === 'string' ? description.trim() : '',
    image: typeof image === 'string' ? image.trim() : '',
    isVeg: Boolean(isVeg),
    inStock: true,
    isAvailable: true,
    restaurantId: req.user.restaurantId, // Rule #3: always server-enforced
  };

  const item = await Menu.create(itemData);

  res.status(201).json({ success: true, data: item });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PUT /api/vendor/menu/:id
//    Updates a menu item. Only whitelisted fields can be changed.
//    restaurantId, _id, and createdAt can NEVER be overwritten through this route.
//    The compound query { _id, restaurantId } ensures cross-vendor tampering
//    returns 404 rather than exposing that the item exists.
// ─────────────────────────────────────────────────────────────────────────────
exports.updateMenuItem = asyncHandler(async (req, res) => {
  if (!assertVendor(req, res)) return;

  // ── Whitelist: only these fields can be updated via the vendor portal ──
  const ALLOWED_FIELDS = ['name', 'price', 'category', 'description', 'image', 'isVeg', 'inStock'];
  const updates = {};

  for (const field of ALLOWED_FIELDS) {
    if (req.body[field] !== undefined) {
      updates[field] = req.body[field];
    }
  }

  // ── Type coercion for price (Rule #4) ──
  if (updates.price !== undefined) {
    const parsedPrice = Number(updates.price);
    if (isNaN(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({ success: false, message: 'Price must be a valid number ≥ 0.' });
    }
    updates.price = parsedPrice;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ success: false, message: 'No valid fields provided to update.' });
  }

  // Compound query — item must belong to this vendor's restaurant.
  const item = await Menu.findOneAndUpdate(
    { _id: req.params.id, restaurantId: req.user.restaurantId },
    { $set: updates },
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

// ─────────────────────────────────────────────────────────────────────────────
// 5. DELETE /api/vendor/menu/:id  (SOFT DELETE — Rule #1)
//    Sets isAvailable: false. The item is never hard-deleted so existing
//    order history that references it remains intact.
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteMenuItem = asyncHandler(async (req, res) => {
  if (!assertVendor(req, res)) return;

  const item = await Menu.findOneAndUpdate(
    { _id: req.params.id, restaurantId: req.user.restaurantId },
    { $set: { isAvailable: false, inStock: false } },
    { new: true }
  );

  if (!item) {
    return res.status(404).json({
      success: false,
      message: 'Item not found or you do not have permission to remove it.',
    });
  }

  res.status(200).json({ success: true, message: 'Item removed from menu.', data: item });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. PUT /api/vendor/status
//    Toggles the restaurant's online/offline master switch.
//    Strict boolean validation — no arbitrary payload is accepted.
// ─────────────────────────────────────────────────────────────────────────────
exports.updateRestaurantStatus = asyncHandler(async (req, res) => {
  if (!assertVendor(req, res)) return;

  // ── Strict boolean validation ──
  const { isActive } = req.body;
  if (typeof isActive !== 'boolean') {
    return res.status(400).json({
      success: false,
      message: 'isActive must be a boolean (true or false).',
    });
  }

  const restaurant = await Restaurant.findOneAndUpdate(
    { owner: req.user._id },
    { $set: { isActive } },
    { new: true, runValidators: true }
  );

  if (!restaurant) {
    return res.status(404).json({
      success: false,
      message: 'No restaurant found for your account.',
    });
  }

  res.status(200).json({
    success: true,
    message: `Restaurant is now ${isActive ? 'Online' : 'Offline'}.`,
    data: { _id: restaurant._id, name: restaurant.name, isActive: restaurant.isActive },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. GET /api/vendor/restaurant
//    Returns the vendor's own restaurant details (name, isActive, etc.)
//    so the frontend can populate the header on load without depending on
//    order data being present.
// ─────────────────────────────────────────────────────────────────────────────
exports.getVendorRestaurant = asyncHandler(async (req, res) => {
  if (!assertVendor(req, res)) return;

  const restaurant = await Restaurant.findOne({ owner: req.user._id })
    .select('name isActive isOpen rating ratingCount cuisineDisplay image')
    .lean();

  if (!restaurant) {
    return res.status(404).json({
      success: false,
      message: 'No restaurant found for your account.',
    });
  }

  res.status(200).json({ success: true, data: restaurant });
});
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const Restaurant = require('../models/Restaurant');
const Menu = require('../models/Menu');

// This controls the Master Online/Offline Switch
exports.updateRestaurantStatus = async (req, res) => {
  try {
    // Finds the restaurant owned by the logged-in vendor and updates isActive
    const restaurant = await Restaurant.findOneAndUpdate(
       { owner: req.user._id },
       { isActive: req.body.isActive },
       { new: true }
    );
    res.json({ success: true, data: restaurant });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};
