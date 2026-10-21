'use strict';
const multer = require('multer');
const ALLOWED = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);
module.exports = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 4, fields: 2, parts: 6 },
  fileFilter: (req, file, cb) => ALLOWED.has(file.mimetype)
    ? cb(null, true)
    : cb(new Error('Only JPEG, PNG, WebP, or GIF images are allowed.'), false),
});
