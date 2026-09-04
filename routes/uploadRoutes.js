const express = require('express');
const router = express.Router();
const multer = require('multer');
const { protect, authorize } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');
const { uploadImage } = require('../controllers/uploadController');

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

// @route   POST /api/upload/:type
// @desc    Upload an image to Cloudinary. :type is one of restaurants | menu | categories
// @access  Private (admin)
router.post('/:type', protect, authorize('admin'), handleUpload, uploadImage);

module.exports = router;
