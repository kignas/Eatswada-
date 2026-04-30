const Menu = require('../models/Menu');
const Restaurant = require('../models/Restaurant');

// Get all restaurants so the CEO can choose who gets the new food item
exports.getAllRestaurants = async (req, res) => {
  try {
    const restaurants = await Restaurant.find({});
    res.json({ success: true, data: restaurants });
  } catch (err) { 
    res.status(500).json({ success: false, message: err.message }); 
  }
};

// CEO Power: Create a Master Item for ANY restaurant
exports.createMasterItem = async (req, res) => {
  try {
    const item = await Menu.create(req.body);
    res.json({ success: true, data: item });
  } catch (err) { 
    res.status(500).json({ success: false, message: err.message }); 
  }
};
