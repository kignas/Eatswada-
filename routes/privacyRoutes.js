"use strict";
const express = require('express');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const router = express.Router();

const privacy = require('../controllers/privacyController');
const { protect, authorize } = require('../middleware/authMiddleware');
const validate = require('../middleware/validateMiddleware');

const privacyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many privacy requests. Please try again later.' },
});
router.use(privacyLimiter);

router.get('/me/export', protect, privacy.exportMyData);
router.delete('/me', protect, privacy.deleteMyAccount);
router.put('/me/nominee', protect, privacy.setNominee);
router.delete('/me/nominee', protect, privacy.clearNominee);
router.get('/requests', protect, privacy.listMyPrivacyRequests);

router.post('/requests',
  protect,
  [
    body('type').isIn(['correction', 'grievance']).withMessage('Invalid request type'),
    body('message').isString().isLength({ min: 5, max: 2000 }).withMessage('Message must be 5-2000 characters'),
  ],
  validate,
  privacy.createPrivacyRequest
);

router.get('/admin/requests', protect, authorize('admin'), privacy.listAdminRequests);
router.patch('/admin/requests/:id',
  protect,
  authorize('admin'),
  [
    body('status').isIn(['open','in_progress','resolved','rejected']).withMessage('Invalid status'),
    body('adminNote').optional().isString().isLength({ max: 2000 }).withMessage('Admin note is too long'),
  ],
  validate,
  privacy.updateAdminRequest
);

module.exports = router;
