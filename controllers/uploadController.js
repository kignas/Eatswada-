'use strict';

const streamifier = require('streamifier');
const asyncHandler = require('express-async-handler');
const cloudinary = require('../config/cloudinary');
const { validateImageBuffer } = require('../utils/imageValidation');

const FOLDER_MAP = {
  restaurants: 'Nearbite/restaurants',
  menu: 'Nearbite/menu',
  categories: 'Nearbite/categories',
};

const streamUpload = (buffer, folder) => new Promise((resolve, reject) => {
  const uploadStream = cloudinary.uploader.upload_stream(
    { folder, resource_type: 'image' },
    (error, result) => error ? reject(error) : resolve(result)
  );
  streamifier.createReadStream(buffer).pipe(uploadStream);
});

// @route POST /api/upload/:type
// @access Private (admin)
const uploadImage = asyncHandler(async (req, res) => {
  const folder = FOLDER_MAP[req.params.type];
  if (!folder) {
    const error = new Error('Invalid upload type.');
    error.statusCode = 400;
    throw error;
  }

  if (!req.file) {
    const error = new Error('No image file provided.');
    error.statusCode = 400;
    throw error;
  }

  const validation = validateImageBuffer(req.file.buffer, req.file.mimetype);
  if (!validation.valid) {
    const error = new Error(validation.message);
    error.statusCode = 400;
    throw error;
  }

  const result = await streamUpload(req.file.buffer, folder);
  res.status(200).json({ success: true, data: { url: result.secure_url } });
});

module.exports = { uploadImage };
