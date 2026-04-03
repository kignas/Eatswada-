const express  = require('express');
const { body } = require('express-validator');
const router   = express.Router();

const {
  sendOTPHandler, verifyOTPHandler, register, login,
  getProfile, updateProfile,
  getAddresses, addAddress, updateAddress, deleteAddress, setDefaultAddress,
} = require('../controllers/userController');

const { protect }  = require('../middleware/authMiddleware');
const validate     = require('../middleware/validateMiddleware');

// ── Auth ──────────────────────────────────────────────────────
router.post('/send-otp',
  [body('phone').notEmpty().withMessage('Phone is required')],
  validate, sendOTPHandler
);

router.post('/verify-otp',
  [
    body('phone').notEmpty().withMessage('Phone is required'),
    body('otp').isLength({ min: 4, max: 4 }).withMessage('OTP must be 4 digits'),
  ],
  validate, verifyOTPHandler
);

router.post('/register',
  [
    body('phone').notEmpty().withMessage('Phone is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  validate, register
);

router.post('/login',
  [
    body('phone').notEmpty().withMessage('Phone is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  validate, login
);

// ── Profile ───────────────────────────────────────────────────
router.get('/profile',  protect, getProfile);
router.put('/profile',  protect, updateProfile);

// ── Addresses ────────────────────────────────────────────────
router.get   ('/addresses',              protect, getAddresses);
router.post  ('/addresses',              protect,
  [
    body('house').notEmpty().withMessage('House / flat is required'),
    body('area').notEmpty().withMessage('Area is required'),
  ],
  validate, addAddress
);
router.put   ('/addresses/:id',          protect, updateAddress);
router.delete('/addresses/:id',          protect, deleteAddress);
router.patch ('/addresses/:id/default',  protect, setDefaultAddress);

module.exports = router;
