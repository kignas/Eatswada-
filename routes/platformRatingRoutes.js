'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { protect, authorize } = require('../middleware/authMiddleware');
const { getMyRatings, submitPlatformRating } = require('../controllers/platformRatingController');

const router = express.Router();

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many rating submissions. Please try again later.' },
});

router.get('/me', protect, authorize('user'), getMyRatings);
router.post('/', protect, authorize('user'), submitLimiter, submitPlatformRating);

module.exports = router;
