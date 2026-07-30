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

router.use(protect, authorize('admin', 'ceo'));

router.post('/', upload.single('photo'), createRider);
router.get('/', getRiders);
router.get('/:id', getRiderById);
router.put('/:id', upload.single('photo'), updateRider);
router.patch('/:id/status', toggleRiderStatus);
router.delete('/:id', deleteRider);

module.exports = router;
