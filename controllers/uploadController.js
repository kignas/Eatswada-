'use strict';

const streamifier = require('streamifier');
const asyncHandler = require('express-async-handler');
const cloudinary = require('../config/cloudinary');
const { validateImageBuffer } = require('../utils/imageValidation');

const FOLDER_MAP = {
  restaurants: 'Nearbite/restaurants',
  menu: 'Nearbite/menu',
  categories: 'Nearbite/categories',
  banners: 'Eatswada/banners',
  restaurantDelivery: 'Eatswada/restaurant-delivery',
};

const streamUpload = (buffer, folder) => new Promise((resolve, reject) => {
  let settled = false;
  const source = streamifier.createReadStream(buffer);
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    try { source.destroy(); } catch (_) {}
    const error = new Error('Image storage service timed out. Please try again.');
    error.statusCode = 504;
    reject(error);
  }, 60 * 1000);

  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error) return reject(error);
    resolve(result);
  };

  let uploadStream;
  try {
    uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (error, result) => finish(error, result)
    );
    source.on('error', finish);
    uploadStream.on('error', finish);
    source.pipe(uploadStream);
  } catch (error) {
    finish(error);
  }
});

// @route POST /api/upload/:type
// Supported types: restaurants | menu | categories | banners | restaurantDelivery
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
