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
const { requirePermission } = require('../middleware/permissionMiddleware');

// ==========================================
// 🛡️ ADMIN ROUTES (Manage Menu page)
// ==========================================

router.get('/pending', protect, authorize('admin'), requirePermission('catalog.manage'), getPendingMenuItems);
router.get('/', protect, authorize('admin'), requirePermission('catalog.manage'), getMenuItemsByRestaurant);
router.post('/', protect, authorize('admin'), requirePermission('catalog.manage'), createMenuItem);
router.put('/:itemId', protect, authorize('admin'), requirePermission('catalog.manage'), updateMenuItem);
router.patch('/:itemId/review/:action', protect, authorize('admin'), requirePermission('catalog.manage'), reviewMenuItem);
router.delete('/:itemId', protect, authorize('admin'), requirePermission('catalog.manage'), deleteMenuItem);

module.exports = router;
