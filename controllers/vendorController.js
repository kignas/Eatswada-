const asyncHandler   = require('express-async-handler');
const Order          = require('../models/Order');
const Menu           = require('../models/Menu');
const Restaurant     = require('../models/Restaurant');

function assertVendorPayload(req, res) {
  if (!req.user || req.user.role !== 'vendor' || !req.user.restaurantId) {
    res.status(403).json({ success: false, message: 'Access denied. You are not a registered vendor.' });
    return false;
  }
  return true;
}

exports.getVendorOrders = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  // 🚨 FIX: Using $or to catch the order regardless of how the schema saved the ID
  const orders = await Order.find({
    $or: [{ restaurant: req.user.restaurantId }, { restaurantId: req.user.restaurantId }]
  }).sort({ createdAt: -1 });
  res.status(200).json({ success: true, data: orders });
});

exports.getVendorMenu = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  // 🚨 FIX: Correct database field targeting
  const items = await Menu.find({
    $or: [{ restaurant: req.user.restaurantId }, { restaurantId: req.user.restaurantId }]
  }).sort({ sortOrder: 1, createdAt: -1 });

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
    restaurant: req.user.restaurantId, // 🚨 FIX: Force correct field mapping
    restaurantId: req.user.restaurantId
  };
  const item = await Menu.create(itemData);
  res.status(201).json({ success: true, data: item });
});

exports.updateMenuItem = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  const { restaurant, restaurantId, ...safeBody } = req.body;
  const item = await Menu.findOneAndUpdate(
    { _id: req.params.id, $or: [{ restaurant: req.user.restaurantId }, { restaurantId: req.user.restaurantId }] },
    safeBody,
    { new: true, runValidators: true }
  );
  if (!item) return res.status(404).json({ success: false, message: 'Item not found or access denied.' });
  res.status(200).json({ success: true, data: item });
});

exports.toggleItemStock = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  // 🚨 FIX: Correct ownership check for toggling inventory
  const existing = await Menu.findOne({
    _id: req.params.id,
    $or: [{ restaurant: req.user.restaurantId }, { restaurantId: req.user.restaurantId }]
  });

  if (!existing) return res.status(404).json({ success: false, message: 'Menu item not found or access denied.' });

  const updated = await Menu.findByIdAndUpdate(existing._id, { inStock: !existing.inStock }, { new: true });
  res.status(200).json({ success: true, data: updated, inStock: updated.inStock, message: updated.inStock ? 'Item is now In Stock.' : 'Item is now Out of Stock.' });
});

exports.getRestaurantProfile = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  const restaurant = await Restaurant.findById(req.user.restaurantId);
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant profile not found.' });
  res.status(200).json({ success: true, data: restaurant });
});

exports.updateRestaurantStatus = asyncHandler(async (req, res) => {
  if (!assertVendorPayload(req, res)) return;
  if (typeof req.body.isActive !== 'boolean') return res.status(400).json({ success: false, message: 'isActive must be a boolean.' });
  const restaurant = await Restaurant.findOneAndUpdate({ owner: req.user._id }, { isActive: req.body.isActive }, { new: true });
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found.' });
  res.status(200).json({ success: true, data: restaurant });
});
