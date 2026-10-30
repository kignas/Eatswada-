const express = require('express');
const router = express.Router();
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { protect, authorize } = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const upload = require('../middleware/uploadMiddleware');
const { uploadImage, uploadCustomerMedia } = require('../controllers/uploadController');
const customerMediaUpload = require('../middleware/customerMediaUpload');

// Upload-specific throttles are deliberately applied AFTER authentication so
// limits are keyed to the account, not only the shared mobile-carrier IP.
// This supplements (and does not replace) the global API limiter.
const customerUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.CUSTOMER_UPLOAD_RATE_LIMIT_MAX) || 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `customer:${String(req.user?._id || 'unknown')}`,
  message: { success: false, message: 'Too many evidence uploads. Please try again later.' },
});

const adminUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.ADMIN_UPLOAD_RATE_LIMIT_MAX) || 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `admin:${String(req.user?._id || 'unknown')}`,
  message: { success: false, message: 'Too many image uploads. Please try again later.' },
});

/**
 * Wraps multer's single-file upload so its errors (wrong file type,
 * over the 5MB limit) come back as clean 400 responses instead of
 * falling through to the generic 500 handler.
 */
const handleUpload = (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'Image must be 5MB or smaller'
        : err.message;
      return res.status(400).json({ success: false, message });
    }
    if (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next();
  });
};

// Customer evidence upload: images are stored privately under the authenticated customer's Cloudinary folder.
const handleCustomerMediaUpload = (req, res, next) => {
  customerMediaUpload.array('images', 4)(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Each image must be 5MB or smaller.' : err.message;
      return res.status(400).json({ success: false, message });
    }
    if (err) return res.status(400).json({ success: false, message: err.message });
    next();
  });
};

router.post('/customer-media', protect, authorize('user'), customerUploadLimiter, handleCustomerMediaUpload, uploadCustomerMedia);

// @route   POST /api/upload/:type
// @desc    Upload an image to Cloudinary. :type is one of restaurants | menu | categories | banners | restaurantDelivery
// @access  Private (admin)
router.post('/:type', protect, authorize('admin'), requirePermission('content.manage'), adminUploadLimiter, handleUpload, uploadImage);

module.exports = router;
