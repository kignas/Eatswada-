const Order = require('../models/Order');
const Menu = require('../models/Menu');

// 1. Get ONLY the logged-in vendor's live orders
exports.getVendorOrders = async (req, res) => {
  try {
    if (req.user.role !== 'vendor' || !req.user.restaurantId) {
        return res.status(403).json({ success: false, message: 'Access denied. You are not a registered vendor.' });
    }
    
    // 🔒 SECURE: Fetch orders where the restaurantId matches the logged-in user's restaurant
    const orders = await Order.find({ restaurantId: req.user.restaurantId }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: orders });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// 2. Get ONLY the logged-in vendor's menu items
exports.getVendorMenu = async (req, res) => {
  try {
    if (req.user.role !== 'vendor') return res.status(403).json({ success: false, message: 'Access denied.' });
    
    const menu = await Menu.find({ restaurantId: req.user.restaurantId }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: menu });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// 3. Add a new Menu Item (Automatically locks to this vendor)
exports.addMenuItem = async (req, res) => {
  try {
    if (req.user.role !== 'vendor') return res.status(403).json({ success: false, message: 'Access denied.' });

    // Force the item to belong to this vendor, even if a hacker tries to change it
    const itemData = {
        ...req.body,
        restaurantId: req.user.restaurantId
    };

    const item = await Menu.create(itemData);
    res.status(201).json({ success: true, data: item });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// 4. Update Price or Stock (Security check: can only edit THEIR OWN items)
exports.updateMenuItem = async (req, res) => {
  try {
    if (req.user.role !== 'vendor') return res.status(403).json({ success: false, message: 'Access denied.' });

    // 🔒 SECURE: Find the item by ID, BUT make sure it also belongs to this restaurant
    const item = await Menu.findOneAndUpdate(
        { _id: req.params.id, restaurantId: req.user.restaurantId }, 
        req.body, 
        { new: true }
    );

    if (!item) return res.status(404).json({ success: false, message: 'Item not found or unauthorized.' });
    res.status(200).json({ success: true, data: item });
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
