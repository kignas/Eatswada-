const express = require('express');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const validate = require('../middleware/validateMiddleware');
const { firebaseAuth } = require('../controllers/firebaseAuthController');

const router = express.Router();
const firebaseAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many authentication attempts. Please try again later.' },
});

router.post('/firebase', firebaseAuthLimiter, [
  body('idToken').isString().isLength({ min: 100, max: 8192 }).withMessage('Valid Firebase ID token is required'),
  body('phone').optional().isString().isLength({ min: 10, max: 16 }).withMessage('Invalid phone number'),
], validate, firebaseAuth);

module.exports = router;
