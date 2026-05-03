const express = require('express');
const router = express.Router();

// Import the controllers we just upgraded
const { 
  getAllRestaurants, 
  createMasterItem, 
  getRestaurantMenu, 
  deleteMenuItem,
  getTodayOrders 
} = require('../controllers/adminController');

// Import your authentication middleware to secure the CEO routes
const { protect, admin } = require('../middleware/authMiddleware');

// ==========================================
// 🏪 ADMIN RESTAURANT ROUTES
// ==========================================
router.get('/restaurants', protect, admin, getAllRestaurants);
router.get('/restaurants/:restaurantId/menu', protect, admin, getRestaurantMenu);

// ==========================================
// 🍔 MASTER CATALOG INJECTION ROUTES
// ==========================================
// 🚨 This MUST point to createMasterItem to fix the orphan bug
router.post('/menu', protect, admin, createMasterItem);
router.delete('/menu/:itemId', protect, admin, deleteMenuItem);

// ==========================================
// 📊 METRICS & DASHBOARD ROUTES
// ==========================================
router.get('/orders/today', protect, admin, getTodayOrders);

module.exports = router;
