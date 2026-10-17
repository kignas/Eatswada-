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
const { upload } = require('../utils/riderUpload');
const { listApplications, reviewApplication } = require('../controllers/riderApplicationController');

router.use(protect, authorize('admin'));

router.get('/applications', listApplications);
router.patch('/applications/:id/review', reviewApplication);
router.post('/', upload.single('photo'), createRider);
router.get('/', getRiders);
router.get('/:id', getRiderById);
router.put('/:id', upload.single('photo'), updateRider);
router.patch('/:id/status', toggleRiderStatus);
router.delete('/:id', deleteRider);

module.exports = router;
