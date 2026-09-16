'use strict';

const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const c = require('../controllers/homeBannerController');

// Public customer homepage feed.
router.get('/', c.getActiveBanners);

// Admin management.
router.get('/all', protect, authorize('admin'), requirePermission('settings.manage'), c.getAllBanners);
router.post('/', protect, authorize('admin'), requirePermission('settings.manage'), c.createBanner);
router.put('/reorder', protect, authorize('admin'), requirePermission('settings.manage'), c.reorderBanners);
router.put('/:id', protect, authorize('admin'), requirePermission('settings.manage'), c.updateBanner);
router.patch('/:id/toggle', protect, authorize('admin'), requirePermission('settings.manage'), c.toggleBanner);
router.delete('/:id', protect, authorize('admin'), requirePermission('settings.manage'), c.deleteBanner);

module.exports = router;
