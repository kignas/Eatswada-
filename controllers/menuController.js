const MenuItem = require('../models/Menu');
const Restaurant = require('../models/Restaurant');
const asyncHandler = require('express-async-handler');

// GET /api/menu?restaurantId=... — admin view of one restaurant's full menu,
// including out-of-stock items (unlike the public getMenu, which filters inStock:true)
const getMenuItemsByRestaurant = asyncHandler(async (req, res) => {
  const { restaurantId } = req.query;
  if (!restaurantId) {
    return res.status(400).json({ success: false, message: 'restaurantId is required' });
  }

  const items = await MenuItem.find({ restaurantId }).sort({ category: 1, name: 1 });
  res.json({ success: true, count: items.length, data: items });
});

// POST /api/menu — admin creates a menu item and assigns it to a restaurant
const createMenuItem = asyncHandler(async (req, res) => {
  const { restaurantId } = req.body;
  if (!restaurantId) {
    return res.status(400).json({ success: false, message: 'restaurantId is required' });
  }

  const restaurant = await Restaurant.findById(restaurantId);
  if (!restaurant) {
    return res.status(404).json({ success: false, message: 'Restaurant not found' });
  }

  const payload = { ...req.body };
  if (!payload.image) delete payload.image; // let the schema default apply instead of saving ''

  const item = await MenuItem.create(payload);
  if (item.price <= 99) {
    item.isUnder99 = true;
    await item.save();
  }

  res.status(201).json({ success: true, data: item });
});

// PUT /api/menu/:itemId — admin edits any field, including reassigning the restaurant
const updateMenuItem = asyncHandler(async (req, res) => {
  if (req.body.restaurantId) {
    const restaurant = await Restaurant.findById(req.body.restaurantId);
    if (!restaurant) {
      return res.status(404).json({ success: false, message: 'Restaurant not found' });
    }
  }

  const item = await MenuItem.findByIdAndUpdate(req.params.itemId, req.body, {
    new: true,
    runValidators: true,
  });
  if (!item) return res.status(404).json({ success: false, message: 'Menu item not found' });

  if (req.body.price !== undefined) {
    item.isUnder99 = item.price <= 99;
    await item.save();
  }

  res.json({ success: true, data: item });
});

// DELETE /api/menu/:itemId
const deleteMenuItem = asyncHandler(async (req, res) => {
  const item = await MenuItem.findByIdAndDelete(req.params.itemId);
  if (!item) return res.status(404).json({ success: false, message: 'Menu item not found' });
  res.json({ success: true, message: 'Menu item deleted' });
});

module.exports = {
  getMenuItemsByRestaurant,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
};
