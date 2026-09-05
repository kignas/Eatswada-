'use strict';

const multer = require('multer');

// Files stay in memory and are streamed to Cloudinary; nothing is written to disk.
const storage = multer.memoryStorage();

const ALLOWED_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) return cb(null, true);
  return cb(new Error('Only JPEG, PNG, WebP, or GIF images are allowed.'), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
    fields: 10,
    parts: 11,
  },
});

module.exports = upload;
