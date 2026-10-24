const express  = require('express');
const { body, param } = require('express-validator');
const rateLimit = require('express-rate-limit'); // Ensure you ran: npm install express-rate-limit
const router   = express.Router();

const {
  login, logout,
  getProfile, updateProfile, requestEmailPasswordReset, verifyEmailPasswordResetOTP,
  resetPasswordByEmailOTP,
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

// Per-account guard for password changes: a stolen token must not be able to guess the current
// password. Only requests that try to change the password are counted (name/avatar edits are free),
// and only failed ones (a successful change does not use up the budget).
const profilePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => String(req.user._id),
  skip: (req) => req.body?.password === undefined,
  message: { success: false, code: 'TOO_MANY_PASSWORD_ATTEMPTS', message: 'Too many password attempts. Please try again in 15 minutes or reset your password by email.' },
});

// ── Auth ──────────────────────────────────────────────────────
// Customers sign in with Google (Firebase) or email/phone + password. There is no phone-OTP
// login/sign-up: /send-otp, /verify-otp and /register were removed (unknown routes -> 404).
// Customer password recovery: email OTP. No reset link is emailed.
router.post('/forgot-password/email',
  otpLimiter,
  [body('email').isEmail().withMessage('Valid email is required')],
  validate, requestEmailPasswordReset
);

router.post('/forgot-password/email/verify',
  loginLimiter,
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('otp').customSanitizer((value) => String(value || '').replace(/\D/g, '').slice(0, 6)),
    body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits'),
  ],
  validate, verifyEmailPasswordResetOTP
);

router.post('/forgot-password/email/reset',
  loginLimiter,
  [
    body('resetToken').isString().isLength({ min: 40, max: 128 }).withMessage('Valid reset session is required'),
    body('password').isString().isLength({ min: 8, max: 128 }).withMessage('Password must be 8-128 characters'),
  ],
  validate, resetPasswordByEmailOTP
);

router.post('/login',
  loginLimiter,
  [
    body('identifier').optional().isString().isLength({ min: 3, max: 254 }).withMessage('Invalid email or mobile number'),
    body('email').optional().isString().isLength({ min: 3, max: 254 }).withMessage('Invalid email'),
    body('phone').optional().isString().isLength({ min: 10, max: 16 }).withMessage('Invalid phone number'),
    body('password').isString().isLength({ min: 1, max: 128 }).withMessage('Password is required'),
  ],
  validate, login
);

router.post('/logout', protect, logout);

// ── Profile ───────────────────────────────────────────────────
router.get('/profile',  protect, getProfile);
router.put('/profile',  protect, profilePasswordLimiter,
  [
    body('name').optional().isString().trim().isLength({ min: 1, max: 80 }).withMessage('Name must be 1-80 characters'),
    body('email').optional({ values: 'falsy' }).isEmail().withMessage('Enter a valid email address'),
    body('phone').optional().isString().isLength({ min: 10, max: 20 }).withMessage('Enter a valid mobile number'),
    body('password').optional().isString().isLength({ min: 8, max: 128 }).withMessage('Password must be 8-128 characters'),
    body('currentPassword').optional().isString().isLength({ max: 128 }).withMessage('Current password is invalid'),
    body('vegOnly').optional().isBoolean().withMessage('vegOnly must be boolean'),
    body('avatar').optional({ values: 'null' }).isString().isLength({ max: 2048 }).withMessage('Avatar value is too long'),
    body('adultConfirmed').optional().isBoolean().withMessage('adultConfirmed must be boolean'),
  ],
  validate, updateProfile
);

// ── Addresses ────────────────────────────────────────────────
router.get   ('/addresses',              protect, getAddresses);
router.post  ('/addresses',              protect,
  [
    body('house').notEmpty().withMessage('House / flat is required'),
    body('area').notEmpty().withMessage('Area is required'),
  ],
  validate, addAddress
);
const addressIdValidation = [param('id').isMongoId().withMessage('Invalid address ID')];
const addressFieldValidation = [
  body('tag').optional().isString().trim().isLength({ min: 1, max: 30 }),
  body('house').optional().isString().trim().isLength({ min: 1, max: 120 }),
  body('area').optional().isString().trim().isLength({ min: 1, max: 160 }),
  body('landmark').optional().isString().trim().isLength({ max: 160 }),
  body('city').optional().isString().trim().isLength({ min: 1, max: 80 }),
  body('pincode').optional().isString().matches(/^\d{6}$/).withMessage('Pincode must be 6 digits'),
  body('isDefault').optional().isBoolean().withMessage('isDefault must be boolean'),
  body().custom((value) => {
    const hasCoords = value.coordinates !== undefined || value.latitude !== undefined || value.longitude !== undefined;
    if (!hasCoords) return true;
    let longitude, latitude;
    if (Array.isArray(value.coordinates) && value.coordinates.length === 2) {
      [longitude, latitude] = value.coordinates.map(Number);
    } else if (value.coordinates !== undefined) {
      throw new Error('Coordinates must contain longitude and latitude');
    } else {
      longitude = Number(value.longitude);
      latitude = Number(value.latitude);
    }
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
      throw new Error('Coordinates are invalid');
    }
    return true;
  }),
];
router.put   ('/addresses/:id',          protect, addressIdValidation, addressFieldValidation, validate, updateAddress);
router.delete('/addresses/:id',          protect, addressIdValidation, validate, deleteAddress);
router.patch ('/addresses/:id/default',  protect, addressIdValidation, validate, setDefaultAddress);

module.exports = router;
