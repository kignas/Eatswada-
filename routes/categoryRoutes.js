const express = require('express');
const router = express.Router();

// 1. Import all controllers cleanly
const {
  getCategories,
  getAllCategories,
  createCategory,
  updateCategory,
  toggleCategoryStatus,
  deleteCategory,
  reorderCategories,
} = require('../controllers/categoryController');

// 2. Import Auth Middleware
const { protect, authorize } = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');

// ==========================================
// 🌐 PUBLIC ROUTES (homepage "What's on your mind?")
// ==========================================

router.get('/', getCategories);

// ==========================================
// 🛡️ ADMIN ROUTES (Manage Categories page)
// ==========================================
// Note: /all and /reorder must stay above the dynamic '/:id' routes.

router.get('/all', protect, authorize('admin'), requirePermission('catalog.manage'), getAllCategories);
router.post('/', protect, authorize('admin'), requirePermission('catalog.manage'), createCategory);
router.put('/reorder', protect, authorize('admin'), requirePermission('catalog.manage'), reorderCategories);
router.put('/:id', protect, authorize('admin'), requirePermission('catalog.manage'), updateCategory);
router.patch('/:id/toggle', protect, authorize('admin'), requirePermission('catalog.manage'), toggleCategoryStatus);
router.delete('/:id', protect, authorize('admin'), requirePermission('catalog.manage'), deleteCategory);

module.exports = router;
