'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  submitVendorApplication,
  getVendorApplicationStatus,
  getVendorApplications,
  getVendorApplicationById,
  approveVendorApplication,
  rejectVendorApplication,
} = require('../controllers/vendorApplicationController');

const applicationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many application attempts. Please try again later.' },
});

// Public seller onboarding.
router.post('/', applicationLimiter, submitVendorApplication);
router.get('/:id/status', applicationLimiter, getVendorApplicationStatus);

// Admin review workflow.
router.get('/', protect, authorize('admin'), getVendorApplications);
router.get('/:id', protect, authorize('admin'), getVendorApplicationById);
router.patch('/:id/approve', protect, authorize('admin'), approveVendorApplication);
router.patch('/:id/reject', protect, authorize('admin'), rejectVendorApplication);

module.exports = router;
