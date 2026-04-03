const express = require('express');
const router  = express.Router();

const {
  getRestaurants, getRestaurantById, getMenu, getUnder99Items,
  searchRestaurants, getCategories,
  createRestaurant, updateRestaurant, deleteRestaurant,
  addMenuItem, updateMenuItem, deleteMenuItem,
} = require('../controllers/restaurantController');

const { protect, authorize } = require('../middleware/authMiddleware');

// ── Public ───────────────────────────────────────────────────
router.get('/search',     searchRestaurants);
router.get('/categories', getCategories);
router.get('/under99',    getUnder99Items);
router.get('/',           getRestaurants);
router.get('/:id',        getRestaurantById);
router.get('/:id/menu',   getMenu);

// ── Admin ────────────────────────────────────────────────────
router.post  ('/',        protect, authorize('admin'), createRestaurant);
router.put   ('/:id',     protect, authorize('admin'), updateRestaurant);
router.delete('/:id',     protect, authorize('admin'), deleteRestaurant);

// ── Menu item admin ──────────────────────────────────────────
router.post  ('/:id/menu',          protect, authorize('admin'), addMenuItem);
router.put   ('/:id/menu/:itemId',  protect, authorize('admin'), updateMenuItem);
router.delete('/:id/menu/:itemId',  protect, authorize('admin'), deleteMenuItem);

module.exports = router;
