const express = require('express');
const router = express.Router();

const {
  getMenuItemsByRestaurant,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  getPendingMenuItems,
  reviewMenuItem,
} = require('../controllers/menuController');

const { protect, authorize } = require('../middleware/authMiddleware');

// ==========================================
// 🛡️ ADMIN ROUTES (Manage Menu page)
// ==========================================

router.get('/pending', protect, authorize('admin'), getPendingMenuItems);
router.get('/', protect, authorize('admin'), getMenuItemsByRestaurant);
router.post('/', protect, authorize('admin'), createMenuItem);
router.put('/:itemId', protect, authorize('admin'), updateMenuItem);
router.patch('/:itemId/review/:action', protect, authorize('admin'), reviewMenuItem);
router.delete('/:itemId', protect, authorize('admin'), deleteMenuItem);

module.exports = router;
