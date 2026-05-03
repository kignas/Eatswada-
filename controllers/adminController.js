const Menu = require('../models/Menu');
const Restaurant = require('../models/Restaurant');
const Order = require('../models/Order'); // Needed for the Today's Orders metric

exports.getAllRestaurants = async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Access Denied.' });
    const restaurants = await Restaurant.find({});
    res.json({ success: true, data: restaurants });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// 🚨 UPGRADED BULLETPROOF INJECTION ENGINE
exports.createMasterItem = async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Access Denied.' });

    // 1. Bulletproof ID mapping to prevent orphans
    const targetId = req.body.restaurant || req.body.restaurantId;
    if (!targetId) {
        return res.status(400).json({ success: false, message: 'Restaurant ID is required' });
    }

    // 2. Force the correct data structure so it shows up on the main site & vendor pages
    req.body.restaurant = targetId;
    req.body.isAvailable = true; // Forces visibility on main website
    req.body.inStock = true;

    // 3. Auto-flag for the 99 Store
    if (Number(req.body.price) <= 99) {
      req.body.isUnder99 = true;
    }

    const item = await Menu.create(req.body);
    res.status(201).json({ success: true, data: item });
  } catch (err) { 
    res.status(500).json({ success: false, message: err.message }); 
  }
};

exports.getRestaurantMenu = async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Access Denied.' });
    const menu = await Menu.find({ 
        $or: [{ restaurant: req.params.restaurantId }, { restaurantId: req.params.restaurantId }] 
    }).sort({ createdAt: -1 });
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

// 📊 NEW: POWERS THE "TODAY'S ORDERS" METRIC ON CEO DASHBOARD
exports.getTodayOrders = async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Access Denied.' });

    // Calculate the start and end time for the current day
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const count = await Order.countDocuments({ createdAt: { $gte: start, $lt: end } });
    res.json({ success: true, count: count });
  } catch (err) { 
    res.status(500).json({ success: false, message: err.message }); 
  }
};
