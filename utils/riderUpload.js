'use strict';

const multer = require('multer');
const cloudinary = require('./cloudinaryConfig');

// Memory storage — the file never touches disk, we stream the buffer
// straight to Cloudinary as a base64 data URI. Keeps this dependency-free
// (no need for multer-storage-cloudinary or streamifier).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed for profile pictures.'));
    }
    cb(null, true);
  },
});

/**
 * uploadToCloudinary — uploads an in-memory file buffer and returns the
 * Cloudinary result (use result.secure_url as the stored avatar URL).
 */
const uploadToCloudinary = async (buffer, mimetype, folder = 'nearbite/riders') => {
  const base64 = `data:${mimetype};base64,${buffer.toString('base64')}`;
  return cloudinary.uploader.upload(base64, {
    folder,
    resource_type: 'image',
    transformation: [{ width: 500, height: 500, crop: 'fill', gravity: 'face' }],
  });
};

module.exports = { upload, uploadToCloudinary };
