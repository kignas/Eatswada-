const Restaurant = require('../models/Restaurant');
const MenuItem   = require('../models/Menu');
const asyncHandler = require('express-async-handler');

const getRestaurants = asyncHandler(async (req, res) => {
  const { veg, category, search, sort = 'rating', page = 1, limit = 20 } = req.query;
  
  // Production Fix: Only fetch active restaurants
  const filter = { isActive: true }; 
  
  if (veg === 'true') filter.isVeg = true;
  if (category) filter.categories = { $in: [category] };
  if (search) filter.$text = { $search: search };
  
  const sortMap = { rating: { rating: -1 }, time: { estimatedDeliveryMin: 1 }, distance: { distanceMeters: 1 } };
  const sortOpt = sortMap[sort] || { rating: -1 };
  const skip = (Number(page) - 1) * Number(limit);
  
  const [restaurants, total] = await Promise.all([
    Restaurant.find(filter).sort(sortOpt).skip(skip).limit(Number(limit)),
    Restaurant.countDocuments(filter),
  ]);
  
  res.json({ success: true, page: Number(page), pages: Math.ceil(total / Number(limit)), total, data: restaurants });
});

const getRestaurantById = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.findOne({ _id: req.params.id, isActive: true });
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
  res.json({ success: true, data: restaurant });
});

const getMenu = asyncHandler(async (req, res) => {
  // 1. Fetch only items that are active, in stock, and belong to this restaurant
  const items = await MenuItem.find({
    $or: [{ restaurant: req.params.id }, { restaurantId: req.params.id }],
    isAvailable: true,
    inStock: true
  }).sort({ category: 1, name: 1 });

  // 2. PRODUCTION FORMATTING: Group the items by Category for the frontend UI
  const groupedMenu = items.reduce((acc, item) => {
    // If an item was injected without a category, default to 'Recommended'
    const cat = item.category || 'Recommended'; 
    
    if (!acc[cat]) {
      acc[cat] = [];
    }
    acc[cat].push(item);
    return acc;
  }, {});

  // 3. Send the properly grouped object to the frontend
  res.json({ 
    success: true, 
    count: items.length, 
    data: groupedMenu // The frontend will now map this perfectly!
  });
});

  res.json({ success: true, count: items.length, data: grouped });
});

// 🚨 UPGRADED 99 STORE ENGINE
const getUnder99Items = asyncHandler(async (req, res) => {
  try {
    // Upgraded to pull items up to 149 and ensuring they aren't deleted
    const items = await MenuItem.find({ 
      price: { $lte: 149 },
      isAvailable: true 
    })
      .populate({
        path: 'restaurant',
        match: { isActive: true }, 
        select: 'name image rating'
      }) 
      .sort({ price: 1 })
      .limit(50);

    // Filter out items attached to a soft-deleted restaurant
    const validItems = items.filter(item => item.restaurant != null);
    res.json({ success: true, count: validItems.length, data: validItems });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch 99 store items' });
  }
});

const searchRestaurants = asyncHandler(async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ success: false, message: 'Query must be at least 2 characters' });
  const regex = new RegExp(q, 'i');
  
  try {
    const [restaurants, menuItems] = await Promise.all([
      Restaurant.find({ isActive: true, $or: [{ name: regex }, { cuisineDisplay: regex }] }).limit(10),
      MenuItem.find({ isAvailable: true, name: regex }).limit(20),
    ]);
    res.json({ success: true, data: { restaurants, menuItems } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Search failed' });
  }
});

const getCategories = asyncHandler(async (req, res) => {
  const cats = await Restaurant.distinct('categories', { isActive: true });
  res.json({ success: true, data: cats });
});

const createRestaurant = asyncHandler(async (req, res) => {
  if (!req.body.cuisine && req.body.cuisineDisplay) {
    req.body.cuisine = [req.body.cuisineDisplay]; 
  } else if (!req.body.cuisine) {
    req.body.cuisine = ['General'];
  }
  if (!req.body.slug && req.body.name) {
    req.body.slug = req.body.name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '') + '-' + Date.now();
  }
  const restaurant = await Restaurant.create(req.body);
  res.status(201).json({ success: true, data: restaurant });
});

const updateRestaurant = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
  res.json({ success: true, data: restaurant });
});

// 🚨 UPGRADED TO SOFT DELETE
const deleteRestaurant = asyncHandler(async (req, res) => {
  // Hides the restaurant without breaking carts/orders
  const restaurant = await Restaurant.findByIdAndUpdate(
    req.params.id, 
    { isActive: false, isOpen: false }, 
    { new: true }
  );

  if (!restaurant) {
    return res.status(404).json({ success: false, message: 'Restaurant not found' });
  }

  // Hide the menu items
  await MenuItem.updateMany(
    { restaurant: req.params.id },
    { isAvailable: false }
  );

  res.json({ success: true, message: 'Restaurant and menu successfully deactivated' });
});

const addMenuItem = asyncHandler(async (req, res) => {
  // 🚨 PRODUCTION FIX: Prevent "Orphaned" items
  const targetRestaurantId = req.params.id || req.body.restaurant || req.body.restaurantId;
  
  if (!targetRestaurantId) {
    return res.status(400).json({ success: false, message: 'Restaurant ID is required' });
  }

  const item = await MenuItem.create({ ...req.body, restaurant: targetRestaurantId });
  
  if (item.price <= 99) { item.isUnder99 = true; await item.save(); }
  res.status(201).json({ success: true, data: item });
});

const updateMenuItem = asyncHandler(async (req, res) => {
  const item = await MenuItem.findByIdAndUpdate(req.params.itemId, req.body, { new: true, runValidators: true });
  if (!item) return res.status(404).json({ success: false, message: 'Menu item not found' });
  res.json({ success: true, data: item });
});

const deleteMenuItem = asyncHandler(async (req, res) => {
  // Production apps also soft delete items, but keeping your hard delete here for now if preferred
  const item = await MenuItem.findByIdAndDelete(req.params.itemId);
  if (!item) return res.status(404).json({ success: false, message: 'Menu item not found' });
  res.json({ success: true, message: 'Menu item deleted' });
});

const getRestaurantMenuPublic = asyncHandler(async (req, res) => {
  const menu = await MenuItem.find({
      $or: [{ restaurant: req.params.id }, { restaurantId: req.params.id }],
      isAvailable: true
  }).sort({ createdAt: -1 });
  
  const availableMenu = menu.filter(item => item.inStock !== false);
  res.json({ success: true, count: availableMenu.length, data: availableMenu });
});

module.exports = {
  getRestaurants, getRestaurantById, getMenu, getUnder99Items,
  searchRestaurants, getCategories,
  createRestaurant, updateRestaurant, deleteRestaurant,
  addMenuItem, updateMenuItem, deleteMenuItem,
  getRestaurantMenuPublic
};
