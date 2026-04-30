const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { getAllRestaurants, createMasterItem, getRestaurantMenu, deleteMenuItem } = require('../controllers/adminController');

router.get('/restaurants', protect, getAllRestaurants);
router.post('/menu', protect, createMasterItem);

// 🚨 THE NEW ROUTES FOR VIEWING AND DELETING ITEMS
router.get('/menu/:restaurantId', protect, getRestaurantMenu);
router.delete('/menu/:itemId', protect, deleteMenuItem);

module.exports = router;
