'use strict';

const express = require('express');
const router = express.Router();

const {
  createRider,
  getRiders,
  getRiderById,
  updateRider,
  toggleRiderStatus,
  deleteRider,
} = require('../controllers/adminController');

const { protect, authorize } = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const { upload } = require('../utils/riderUpload');
const { listApplications, reviewApplication } = require('../controllers/riderApplicationController');

router.use(protect, authorize('admin'));

router.get('/applications', requirePermission('riders.manage'), listApplications);
router.patch('/applications/:id/review', requirePermission('riders.manage'), reviewApplication);
router.post('/', requirePermission('riders.manage'), upload.single('photo'), createRider);
router.get('/', requirePermission('riders.manage'), getRiders);
router.get('/:id', requirePermission('riders.manage'), getRiderById);
router.put('/:id', requirePermission('riders.manage'), upload.single('photo'), updateRider);
router.patch('/:id/status', requirePermission('riders.manage'), toggleRiderStatus);
router.delete('/:id', requirePermission('riders.manage'), deleteRider);

module.exports = router;
