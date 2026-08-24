const express = require('express');
const router = express.Router();

// 1. Import all controllers cleanly
const { 
  getRestaurants,
  getRestaurantReviews, 
  getRestaurantById, 
  getMenu, 
  getUnder99Items,
  searchRestaurants, 
  getCategories,
  createRestaurant, 
  updateRestaurant, 
  deleteRestaurant,
  updateRestaurantAvailability,
  addMenuItem, 
  updateMenuItem, 
  deleteMenuItem,
  updateMenuItemAvailability
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
router.get('/:id/reviews', getRestaurantReviews);
router.get('/:id', getRestaurantById);
router.get('/:id/menu', getMenu); // This uses the Swiggy-style formatter we built!

// ==========================================
// 🛡️ ADMIN / VENDOR ROUTES (Protected)
// ==========================================

// Restaurant Management
// createRestaurant stays admin-only — vendor self-onboarding wasn't in scope here.
router.post('/', protect, authorize('admin'), createRestaurant);
// updateRestaurant/deleteRestaurant/updateRestaurantAvailability now also allow
// 'vendor' — the controller enforces that a vendor can only touch their own
// restaurant (canManageRestaurant), so admin-or-owner is the real gate.
router.put('/:id', protect, authorize('admin', 'ceo', 'vendor'), updateRestaurant);
router.delete('/:id', protect, authorize('admin', 'ceo', 'vendor'), deleteRestaurant);
router.patch('/:id/availability', protect, authorize('admin', 'ceo', 'vendor'), updateRestaurantAvailability);

// Menu Item Management
// Same admin-or-owner pattern: route allows both roles, controller checks
// ownership of the item's parent restaurant.
router.post('/:id/menu', protect, authorize('admin', 'vendor'), addMenuItem);
router.put('/:id/menu/:itemId', protect, authorize('admin', 'vendor'), updateMenuItem);
router.delete('/:id/menu/:itemId', protect, authorize('admin', 'vendor'), deleteMenuItem);
router.patch('/:id/menu/:itemId/availability', protect, authorize('admin', 'vendor'), updateMenuItemAvailability);

module.exports = router;
