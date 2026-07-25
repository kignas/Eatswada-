'use strict';

const cloudinary = require('cloudinary').v2;

/**
 * Cloudinary SDK configuration.
 *
 * Reads credentials from environment variables (set on Render):
 *   CLOUDINARY_CLOUD_NAME
 *   CLOUDINARY_API_KEY
 *   CLOUDINARY_API_SECRET
 *
 * secure: true ensures every URL Cloudinary returns uses https.
 */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

module.exports = cloudinary;
