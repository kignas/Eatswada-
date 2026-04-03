const Restaurant = require('../models/Restaurant');
const MenuItem   = require('../models/Menu');
const asyncHandler = require('express-async-handler');

// GET /api/restaurants  — list with optional filters
const getRestaurants = asyncHandler(async (req, res) => {
  const { veg, category, search, sort = 'rating', page = 1, limit = 20 } = req.query;
  const filter = {};
  if (veg === 'true')   filter.isVeg = true;
  if (category)         filter.categories = { $in: [category] };
  if (search)           filter.$text = { $search: search };

  const sortMap = { rating: { rating: -1 }, time: { time: 1 }, distance: { distance: 1 } };
  const sortOpt = sortMap[sort] || { rating: -1 };

  const skip  = (Number(page) - 1) * Number(limit);
  const [restaurants, total] = await Promise.all([
    Restaurant.find(filter).sort(sortOpt).skip(skip).limit(Number(limit)),
    Restaurant.countDocuments(filter),
  ]);

  res.json({
    success: true,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
    total,
    data: restaurants,
  });
});

// GET /api/restaurants/:id
const getRestaurantById = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.findById(req.params.id);
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
  res.json({ success: true, data: restaurant });
});

// GET /api/restaurants/:id/menu
const getMenu = asyncHandler(async (req, res) => {
  const { category, veg } = req.query;
  const filter = { restaurant: req.params.id, isAvailable: true };
  if (category) filter.category = category;
  if (veg === 'true') filter.isVeg = true;

  const items = await MenuItem.find(filter).sort({ category: 1, sortOrder: 1, name: 1 });

  // Group by category
  const grouped = items.reduce((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {});

  res.json({ success: true, count: items.length, data: grouped });
});

// GET /api/restaurants/under99  — items priced ≤₹99 (matches under99.html)
const getUnder99Items = asyncHandler(async (req, res) => {
  const items = await MenuItem.find({ isUnder99: true, isAvailable: true, price: { $lte: 99 } })
    .populate('restaurant', 'name image rating')
    .sort({ price: 1 })
    .limit(40);
  res.json({ success: true, count: items.length, data: items });
});

// GET /api/restaurants/search?q=biryani
const searchRestaurants = asyncHandler(async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2)
    return res.status(400).json({ success: false, message: 'Query must be at least 2 characters' });

  const regex = new RegExp(q, 'i');
  const [restaurants, menuItems] = await Promise.all([
    Restaurant.find({ $or: [{ name: regex }, { cuisineDisplay: regex }] }).limit(10),
    MenuItem.find({ name: regex, isAvailable: true })
      .populate('restaurant', 'name image rating time distance')
      .limit(20),
  ]);

  res.json({ success: true, data: { restaurants, menuItems } });
});

// GET /api/restaurants/categories  — distinct category tags
const getCategories = asyncHandler(async (req, res) => {
  const cats = await Restaurant.distinct('categories');
  res.json({ success: true, data: cats });
});

// ── ADMIN: create / update / delete ──────────────────────────

const createRestaurant = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.create(req.body);
  res.status(201).json({ success: true, data: restaurant });
});

const updateRestaurant = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
  res.json({ success: true, data: restaurant });
});

const deleteRestaurant = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.findByIdAndDelete(req.params.id);
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
  await MenuItem.deleteMany({ restaurant: req.params.id });
  res.json({ success: true, message: 'Restaurant and menu deleted' });
});

// ── ADMIN: menu item CRUD ─────────────────────────────────────

const addMenuItem = asyncHandler(async (req, res) => {
  const item = await MenuItem.create({ ...req.body, restaurant: req.params.id });
  // Auto-flag under99
  if (item.price <= 99) { item.isUnder99 = true; await item.save(); }
  res.status(201).json({ success: true, data: item });
});

const updateMenuItem = asyncHandler(async (req, res) => {
  const item = await MenuItem.findByIdAndUpdate(req.params.itemId, req.body, { new: true, runValidators: true });
  if (!item) return res.status(404).json({ success: false, message: 'Menu item not found' });
  res.json({ success: true, data: item });
});

const deleteMenuItem = asyncHandler(async (req, res) => {
  const item = await MenuItem.findByIdAndDelete(req.params.itemId);
  if (!item) return res.status(404).json({ success: false, message: 'Menu item not found' });
  res.json({ success: true, message: 'Menu item deleted' });
});

module.exports = {
  getRestaurants, getRestaurantById, getMenu, getUnder99Items,
  searchRestaurants, getCategories,
  createRestaurant, updateRestaurant, deleteRestaurant,
  addMenuItem, updateMenuItem, deleteMenuItem,
};
    
