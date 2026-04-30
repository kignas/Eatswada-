const Menu = require('../models/Menu');
const Restaurant = require('../models/Restaurant');

// 1. Get all restaurants (LOCKED TO CEO)
exports.getAllRestaurants = async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Access Denied.' });
    const restaurants = await Restaurant.find({});
    res.json({ success: true, data: restaurants });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// 2. Create a Master Item (LOCKED TO CEO)
exports.createMasterItem = async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Access Denied.' });
    const item = await Menu.create(req.body);
    res.status(201).json({ success: true, data: item });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// 🚨 NEW 3. Get Current Items for a Specific Restaurant (LOCKED TO CEO)
exports.getRestaurantMenu = async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Access Denied.' });
    const menu = await Menu.find({ restaurantId: req.params.restaurantId }).sort({ createdAt: -1 });
    res.json({ success: true, data: menu });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// 🚨 NEW 4. Delete a Master Item completely (LOCKED TO CEO)
exports.deleteMenuItem = async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Access Denied.' });
    await Menu.findByIdAndDelete(req.params.itemId);
    res.json({ success: true, message: 'Item deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
