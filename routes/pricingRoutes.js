'use strict';

// Customer-facing pricing endpoints. Every value is computed server-side from
// verified restaurant/menu/address data; the client can only ask WHICH
// restaurant and address, never a price.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, query } = require('express-validator');
const validate = require('../middleware/validateMiddleware');
const { protect } = require('../middleware/authMiddleware');
const c = require('../controllers/pricingController');

const router = express.Router();

// Quotes are cheap but hit the route provider; keep a generous cap so normal
// cart editing is never blocked, while a scrape cannot hammer the provider.
const quoteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many pricing requests. Please slow down.' },
});

router.use(protect);

router.get('/config', c.publicConfig);

router.get(
  '/restaurant-cards',
  quoteLimiter,
  query('restaurantIds').isString().notEmpty().withMessage('restaurantIds is required.'),
  validate,
  c.restaurantCards,
);

router.post(
  '/quote',
  quoteLimiter,
  body('restaurantId').isMongoId().withMessage('A valid restaurantId is required.'),
  body('addressId').optional({ nullable: true }).isMongoId().withMessage('A valid addressId is required.'),
  body('items').isArray({ min: 1 }).withMessage('At least one item is required.'),
  body('paymentMethod').optional().isIn(['upi', 'cod']),
  validate,
  c.quote,
);

module.exports = router;
