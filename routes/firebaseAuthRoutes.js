const express = require('express');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const validate = require('../middleware/validateMiddleware');
const { firebaseAuth, completeGoogleProfile } = require('../controllers/firebaseAuthController');

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
], validate, firebaseAuth);

router.post('/firebase/complete-profile', firebaseAuthLimiter, [
  body('idToken').isString().isLength({ min: 100, max: 8192 }).withMessage('Valid Firebase ID token is required'),
  body('phone').isString().isLength({ min: 10, max: 16 }).withMessage('Invalid phone number'),
  body('password').isString().isLength({ min: 8, max: 128 }).withMessage('Password must be 8-128 characters'),
  body('name').optional().isString().isLength({ min: 2, max: 60 }).withMessage('Invalid name'),
], validate, completeGoogleProfile);

module.exports = router;
