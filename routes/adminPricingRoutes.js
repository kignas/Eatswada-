'use strict';

// Admin -> Financial Management -> Dynamic Pricing.
// Every route requires an admin with finance.manage; mutations are audited.

const express = require('express');
const { param, query } = require('express-validator');
const validate = require('../middleware/validateMiddleware');
const { protect, authorize } = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const c = require('../controllers/adminPricingController');
const router = express.Router();

router.use(protect, authorize('admin'), requirePermission('finance.manage'));

router.get('/config', c.getPricingConfig);
router.get('/rules', c.listRules);
router.put('/rules', c.updatePricingRules);
router.get(
  '/snapshot/:orderId',
  param('orderId').isMongoId().withMessage('A valid order id is required.'),
  validate,
  c.getOrderSnapshot,
);
router.get(
  '/contribution',
  query('days').optional().isInt({ min: 1, max: 90 }),
  validate,
  c.getContributionSummary,
);

module.exports = router;
