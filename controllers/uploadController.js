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

const uploadCustomerMedia = asyncHandler(async (req, res) => {
  if (req.user?.role !== 'user') return res.status(403).json({ success: false, message: 'Customer account required.' });
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) return res.status(400).json({ success: false, message: 'Select at least one image.' });
  if (files.length > 4) return res.status(400).json({ success: false, message: 'Upload up to 4 images at a time.' });
  const urls = [];
  for (const file of files) {
    const validation = validateImageBuffer(file.buffer, file.mimetype);
    if (!validation.valid) return res.status(400).json({ success: false, message: validation.message });
  }
  // Upload only validated images; never trust client-supplied URLs as uploaded evidence.
  for (const file of files) {
    const result = await streamUpload(file.buffer, `Eatswada/customer-media/${String(req.user._id)}`);
    if (!result?.secure_url || !/^https:\/\/res\.cloudinary\.com\//i.test(result.secure_url)) {
      const error = new Error('Image storage returned an invalid URL.'); error.statusCode = 502; throw error;
    }
    urls.push(result.secure_url);
  }
  return res.status(201).json({ success: true, data: { urls } });
});

const uploadVendorMenuImage = asyncHandler(async (req, res) => {
  if (req.user?.role !== 'vendor' || !req.user.restaurantId) {
    return res.status(403).json({ success: false, message: 'Vendor restaurant access required.' });
  }
  if (!req.file) return res.status(400).json({ success: false, message: 'No image file provided.' });
  const validation = validateImageBuffer(req.file.buffer, req.file.mimetype);
  if (!validation.valid) return res.status(400).json({ success: false, message: validation.message });
  const folder = `Eatswada/vendors/${String(req.user.restaurantId)}/menu`;
  const result = await streamUpload(req.file.buffer, folder);
  res.status(200).json({ success: true, data: { url: result.secure_url } });
});

module.exports = { uploadImage, uploadVendorMenuImage, uploadCustomerMedia };
