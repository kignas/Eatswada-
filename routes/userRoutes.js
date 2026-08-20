const express  = require('express');
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit'); // Ensure you ran: npm install express-rate-limit
const router   = express.Router();

const {
  sendOTPHandler, verifyOTPHandler, register, login, setPassword, forgotPasswordSendOTP, forgotPasswordReset,
  getProfile, updateProfile,
  getAddresses, addAddress, updateAddress, deleteAddress, setDefaultAddress,
} = require('../controllers/userController');

const { protect }  = require('../middleware/authMiddleware');
const validate     = require('../middleware/validateMiddleware');

// ── Rate Limiters ─────────────────────────────────────────────
const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour window
  max: 5, // Limit each IP to 5 OTP requests per hour to save SMS costs
  message: { success: false, message: 'Too many OTP requests. Please try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes window
  max: 7, // Limit each IP to 7 login/verify attempts per 15 minutes
  message: { success: false, message: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Auth ──────────────────────────────────────────────────────
router.post('/send-otp',
  otpLimiter, // Applied to protect SMS wallet
  [body('phone').notEmpty().withMessage('Phone is required')],
  validate, sendOTPHandler
);

router.post('/verify-otp',
  loginLimiter,
  [
    body('phone').notEmpty().withMessage('Phone is required'),
    body('otp').isLength({ min: 4, max: 4 }).withMessage('OTP must be 4 digits'),
  ],
  validate, verifyOTPHandler
);

router.post('/register',
  loginLimiter,
  [
    body('phone').notEmpty().withMessage('Phone is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  validate, register
);

router.post('/login',
  loginLimiter,
  [
    body('phone').notEmpty().withMessage('Phone is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  validate, login
);

// Customer password setup after verified-phone onboarding
router.put('/password', protect,
  [body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')],
  validate, setPassword
);

// Forgot-password flow: OTP + new password. Do not reveal account existence.
router.post('/forgot-password/send-otp', otpLimiter,
  [body('phone').notEmpty().withMessage('Phone is required')],
  validate, forgotPasswordSendOTP
);

router.post('/forgot-password/reset', loginLimiter,
  [
    body('phone').notEmpty().withMessage('Phone is required'),
    body('otp').isLength({ min: 4, max: 4 }).withMessage('OTP must be 4 digits'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  validate, forgotPasswordReset
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
