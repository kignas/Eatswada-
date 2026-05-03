const express = require('express');
const router = express.Router();

// 1. Import all controllers cleanly
const { 
  getRestaurants, 
  getRestaurantById, 
  getMenu, 
  getUnder99Items,
  searchRestaurants, 
  getCategories,
  createRestaurant, 
  updateRestaurant, 
  deleteRestaurant,
  addMenuItem, 
  updateMenuItem, 
  deleteMenuItem
} = require('../controllers/restaurantController');

// 2. Import Auth Middleware
const { protect, authorize } = require('../middleware/authMiddleware');

// ==========================================
// 🌐 PUBLIC ROUTES (Visible to Customers)
// ==========================================
// Note: Specific routes must go BEFORE dynamic routes like '/:id'

router.get('/search', searchRestaurants);
router.get('/categories', getCategories);
router.get('/under99', getUnder99Items);

router.get('/', getRestaurants);

// Dynamic public routes
router.get('/:id', getRestaurantById);
router.get('/:id/menu', getMenu); // This uses the Swiggy-style formatter we built!

// ==========================================
// 🛡️ ADMIN / VENDOR ROUTES (Protected)
// ==========================================

// Restaurant Management
router.post('/', protect, authorize('admin'), createRestaurant);
router.put('/:id', protect, authorize('admin'), updateRestaurant);
router.delete('/:id', protect, authorize('admin'), deleteRestaurant);

// Menu Item Management
router.post('/:id/menu', protect, authorize('admin'), addMenuItem);
router.put('/:id/menu/:itemId', protect, authorize('admin'), updateMenuItem);
router.delete('/:id/menu/:itemId', protect, authorize('admin'), deleteMenuItem);

module.exports = router;
