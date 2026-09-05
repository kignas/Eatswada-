'use strict';

const multer = require('multer');
const cloudinary = require('./cloudinaryConfig');
const { validateImageBuffer } = require('./imageValidation');

const ALLOWED_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
    fields: 20,
    parts: 21,
  },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, WebP, or GIF images are allowed for profile pictures.'));
    }
    cb(null, true);
  },
});

const uploadToCloudinary = async (buffer, mimetype, folder = 'nearbite/riders') => {
  const validation = validateImageBuffer(buffer, mimetype);
  if (!validation.valid) {
    const error = new Error(validation.message);
    error.statusCode = 400;
    throw error;
  }

  const base64 = `data:${mimetype};base64,${buffer.toString('base64')}`;
  return cloudinary.uploader.upload(base64, {
    folder,
    resource_type: 'image',
    transformation: [{ width: 500, height: 500, crop: 'fill', gravity: 'face' }],
  });
};

module.exports = { upload, uploadToCloudinary };
