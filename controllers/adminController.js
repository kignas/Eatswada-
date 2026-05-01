const Menu = require('../models/Menu');
const Restaurant = require('../models/Restaurant');

exports.getAllRestaurants = async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Access Denied.' });
    const restaurants = await Restaurant.find({});
    res.json({ success: true, data: restaurants });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.createMasterItem = async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Access Denied.' });
    
    // 🚨 THIS WAS FAILING! Fixes the ID so the Menu saves properly!
    if(req.body.restaurantId && !req.body.restaurant) {
        req.body.restaurant = req.body.restaurantId; 
    }

    const item = await Menu.create(req.body);
    res.status(201).json({ success: true, data: item });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getRestaurantMenu = async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Access Denied.' });
    const menu = await Menu.find({ $or: [{ restaurant: req.params.restaurantId }, { restaurantId: req.params.restaurantId }] }).sort({ createdAt: -1 });
    res.json({ success: true, data: menu });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.deleteMenuItem = async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Access Denied.' });
    await Menu.findByIdAndDelete(req.params.itemId);
    res.json({ success: true, message: 'Item deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
