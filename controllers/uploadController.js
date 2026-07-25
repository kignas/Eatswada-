const streamifier = require('streamifier');
const asyncHandler = require('express-async-handler');
const cloudinary = require('../config/cloudinary');

// Maps the :type route param to its Cloudinary folder
const FOLDER_MAP = {
  restaurants: 'Nearbite/restaurants',
  menu: 'Nearbite/menu',
  categories: 'Nearbite/categories',
};

/**
 * Streams a buffer to Cloudinary and resolves with the upload result.
 */
const streamUpload = (buffer, folder) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
};

// @desc    Upload an image to Cloudinary (restaurant / menu / category)
// @route   POST /api/upload/:type
// @access  Private (admin, vendor)
const uploadImage = asyncHandler(async (req, res) => {
  const { type } = req.params;
  const folder = FOLDER_MAP[type];

  if (!folder) {
    const error = new Error(`Invalid upload type "${type}". Must be one of: ${Object.keys(FOLDER_MAP).join(', ')}`);
    error.statusCode = 400;
    throw error;
  }

  if (!req.file) {
    const error = new Error('No image file provided');
    error.statusCode = 400;
    throw error;
  }

  const result = await streamUpload(req.file.buffer, folder);

  res.status(200).json({
    success: true,
    data: { url: result.secure_url },
  });
});

module.exports = { uploadImage };
